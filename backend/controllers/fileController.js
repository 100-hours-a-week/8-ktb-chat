const File = require('../models/File');
const Message = require('../models/Message');
const Room = require('../models/Room');
const { processFileForRAG } = require('../services/fileService');
const path = require('path');
const fs = require('fs');
const { promisify } = require('util');
const crypto = require('crypto');
const { uploadDir } = require('../middleware/upload');
const CacheService = require('../services/cacheService');

const fsPromises = {
  writeFile: promisify(fs.writeFile),
  unlink: promisify(fs.unlink),
  access: promisify(fs.access),
  mkdir: promisify(fs.mkdir),
  rename: promisify(fs.rename)
};

const isPathSafe = (filepath, directory) => {
  const resolvedPath = path.resolve(filepath);
  const resolvedDirectory = path.resolve(directory);
  return resolvedPath.startsWith(resolvedDirectory);
};

const generateSafeFilename = (originalFilename) => {
  const ext = path.extname(originalFilename || '').toLowerCase();
  const timestamp = Date.now();
  const randomBytes = crypto.randomBytes(8).toString('hex');
  return `${timestamp}_${randomBytes}${ext}`;
};

// 캐시된 파일 권한 및 정보 조회 함수 (대폭 개선)
const getFileFromRequest = async (req) => {
  try {
    const filename = req.params.filename;
    const token = req.headers['x-auth-token'] || req.query.token;
    const sessionId = req.headers['x-session-id'] || req.query.sessionId;
    
    if (!filename) {
      throw new Error('Invalid filename');
    }

    if (!token || !sessionId) {
      throw new Error('Authentication required');
    }

    const filePath = path.join(uploadDir, filename);
    if (!isPathSafe(filePath, uploadDir)) {
      throw new Error('Invalid file path');
    }

    // 캐시된 파일 권한 확인 (DB 쿼리만 캐싱, 파일 시스템은 직접 접근)
    const fileAccess = await CacheService.getFileAccess(filename, req.user.id, async () => {
      // 파일 메타데이터 조회
      const fileDoc = await File.findOne({ filename: filename });
      if (!fileDoc) {
        throw new Error('File not found in database');
      }

      // 채팅방 권한 검증을 위한 메시지 조회
      const message = await Message.findOne({ file: fileDoc._id });
      if (!message) {
        throw new Error('File message not found');
      }

      // 사용자가 해당 채팅방의 참가자인지 확인
      const room = await Room.findOne({
        _id: message.room,
        participants: req.user.id
      });

      if (!room) {
        throw new Error('Unauthorized access');
      }

      return {
        file: fileDoc.toObject(),
        hasAccess: true,
        roomId: room._id,
        messageId: message._id
      };
    });

    // 파일 존재 여부 확인 (직접 - 더 빠름)
    await fsPromises.access(filePath, fs.constants.R_OK);

    if (!fileAccess || !fileAccess.hasAccess) {
      throw new Error('Unauthorized access');
    }

    return { 
      file: fileAccess.file, 
      filePath,
      roomId: fileAccess.roomId,
      messageId: fileAccess.messageId
    };
  } catch (error) {
    console.error('getFileFromRequest error:', {
      filename: req.params.filename,
      error: error.message
    });
    throw error;
  }
};

exports.uploadFile = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: '파일이 선택되지 않았습니다.'
      });
    }

    // 파일 해시 생성 (중복 체크용)
    const fileBuffer = await fsPromises.readFile(req.file.path);
    const fileHash = crypto.createHash('md5').update(fileBuffer).digest('hex');

    // 캐시된 중복 파일 체크
    const duplicateCheck = await CacheService.getFileDuplicate(fileHash, req.user.id, async () => {
      // 동일한 해시와 크기를 가진 파일이 이미 존재하는지 확인
      const existingFile = await File.findOne({
        user: req.user.id,
        size: req.file.size,
        mimetype: req.file.mimetype
      });

      if (existingFile) {
        // 실제 파일 내용이 같은지 검증
        try {
          const existingPath = path.join(uploadDir, existingFile.filename);
          const existingBuffer = await fsPromises.readFile(existingPath);
          const existingHash = crypto.createHash('md5').update(existingBuffer).digest('hex');
          
          if (existingHash === fileHash) {
            return {
              isDuplicate: true,
              file: existingFile.toObject()
            };
          }
        } catch (error) {
          console.warn('Duplicate check read error:', error);
        }
      }

      return { isDuplicate: false };
    });

    // 중복 파일인 경우 기존 파일 정보 반환
    if (duplicateCheck.isDuplicate) {
      // 업로드된 임시 파일 삭제
      await fsPromises.unlink(req.file.path);
      
      return res.status(200).json({
        success: true,
        message: '동일한 파일이 이미 존재합니다.',
        duplicate: true,
        file: {
          _id: duplicateCheck.file._id,
          filename: duplicateCheck.file.filename,
          originalname: duplicateCheck.file.originalname,
          mimetype: duplicateCheck.file.mimetype,
          size: duplicateCheck.file.size,
          uploadDate: duplicateCheck.file.uploadDate
        }
      });
    }

    // 새 파일 저장
    const safeFilename = generateSafeFilename(req.file.originalname);
    const currentPath = req.file.path;
    const newPath = path.join(uploadDir, safeFilename);

    const file = new File({
      filename: safeFilename,
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      user: req.user.id,
      path: newPath
    });

    await file.save();
    await fsPromises.rename(currentPath, newPath);

    // 파일 업로드 완료 시 관련 캐시 무효화
    await CacheService.invalidateMultiple([
      `user:${req.user.id}`,
      'file_duplicate'
    ]);

    res.status(200).json({
      success: true,
      message: '파일 업로드 성공',
      duplicate: false,
      file: {
        _id: file._id,
        filename: file.filename,
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
        uploadDate: file.uploadDate
      }
    });

  } catch (error) {
    console.error('File upload error:', error);
    if (req.file?.path) {
      try {
        await fsPromises.unlink(req.file.path);
      } catch (unlinkError) {
        console.error('Failed to delete uploaded file:', unlinkError);
      }
    }
    res.status(500).json({
      success: false,
      message: '파일 업로드 중 오류가 발생했습니다.',
      error: error.message
    });
  }
};

