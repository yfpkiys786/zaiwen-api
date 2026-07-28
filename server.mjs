/**
 * 在问AI API 服务
 * ================
 * 零外部依赖，纯 Node.js 内置模块
 *
 * 启动: node server.mjs
 * 环境变量:
 *   PORT=3456               服务端口
 *   TOKENS=token1,token2    初始token（部署时填一次，之后用接口管理）
 *   MIN_BALANCE=100         最低余额阈值
 *   ADMIN_KEY=yourkey       管理接口密钥（保护增删token操作）
 *
 * 接口:
 *   POST /v1/chat              单轮对话
 *   POST /v1/chat/session      多轮对话
 *   GET  /v1/tokens            Token池状态+余额
 *   GET  /v1/health            健康检查
 *   POST /v1/admin/tokens      添加token  {token, adminKey}
 *   DELETE /v1/admin/tokens    删除token  {token, adminKey}
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { ZaiwenClient } from "./zaiwen_client.mjs";

// ==================== 加载 .env 文件 (零依赖) ====================
function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !process.env[key]) {
      process.env[key] = val;
    }
  }
}
loadEnv(path.resolve(".env"));

// ==================== 配置 ====================
const PORT = parseInt(process.env.PORT || "3456", 10);
const ADMIN_KEY = process.env.ADMIN_KEY || "zaiwen-admin";
const MIN_BALANCE = parseInt(process.env.MIN_BALANCE || "100", 10);

// Token 持久化文件
const TOKENS_FILE = path.resolve("tokens_data.json");

// ==================== Token 持久化 ====================
function loadTokens() {
  // 优先从持久化文件加载
  try {
    if (fs.existsSync(TOKENS_FILE)) {
      const saved = JSON.parse(fs.readFileSync(TOKENS_FILE, "utf-8"));
      if (Array.isArray(saved) && saved.length > 0) {
        console.log(`[持久化] 从 tokens_data.json 加载了 ${saved.length} 个 token`);
        return saved;
      }
    }
  } catch (e) {
    console.warn("[持久化] 读取失败，回退到环境变量:", e.message);
  }
  // 回退到环境变量
  const str = process.env.TOKENS || "";
  return str.split(",").map((t) => t.trim()).filter(Boolean);
}

function saveTokens() {
  const list = client.tokens;
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(list, null, 2), "utf-8");
}

let tokens = loadTokens();

if (tokens.length === 0) {
  console.error("[错误] 未配置 TOKENS 环境变量");
  console.error("  示例: TOKENS=token1,token2 node server.mjs");
  process.exit(1);
}

const client = new ZaiwenClient({ tokens, minBalance: MIN_BALANCE });

// ==================== 工具 ====================
function json(res, code, data) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(JSON.stringify(data, null, 2));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });
}

// ==================== 路由 ====================

/** 活跃的多轮会话缓存: sessionId -> ChatSession */
const sessions = new Map();

