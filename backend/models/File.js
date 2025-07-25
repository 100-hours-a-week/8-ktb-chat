const mongoose = require('mongoose');

const FileSchema = new mongoose.Schema({
  filename: { 
    type: String, 
    required: true,
    index: true,
    validate: {
      validator: function(v) {
        return /^[0-9]+_[a-f0-9]+\.[a-z0-9]+$/.test(v);
      },
      message: '올바르지 않은 파일명 형식입니다.'
    }
  },
  originalname: { 
    type: String,
    required: true,
    set: function(name) {
      try {
        if (!name) return '';
        
        // 파일명에서 경로 구분자 제거
        const sanitizedName = name.replace(/[\/\\]/g, '');
        
        // 유니코드 정규화 (NFC)
        return sanitizedName.normalize('NFC');
      } catch (error) {
        console.error('Filename sanitization error:', error);
        return name;
      }
    },
    get: function(name) {
      try {
        if (!name) return '';
        
        // 유니코드 정규화된 형태로 반환
        return name.normalize('NFC');
      } catch (error) {
        console.error('Filename retrieval error:', error);
        return name;
      }
    }
  },
  mimetype: { 
    type: String,
    required: true
  },
  size: { 
    type: Number,
    required: true,
    min: 0
  },
  path: { 
    type: String,
    required: true
  },
  // Base64 데이터 필드 제거 - 로컬 파일시스템 사용
  user: { 
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  uploadDate: { 
    type: Date, 
    default: Date.now,
    index: true
  },
  metadata: {
    hash: String,
    encoding: String,
    uploadIp: String,
    userAgent: String
  }
}, {
  timestamps: true
});

// 인덱스 설정
FileSchema.index({ user: 1, uploadDate: -1 });
FileSchema.index({ filename: 1, user: 1 }, { unique: true });

// 파일 삭제 시 실제 파일도 삭제하는 미들웨어
FileSchema.pre('deleteOne', { document: true, query: false }, async function(next) {
  try {
    const fs = require('fs').promises;
    if (this.path && !this.path.startsWith('mongodb://')) {
      // 로컬 파일시스템의 파일 삭제
      await fs.unlink(this.path);
      console.log('Local file deleted:', this.path);
    }
    next();
  } catch (error) {
    console.error('File removal error:', error);
    // 파일 삭제 실패해도 DB 레코드는 삭제하도록 next() 호출
    next();
  }
});

// URL 안전한 파일명 생성을 위한 유틸리티 메서드
FileSchema.methods.getSafeFilename = function() {
  return this.filename;
};

// Content-Disposition 헤더를 위한 파일명 인코딩 메서드
FileSchema.methods.getEncodedFilename = function() {
  try {
    const filename = this.originalname;
    if (!filename) return '';

    // RFC 5987에 따른 인코딩
    const encodedFilename = encodeURIComponent(filename)
      .replace(/'/g, "%27")
      .replace(/\(/g, "%28")
      .replace(/\)/g, "%29")
      .replace(/\*/g, "%2A");

    return {
      legacy: filename.replace(/[^\x20-\x7E]/g, ''), // ASCII only for legacy clients
      encoded: `UTF-8''${encodedFilename}` // RFC 5987 format
    };
  } catch (error) {
    console.error('Filename encoding error:', error);
    return {
      legacy: this.filename,
      encoded: this.filename
    };
  }
};

// 파일 URL 생성을 위한 유틸리티 메서드
FileSchema.methods.getFileUrl = function(type = 'download') {
  return `/api/files/${type}/${encodeURIComponent(this.filename)}`;
};

// 다운로드용 Content-Disposition 헤더 생성 메서드
FileSchema.methods.getContentDisposition = function(type = 'attachment') {
  const { legacy, encoded } = this.getEncodedFilename();
  return `${type}; filename="${legacy}"; filename*=${encoded}`;
};

// 파일 MIME 타입 검증 메서드
FileSchema.methods.isPreviewable = function() {
  const previewableTypes = [
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'video/mp4', 'video/webm', 'video/quicktime',
    'audio/mpeg', 'audio/wav', 'audio/ogg',
    'application/pdf', 'text/plain'
  ];
  return previewableTypes.includes(this.mimetype);
};

// 파일 크기를 읽기 쉬운 형태로 반환하는 메서드
FileSchema.methods.getFormattedSize = function() {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = this.size;
  let unitIndex = 0;
  
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  
  return `${size.toFixed(1)} ${units[unitIndex]}`;
};

// 파일 타입 카테고리 반환 메서드
FileSchema.methods.getFileCategory = function() {
  const mimetype = this.mimetype;
  
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype.startsWith('video/')) return 'video';
  if (mimetype.startsWith('audio/')) return 'audio';
  if (mimetype.startsWith('application/pdf')) return 'document';
  if (mimetype.startsWith('text/')) return 'text';
  
  return 'other';
};

module.exports = mongoose.model('File', FileSchema);