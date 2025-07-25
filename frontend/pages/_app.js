import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { ThemeProvider } from '@vapor-ui/core';
import { createThemeConfig } from '@vapor-ui/core';
import '@vapor-ui/core/styles.css';
import '../styles/globals.css';
import Navbar from '../components/Navbar';
import authService from '../services/authService';

// Create dark theme configuration
const themeConfig = createThemeConfig({
  appearance: 'dark',
  radius: 'md',
  scaling: 1.0,
  colors: {
    primary: '#3b82f6',
    secondary: '#64748b',
    success: '#10b981',
    warning: '#f59e0b',
    danger: '#ef4444',
    info: '#06b6d4',
  },
});

function MyApp({ Component, pageProps }) {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [isAuthInitialized, setIsAuthInitialized] = useState(false);

  useEffect(() => {
    setMounted(true);
    
    // 전역 인증 상태 초기화
    const initializeAuth = () => {
      try {
        // 페이지 로드 시 세션 검증
        const user = authService.getCurrentUser();
        console.log('[App] Auth initialization:', { hasUser: !!user });
        
        // URL 파라미터에서 에러 처리
        if (router.isReady && router.query.error) {
          const errorType = router.query.error;
          console.log('[App] URL error detected:', errorType);
          
          // 에러 유형에 따른 처리
          if (errorType === 'session_expired') {
            // 세션 만료 시 로그아웃 처리
            authService.logout();
          }
          
          // URL에서 에러 파라미터 제거 (새로고침 시 에러 메시지 중복 표시 방지)
          const { error, ...cleanQuery } = router.query;
          router.replace({
            pathname: router.pathname,
            query: cleanQuery
          }, undefined, { shallow: true });
        }
        
        setIsAuthInitialized(true);
      } catch (error) {
        console.error('[App] Auth initialization error:', error);
        setIsAuthInitialized(true);
      }
    };

    // 라우터가 준비되면 인증 초기화
    if (router.isReady) {
      initializeAuth();
    }

    // 전역 에러 핸들러
    const handleGlobalError = (event) => {
      console.error('[App] Global error:', event.error);
      
      // 인증 관련 에러인 경우 처리
      if (event.error?.message?.includes('Authentication') || 
          event.error?.message?.includes('Unauthorized')) {
        console.log('[App] Global auth error detected');
        authService.logout();
      }
    };

    // 전역 Promise rejection 핸들러
    const handleUnhandledRejection = (event) => {
      console.error('[App] Unhandled promise rejection:', event.reason);
      
      // 인증 관련 rejection인 경우 처리
      if (event.reason?.response?.status === 401 || 
          event.reason?.message?.includes('Authentication')) {
        console.log('[App] Global auth rejection detected');
        authService.logout();
      }
    };

    // 이벤트 리스너 등록
    window.addEventListener('error', handleGlobalError);
    window.addEventListener('unhandledrejection', handleUnhandledRejection);

    // 정리 함수
    return () => {
      window.removeEventListener('error', handleGlobalError);
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
    };
  }, [router, router.isReady]);

  // 마운트되지 않았거나 인증이 초기화되지 않은 경우 null 반환
  if (!mounted || !isAuthInitialized) {
    return null;
  }

  const showNavbar = !['/', '/register'].includes(router.pathname);

  return (
    <ThemeProvider config={themeConfig}>
      {showNavbar && <Navbar />}
      <Component {...pageProps} />
    </ThemeProvider>
  );
}

export default MyApp;