exports.downloadFile = async (req, res) => {
  try {
    const { file, filePath } = await getFileFromRequest(req);
    
    // 헤더 직접 생성 (캐싱 제거 - 메모리에서 더 빠름)
    const fileInstance = new File(file);
    const contentDisposition = fileInstance.getContentDisposition('attachment');
    
    // 헤더 설정 (직접)
    res.set({
      'Content-Type': file.mimetype,
      'Content-Length': file.size,
      'Content-Disposition': contentDisposition,
      'Cache-Control': 'private, no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });

    // 최적화된 파일 스트림 생성 및 전송
    const fileStream = fs.createReadStream(filePath, {
      highWaterMark: 64 * 1024 // 64KB 청크로 최적화
    });
    
    fileStream.on('error', (error) => {
      console.error('File streaming error:', error);
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          message: '파일 스트리밍 중 오류가 발생했습니다.'
        });
      }
    });

    fileStream.pipe(res);

  } catch (error) {
    handleFileError(error, res);
  }
};

exports.viewFile = async (req, res) => {
  try {
    const { file, filePath } = await getFileFromRequest(req);

    // File 모델 인스턴스로 변환하여 메서드 사용
    const fileInstance = new File(file);
    if (!fileInstance.isPreviewable()) {
      return res.status(415).json({
        success: false,
        message: '미리보기를 지원하지 않는 파일 형식입니다.'
      });
    }

    // 헤더 직접 생성 (더 빠름)
    const contentDisposition = fileInstance.getContentDisposition('inline');
    const etag = `"${file.filename}-${file.size}"`;
    
    // 브라우저 캐시 확인 (If-None-Match)
    const clientEtag = req.headers['if-none-match'];
    if (clientEtag && clientEtag === etag) {
      return res.status(304).end(); // Not Modified
    }

    // 헤더 설정 (직접)
    res.set({
      'Content-Type': file.mimetype,
      'Content-Disposition': contentDisposition,
      'Content-Length': file.size,
      'Cache-Control': 'public, max-age=31536000, immutable', // 1년 캐시
      'ETag': etag,
      'Last-Modified': new Date(file.uploadDate).toUTCString()
    });

    // 최적화된 파일 스트림 생성 및 전송
    const fileStream = fs.createReadStream(filePath, {
      highWaterMark: 64 * 1024 // 64KB 청크로 최적화
    });
    
    fileStream.on('error', (error) => {
      console.error('File streaming error:', error);
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          message: '파일 스트리밍 중 오류가 발생했습니다.'
        });
      }
    });

    fileStream.pipe(res);

  } catch (error) {
    handleFileError(error, res);
  }
};

const handleFileStream = (fileStream, res) => {
  fileStream.on('error', (error) => {
    console.error('File streaming error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: '파일 스트리밍 중 오류가 발생했습니다.'
      });
    }
  });

  fileStream.pipe(res);
};

const handleFileError = (error, res) => {
  console.error('File operation error:', {
    message: error.message,
    stack: error.stack
  });

  // 에러 상태 코드 및 메시지 매핑
  const errorResponses = {
    'Invalid filename': { status: 400, message: '잘못된 파일명입니다.' },
    'Authentication required': { status: 401, message: '인증이 필요합니다.' },
    'Invalid file path': { status: 400, message: '잘못된 파일 경로입니다.' },
    'File not found in database': { status: 404, message: '파일을 찾을 수 없습니다.' },
    'File message not found': { status: 404, message: '파일 메시지를 찾을 수 없습니다.' },
    'Unauthorized access': { status: 403, message: '파일에 접근할 권한이 없습니다.' },
    'ENOENT': { status: 404, message: '파일을 찾을 수 없습니다.' }
  };

  const errorResponse = errorResponses[error.message] || {
    status: 500,
    message: '파일 처리 중 오류가 발생했습니다.'
  };

  res.status(errorResponse.status).json({
    success: false,
    message: errorResponse.message
  });
};

exports.deleteFile = async (req, res) => {
  try {
    const file = await File.findById(req.params.id);
    
    if (!file) {
      return res.status(404).json({
        success: false,
        message: '파일을 찾을 수 없습니다.'
      });
    }

    if (file.user.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: '파일을 삭제할 권한이 없습니다.'
      });
    }

    const filePath = path.join(uploadDir, file.filename);

    if (!isPathSafe(filePath, uploadDir)) {
      return res.status(403).json({
        success: false,
        message: '잘못된 파일 경로입니다.'
      });
    }
    
    try {
      await fsPromises.access(filePath, fs.constants.W_OK);
      await fsPromises.unlink(filePath);
    } catch (unlinkError) {
      console.error('File deletion error:', unlinkError);
    }

    await file.deleteOne();

    // 파일 삭제 시 관련 캐시 무효화 (DB 쿼리 캐시만)
    await CacheService.invalidateMultiple([
      `file:${file.filename}`,
      `user:${req.user.id}`,
      'file_duplicate',
      'file_access'
    ]);

    res.json({
      success: true,
      message: '파일이 삭제되었습니다.'
    });
  } catch (error) {
    console.error('File deletion error:', error);
    res.status(500).json({
      success: false,
      message: '파일 삭제 중 오류가 발생했습니다.',
      error: error.message
    });
  }
};