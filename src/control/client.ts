import { request } from 'node:http';

import { readJson } from '../store/fsutil.js';
import { daemonInfoPath } from '../store/paths.js';

export interface DaemonInfo {
  pid: number;
  port: number;
  controlToken: string;
}

export async function readDaemonInfo(stateDir?: string): Promise<DaemonInfo | null> {
  const info = await readJson<DaemonInfo>(daemonInfoPath(stateDir));
  if (!info || typeof info.port !== 'number' || typeof info.controlToken !== 'string') return null;
  return info;
}

export class ControlError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ControlError';
  }
}

/** Issue a control-plane request to the daemon. */
export function controlRequest<T>(
  info: DaemonInfo,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        host: '127.0.0.1',
        port: info.port,
        method,
        path,
        headers: {
          'x-dp-control-token': info.controlToken,
          ...(payload !== undefined
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : {}),
        },
        timeout: 15_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = null;
          try {
            parsed = text === '' ? null : JSON.parse(text);
          } catch {
            // fall through with null
          }
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            resolve(parsed as T);
          } else {
            const message =
              parsed !== null && typeof parsed === 'object' && 'error' in parsed
                ? String((parsed as { error: unknown }).error)
                : `daemon returned ${status}`;
            reject(new ControlError(message, status));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('daemon request timed out')));
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export async function isDaemonHealthy(info: DaemonInfo): Promise<boolean> {
  try {
    const result = await controlRequest<{ ok: boolean; pid: number }>(
      info,
      'GET',
      '/control/health',
    );
    return result.ok === true;
  } catch {
    return false;
  }
}
