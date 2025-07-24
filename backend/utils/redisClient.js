// backend/utils/redisClient.js
const Redis = require('redis');
const { redisHost, redisPort, redisPassword } = require('../config/keys');

class MockRedisClient {
  constructor() {
    this.store = new Map();
    this.isConnected = true;
    console.log('Using in-memory Redis mock (Redis server not available)');
  }

  async connect() {
    return this;
  }

  async set(key, value, options = {}) {
    const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
    this.store.set(key, { value: stringValue, expires: options.ttl ? Date.now() + (options.ttl * 1000) : null });
    return 'OK';
  }

  async get(key) {
    const item = this.store.get(key);
    if (!item) return null;
    
    if (item.expires && Date.now() > item.expires) {
      this.store.delete(key);
      return null;
    }
    
    try {
      return JSON.parse(item.value);
    } catch {
      return item.value;
    }
  }

  async setEx(key, seconds, value) {
    return this.set(key, value, { ttl: seconds });
  }

  async del(key) {
    return this.store.delete(key) ? 1 : 0;
  }

  async expire(key, seconds) {
    const item = this.store.get(key);
    if (item) {
      item.expires = Date.now() + (seconds * 1000);
      return 1;
    }
    return 0;
  }

  async quit() {
    this.store.clear();
    console.log('Mock Redis connection closed');
  }

  async incr(key) {
    const item = this.store.get(key);
    let value = item ? parseInt(item.value, 10) : 0;
    value += 1;
    this.store.set(key, { value: String(value), expires: item?.expires || null });
    return value;
  }

  async decr(key) {
    const item = this.store.get(key);
    let value = item ? parseInt(item.value, 10) : 0;
    value -= 1;
    this.store.set(key, { value: String(value), expires: item?.expires || null });
    return value;
  }

  async rPush(key, value) {
    const item = this.store.get(key);
    let list = item ? JSON.parse(item.value) : [];
    if (!Array.isArray(list)) {
      throw new Error('Key does not contain a list');
    }
    list.push(value);
    this.store.set(key, { value: JSON.stringify(list), expires: item?.expires || null });
    return list.length;
  }

  async lRange(key, start, stop) {
    const item = this.store.get(key);
    if (!item) return [];

    const list = JSON.parse(item.value);
    if (!Array.isArray(list)) {
      throw new Error('Key does not contain a list');
    }

    return list.slice(start, stop + 1);
  }
}

class RedisClient {
  constructor() {
    this.client = null;
    this.isConnected = false;
    this.connectionAttempts = 0;
    this.maxRetries = 5;
    this.retryDelay = 5000;
    this.useMock = false;
  }

  async connect() {
    if (this.isConnected && this.client) {
      return this.client;
    }

    // Check if Redis configuration is available
    if (!redisHost || !redisPort) {
      console.log('Redis configuration not found, using in-memory mock');
      this.client = new MockRedisClient();
      this.isConnected = true;
      this.useMock = true;
      return this.client;
    }

    try {
      console.log('Connecting to Redis...');

      this.client = Redis.createClient({
        url: `redis://${redisHost}:${redisPort}`,
        password: redisPassword,
        socket: {
          host: redisHost,
          port: redisPort,
          connectTimeout: 5000,
          reconnectStrategy: (retries) => {
            if (retries > this.maxRetries) {
              console.log('Max Redis reconnection attempts reached, switching to in-memory mock');
              this.client = new MockRedisClient();
              this.isConnected = true;
              this.useMock = true;
              return false;
            }
            return Math.min(retries * 50, 2000);
          }
        }
      });

      this.client.on('connect', () => {
        console.log('Redis Client Connected');
        this.isConnected = true;
        this.connectionAttempts = 0;
      });

      this.client.on('error', (err) => {
        console.error('Redis Client Error:', err.message);
        if (!this.useMock) {
          console.log('Switching to in-memory mock Redis');
          this.client = new MockRedisClient();
          this.isConnected = true;
          this.useMock = true;
        }
      });

      await this.client.connect();
      return this.client;

    } catch (error) {
      console.error('Redis connection failed:', error.message);
      console.log('Using in-memory mock Redis instead');
      this.client = new MockRedisClient();
      this.isConnected = true;
      this.useMock = true;
      return this.client;
    }
  }

  async set(key, value, options = {}) {
    try {
      if (!this.isConnected) {
        await this.connect();
      }

      if (this.useMock) {
        return await this.client.set(key, value, options);
      }

      let stringValue;
      if (typeof value === 'object') {
        stringValue = JSON.stringify(value);
      } else {
        stringValue = String(value);
      }

      if (options.ttl) {
        return await this.client.setEx(key, options.ttl, stringValue);
      }
      return await this.client.set(key, stringValue);
    } catch (error) {
      console.error('Redis set error:', error);
      throw error;
    }
  }

  async get(key) {
    try {
      if (!this.isConnected) {
        await this.connect();
      }

      if (this.useMock) {
        return await this.client.get(key);
      }

      const value = await this.client.get(key);
      if (!value) return null;

      try {
        return JSON.parse(value);
      } catch (parseError) {
        return value;
      }
    } catch (error) {
      console.error('Redis get error:', error);
      throw error;
    }
  }

  async setEx(key, seconds, value) {
    try {
      if (!this.isConnected) {
        await this.connect();
      }

      if (this.useMock) {
        return await this.client.setEx(key, seconds, value);
      }

      let stringValue;
      if (typeof value === 'object') {
        stringValue = JSON.stringify(value);
      } else {
        stringValue = String(value);
      }

      return await this.client.setEx(key, seconds, stringValue);
    } catch (error) {
      console.error('Redis setEx error:', error);
      throw error;
    }
  }

  async del(key) {
    try {
      if (!this.isConnected) {
        await this.connect();
      }
      return await this.client.del(key);
    } catch (error) {
      console.error('Redis del error:', error);
      throw error;
    }
  }

  async expire(key, seconds) {
    try {
      if (!this.isConnected) {
        await this.connect();
      }
      return await this.client.expire(key, seconds);
    } catch (error) {
      console.error('Redis expire error:', error);
      throw error;
    }
  }

  async quit() {
    if (this.client) {
      try {
        await this.client.quit();
        this.isConnected = false;
        this.client = null;
        console.log('Redis connection closed successfully');
      } catch (error) {
        console.error('Redis quit error:', error);
      }
    }
  }

  async incr(key) {
    try {
      if (!this.isConnected) {
        await this.connect();
      }

      if (this.useMock) {
        return await this.client.incr(key);
      }

      return await this.client.incr(key);
    } catch (error) {
      console.error('Redis incr error:', error);
      throw error;
    }
  }

  async decr(key) {
    try {
      if (!this.isConnected) {
        await this.connect();
      }

      if (this.useMock) {
        return await this.client.decr(key);
      }

      return await this.client.decr(key);
    } catch (error) {
      console.error('Redis decr error:', error);
      throw error;
    }
  }

  async rPush(key, value) {
    try {
      if (!this.isConnected) {
        await this.connect();
      }

      if (this.useMock) {
        return await this.client.rPush(key, value);
      }

      return await this.client.rPush(key, value);
    } catch (error) {
      console.error('Redis rPush error:', error);
      throw error;
    }
  }
}

const redisClient = new RedisClient();
module.exports = redisClient;