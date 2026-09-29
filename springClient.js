const BASE_URL = process.env.SPRING_API_BASE_URL || 'http://spring-boot:8080'
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET
// 백엔드 replaceDayItems는 새로 생긴 구간마다 ODsay 경로를 계산해서, 로그 불러오기처럼
// 구간이 한꺼번에 여러 개 바뀌면 수 초~십수 초가 걸린다. 5초로 두었을 때 운영에서 요청이
// 매번 끊기고(백엔드는 끝까지 처리해 커밋함) 같은 요청을 재시도하는 실패 루프가 났다
// (2026-09-28). 응답을 못 받으면 버전/temp id 동기화도 전부 어긋나므로 넉넉히 둔다.
const TIMEOUT_MS = 30000
const MAX_ATTEMPTS = 3

if (!INTERNAL_API_SECRET) {
  console.warn('[springClient] INTERNAL_API_SECRET이 설정되지 않았습니다 — flush 요청이 전부 401로 거부됩니다.')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function fetchWithTimeout (url, options) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

// PUT /api/internal/itineraries/{itineraryId}/days/{dayId}/items 를 호출한다.
// 타임아웃 30초 + 지수 백오프 3회(1s, 2s, 4s) 재시도. 재시도 대상은 네트워크 오류/5xx/429뿐이다
// — 400/401/403은 다시 보내도 똑같이 실패하고, 409(버전 충돌)는 "정상적인 충돌"이라 호출부가
// 응답 바디로 직접 처리해야 하므로 여기서 재시도하지 않고 즉시 반환한다.
async function replaceDayItems (itineraryId, dayId, body) {
  let lastError = null
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetchWithTimeout(
        `${BASE_URL}/api/internal/itineraries/${itineraryId}/days/${dayId}/items`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Secret': INTERNAL_API_SECRET || '',
          },
          body: JSON.stringify(body),
        },
      )
      const json = await res.json().catch(() => null)
      if (res.ok) return { ok: true, status: res.status, data: json?.data }
      if (res.status === 409) return { ok: false, status: 409, data: json?.data, message: json?.message }
      if (res.status !== 429 && res.status < 500) {
        // 값 자체가 잘못된 요청(400) / 인증·권한 실패(401/403) — 재시도해도 같은 결과다.
        return { ok: false, status: res.status, data: null, message: json?.message }
      }
      lastError = new Error(`HTTP ${res.status}: ${json?.message ?? '알 수 없는 오류'}`)
    } catch (e) {
      lastError = e
    }
    if (attempt < MAX_ATTEMPTS - 1) await sleep(1000 * 2 ** attempt)
  }
  throw lastError
}

module.exports = { replaceDayItems }
