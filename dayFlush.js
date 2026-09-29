const crypto = require('crypto')

const DAYS_KEY = 'days'

// Yjs 문서에서 day별 항목 목록을 읽어온다. 프론트 itineraryYjsSchema.ts의 스키마와 반드시
// 같은 구조여야 한다: doc.getArray('days') → 각 원소는 { dayId, items: Y.Array<Y.Map> },
// item Y.Map은 최소 { id, spotId, time }를 갖는다(그 외 필드는 화면 표시용이라 flush에는
// 필요 없음).
function extractDays (doc) {
  const daysArray = doc.getArray(DAYS_KEY)
  return daysArray.toArray().map((dayMap) => {
    const dayId = dayMap.get('dayId')
    const itemsArray = dayMap.get('items')
    const items = (itemsArray ? itemsArray.toArray() : []).map((itemMap) => ({
      id: itemMap.get('id'),
      spotId: itemMap.get('spotId'),
      time: itemMap.get('time'),
      // flush 응답의 실제 id를 "이 항목"에 정확히 되돌려 쓰기 위한 참조(resolveTempIds).
      // payload/서명에는 들어가지 않는다(toReplacePayload가 필요한 필드만 골라 씀).
      map: itemMap,
    }))
    return { dayId, items }
  })
}

// 프론트 flushItineraryToRest.ts의 replaceDayItems 페이로드 규칙과 동일하다 — spotId 없는
// 항목(아직 저장 중인 placeholder 등)은 제외한다.
function toReplacePayload (items) {
  return items
    .filter((item) => item.spotId)
    .map((item) => ({
      existingItemId: typeof item.id === 'string' && item.id.startsWith('temp-') ? undefined : item.id,
      spotId: item.spotId,
      arrivalTime: item.time || undefined,
    }))
}

// operationId 해시 규칙도 프론트와 동일하게 맞춘다(dayId + 항목 구성 + 순서만, arrivalTime은
// 뺀다 — flushItineraryToRest.ts 주석 참고) — 배포 전환기에 구버전 프론트와 node가 같은
// 논리적 편집을 동시에 flush해도 서버 멱등 캐시에서 자연히 하나로 합쳐지게 하기 위함.
function computeOperationId (dayId, orderedInputs) {
  const input = `${dayId}|${orderedInputs.map((i) => `${i.existingItemId ?? 'new'}:${i.spotId}`).join(',')}`
  const digest = crypto.createHash('sha256').update(input).digest('hex').slice(0, 32)
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`
}

module.exports = { extractDays, toReplacePayload, computeOperationId }