const ROUTES = {
  "GET /v1/health": async (req, res) => {
    json(res, 200, { status: "ok", uptime: process.uptime(), tokens: tokens.length });
  },

  "GET /v1/tokens": async (req, res) => {
    const info = client.tokenInfoList;
    const balances = await client.checkAllBalances().catch(() => []);
    json(res, 200, { count: tokens.length, tokens: info, balances });
  },

  "POST /v1/chat": async (req, res) => {
    const body = await readBody(req);
    const { message, model, online, token } = body;

    if (!message || !message.trim()) {
      return json(res, 400, { error: "message 不能为空" });
    }

    try {
      const result = await client.chat(message, {
        model: model || "zaiwen-auto",
        online: !!online,
        token,
      });
      json(res, 200, {
        reply: result.reply,
        model: result.model,
        conversationId: result.conversationId,
        token: result.token?.slice(-16),
      });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  },

  "POST /v1/chat/session": async (req, res) => {
    const body = await readBody(req);
    const { message, sessionId, model, online, token } = body;

    if (!message || !message.trim()) {
      return json(res, 400, { error: "message 不能为空" });
    }

    try {
      // 获取或创建会话
      let session;
      const sid = sessionId || "default";
      if (sessions.has(sid)) {
        session = sessions.get(sid);
      } else {
        session = client.createSession(model || "zaiwen-auto");
        sessions.set(sid, session);
      }

      const result = await session.send(message, {
        model: model || session.model,
        online: !!online,
        token,
      });

      json(res, 200, {
        reply: result.reply,
        model: result.model,
        sessionId: sid,
        round: session.round,
        conversationId: result.conversationId,
        token: result.token?.slice(-16),
        history: session.history,
      });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  },

  "DELETE /v1/chat/session": async (req, res) => {
    const body = await readBody(req);
    const sid = body.sessionId || "default";
    const deleted = sessions.delete(sid);
    json(res, 200, { deleted, sessionId: sid });
  },

  // ==================== 管理接口 ====================
  "POST /v1/admin/tokens": async (req, res) => {
    const body = await readBody(req);
    if (body.adminKey !== ADMIN_KEY) {
      return json(res, 403, { error: "adminKey 不正确" });
    }
    if (!body.token || !body.token.trim()) {
      return json(res, 400, { error: "token 不能为空" });
    }
    const t = body.token.trim();
    client.addToken(t);
    saveTokens();
    json(res, 200, {
      ok: true,
      message: "Token 已添加",
      count: client.tokens.length,
      added: t.slice(0, 20) + "..." + t.slice(-10),
    });
  },

  "DELETE /v1/admin/tokens": async (req, res) => {
    const body = await readBody(req);
    if (body.adminKey !== ADMIN_KEY) {
      return json(res, 403, { error: "adminKey 不正确" });
    }
    if (!body.token) {
      return json(res, 400, { error: "请提供要删除的 token（完整值或前缀）" });
    }
    // 支持前缀匹配删除
    const target = body.token.trim();
    const allTokens = client.tokens;
    let found = allTokens.find((t) => t === target);
    if (!found) {
      found = allTokens.find((t) => t.startsWith(target));
    }
    if (!found) {
      return json(res, 404, { error: "未找到匹配的 token", hint: "请提供完整 token 或更长前缀" });
    }
    client.removeToken(found);
    saveTokens();
    json(res, 200, {
      ok: true,
      message: "Token 已删除",
      count: client.tokens.length,
      removed: found.slice(0, 20) + "..." + found.slice(-10),
    });
  },
};

// ==================== HTTP Server ====================
const server = http.createServer(async (req, res) => {
  // CORS 预检
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    });
    return res.end();
  }

  const path = req.url?.split("?")[0] || "/";
  const key = `${req.method} ${path}`;

  console.log(`${new Date().toISOString().slice(11, 19)} ${req.method} ${path}`);

  if (ROUTES[key]) {
    try {
      await ROUTES[key](req, res);
    } catch (e) {
      console.error(`[${key}] 错误:`, e.message);
      json(res, 500, { error: e.message });
    }
  } else {
    json(res, 404, {
      error: "Not Found",
      available: Object.keys(ROUTES),
    });
  }
});

server.listen(PORT, () => {
  console.log("=" .repeat(52));
  console.log("  在问AI API 服务已启动");
  console.log("=" .repeat(52));
  console.log(`  端口:     ${PORT}`);
  console.log(`  Token数:  ${tokens.length}`);
  console.log(`  最低余额: ${MIN_BALANCE}`);
  console.log(`  管理密钥: ${ADMIN_KEY === "zaiwen-admin" ? "⚠ 使用默认值,建议在.env中修改ADMIN_KEY" : "✓ 已自定义"}`);
  console.log(`  接口:`);
  console.log(`    POST /v1/chat            单轮对话`);
  console.log(`    POST /v1/chat/session    多轮对话`);
  console.log(`    GET  /v1/tokens          Token状态`);
  console.log(`    GET  /v1/health           健康检查`);
  console.log(`    POST /v1/admin/tokens     添加Token`);
  console.log(`    DELETE /v1/admin/tokens  删除Token`);
  console.log("=" .repeat(52));
});
