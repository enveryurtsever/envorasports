/**
 * pm2 process definition for the month-long local test.
 *
 *   pm2 start ecosystem.config.cjs      start it
 *   pm2 logs envora                     follow site and job output together
 *   pm2 restart envora                  after a rebuild
 *   pm2 save                            survive a reboot
 *
 * One entry: scripts/serve.ts runs the site and the scheduler together. Every
 * job takes a database lock and is idempotent, so a restart mid-run leaves
 * nothing half-done and the next tick picks it up.
 */
module.exports = {
  apps: [
    {
      name: 'envora',
      cwd: __dirname,
      script: 'npx',
      args: 'tsx scripts/serve.ts',
      env: { NODE_ENV: 'production', PORT: '6247' },
      exec_mode: 'fork',
      interpreter: 'none',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      // A crash loop against a rate-limited provider must not hammer it.
      restart_delay: 30_000,
      watch: false,
      max_memory_restart: '1G',
      time: true,
    },
  ],
};
