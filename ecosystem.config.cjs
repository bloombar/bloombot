// OPS-8 — every process the platform actually runs, supervised so each
// restarts independently: the legacy Python bot (until D-1 retires it),
// the four Node processes PLAT-4 names (API, bot, worker, MCP server), and
// the alerting monitor OPS-12 adds. Never clustered (PLAT-4's own text) —
// pm2's `instances`/`exec_mode` are left at their defaults (one instance,
// fork mode) throughout.
//
// `scripts/deploy.sh` reloads each of these by name individually
// (`pm2 reload <name>`) rather than restarting the whole file at once, so a
// bad deploy of one process does not bounce the other three, and bootstraps
// a fresh droplet with `pm2 start ecosystem.config.cjs --only <name>` —
// never a bare `pm2 start ecosystem.config.cjs`, which would start every
// app here at once on a droplet where some might not be ready yet.
//
// Every Node process here loads `.env` itself (`loadDotEnv()`, CFG-5) the
// same way the Python app already does through `python-dotenv` — no
// `env:` block below carries a secret, and none needs to: pm2's own `cwd`
// is left at its default (wherever `pm2 start`/`reload` is invoked from,
// i.e. `$APP_DIR`, matching `scripts/deploy.sh`), which is also the
// directory every relative path in `.env` (`DATABASE_PATH`, `LOGS_DIR`,
// `ATTACHMENT_STORAGE_DIR`) is resolved against — setting `cwd` to each
// app's own directory here would silently point every one of those at the
// wrong place (`apps/api/data/data.db` instead of the real database).
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
    {
      name: "api",
      // `apps/api/package.json`'s own `start` script, run directly rather
      // than through `npm start` — one fewer process pm2 has to supervise
      // and restart per app.
      script: "apps/api/dist/index.js",
      error_file: "./logs/pm2-api-error.log",
      out_file: "./logs/pm2-api-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
    {
      name: "bot",
      // PLAT-3/PLAT-4 — the only process holding a Discord gateway
      // connection; single-instance is structural here, not merely the
      // default this file otherwise never overrides.
      script: "apps/bot/dist/index.js",
      error_file: "./logs/pm2-bot-error.log",
      out_file: "./logs/pm2-bot-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
    {
      name: "worker",
      script: "apps/worker/dist/index.js",
      error_file: "./logs/pm2-worker-error.log",
      out_file: "./logs/pm2-worker-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
    {
      name: "mcp",
      script: "apps/mcp/dist/index.js",
      error_file: "./logs/pm2-mcp-error.log",
      out_file: "./logs/pm2-mcp-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
    {
      name: "ops-monitor",
      // OPS-12 — polls the four processes above's own /health endpoints and
      // notifies on a transition (`scripts/ops-monitor.mjs`'s own module
      // comment has the full reasoning). Supervised the same as everything
      // else here: if the watcher itself dies, pm2 restarts it rather than
      // an outage going unnoticed because the thing that notices crashed
      // silently.
      script: "scripts/ops-monitor.mjs",
      error_file: "./logs/pm2-ops-monitor-error.log",
      out_file: "./logs/pm2-ops-monitor-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};
