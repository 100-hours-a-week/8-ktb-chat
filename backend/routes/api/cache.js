const express = require('express');
const router = express.Router();
const auth = require('../../middleware/auth');
const CacheService = require('../../services/cacheService');

// 캐시 상태 확인 (헬스체크)
router.get('/health', async (req, res) => {
  try {
    const healthStatus = await CacheService.healthCheck();
    
    res.status(healthStatus.healthy ? 200 : 503).json({
      success: true,
      cache: healthStatus
    });
  } catch (error) {
    console.error('Cache health check error:', error);
    res.status(503).json({
      success: false,
      message: '캐시 상태 확인에 실패했습니다.',
      error: error.message
    });
  }
});

// 캐시 통계 조회
router.get('/stats', auth, async (req, res) => {
  try {
    const stats = CacheService.getStats();
    
    res.json({
      success: true,
      data: {
        ...stats,
        message: '캐시 통계 조회 성공'
      }
    });
  } catch (error) {
    console.error('Cache stats error:', error);
    res.status(500).json({
      success: false,
      message: '캐시 통계 조회에 실패했습니다.',
      error: error.message
    });
  }
});

// 캐시 통계 초기화 (부하 테스트용)
router.delete('/stats', auth, async (req, res) => {
  try {
    CacheService.resetStats();
    
    res.json({
      success: true,
      message: '캐시 통계가 초기화되었습니다.'
    });
  } catch (error) {
    console.error('Cache stats reset error:', error);
    res.status(500).json({
      success: false,
      message: '캐시 통계 초기화에 실패했습니다.',
      error: error.message
    });
  }
});

// 특정 캐시 무효화 (부하 테스트용)
router.delete('/invalidate/:tag', auth, async (req, res) => {
  try {
    const { tag } = req.params;
    const deletedCount = await CacheService.invalidateByTag(tag);
    
    res.json({
      success: true,
      message: `캐시 무효화 완료: ${tag}`,
      deletedCount
    });
  } catch (error) {
    console.error('Cache invalidation error:', error);
    res.status(500).json({
      success: false,
      message: '캐시 무효화에 실패했습니다.',
      error: error.message
    });
  }
});

// 캐시 예열 (부하 테스트용)
router.post('/warmup', auth, async (req, res) => {
  try {
    const { roomId } = req.body;
    await CacheService.warmUp(roomId);
    
    res.json({
      success: true,
      message: '캐시 예열이 완료되었습니다.',
      roomId: roomId || 'all'
    });
  } catch (error) {
    console.error('Cache warmup error:', error);
    res.status(500).json({
      success: false,
      message: '캐시 예열에 실패했습니다.',
      error: error.message
    });
  }
});

module.exports = router; 