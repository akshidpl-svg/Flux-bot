/**
 * PM2 alternative to systemd.
 *
 *   pm2 start ecosystem.config.cjs
 *   pm2 save && pm2 startup systemd
 *
 * Keep exactly ONE instance: SQLite is a single-writer database. Running two
 * bot processes would duplicate gateway connections.
 */
module.exports = {
  apps: [
    {
      name: 'fluxtip',
      cwd: '/opt/fluxtip',
      script: 'dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 20,
      min_uptime: '30s',
      restart_delay: 5000,
      kill_timeout: 30000,
      max_memory_restart: '512M',
      time: true,
      merge_logs: true,
      out_file: '/var/log/fluxtip/out.log',
      error_file: '/var/log/fluxtip/error.log',
      env: {
        NODE_ENV: 'production',
        // All secrets come from /etc/fluxtip/fluxtip.env via the launch wrapper
        // below, not from this file.
      },
    },
  ],
};
