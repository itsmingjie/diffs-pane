import { randomBytes } from 'node:crypto';

import { isDaemonHealthy, readDaemonInfo } from '../control/client.js';
import { writeJsonAtomic } from '../store/fsutil.js';
import { daemonInfoPath, stateDir } from '../store/paths.js';
import { startServer } from './server.js';
import { SessionManager } from './sessions.js';

const SHUTDOWN_GRACE_MS = 750;
const PING_INTERVAL_MS = 25_000;
const DEFAULT_PORT = 34_337;

/** Per-user singleton daemon serving all working trees over loopback HTTP. */
async function main(): Promise<void> {
  const dir = stateDir();

  // Singleton guard: refuse to start when a healthy daemon already exists.
  const existing = await readDaemonInfo(dir);
  if (existing && existing.pid !== process.pid && (await isDaemonHealthy(existing))) {
    process.exit(3);
  }

  let shuttingDown = false;
  const shutdown = (code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      clearInterval(pingTimer);
      try {
        await manager.stopAll();
      } finally {
        daemon.server.close(() => process.exit(code));
        setTimeout(() => process.exit(code), SHUTDOWN_GRACE_MS).unref();
      }
    })();
  };

  const manager = new SessionManager(dir, () => {
    // The daemon exits when no sessions remain. A short delay lets the final
    // control response flush before the process goes away.
    setTimeout(() => {
      if (manager.list().length === 0) shutdown(0);
    }, SHUTDOWN_GRACE_MS);
  });

  await manager.restore();

  const controlToken = randomBytes(24).toString('base64url');
  const daemon = await startServer({
    controlToken,
    manager,
    preferredPort: DEFAULT_PORT,
  });

  writeJsonAtomic(daemonInfoPath(dir), {
    pid: process.pid,
    port: daemon.port,
    controlToken,
  });

  const pingTimer = setInterval(() => manager.pingAll(), PING_INTERVAL_MS);

  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
  // If everything restored to nothing, still exit once idle.
  if (manager.list().length === 0) {
    setTimeout(() => {
      if (manager.list().length === 0) shutdown(0);
    }, 30_000).unref();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
