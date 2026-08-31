module.exports = {
  apps: [
    {
      name: "bloombot",
      // Run through pipenv, matching how the bot is actually started in
      // production. `interpreter: "python3"` would use the system python, which
      // has none of the project's dependencies installed — the bot would crash
      // on start. `interpreter: "none"` stops pm2 wrapping this in node.
      script: "pipenv",
      args: "run ./response_bot.py",
      interpreter: "none",
      // Env vars are loaded from .env by python-dotenv — no secrets needed here.
      // Override LOG_LEVEL or LOGS_DIR here if needed, e.g.:
      // env: { LOG_LEVEL: "INFO", LOGS_DIR: "./logs" },
      error_file: "./logs/pm2-error.log",
      out_file: "./logs/pm2-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};
