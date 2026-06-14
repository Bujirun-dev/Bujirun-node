const http = require('http')
const { WebSocketServer } = require('ws')
const { setupWSConnection } = require('y-websocket/bin/utils')
const { RedisPersistence } = require('y-redis')

// 허용되는 room 이름: itinerary UUID만 허용 (보안)
const UUID_REGEX = /^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\/.*)?$/i

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

const wss = new WebSocketServer({ server })

wss.on('connection', (ws, req) => {
  const pathname = new URL(req.url, 'http://localhost').pathname

  if (!UUID_REGEX.test(pathname)) {
    ws.close(1008, 'Invalid room: must be an itinerary UUID')
    return
  }

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
