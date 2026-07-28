// PM2 配置 - 生产环境
// 启动: pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: "zaiwen-api",
      script: "server.mjs",
      // 端口和 TOKENS 在 .env 文件中配置，PM2 会自动加载
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "256M",
      log_date_format: "MM-DD HH:mm:ss",
      error_file: "./logs/error.log",
      out_file: "./logs/out.log",
      merge_logs: true,
    },
  ],
};
