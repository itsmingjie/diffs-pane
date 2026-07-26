import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { isDaemonHealthy, readDaemonInfo, type DaemonInfo } from '../control/client.js';

const DAEMON_ENTRY = fileURLToPath(new URL('../daemon/main.js', import.meta.url));
const START_TIMEOUT_MS = 15_000;

/** Return a healthy daemon, starting the per-user singleton if needed. */
export async function ensureDaemon(): Promise<DaemonInfo> {
  const existing = await healthyDaemon();
  if (existing) return existing;

  if (!existsSync(DAEMON_ENTRY)) {
    throw new Error(`daemon entry not built: ${DAEMON_ENTRY} (run \`pnpm run build\`)`);
  }
  const child = spawn(process.execPath, [DAEMON_ENTRY], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(100);
    const info = await healthyDaemon();
    if (info) return info;
  }
  throw new Error('timed out waiting for the diffs-pane daemon to start');
}

/** The running daemon, or null when none is healthy. */
export async function healthyDaemon(): Promise<DaemonInfo | null> {
  const info = await readDaemonInfo();
  if (info && (await isDaemonHealthy(info))) return info;
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
