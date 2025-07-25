import React, { useState, useEffect } from 'react';
import { 
  PdfIcon as FileText, 
  ImageIcon as Image, 
  MovieIcon as Film, 
  CorrectOutlineIcon as CheckCheck, 
  CorrectOutlineIcon as Check, 
  MusicIcon as Music, 
  LinkOutlineIcon as ExternalLink, 
  DownloadIcon as Download,
  ErrorCircleIcon as AlertCircle 
} from '@vapor-ui/icons';
import { Button, Text, Callout } from '@vapor-ui/core';
import PersistentAvatar from '../../common/PersistentAvatar';
import MessageContent from './MessageContent';
import MessageActions from './MessageActions';
import ReadStatus from '../ReadStatus';
import fileService from '../../../services/fileService';
import authService from '../../../services/authService';

const FileActions = ({ handleViewInNewTab, handleFileDownload }) => (
  <div className="file-actions mt-2 pt-2 border-t border-gray-200">
    <Button
      size="sm"
      variant="outline"
      onClick={handleViewInNewTab}
      title="새 탭에서 보기"
    >
      <ExternalLink size={16} />
      <span>새 탭에서 보기</span>
    </Button>
    <Button
      size="sm"
      variant="outline"
      onClick={handleFileDownload}
      title="다운로드"
    >
      <Download size={16} />
      <span>다운로드</span>
    </Button>
  </div>
);

