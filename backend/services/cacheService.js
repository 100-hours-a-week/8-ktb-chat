const redisClient = require('../utils/redisClient');
const crypto = require('crypto');

/**
 * 통합 캐시 서비스 클래스
 * 모든 캐싱 로직을 중앙화하여 관리하고 다양한 캐싱 전략을 제공
 */
class CacheService {
  // 캐시 TTL 상수 정의 (초 단위)
  static TTL = {
    SHORT: 60,           // 1분 - 자주 변경되는 데이터
    MEDIUM: 300,         // 5분 - 중간 빈도 변경 데이터
    LONG: 1800,          // 30분 - 덜 자주 변경되는 데이터
    EXTENDED: 3600,      // 1시간 - 거의 변경되지 않는 데이터
    SESSION: 86400       // 24시간 - 세션 데이터
  };

  // 캐시 키 접두사 정의
  static PREFIXES = {
    MESSAGES: 'chat:messages:',
    USER: 'user:profile:',
    ROOM: 'chat:room:',
    ROOM_LIST: 'chat:rooms:list:',
    USER_ROOMS: 'user:rooms:',
    STATS: 'stats:',
    AI_RESPONSE: 'ai:response:',
    FILE_METADATA: 'file:meta:'
  };

  // 캐시 통계 추적
  static stats = {
    hits: 0,
    misses: 0,
    sets: 0,
    deletes: 0,
    errors: 0
  };

  /**
   * 캐시에서 데이터 조회
   * @param {string} key - 캐시 키
   * @param {Function} fetchFunction - 캐시 미스 시 실행할 데이터 조회 함수
   * @param {number} ttl - TTL (초)
   * @param {Object} options - 추가 옵션
   * @returns {Promise<any>} 캐시된 데이터 또는 새로 조회한 데이터
   */
  static async get(key, fetchFunction = null, ttl = this.TTL.MEDIUM, options = {}) {
    try {
      // 캐시에서 먼저 조회
      const cached = await redisClient.get(key);
      
      if (cached !== null) {
        this.stats.hits++;
        console.debug(`Cache HIT: ${key}`);
        return cached;
      }

      this.stats.misses++;
      console.debug(`Cache MISS: ${key}`);

      // fetchFunction이 제공된 경우 데이터 조회 후 캐시 저장
      if (fetchFunction && typeof fetchFunction === 'function') {
        const data = await fetchFunction();
        
        if (data !== null && data !== undefined) {
          await this.set(key, data, ttl, options);
          return data;
        }
      }

      return null;
    } catch (error) {
      this.stats.errors++;
      console.error('Cache get error:', error);
      
      // 캐시 실패 시 fetchFunction이 있으면 직접 실행
      if (fetchFunction && typeof fetchFunction === 'function') {
        try {
          return await fetchFunction();
        } catch (fetchError) {
          console.error('Fallback fetch error:', fetchError);
          throw fetchError;
        }
      }
      
      throw error;
    }
  }

  /**
   * 캐시에 데이터 저장
   * @param {string} key - 캐시 키
   * @param {any} value - 저장할 데이터
   * @param {number} ttl - TTL (초)
   * @param {Object} options - 추가 옵션
   * @returns {Promise<boolean>} 저장 성공 여부
   */
  static async set(key, value, ttl = this.TTL.MEDIUM, options = {}) {
    try {
      // null이나 undefined는 캐시하지 않음
      if (value === null || value === undefined) {
        return false;
      }

      await redisClient.setEx(key, ttl, value);
      this.stats.sets++;
      console.debug(`Cache SET: ${key} (TTL: ${ttl}s)`);
      return true;
    } catch (error) {
      this.stats.errors++;
      console.error('Cache set error:', error);
      return false;
    }
  }

  /**
   * 캐시에서 데이터 삭제
   * @param {string|string[]} keys - 삭제할 캐시 키(들)
   * @returns {Promise<number>} 삭제된 키의 개수
   */
  static async del(keys) {
    try {
      const keyArray = Array.isArray(keys) ? keys : [keys];
      const result = await redisClient.del(keyArray);
      this.stats.deletes += keyArray.length;
      console.debug(`Cache DEL: ${keyArray.join(', ')}`);
      return result;
    } catch (error) {
      this.stats.errors++;
      console.error('Cache delete error:', error);
      return 0;
    }
  }

  /**
   * 패턴으로 캐시 키 검색 및 삭제
   * @param {string} pattern - 검색 패턴 (예: 'chat:rooms:*')
   * @returns {Promise<number>} 삭제된 키의 개수
   */
  static async deleteByPattern(pattern) {
    try {
      const keys = await redisClient.keys(pattern);
      if (keys.length > 0) {
        return await this.del(keys);
      }
      return 0;
    } catch (error) {
      this.stats.errors++;
      console.error('Cache delete by pattern error:', error);
      return 0;
    }
  }

