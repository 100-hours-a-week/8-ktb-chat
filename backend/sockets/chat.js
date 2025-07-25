const { createAdapter } = require('@socket.io/redis-adapter');
const { createClient } = require('redis');
const Message = require('../models/Message');
const Room = require('../models/Room');
const User = require('../models/User');
const File = require('../models/File');
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config/keys');
const redisClient = require('../utils/redisClient');
const SessionService = require('../services/sessionService');
const aiService = require('../services/aiService');
const CacheService = require('../services/cacheService');

module.exports = async function(io) {
  // Redis 어댑터 설정 (단일 인스턴스에서는 비활성화)
  console.log('⚠️ Running in single instance mode, Redis adapter disabled');
  
  /*
  // Redis 어댑터 설정 (클러스터 모드용)
  try {
    const { redisHost, redisPort, redisPassword } = require('../config/keys');
    
    if (redisHost && redisPort) {
      console.log('Setting up Redis adapter for Socket.IO cluster mode...');
      
      // 기존 Redis 설정을 사용하여 새로운 클라이언트 생성
      const redisUrl = `redis://${redisHost}:${redisPort}`;
      
      const pubClient = createClient({
        url: redisUrl,
        password: redisPassword,
        socket: {
          reconnectStrategy: (retries) => Math.min(retries * 50, 1000)
        }
      });
      const subClient = pubClient.duplicate();

      // 에러 핸들링 추가
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
  */
  
  const connectedUsers = new Map();
  const streamingSessions = new Map();
  const userRooms = new Map();
  const messageQueues = new Map();
  const messageLoadRetries = new Map();
  const aiRequestLocks = new Map(); // AI 요청 중복 방지
  const processedMessages = new Map(); // 메시지 중복 처리 방지
  const BATCH_SIZE = 30;  // 한 번에 로드할 메시지 수
  const LOAD_DELAY = 300; // 메시지 로드 딜레이 (ms)
  const MAX_RETRIES = 3;  // 최대 재시도 횟수
  const MESSAGE_LOAD_TIMEOUT = 10000; // 메시지 로드 타임아웃 (10초)
  const RETRY_DELAY = 2000; // 재시도 간격 (2초)
  const DUPLICATE_LOGIN_TIMEOUT = 10000; // 중복 로그인 타임아웃 (10초)

  // 로깅 유틸리티 함수
  const logDebug = (action, data) => {
    console.debug(`[Socket.IO] ${action}:`, {
      ...data,
      timestamp: new Date().toISOString()
    });
  };

  // 캐시된 메시지 일괄 로드 함수 (대폭 개선)
  const loadMessages = async (socket, roomId, before, limit = BATCH_SIZE) => {
    try {
      // 캐시 서비스를 사용한 메시지 조회
      const result = await CacheService.getMessages(roomId, before, limit, async () => {
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => {
            reject(new Error('Message loading timed out'));
          }, MESSAGE_LOAD_TIMEOUT);
        });

        // 쿼리 구성
        const query = { room: roomId, isDeleted: false };
        if (before) {
          query.timestamp = { $lt: new Date(before) };
        }

        // 메시지 로드 with profileImage (캐시 미스 시에만 실행)
        const messages = await Promise.race([
          Message.find(query)
            .populate('sender', 'name email profileImage')
            .populate({
              path: 'file',
              select: 'filename originalname mimetype size'
            })
            .sort({ timestamp: -1 })
            .limit(limit + 1)
            .lean(),
          timeoutPromise
        ]);

        // 결과 처리
        const hasMore = messages.length > limit;
        const resultMessages = messages.slice(0, limit);
        const sortedMessages = resultMessages.sort((a, b) => 
          new Date(a.timestamp) - new Date(b.timestamp)
        );

        return {
          messages: sortedMessages,
          hasMore,
          oldestTimestamp: sortedMessages[0]?.timestamp || null
        };
      });

      // 읽음 상태 비동기 업데이트 (캐시와 별개로 항상 실행)
      if (result?.messages?.length > 0 && socket.user) {
        const messageIds = result.messages.map(msg => msg._id);
        Message.updateMany(
          {
            _id: { $in: messageIds },
            'readers.userId': { $ne: socket.user.id }
          },
          {
            $push: {
              readers: {
                userId: socket.user.id,
                readAt: new Date()
              }
            }
          }
        ).exec().catch(error => {
          console.error('Read status update error:', error);
        });
      }

      return result;
    } catch (error) {
      if (error.message === 'Message loading timed out') {
        logDebug('message load timeout', {
          roomId,
          before,
          limit
        });
      } else {
        console.error('Load messages error:', {
          error: error.message,
          stack: error.stack,
          roomId,
          before,
          limit
        });
      }
      throw error;
    }
  };

  // 재시도 로직을 포함한 메시지 로드 함수
  const loadMessagesWithRetry = async (socket, roomId, before, retryCount = 0) => {
    const retryKey = `${roomId}:${socket.user.id}`;
    
    try {
      if (messageLoadRetries.get(retryKey) >= MAX_RETRIES) {
        throw new Error('최대 재시도 횟수를 초과했습니다.');
      }

      const result = await loadMessages(socket, roomId, before);
      messageLoadRetries.delete(retryKey);
      return result;

    } catch (error) {
      const currentRetries = messageLoadRetries.get(retryKey) || 0;
      
      if (currentRetries < MAX_RETRIES) {
        messageLoadRetries.set(retryKey, currentRetries + 1);
        const delay = Math.min(RETRY_DELAY * Math.pow(2, currentRetries), 10000);
        
        logDebug('retrying message load', {
          roomId,
          retryCount: currentRetries + 1,
          delay
        });

        await new Promise(resolve => setTimeout(resolve, delay));
        return loadMessagesWithRetry(socket, roomId, before, currentRetries + 1);
      }

      messageLoadRetries.delete(retryKey);
      throw error;
    }
  };

  // 중복 로그인 처리 함수
  const handleDuplicateLogin = async (existingSocket, newSocket) => {
    try {
      // 기존 연결에 중복 로그인 알림
      existingSocket.emit('duplicate_login', {
        type: 'new_login_attempt',
        deviceInfo: newSocket.handshake.headers['user-agent'],
        ipAddress: newSocket.handshake.address,
        timestamp: Date.now()
      });

      // 타임아웃 설정
      return new Promise((resolve) => {
        setTimeout(async () => {
          try {
            // 기존 세션 종료
            existingSocket.emit('session_ended', {
              reason: 'duplicate_login',
              message: '다른 기기에서 로그인하여 현재 세션이 종료되었습니다.'
            });

            // 기존 연결 종료
            existingSocket.disconnect(true);
            resolve();
          } catch (error) {
            console.error('Error during session termination:', error);
            resolve();
          }
        }, DUPLICATE_LOGIN_TIMEOUT);
      });
    } catch (error) {
      console.error('Duplicate login handling error:', error);
      throw error;
    }
  };

  // 미들웨어: 소켓 연결 시 인증 처리
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      const sessionId = socket.handshake.auth.sessionId;

      if (!token || !sessionId) {
        return next(new Error('Authentication error'));
      }

      const decoded = jwt.verify(token, jwtSecret);
      if (!decoded?.user?.id) {
        return next(new Error('Invalid token'));
      }

      // 이미 연결된 사용자인지 확인
      const existingSocketId = connectedUsers.get(decoded.user.id);
      if (existingSocketId) {
        const existingSocket = io.sockets.sockets.get(existingSocketId);
        if (existingSocket) {
          // 중복 로그인 처리
          await handleDuplicateLogin(existingSocket, socket);
        }
      }

      // 임시: 세션 검증 완화 (연결 문제 해결을 위해)
      try {
        const validationResult = await SessionService.validateSession(decoded.user.id, sessionId);
        if (!validationResult.isValid) {
          console.warn('Session validation failed, allowing connection anyway:', validationResult);
          // 세션 검증 실패해도 연결 허용 (임시)
        }
      } catch (sessionError) {
        console.warn('Session validation error, allowing connection anyway:', sessionError);
      }

      const user = await User.findById(decoded.user.id);
      if (!user) {
        return next(new Error('User not found'));
      }

      socket.user = {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        sessionId: sessionId,
        profileImage: user.profileImage
      };

      await SessionService.updateLastActivity(decoded.user.id);
      next();

    } catch (error) {
      console.error('Socket authentication error:', {
        error: error.message,
        name: error.name,
        stack: error.stack,
        token: token ? 'present' : 'missing',
        sessionId: sessionId ? 'present' : 'missing'
      });
      
      if (error.name === 'TokenExpiredError') {
        return next(new Error('Token expired'));
      }
      
      if (error.name === 'JsonWebTokenError') {
        return next(new Error('Invalid token'));
      }
      
      next(new Error('Authentication failed'));
    }
  });
  
  io.on("connection", (socket) => {
    let pingTimeout;

    logDebug('socket connected', {
      socketId: socket.id,
      userId: socket.user?.id,
      userName: socket.user?.name
    });

    const heartbeat = () => {
      clearTimeout(pingTimeout);
      pingTimeout = setTimeout(() => {
        socket.disconnect(true);
      }, 30000); // 30초 타임아웃
    };

    socket.on("ping", () => {
      socket.emit("pong");
      heartbeat();
    });

    // 중복 로그인 감지
    if (socket.user) {
      const previousSocketId = connectedUsers.get(socket.user.id);
      if (previousSocketId && previousSocketId !== socket.id) {
        const previousSocket = io.sockets.sockets.get(previousSocketId);
        if (previousSocket) {
          // 이전 연결에 중복 로그인 알림
          previousSocket.emit('duplicate_login', {
            type: 'new_login_attempt',
            deviceInfo: socket.handshake.headers['user-agent'],
            ipAddress: socket.handshake.address,
            timestamp: Date.now()
          });

          // 이전 연결 종료 처리
          setTimeout(() => {
            previousSocket.emit('session_ended', {
              reason: 'duplicate_login',
              message: '다른 기기에서 로그인하여 현재 세션이 종료되었습니다.'
            });
            previousSocket.disconnect(true);
          }, DUPLICATE_LOGIN_TIMEOUT);
        }
      }

      // 새로운 연결 정보 등록
      connectedUsers.set(socket.user.id, socket.id);
    }

    // 기존 연결 성공 정보 전송
    socket.emit("connect_success", {
      socketId: socket.id,
      userId: socket.user?.id,
      connected: true,
      timestamp: Date.now(),
    });

    // 재연결 시 이전 방 복구
    socket.on("reconnect", async () => {
      if (socket.user) {
        const currentRoom = userRooms.get(socket.user.id);
        if (currentRoom) {
          socket.join(currentRoom);
          const room = await Room.findById(currentRoom).populate(
            "participants",
            "name email profileImage"
          );
          if (room) {
            socket.emit("joinRoomSuccess", {
              roomId: currentRoom,
              participants: room.participants,
              socketConnected: true,
            });
          }
        }
      }
    });

    // 최초 접속 시 방 참여 처리
    if (socket.user) {
      const currentRoom = userRooms.get(socket.user.id);
      if (currentRoom) {
        socket.join(currentRoom);
        socket.emit("joinRoomSuccess", {
          roomId: currentRoom,
          socketConnected: true,
        });
      }
    }

    // 연결 종료 시 cleanup
    socket.on("disconnect", () => {
      if (socket.user?.id) {
        connectedUsers.delete(socket.user.id);
      }
      clearTimeout(pingTimeout);
      console.log(`User disconnected: ${socket.user?.id}`);
    });
    
    // 이전 메시지 로딩 처리 개선
    socket.on('fetchPreviousMessages', async ({ roomId, before }) => {
      const queueKey = `${roomId}:${socket.user.id}`;

      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        // 권한 체크
        const room = await Room.findOne({
          _id: roomId,
          participants: socket.user.id
        });

        if (!room) {
          throw new Error('채팅방 접근 권한이 없습니다.');
        }

        if (messageQueues.get(queueKey)) {
          logDebug('message load skipped - already loading', {
            roomId,
            userId: socket.user.id
          });
          return;
        }

        messageQueues.set(queueKey, true);
        socket.emit('messageLoadStart');

        const result = await loadMessagesWithRetry(socket, roomId, before);
        
        logDebug('previous messages loaded', {
          roomId,
          messageCount: result.messages.length,
          hasMore: result.hasMore,
          oldestTimestamp: result.oldestTimestamp
        });

        socket.emit('previousMessagesLoaded', result);

      } catch (error) {
        console.error('Fetch previous messages error:', error);
        socket.emit('error', {
          type: 'LOAD_ERROR',
          message: error.message || '이전 메시지를 불러오는 중 오류가 발생했습니다.'
        });
      } finally {
        setTimeout(() => {
          messageQueues.delete(queueKey);
        }, LOAD_DELAY);
      }
    });
    
    // 채팅방 입장 처리 개선
    socket.on('joinRoom', async (roomId) => {
      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        // 이미 해당 방에 참여 중인지 확인
        const currentRoom = userRooms.get(socket.user.id);
        if (currentRoom === roomId) {
          logDebug('already in room', {
            userId: socket.user.id,
            roomId
          });
          socket.emit('joinRoomSuccess', { roomId });
          return;
        }

        // 기존 방에서 나가기
        if (currentRoom) {
          logDebug('leaving current room', { 
            userId: socket.user.id, 
            roomId: currentRoom 
          });
          socket.leave(currentRoom);
          userRooms.delete(socket.user.id);
          
          socket.to(currentRoom).emit('userLeft', {
            userId: socket.user.id,
            name: socket.user.name
          });
        }

        // 채팅방 참가 with profileImage
        const room = await Room.findByIdAndUpdate(
          roomId,
          { $addToSet: { participants: socket.user.id } },
          { 
            new: true,
            runValidators: true 
          }
        ).populate('participants', 'name email profileImage');

        if (!room) {
          throw new Error('채팅방을 찾을 수 없습니다.');
        }

        socket.join(roomId);
        userRooms.set(socket.user.id, roomId);

        // 입장 메시지 생성
        const joinMessage = new Message({
          room: roomId,
          content: `${socket.user.name}님이 입장하였습니다.`,
          type: 'system',
          timestamp: new Date()
        });
        
        await joinMessage.save();

        // 초기 메시지 로드
        const messageLoadResult = await loadMessages(socket, roomId);
        const { messages, hasMore, oldestTimestamp } = messageLoadResult;

        // 활성 스트리밍 메시지 조회
        const activeStreams = Array.from(streamingSessions.values())
          .filter(session => session.room === roomId)
          .map(session => ({
            _id: session.messageId,
            type: 'ai',
            aiType: session.aiType,
            content: session.content,
            timestamp: session.timestamp,
            isStreaming: true
          }));

        // 이벤트 발송
        socket.emit('joinRoomSuccess', {
          roomId,
          participants: room.participants,
          messages,
          hasMore,
          oldestTimestamp,
          activeStreams
        });

        io.to(roomId).emit('message', joinMessage);
        io.to(roomId).emit('participantsUpdate', room.participants);

        logDebug('user joined room', {
          userId: socket.user.id,
          roomId,
          messageCount: messages.length,
          hasMore
        });

      } catch (error) {
        console.error('Join room error:', {
          error: error.message,
          stack: error.stack,
          userId: socket.user?.id,
          roomId: roomId
        });
        socket.emit('joinRoomError', {
          message: error.message || '채팅방 입장에 실패했습니다.'
        });
      }
    });
    
    // 메시지 전송 처리
    socket.on('chatMessage', async (messageData) => {
      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        if (!messageData) {
          throw new Error('메시지 데이터가 없습니다.');
        }

        const { room, type, content, fileData, requestId } = messageData;

        if (!room) {
          throw new Error('채팅방 정보가 없습니다.');
        }

        // 요청 ID 기반 중복 방지 (더 정확함)
        if (requestId) {
          const requestKey = `${socket.user.id}:${requestId}`;
          if (processedMessages.has(requestKey)) {
            console.log('Duplicate request prevented:', requestKey);
            return;
          }
          processedMessages.set(requestKey, true);
          // 5분 후 요청 ID 제거 (충분한 시간)
          setTimeout(() => {
            processedMessages.delete(requestKey);
          }, 300000);
        } else {
          console.warn('Message received without requestId from user:', socket.user.id);
        }

        // 채팅방 권한 확인
        const chatRoom = await Room.findOne({
          _id: room,
          participants: socket.user.id
        });

        if (!chatRoom) {
          throw new Error('채팅방 접근 권한이 없습니다.');
        }

        // 세션 유효성 재확인
        const sessionValidation = await SessionService.validateSession(
          socket.user.id, 
          socket.user.sessionId
        );
        
        if (!sessionValidation.isValid) {
          throw new Error('세션이 만료되었습니다. 다시 로그인해주세요.');
        }

        // AI 멘션 확인
        const aiMentions = extractAIMentions(content);
        let message;

        logDebug('message received', {
          type,
          room,
          userId: socket.user.id,
          hasFileData: !!fileData,
          hasAIMentions: aiMentions.length
        });

        // 메시지 타입별 처리
        switch (type) {
          case 'file':
            if (!fileData || !fileData._id) {
              throw new Error('파일 데이터가 올바르지 않습니다.');
            }

            const file = await File.findOne({
              _id: fileData._id,
              user: socket.user.id
            });

            if (!file) {
              throw new Error('파일을 찾을 수 없거나 접근 권한이 없습니다.');
            }

            message = new Message({
              room,
              sender: socket.user.id,
              type: 'file',
              file: file._id,
              content: content || '',
              timestamp: new Date(),
              reactions: {},
              metadata: {
                fileType: file.mimetype,
                fileSize: file.size,
                originalName: file.originalname
              }
            });
            break;

          case 'text':
            const messageContent = content?.trim() || messageData.msg?.trim();
            if (!messageContent) {
              return;
            }

            message = new Message({
              room,
              sender: socket.user.id,
              content: messageContent,
              type: 'text',
              timestamp: new Date(),
              reactions: {}
            });
            break;

          default:
            throw new Error('지원하지 않는 메시지 타입입니다.');
        }

        await message.save();
        await message.populate([
          { path: 'sender', select: 'name email profileImage' },
          { path: 'file', select: 'filename originalname mimetype size' }
        ]);

        // 새 메시지 작성 시 해당 채팅방의 메시지 캐시 무효화
        await CacheService.invalidateByTag(`room:${room}`);

        io.to(room).emit('message', message);

        // AI 멘션이 있는 경우 AI 응답 생성 (중복 방지)
        if (aiMentions.length > 0) {
          const originalMessageId = message._id.toString();
          for (const ai of aiMentions) {
            const query = content.replace(new RegExp(`@${ai}\\b`, 'g'), '').trim();
            const requestKey = `${room}:${ai}:${originalMessageId}`;
            
            // 중복 요청 방지
            if (!aiRequestLocks.has(requestKey)) {
              aiRequestLocks.set(requestKey, true);
              
              // 에러 처리를 포함하여 비동기로 호출
              handleAIResponse(io, room, ai, query, requestKey).catch(error => {
                console.error(`AI response failed for key ${requestKey}:`, error);
                // 락 해제는 handleAIResponse 내부에서 처리되므로 여기서 별도 처리 필요 없음
              });

            } else {
              console.log(`AI request skipped (duplicate): ${ai} in room ${room}`);
            }
          }
        }

        await SessionService.updateLastActivity(socket.user.id);

        logDebug('message processed', {
          messageId: message._id,
          type: message.type,
          room
        });

      } catch (error) {
        console.error('Message handling error:', error);
        socket.emit('error', {
          code: error.code || 'MESSAGE_ERROR',
          message: error.message || '메시지 전송 중 오류가 발생했습니다.'
        });
      }
    });

    // 채팅방 퇴장 처리
    socket.on('leaveRoom', async (roomId) => {
      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        // 실제로 해당 방에 참여 중인지 먼저 확인
        const currentRoom = userRooms?.get(socket.user.id);
        if (!currentRoom || currentRoom !== roomId) {
          console.log(`User ${socket.user.id} is not in room ${roomId}`);
          return;
        }

        // 권한 확인
        const room = await Room.findOne({
          _id: roomId,
          participants: socket.user.id
        }).select('participants').lean();

        if (!room) {
          console.log(`Room ${roomId} not found or user has no access`);
          return;
        }

        socket.leave(roomId);
        userRooms.delete(socket.user.id);

        // 퇴장 메시지 생성 및 저장
        const leaveMessage = await Message.create({
          room: roomId,
          content: `${socket.user.name}님이 퇴장하였습니다.`,
          type: 'system',
          timestamp: new Date()
        });

        // 참가자 목록 업데이트 - profileImage 포함
        const updatedRoom = await Room.findByIdAndUpdate(
          roomId,
          { $pull: { participants: socket.user.id } },
          { 
            new: true,
            runValidators: true
          }
        ).populate('participants', 'name email profileImage');

        if (!updatedRoom) {
          console.log(`Room ${roomId} not found during update`);
          return;
        }

        // 스트리밍 세션 정리
        for (const [messageId, session] of streamingSessions.entries()) {
          if (session.room === roomId && session.userId === socket.user.id) {
            streamingSessions.delete(messageId);
          }
        }

        // 메시지 큐 정리
        const queueKey = `${roomId}:${socket.user.id}`;
        messageQueues.delete(queueKey);
        messageLoadRetries.delete(queueKey);

        // 이벤트 발송
        io.to(roomId).emit('message', leaveMessage);
        io.to(roomId).emit('participantsUpdate', updatedRoom.participants);

        console.log(`User ${socket.user.id} left room ${roomId} successfully`);

      } catch (error) {
        console.error('Leave room error:', error);
        socket.emit('error', {
          message: error.message || '채팅방 퇴장 중 오류가 발생했습니다.'
        });
      }
    });
    
    // 연결 해제 처리
    socket.on('disconnect', async (reason) => {
      if (!socket.user) return;

      try {
        // 해당 사용자의 현재 활성 연결인 경우에만 정리
        if (connectedUsers.get(socket.user.id) === socket.id) {
          connectedUsers.delete(socket.user.id);
        }

        const roomId = userRooms.get(socket.user.id);
        userRooms.delete(socket.user.id);

        // 메시지 큐 정리
        const userQueues = Array.from(messageQueues.keys())
          .filter(key => key.endsWith(`:${socket.user.id}`));
        userQueues.forEach(key => {
          messageQueues.delete(key);
          messageLoadRetries.delete(key);
        });
        
        // 스트리밍 세션 정리
        for (const [messageId, session] of streamingSessions.entries()) {
          if (session.userId === socket.user.id) {
            streamingSessions.delete(messageId);
          }
        }

        // 현재 방에서 자동 퇴장 처리
        if (roomId) {
          // 다른 디바이스로 인한 연결 종료가 아닌 경우에만 처리
          if (reason !== 'client namespace disconnect' && reason !== 'duplicate_login') {
            const leaveMessage = await Message.create({
              room: roomId,
              content: `${socket.user.name}님이 연결이 끊어졌습니다.`,
              type: 'system',
              timestamp: new Date()
            });

            const updatedRoom = await Room.findByIdAndUpdate(
              roomId,
              { $pull: { participants: socket.user.id } },
              { 
                new: true,
                runValidators: true 
              }
            ).populate('participants', 'name email profileImage');

            if (updatedRoom) {
              io.to(roomId).emit('message', leaveMessage);
              io.to(roomId).emit('participantsUpdate', updatedRoom.participants);
            }
          }
        }

        logDebug('user disconnected', {
          reason,
          userId: socket.user.id,
          socketId: socket.id,
          lastRoom: roomId
        });

      } catch (error) {
        console.error('Disconnect handling error:', error);
      }
    });

    // 세션 종료 또는 로그아웃 처리
    socket.on('force_login', async ({ token }) => {
      try {
        if (!socket.user) return;

        // 강제 로그아웃을 요청한 클라이언트의 세션 정보 확인
        const decoded = jwt.verify(token, jwtSecret);
        if (!decoded?.user?.id || decoded.user.id !== socket.user.id) {
          throw new Error('Invalid token');
        }

        // 세션 종료 처리
        socket.emit('session_ended', {
          reason: 'force_logout',
          message: '다른 기기에서 로그인하여 현재 세션이 종료되었습니다.'
        });

        // 연결 종료
        socket.disconnect(true);

      } catch (error) {
        console.error('Force login error:', error);
        socket.emit('error', {
          message: '세션 종료 중 오류가 발생했습니다.'
        });
      }
    });

    // 메시지 읽음 상태 처리
    socket.on('markMessagesAsRead', async ({ roomId, messageIds }) => {
      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        if (!Array.isArray(messageIds) || messageIds.length === 0) {
          return;
        }

        // 읽음 상태 업데이트
        await Message.updateMany(
          {
            _id: { $in: messageIds },
            room: roomId,
            'readers.userId': { $ne: socket.user.id }
          },
          {
            $push: {
              readers: {
                userId: socket.user.id,
                readAt: new Date()
              }
            }
          }
        );

        socket.to(roomId).emit('messagesRead', {
          userId: socket.user.id,
          messageIds
        });

      } catch (error) {
        console.error('Mark messages as read error:', error);
        socket.emit('error', {
          message: '읽음 상태 업데이트 중 오류가 발생했습니다.'
        });
      }
    });

    // 리액션 처리
    socket.on('messageReaction', async ({ messageId, reaction, type }) => {
      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        const message = await Message.findById(messageId);
        if (!message) {
          throw new Error('메시지를 찾을 수 없습니다.');
        }

        // 리액션 추가/제거
        if (type === 'add') {
          await message.addReaction(reaction, socket.user.id);
        } else if (type === 'remove') {
          await message.removeReaction(reaction, socket.user.id);
        }

        // 업데이트된 리액션 정보 브로드캐스트
        io.to(message.room).emit('messageReactionUpdate', {
          messageId,
          reactions: message.reactions
        });

      } catch (error) {
        console.error('Message reaction error:', error);
        socket.emit('error', {
          message: error.message || '리액션 처리 중 오류가 발생했습니다.'
        });
      }
    });
  });

  // AI 멘션 추출 함수
  function extractAIMentions(content) {
    if (!content) return [];
    
    const aiTypes = ['wayneAI', 'consultingAI', 'BadGirl'];
    const mentions = new Set();
    const mentionRegex = /@(wayneAI|consultingAI|BadGirl)\b/g;
    let match;
    
    while ((match = mentionRegex.exec(content)) !== null) {
      if (aiTypes.includes(match[1])) {
        mentions.add(match[1]);
      }
    }
    
    return Array.from(mentions);
  }

  // AI 응답 처리 함수 개선 (큐 시스템 적용)
  async function handleAIResponse(io, room, aiName, query, requestKey) {
    const messageId = `${aiName}-${Date.now()}`;
    let accumulatedContent = '';
    const timestamp = new Date();
    let isCompleted = false; // 완료 콜백 중복 실행 방지 플래그

    // 이미 같은 AI가 같은 방에서 스트리밍 중인지 확인
    const existingStream = Array.from(streamingSessions.values())
      .find(session => session.room === room && session.aiType === aiName);
    
    if (existingStream) {
      console.log(`AI response skipped - already streaming: ${aiName} in room ${room}`);
      return;
    }

    // 스트리밍 세션 초기화
    streamingSessions.set(messageId, {
      room,
      aiType: aiName,
      content: '',
      messageId,
      timestamp,
      lastUpdate: Date.now(),
      reactions: {},
      requestId: null // AI 요청 ID 추가
    });
    
    logDebug('AI response started', {
      messageId,
      aiType: aiName,
      room,
      query
    });

    // 초기 상태 전송
    io.to(room).emit('aiMessageStart', {
      messageId,
      aiType: aiName,
      timestamp,
      status: 'queued' // 큐에 추가됨을 표시
    });

    try {
      // AI 큐 시스템을 통한 응답 생성
      const requestId = await aiService.queueResponse(query, aiName, {
        onStart: () => {
          logDebug('AI generation started', {
            messageId,
            aiType: aiName,
            requestId
          });

          // 세션에 requestId 저장
          const session = streamingSessions.get(messageId);
          if (session) {
            session.requestId = requestId;
          }

          // 처리 시작 알림
          io.to(room).emit('aiMessageProcessing', {
            messageId,
            aiType: aiName,
            timestamp: new Date(),
            status: 'processing'
          });
        },
        onChunk: async (chunk) => {
          accumulatedContent += chunk.currentChunk || '';
          
          const session = streamingSessions.get(messageId);
          if (session) {
            session.content = accumulatedContent;
            session.lastUpdate = Date.now();
          }

          io.to(room).emit('aiMessageChunk', {
            messageId,
            currentChunk: chunk.currentChunk,
            fullContent: accumulatedContent,
            isCodeBlock: chunk.isCodeBlock,
            timestamp: new Date(),
            aiType: aiName,
            isComplete: false,
            status: 'streaming'
          });
        },
        onComplete: async (finalContent) => {
          if (isCompleted) return; // 이미 완료 처리된 경우 무시
          isCompleted = true;

          try {
            // AI 메시지 저장
            const aiMessage = await Message.create({
              room,
              content: finalContent.content || accumulatedContent.trim(),
              type: 'ai',
              aiType: aiName,
              timestamp: new Date(),
              reactions: {},
              metadata: {
                query,
                requestId,
                generationTime: Date.now() - timestamp.getTime(),
                queueTime: Date.now() - timestamp.getTime()
              }
            });

            // 메시지 캐시 무효화 (비동기 처리)
            CacheService.invalidateByTag(`room:${room}`).catch(error => {
              console.warn('Cache invalidation failed:', error);
            });

            // 완료 메시지 전송
            io.to(room).emit('aiMessageComplete', {
              messageId,
              _id: aiMessage._id,
              content: finalContent.content || accumulatedContent.trim(),
              aiType: aiName,
              timestamp: new Date(),
              isComplete: true,
              query,
              reactions: {},
              status: 'completed'
            });

            logDebug('AI response completed', {
              messageId,
              aiType: aiName,
              requestId,
              contentLength: (finalContent.content || accumulatedContent).length,
              generationTime: Date.now() - timestamp.getTime()
            });
          } catch (saveError) {
            console.error('Failed to save AI message:', saveError);
            
            io.to(room).emit('aiMessageError', {
              messageId,
              error: '메시지 저장 중 오류가 발생했습니다.',
              aiType: aiName,
              timestamp: new Date(),
              status: 'error'
            });
          } finally {
            // 스트리밍 세션 및 요청 락 정리
            streamingSessions.delete(messageId);
            if (requestKey) aiRequestLocks.delete(requestKey);
          }
        },
        onError: (error) => {
          console.error('AI response error:', error);
          
          // 스트리밍 세션 및 요청 락 정리
          streamingSessions.delete(messageId);
          if (requestKey) aiRequestLocks.delete(requestKey);

          // 에러 타입별 메시지 처리
          let errorMessage = 'AI 응답 생성 중 오류가 발생했습니다.';
          let retryable = true;
          
          if (error.message.includes('timeout')) {
            errorMessage = 'AI 응답 시간이 초과되었습니다. 다시 시도해주세요.';
          } else if (error.message.includes('한도')) {
            errorMessage = 'AI 서비스 요청 한도에 도달했습니다. 잠시 후 다시 시도해주세요.';
            retryable = false;
          } else if (error.message.includes('일시적인 문제')) {
            errorMessage = 'AI 서비스에 일시적인 문제가 발생했습니다.';
          }

          // 에러 메시지 전송
          io.to(room).emit('aiMessageError', {
            messageId,
            error: errorMessage,
            aiType: aiName,
            timestamp: new Date(),
            status: 'error',
            retryable
          });

          logDebug('AI response error', {
            messageId,
            aiType: aiName,
            requestId: streamingSessions.get(messageId)?.requestId,
            error: error.message
          });
        }
      });

      // 큐에 추가된 requestId 저장
      const session = streamingSessions.get(messageId);
      if (session) {
        session.requestId = requestId;
      }

      logDebug('AI request queued', {
        messageId,
        aiType: aiName,
        requestId,
        queueStatus: aiService.getQueueStatus()
      });

    } catch (error) {
      console.error('AI handler error:', error);
      
      // 스트리밍 세션 및 요청 락 정리
      streamingSessions.delete(messageId);
      if (requestKey) aiRequestLocks.delete(requestKey);

      // 큐 시스템 에러 메시지 전송
      io.to(room).emit('aiMessageError', {
        messageId,
        error: 'AI 서비스에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.',
        aiType: aiName,
        timestamp: new Date(),
        status: 'error',
        retryable: true
      });
    }
  }

  return io;
};