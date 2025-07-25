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
const { 
  saveFileToGridFS, 
  getFileStreamFromGridFS, 
  getFileInfoFromGridFS, 
  deleteFileFromGridFS 
} = require('../services/gridfsService');

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
  console.log('=== FILE UPLOAD REQUEST START ===');
  console.log('Request details:', {
    hasFile: !!req.file,
    userId: req.user?.id,
    userAgent: req.headers['user-agent'],
    contentType: req.headers['content-type'],
    timestamp: new Date().toISOString()
  });

  if (req.file) {
    console.log('File details:', {
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      path: req.file.path,
      fieldname: req.file.fieldname
    });
  }

  try {
    if (!req.file) {
      console.error('❌ FILE UPLOAD ERROR: No file provided');
      return res.status(400).json({
        success: false,
        message: '파일이 선택되지 않았습니다.'
      });
    }

    console.log('📁 Starting file hash generation...');
    // 파일 해시 생성 (중복 체크용)
    try {
      const fileBuffer = await fsPromises.readFile(req.file.path);
      const fileHash = crypto.createHash('md5').update(fileBuffer).digest('hex');
      console.log('✅ File hash generated:', fileHash);

      // 중복 파일 확인
      const duplicateFile = await File.findOne({ 
        user: req.user.id,
        size: req.file.size,
        mimetype: req.file.mimetype,
        originalname: req.file.originalname
      });

      if (duplicateFile) {
        console.log('⚠️ Duplicate file detected, cleaning up temp file...');
        await fsPromises.unlink(req.file.path);
        console.log('✅ Duplicate file handled, returning existing file');
        
        return res.json({
          success: true,
          message: '파일이 업로드되었습니다.',
          data: {
            file: {
              _id: duplicateFile._id,
              filename: duplicateFile.filename,
              originalname: duplicateFile.originalname,
              mimetype: duplicateFile.mimetype,
              size: duplicateFile.size,
              uploadDate: duplicateFile.uploadDate
            }
          }
        });
      }
    } catch (hashError) {
      console.error('❌ FILE HASH ERROR:', {
        error: hashError.message,
        stack: hashError.stack,
        filePath: req.file.path
      });
      // 해시 에러는 무시하고 계속 진행
    }

    // 새 파일 저장 (GridFS 사용)
    const safeFilename = generateSafeFilename(req.file.originalname);
    
    console.log('🚀 Starting GridFS upload:', {
      originalname: req.file.originalname,
      safeFilename,
      tempPath: req.file.path,
      mimetype: req.file.mimetype,
      size: req.file.size
    });

    // 파일 버퍼 읽기
    const fileBuffer = await fsPromises.readFile(req.file.path);

    // GridFS에 파일 업로드
    const gridfsFile = await saveFileToGridFS({
      filename: safeFilename,
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      buffer: fileBuffer
    });
    
    console.log('✅ GridFS upload completed, creating database record...');

    // 데이터베이스에 파일 정보 저장
    const file = new File({
      filename: safeFilename,
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      user: req.user.id,
      path: `gridfs://${safeFilename}`, // GridFS 경로 표시
      gridfsId: gridfsFile._id // GridFS 파일 ID 저장
    });

    await file.save();
    console.log('✅ Database record created successfully:', {
      fileId: file._id,
      filename: file.filename,
      gridfsId: gridfsFile._id
    });
    
    // 로컬 임시 파일 삭제
    try {
      await fsPromises.unlink(req.file.path);
      console.log('✅ Temporary file cleaned up');
    } catch (cleanupError) {
      console.warn('⚠️ Failed to cleanup temporary file:', cleanupError.message);
    }

    // 파일 업로드 완료 시 관련 캐시 무효화
    await CacheService.invalidateMultiple([
      `user:${req.user.id}`,
      'file_duplicate'
    ]);
    console.log('✅ Cache invalidated');

    console.log('=== FILE UPLOAD SUCCESS ===');
    res.json({
      success: true,
      message: '파일이 업로드되었습니다.',
      data: {
        file: {
          _id: file._id,
          filename: file.filename,
          originalname: file.originalname,
          mimetype: file.mimetype,
          size: file.size,
          uploadDate: file.uploadDate
        }
      }
    });

  } catch (error) {
    console.error('=== FILE UPLOAD CRITICAL ERROR ===');
    console.error('Error details:', {
      message: error.message,
      stack: error.stack,
      name: error.name,
      code: error.code,
      statusCode: error.statusCode,
      timestamp: new Date().toISOString(),
      userId: req.user?.id,
      fileName: req.file?.originalname,
      fileSize: req.file?.size
    });

    if (req.file?.path) {
      try {
        await fsPromises.unlink(req.file.path);
        console.log('✅ Cleanup: Temporary file deleted after error');
      } catch (unlinkError) {
        console.error('❌ Cleanup failed:', unlinkError.message);
      }
    }

    console.error('=== FILE UPLOAD ERROR END ===');
    res.status(500).json({
      success: false,
      message: '파일 업로드 중 오류가 발생했습니다.',
      error: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
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

    console.log('Getting file info from GridFS for download:', filename);

    // GridFS에서 파일 정보 조회
    const gridfsFile = await getFileInfoFromGridFS(filename);
    
    // GridFS에서 파일 스트림 생성
    const fileStream = await getFileStreamFromGridFS(filename);
    
    console.log('Streaming file download from GridFS:', { 
      filename, 
      contentType: gridfsFile.contentType,
      length: gridfsFile.length 
    });

    // 다운로드용 응답 헤더 설정
    res.set({
      'Content-Type': gridfsFile.contentType,
      'Content-Length': gridfsFile.length,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(file.originalname || filename)}"`,
      'Cache-Control': 'private, no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });

    // 파일 스트림을 응답으로 전송
    fileStream.on('error', (error) => {
      console.error('GridFS download streaming error:', error);
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          message: '파일 다운로드 중 오류가 발생했습니다.'
        });
      }
    });

    fileStream.pipe(res);

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

    console.log('Getting file info from GridFS:', filename);

    // GridFS에서 파일 정보 조회
    const gridfsFile = await getFileInfoFromGridFS(filename);
    
    // GridFS에서 파일 스트림 생성
    const fileStream = await getFileStreamFromGridFS(filename);
    
    console.log('Streaming file from GridFS:', { 
      filename, 
      contentType: gridfsFile.contentType,
      length: gridfsFile.length 
    });

    // 응답 헤더 설정
    res.set({
      'Content-Type': gridfsFile.contentType,
      'Content-Length': gridfsFile.length,
      'Content-Disposition': `inline; filename="${encodeURIComponent(file.originalname || filename)}"`,
      'Cache-Control': 'public, max-age=31536000, immutable', // 1년 캐시
      'Last-Modified': new Date(gridfsFile.uploadDate).toUTCString()
    });

    // 파일 스트림을 응답으로 전송
    fileStream.on('error', (error) => {
      console.error('GridFS streaming error:', error);
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          message: '파일 스트리밍 중 오류가 발생했습니다.'
        });
      }
    });

    fileStream.pipe(res);

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

    console.log('Deleting file from GridFS:', file.filename);

    // GridFS에서 파일 삭제
    try {
      await deleteFileFromGridFS(file.filename);
      console.log('File deleted from GridFS successfully:', file.filename);
    } catch (gridfsError) {
      console.warn('Failed to delete file from GridFS (continuing with DB cleanup):', gridfsError.message);
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