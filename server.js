const http = require('http')
const { WebSocketServer } = require('ws')
const { setupWSConnection } = require('y-websocket/bin/utils')
const { RedisPersistence } = require('y-redis')
const { authorize } = require('./auth')

// 허용되는 room 이름: itinerary UUID만 허용 (보안)
const UUID_REGEX = /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/.*)?$/i

const redisOpts = {
  host: process.env.REDIS_HOST || 'localhost',
  port: Number(process.env.REDIS_PORT) || 6379,
  ...(process.env.REDIS_PASSWORD && { password: process.env.REDIS_PASSWORD }),
}

const persistence = new RedisPersistence({ redisOpts })

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

  try {
    await authorize(token, itineraryId)
  } catch (e) {
    console.warn(`[auth] 연결 거부 — itineraryId=${itineraryId}: ${e.message}`)
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req)
  })
})

wss.on('connection', (ws, req) => {
  setupWSConnection(ws, req, { gc: true, persistence })
})

const PORT = process.env.PORT || 1234
server.listen(PORT, () => {
  console.log(`YJS WebSocket server running on port ${PORT}`)
  console.log(`Redis: ${redisOpts.host}:${redisOpts.port}`)
})

async function shutdown() {
  console.log('Shutting down...')
  await persistence.destroy()
  server.close(() => process.exit(0))
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
