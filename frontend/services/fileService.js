import axios, { isCancel, CancelToken } from "axios";
import authService from "./authService";
import { Toast } from "../components/Toast";


export async function saveS3UrlToBackend(s3Url, originalname) {
  const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/files/save-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: s3Url, originalname }),
  });

  const data = await response.json();
  if (!response.ok || !data.success) {
    throw new Error(data.message || "URL 저장 실패");
  }

  return data.file;
}

class FileService {
  constructor() {
    this.baseUrl = process.env.NEXT_PUBLIC_API_URL;
    this.uploadLimit = 50 * 1024 * 1024; // 50MB
    this.retryAttempts = 3;
    this.retryDelay = 1000;
    this.activeUploads = new Map();

    this.allowedTypes = {
      image: {
        extensions: [".jpg", ".jpeg", ".png", ".gif", ".webp"],
        mimeTypes: ["image/jpeg", "image/png", "image/gif", "image/webp"],
        maxSize: 10 * 1024 * 1024,
        name: "이미지",
      },
      video: {
        extensions: [".mp4", ".webm", ".mov"],
        mimeTypes: ["video/mp4", "video/webm", "video/quicktime"],
        maxSize: 50 * 1024 * 1024,
        name: "동영상",
      },
      audio: {
        extensions: [".mp3", ".wav", ".ogg"],
        mimeTypes: ["audio/mpeg", "audio/wav", "audio/ogg"],
        maxSize: 20 * 1024 * 1024,
        name: "오디오",
      },
      document: {
        extensions: [".pdf", ".doc", ".docx", ".txt"],
        mimeTypes: [
          "application/pdf",
          "application/msword",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "text/plain",
        ],
        maxSize: 20 * 1024 * 1024,
        name: "문서",
      },
      archive: {
        extensions: [".zip", ".rar", ".7z"],
        mimeTypes: [
          "application/zip",
          "application/x-rar-compressed",
          "application/x-7z-compressed",
        ],
        maxSize: 50 * 1024 * 1024,
        name: "압축파일",
      },
    };
  }

  async validateFile(file) {
    if (!file) {
      const message = "파일이 선택되지 않았습니다.";
      Toast.error(message);
      return { success: false, message };
    }

    if (file.size > this.uploadLimit) {
      const message = `파일 크기는 ${this.formatFileSize(
        this.uploadLimit
      )}를 초과할 수 없습니다.`;
      Toast.error(message);
      return { success: false, message };
    }

    let isAllowedType = false;
    let maxTypeSize = 0;
    let typeConfig = null;

    for (const config of Object.values(this.allowedTypes)) {
      if (config.mimeTypes.includes(file.type)) {
        isAllowedType = true;
        maxTypeSize = config.maxSize;
        typeConfig = config;
        break;
      }
    }

    if (!isAllowedType) {
      const message = "지원하지 않는 파일 형식입니다.";
      Toast.error(message);
      return { success: false, message };
    }

    if (file.size > maxTypeSize) {
      const message = `${typeConfig.name} 파일은 ${this.formatFileSize(
        maxTypeSize
      )}를 초과할 수 없습니다.`;
      Toast.error(message);
      return { success: false, message };
    }

    const ext = this.getFileExtension(file.name);
    if (!typeConfig.extensions.includes(ext.toLowerCase())) {
      const message = "파일 확장자가 올바르지 않습니다.";
      Toast.error(message);
      return { success: false, message };
    }

    return { success: true };
  }

