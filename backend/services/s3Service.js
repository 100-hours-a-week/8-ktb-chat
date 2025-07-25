// backend/services/s3Service.js
const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const fs = require('fs');

// S3 클라이언트 설정
const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'ap-northeast-2',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  }
});

const BUCKET_NAME = process.env.S3_BUCKET_NAME || 'pumati-loadtest';

console.log('S3 Configuration:', {
  region: process.env.AWS_REGION || 'ap-northeast-2',
  bucketName: BUCKET_NAME,
  hasAccessKey: !!process.env.AWS_ACCESS_KEY_ID,
  hasSecretKey: !!process.env.AWS_SECRET_ACCESS_KEY
});

/**
 * 파일을 S3에 업로드
 * @param {Object} file - 업로드할 파일 정보
 * @param {string} file.path - 로컬 파일 경로
 * @param {string} file.filename - S3에 저장될 파일명
 * @param {string} file.mimetype - 파일 MIME 타입
 */
const uploadToS3 = async (file) => {
  try {
    console.log('S3 Upload Start:', {
      filename: file.filename,
      mimetype: file.mimetype,
      path: file.path,
      bucket: BUCKET_NAME
    });

    // 파일 존재 확인
    const fs = require('fs');
    if (!fs.existsSync(file.path)) {
      throw new Error(`로컬 파일이 존재하지 않습니다: ${file.path}`);
    }

    const fileStats = fs.statSync(file.path);
    console.log('Local file stats:', {
      size: fileStats.size,
      exists: true
    });

    const fileStream = fs.createReadStream(file.path);

    const uploadParams = {
      Bucket: BUCKET_NAME,
      Key: file.filename,
      Body: fileStream,
      ContentType: file.mimetype,
    };

    console.log('S3 Upload Params:', {
      Bucket: uploadParams.Bucket,
      Key: uploadParams.Key,
      ContentType: uploadParams.ContentType
    });

    const data = await s3Client.send(new PutObjectCommand(uploadParams));
    console.log("S3 Upload Success:", { key: file.filename, etag: data.ETag });
    return data;
  } catch (err) {
    console.error("S3 Upload Error Details:", {
      error: err.message,
      stack: err.stack,
      code: err.code,
      statusCode: err.$response?.statusCode,
      requestId: err.$response?.requestId
    });
    throw new Error(`S3 업로드 실패: ${err.message}`);
  }
};

/**
 * S3에서 파일 조회/다운로드용 사전 서명된 URL 생성
 * @param {string} filename - 파일명
 * @param {boolean} forDownload - 다운로드용인지 여부
 * @returns {string} 사전 서명된 URL
 */
const getSignedUrlForView = async (filename, forDownload = false) => {
  try {
    const commandInput = {
      Bucket: BUCKET_NAME,
      Key: filename,
    };

    if (forDownload) {
      // 다운로드를 위해 Content-Disposition 헤더 설정
      commandInput.ResponseContentDisposition = `attachment; filename="${encodeURIComponent(filename)}"`;
    }

    const command = new GetObjectCommand(commandInput);

    // 1시간 동안 유효한 URL 생성
    const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
    console.log("S3 Signed URL generated:", { filename, forDownload });
    return signedUrl;
  } catch (err) {
    console.error("S3 Signed URL Error:", err);
    throw new Error(`S3 URL 생성 실패: ${err.message}`);
  }
};

/**
 * S3에서 파일 삭제
 * @param {string} filename - 삭제할 파일명
 */
const deleteFromS3 = async (filename) => {
  try {
    const deleteParams = {
      Bucket: BUCKET_NAME,
      Key: filename,
    };

    const data = await s3Client.send(new DeleteObjectCommand(deleteParams));
    console.log("S3 Delete Success:", { filename });
    return data;
  } catch (err) {
    console.error("S3 Delete Error:", err);
    throw new Error(`S3 삭제 실패: ${err.message}`);
  }
};

module.exports = {
  uploadToS3,
  getSignedUrlForView,
  deleteFromS3
}; 