  /**
   * 메시지 캐싱 - 채팅방별 메시지 목록
   * @param {string} roomId - 채팅방 ID
   * @param {string|null} before - 이전 메시지 기준 시간
   * @param {number} limit - 메시지 개수 제한
   * @param {Function} fetchFunction - 메시지 조회 함수
   * @returns {Promise<Object>} 메시지 목록과 메타데이터
   */
  static async getMessages(roomId, before = null, limit = 30, fetchFunction) {
    const beforeKey = before ? crypto.createHash('md5').update(before).digest('hex').substring(0, 8) : 'latest';
    const key = `${this.PREFIXES.MESSAGES}${roomId}:${beforeKey}:${limit}`;
    
    return await this.get(key, fetchFunction, this.TTL.SHORT, {
      tags: ['messages', `room:${roomId}`]
    });
  }

  /**
   * 사용자 프로필 캐싱
   * @param {string} userId - 사용자 ID
   * @param {Function} fetchFunction - 사용자 정보 조회 함수
   * @returns {Promise<Object>} 사용자 프로필 정보
   */
  static async getUserProfile(userId, fetchFunction) {
    const key = `${this.PREFIXES.USER}${userId}`;
    
    return await this.get(key, fetchFunction, this.TTL.LONG, {
      tags: ['user', `user:${userId}`]
    });
  }

  /**
   * 채팅방 상세 정보 캐싱
   * @param {string} roomId - 채팅방 ID
   * @param {Function} fetchFunction - 채팅방 정보 조회 함수
   * @returns {Promise<Object>} 채팅방 상세 정보
   */
  static async getRoomDetails(roomId, fetchFunction) {
    const key = `${this.PREFIXES.ROOM}${roomId}`;
    
    return await this.get(key, fetchFunction, this.TTL.MEDIUM, {
      tags: ['room', `room:${roomId}`]
    });
  }

  /**
   * 사용자별 참여 채팅방 목록 캐싱
   * @param {string} userId - 사용자 ID
   * @param {Function} fetchFunction - 채팅방 목록 조회 함수
   * @returns {Promise<Array>} 참여 중인 채팅방 목록
   */
  static async getUserRooms(userId, fetchFunction) {
    const key = `${this.PREFIXES.USER_ROOMS}${userId}`;
    
    return await this.get(key, fetchFunction, this.TTL.MEDIUM, {
      tags: ['user_rooms', `user:${userId}`]
    });
  }

  /**
   * 파일 메타데이터 캐싱
   * @param {string} fileId - 파일 ID
   * @param {Function} fetchFunction - 파일 정보 조회 함수
   * @returns {Promise<Object>} 파일 메타데이터
   */
  static async getFileMetadata(fileId, fetchFunction) {
    const key = `${this.PREFIXES.FILE_METADATA}${fileId}`;
    
    return await this.get(key, fetchFunction, this.TTL.EXTENDED, {
      tags: ['file', `file:${fileId}`]
    });
  }

  /**
   * 파일 권한 캐싱 (사용자가 특정 파일에 접근 권한이 있는지)
   * @param {string} filename - 파일명
   * @param {string} userId - 사용자 ID
   * @param {Function} fetchFunction - 권한 확인 함수
   * @returns {Promise<Object>} 파일 정보 및 권한
   */
  static async getFileAccess(filename, userId, fetchFunction) {
    const key = `file:access:${filename}:${userId}`;
    
    return await this.get(key, fetchFunction, this.TTL.MEDIUM, {
      tags: ['file_access', `file:${filename}`, `user:${userId}`]
    });
  }

  // getFileHeaders 제거 - 로컬에서 직접 생성이 더 빠름

  /**
   * 파일 업로드 중복 체크 캐싱 (같은 파일이 이미 업로드되었는지)
   * @param {string} hash - 파일 해시
   * @param {string} userId - 사용자 ID
   * @param {Function} fetchFunction - 중복 확인 함수
   * @returns {Promise<Object>} 기존 파일 정보 (있는 경우)
   */
  static async getFileDuplicate(hash, userId, fetchFunction) {
    const key = `file:duplicate:${hash}:${userId}`;
    
    return await this.get(key, fetchFunction, this.TTL.LONG, {
      tags: ['file_duplicate', `user:${userId}`]
    });
  }

  /**
   * AI 응답 캐싱 (동일한 질문에 대한 응답 재사용)
   * @param {string} query - AI 질문
   * @param {string} aiType - AI 타입
   * @param {Function} fetchFunction - AI 응답 생성 함수
   * @returns {Promise<string>} AI 응답
   */
  static async getAIResponse(query, aiType, fetchFunction) {
    // 질문을 해시화하여 캐시 키 생성
    const queryHash = crypto.createHash('md5').update(query + aiType).digest('hex');
    const key = `${this.PREFIXES.AI_RESPONSE}${queryHash}`;
    
    return await this.get(key, fetchFunction, this.TTL.LONG, {
      tags: ['ai_response', `ai:${aiType}`]
    });
  }

