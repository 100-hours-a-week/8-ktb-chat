require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const { router: roomsRouter, initializeSocket } = require('./routes/api/rooms');
const routes = require('./routes');
const { Server } = require('socket.io');
const { createClient } = require('redis');
const { createAdapter } = require('@socket.io/redis-adapter');
const { mongoURI } = require('./config/keys');
const CacheService = require('./services/cacheService');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 5000;

// trust proxy 설정 추가
app.set('trust proxy', 1);

// MongoDB 연결 풀 설정
const mongooseOptions = {
  // 연결 풀 설정
  maxPoolSize: 20,          // 최대 연결 수 (기본값: 100)
  minPoolSize: 5,           // 최소 연결 수 (기본값: 0)
  maxIdleTimeMS: 30000,     // 유휴 연결 유지 시간 (30초)
  
  // 버퍼링 설정 (bufferMaxEntries는 최신 MongoDB 드라이버에서 지원되지 않음)
  bufferCommands: false,    // 연결 실패 시 명령 버퍼링 비활성화
  
  // 타임아웃 설정
  serverSelectionTimeoutMS: 5000,   // 서버 선택 타임아웃 (5초)
  socketTimeoutMS: 45000,           // 소켓 타임아웃 (45초)
  connectTimeoutMS: 30000,          // 연결 타임아웃 (30초)
  
  // 재시도 및 안정성 설정
  heartbeatFrequencyMS: 10000,      // 하트비트 주기 (10초)
  retryWrites: true,                // 쓰기 재시도 활성화
  retryReads: true,                 // 읽기 재시도 활성화
  
  // 성능 최적화
  directConnection: false,          // 레플리카 셋 자동 감지
  readPreference: 'secondaryPreferred', // 읽기 성능 최적화
  
  // 로깅 설정 (개발 환경에서만)
  ...(process.env.NODE_ENV === 'development' && {
    loggerLevel: 'info'
  })
};

// CORS 설정
const corsOptions = {
  origin: [
    'https://bootcampchat-fe.run.goorm.site',
    'https://bootcampchat-hgxbv.dev-k8s.arkain.io',
    'https://chat.goorm-ktb-008.goorm.team', // 현재 도메인 추가
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:3002',
    'https://localhost:3000',
    'https://localhost:3001',
    'https://localhost:3002',
    'http://0.0.0.0:3000',
    'https://0.0.0.0:3000'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 
    'Authorization', 
    'x-auth-token', 
    'x-session-id',
    'Cache-Control',
    'Pragma'
  ],
  exposedHeaders: ['x-auth-token', 'x-session-id']
};

// 기본 미들웨어
app.use(cors(corsOptions));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// 정적 파일 제공 (uploads 디렉토리)
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
  setHeaders: (res, filePath, stat) => {
    // CORS 헤더 설정
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, x-auth-token, x-session-id');
    
    // 보안 헤더 설정
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('X-XSS-Protection', '1; mode=block');
    
    // 파일 타입별 캐시 정책
    const ext = path.extname(filePath).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.ico'].includes(ext)) {
      // 이미지 파일: 1년 캐시
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (['.mp4', '.webm', '.mov', '.mp3', '.wav', '.ogg'].includes(ext)) {
      // 미디어 파일: 1개월 캐시
      res.set('Cache-Control', 'public, max-age=2592000');
    } else {
      // 기타 파일: 1일 캐시
      res.set('Cache-Control', 'public, max-age=86400');
    }
    
    // Last-Modified 헤더 설정
    res.set('Last-Modified', stat.mtime.toUTCString());
  },
  // 파일이 없을 때 404 에러 반환
  fallthrough: false,
  // dotfiles 무시
  dotfiles: 'ignore',
  // ETag 생성
  etag: true,
  // 파일 확장자 처리
  extensions: false,
  // 인덱스 파일 무시
  index: false,
  // 대소문자 구분하지 않음
  caseSensitive: false,
  // 최대 age 설정
  maxAge: 0 // setHeaders에서 개별 설정
}));

// 루트 헬스체크 엔드포인트 (ALB용)
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// API 라우트 마운트
app.use('/api', routes);

