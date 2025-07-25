// frontend/services/axios.js
import axios from 'axios';
import authService from './authService';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL;

if (!API_BASE_URL) {
  console.warn('Warning: NEXT_PUBLIC_API_URL is not defined in environment variables');
}

// 재시도 설정
const RETRY_CONFIG = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 5000,
  backoffFactor: 2,
  retryableStatuses: [408, 429, 500, 502, 503, 504],
  retryableErrors: ['ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'ENETUNREACH', 'ERR_NETWORK']
};

// 전역 상태 관리 - 무한 리다이렉트 방지
let isRedirecting = false;
let isRefreshingToken = false;
let tokenRefreshPromise = null;

// 기본 설정으로 axios 인스턴스 생성
const axiosInstance = axios.create({
  baseURL: API_BASE_URL || 'http://localhost:5000',
  timeout: 30000,
  withCredentials: true,
  headers: {
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  }
});

// 대기 중인 요청 관리
const pendingRequests = new Map();

// 재시도 딜레이 계산 함수 
const getRetryDelay = (retryCount) => {
  // 지수 백오프와 약간의 무작위성 추가
  const delay = RETRY_CONFIG.initialDelayMs * 
    Math.pow(RETRY_CONFIG.backoffFactor, retryCount) *
    (1 + Math.random() * 0.1); // 지터 추가
  return Math.min(delay, RETRY_CONFIG.maxDelayMs);
};

// 재시도 가능한 에러 판단
const isRetryableError = (error) => {
  if (error.code && RETRY_CONFIG.retryableErrors.includes(error.code)) {
    return true;
  }
  return !error.response || RETRY_CONFIG.retryableStatuses.includes(error.response.status);
};

// 중복 요청 방지
const isDuplicateRequest = (config) => {
  const requestKey = `${config.method}:${config.url}`;
  if (pendingRequests.has(requestKey)) {
    console.log('Duplicate request prevented:', requestKey);
    return true;
  }
  pendingRequests.set(requestKey, true);
  return false;
};

// 안전한 로그아웃 및 리다이렉트 함수
const handleAuthFailure = async (errorCode = 'session_expired') => {
  // 이미 리다이렉트 중이면 중복 처리 방지
  if (isRedirecting) {
    console.log('Already redirecting, skipping duplicate auth failure handling');
    return;
  }

  try {
    isRedirecting = true;
    console.log(`[Auth] Handling auth failure with code: ${errorCode}`);
    
    // 로그아웃 처리
    authService.logout();
    
    // 클라이언트 사이드에서만 리다이렉트
    if (typeof window !== 'undefined') {
      // 현재 페이지가 이미 로그인 페이지가 아닌 경우에만 리다이렉트
      if (window.location.pathname !== '/') {
        window.location.href = `/?error=${errorCode}`;
      }
    }
  } catch (error) {
    console.error('Error during auth failure handling:', error);
  } finally {
    // 3초 후 리다이렉트 상태 리셋 (혹시 모를 상황 대비)
    setTimeout(() => {
      isRedirecting = false;
    }, 3000);
  }
};

// 요청 인터셉터
axiosInstance.interceptors.request.use(
  async (config) => {
    try {
      // 중복 요청 체크
      if (isDuplicateRequest(config)) {
        const error = new Error('Duplicate request prevented');
        error.code = 'DUPLICATE_REQUEST';
        return Promise.reject(error);
      }

      // 요청 데이터 검증
      if (config.method !== 'get' && !config.data) {
        config.data = {};
      }

      // 인증 토큰 설정
      const user = authService.getCurrentUser();
      if (user?.token) {
        config.headers['x-auth-token'] = user.token;
        if (user.sessionId) {
          config.headers['x-session-id'] = user.sessionId;
        }
      }

      return config;
    } catch (error) {
      console.error('Request interceptor error:', error);
      return Promise.reject(error);
    }
  },
  (error) => Promise.reject(error)
);