  async uploadFile(file, onProgress) {
    console.log("[Upload] 📂 업로드 시작 - 파일명:", file.name, "크기:", file.size, "타입:", file.type);
    
    const validationResult = await this.validateFile(file);
    if (!validationResult.success) {
      console.error("[Upload] 파일 유효성 검사 실패:", validationResult.message);
      return validationResult;
    }
    console.log("[Upload] 파일 유효성 검사 통과");

    try {
      // 인증 정보 확인
      const user = authService.getCurrentUser();
      console.log("[Upload] 인증 정보 확인:", {
        hasToken: !!user?.token,
        hasSessionId: !!user?.sessionId,
        tokenLength: user?.token?.length,
      });
      
      if (!user?.token || !user?.sessionId) {
        console.warn("[Upload] 인증 정보 없음");
        return {
          success: false,
          message: "인증 정보가 없습니다.",
        };
      }

      const source = CancelToken.source();
      this.activeUploads.set(file.name, source);

      // S3 URL 준비 - 실제 S3에 업로드될 파일명
      const fileKey = `${Date.now()}-${file.name}`;
      const s3Bucket = "8-ktb-chat-images";
      const s3Region = "ap-northeast-2";
      const s3Url = `https://${s3Bucket}.s3.${s3Region}.amazonaws.com/${fileKey}`;

      console.log("[Upload] S3 업로드 준비:", {
        fileKey,
        originalFilename: file.name,
        s3Bucket,
        s3Region,
        s3Url,
        encodedUrl: encodeURI(s3Url)
      });

      // S3 업로드 헤더 확인 (ACL 헤더 제거)
      const uploadHeaders = {
        "Content-Type": file.type
        // "x-amz-acl": "public-read" // 403 에러 방지를 위해 제거
      };
      console.log("[Upload] S3 업로드 헤더:", uploadHeaders);

      console.log("[Upload] S3 PUT 요청 시작...");
      
      const uploadRes = await axios.put(s3Url, file, {
        headers: uploadHeaders,
        cancelToken: source.token,
        timeout: 60000, // 60초 타임아웃
        onUploadProgress: (progressEvent) => {
          const percentCompleted = Math.round(
            (progressEvent.loaded * 100) / progressEvent.total
          );
          console.log(`[Upload] 업로드 진행률: ${percentCompleted}%`);
          if (onProgress) {
            onProgress(percentCompleted);
          }
        },
      });

      console.log("[Upload] S3 응답 수신:", {
        status: uploadRes.status,
        statusText: uploadRes.statusText,
        headers: uploadRes.headers,
        data: uploadRes.data
      });

      if (uploadRes.status !== 200) {
        console.error("[Upload] S3 업로드 실패 - 상태 코드:", uploadRes.status);
        console.error("[Upload] 응답 상세:", uploadRes);
        return {
          success: false,
          message: `S3 업로드에 실패했습니다. (상태: ${uploadRes.status})`,
        };
      }

      console.log("[Upload] S3 업로드 완료:", s3Url);

      // 백엔드 API 호출 준비 - 실제 S3에 업로드된 파일명(fileKey) 사용
      const uploadUrl = this.baseUrl
        ? `${this.baseUrl}/api/files/s3-url`
        : "/api/files/s3-url";

      const backendPayload = {
        fileUrl: s3Url,
        filename: fileKey,           // 수정: 실제 S3 파일명 사용
        originalname: file.name,     // 추가: 원본 파일명은 별도 필드로
        mimetype: file.type,
        size: file.size,
        s3Key: fileKey,              // 추가: 명시적 S3 키
        s3Url: s3Url          
      };

      const backendHeaders = {
        "x-auth-token": user.token,
        "x-session-id": user.sessionId,
      };

      console.log("[Upload] 백엔드 API 호출 준비:", {
        url: uploadUrl,
        payload: backendPayload,
        headers: { ...backendHeaders, "x-auth-token": "***토큰숨김***" }
      });

      console.log("[Upload] 백엔드 POST 요청 시작...");

      const response = await axios.post(uploadUrl, backendPayload, {
        headers: backendHeaders,
        withCredentials: true,
        timeout: 30000, // 30초 타임아웃
      });

      this.activeUploads.delete(file.name);

      console.log("[Upload] 백엔드 응답 수신:", {
        status: response.status,
        statusText: response.statusText,
        data: response.data
      });

      if (!response.data || !response.data.success) {
        console.error("[Upload] 백엔드 응답 실패:", response.data);
        return {
          success: false,
          message: response.data?.message || "백엔드 전송에 실패했습니다.",
        };
      }

      const fileData = response.data.file;
      console.log("[Upload] 전체 업로드 프로세스 완료:", fileData);
      
      return {
        success: true,
        data: {
          ...response.data,
          file: {
            ...fileData,
            url: s3Url,
            s3Url: s3Url,
            s3Key: fileKey 
          },
        },
      };

    } catch (error) {
      this.activeUploads.delete(file.name);

      // 에러 상세 정보 로깅
      console.error("[Upload] 예외 발생:", {
        message: error.message,
        name: error.name,
        code: error.code,
        stack: error.stack
      });

      // Axios 에러인 경우 더 상세한 정보
      if (error.response) {
        console.error("[Upload] 서버 응답 에러:", {
          status: error.response.status,
          statusText: error.response.statusText,
          headers: error.response.headers,
          data: error.response.data
        });
      } else if (error.request) {
        console.error("[Upload] 요청 에러 (응답 없음):", {
          request: error.request,
          readyState: error.request.readyState,
          status: error.request.status,
          responseText: error.request.responseText
        });
      }

      // 네트워크 에러 상세 분석
      if (error.code === 'ERR_NETWORK') {
        console.error("[Upload] 네트워크 에러 상세:");
        console.error("- CORS 문제일 가능성이 높습니다");
        console.error("- S3 버킷의 CORS 설정을 확인하세요");
        console.error("- 브라우저 개발자 도구의 Network 탭을 확인하세요");
      }

      if (isCancel(error)) {
        console.warn("[Upload] ⏹업로드 취소됨");
        return {
          success: false,
          message: "업로드가 취소되었습니다.",
        };
      }

      if (error.response?.status === 401) {
        console.warn("[Upload] 인증 만료됨, 토큰 재발급 시도");
        try {
          const refreshed = await authService.refreshToken();
          if (refreshed) {
            console.log("[Upload] 토큰 재발급 성공, 업로드 재시도");
            return this.uploadFile(file, onProgress);
          }
          console.error("[Upload] 토큰 재발급 실패");
          return {
            success: false,
            message: "인증이 만료되었습니다. 다시 로그인해주세요.",
          };
        } catch (refreshError) {
          console.error("[Upload] 토큰 재발급 중 예외:", refreshError);
          return {
            success: false,
            message: "인증이 만료되었습니다. 다시 로그인해주세요.",
          };
        }
      }

      return this.handleUploadError(error);
    }
  }

