const express = require('express');
const authRoutes = require('./auth');
const userRoutes = require('./users');
const roomRoutes = require('./rooms');
const messageRoutes = require('./message');
const fileRoutes = require('./files');
const cacheRoutes = require('./cache');
const aiService = require('../../services/aiService');
const CacheService = require('../../services/cacheService');
const auth = require('../../middleware/auth');

const router = express.Router();

// Health check endpoint
router.get('/health', async (req, res) => {
  try {
    const cacheStatus = await CacheService.healthCheck();
    const aiQueueStatus = aiService.getQueueStatus();
    
    const status = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      services: {
        cache: cacheStatus,
        ai_queue: aiQueueStatus,
        database: 'connected' // MongoDB 연결 상태는 별도 체크 필요 시 추가
      },
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      environment: process.env.NODE_ENV
    };

    const httpStatus = cacheStatus.healthy && aiQueueStatus.isHealthy ? 200 : 503;
    res.status(httpStatus).json(status);
  } catch (error) {
    console.error('Health check error:', error);
    res.status(503).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      error: error.message
    });
  }
});

// AI 큐 상태 조회 (인증 필요)
router.get('/ai/queue-status', auth, (req, res) => {
  try {
    const queueStatus = aiService.getQueueStatus();
    res.json({
      success: true,
      data: queueStatus,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('AI queue status error:', error);
    res.status(500).json({
      success: false,
      message: 'AI 큐 상태 조회 중 오류가 발생했습니다.',
      error: error.message
    });
  }
});

// 캐시 통계 조회 (인증 필요)
router.get('/cache/stats', auth, (req, res) => {
  try {
    const cacheStats = CacheService.getStats();
    res.json({
      success: true,
      data: cacheStats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Cache stats error:', error);
    res.status(500).json({
      success: false,
      message: '캐시 통계 조회 중 오류가 발생했습니다.',
      error: error.message
    });
  }
});

// Route mounting
router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/rooms', roomRoutes);
router.use('/messages', messageRoutes);
router.use('/files', fileRoutes);
router.use('/cache', cacheRoutes);

module.exports = router;
