import type { Env } from '../types';
import { jsonError } from '../http-security';
import { previewOrigin } from './security';
import { readBoundedText } from './body';

/** 只有主站的认证 API 能创建或撤销转发；预览站没有 SSH 控制接口。 */
export async function forwardingRoute(request: Request, env: Env, accountId: string): Promise<Response> {
  if (request.method !== 'POST' && request.method !== 'DELETE') return jsonError('Method not allowed', 405);
  const url = new URL(request.url);
  const session = url.searchParams.get('session');
  if (!session || !/^[a-f0-9]{64}$/.test(session)) return jsonError('Invalid session identifier', 400);
  let origin: string;
  try {
    origin = previewOrigin(env.PREVIEW_ORIGIN, url.origin);
    if (env.APP_ORIGIN) previewOrigin(origin, env.APP_ORIGIN);
  }
  catch (error) { return jsonError((error as Error).message, 503); }
  const headers = new Headers({
    'x-account-id': accountId, 'x-preview-origin': origin, 'Content-Type': 'application/json',
  });
  let body: string | undefined;
  if (request.method === 'POST') {
    if (!request.headers.get('Content-Type')?.startsWith('application/json')) return jsonError('Expected application/json', 415);
    let text: string;
    try { text = await readBoundedText(request, 1024); }
    catch { return jsonError('Request body is too large', 413); }
    let input: { port?: unknown };
    try { input = JSON.parse(text); } catch { return jsonError('Invalid JSON body', 400); }
    if (!input || !Number.isInteger(input.port) || Number(input.port) < 1 || Number(input.port) > 65535) {
      return jsonError('端口必须是 1–65535 的整数。', 400);
    }
    body = JSON.stringify({ port: input.port });
  }
  return env.SSH_SESSIONS.get(env.SSH_SESSIONS.idFromString(session)).fetch(new Request('https://session.internal/forward', {
    method: request.method, headers, body,
  }));
}
