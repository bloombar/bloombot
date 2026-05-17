module.exports = {
  apps: [
    {
      name: "bloombot",
      script: "response_bot.py",
      interpreter: "python3",
      // Env vars are loaded from .env by python-dotenv — no secrets needed here.
      // Override LOG_LEVEL or LOGS_DIR here if needed, e.g.:
      // env: { LOG_LEVEL: "INFO", LOGS_DIR: "./logs" },
      error_file: "./logs/pm2-error.log",
      out_file: "./logs/pm2-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};
