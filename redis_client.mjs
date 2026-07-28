/**
 * 轻量级 Redis 客户端 (零依赖, 纯 Node.js net 模块)
 * ===================================================
 * 仅实现项目所需命令: AUTH, SET, GET, DEL, KEYS
 */
import net from "node:net";
import { URL } from "node:url";

export class RedisClient {
  #socket = null;
  #buf = "";
  #pending = [];
  #ready = false;

  /**
   * @param {string} redisUrl  redis://user:pass@host:port
   */
  constructor(redisUrl) {
    const u = new URL(redisUrl);
    this.host = u.hostname;
    this.port = parseInt(u.port || "6379", 10);
    this.password = u.password || "";
    this.#connect();
  }

  // ==================== 连接 ====================

  #connect() {
    this.#socket = net.createConnection({ host: this.host, port: this.port }, () => {
      this.#ready = true;
      // 先认证
      if (this.password) {
        this.#send(["AUTH", this.password]).then(() => this.#flushPending());
      } else {
        this.#flushPending();
      }
    });

    this.#socket.on("data", (chunk) => {
      this.#buf += chunk.toString("utf-8");
      this.#tryResolve();
    });

    this.#socket.on("error", (e) => {
      this.#rejectAll(e);
    });

    this.#socket.on("close", () => {
      this.#ready = false;
    });

    // 心跳保持连接
    setInterval(() => {
      if (this.#ready) this.#send(["PING"]).catch(() => {});
    }, 300000); // 5分钟
  }

  #send(args) {
    return new Promise((resolve, reject) => {
      this.#pending.push({ resolve, reject });
      const parts = args.map((a) => `$${Buffer.byteLength(String(a))}\r\n${a}\r\n`).join("");
      const cmd = `*${args.length}\r\n${parts}`;
      this.#socket.write(cmd);
    });
  }

  #flushPending() {
    for (const p of this.#pending) {
      // 如果有等待的回调，让它们通过 #tryResolve 处理
      // 如果认证失败了会被拒绝
    }
  }

  #rejectAll(err) {
    for (const p of this.#pending) p.reject(err);
    this.#pending = [];
  }

  #tryResolve() {
    while (this.#pending.length > 0 && this.#buf.length > 0) {
      const { resolve, reject } = this.#pending[0];
      try {
        const { result, consumed } = this.#parse(this.#buf);
        this.#buf = this.#buf.slice(consumed);
        this.#pending.shift();
        resolve(result);
      } catch (e) {
        if (e === "INCOMPLETE") break;
        this.#pending.shift();
        reject(e);
      }
    }
  }

  // ==================== RESP 解析器 ====================

  #parse(str) {
    if (!str) throw "INCOMPLETE";
    switch (str[0]) {
      case "+": { // Simple String
        const end = str.indexOf("\r\n");
        if (end === -1) throw "INCOMPLETE";
        return { result: str.slice(1, end), consumed: end + 2 };
      }
      case "-": { // Error
        const end = str.indexOf("\r\n");
        if (end === -1) throw "INCOMPLETE";
        throw new Error(str.slice(1, end));
      }
      case ":": { // Integer
        const end = str.indexOf("\r\n");
        if (end === -1) throw "INCOMPLETE";
        return { result: parseInt(str.slice(1, end), 10), consumed: end + 2 };
      }
      case "$": { // Bulk String
        const crlf = str.indexOf("\r\n");
        if (crlf === -1) throw "INCOMPLETE";
        const len = parseInt(str.slice(1, crlf), 10);
        if (len === -1) return { result: null, consumed: crlf + 2 };
        const start = crlf + 2;
        if (str.length < start + len + 2) throw "INCOMPLETE";
        return { result: str.slice(start, start + len), consumed: start + len + 2 };
      }
      case "*": { // Array
        const crlf = str.indexOf("\r\n");
        if (crlf === -1) throw "INCOMPLETE";
        const count = parseInt(str.slice(1, crlf), 10);
        if (count === -1) return { result: null, consumed: crlf + 2 };
        let offset = crlf + 2;
        const items = [];
        for (let i = 0; i < count; i++) {
          const { result, consumed } = this.#parse(str.slice(offset));
          items.push(result);
          offset += consumed;
        }
        return { result: items, consumed: offset };
      }
      default:
        throw new Error("未知 RESP 类型: " + str[0]);
    }
  }

  // ==================== 公开 API ====================

  /** 等待连接就绪 */
  async #waitReady() {
    if (this.#ready) return;
    // 简单等待最多 5 秒
    for (let i = 0; i < 50; i++) {
      if (this.#ready) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("Redis 连接超时");
  }

  /** SET key value */
  async set(key, value) {
    await this.#waitReady();
    return this.#send(["SET", key, value]);
  }

  /** GET key → value | null */
  async get(key) {
    await this.#waitReady();
    return this.#send(["GET", key]);
  }

  /** DEL key → 删除数量 */
  async del(key) {
    await this.#waitReady();
    return this.#send(["DEL", key]);
  }

  /** KEYS pattern → string[] */
  async keys(pattern = "*") {
    await this.#waitReady();
    return this.#send(["KEYS", pattern]);
  }

  /** PING */
  async ping() {
    await this.#waitReady();
    return this.#send(["PING"]);
  }

  /** 关闭连接 */
  close() {
    if (this.#socket) {
      this.#socket.destroy();
      this.#ready = false;
    }
  }
}
