import { spawn } from 'node:child_process';

/**
 * One process for the whole product: the site and the scheduler together.
 *
 * They were two pm2 entries, which kept a rebuild of the site from interrupting
 * a running job. One entry is simpler to reason about and to restart, and the
 * safety that bought is already provided elsewhere: every job takes a database
 * lock and is idempotent, so a restart mid-run leaves nothing half-done — the
 * next tick simply picks it up.
 *
 * The web server is a child process because `next start` owns its own runtime;
 * the scheduler runs here, in this process. If either stops, both stop, so pm2
 * sees one thing to supervise rather than a half-alive pair.
 */

const web = spawn('npm', ['run', 'start'], {
  stdio: 'inherit',
  env: { ...process.env, PORT: process.env.PORT ?? '6247' },
});

web.on('exit', (code, signal) => {
  console.log(`[serve] web server exited (code=${code} signal=${signal}), stopping`);
  process.exit(code ?? 1);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    web.kill(signal);
  });
}

// Started after the web server so a failure to bind the port surfaces first.
await import('./scheduler');
