// backend/services/gridfsService.js
const mongoose = require('mongoose');
const Grid = require('gridfs-stream');

let gfs;

// GridFS 초기화
const initGridFS = () => {
  const conn = mongoose.connection;
  
  if (conn.readyState === 1) {
    // 이미 연결된 경우
    gfs = Grid(conn.db, mongoose.mongo);
    gfs.collection('uploads');
    console.log('✅ GridFS initialized successfully');
  } else {
    // 연결 대기
    conn.once('open', () => {
      gfs = Grid(conn.db, mongoose.mongo);
      gfs.collection('uploads');
      console.log('✅ GridFS initialized successfully');
    });
  }
};

/**
 * 파일을 GridFS에 저장
 * @param {Object} fileData - 파일 정보
 * @param {string} fileData.filename - 파일명
 * @param {string} fileData.originalname - 원본 파일명
 * @param {string} fileData.mimetype - MIME 타입
 * @param {Buffer} fileData.buffer - 파일 버퍼
 * @returns {Promise<Object>} GridFS 파일 정보
 */
const saveFileToGridFS = async (fileData) => {
  return new Promise((resolve, reject) => {
    if (!gfs) {
      return reject(new Error('GridFS가 초기화되지 않았습니다.'));
    }

    console.log('📁 GridFS 업로드 시작:', {
      filename: fileData.filename,
      originalname: fileData.originalname,
      mimetype: fileData.mimetype,
      size: fileData.buffer.length
    });

    const writestream = gfs.createWriteStream({
      filename: fileData.filename,
      mode: 'w',
      content_type: fileData.mimetype,
      metadata: {
        originalname: fileData.originalname,
        uploadDate: new Date()
      }
    });

    writestream.on('close', (file) => {
      console.log('✅ GridFS 업로드 완료:', {
        fileId: file._id,
        filename: file.filename,
        length: file.length
      });
      resolve(file);
    });

    writestream.on('error', (error) => {
      console.error('❌ GridFS 업로드 실패:', error);
      reject(error);
    });

    writestream.write(fileData.buffer);
    writestream.end();
  });
};

/**
 * GridFS에서 파일 읽기 스트림 가져오기
 * @param {string} filename - 파일명
 * @returns {ReadStream} GridFS 읽기 스트림
 */
const getFileStreamFromGridFS = (filename) => {
  if (!gfs) {
    throw new Error('GridFS가 초기화되지 않았습니다.');
  }

  console.log('📖 GridFS에서 파일 스트림 생성:', filename);
  return gfs.createReadStream({
    filename: filename
  });
};

/**
 * GridFS에서 파일 정보 조회
 * @param {string} filename - 파일명
 * @returns {Promise<Object>} 파일 정보
 */
const getFileInfoFromGridFS = async (filename) => {
  return new Promise((resolve, reject) => {
    if (!gfs) {
      return reject(new Error('GridFS가 초기화되지 않았습니다.'));
    }

    gfs.files.findOne({ filename: filename }, (err, file) => {
      if (err) {
        console.error('❌ GridFS 파일 조회 실패:', err);
        return reject(err);
      }
      
      if (!file) {
        console.error('❌ GridFS에서 파일을 찾을 수 없음:', filename);
        return reject(new Error('파일을 찾을 수 없습니다.'));
      }

      console.log('✅ GridFS 파일 정보 조회 성공:', {
        filename: file.filename,
        contentType: file.contentType,
        length: file.length
      });
      
      resolve(file);
    });
  });
};

/**
 * GridFS에서 파일 삭제
 * @param {string} filename - 파일명
 * @returns {Promise<void>}
 */
const deleteFileFromGridFS = async (filename) => {
  return new Promise((resolve, reject) => {
    if (!gfs) {
      return reject(new Error('GridFS가 초기화되지 않았습니다.'));
    }

    console.log('🗑️ GridFS에서 파일 삭제 시도:', filename);
    
    gfs.remove({ filename: filename }, (err) => {
      if (err) {
        console.error('❌ GridFS 파일 삭제 실패:', err);
        return reject(err);
      }
      
      console.log('✅ GridFS에서 파일 삭제 성공:', filename);
      resolve();
    });
  });
};

module.exports = {
  initGridFS,
  saveFileToGridFS,
  getFileStreamFromGridFS,
  getFileInfoFromGridFS,
  deleteFileFromGridFS
}; 