  async downloadFile(filename, originalname) {
    try {
      const user = authService.getCurrentUser();
      if (!user?.token || !user?.sessionId) {
        return {
          success: false,
          message: "인증 정보가 없습니다.",
        };
      }

      // 파일 존재 여부 먼저 확인
      const downloadUrl = this.getFileUrl(filename, false);
      const checkResponse = await axios.head(downloadUrl, {
        headers: {
          "x-auth-token": user.token,
          "x-session-id": user.sessionId,
        },
        validateStatus: (status) => status < 500,
        withCredentials: true,
      });

      if (checkResponse.status === 404) {
        return {
          success: false,
          message: "파일을 찾을 수 없습니다.",
        };
      }

      if (checkResponse.status === 403) {
        return {
          success: false,
          message: "파일에 접근할 권한이 없습니다.",
        };
      }

      if (checkResponse.status !== 200) {
        return {
          success: false,
          message: "파일 다운로드 준비 중 오류가 발생했습니다.",
        };
      }

      const response = await axios({
        method: "GET",
        url: downloadUrl,
        headers: {
          "x-auth-token": user.token,
          "x-session-id": user.sessionId,
        },
        responseType: "blob",
        timeout: 30000,
        withCredentials: true,
      });

      const contentType = response.headers["content-type"];
      const contentDisposition = response.headers["content-disposition"];
      let finalFilename = originalname;

      if (contentDisposition) {
        const filenameMatch = contentDisposition.match(
          /filename\*=UTF-8''([^;]+)|filename="([^"]+)"|filename=([^;]+)/
        );
        if (filenameMatch) {
          finalFilename = decodeURIComponent(
            filenameMatch[1] || filenameMatch[2] || filenameMatch[3]
          );
        }
      }

      const blob = new Blob([response.data], {
        type: contentType || "application/octet-stream",
      });

      const blobUrl = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = finalFilename;
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      setTimeout(() => {
        window.URL.revokeObjectURL(blobUrl);
      }, 100);

