/**
 * pm2 process definitions for the month-long local test.
 *
 *   pm2 start ecosystem.config.cjs      start both
 *   pm2 logs envora-scheduler           follow the job log
 *   pm2 restart envora-web              after a rebuild
 *   pm2 save                            survive a reboot
 *
 * Two processes, deliberately: the web app serves from the database and never
 * calls a provider, while the scheduler owns every metered call. Restarting the
 * site therefore cannot cost quota or interrupt a running job.
 */
module.exports = {
  apps: [
    {
      name: 'envora-web',
      cwd: __dirname,
      script: 'npm',
      args: 'run start',
      env: { NODE_ENV: 'production', PORT: '6247' },
      exec_mode: 'fork',
      interpreter: 'none',
      autorestart: true,
      max_restarts: 10,
      // The server holds .next open; a rebuild needs a restart, not a reload.
      watch: false,
      max_memory_restart: '800M',
      time: true,
    },
    {
      name: 'envora-scheduler',
      cwd: __dirname,
      script: 'npx',
      args: 'tsx scripts/scheduler.ts',
      env: { NODE_ENV: 'production' },
      // Only ever one, and forked rather than clustered: every job is
      // idempotent and locked, but a second copy would still burn the daily
      // provider allowance twice as fast.
      exec_mode: 'fork',
      interpreter: 'none',
      instances: 1,
      max_restarts: 10,
      // A crash loop against a rate-limited provider must not hammer it.
      restart_delay: 30_000,
      watch: false,
      max_memory_restart: '600M',
      time: true,
    },
  ],
};
