# Bujirun-node

여행 일정 실시간 공동 편집을 위한 Yjs WebSocket 서버.  
`y-websocket` + `y-redis`를 사용해 여러 클라이언트 간 CRDT 기반 실시간 동기화를 제공한다.

---

## 아키텍처

```
[프론트엔드]  ←── WebSocket (Yjs) ──→  [부지런-node]  ←── Redis pub/sub ──→  [부지런-node (다중 인스턴스)]
                                               │
                                         Redis List에 Yjs 업데이트 영속 저장
                                               │
                                        (별도 REST 호출)
                                               ↓
                                        [bujirun-backend]  ←── DB
```

- **room 이름 = itinerary UUID**: 각 일정마다 독립된 Yjs 문서가 생성된다.
- **Redis**: Yjs 업데이트를 `{itineraryId}:updates` 리스트에 저장하고 pub/sub으로 다중 인스턴스 간 동기화한다. 서버 재시작 시에도 문서 상태가 유지된다.
- **bujirun-backend**: REST API로 DB 원본을 소유한다. 실시간 편집 중 Yjs 상태와 DB는 직접 연결되지 않으며, 편집 완료(저장) 시점에 프론트엔드가 REST API를 호출해 DB에 반영한다.

---

## 환경 변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | `1234` | WebSocket 서버 포트 |
| `REDIS_HOST` | `localhost` | Redis 호스트 |
| `REDIS_PORT` | `6379` | Redis 포트 |
| `REDIS_PASSWORD` | — | Redis 비밀번호 (없으면 생략) |

---

## 로컬 실행

```bash
npm install
REDIS_HOST=localhost npm start
```

Redis가 없으면 Docker로 빠르게 띄울 수 있다.

```bash
docker run -d -p 6379:6379 redis:7-alpine
```

---

## 프론트엔드 연동 가이드

### 의존성 설치

```bash
npm install yjs y-websocket
```

### 연결

```js
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'

const itineraryId = 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' // 백엔드에서 받은 UUID

const doc = new Y.Doc()
const provider = new WebsocketProvider(
  'ws://localhost:1234',
  itineraryId,          // room 이름 = itinerary UUID
  doc
)

provider.on('status', ({ status }) => {
  console.log('연결 상태:', status) // 'connecting' | 'connected' | 'disconnected'
})
```

### Yjs 데이터 구조 설계 권장안

일정 데이터를 Yjs 공유 타입으로 모델링할 때 아래 구조를 권장한다.  
백엔드 엔티티(`Itinerary` → `ItineraryDay` → `ItineraryItem`)와 1:1 대응된다.

```js
// 일정 메타
const meta = doc.getMap('meta')
meta.set('title', '제주 여행')

// 일별 아이템 순서 (day UUID 기준으로 YArray 분리)
const day1Items = doc.getArray('day:{dayId}')
day1Items.push([{
  itemId: 'xxxxxxxx-...',   // 백엔드 ItineraryItem UUID
  spotId: 'xxxxxxxx-...',
  orderIndex: 0,
  memo: '',
}])
```

### 편집 완료 후 DB 저장

Yjs는 실시간 동기화 레이어이고, DB 원본은 bujirun-backend가 관리한다.  
편집이 끝나면 프론트엔드에서 직접 REST API를 호출해야 한다.

```js
// 예: 아이템 순서 변경 후 백엔드에 반영
await fetch(`/api/itineraries/{itineraryId}/days/{dayId}/items/{itemId}`, {
  method: 'PATCH',
  body: JSON.stringify({ orderIndex: newIndex, ... }),
})
```

### 주의사항

- `WebsocketProvider`의 두 번째 인자(room 이름)는 반드시 **itinerary UUID** 형식이어야 한다. UUID가 아닌 값으로 연결하면 서버가 즉시 연결을 끊는다.
- 같은 `itineraryId`로 접속한 모든 클라이언트는 자동으로 동기화된다. 별도 room 관리 코드는 필요 없다.
- 오프라인 상태에서도 Yjs가 로컬 변경을 보관했다가 재연결 시 자동으로 머지한다.

---

## 백엔드(bujirun-backend) 연동 고려사항

### 책임 분리

| 역할 | 담당 |
|---|---|
| 실시간 상태 동기화 | 부지런-node (Yjs + Redis) |
| 데이터 원본(DB) | bujirun-backend |
| 최종 저장 트리거 | 프론트엔드 → bujirun-backend REST |

bujirun-backend는 이 서버와 직접 통신하지 않는다. 실시간 협업 중 DB 변경은 프론트엔드가 책임진다.

### itinerary UUID 일치

`Itinerary.id`(UUID)가 WebSocket room 이름으로 사용된다.  
일정 생성 흐름: `POST /api/itineraries` → 응답의 `id` 값을 WebSocket 연결에 사용.

### 동시 편집 충돌

Yjs CRDT 특성상 두 사용자가 동시에 같은 필드를 편집하면 자동 머지된다.  
단, **아이템 추가/삭제**(DB 쓰기)와 **실시간 순서 변경**(Yjs)이 겹치면 Yjs 상태와 DB 상태가 일시적으로 달라질 수 있다.  
편집 세션 종료 후 DB와 동기화하는 시점을 명확히 정의해두는 것이 좋다.

### Redis 키 구조

```
{itineraryId}:updates   → List  (Yjs 업데이트 바이너리 목록)
```

Redis에 저장되는 값은 Yjs 바이너리 포맷이므로 직접 읽거나 수정하면 안 된다.

### 스케일아웃

Node 인스턴스를 여러 개 띄울 경우 모두 동일한 Redis를 바라보도록 설정하면 된다.  
Redis pub/sub이 인스턴스 간 Yjs 업데이트를 자동으로 릴레이한다.

---

## Docker

```bash
docker build -t bujirun-node .
docker run -p 1234:1234 \
  -e REDIS_HOST=redis \
  -e REDIS_PORT=6379 \
  bujirun-node
```
