const BASE_URL = process.env.SPRING_API_BASE_URL || 'http://spring-boot:8080'
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET
const TIMEOUT_MS = 5000
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
// 타임아웃 5초 + 지수 백오프 3회(1s, 2s, 4s) 재시도. 재시도 대상은 네트워크 오류/5xx/429뿐이다
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
