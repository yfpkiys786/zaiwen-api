#!/bin/bash
# ===========================================
# 在问AI API 一键部署
# 用法: bash deploy.sh
# ===========================================
set -e
APP="zaiwen-api"

echo "=================================="
echo "  在问AI API 部署"
echo "=================================="

# 检查 Node
command -v node &>/dev/null || { echo "[错误] 未安装 Node.js"; exit 1; }
echo "[✓] Node $(node -v)"

# 检查 PM2
command -v pm2 &>/dev/null || { echo "[!] 安装 PM2..."; npm i -g pm2; }
echo "[✓] PM2 $(pm2 -v)"

# 检查 .env
if [ ! -f .env ]; then
  echo ""
  echo "=================================="
  echo "  首次部署：请先创建 .env 文件"
  echo "=================================="
  echo ""
  echo "  第1步: cp .env.example .env"
  echo "  第2步: vim .env  # 填入 TOKENS, REDIS_URL, ADMIN_KEY"
  echo ""
  exit 1
fi
echo "[✓] .env 已配置"

# 读取端口
PORT=$(grep -oP '^PORT=\K\d+' .env 2>/dev/null || echo "3456")
echo "[✓] 端口: $PORT"

# 检测端口冲突
if ss -tlnp 2>/dev/null | grep -q ":$PORT "; then
  echo "[警告] 端口 $PORT 已被占用！请修改 .env 中的 PORT"
  exit 1
fi

# 创建日志目录
mkdir -p logs

# 启动/重启
if pm2 list 2>/dev/null | grep -q "$APP"; then
  echo "[>] 重启服务..."
  pm2 restart "$APP"
else
  echo "[>] 首次启动..."
  pm2 start ecosystem.config.cjs
fi

pm2 save

echo ""
echo "=================================="
echo "  部署完成"
echo "=================================="
echo "  测试: curl -X POST http://localhost:$PORT/v1/chat -H 'Content-Type: application/json' -d '{\"message\":\"你好\"}'"
echo "  日志: pm2 logs $APP"
echo "=================================="