// 응답 인터셉터
axiosInstance.interceptors.response.use(
  (response) => {
    // 성공한 요청 제거
    const requestKey = `${response.config.method}:${response.config.url}`;
    pendingRequests.delete(requestKey);
    
    return response;
  },
  async (error) => {
    const config = error.config || {};
    
    // 요청 키 제거
    if (config.method && config.url) {
      const requestKey = `${config.method}:${config.url}`;
      pendingRequests.delete(requestKey);
    }
    
    config.retryCount = config.retryCount || 0;
    
    // 중복 요청 에러는 무시
    if (error.code === 'DUPLICATE_REQUEST') {
      return Promise.reject(error);
    }
    
    // 요청이 취소된 경우
    if (axios.isCancel(error)) {
      console.log('Request canceled:', error.message);
      return Promise.reject(error);
    }

    // 재시도 가능한 에러이고 최대 재시도 횟수에 도달하지 않은 경우
    if (isRetryableError(error) && config.retryCount < RETRY_CONFIG.maxRetries) {
      config.retryCount++;
      const delay = getRetryDelay(config.retryCount);
      
      console.log(
        `Retrying request (${config.retryCount}/${RETRY_CONFIG.maxRetries}) ` +
        `after ${Math.round(delay)}ms:`, 
        config.url
      );
      
      try {
        // 딜레이 후 재시도
        await new Promise(resolve => setTimeout(resolve, delay));
        return await axiosInstance(config);
      } catch (retryError) {
        if (config.retryCount >= RETRY_CONFIG.maxRetries) {
          console.error('Max retry attempts reached:', config.url);
        }
        return Promise.reject(retryError);
      }
    }

    // 에러 유형별 처리
    if (!error.response) {
      // 네트워크 오류
      const customError = new Error();
      customError.message = [
        '서버와 통신할 수 없습니다.',
        '네트워크 연결을 확인하고 잠시 후 다시 시도해주세요.',
        error.code ? `(Error: ${error.code})` : ''
      ].filter(Boolean).join(' ');
      
      customError.isNetworkError = true;
      customError.originalError = error;
      customError.status = 0;
      customError.code = error.code || 'NETWORK_ERROR';
      customError.config = config;
      
      customError.retry = async () => {
        try {
          return await axiosInstance(config);
        } catch (retryError) {
          console.error('Manual retry failed:', retryError);
          throw retryError;
        }
      };
      
      throw customError;
    }

    // HTTP 상태 코드별 처리
    const status = error.response.status;
    const errorData = error.response.data;
    
    let errorMessage;
    let shouldLogout = false;
    
    switch (status) {
      case 400:
        errorMessage = errorData?.message || '잘못된 요청입니다.';
        break;
        
      case 401:
        errorMessage = '인증이 필요하거나 만료되었습니다.';
        shouldLogout = true;
        break;
        
      case 403:
        errorMessage = errorData?.message || '접근 권한이 없습니다.';
        break;
        
      case 404:
        errorMessage = errorData?.message || '요청한 리소스를 찾을 수 없습니다.';
        break;
        
      case 408:
        errorMessage = '요청 시간이 초과되었습니다.';
        break;
        
      case 429:
        errorMessage = '너무 많은 요청이 발생했습니다. 잠시 후 다시 시도해주세요.';
        break;
        
      case 500:
        errorMessage = '서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요.';
        break;
        
      case 502:
      case 503:
      case 504:
        errorMessage = '서버가 일시적으로 응답할 수 없습니다. 잠시 후 다시 시도해주세요.';
        break;
        
      default:
        errorMessage = errorData?.message || '예기치 않은 오류가 발생했습니다.';
    }

    // 에러 객체 생성 및 메타데이터 추가
    const enhancedError = new Error(errorMessage);
    enhancedError.status = status;
    enhancedError.code = errorData?.code;
    enhancedError.data = errorData;
    enhancedError.config = config;
    enhancedError.originalError = error;
    enhancedError.retry = async () => {
      try {
        return await axiosInstance(config);
      } catch (retryError) {
        console.error('Manual retry failed:', retryError);
        throw retryError;
      }
    };

    // 401 에러 처리 - 토큰 갱신 시도
    if (status === 401 && !isRefreshingToken && !isRedirecting) {
      try {
        // 토큰 갱신이 이미 진행 중이면 기다림
        if (tokenRefreshPromise) {
          await tokenRefreshPromise;
          const user = authService.getCurrentUser();
          if (user?.token) {
            config.headers['x-auth-token'] = user.token;
            config.headers['x-session-id'] = user.sessionId;
            return axiosInstance(config);
          }
        } else {
          // 새로운 토큰 갱신 시도
          isRefreshingToken = true;
          tokenRefreshPromise = authService.refreshToken();
          
          const refreshed = await tokenRefreshPromise;
          if (refreshed) {
            // 토큰 갱신 성공 시 원래 요청 재시도
            const user = authService.getCurrentUser();
            if (user?.token) {
              config.headers['x-auth-token'] = user.token;
              config.headers['x-session-id'] = user.sessionId;
              return axiosInstance(config);
            }
          }
        }
      } catch (refreshError) {
        console.error('Token refresh failed:', refreshError);
        // 토큰 갱신 실패 시 로그아웃 및 리다이렉트
        await handleAuthFailure('session_expired');
      } finally {
        isRefreshingToken = false;
        tokenRefreshPromise = null;
      }
    }

    // 이미 리다이렉트 중이면 에러만 던지고 추가 처리 안함
    if (isRedirecting) {
      throw enhancedError;
    }

    // 401 에러이고 토큰 갱신도 실패한 경우
    if (status === 401) {
      await handleAuthFailure('session_expired');
    }

    throw enhancedError;
  }
);

export default axiosInstance;