import type { IncomingMessage } from 'node:http';

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

export const MAX_BODY_BYTES = 1024 * 1024;

/** Reject non-loopback peers and unexpected Host headers. */
export function checkTransport(req: IncomingMessage, port: number): string | null {
  const remote = req.socket.remoteAddress ?? '';
  if (!LOOPBACK_ADDRESSES.has(remote)) return 'non-loopback client rejected';

  const host = req.headers.host;
  if (!host) return 'missing Host header';
  const { hostname, portPart } = splitHost(host);
  if (!ALLOWED_HOSTNAMES.has(hostname)) return `unexpected host: ${hostname}`;
  if (portPart !== null && portPart !== String(port)) return `unexpected port: ${portPart}`;
  return null;
}

/** Reject cross-origin mutations. Same-origin browser requests pass. */
export function checkMutationOrigin(req: IncomingMessage, port: number): string | null {
  const origin = req.headers.origin;
  if (origin === undefined || origin === 'null')
    return origin === 'null' ? 'opaque origin rejected' : null;
  try {
    const url = new URL(origin);
    const hostname = url.hostname === '::1' ? '[::1]' : url.hostname;
    if (url.protocol !== 'http:' || !ALLOWED_HOSTNAMES.has(hostname) || url.port !== String(port)) {
      return `cross-origin request rejected: ${origin}`;
    }
    return null;
  } catch {
    return `malformed Origin: ${origin}`;
  }
}

function splitHost(host: string): { hostname: string; portPart: string | null } {
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    const hostname = host.slice(0, end + 1);
    const rest = host.slice(end + 1);
    return { hostname, portPart: rest.startsWith(':') ? rest.slice(1) : null };
  }
  const idx = host.lastIndexOf(':');
  if (idx < 0) return { hostname: host, portPart: null };
  return { hostname: host.slice(0, idx), portPart: host.slice(idx + 1) };
}

/** Read a request body with a hard size cap. */
export function readBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
