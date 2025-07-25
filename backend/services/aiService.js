const axios = require('axios');
const { openaiApiKey } = require('../config/keys');
const redisClient = require('../utils/redisClient');
const crypto = require('crypto');

class AIService {
  constructor() {
    this.openaiClient = axios.create({
      baseURL: 'https://api.openai.com/v1',
      headers: {
        'Authorization': `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 60000, // 60초 타임아웃
    });

    // AI 요청 큐 관리
    this.processingQueue = new Map(); // 현재 처리 중인 요청들
    this.maxConcurrentRequests = 3;  // 동시 처리 가능한 최대 AI 요청 수
    this.requestQueue = [];          // 대기 중인 요청들
    this.isProcessing = false;

    // 큐 처리 시작
    this.startQueueProcessor();
  }

  /**
   * 큐 처리기 시작 - 대기 중인 AI 요청들을 순차적으로 처리
   */
  startQueueProcessor() {
    setInterval(async () => {
      if (this.isProcessing || this.requestQueue.length === 0) {
        return;
      }

      // 동시 처리 중인 요청 수가 제한을 초과하지 않는 경우에만 처리
      if (this.processingQueue.size >= this.maxConcurrentRequests) {
        return;
      }

      this.isProcessing = true;
      const nextRequest = this.requestQueue.shift();
      
      if (nextRequest) {
        this.processAIRequest(nextRequest)
          .catch(error => {
            console.error('Queue processor error:', error);
            // 에러 발생 시 클라이언트에 알림
            if (nextRequest.callbacks?.onError) {
              nextRequest.callbacks.onError(error);
            }
          })
          .finally(() => {
            this.processingQueue.delete(nextRequest.requestId);
          });
      }
      
      this.isProcessing = false;
    }, 100); // 100ms마다 큐 체크
  }

  /**
   * AI 응답 생성 요청을 큐에 추가
   * @param {string} message - 사용자 메시지
   * @param {string} persona - AI 페르소나
   * @param {Object} callbacks - 콜백 함수들
   * @returns {Promise<string>} 요청 ID
   */
  async queueResponse(message, persona = 'wayneAI', callbacks = {}) {
    const requestId = crypto.randomBytes(16).toString('hex');
    
    // 중복 요청 체크 (같은 메시지와 페르소나)
    const duplicateKey = crypto.createHash('md5')
      .update(`${message}:${persona}`)
      .digest('hex');

    // Redis에서 최근 처리된 동일 요청 확인 (1분 이내)
    try {
      const recentResponse = await redisClient.get(`ai:recent:${duplicateKey}`);
      if (recentResponse && callbacks.onComplete) {
        // 최근 동일 요청이 있다면 즉시 반환
        console.log(`[AI] Returning cached response for duplicate request: ${duplicateKey}`);
        setImmediate(() => {
          callbacks.onStart && callbacks.onStart();
          callbacks.onComplete && callbacks.onComplete({ content: recentResponse });
        });
        return requestId;
      }
    } catch (error) {
      console.warn('Failed to check duplicate AI request:', error);
    }

    const queueItem = {
      requestId,
      message,
      persona,
      callbacks,
      timestamp: Date.now(),
      duplicateKey
    };

    // 큐에 추가
    this.requestQueue.push(queueItem);
    
    console.log(`[AI] Request queued: ${requestId}, Queue size: ${this.requestQueue.length}, Processing: ${this.processingQueue.size}`);
    
    return requestId;
  }

  /**
   * 개별 AI 요청 처리
   * @param {Object} queueItem - 큐 아이템
   */
  async processAIRequest(queueItem) {
    const { requestId, message, persona, callbacks, duplicateKey } = queueItem;
    
    try {
      console.log(`[AI] Processing request: ${requestId}`);
      this.processingQueue.set(requestId, queueItem);

      // 콜백 호출
      if (callbacks.onStart) {
        callbacks.onStart();
      }

      const response = await this.generateStreamingResponse(message, persona, callbacks);
      
      // 성공한 응답을 Redis에 캐시 (1분간)
      try {
        await redisClient.setEx(`ai:recent:${duplicateKey}`, 60, response);
      } catch (cacheError) {
        console.warn('Failed to cache AI response:', cacheError);
      }

      console.log(`[AI] Request completed: ${requestId}`);
      return response;

    } catch (error) {
      console.error(`[AI] Request failed: ${requestId}`, error);
      throw error;
    }
  }

  /**
   * 스트리밍 AI 응답 생성 (기존 로직 개선)
   * @param {string} message - 사용자 메시지
   * @param {string} persona - AI 페르소나
   * @param {Object} callbacks - 콜백 함수들
   * @returns {Promise<string>} 최종 응답
   */
  async generateStreamingResponse(message, persona = 'wayneAI', callbacks = {}) {
    const aiPersona = {
      wayneAI: {
        name: 'Wayne AI',
        role: '단어로 단답형으로 말하는 어시스턴트',
        traits: '질문에 최적화된 답변을 단어로 짧게 말해줌',
        tone: '밝음',
      },
      consultingAI: {
        name: 'Consulting AI',
        role: '단어로 단답형으로 말하는 어시스턴트',
        traits: '질문에 최적화된 답변을 단어로 짧게 말해줌',
        tone: '밝음',
      },
      BadGirl: {
        name: 'BadGirl',
        role: '욕쟁이 할머니',
        traits: '욕하고 단답하는 할머니',
        tone: '천박하고 가볍지만 친숙한 톤',
      }
    }[persona];

    if (!aiPersona) {
      throw new Error('Unknown AI persona');
    }

    const systemPrompt = `당신은 ${aiPersona.name}입니다.
역할: ${aiPersona.role}
특성: ${aiPersona.traits}
톤: ${aiPersona.tone}

답변 시 주의사항:
1. 10글자 이내로 완전 짧게 단어만 말하면 제일 좋고, 단답형으로 말하세요.
2. ${aiPersona.tone}을 유지하세요.`;

    try {
      const response = await this.openaiClient.post('/chat/completions', {
        model: 'gpt-4',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message }
        ],
        temperature: 0.1,
        max_tokens: 10,
        stream: true
      }, {
        responseType: 'stream',
        timeout: 45000, // 45초 타임아웃
      });

      let fullResponse = '';
      let isCodeBlock = false;
      let buffer = '';

      return new Promise((resolve, reject) => {
        // 타임아웃 설정
        const timeoutId = setTimeout(() => {
          reject(new Error('AI response timeout'));
        }, 50000);

        const cleanup = () => {
          clearTimeout(timeoutId);
        };

        response.data.on('data', async chunk => {
          try {
            // 청크 데이터를 문자열로 변환하고 버퍼에 추가
            buffer += chunk.toString();

            // 완전한 JSON 객체를 찾아 처리
            while (true) {
              const newlineIndex = buffer.indexOf('\n');
              if (newlineIndex === -1) break;

              const line = buffer.slice(0, newlineIndex).trim();
              buffer = buffer.slice(newlineIndex + 1);

              if (line === '') continue;
              if (line === 'data: [DONE]') {
                cleanup();
                if (callbacks.onComplete) {
                  callbacks.onComplete({ content: fullResponse.trim() });
                }
                resolve(fullResponse.trim());
                return;
              }

              if (line.startsWith('data: ')) {
                try {
                  const data = JSON.parse(line.slice(6));
                  const content = data.choices[0]?.delta?.content;
                  
                  if (content) {
                    // 코드 블록 상태 업데이트
                    if (content.includes('```')) {
                      isCodeBlock = !isCodeBlock;
                    }

                    // 현재 청크만 전송
                    if (callbacks.onChunk) {
                      await callbacks.onChunk({
                        currentChunk: content,
                        isCodeBlock
                      });
                    }

                    // 전체 응답은 서버에서만 관리
                    fullResponse += content;
                  }
                } catch (err) {
                  console.error('JSON parsing error:', err);
                }
              }
            }
          } catch (error) {
            console.error('Stream processing error:', error);
            cleanup();
            if (callbacks.onError) {
              callbacks.onError(error);
            }
            reject(error);
          }
        });

        response.data.on('error', (error) => {
          console.error('Stream error:', error);
          cleanup();
          if (callbacks.onError) {
            callbacks.onError(error);
          }
          reject(error);
        });

        response.data.on('end', () => {
          cleanup();
          if (fullResponse) {
            if (callbacks.onComplete) {
              callbacks.onComplete({ content: fullResponse.trim() });
            }
            resolve(fullResponse.trim());
          } else {
            reject(new Error('Empty AI response'));
          }
        });
      });

    } catch (error) {
      console.error('AI API error:', error);
      
      // 에러 타입별 처리
      if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
        throw new Error('AI 서비스 응답 시간이 초과되었습니다.');
      } else if (error.response?.status === 429) {
        throw new Error('AI 서비스 요청 한도를 초과했습니다. 잠시 후 다시 시도해주세요.');
      } else if (error.response?.status >= 500) {
        throw new Error('AI 서비스에 일시적인 문제가 발생했습니다.');
      } else {
        throw new Error('AI 응답 생성 중 오류가 발생했습니다.');
      }
    }
  }

  /**
   * 레거시 호환성을 위한 기존 generateResponse 메서드
   * @param {string} message - 사용자 메시지
   * @param {string} persona - AI 페르소나
   * @param {Object} callbacks - 콜백 함수들
   * @returns {Promise<string>} 요청 ID
   */
  async generateResponse(message, persona = 'wayneAI', callbacks = {}) {
    return this.queueResponse(message, persona, callbacks);
  }

  /**
   * 큐 상태 조회
   * @returns {Object} 큐 상태 정보
   */
  getQueueStatus() {
    return {
      queueLength: this.requestQueue.length,
      processing: this.processingQueue.size,
      maxConcurrent: this.maxConcurrentRequests,
      isHealthy: this.processingQueue.size < this.maxConcurrentRequests
    };
  }

  /**
   * 특정 요청 취소
   * @param {string} requestId - 요청 ID
   * @returns {boolean} 취소 성공 여부
   */
  cancelRequest(requestId) {
    // 대기 큐에서 제거
    const queueIndex = this.requestQueue.findIndex(item => item.requestId === requestId);
    if (queueIndex !== -1) {
      this.requestQueue.splice(queueIndex, 1);
      console.log(`[AI] Request cancelled from queue: ${requestId}`);
      return true;
    }

    // 처리 중인 요청은 취소할 수 없음 (이미 진행 중)
    if (this.processingQueue.has(requestId)) {
      console.log(`[AI] Cannot cancel processing request: ${requestId}`);
      return false;
    }

    return false;
  }
}

module.exports = new AIService();