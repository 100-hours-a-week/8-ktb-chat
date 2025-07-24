require('dotenv').config();
const http = require('http');
const socketIO = require('socket.io');

const PORT = process.env.WEBSOCKET_PORT || 5002;

// HTTP 서버 생성
const server = http.createServer();
const io = socketIO(server, {
  cors: {
    origin: [
      'https://bootcampchat-fe.run.goorm.site',
      'https://bootcampchat-hgxbv.dev-k8s.arkain.io',
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:3002',
      'https://localhost:3000',
      'https://localhost:3001',
      'https://localhost:3002',
      'http://0.0.0.0:3000',
      'https://0.0.0.0:3000'
    ],
    credentials: true
  }
});

// WebSocket 이벤트 처리
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('message', (data) => {
    console.log('Received message:', data);
    socket.emit('response', `Echo: ${data}`);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// 서버 시작
server.listen(PORT, '0.0.0.0', () => {
  console.log(`WebSocket server running on port ${PORT}`);
});

module.exports = server;