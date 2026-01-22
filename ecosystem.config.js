module.exports = {
  apps: [
    {
      name: 'mail-sync',
      script: 'main.py',
      interpreter: '/Users/chenyuanquan/Documents/MailAgent/venv/bin/python3',
      cwd: '/Users/chenyuanquan/Documents/MailAgent',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      env: {
        PYTHONUNBUFFERED: '1'
      },
      error_file: 'logs/pm2-mail-error.log',
      out_file: 'logs/pm2-mail-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss'
    },
    {
      name: 'calendar-sync',
      script: 'calendar_main.py',
      interpreter: '/Users/chenyuanquan/Documents/MailAgent/venv/bin/python3',
      cwd: '/Users/chenyuanquan/Documents/MailAgent',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      env: {
        PYTHONUNBUFFERED: '1'
      },
      error_file: 'logs/pm2-calendar-error.log',
      out_file: 'logs/pm2-calendar-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss'
    }
  ]
};
