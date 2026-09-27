const Y = require('yjs')
const springClient = require('./springClient')
const { extractDays, toReplacePayload, computeOperationId } = require('./dayFlush')

const DEBOUNCE_MS = 5000
const PERIODIC_MS = 30000

// a, b 공통으로 등장하는 id 중 "양쪽에서 같은 상대 순서를 유지하는" 가장 긴 부분수열을
// 구한다 — 프론트 itineraryYjsSchema.ts의 longestCommonSubsequenceIds와 동일한 알고리즘.
// 409 충돌로 서버 최신 상태를 로컬 Yjs에 반영할 때, 이미 존재하는(=연결된 클라이언트가
// 참조 중인) Y.Map을 삭제 후 재삽입하면 Yjs가 허용하지 않는다 — 위치가 그대로인 항목은
// 반드시 "그 인스턴스를 patch"해야 한다.
function longestCommonSubsequenceIds (a, b) {
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  const result = new Set()
  let i = n
  let j = m
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.add(a[i - 1])
      i -= 1
      j -= 1
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i -= 1
    } else {
      j -= 1
    }
  }
  return result
}

// room(itineraryId) 하나의 flush를 전담한다. room당 정확히 1개만 있어야 하므로, 생성/조회는
// server.js의 getOrCreateRoomManager를 통해서만 한다.
class RoomFlushManager {
  constructor (itineraryId, doc) {
    this.itineraryId = itineraryId
    this.doc = doc
    // day별 마지막으로 확인한 낙관적 락 버전. undefined면 "아직 모름"(첫 flush는 버전 체크
    // 스킵 — node가 이 room에서 처음 flush하는 것이므로 경합 상대가 없어 안전하다) 상태다.
    this.dayVersions = new Map()
    // day별 마지막으로 성공한 flush의 payload 서명. 같으면 변경 없음으로 보고 스킵한다.
    this.lastFlushedSignature = new Map()
    // 지금 이 room에 연결된 유저id 집합. Spring의 validateAccess는 "소유자 또는 그룹원"만
    // 확인하므로, 지금 방에 있는 사람이면 누구든 actorUserId로 써도 권한상 안전하다.
    this.activeUserIds = new Set()
    this.debounceTimer = null
    this.destroyed = false

    // 겹침 방지(coalesce): 프론트 useCollaborativeItinerary의 runFlush와 정확히 같은 패턴.
    // 진행 중인 flush가 있으면 새로 시작하지 않고 "끝나면 한 번 더" 예약만 한다 — 그래야
    // 이탈 시 최종 flush(flushFinal)가 이미 돌고 있는 주기적/디바운스 flush와 겹쳐서 같은
    // day를 두 번 동시에 REST에 쏘는 레이스가 생기지 않는다.
    this.flushChain = null
    this.pendingAgain = false
    this.pendingActorOverride = undefined

    this.periodicTimer = setInterval(() => this.scheduleFlush(), PERIODIC_MS)
    this.updateHandler = (_update, origin) => {
      // origin이 이 매니저 자신(applyServerDay가 만든 트랜잭션)이면 다시 flush를 예약할
      // 필요가 없다 — 서버가 이미 확인해준 상태를 그대로 재전송하는 무의미한 루프가 된다.
      if (origin === this) return
      this.onDocUpdate()
    }
    doc.on('update', this.updateHandler)
  }

  noteUser (userId) {
    if (userId) this.activeUserIds.add(userId)
  }

  removeUser (userId) {
    if (userId) this.activeUserIds.delete(userId)
  }

  pickActorUserId () {
    return this.activeUserIds.values().next().value
  }