      return { success: true };
    } catch (error) {
      if (error.response?.status === 401) {
        try {
          const refreshed = await authService.refreshToken();
          if (refreshed) {
            return this.downloadFile(filename, originalname);
          }
        } catch (refreshError) {
          return {
            success: false,
            message: "인증이 만료되었습니다. 다시 로그인해주세요.",
          };
        }
      }

      return this.handleDownloadError(error);
    }
  }

  getFileUrl(filename, forPreview = false) {
    if (!filename) return "";

    const baseUrl = process.env.NEXT_PUBLIC_API_URL || "";
    const endpoint = forPreview ? "view" : "download";
    return `${baseUrl}/api/files/${endpoint}/${filename}`;
  }

  getPreviewUrl(file, withAuth = true) {
    if (!file?.filename) return "";

    const baseUrl = `${process.env.NEXT_PUBLIC_API_URL}/api/files/view/${file.filename}`;

    if (!withAuth) return baseUrl;

    const user = authService.getCurrentUser();
    if (!user?.token || !user?.sessionId) return baseUrl;

    // URL 객체 생성 전 프로토콜 확인
    const url = new URL(baseUrl);
    url.searchParams.append("token", encodeURIComponent(user.token));
    url.searchParams.append("sessionId", encodeURIComponent(user.sessionId));

    return url.toString();
  }

  getFileType(filename) {
    if (!filename) return "unknown";
    const ext = this.getFileExtension(filename).toLowerCase();
    for (const [type, config] of Object.entries(this.allowedTypes)) {
      if (config.extensions.includes(ext)) {
        return type;
      }
    }
    return "unknown";
  }

  getFileExtension(filename) {
    if (!filename) return "";
    const parts = filename.split(".");
    return parts.length > 1 ? `.${parts.pop().toLowerCase()}` : "";
  }

  formatFileSize(bytes) {
    if (!bytes || bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(2))} ${units[i]}`;
  }

  getHeaders() {
    const user = authService.getCurrentUser();
    if (!user?.token || !user?.sessionId) {
      return {};
    }
    return {
      "x-auth-token": user.token,
      "x-session-id": user.sessionId,
      Accept: "application/json, */*",
    };
  }

  handleUploadError(error) {
    console.error("Upload error:", error);

    if (error.code === "ECONNABORTED") {
      return {
        success: false,
        message: "파일 업로드 시간이 초과되었습니다.",
      };
    }

    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const message = error.response?.data?.message;

      switch (status) {
        case 400:
          return {
            success: false,
            message: message || "잘못된 요청입니다.",
          };
        case 401:
          return {
            success: false,
            message: "인증이 필요합니다.",
          };
        case 413:
          return {
            success: false,
            message: "파일이 너무 큽니다.",
          };
        case 415:
          return {
            success: false,
            message: "지원하지 않는 파일 형식입니다.",
          };
        case 500:
          return {
            success: false,
            message: "서버 오류가 발생했습니다.",
          };
        default:
          return {
            success: false,
            message: message || "파일 업로드에 실패했습니다.",
          };
      }
    }

    return {
      success: false,
      message: error.message || "알 수 없는 오류가 발생했습니다.",
      error,
    };
  }

  handleDownloadError(error) {
    console.error("Download error:", error);

    if (error.code === "ECONNABORTED") {
      return {
        success: false,
        message: "파일 다운로드 시간이 초과되었습니다.",
      };
    }

    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const message = error.response?.data?.message;

      switch (status) {
        case 404:
          return {
            success: false,
            message: "파일을 찾을 수 없습니다.",
          };
        case 403:
          return {
            success: false,
            message: "파일에 접근할 권한이 없습니다.",
          };
        case 400:
          return {
            success: false,
            message: message || "잘못된 요청입니다.",
          };
        case 500:
          return {
            success: false,
            message: "서버 오류가 발생했습니다.",
          };
        default:
          return {
            success: false,
            message: message || "파일 다운로드에 실패했습니다.",
          };
      }
    }

    return {
      success: false,
      message: error.message || "알 수 없는 오류가 발생했습니다.",
      error,
    };
  }

  cancelUpload(filename) {
    const source = this.activeUploads.get(filename);
    if (source) {
      source.cancel("Upload canceled by user");
      this.activeUploads.delete(filename);
      return {
        success: true,
        message: "업로드가 취소되었습니다.",
      };
    }
    return {
      success: false,
      message: "취소할 업로드를 찾을 수 없습니다.",
    };
  }

  cancelAllUploads() {
    let canceledCount = 0;
    for (const [filename, source] of this.activeUploads) {
      source.cancel("All uploads canceled");
      this.activeUploads.delete(filename);
      canceledCount++;
    }

    return {
      success: true,
      message: `${canceledCount}개의 업로드가 취소되었습니다.`,
      canceledCount,
    };
  }

  getErrorMessage(status) {
    switch (status) {
      case 400:
        return "잘못된 요청입니다.";
      case 401:
        return "인증이 필요합니다.";
      case 403:
        return "파일에 접근할 권한이 없습니다.";
      case 404:
        return "파일을 찾을 수 없습니다.";
      case 413:
        return "파일이 너무 큽니다.";
      case 415:
        return "지원하지 않는 파일 형식입니다.";
      case 500:
        return "서버 오류가 발생했습니다.";
      case 503:
        return "서비스를 일시적으로 사용할 수 없습니다.";
      default:
        return "알 수 없는 오류가 발생했습니다.";
    }
  }

  isRetryableError(error) {
    if (!error.response) {
      return true; // 네트워크 오류는 재시도 가능
    }

    const status = error.response.status;
    return [408, 429, 500, 502, 503, 504].includes(status);
  }
}

export default new FileService();

// S3 이미지 조회용 presigned URL 생성
export async function getImageReadUrl(imageKey, token, sessionId) {
  const encodedKey = encodeURIComponent(imageKey);
  const res = await fetch(
    `${process.env.NEXT_PUBLIC_API_URL}/api/users/profile-image/read/${encodedKey}`,
    {
      headers: {
        "x-auth-token": token,
        "x-session-id": sessionId,
      },
    }
  );
  const { imageUrl } = await res.json();
  return imageUrl;
}

// S3 URL에서 이미지 키 추출
export const extractImageKeyFromS3Url = (s3Url) => {
  if (!s3Url || !s3Url.includes("s3.amazonaws.com")) {
    return null;
  }

  // URL에서 버킷명 이후 부분 추출
  const urlParts = s3Url.split("/");
  const bucketIndex = urlParts.findIndex((part) =>
    part.includes("s3.amazonaws.com")
  );

  if (bucketIndex === -1) {
    return null;
  }

  // profile-images/userId/filename 형태로 반환
  return urlParts.slice(bucketIndex + 1).join("/");
};
