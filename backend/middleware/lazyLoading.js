/**
 * Lazy Loading 및 응답 최적화
 * 대용량 사용자 처리를 위한 데이터 로딩 최적화
 */

// 페이지네이션 최적화 (프론트엔드 호환성 유지)
const optimizePagination = (req, res, next) => {
  // 프론트엔드 기본값 유지 (변경하지 않음)
  const defaultPageSize = 20; // 프론트엔드 기본값 유지
  const maxPageSize = 100;    // 프론트엔드 최대값 유지
  
  // 쿼리 파라미터 정규화 (기존 로직 유지)
  req.pagination = {
    page: Math.max(0, parseInt(req.query.page) || 0),
    pageSize: Math.min(Math.max(1, parseInt(req.query.pageSize) || defaultPageSize), maxPageSize),
    offset: 0
  };
  
  req.pagination.offset = req.pagination.page * req.pagination.pageSize;
  
  next();
};

// 응답 데이터 압축 (프론트엔드 호환성 유지)
const compressResponse = (req, res, next) => {
  const originalJson = res.json;
  
  res.json = function(data) {
    // 큰 배열만 압축 (기존 프론트엔드 구조 유지)
    if (data && data.data && Array.isArray(data.data) && data.data.length > 50) {
      // 긴 텍스트만 압축
      data.data = data.data.map(item => {
        if (item && typeof item === 'object') {
          // 메시지 내용만 압축 (500자 이상일 때)
          if (item.content && item.content.length > 500) {
            return {
              ...item,
              content: item.content.substring(0, 500) + '...'
            };
          }
        }
        return item;
      });
    }
    
    return originalJson.call(this, data);
  };
  
  next();
};

// 지연 로딩 전략 (프론트엔드 호환성 유지)
const lazyLoadStrategy = {
  // 메시지 지연 로딩 (프론트엔드 기본값 유지)
  messages: {
    initialLoad: 30,      // 프론트엔드 기본값 유지
    subsequentLoad: 30,   // 프론트엔드 기본값 유지  
    maxLoad: 200         // 합리적 최대값
  },
  
  // 사용자 정보 지연 로딩 (기존 필드 유지)
  users: {
    basicInfo: ['_id', 'name', 'profileImage', 'email'], // 기존 필드 유지
    detailedInfo: ['lastActive', 'createdAt'] // 추가 정보만 지연
  },
  
  // 파일 정보 지연 로딩 (기존 구조 유지)
  files: {
    basicInfo: ['_id', 'filename', 'mimetype', 'size', 'originalname'], // 기본 필드 유지
    metadata: ['uploadDate', 'path'] // 메타데이터만 지연
  }
};

// 메시지 Lazy Loading 미들웨어 (프론트엔드 호환성 유지)
const messagelazyLoadMiddleware = (req, res, next) => {
  // 프론트엔드 요청 파라미터를 그대로 유지 (변경하지 않음)
  // 메시지 로딩은 Socket.IO를 통해 이루어지므로 HTTP 요청 수정 불필요
  next();
};

// 데이터베이스 쿼리 최적화 (선택적 적용)
const optimizeDBQueries = (req, res, next) => {
  // 부하 테스트용 쿼리 최적화 힌트 제공 (강제 적용하지 않음)
  req.dbOptimizationHints = {
    preferLean: true,     // lean() 사용 권장
    maxTimeMS: 15000,     // 넉넉한 쿼리 타임아웃
    indexHints: true      // 인덱스 사용 권장
  };
  
  next();
};

// 응답 캐시 헤더 설정
const setCacheHeaders = (req, res, next) => {
  // 정적 데이터에 대한 캐싱 헤더
  if (req.method === 'GET') {
    if (req.originalUrl.includes('/rooms') && !req.originalUrl.includes('/messages')) {
      // 채팅방 목록은 짧은 캐시
      res.set('Cache-Control', 'public, max-age=30');
    } else if (req.originalUrl.includes('/users/profile')) {
      // 사용자 프로필은 중간 캐시
      res.set('Cache-Control', 'public, max-age=300');
    } else if (req.originalUrl.includes('/files/view')) {
      // 파일 뷰는 긴 캐시
      res.set('Cache-Control', 'public, max-age=3600');
    } else {
      // 기본은 캐시 없음
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
  
  next();
};

// 요청 우선순위 설정 (부하 테스트용 - 지연 제거)
const prioritizeRequests = (req, res, next) => {
  // 우선순위만 설정하고 지연은 추가하지 않음 (부하 테스트용)
  const highPriorityPaths = [
    '/api/auth/login',
    '/api/auth/logout', 
    '/socket.io/',
    '/health'
  ];
  
  const mediumPriorityPaths = [
    '/api/rooms',
    '/api/users/profile'
  ];
  
  if (highPriorityPaths.some(path => req.originalUrl.includes(path))) {
    req.priority = 'high';
  } else if (mediumPriorityPaths.some(path => req.originalUrl.includes(path))) {
    req.priority = 'medium';
  } else {
    req.priority = 'low';
  }
  
  // 부하 테스트에서는 지연 없이 바로 처리
  next();
};

// 배치 요청 처리
const batchRequestHandler = (req, res, next) => {
  // 여러 요청을 배치로 처리하는 로직
  if (req.body && req.body.batch && Array.isArray(req.body.batch)) {
    req.isBatch = true;
    req.batchSize = Math.min(req.body.batch.length, 10); // 최대 10개까지
  }
  
  next();
};

// 응답 스트리밍 비활성화 (프론트엔드 호환성 유지)
const enableStreaming = (req, res, next) => {
  // 스트리밍은 프론트엔드 호환성 문제로 비활성화
  // 기본 JSON 응답 유지
  next();
};

module.exports = {
  optimizePagination,
  compressResponse,
  lazyLoadStrategy,
  messagelazyLoadMiddleware,
  optimizeDBQueries,
  setCacheHeaders,
  prioritizeRequests,
  batchRequestHandler,
  enableStreaming
}; 