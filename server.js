const http = require('http')
const { WebSocketServer } = require('ws')
const { setupWSConnection } = require('y-websocket/bin/utils')

const server = http.createServer()
const wss = new WebSocketServer({ server })

wss.on('connection', (ws, req) => {
  setupWSConnection(ws, req)
})

const PORT = process.env.PORT || 1234
server.listen(PORT, () => {
  console.log(`YJS WebSocket server running on port ${PORT}`)
})