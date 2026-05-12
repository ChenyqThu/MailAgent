module.exports = {
  apps: [
    {
      name: "mail-web",
      script: "./venv/bin/uvicorn",
      args: "web.api.main:app --host 0.0.0.0 --port 8200",
      cwd: "/Users/kevin/Work/Code/MailAgent",
      interpreter: "none",
      env: {
        PATH: "./venv/bin:" + process.env.PATH,
      },
      max_memory_restart: "256M",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "logs/web-api-error.log",
      out_file: "logs/web-api-out.log",
    },
  ],
};
