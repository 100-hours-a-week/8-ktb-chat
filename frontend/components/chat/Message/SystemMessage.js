import React from 'react';

const SystemMessage = React.forwardRef(({ msg }, ref) => {
  const formattedTime = new Date(msg.timestamp).toLocaleString('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).replace(/\./g, '년').replace(/\s/g, ' ').replace('일 ', '일 ');
  
  return (
    <div ref={ref} className="message-system">
      {msg.content}
      {formattedTime && (
        <div className="message-time">
          {formattedTime}
        </div>
      )}
    </div>
  );
});

export default React.memo(SystemMessage);