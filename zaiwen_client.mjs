/**
 * 在问AI 多Token客户端 - Node.js
 * ================================
 * - 支持多 token 池，自动负载/切换
 * - 额度检测，余额不足自动跳过
 * - 非流式，完整返回
 *
 * 使用:
 *   import { ZaiwenClient } from "./zaiwen_client.mjs";
 *   const client = new ZaiwenClient({ tokens: ["token1", "token2"] });
 *   const reply = await client.chat("你好");
 */

import https from "node:https";
import { fileURLToPath } from "node:url";

// ==================== HTTP 工具 ====================

function httpRequest(url, opts = {}) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: u.hostname,
        port: 443,
        path: u.pathname + u.search,
        method: opts.method || "GET",
        headers: opts.headers || {},
      },
      (res) => {
        let body = "";
        res.setEncoding("utf-8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          let data;
          try { data = JSON.parse(body); } catch { data = body; }
          resolve({ status: res.statusCode, data, raw: body });
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(opts.timeout || 30000, () => { req.destroy(); reject(new Error("请求超时")); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function buildHeaders(token) {
  return {
    Accept: "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Content-Type": "application/json",
    Origin: "https://chat.zaiwenai.com",
    Referer: "https://chat.zaiwenai.com/",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Edg/148.0.0.0",
    DNT: "1",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
    "sec-ch-ua": `"Chromium";v="148", "Microsoft Edge";v="148", "Not/A)Brand";v="99"`,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": `"Windows"`,
    token,
    channel: "web.zaiwenai.com",
    Host: "back.zaiwenai.com",
    Connection: "keep-alive",
  };
}

// ==================== 核心类 ====================

export class ZaiwenClient {
  /** 小于此值视为余额不足 */
  static MIN_BALANCE = 100;

  /**
   * @param {object} opts
   * @param {string[]} opts.tokens  token 列表
   * @param {number} [opts.minBalance=100] 最低余额阈值
   */
  constructor(opts = {}) {
    /** @type {Map<string, {balance: number, vip: string, lastCheck: number, disabled: boolean}>} */
    this._tokens = new Map();
    this._minBalance = opts.minBalance ?? ZaiwenClient.MIN_BALANCE;
    this._currentIdx = 0;

    if (opts.tokens?.length) {
      for (const t of opts.tokens) {
        this._tokens.set(t, { balance: -1, vip: "", lastCheck: 0, disabled: false });
      }
    }
  }

  // ==================== Token 管理 ====================

  /** 获取所有有效 token */
  get tokens() {
    return [...this._tokens.entries()]
      .filter(([, v]) => !v.disabled)
      .map(([k]) => k);
  }

  /** 获取所有 token 信息 */
  get tokenInfoList() {
    return [...this._tokens.entries()].map(([token, info]) => ({
      token: token.slice(0, 20) + "..." + token.slice(-10),
      balance: info.balance,
      vip: info.vip,
      disabled: info.disabled,
      lastCheck: info.lastCheck ? new Date(info.lastCheck).toISOString() : null,
    }));
  }

  /**
   * 添加 token
   * @param {string} token
   */
  addToken(token) {
    if (!this._tokens.has(token)) {
      this._tokens.set(token, { balance: -1, vip: "", lastCheck: 0, disabled: false });
    }
  }

  /**
   * 移除 token
   * @param {string} token
   */
  removeToken(token) {
    this._tokens.delete(token);
  }

  /**
   * 禁用 token
   * @param {string} token
   */
  disableToken(token) {
    const info = this._tokens.get(token);
    if (info) info.disabled = true;
  }

  /**
   * 检测单个 token 余额
   * @param {string} token
   * @returns {Promise<{balance: number, vip: string, ok: boolean}>}
   */
  async checkBalance(token) {
    const walletHeaders = {
      Host: "back.zaiwenai.com",
      Connection: "keep-alive",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
      channel: "web.zaiwenai.com",
      "Content-Type": "application/json",
      token,
      Accept: "*/*",
      Origin: "https://www.zaiwenai.com",
      Referer: "https://www.zaiwenai.com/",
      "Accept-Language": "zh-CN,zh;q=0.9",
    };

    const { data } = await httpRequest(
      "https://back.zaiwenai.com/api/v1/application/wallet/info?",
      { headers: walletHeaders, timeout: 10000 }
    );

    const balance = parseFloat(data?.data?.characterBalance) || 0;
    const vip = data?.data?.vip || "未知";
    const ok = balance >= this._minBalance;

    const info = this._tokens.get(token);
    if (info) {
      info.balance = balance;
      info.vip = vip;
      info.lastCheck = Date.now();
    }

    return { balance, vip, ok };
  }

  /**
   * 检测所有 token 余额
   * @returns {Promise<{balance: number, vip: string, ok: boolean, token: string}[]>}
   */
  async checkAllBalances() {
    const results = [];
    for (const token of this.tokens) {
      try {
        const r = await this.checkBalance(token);
        results.push({ ...r, token });
      } catch (e) {
        results.push({ balance: 0, vip: "检测失败", ok: false, token, error: e.message });
      }
    }
    return results;
  }

  /**
   * 获取一个可用的 token (轮询 + 跳过余额不足)
   * @returns {Promise<string>}
   */
  async _pickToken() {
    const active = this.tokens;
    if (active.length === 0) throw new Error("没有可用 token，请检查余额或添加新 token");

    // 轮询尝试，最多一圈
    for (let i = 0; i < active.length; i++) {
      this._currentIdx = (this._currentIdx + 1) % active.length;
      const token = active[this._currentIdx];
      const info = this._tokens.get(token);
      if (!info) continue;

      // 30秒内检查过，直接信任缓存；否则重新检测
      if (Date.now() - info.lastCheck > 30000) {
        try {
          await this.checkBalance(token);
        } catch {
          continue;
        }
      }

      if (info.balance >= this._minBalance) {
        return token;
      }
    }

    throw new Error("所有 token 余额均不足");
  }

  // ==================== 对话 ====================

  /**
   * 发送对话（非流式）
   * @param {string} content 用户消息
   * @param {object} opts
   * @param {string} [opts.model="zaiwen-auto"] 模型名
   * @param {string} [opts.conversationId] 多轮对话ID
   * @param {number} [opts.round=1] 轮数
   * @param {boolean} [opts.online=false] 联网搜索
   * @param {string} [opts.token] 指定 token（不自动选择）
   * @returns {Promise<{reply: string, thinking: string, conversationId: string, model: string, token: string}>}
   */
  async chat(content, opts = {}) {
    const {
      model = "zaiwen-auto",
      conversationId = "",
      online = false,
    } = opts;

    let round = opts.round || 1;
    let token = opts.token || (await this._pickToken());

    if (!conversationId) {
      round = 1;
    }

    const payload = JSON.stringify({
      data: {
        content,
        model,
        round,
        type: "text",
        online,
        agent: false,
        file: {},
        knowledge: [],
        draw: {},
        suno_input: {},
        video: {
          ratio: "1:1",
          resolution: "720p",
          duration: 5,
          mediaModel: "referenceImage",
          generate_audio: true,
          original_image: { image: {}, weight: 50 },
          reference_medias: [],
        },
        pptx_extra: { color_scheme: "", style: "", scenario: "" },
        ...(conversationId ? { conversation_id: conversationId } : {}),
      },
    });

    const headers = buildHeaders(token);
    headers["Content-Length"] = Buffer.byteLength(payload);

    const { status, raw, data } = await httpRequest(
      `https://back.zaiwenai.com/api/v1/ai/message/stream`,
      { method: "POST", headers, body: payload, timeout: 120000 }
    );

    if (status !== 200) {
      // 可能是 token 过期
      if (status === 401 || status === 403) {
        this.disableToken(token);
        // 重试其他 token
        if (!opts.token) {
          const newToken = await this._pickToken();
          return this.chat(content, { ...opts, token: newToken });
        }
      }
      throw new Error(`HTTP ${status}: ${typeof raw === "string" ? raw.slice(0, 300) : JSON.stringify(raw)}`);
    }

    // 解析 SSE
    const events = [];
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const d = line.slice(5).trim();
      if (!d) continue;
      try { events.push(JSON.parse(d)); } catch {}
    }

    let convId = "";
    let fullText = "";
    let modelUsed = "";

    for (const ev of events) {
      switch (ev.type) {
        case "conversation":
          convId = ev.conversation_id || ev.data?.id || convId;
          modelUsed = ev.data?.model || modelUsed;
          break;
        case "streaming":
          fullText += ev.content || "";
          break;
        case "assistant-message":
          modelUsed = ev.data?.model || modelUsed;
          break;
        case "error":
          throw new Error(ev.content || JSON.stringify(ev));
      }
    }

    // 分离思考过程
    let thinking = "";
    let reply = fullText;
    if (fullText.trimStart().startsWith(">")) {
      const lines = fullText.split("\n");
      const thinkLines = [];
      const replyLines = [];
      let inThinking = true;
      for (const line of lines) {
        if (inThinking && (line.startsWith(">") || line.trim() === "")) {
          thinkLines.push(line);
        } else {
          inThinking = false;
          replyLines.push(line);
        }
      }
      thinking = thinkLines.join("\n").trim();
      reply = replyLines.join("\n").trim() || fullText.trim();
    }

    return { reply, thinking, conversationId: convId, model: modelUsed, token };
  }

  // ==================== 多轮对话辅助 ====================

  /**
   * 创建对话会话
   */
  createSession(model = "zaiwen-auto") {
    return new ChatSession(this, model);
  }
}

/**
 * 对话会话 - 自动维护 round 和 conversationId
 */
export class ChatSession {
  /**
   * @param {ZaiwenClient} client
   * @param {string} model
   */
  constructor(client, model = "zaiwen-auto") {
    this.client = client;
    this.model = model;
    this.conversationId = "";
    this.round = 0;
    this.history = [];
  }

  /**
   * 发送消息
   * @param {string} content
   * @param {object} [opts]
   */
  async send(content, opts = {}) {
    this.round++;
    const result = await this.client.chat(content, {
      model: opts.model || this.model,
      conversationId: this.conversationId,
      round: this.round,
      online: opts.online || false,
      token: opts.token,
    });

    this.conversationId = result.conversationId;
    this.history.push({ role: "user", content });
    this.history.push({ role: "assistant", content: result.reply });

    return result;
  }
}

// ==================== 直接运行测试 ====================
const __filename = fileURLToPath(import.meta.url);
const __isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("/zaiwen_client.mjs")
  || process.argv[1]?.replace(/\\/g, "/") === __filename.replace(/\\/g, "/");

if (__isMain) {
  const TOKEN = "6a684fe1c158d97f2b0e02d5-a081e3f49e527b5ba51546e5e632dcc9";

  const client = new ZaiwenClient({ tokens: [TOKEN] });

  console.log("=".repeat(55));
  console.log("在问AI 多Token客户端 - 测试");
  console.log("=".repeat(55));

  // 1. 检测余额
  console.log("\n[1] 检测 token 余额...");
  const balances = await client.checkAllBalances();
  for (const b of balances) {
    console.log(`    Token: ${b.token.slice(0, 20)}...`);
    console.log(`    余额: ${b.balance.toLocaleString()} | VIP: ${b.vip} | 可用: ${b.ok ? "✓" : "✗"}`);
    if (b.error) console.log(`    错误: ${b.error}`);
  }

  // 2. 单轮对话
  console.log("\n[2] 单轮对话测试...");
  const r1 = await client.chat("你好，给我讲个程序员笑话", { online: false });
  console.log(`    回复: ${r1.reply.slice(0, 120)}${r1.reply.length > 120 ? "..." : ""}`);
  console.log(`    模型: ${r1.model} | Token: ${r1.token.slice(-16)}`);

  // 3. 多轮对话
  console.log("\n[3] 多轮对话测试...");
  const session = client.createSession();
  const s1 = await session.send("用三个词形容大海");
  console.log(`    Q1 回复: ${s1.reply}`);
  const s2 = await session.send("详细展开第二个词");
  console.log(`    Q2 回复: ${s2.reply.slice(0, 100)}...`);
  console.log(`    对话轮数: ${session.round} | ID: ${session.conversationId}`);

  // 4. Token 信息
  console.log("\n[4] Token 池状态:");
  console.table(client.tokenInfoList);

  console.log("=".repeat(55));
  console.log("测试完成");
}