  /**
   * 캐시 무효화 - 특정 태그로 관련 캐시 삭제
   * @param {string} tag - 무효화할 태그 (예: 'room:123', 'user:456')
   * @returns {Promise<number>} 삭제된 캐시 항목 수
   */
  static async invalidateByTag(tag) {
    try {
      let deletedCount = 0;

      // 태그별 무효화 로직
      if (tag.startsWith('room:')) {
        const roomId = tag.split(':')[1];
        const patterns = [
          `${this.PREFIXES.MESSAGES}${roomId}:*`,
          `${this.PREFIXES.ROOM}${roomId}`,
          `${this.PREFIXES.ROOM_LIST}*` // 방 목록도 무효화
        ];
        
        for (const pattern of patterns) {
          deletedCount += await this.deleteByPattern(pattern);
        }
      } else if (tag.startsWith('user:')) {
        const userId = tag.split(':')[1];
        const patterns = [
          `${this.PREFIXES.USER}${userId}`,
          `${this.PREFIXES.USER_ROOMS}${userId}`
        ];
        
        for (const pattern of patterns) {
          deletedCount += await this.deleteByPattern(pattern);
        }
      } else if (tag === 'room_list') {
        deletedCount += await this.deleteByPattern(`${this.PREFIXES.ROOM_LIST}*`);
      } else if (tag.startsWith('file:')) {
        const filename = tag.split(':')[1];
        const patterns = [
          `${this.PREFIXES.FILE_METADATA}${filename}`,
          `file:access:${filename}:*`
        ];
        
        for (const pattern of patterns) {
          deletedCount += await this.deleteByPattern(pattern);
        }
      } else if (tag === 'file_duplicate') {
        deletedCount += await this.deleteByPattern('file:duplicate:*');
      } else if (tag === 'file_access') {
        deletedCount += await this.deleteByPattern('file:access:*');
      }

      console.debug(`Cache invalidated by tag: ${tag} (${deletedCount} items)`);
      return deletedCount;
    } catch (error) {
      this.stats.errors++;
      console.error('Cache invalidation error:', error);
      return 0;
    }
  }

  /**
   * 대량 무효화 - 여러 태그 동시 처리
   * @param {string[]} tags - 무효화할 태그 배열
   * @returns {Promise<number>} 총 삭제된 캐시 항목 수
   */
  static async invalidateMultiple(tags) {
    let totalDeleted = 0;
    
    for (const tag of tags) {
      totalDeleted += await this.invalidateByTag(tag);
    }
    
    return totalDeleted;
  }

  /**
   * 캐시 통계 조회
   * @returns {Object} 캐시 히트율 및 통계 정보
   */
  static getStats() {
    const total = this.stats.hits + this.stats.misses;
    const hitRate = total > 0 ? (this.stats.hits / total * 100).toFixed(2) : 0;
    
    return {
      hitRate: `${hitRate}%`,
      hits: this.stats.hits,
      misses: this.stats.misses,
      sets: this.stats.sets,
      deletes: this.stats.deletes,
      errors: this.stats.errors,
      total: total
    };
  }

  /**
   * 캐시 통계 초기화
   */
  static resetStats() {
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      deletes: 0,
      errors: 0
    };
  }

  /**
   * 캐시 상태 확인 (헬스체크용)
   * @returns {Promise<Object>} 캐시 상태 정보
   */
  static async healthCheck() {
    try {
      const testKey = 'cache:health:test';
      const testValue = Date.now();
      
      // 쓰기 테스트
      await redisClient.setEx(testKey, 10, testValue);
      
      // 읽기 테스트
      const retrieved = await redisClient.get(testKey);
      
      // 삭제 테스트
      await redisClient.del(testKey);
      
      const isHealthy = retrieved == testValue;
      
      return {
        healthy: isHealthy,
        timestamp: new Date().toISOString(),
        stats: this.getStats(),
        redis_connected: true
      };
    } catch (error) {
      console.error('Cache health check failed:', error);
      return {
        healthy: false,
        timestamp: new Date().toISOString(),
        error: error.message,
        stats: this.getStats(),
        redis_connected: false
      };
    }
  }

  /**
   * 캐시 예열 - 자주 사용되는 데이터 미리 로드
   * @param {string} roomId - 채팅방 ID (선택)
   * @returns {Promise<void>}
   */
  static async warmUp(roomId = null) {
    try {
      console.log('Cache warming up...');
      
      if (roomId) {
        // 특정 채팅방의 최신 메시지 미리 로드
        const Message = require('../models/Message');
        const messages = await Message.find({ room: roomId })
          .populate('sender', 'name email profileImage')
          .sort({ timestamp: -1 })
          .limit(30)
          .lean();
        
        if (messages.length > 0) {
          const cacheKey = `${this.PREFIXES.MESSAGES}${roomId}:latest:30`;
          await this.set(cacheKey, {
            messages: messages.reverse(),
            hasMore: messages.length >= 30,
            oldestTimestamp: messages[0]?.timestamp
          }, this.TTL.SHORT);
        }
      }
      
      console.log('Cache warm up completed');
    } catch (error) {
      console.error('Cache warm up error:', error);
    }
  }
}

module.exports = CacheService; 