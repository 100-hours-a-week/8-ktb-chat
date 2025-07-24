import { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/router';
import { Text } from '@vapor-ui/core';
import authService from '../services/authService';

// 전역 상태 관리 - 중복 인증 체크 방지
let isAuthChecking = false;

export const withAuth = (WrappedComponent) => {
  const WithAuthComponent = (props) => {
    const router = useRouter();
    const [isLoading, setIsLoading] = useState(true);
    const [authError, setAuthError] = useState(null);
    const mountedRef = useRef(true);
    const authCheckRef = useRef(false);

    useEffect(() => {
      mountedRef.current = true;
      
      const checkAuth = async () => {
        // 이미 인증 체크 중이거나 컴포넌트가 언마운트된 경우 중복 처리 방지
        if (authCheckRef.current || !mountedRef.current || isAuthChecking) {
          return;
        }

        try {
          authCheckRef.current = true;
          isAuthChecking = true;
          
          console.log('[WithAuth] Starting authentication check...');
          
          // 1. 기본 사용자 정보 확인
          const user = authService.getCurrentUser();
          if (!user || !user.token || !user.sessionId) {
            console.log('[WithAuth] No valid user session found');
            throw new Error('NO_AUTH_DATA');
          }

          // 2. 토큰 유효성 검증 (서버와 통신)
          try {
            console.log('[WithAuth] Verifying token...');
            const isValid = await authService.verifyToken();
            
            if (!isValid) {
              console.log('[WithAuth] Token verification failed');
              throw new Error('INVALID_TOKEN');
            }
            
            console.log('[WithAuth] Authentication successful');
            
            // 인증 성공 시에만 로딩 해제
            if (mountedRef.current) {
              setIsLoading(false);
              setAuthError(null);
            }
            
          } catch (verifyError) {
            console.error('[WithAuth] Token verification error:', verifyError);
            
            // 토큰 갱신 시도
            try {
              console.log('[WithAuth] Attempting token refresh...');
              const refreshed = await authService.refreshToken();
              
              if (refreshed && mountedRef.current) {
                console.log('[WithAuth] Token refresh successful');
                setIsLoading(false);
                setAuthError(null);
                return;
              }
            } catch (refreshError) {
              console.error('[WithAuth] Token refresh failed:', refreshError);
            }
            
            // 토큰 갱신도 실패한 경우
            throw new Error('TOKEN_REFRESH_FAILED');
          }

        } catch (error) {
          console.error('[WithAuth] Authentication failed:', error.message);
          
          if (!mountedRef.current) return;
          
          // 에러 유형에 따른 처리
          const errorCode = error.message || 'UNKNOWN_ERROR';
          let redirectPath = '/';
          
          switch (errorCode) {
            case 'NO_AUTH_DATA':
              redirectPath = `/?error=no_auth&redirect=${encodeURIComponent(router.asPath)}`;
              break;
            case 'INVALID_TOKEN':
            case 'TOKEN_REFRESH_FAILED':
              redirectPath = `/?error=session_expired&redirect=${encodeURIComponent(router.asPath)}`;
              break;
            default:
              redirectPath = `/?error=auth_error&redirect=${encodeURIComponent(router.asPath)}`;
          }
          
          // 로그아웃 처리
          authService.logout();
          
          // 리다이렉트 (현재 페이지가 이미 로그인 페이지가 아닌 경우에만)
          if (router.pathname !== '/') {
            setAuthError(errorCode);
            setTimeout(() => {
              if (mountedRef.current) {
                router.replace(redirectPath);
              }
            }, 100); // 약간의 딜레이로 상태 업데이트 완료 보장
          }
          
        } finally {
          authCheckRef.current = false;
          isAuthChecking = false;
        }
      };

      // 라우터가 준비된 후 인증 체크 시작
      if (router.isReady) {
        checkAuth();
      }

      // 인증 상태 변경 이벤트 리스너
      const handleAuthStateChange = () => {
        console.log('[WithAuth] Auth state changed, rechecking...');
        if (mountedRef.current && !authCheckRef.current) {
          checkAuth();
        }
      };

      // 전역 인증 상태 변경 감지
      window.addEventListener('authStateChange', handleAuthStateChange);

      return () => {
        mountedRef.current = false;
        window.removeEventListener('authStateChange', handleAuthStateChange);
      };
    }, [router, router.isReady, router.pathname]);

    // 컴포넌트 언마운트 시 정리
    useEffect(() => {
      return () => {
        mountedRef.current = false;
      };
    }, []);

    // 로딩 중이거나 에러가 있는 경우
    if (isLoading || authError) {
      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          backgroundColor: 'var(--vapor-color-background)',
          color: 'var(--vapor-color-text-primary)'
        }}>
          {isLoading ? (
            <>
              <div className="spinner-border mb-3" role="status">
                <span className="visually-hidden">Loading...</span>
              </div>
              <Text typography="body1">인증 확인 중...</Text>
            </>
          ) : authError ? (
            <>
              <Text typography="heading5" style={{ marginBottom: '16px', color: 'var(--vapor-color-danger)' }}>
                인증 오류
              </Text>
              <Text typography="body1" style={{ marginBottom: '16px' }}>
                로그인 페이지로 이동합니다...
              </Text>
            </>
          ) : null}
        </div>
      );
    }

    return <WrappedComponent {...props} />;
  };

  // HOC에 displayName 설정
  const displayName = WrappedComponent.displayName || WrappedComponent.name || 'Component';
  WithAuthComponent.displayName = `WithAuth(${displayName})`;

  return WithAuthComponent;
};

export const withoutAuth = (WrappedComponent) => {
  const WithoutAuthComponent = (props) => {
    const router = useRouter();
    const [isLoading, setIsLoading] = useState(true);
    const mountedRef = useRef(true);

    useEffect(() => {
      mountedRef.current = true;
      
      const checkAuth = async () => {
        // 라우터가 준비될 때까지 대기
        if (!router.isReady) {
          return;
        }
        
        try {
          const user = authService.getCurrentUser();
          
          if (user && user.token) {
            // 이미 로그인된 사용자가 로그인 페이지 접근 시
            if (router.pathname === '/' && mountedRef.current) {
              console.log('[WithoutAuth] Redirecting authenticated user to chat-rooms');
              await router.replace('/chat-rooms');
              return;
            }
          }
          
          if (mountedRef.current) {
            setIsLoading(false);
          }
          
        } catch (error) {
          console.error('[WithoutAuth] Auth check error:', error);
          if (mountedRef.current) {
            setIsLoading(false);
          }
        }
      };

      checkAuth();

      return () => {
        mountedRef.current = false;
      };
    }, [router, router.isReady]);

    if (isLoading) {
      return (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          backgroundColor: 'var(--vapor-color-background)',
          color: 'var(--vapor-color-text-primary)'
        }}>
          <Text typography="body1">Loading...</Text>
        </div>
      );
    }

    return <WrappedComponent {...props} />;
  };

  const displayName = WrappedComponent.displayName || WrappedComponent.name || 'Component';
  WithoutAuthComponent.displayName = `WithoutAuth(${displayName})`;

  return WithoutAuthComponent;
};