// Socket.IO 설정
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 1e8, // 100MB
  pingTimeout: 60000
});

// 글로벌 소켓 설정
app.set('io', io);

// 채팅 소켓 핸들러 초기화
require('./sockets/chat')(io);

// Redis 어댑터 설정 함수
const setupRedisAdapter = async () => {
  try {
    const { redisHost, redisPort, redisPassword } = require('./config/keys');
    
    if (redisHost && redisPort) {
      console.log('Setting up Redis adapter for Socket.IO cluster mode...');
      
      const pubClient = createClient({
        url: `redis://${redisHost}:${redisPort}`,
        password: redisPassword,
        socket: {
          reconnectStrategy: (retries) => {
            if (retries > 50) {
              console.error('Redis Pub/Sub: Max reconnection attempts reached. Shutting down...');
              process.exit(1); // PM2와 같은 프로세스 매니저가 재시작하도록 유도
            }
            const delay = Math.min(retries * 200, 10000); // 최대 10초까지 딜레이 증가
            console.log(`Redis Pub/Sub: Reconnection attempt ${retries + 1}, retrying in ${delay}ms`);
            return delay;
          }
        }
      });
      const subClient = pubClient.duplicate();

      pubClient.on('connect', () => console.log('Redis Pub Client connected.'));
      subClient.on('connect', () => console.log('Redis Sub Client connected.'));

      pubClient.on('error', (err) => console.error('Redis Pub Client Error:', err));
      subClient.on('error', (err) => console.error('Redis Sub Client Error:', err));

      await Promise.all([pubClient.connect(), subClient.connect()]);

      io.adapter(createAdapter(pubClient, subClient));
      console.log('✅ Redis adapter for Socket.IO cluster mode initialized successfully');
    } else {
      console.log('⚠️ Redis configuration not found, using default memory adapter');
    }
  } catch (error) {
    console.error('❌ Failed to initialize Redis adapter, using default memory adapter:', error);
  }
};

// MongoDB 연결 상태 모니터링
mongoose.connection.on('connected', () => {
  console.log('MongoDB Connected Successfully');
  console.log(`Connection pool stats: maxPoolSize=${mongooseOptions.maxPoolSize}, minPoolSize=${mongooseOptions.minPoolSize}`);
});

mongoose.connection.on('error', (err) => {
  console.error('MongoDB Connection Error:', err.message);
});

mongoose.connection.on('disconnected', () => {
  console.log('MongoDB Disconnected');
});

// 연결 풀 상태 모니터링 (개발 환경에서만)
if (process.env.NODE_ENV === 'development') {
  setInterval(() => {
    const db = mongoose.connection.db;
    if (db) {
      console.log('MongoDB Pool Status:', {
        readyState: mongoose.connection.readyState,
        poolSize: mongoose.connection.readyState === 1 ? 'Connected' : 'Not Connected'
      });
    }
  }, 60000); // 1분마다 체크
}

// 프로세스 종료 시 우아한 연결 해제
process.on('SIGINT', async () => {
  console.log('Received SIGINT, closing MongoDB connection...');
  try {
    await mongoose.connection.close();
    console.log('MongoDB connection closed.');
    process.exit(0);
  } catch (error) {
    console.error('Error closing MongoDB connection:', error);
    process.exit(1);
  }
});

process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, closing MongoDB connection...');
  try {
    await mongoose.connection.close();
    console.log('MongoDB connection closed.');
    process.exit(0);
  } catch (error) {
    console.error('Error closing MongoDB connection:', error);
    process.exit(1);
  }
});

// 서버 시작 함수
const startServer = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, mongooseOptions);
    console.log('MongoDB Connected');
    
    // Redis 어댑터 설정
    await setupRedisAdapter();

    server.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running on port ${PORT}`);
      console.log('Environment:', process.env.NODE_ENV);
      console.log('API Base URL:', `http://0.0.0.0:${PORT}/api`);
    });
  } catch (err) {
    console.error('Server startup error:', err);
    process.exit(1);
  }
};

startServer();

module.exports = { app, server };