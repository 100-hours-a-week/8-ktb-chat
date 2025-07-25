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
const { uploadToS3, getSignedUrlForView, deleteFromS3 } = require('../services/s3Service');

const fsPromises = {
  readFile: promisify(fs.readFile),
  writeFile: promisify(fs.writeFile),
  unlink: promisify(fs.unlink),
  access: promisify(fs.access),
  mkdir: promisify(fs.mkdir),
  rename: promisify(fs.rename)
};

const generateSafeFilename = (originalFilename) => {
  const ext = path.extname(originalFilename);
  const timestamp = Date.now();
  const randomBytes = crypto.randomBytes(8).toString('hex');
  return `${timestamp}_${randomBytes}${ext}`;
};

const isPathSafe = (filepath, directory) => {
  try {
    const resolvedPath = path.resolve(filepath);
    const resolvedDirectory = path.resolve(directory);
    return resolvedPath.startsWith(resolvedDirectory);
  } catch (error) {
    console.error('Path validation error:', error);
    return false;
  }
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
      
      // 메시지가 없더라도 파일 소유자이면 접근 허용 (업로드 직후 등)
      if (!message) {
        if (fileDoc.user.toString() === req.user.id.toString()) {
          return {
            file: fileDoc.toObject(),
            hasAccess: true,
            roomId: null, // 메시지가 없으므로 room 정보는 null
            messageId: null
          };
        }
        throw new Error('File message not found and not an owner');
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
    try {
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
    } catch (hashError) {
      console.error('File hash calculation error:', hashError);
      return res.status(500).json({
        success: false,
        message: '파일 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.'
      });
    }

    // 새 파일 저장 (S3 사용)
    const safeFilename = generateSafeFilename(req.file.originalname);
    
    console.log('Starting S3 upload:', {
      originalname: req.file.originalname,
      safeFilename,
      tempPath: req.file.path,
      mimetype: req.file.mimetype,
      size: req.file.size
    });

    // S3에 파일 업로드
    await uploadToS3({
      path: req.file.path,
      filename: safeFilename,
      mimetype: req.file.mimetype,
    });
    
    console.log('S3 upload completed, creating database record...');

    // 데이터베이스에 파일 정보 저장
    const file = new File({
      filename: safeFilename,
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      user: req.user.id,
      path: `s3://${process.env.S3_BUCKET_NAME || 'pumati-loadtest'}/${safeFilename}`
    });

    await file.save();
    console.log('Database record created successfully');
    
    // 로컬 임시 파일 삭제
    try {
      await fsPromises.unlink(req.file.path);
      console.log('Temporary file cleaned up');
    } catch (cleanupError) {
      console.warn('Failed to cleanup temporary file:', cleanupError.message);
    }

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
    const { filename } = req.params;
    
    console.log('DownloadFile request:', { filename, user: req.user?.id });

    // 데이터베이스에서 파일 정보 조회
    const file = await File.findOne({ filename });
    if (!file) {
      console.log('File not found in database:', filename);
      return res.status(404).json({ 
        success: false, 
        message: '파일을 찾을 수 없습니다.' 
      });
    }

    // 기본적인 접근 권한 확인 (파일 소유자인지 확인)
    if (file.user.toString() !== req.user.id.toString()) {
      // 소유자가 아닌 경우, 메시지를 통한 권한 확인
      const message = await Message.findOne({ file: file._id });
      if (message) {
        const room = await Room.findOne({
          _id: message.room,
          participants: req.user.id
        });
        
        if (!room) {
          console.log('Access denied for file download:', { filename, userId: req.user.id });
          return res.status(403).json({ 
            success: false, 
            message: '파일 다운로드 권한이 없습니다.' 
          });
        }
      } else {
        // 메시지가 없고 소유자도 아닌 경우 접근 거부
        console.log('No message found and not owner for download:', { filename, userId: req.user.id });
        return res.status(403).json({ 
          success: false, 
          message: '파일 다운로드 권한이 없습니다.' 
        });
      }
    }

    console.log('Generating S3 signed URL for download:', filename);

    // S3에서 다운로드용 사전 서명된 URL 생성
    const signedUrl = await getSignedUrlForView(filename, true);
    
    console.log('Redirecting to S3 download URL:', { filename, hasUrl: !!signedUrl });
    
    // 클라이언트를 S3 다운로드 URL로 리다이렉트
    res.redirect(signedUrl);

  } catch (error) {
    console.error('DownloadFile error:', {
      filename: req.params.filename,
      error: error.message,
      stack: error.stack
    });
    res.status(500).json({ 
      success: false, 
      message: '파일 다운로드 중 오류가 발생했습니다.' 
    });
  }
};

exports.viewFile = async (req, res) => {
  try {
    const { filename } = req.params;
    
    console.log('ViewFile request:', { filename, user: req.user?.id });

    // 데이터베이스에서 파일 정보 조회
    const file = await File.findOne({ filename });
    if (!file) {
      console.log('File not found in database:', filename);
      return res.status(404).json({ 
        success: false, 
        message: '파일을 찾을 수 없습니다.' 
      });
    }

    // 기본적인 접근 권한 확인 (파일 소유자인지 확인)
    if (file.user.toString() !== req.user.id.toString()) {
      // 소유자가 아닌 경우, 메시지를 통한 권한 확인
      const message = await Message.findOne({ file: file._id });
      if (message) {
        const room = await Room.findOne({
          _id: message.room,
          participants: req.user.id
        });
        
        if (!room) {
          console.log('Access denied for file:', { filename, userId: req.user.id });
          return res.status(403).json({ 
            success: false, 
            message: '파일에 접근할 권한이 없습니다.' 
          });
        }
      } else {
        // 메시지가 없고 소유자도 아닌 경우 접근 거부
        console.log('No message found and not owner:', { filename, userId: req.user.id });
        return res.status(403).json({ 
          success: false, 
          message: '파일에 접근할 권한이 없습니다.' 
        });
      }
    }

    console.log('Generating S3 signed URL for view:', filename);

    // S3에서 미리보기용 사전 서명된 URL 생성
    const signedUrl = await getSignedUrlForView(filename, false);
    
    console.log('Redirecting to S3 URL:', { filename, hasUrl: !!signedUrl });
    
    // 클라이언트를 S3 URL로 리다이렉트
    res.redirect(signedUrl);

  } catch (error) {
    console.error('ViewFile error:', {
      filename: req.params.filename,
      error: error.message,
      stack: error.stack
    });
    res.status(500).json({ 
      success: false, 
      message: '파일 보기 중 오류가 발생했습니다.' 
    });
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

    console.log('Deleting file from S3:', file.filename);

    // S3에서 파일 삭제
    try {
      await deleteFromS3(file.filename);
      console.log('File deleted from S3 successfully:', file.filename);
    } catch (s3Error) {
      console.warn('Failed to delete file from S3 (continuing with DB cleanup):', s3Error.message);
    }

    // 데이터베이스에서 파일 정보 삭제
    await file.deleteOne();
    console.log('File record deleted from database:', file.filename);

    // 파일 삭제 시 관련 캐시 무효화
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