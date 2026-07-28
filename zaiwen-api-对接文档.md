# 在问AI API 对接文档

> 服务地址：`https://zaiwen-api.onrender.com`
> 更新时间：2026-07-28

---

## 接口总览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/health` | 健康检查 |
| GET | `/v1/tokens` | Token池状态与余额 |
| POST | `/v1/chat` | 单轮对话 |
| POST | `/v1/chat/session` | 多轮对话 |
| DELETE | `/v1/chat/session` | 删除会话 |
| POST | `/v1/admin/tokens` | 添加Token |
| DELETE | `/v1/admin/tokens` | 删除Token |

---

## 1. 健康检查

```bash
curl https://zaiwen-api.onrender.com/v1/health
```

**返回：**
```json
{
  "status": "ok",
  "uptime": 875.287,
  "tokens": 1,
  "redis": true
}
```

---

## 2. Token池状态

```bash
curl https://zaiwen-api.onrender.com/v1/tokens
```

**返回：**
```json
{
  "count": 1,
  "tokens": [
    {
      "token": "6a684fe1...e5e632dcc9",
      "balance": 68762147.4,
      "vip": "普通用户",
      "disabled": false,
      "lastCheck": "2026-07-28T10:03:50.165Z"
    }
  ],
  "balances": [
    {
      "balance": 68762147.4,
      "vip": "普通用户",
      "ok": true,
      "token": "6a684fe1..."
    }
  ]
}
```

---

## 3. 单轮对话

```bash
curl -X POST https://zaiwen-api.onrender.com/v1/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "用一句话介绍无花果干",
    "model": "zaiwen-auto"
  }'
```

**参数说明：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `message` | string | 是 | 用户消息 |
| `model` | string | 否 | 模型名，默认 `zaiwen-auto` |
| `online` | boolean | 否 | 是否联网，默认 `false` |
| `token` | string | 否 | 指定Token，不传自动轮询 |

**返回：**
```json
{
  "reply": "无花果干是将新鲜无花果脱水制成的干果...",
  "model": "zaiwen-auto",
  "conversationId": "...",
  "token": "e5e632dcc9"
}
```

---

## 4. 多轮对话

**首次对话（不传 sessionId）：**

```bash
curl -X POST https://zaiwen-api.onrender.com/v1/chat/session \
  -H "Content-Type: application/json" \
  -d '{
    "message": "帮我写一条无花果干的朋友圈推荐文案",
    "model": "zaiwen-auto"
  }'
```

**续接对话（传入 sessionId）：**

```bash
curl -X POST https://zaiwen-api.onrender.com/v1/chat/session \
  -H "Content-Type: application/json" \
  -d '{
    "message": "把文案改得更活泼一些",
    "sessionId": "my-session-001",
    "model": "zaiwen-auto"
  }'
```

**参数说明：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `message` | string | 是 | 用户消息 |
| `sessionId` | string | 否 | 会话标识，首次不传则使用 `default` |
| `model` | string | 否 | 模型名，默认 `zaiwen-auto` |
| `online` | boolean | 否 | 是否联网 |
| `token` | string | 否 | 指定Token |

**返回：**
```json
{
  "reply": "今天新买了一箱无花果干，真的太香了！...",
  "model": "zaiwen-auto",
  "sessionId": "my-session-001",
  "round": 2,
  "conversationId": "...",
  "token": "e5e632dcc9",
  "history": [...]
}
```

> **建议：** 传入自定义 `sessionId`，避免与其他人共用 `default` 导致上下文污染。

---

## 5. 删除会话

```bash
curl -X DELETE https://zaiwen-api.onrender.com/v1/chat/session \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "my-session-001"}'
```

**返回：**
```json
{
  "deleted": true,
  "sessionId": "my-session-001"
}
```

---

## 6. 添加Token

```bash
curl -X POST https://zaiwen-api.onrender.com/v1/admin/tokens \
  -H "Content-Type: application/json" \
  -d '{
    "token": "your-new-token-value",
    "adminKey": "wg266288"
  }'
```

**返回：**
```json
{
  "ok": true,
  "message": "Token 已添加",
  "count": 2,
  "added": "your-new-token-va...ken-value"
}
```

**错误（adminKey 不对）：**
```json
{ "error": "adminKey 不正确" }
```

---

## 7. 删除Token

支持完整值或前缀匹配：

```bash
curl -X DELETE https://zaiwen-api.onrender.com/v1/admin/tokens \
  -H "Content-Type: application/json" \
  -d '{
    "token": "6a684fe1c158d97f",
    "adminKey": "wg266288"
  }'
```

**返回：**
```json
{
  "ok": true,
  "message": "Token 已删除",
  "count": 1,
  "removed": "6a684fe1c158d97f2b0e...e5e632dcc9"
}
```

**错误（未找到匹配token）：**
```json
{ "error": "未找到匹配的 token", "hint": "请提供完整 token 或更长前缀" }
```

---

## 通用说明

- **Content-Type**：全部 JSON 接口需带 `Content-Type: application/json`
- **CORS**：所有接口已开放跨域（`Access-Control-Allow-Origin: *`）
- **超时建议**：对话类接口 60s，查询类接口 15s
- **错误格式**：统一返回 `{ "error": "描述" }`
