const fs = require('fs');
const path = require('path');
const CacheService = require('../services/cacheService');

/**
 * 파일 전송 최적화 미들웨어
 * Range 요청, 조건부 요청, 압축 등을 지원
 */

// Range 요청 처리 미들웨어
const rangeRequestMiddleware = (req, res, next) => {
  const range = req.headers.range;
  
  if (range && req.method === 'GET') {
    // Range 요청 파싱
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : undefined;
    
    // Range 정보를 req 객체에 저장
    req.range = {
      start: isNaN(start) ? 0 : start,
      end: end,
      hasRange: true
    };
  } else {
    req.range = { hasRange: false };
  }
  
  next();
};

// 조건부 요청 처리 미들웨어
const conditionalRequestMiddleware = (req, res, next) => {
  // If-Modified-Since 헤더 확인
  const ifModifiedSince = req.headers['if-modified-since'];
  const ifNoneMatch = req.headers['if-none-match'];
  
  req.conditionalRequest = {
    ifModifiedSince: ifModifiedSince,
    ifNoneMatch: ifNoneMatch,
    hasConditional: !!(ifModifiedSince || ifNoneMatch)
  };
  
  next();
};

// 파일 스트림 최적화 함수
const createOptimizedFileStream = (filePath, options = {}) => {
  const {
    start = 0,
    end,
    highWaterMark = 64 * 1024 // 64KB 청크
  } = options;
  
  const streamOptions = {
    start,
    highWaterMark
  };
  
  if (end !== undefined) {
    streamOptions.end = end;
  }
  
  return fs.createReadStream(filePath, streamOptions);
};

// 파일 통계 정보 직접 조회 (캐싱 제거 - fs.stat이 충분히 빠름)
const fileStatDirectMiddleware = async (req, res, next) => {
  if (!req.params.filename) {
    return next();
  }
  
  try {
    const filename = req.params.filename;
    const { uploadDir } = require('./upload');
    const filePath = path.join(uploadDir, filename);
    
    try {
      const stat = await fs.promises.stat(filePath);
      req.fileStat = {
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        exists: true
      };
    } catch (error) {
      req.fileStat = { exists: false };
    }
    
    next();
  } catch (error) {
    console.error('File stat error:', error);
    next();
  }
};

// ETag 생성 함수
const generateETag = (filename, size, mtime) => {
  const crypto = require('crypto');
  const etag = crypto
    .createHash('md5')
    .update(`${filename}-${size}-${mtime}`)
    .digest('hex');
  return `"${etag}"`;
};

// 캐시 적용 파일 다운로드 미들웨어
const cachedFileDownloadMiddleware = async (req, res, next) => {
  try {
    if (!req.fileStat || !req.fileStat.exists) {
      return next();
    }
    
    const { filename } = req.params;
    const { size, mtime } = req.fileStat;
    
    // ETag 생성
    const etag = generateETag(filename, size, mtime);
    
    // 조건부 요청 처리
    if (req.conditionalRequest.hasConditional) {
      // If-None-Match 확인
      if (req.conditionalRequest.ifNoneMatch === etag) {
        return res.status(304).end();
      }
      
      // If-Modified-Since 확인
      if (req.conditionalRequest.ifModifiedSince) {
        const ifModDate = new Date(req.conditionalRequest.ifModifiedSince);
        const fileModDate = new Date(mtime);
        
        if (fileModDate <= ifModDate) {
          return res.status(304).end();
        }
      }
    }
    
    // ETag와 Last-Modified 헤더 설정
    res.set({
      'ETag': etag,
      'Last-Modified': new Date(mtime).toUTCString()
    });
    
    // Range 요청 처리
    if (req.range.hasRange) {
      const start = req.range.start;
      const end = req.range.end || (size - 1);
      const contentLength = end - start + 1;
      
      if (start >= size || end >= size) {
        res.set('Content-Range', `bytes */${size}`);
        return res.status(416).end();
      }
      
      res.set({
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': contentLength
      });
      
      res.status(206); // Partial Content
      req.streamOptions = { start, end };
    } else {
      res.set({
        'Accept-Ranges': 'bytes',
        'Content-Length': size
      });
      req.streamOptions = {};
    }
    
    next();
  } catch (error) {
    console.error('Cached file download middleware error:', error);
    next();
  }
};

// 파일 전송 성능 모니터링 미들웨어
const fileTransferMonitorMiddleware = (req, res, next) => {
  const startTime = Date.now();
  let bytesTransferred = 0;
  
  // 응답 완료 시 통계 수집
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const speed = bytesTransferred / (duration / 1000); // bytes per second
    
    // 느린 전송 감지 (10KB/s 미만)
    if (speed < 10240 && duration > 1000) {
      console.warn(`Slow file transfer: ${req.params.filename} - ${(speed/1024).toFixed(2)} KB/s`);
    }
    
    // 통계 로깅 (개발/테스트용)
    if (process.env.NODE_ENV === 'development') {
      console.debug(`File transfer: ${req.params.filename} - ${(bytesTransferred/1024).toFixed(2)} KB in ${duration}ms`);
    }
  });
  
  // 바이트 전송량 추적
  const originalWrite = res.write;
  res.write = function(chunk) {
    if (chunk) {
      bytesTransferred += chunk.length;
    }
    return originalWrite.apply(this, arguments);
  };
  
  next();
};

module.exports = {
  rangeRequest: rangeRequestMiddleware,
  conditionalRequest: conditionalRequestMiddleware,
  fileStatDirect: fileStatDirectMiddleware,
  cachedFileDownload: cachedFileDownloadMiddleware,
  fileTransferMonitor: fileTransferMonitorMiddleware,
  createOptimizedFileStream,
  generateETag
}; 