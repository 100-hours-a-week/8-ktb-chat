// backend/services/gridfsService.js
const mongoose = require('mongoose');
const { GridFSBucket } = require('mongodb');

let bucket;

// GridFS 초기화 - 더 안정적인 방식
const initGridFS = () => {
  const conn = mongoose.connection;
  
  const createBucket = () => {
    try {
      bucket = new GridFSBucket(conn.db, { bucketName: 'uploads' });
      console.log('✅ GridFS Bucket initialized successfully');
      return true;
    } catch (error) {
      console.error('❌ GridFS Bucket initialization failed:', error);
      return false;
    }
  };

  if (conn.readyState === 1) {
    // 이미 연결된 경우
    createBucket();
  } else {
    // 연결 대기
    conn.once('open', () => {
      setTimeout(createBucket, 1000); // 1초 대기 후 초기화
    });
  }
};

// GridFS 준비 상태 확인
const ensureGridFSReady = async () => {
  let attempts = 0;
  const maxAttempts = 10;
  
  while (!bucket && attempts < maxAttempts) {
    console.log(`GridFS 준비 대기 중... (${attempts + 1}/${maxAttempts})`);
    await new Promise(resolve => setTimeout(resolve, 500));
    
    if (mongoose.connection.readyState === 1 && !bucket) {
      const conn = mongoose.connection;
      try {
        bucket = new GridFSBucket(conn.db, { bucketName: 'uploads' });
        console.log('✅ GridFS Bucket 지연 초기화 완료');
        break;
      } catch (error) {
        console.warn('GridFS 초기화 재시도 중...', error.message);
      }
    }
    attempts++;
  }
  
  if (!bucket) {
    throw new Error('GridFS Bucket 초기화 실패 - MongoDB 연결을 확인하세요');
  }
  
  return bucket;
};

/**
 * 파일을 GridFS에 저장
 */
const saveFileToGridFS = async (fileData) => {
  await ensureGridFSReady();
  
  return new Promise((resolve, reject) => {
    console.log('📁 GridFS 업로드 시작:', {
      filename: fileData.filename,
      originalname: fileData.originalname,
      mimetype: fileData.mimetype,
      size: fileData.buffer.length
    });

    const uploadStream = bucket.openUploadStream(fileData.filename, {
      contentType: fileData.mimetype,
      metadata: {
        originalname: fileData.originalname,
        uploadDate: new Date()
      }
    });

    uploadStream.on('finish', (file) => {
      console.log('✅ GridFS 업로드 완료:', {
        fileId: file._id,
        filename: file.filename,
        length: file.length
      });
      resolve(file);
    });

    uploadStream.on('error', (error) => {
      console.error('❌ GridFS 업로드 실패:', error);
      reject(error);
    });

    uploadStream.end(fileData.buffer);
  });
};

/**
 * GridFS에서 파일 읽기 스트림 가져오기
 */
const getFileStreamFromGridFS = async (filename) => {
  await ensureGridFSReady();
  
  console.log('📖 GridFS에서 파일 스트림 생성:', filename);
  return bucket.openDownloadStreamByName(filename);
};

/**
 * GridFS에서 파일 정보 조회
 */
const getFileInfoFromGridFS = async (filename) => {
  await ensureGridFSReady();

  try {
    const files = await bucket.find({ filename: filename }).toArray();
    
    if (!files || files.length === 0) {
      console.error('❌ GridFS에서 파일을 찾을 수 없음:', filename);
      throw new Error('파일을 찾을 수 없습니다.');
    }

    const file = files[0];
    console.log('✅ GridFS 파일 정보 조회 성공:', {
      filename: file.filename,
      contentType: file.contentType,
      length: file.length
    });
    
    return file;
  } catch (error) {
    console.error('❌ GridFS 파일 조회 실패:', error);
    throw error;
  }
};

/**
 * GridFS에서 파일 삭제
 */
const deleteFileFromGridFS = async (filename) => {
  await ensureGridFSReady();

  try {
    console.log('🗑️ GridFS에서 파일 삭제 시도:', filename);
    
    // 파일 찾기
    const files = await bucket.find({ filename: filename }).toArray();
    
    if (!files || files.length === 0) {
      console.warn('⚠️ 삭제할 파일을 찾을 수 없음:', filename);
      return;
    }

    // 파일 삭제
    await bucket.delete(files[0]._id);
    console.log('✅ GridFS에서 파일 삭제 성공:', filename);
  } catch (error) {
    console.error('❌ GridFS 파일 삭제 실패:', error);
    throw error;
  }
};

module.exports = {
  initGridFS,
  saveFileToGridFS,
  getFileStreamFromGridFS,
  getFileInfoFromGridFS,
  deleteFileFromGridFS
}; 