  onDocUpdate () {
    if (this.destroyed) return
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => this.scheduleFlush(), DEBOUNCE_MS)
  }

  scheduleFlush () {
    if (this.destroyed) return
    void this.enqueueFlush(undefined)
  }

  // 이탈 시 최종 flush. 디바운스는 기다리지 않고 즉시 큐에 넣는다. 방금 나간 유저의 id를
  // 명시적으로 받는다 — 마지막 사용자가 나가면 activeUserIds가 이미 비어서
  // pickActorUserId()가 아무도 못 고르기 때문이다.
  flushFinal (actorUserId) {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    return this.enqueueFlush(actorUserId)
  }

  // 이미 도는 체인이 있으면 그 체인을 그대로 돌려주고(호출부가 완료를 기다릴 수 있게) 예약
  // 플래그만 세운다. 없으면 새 체인을 시작한다.
  enqueueFlush (actorUserIdOverride) {
    if (actorUserIdOverride) this.pendingActorOverride = actorUserIdOverride
    if (this.flushChain) {
      this.pendingAgain = true
      return this.flushChain
    }
    const chain = (async () => {
      try {
        let override = actorUserIdOverride
        for (;;) {
          // eslint-disable-next-line no-await-in-loop
          await this.runFlushOnce(override)
          if (!this.pendingAgain) return
          this.pendingAgain = false
          override = this.pendingActorOverride
          this.pendingActorOverride = undefined
        }
      } finally {
        this.flushChain = null
      }
    })()
    this.flushChain = chain
    return chain
  }

  async runFlushOnce (actorUserIdOverride) {
    const actorUserId = actorUserIdOverride ?? this.pickActorUserId()
    if (!actorUserId) return // 방에 아무도 없다 — 이탈 시 flush는 override로 별도 처리됨
    try {
      const days = extractDays(this.doc)
      for (const { dayId, items } of days) {
        if (!dayId) continue
        // eslint-disable-next-line no-await-in-loop
        await this.flushDay(dayId, items, actorUserId, false)
      }
    } catch (e) {
      console.error(`[flush] room=${this.itineraryId} 예상치 못한 오류:`, e)
    }
  }

  async flushDay (dayId, items, actorUserId, isConflictRetry) {
    // spotId 없는 항목은 toReplacePayload가 걸러내지만, 응답의 items[i]를 원래 로컬 항목과
    // 위치로 다시 짝지어야(resolveTempIds) 하므로 같은 필터를 여기서도 적용해 인덱스를
    // 맞춰둔다.
    const filteredItems = items.filter((item) => item.spotId)
    const orderedInputs = toReplacePayload(filteredItems)
    const signature = JSON.stringify(orderedInputs)
    if (!isConflictRetry && this.lastFlushedSignature.get(dayId) === signature) {
      return // 변경 없음 — flush 대상에서 제외
    }

    const operationId = await computeOperationId(dayId, orderedInputs)
    const expectedVersion = this.dayVersions.get(dayId)

    let result
    try {
      result = await springClient.replaceDayItems(this.itineraryId, dayId, {
        actorUserId,
        operationId,
        expectedVersion,
        items: orderedInputs,
      })
    } catch (e) {
      console.error(`[flush] room=${this.itineraryId} day=${dayId} 최종 실패(재시도 소진):`, e.message)
      this.broadcastSaveStatus('error')
      return // Yjs(+Redis)엔 그대로 남아있으므로 데이터 소실은 없다. 다음 주기에 재시도.
    }

    if (result.ok) {
      // temp- id를 실제 id로 못 바꿔주면, 바로 다음 flush(디바운스/주기 무엇이든)가 이 항목을
      // "아직 저장 안 된 새 항목"으로 다시 보고 매번 새로 만들어서 같은 항목이 계속
      // 중복 생성된다(로컬 재현 확인, 2026-09-17) — 프론트 flushItineraryToRest의
      // onIdResolved와 동일한 이유로 반드시 필요하다.
      this.resolveTempIds(dayId, filteredItems, result.data?.items)
      this.dayVersions.set(dayId, result.data?.version)
      // id가 바뀌었으니 다음 비교 기준(signature)도 실제 id 기준으로 다시 계산해서 저장한다
      // — 안 그러면 바로 다음 주기 flush가 "달라졌다"고 잘못 판단해 불필요한 REST 호출이
      // 한 번 더 나간다.
      const resolvedItems = extractDays(this.doc).find((d) => d.dayId === dayId)?.items ?? []
      const resolvedFiltered = resolvedItems.filter((item) => item.spotId)
      this.lastFlushedSignature.set(dayId, JSON.stringify(toReplacePayload(resolvedFiltered)))
      this.broadcastSaveStatus('saved')
      return
    }

    if (result.status === 409 && result.data) {
      this.applyServerDay(dayId, result.data)
      this.dayVersions.set(dayId, result.data.version)
      if (!isConflictRetry) {
        const refreshed = extractDays(this.doc).find((d) => d.dayId === dayId)
        await this.flushDay(dayId, refreshed?.items ?? [], actorUserId, true)
      }
      return
    }

    console.error(
      `[flush] room=${this.itineraryId} day=${dayId} 실패 status=${result.status} ${result.message ?? ''}`,
    )
    this.broadcastSaveStatus('error')
  }

  // 성공 응답의 items[i]는 요청으로 보낸 orderedInputs[i](=filteredItems[i])와 같은 순서다
  // (백엔드 replaceDayItems가 요청 순서대로 결과를 만듦). temp- id였던 로컬 항목만 그
  // 위치의 실제 id로 바꿔 쓴다 — 이미 실제 id였던 항목은 그대로 둔다. 그 사이 다른 편집으로
  // 해당 temp 항목이 사라졌으면(동시 삭제 등) find가 못 찾아서 조용히 스킵된다.
  resolveTempIds (dayId, filteredItems, resultItems) {
    if (!resultItems) return
    const daysArray = this.doc.getArray('days')
    const dayIdx = daysArray.toArray().findIndex((d) => d.get('dayId') === dayId)
    if (dayIdx < 0) return
    const itemsArray = daysArray.get(dayIdx).get('items')
    if (!itemsArray) return
    const maps = itemsArray.toArray()

    this.doc.transact(() => {
      filteredItems.forEach((localItem, index) => {
        if (typeof localItem.id !== 'string' || !localItem.id.startsWith('temp-')) return
        const real = resultItems[index]
        if (!real?.id) return
        const map = maps.find((m) => m.get('id') === localItem.id)
        if (map) map.set('id', real.id)
      })
    }, this)
  }

  // 409 응답의 최신 day 상태를 로컬 Yjs에 반영한다. 위치가 그대로인 항목은 Y.Map 인스턴스를
  // 유지한 채 내용만 patch하고(연결된 클라이언트가 참조 중인 인스턴스를 삭제하면 안 됨),
  // 실제로 빠지거나 새로 생긴 항목만 삭제/삽입한다 — 프론트 itineraryYjsSchema.ts의
  // replaceItemsArray와 같은 전략.
  //
  // 알려진 한계: 새로 생기는 항목은 최소 필드(id/spotId/time)만 채운다 — placeName 외 다른
  // 표시용 필드는 다음 새로고침(REST 재조회)에서 채워진다. node가 유일한 flush 주체가 된
  // 뒤로는 이 경로(409) 자체가 매우 드물어야 한다(같은 room을 동시에 flush할 다른 주체가
  // 이론상 없음 — 배포 전환기의 구버전 프론트 공존 기간만 예외).
  applyServerDay (dayId, serverDay) {
    const daysArray = this.doc.getArray('days')
    const dayIdx = daysArray.toArray().findIndex((d) => d.get('dayId') === dayId)
    if (dayIdx < 0) return
    const dayMap = daysArray.get(dayIdx)
    const itemsArray = dayMap.get('items')
    if (!itemsArray) return

    this.doc.transact(() => {
      const currentMaps = itemsArray.toArray()
      const currentIds = currentMaps.map((m) => m.get('id'))
      const nextItems = serverDay.items || []
      const nextIds = nextItems.map((it) => it.id)
      const nextById = new Map(nextItems.map((it) => [it.id, it]))
      const anchorIds = longestCommonSubsequenceIds(currentIds, nextIds)

      currentMaps.forEach((map) => {
        const id = map.get('id')
        if (!anchorIds.has(id)) return
        const item = nextById.get(id)
        if (!item) return
        map.set('spotId', item.spot?.id)
        map.set('time', item.arrivalTime ?? '')
      })

      for (let idx = currentMaps.length - 1; idx >= 0; idx -= 1) {
        const id = currentMaps[idx].get('id')
        if (!anchorIds.has(id)) itemsArray.delete(idx, 1)
      }

      let cursor = 0
      nextIds.forEach((id) => {
        if (anchorIds.has(id)) {
          cursor += 1
          return
        }
        const item = nextById.get(id)
        if (!item) return
        const map = new Y.Map()
        map.set('id', id)
        map.set('spotId', item.spot?.id)
        map.set('time', item.arrivalTime ?? '')
        map.set('placeName', item.spot?.name ?? '장소 미정')
        itemsArray.insert(cursor, [map])
        cursor += 1
      })
    }, this)
  }

  // 저장 상태를 awareness로 브로드캐스트한다. 실제 사용자 프레즌스가 아니라 "시스템" 항목
  // 하나를 이 doc의 로컬 상태로 실어보내는 것 — 프론트는 __system:true로 이걸 구분해서
  // 참여자 목록에는 안 보여주고 저장 상태 안내에만 쓴다.
  broadcastSaveStatus (status) {
    this.doc.awareness.setLocalState({ __system: true, saveStatus: status, savedAt: Date.now() })
  }

  destroy () {
    this.destroyed = true
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    if (this.periodicTimer) clearInterval(this.periodicTimer)
    this.doc.off('update', this.updateHandler)
  }
}

module.exports = { RoomFlushManager, DEBOUNCE_MS, PERIODIC_MS }
