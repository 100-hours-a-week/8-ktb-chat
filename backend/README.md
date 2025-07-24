# Backend API

## 환경 변수 설정

### S3 Presigned URL 기능을 위한 환경 변수

프로필 이미지 업로드 시 S3 presigned URL을 사용하려면 다음 환경 변수를 설정하세요:

```env
# AWS S3 설정 (필수)
AWS_REGION=ap-northeast-2
AWS_ACCESS_KEY_ID=your-access-key-id
AWS_SECRET_ACCESS_KEY=your-secret-access-key
S3_BUCKET_NAME=your-bucket-name

# API URL (선택사항, 기본값: http://localhost:5000)
API_URL=https://your-api-domain.com
```

### 프론트엔드 환경 변수 설정

프론트엔드에서 S3 URL을 생성하기 위해 다음 환경 변수를 설정하세요:

```env
# .env.local 또는 .env.production
NEXT_PUBLIC_S3_BUCKET_NAME=your-bucket-name
NEXT_PUBLIC_AWS_REGION=ap-northeast-2
NEXT_PUBLIC_API_URL=https://your-api-domain.com
```

### 보안 고려사항

1. **AWS 자격 증명**: IAM 사용자를 생성하고 S3 버킷에 대한 최소 권한만 부여
2. **버킷 정책**: 공개 읽기 권한만 허용하고 쓰기는 presigned URL로만 가능하도록 설정
3. **환경별 관리**: 개발/스테이징/프로덕션 환경별로 다른 버킷 사용
4. **버전 관리 제외**: AWS 자격 증명은 절대 Git에 포함하지 마세요

## API 엔드포인트

### 프로필 이미지 업로드 (S3 Presigned URL)

#### 1. S3 Presigned URL 생성

```
POST /api/users/profile-image/presigned
```

**요청 본문:**

```json
{
  "filename": "profile.jpg",
  "contentType": "image/jpeg"
}
```

**응답:**

```json
{
  "success": true,
  "presignedUrl": "https://your-bucket.s3.ap-northeast-2.amazonaws.com/...",
  "s3Key": "profile-images/user123/1703123456789_abc123def.jpg",
  "filename": "1703123456789_abc123def.jpg",
  "contentType": "image/jpeg",
  "expiresIn": 3600
}
```

#### 2. S3 URL을 통한 프로필 업데이트

```
POST /api/users/profile-image/update
```

**요청 본문:**

```json
{
  "s3Url": "https://your-bucket.s3.ap-northeast-2.amazonaws.com/profile-images/user123/filename.jpg",
  "s3Key": "profile-images/user123/filename.jpg"
}
```

**응답:**

```json
{
  "success": true,
  "message": "프로필 이미지가 업데이트되었습니다.",
  "imageUrl": "https://your-bucket.s3.ap-northeast-2.amazonaws.com/profile-images/user123/filename.jpg"
}
```

### 기존 업로드 방식 (하위 호환성)

```
POST /api/users/profile-image
```

기존 방식도 계속 지원됩니다.

## S3 버킷 설정

### 1. 버킷 생성

- 리전: `ap-northeast-2` (서울)
- 버킷 이름: 고유한 이름 사용
- 퍼블릭 액세스: 필요에 따라 설정

### 2. CORS 설정

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "PUT", "POST"],
    "AllowedOrigins": ["https://your-frontend-domain.com"],
    "ExposeHeaders": []
  }
]
```

### 3. 버킷 정책 (선택사항)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadGetObject",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::your-bucket-name/*"
    }
  ]
}
```

## 보안 기능

1. **Presigned URL**: 1시간 후 자동 만료
2. **파일 타입 검증**: 이미지 파일만 허용
3. **파일 크기 제한**: 5MB 제한
4. **사용자별 폴더**: `profile-images/{userId}/` 구조로 분리
5. **경로 순회 공격 방지**: 파일명에 경로 구분자 포함 시 차단