const FileMessage = ({ 
  msg = {}, 
  isMine = false, 
  currentUser = null,
  onReactionAdd,
  onReactionRemove,
  room = null,
  messageRef,
  socketRef
}) => {
  const [error, setError] = useState(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [imageLoading, setImageLoading] = useState(true);

  useEffect(() => {
    const loadImage = async () => {
      if (msg?.file) {
        setImageLoading(true);
        setError(null);
        
        try {
          // fallback 로직을 사용하여 이미지 URL 획득
          const url = await fileService.loadImageWithFallback(msg.file);
          setPreviewUrl(url);
          console.debug('Image URL loaded:', {
            filename: msg.file.filename,
            url
          });
        } catch (loadError) {
          console.error('Failed to load image URL:', loadError);
          setError(loadError.message || '이미지를 불러올 수 없습니다.');
          // fallback으로 기본 API URL 사용
          const defaultUrl = fileService.getPreviewUrl(msg.file, true);
          setPreviewUrl(defaultUrl);
        } finally {
          setImageLoading(false);
        }
      }
    };

    loadImage();
  }, [msg?.file]);

  if (!msg?.file) {
    console.error('File data is missing:', msg);
    return null;
  }

  const formattedTime = new Date(msg.timestamp).toLocaleString('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).replace(/\./g, '년').replace(/\s/g, ' ').replace('일 ', '일 ');

  const getFileIcon = () => {
    const mimetype = msg.file?.mimetype || '';
    const iconProps = { className: "w-5 h-5 flex-shrink-0" };

    if (mimetype.startsWith('image/')) return <Image {...iconProps} color="#00C853" />;
    if (mimetype.startsWith('video/')) return <Film {...iconProps} color="#2196F3" />;
    if (mimetype.startsWith('audio/')) return <Music {...iconProps} color="#9C27B0" />;
    return <FileText {...iconProps} color="#ffffff" />;
  };

  const getDecodedFilename = (encodedFilename) => {
    try {
      if (!encodedFilename) return 'Unknown File';
      
      const base64 = encodedFilename
        .replace(/-/g, '+')
        .replace(/_/g, '/');
      
      const pad = base64.length % 4;
      const paddedBase64 = pad ? base64 + '='.repeat(4 - pad) : base64;
      
      if (paddedBase64.match(/^[A-Za-z0-9+/=]+$/)) {
        return Buffer.from(paddedBase64, 'base64').toString('utf8');
      }

      return decodeURIComponent(encodedFilename);
    } catch (error) {
      console.error('Filename decoding error:', error);
      return encodedFilename;
    }
  };

  const renderAvatar = () => (
    <PersistentAvatar 
      user={isMine ? currentUser : msg.sender}
      size="md"
      className="flex-shrink-0"
      showInitials={true}
    />
  );

  const handleFileDownload = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setError(null);
    
    try {
      if (!msg.file?.filename) {
        throw new Error('파일 정보가 없습니다.');
      }

      const user = authService.getCurrentUser();
      if (!user?.token || !user?.sessionId) {
        throw new Error('인증 정보가 없습니다.');
      }

      const baseUrl = fileService.getFileUrl(msg.file.filename, false);
      const authenticatedUrl = `${baseUrl}?token=${encodeURIComponent(user.token)}&sessionId=${encodeURIComponent(user.sessionId)}&download=true`;

      const link = document.createElement('a');
      link.href = authenticatedUrl;
      link.download = getDecodedFilename(msg.file.originalname);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

    } catch (error) {
      console.error('File download error:', error);
      setError(error.message || '파일 다운로드 중 오류가 발생했습니다.');
    }
  };

  const handleViewInNewTab = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setError(null);

    try {
      if (!msg.file?.filename) {
        throw new Error('파일 정보가 없습니다.');
      }

      const user = authService.getCurrentUser();
      if (!user?.token || !user?.sessionId) {
        throw new Error('인증 정보가 없습니다.');
      }

      const baseUrl = fileService.getFileUrl(msg.file.filename, true);
      const authenticatedUrl = `${baseUrl}?token=${encodeURIComponent(user.token)}&sessionId=${encodeURIComponent(user.sessionId)}`;

      const newWindow = window.open(authenticatedUrl, '_blank');
      if (!newWindow) {
        throw new Error('팝업이 차단되었습니다. 팝업 차단을 해제해주세요.');
      }
      newWindow.opener = null;
    } catch (error) {
      console.error('File view error:', error);
      setError(error.message || '파일 보기 중 오류가 발생했습니다.');
    }
  };

  const renderImagePreview = (originalname) => {
    try {
      if (!msg?.file?.filename) {
        return (
          <div className="flex items-center justify-center h-full bg-gray-100">
            <Image className="w-8 h-8 text-gray-400" />
          </div>
        );
      }

      if (imageLoading) {
        return (
          <div className="flex items-center justify-center h-full bg-gray-100">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
          </div>
        );
      }

      if (error) {
        return (
          <div className="flex flex-col items-center justify-center h-full bg-gray-100 p-4">
            <Image className="w-8 h-8 text-gray-400 mb-2" />
            <span className="text-xs text-red-500 text-center">{error}</span>
          </div>
        );
      }

      return (
        <div className="bg-transparent-pattern">
          <img 
            src={previewUrl}
            alt={originalname}
            className="object-cover rounded-sm"
            onLoad={(e) => {
              console.debug('Image loaded successfully:', originalname);
              setError(null);
            }}
            onError={async (e) => {
              console.error('Image load error for URL:', previewUrl);
              
              // 첫 번째 에러 시 인증된 URL로 재시도
              if (!previewUrl.includes('token=')) {
                try {
                  const user = authService.getCurrentUser();
                  if (user?.token && user?.sessionId) {
                    const apiUrl = fileService.getFileUrl(msg.file.filename, true);
                    const authenticatedUrl = `${apiUrl}?token=${encodeURIComponent(user.token)}&sessionId=${encodeURIComponent(user.sessionId)}`;
                    e.target.src = authenticatedUrl;
                    setPreviewUrl(authenticatedUrl);
                    return; // 재시도하므로 에러 처리하지 않음
                  }
                } catch (retryError) {
                  console.error('Retry with auth failed:', retryError);
                }
              }
              
              // 최종 실패 시 placeholder 이미지
              e.target.onerror = null; 
              e.target.src = '/images/placeholder-image.png';
              setError('이미지를 불러올 수 없습니다.');
            }}
            loading="lazy"
          />
        </div>
      );
    } catch (error) {
      console.error('Image preview render error:', error);
      setError(error.message || '이미지 미리보기를 불러올 수 없습니다.');
      return (
        <div className="flex items-center justify-center h-full bg-gray-100">
          <Image className="w-8 h-8 text-gray-400" />
        </div>
      );
    }
  };

  const renderFilePreview = () => {
    const mimetype = msg.file?.mimetype || '';
    const originalname = getDecodedFilename(msg.file?.originalname || 'Unknown File');
    const size = fileService.formatFileSize(msg.file?.size || 0);

    const previewWrapperClass = 
      "overflow-hidden";
    const fileInfoClass = 
      "flex items-center gap-3 p-1 mt-2";

    if (mimetype.startsWith('image/')) {
      return (
        <div className={previewWrapperClass}>
          {renderImagePreview(originalname)}
          <div className={fileInfoClass}>
            <div className="flex-1 min-w-0">
              <Text typography="body2" className="font-medium truncate">{getFileIcon()} {originalname}</Text>
              <span className="text-sm text-muted">{size}</span>
            </div>
          </div>
          <FileActions handleViewInNewTab={handleViewInNewTab} handleFileDownload={handleFileDownload} />
        </div>
      );
    }

    if (mimetype.startsWith('video/')) {
      return (
        <div className={previewWrapperClass}>
          <div>
            {previewUrl ? (
              <video 
                className="object-cover rounded-sm"
                controls
                preload="metadata"
                aria-label={`${originalname} 비디오`}
                crossOrigin="use-credentials"
              >
                <source src={previewUrl} type={mimetype} />
                <track kind="captions" />
                비디오를 재생할 수 없습니다.
              </video>
            ) : (
              <div className="flex items-center justify-center h-full">
                <Film className="w-8 h-8 text-gray-400" />
              </div>
            )}
          </div>
          <div className={fileInfoClass}>
            <div className="flex-1 min-w-0">
              <Text typography="body2" className="font-medium truncate">{getFileIcon()} {originalname}</Text>
              <span className="text-sm text-muted">{size}</span>
            </div>
          </div>
          <FileActions handleViewInNewTab={handleViewInNewTab} handleFileDownload={handleFileDownload} />
        </div>
      );
    }

    if (mimetype.startsWith('audio/')) {
      return (
        <div className={previewWrapperClass}>
          <div className={fileInfoClass}>
            <div className="flex-1 min-w-0">
              <Text typography="body2" className="font-medium truncate">{getFileIcon()} {originalname}</Text>
              <span className="text-sm text-muted">{size}</span>
            </div>
          </div>
          <div className="px-3 pb-3">
            {previewUrl && (
              <audio 
                className="w-full"
                controls
                preload="metadata"
                aria-label={`${originalname} 오디오`}
                crossOrigin="use-credentials"
              >
                <source src={previewUrl} type={mimetype} />
                오디오를 재생할 수 없습니다.
              </audio>
            )}
          </div>
          <FileActions handleViewInNewTab={handleViewInNewTab} handleFileDownload={handleFileDownload} />
        </div>
      );
    }

    return (
      <div className={previewWrapperClass}>
        <div className={fileInfoClass}>
          <div className="flex-1 min-w-0">
            <div className="font-medium truncate">{getFileIcon()} {originalname}</div>
            <Text typography="body2" as="span">{size}</Text>
          </div>
        </div>
        <FileActions handleViewInNewTab={handleViewInNewTab} handleFileDownload={handleFileDownload}  />
      </div>
    );
  };

  return (
    <div className="messages">
      <div className={`message-group ${isMine ? 'mine' : 'yours'}`}>
        <div className="message-sender-info">
          {renderAvatar()}
          <span className="sender-name">
            {isMine ? '나' : msg.sender?.name}
          </span>
        </div>
        <div className={`message-bubble ${isMine ? 'message-mine' : 'message-other'} last file-message`}>
          <div className="message-content">
            {error && (
              <Callout color="danger" className="mb-3 d-flex align-items-center">
                <AlertCircle className="w-4 h-4 me-2" />
                <span>{error}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ms-auto"
                  aria-label="Close"
                  onClick={() => setError(null)}
                >
                  ×
                </Button>
              </Callout>
            )}
            {renderFilePreview()}
            {msg.content && (
              <div className="mt-3">
                <MessageContent content={msg.content} />
              </div>
            )}
          </div>
          <div className="message-footer">
            <div 
              className="message-time mr-3" 
              title={new Date(msg.timestamp).toLocaleString('ko-KR')}
            >
              {formattedTime}
            </div>
            <ReadStatus 
              messageType={msg.type}
              participants={room.participants}
              readers={msg.readers}
              messageId={msg._id}
              messageRef={messageRef}
              currentUserId={currentUser.id}
              socketRef={socketRef}
            />
          </div>
        </div>
        <MessageActions 
          messageId={msg._id}
          messageContent={msg.content}
          reactions={msg.reactions}
          currentUserId={currentUser?.id}
          onReactionAdd={onReactionAdd}
          onReactionRemove={onReactionRemove}
          isMine={isMine}
          room={room}
        />        
      </div>
    </div>
  );
};

FileMessage.defaultProps = {
  msg: {
    file: {
      mimetype: '',
      filename: '',
      originalname: '',
      size: 0
    }
  },
  isMine: false,
  currentUser: null
};

export default React.memo(FileMessage);