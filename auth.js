const jwt = require('jsonwebtoken')

const JWT_SECRET = process.env.JWT_SECRET
const SPRING_API_BASE_URL = process.env.SPRING_API_BASE_URL || 'http://spring-boot:8080'

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET 환경변수가 필요합니다 (bujirun-backend의 jwt.secret과 동일해야 함)')
}

/**
 * 접속 토큰을 검증하고, 이 유저가 해당 itinerary에 접근 권한이 있는지
 * bujirun-backend REST API로 확인한다.
 * 소유자/그룹멤버 판단은 백엔드(ItineraryService.validateAccess)가 유일한 기준이므로
 * 여기서 그 로직을 중복 구현하지 않고 백엔드에 그대로 위임한다.
 *
 * @param {string} token JWT access token
 * @param {string} itineraryId room 이름 (=itineraryId)
 * @throws {Error} 토큰이 유효하지 않거나 접근 권한이 없으면 예외
 */
async function authorize (token, itineraryId) {
  if (!token) throw new Error('토큰이 없습니다')

  try {
    jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] })
  } catch (e) {
    throw new Error('유효하지 않은 토큰입니다: ' + e.message)
  }

  const res = await fetch(`${SPRING_API_BASE_URL}/api/itineraries/${itineraryId}`, {
    headers: { Authorization: `Bearer ${token}` }
  })

  if (!res.ok) {
    throw new Error(`일정 접근 권한이 없습니다 (status=${res.status})`)
  }
}

module.exports = { authorize }
