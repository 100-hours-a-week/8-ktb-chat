const compression = require('compression');
const CacheService = require('../services/cacheService');

/**
 * 부하 테스트용 성능 최적화 미들웨어
 * 보안, 모니터링, DDoS 방어 기능 제거
 */

// GZIP 압축 미들웨어 (성능 향상을 위해 유지)
const compressionMiddleware = compression({
  // 압축할 최소 크기 (바이트)
  threshold: 1024,
  // 압축 레벨 (0-9, 6이 기본값)
  level: 6,
  // 압축할 MIME 타입 필터
  filter: (req, res) => {
    // 이미 압축된 파일은 제외
    if (req.headers['x-no-compression']) {
      return false;
    }
    
    // 기본 압축 필터 사용
    return compression.filter(req, res);
  }
});

// 캐시 제어 미들웨어
const cacheControlMiddleware = (req, res, next) => {
  const path = req.path;
  
  // 정적 자산에 대한 캐시 설정
  if (path.match(/\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$/)) {
    // 정적 파일은 1년 캐시
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
  } else if (path.startsWith('/api/')) {
    // API 응답은 캐시하지 않음 (민감한 데이터)
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  } else {
    // 기타 파일은 짧은 캐시
    res.set('Cache-Control', 'public, max-age=300'); // 5분
  }
  
  next();
};

// ETag 미들웨어 (조건부 요청 지원) - 성능 향상을 위해 유지
const etagMiddleware = (req, res, next) => {
  const originalSend = res.send;
  
  res.send = function(data) {
    // GET 요청에 대해서만 ETag 생성
    if (req.method === 'GET' && data) {
      const crypto = require('crypto');
      const etag = crypto.createHash('md5').update(data).digest('hex');
      this.set('ETag', `"${etag}"`);
      
      // If-None-Match 헤더 확인
      const clientEtag = req.headers['if-none-match'];
      if (clientEtag && clientEtag === `"${etag}"`) {
        return this.status(304).end();
      }
    }
    
    return originalSend.call(this, data);
  };
  
  next();
};

// 캐시 예열 미들웨어 (앱 시작 시) - 성능 향상을 위해 유지
const cacheWarmupMiddleware = async (req, res, next) => {
  // 첫 번째 요청에서만 실행
  if (!cacheWarmupMiddleware.warmedUp) {
    cacheWarmupMiddleware.warmedUp = true;
    
    // 백그라운드에서 캐시 예열 실행
    setImmediate(async () => {
      try {
        console.log('Starting cache warmup...');
        await CacheService.warmUp();
        console.log('Cache warmup completed');
      } catch (error) {
        console.error('Cache warmup failed:', error);
      }
    });
  }
  
  next();
};

module.exports = {
  compression: compressionMiddleware,
  cacheControl: cacheControlMiddleware,
  etag: etagMiddleware,
  cacheWarmup: cacheWarmupMiddleware
}; 