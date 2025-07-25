import { useState, useCallback } from 'react';
import { Toast } from '../components/Toast';
import fileService from '../services/fileService';

// 고유 ID 생성 함수
const generateRequestId = () => {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
};

export const useMessageHandling = (socketRef, currentUser, router, handleSessionError, messages = []) => {
 const [message, setMessage] = useState('');
 const [showEmojiPicker, setShowEmojiPicker] = useState(false);
 const [showMentionList, setShowMentionList] = useState(false);
 const [mentionFilter, setMentionFilter] = useState('');
 const [mentionIndex, setMentionIndex] = useState(0);
 const [filePreview, setFilePreview] = useState(null);
 const [uploading, setUploading] = useState(false);
 const [uploadProgress, setUploadProgress] = useState(0);
 const [uploadError, setUploadError] = useState(null);
 const [loadingMessages, setLoadingMessages] = useState(false);

 const handleMessageChange = useCallback((e) => {
   const newValue = e.target.value;
   setMessage(newValue);

   const cursorPosition = e.target.selectionStart;
   const textBeforeCursor = newValue.slice(0, cursorPosition);
   const atSymbolIndex = textBeforeCursor.lastIndexOf('@');

   if (atSymbolIndex !== -1) {
     const mentionText = textBeforeCursor.slice(atSymbolIndex + 1);
     if (!mentionText.includes(' ')) {
       setMentionFilter(mentionText.toLowerCase());
       setShowMentionList(true);
       setMentionIndex(0);
       return;
     }
   }
   
   setShowMentionList(false);
 }, []);

 const handleLoadMore = useCallback(async () => {
   if (!socketRef.current?.connected) {
     console.warn('Cannot load messages: Socket not connected');
     return;
   }

   try {
     if (loadingMessages) {
       console.log('Already loading messages, skipping...');
       return;
     }

     setLoadingMessages(true);
     const firstMessageTimestamp = messages[0]?.timestamp;

     console.log('Loading more messages:', {
       roomId: router?.query?.room,
       before: firstMessageTimestamp,
       currentMessageCount: messages.length
     });

     // Promise를 반환하도록 수정
     return new Promise((resolve, reject) => {
       const timeout = setTimeout(() => {
         setLoadingMessages(false);
         reject(new Error('Message loading timed out'));
       }, 10000);

       socketRef.current.emit('fetchPreviousMessages', {
         roomId: router?.query?.room,
         before: firstMessageTimestamp
       });

       socketRef.current.once('previousMessagesLoaded', (response) => {
         clearTimeout(timeout);
         setLoadingMessages(false);
         resolve(response);
       });

       socketRef.current.once('error', (error) => {
         clearTimeout(timeout);
         setLoadingMessages(false);
         reject(error);
       });
     });

   } catch (error) {
     console.error('Load more messages error:', error);
     Toast.error('이전 메시지를 불러오는데 실패했습니다.');
     setLoadingMessages(false);
     throw error;
   }
 }, [socketRef, router?.query?.room, loadingMessages, messages]);

 const handleMessageSubmit = useCallback(async (messageData) => {
   console.log('=== FRONTEND MESSAGE SUBMIT START ===');
   console.log('Submit data:', {
     type: messageData?.type,
     hasContent: !!messageData?.content,
     hasFileData: !!messageData?.fileData,
     socketConnected: socketRef.current?.connected,
     currentUser: !!currentUser,
     roomId: router?.query?.room,
     timestamp: new Date().toISOString()
   });

   if (!socketRef.current?.connected || !currentUser) {
     console.error('❌ FRONTEND ERROR: Socket not connected or no user');
     console.error('Socket details:', {
       connected: socketRef.current?.connected,
       socketExists: !!socketRef.current,
       hasCurrentUser: !!currentUser
     });
     Toast.error('채팅 서버와 연결이 끊어졌습니다.');
     return;
   }

   const roomId = router?.query?.room;
   if (!roomId) {
     console.error('❌ FRONTEND ERROR: No room ID');
     Toast.error('채팅방 정보를 찾을 수 없습니다.');
     return;
   }

   try {
     console.log('📤 Sending message:', messageData);

     if (messageData.type === 'file') {
       console.log('📁 Processing file upload...');
       setUploading(true);
       setUploadError(null);
       setUploadProgress(0);

       console.log('File details:', {
         hasFile: !!messageData.fileData?.file,
         fileName: messageData.fileData?.file?.name,
         fileSize: messageData.fileData?.file?.size,
         fileType: messageData.fileData?.file?.type
       });

       try {
         console.log('🚀 Starting file upload...');
         const uploadResponse = await fileService.uploadFile(
           messageData.fileData.file,
           (progress) => {
             console.log('📊 Upload progress:', progress + '%');
             setUploadProgress(progress);
           }
         );

         console.log('✅ Upload response received:', {
           success: uploadResponse?.success,
           hasData: !!uploadResponse?.data,
           hasFile: !!uploadResponse?.data?.file,
           fileId: uploadResponse?.data?.file?._id,
           filename: uploadResponse?.data?.file?.filename,
           error: uploadResponse?.error || uploadResponse?.message
         });

         if (!uploadResponse.success) {
           console.error('❌ Upload failed:', {
             message: uploadResponse.message,
             error: uploadResponse.error,
             details: uploadResponse.details
           });
           throw new Error(uploadResponse.message || '파일 업로드에 실패했습니다.');
         }

         // 안전한 파일 데이터 추출
         const fileData = uploadResponse?.data?.file;
         if (!fileData || !fileData._id || !fileData.filename) {
           console.error('❌ Invalid file data in upload response:', {
             hasFileData: !!fileData,
             fileId: fileData?._id,
             filename: fileData?.filename,
             fullResponse: uploadResponse
           });
           throw new Error('업로드 응답에 유효하지 않은 파일 데이터가 포함되어 있습니다.');
         }

         console.log('📡 Emitting file message to socket...');
         const messagePayload = {
           room: roomId,
           type: 'file',
           content: messageData.content || '',
           requestId: generateRequestId(),
           fileData: {
             _id: fileData._id,
             filename: fileData.filename,
             originalname: fileData.originalname,
             mimetype: fileData.mimetype,
             size: fileData.size
           }
         };

         console.log('Message payload:', messagePayload);
         socketRef.current.emit('chatMessage', messagePayload);
         console.log('✅ File message emitted successfully');

         setFilePreview(null);
         setMessage('');
         setUploading(false);
         setUploadProgress(0);

       } catch (uploadError) {
         console.error('❌ FILE UPLOAD ERROR:', {
           message: uploadError.message,
           stack: uploadError.stack,
           name: uploadError.name
         });
         
         setUploading(false);
         setUploadProgress(0);
         setUploadError(uploadError.message);
         Toast.error(`파일 업로드 실패: ${uploadError.message}`);
         throw uploadError;
       }

     } else if (messageData.content?.trim()) {
       console.log('📝 Processing text message...');
       const textPayload = {
         room: roomId,
         type: 'text',
         content: messageData.content.trim(),
         requestId: generateRequestId()
       };

       console.log('Text message payload:', textPayload);
       socketRef.current.emit('chatMessage', textPayload);
       console.log('✅ Text message emitted successfully');
     }

     console.log('=== FRONTEND MESSAGE SUBMIT SUCCESS ===');

   } catch (error) {
     console.error('=== FRONTEND MESSAGE SUBMIT ERROR ===');
     console.error('Error details:', {
       message: error.message,
       stack: error.stack,
       name: error.name,
       messageData: {
         type: messageData?.type,
         hasContent: !!messageData?.content,
         hasFileData: !!messageData?.fileData
       },
       timestamp: new Date().toISOString()
     });

     if (error.message?.includes('세션') || 
         error.message?.includes('인증') || 
         error.message?.includes('토큰')) {
       console.log('🔄 Session error detected, handling session error...');
       await handleSessionError();
       return;
     }

     Toast.error(`메시지 전송 실패: ${error.message}`);
     console.error('=== FRONTEND MESSAGE SUBMIT ERROR END ===');
   }
 }, [socketRef, currentUser, router?.query?.room, handleSessionError, setUploading, setUploadError, setUploadProgress, setFilePreview, setMessage]);

 const handleEmojiToggle = useCallback(() => {
   setShowEmojiPicker(prev => !prev);
 }, []);

 const getFilteredParticipants = useCallback((room) => {
   if (!room?.participants) return [];

   const allParticipants = [
     {
       _id: 'wayneAI',
       name: 'wayneAI',
       email: 'ai@wayne.ai',
       isAI: true
     },
     {
       _id: 'consultingAI',
       name: 'consultingAI',
       email: 'ai@consulting.ai',
       isAI: true
     },
     {
      _id: 'BadGirl',
      name: 'BadGirl',
      email: 'ai@BadGirl.ai',
      isAI: true
    },
     ...room.participants
   ];

   return allParticipants.filter(user => 
     user.name.toLowerCase().includes(mentionFilter) ||
     user.email.toLowerCase().includes(mentionFilter)
   );
 }, [mentionFilter]);

 const insertMention = useCallback((messageInputRef, user) => {
   if (!messageInputRef?.current) return;

   const cursorPosition = messageInputRef.current.selectionStart;
   const textBeforeCursor = message.slice(0, cursorPosition);
   const atSymbolIndex = textBeforeCursor.lastIndexOf('@');

   if (atSymbolIndex !== -1) {
     const textBeforeAt = message.slice(0, atSymbolIndex);
     const newMessage = 
       textBeforeAt +
       `@${user.name} ` +
       message.slice(cursorPosition);

     setMessage(newMessage);
     setShowMentionList(false);

     setTimeout(() => {
       const newPosition = atSymbolIndex + user.name.length + 2;
       messageInputRef.current.focus();
       messageInputRef.current.setSelectionRange(newPosition, newPosition);
     }, 0);
   }
 }, [message]);

 const removeFilePreview = useCallback(() => {
   setFilePreview(null);
   setUploadError(null);
   setUploadProgress(0);
 }, []);

 return {
   message,
   showEmojiPicker,
   showMentionList,
   mentionFilter,
   mentionIndex,
   filePreview,
   uploading,
   uploadProgress,
   uploadError,
   loadingMessages,
   setMessage,
   setShowEmojiPicker,
   setShowMentionList,
   setMentionFilter,
   setMentionIndex,
   setFilePreview,
   setLoadingMessages,
   handleMessageChange,
   handleMessageSubmit,
   handleEmojiToggle,
   handleLoadMore,
   getFilteredParticipants,
   insertMention,
   removeFilePreview
 };
};

export default useMessageHandling;