const http = require('http')
const { WebSocketServer } = require('ws')
const { setupWSConnection, getYDoc } = require('y-websocket/bin/utils')
const { RedisPersistence } = require('y-redis')
const { authorize } = require('./auth')
const { RoomFlushManager } = require('./roomFlushManager')

// 허용되는 room 이름: itinerary UUID만 허용 (보안)
const UUID_REGEX = /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/.*)?$/i

const redisOpts = {
  host: process.env.REDIS_HOST || 'localhost',
  port: Number(process.env.REDIS_PORT) || 6379,
  ...(process.env.REDIS_PASSWORD && { password: process.env.REDIS_PASSWORD }),
}

const persistence = new RedisPersistence({ redisOpts })

// room(itineraryId)당 RoomFlushManager 1개. getYDoc()이 돌려주는 WSSharedDoc은 room당
// 하나뿐이라(y-websocket이 내부 Map으로 보장) 여기 registry도 room당 1개만 있으면 된다.
const roomManagers = new Map()

function getOrCreateRoomManager (itineraryId) {
  let manager = roomManagers.get(itineraryId)
  if (manager && !manager.destroyed) return manager
  const doc = getYDoc(itineraryId)
  manager = new RoomFlushManager(itineraryId, doc)
  roomManagers.set(itineraryId, manager)
  return manager
}

// 마지막 사용자가 나가면 최종 flush 후 room(매니저) 정리. flush가 도는 동안 누군가
// 재접속하면(activeUserIds가 다시 채워지면) 정리하지 않는다.
async function handleUserLeft (itineraryId, userId) {
  const manager = roomManagers.get(itineraryId)
  if (!manager) return
  manager.removeUser(userId)
  if (manager.activeUserIds.size > 0) return
  await manager.flushFinal(userId)
  if (manager.activeUserIds.size === 0 && roomManagers.get(itineraryId) === manager) {
    manager.destroy()
    roomManagers.delete(itineraryId)
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200)
  res.end('ok')
})

const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost')
  const match = UUID_REGEX.exec(url.pathname)

  if (!match) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
    socket.destroy()
    return
  }

  const itineraryId = match[1]
  const token = url.searchParams.get('token')

  let userId
  try {
    userId = await authorize(token, itineraryId)
  } catch (e) {
    console.warn(`[auth] 연결 거부 — itineraryId=${itineraryId}: ${e.message}`)
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return
  }

  // connection 핸들러에서 다시 URL을 파싱하지 않도록 req에 실어둔다.
  req.itineraryId = itineraryId
  req.userId = userId

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req)
  })
})

wss.on('connection', (ws, req) => {
  setupWSConnection(ws, req, { docName: req.itineraryId, gc: true })

  const manager = getOrCreateRoomManager(req.itineraryId)
  manager.noteUser(req.userId)

  ws.on('close', () => {
    handleUserLeft(req.itineraryId, req.userId).catch((e) => {
      console.error(`[flush] room=${req.itineraryId} 이탈 시 최종 flush 실패:`, e)
    })
  })
})

const PORT = process.env.PORT || 1234
server.listen(PORT, () => {
  console.log(`YJS WebSocket server running on port ${PORT}`)
  console.log(`Redis: ${redisOpts.host}:${redisOpts.port}`)
})

async function shutdown () {
  console.log('Shutting down...')
  for (const manager of roomManagers.values()) manager.destroy()
  // 연결된 클라이언트가 있으면 server.close()의 콜백이 그 연결들이 끊길 때까지
  // 영원히 안 불려서 process.exit이 실행되지 않고 프로세스가 좀비로 남는다 —
  // 클라이언트를 먼저 강제로 끊고, 그래도 안 죽으면 타임아웃으로 강제 종료한다.
  wss.clients.forEach((ws) => ws.close(1001, 'Server shutting down'))
  await persistence.destroy()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 5000).unref()
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
