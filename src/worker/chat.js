import { error, json, readJson, requireCsrf, requireSession } from './auth.js';

const ROOM_ID = 'jasonmail-private-room';

function getRoom(env) {
  return env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(ROOM_ID));
}

async function control(env, path, data = {}) {
  const response = await getRoom(env).fetch(`https://jasonmail.internal/control/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
  });
  return response.json();
}

async function getChatStatus(request, env) {
  const room = await getRoom(env).fetch('https://jasonmail.internal/control/status');
  const status = await room.json();
  if (request) {
    const domain = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('email_domain').first();
    status.emailDomain = domain?.value || new URL(request.url).hostname;
  }
  return json(status);
}

export async function adminChat(request, env, action) {
  if (action === 'status') {
    const session = await requireSession(request, env);
    if (session.response) return session.response;
    return getChatStatus(request, env);
  }
  const auth = await requireCsrf(request, env);
  if (auth.response) return auth.response;
  const input = await readJson(request) || {};
  if (action === 'enable') {
    await control(env, 'disable');
    await env.DB.prepare('UPDATE chat_settings SET enabled = 1, updated_at = ? WHERE id = 1').bind(Date.now()).run();
    return json(await control(env, 'enable'));
  }
  if (action === 'disable') {
    const result = await control(env, 'disable');
    return json(result);
  }
  if (action === 'rotate') return json(await control(env, 'rotate'));
  if (action === 'settings') {
    const allowFiles = Boolean(input.allowFiles);
    const allowExtensions = [...new Set(String(input.allowExtensions || '').split(/[\s,;]+/u).map((s) => s.toLowerCase().replace(/^\./u, '').trim()).filter((s) => /^[a-z0-9]{1,12}$/u.test(s)))].slice(0, 100).join(',');
    const denyExtensions = [...new Set(String(input.denyExtensions || '').split(/[\s,;]+/u).map((s) => s.toLowerCase().replace(/^\./u, '').trim()).filter((s) => /^[a-z0-9]{1,12}$/u.test(s)))].slice(0, 100).join(',');
    const maxFileBytes = Math.max(1, Math.min(10 * 1024 * 1024, Number(input.maxFileBytes) || 10 * 1024 * 1024));
    const messageIntervalMs = Math.max(500, Math.min(60_000, Number(input.messageIntervalMs) || 1000));
    await env.DB.prepare(`UPDATE chat_settings SET allow_files = ?, allow_extensions = ?, deny_extensions = ?, max_file_bytes = ?, message_interval_ms = ?, updated_at = ? WHERE id = 1`)
      .bind(Number(allowFiles), allowExtensions, denyExtensions, maxFileBytes, messageIntervalMs, Date.now()).run();
    const settings = { allowFiles, allowExtensions, denyExtensions, maxFileBytes, messageIntervalMs };
    return json(await control(env, 'settings', settings));
  }
  return error('未知的聊天室操作。', 404);
}

export async function connectChat(request, env) {
  return getRoom(env).fetch(request);
}

export async function chatFile(request, env, id = null) {
  return getRoom(env).fetch(new Request(`https://jasonmail.internal/file/${id || 'upload'}${new URL(request.url).search}`, request));
}

