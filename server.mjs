/**
 * 在问AI API 服务
 * ================
 * 零外部依赖，纯 Node.js 内置模块
 *
 * 启动: node server.mjs
 * 环境变量:
 *   PORT=3456          服务端口 (默认3456)
 *   TOKENS=token1,token2  多个token逗号分隔
 *   MIN_BALANCE=100     最低余额阈值
 *
 * 接口:
 *   POST /v1/chat              单轮对话
 *   POST /v1/chat/session      多轮对话 (自动管理上下文)
 *   GET  /v1/tokens            查看token池状态
 *   GET  /v1/health            健康检查
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
const TOKENS_STR = process.env.TOKENS || "";
const MIN_BALANCE = parseInt(process.env.MIN_BALANCE || "100", 10);

const tokens = TOKENS_STR.split(",").map((t) => t.trim()).filter(Boolean);

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
  console.log(`  接口:`);
  console.log(`    POST /v1/chat           单轮对话`);
  console.log(`    POST /v1/chat/session   多轮对话`);
  console.log(`    GET  /v1/tokens          Token状态`);
  console.log(`    GET  /v1/health          健康检查`);
  console.log("=" .repeat(52));
});
