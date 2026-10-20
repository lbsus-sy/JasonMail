import { readBoundedBytes } from '../bounded-body.js';

const encoder = new TextEncoder();
const BLOCKED_EXTENSIONS = new Set(['exe', 'com', 'bat', 'cmd', 'msi', 'js', 'vbs', 'ps1', 'sh', 'jar', 'scr', 'dll', 'app', 'apk']);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

function randomCode() {
  const value = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return String(value).padStart(6, '0');
}

function safeName(value) {
  return String(value || 'file').replace(/[\\/\u0000-\u001f\u007f]/gu, '_').slice(0, 180) || 'file';
}

function ext(name) {
  const match = name.toLowerCase().match(/\.([a-z0-9]{1,12})$/u);
  return match?.[1] || '';
}

export class ChatRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async state() {
    const enabled = Boolean(await this.ctx.storage.get('enabled'));
    const code = await this.ctx.storage.get('code') || '';
    const expiresAt = await this.ctx.storage.get('expiresAt') || null;
    const settings = await this.ctx.storage.get('settings') || { allowFiles: false, allowExtensions: '', denyExtensions: '', maxFileBytes: 10 * 1024 * 1024, messageIntervalMs: 1000 };
    return { enabled, code, expiresAt, settings };
  }

  async currentState() {
    const current = await this.state();
    if (!current.enabled || (Number(current.expiresAt) > Date.now())) return current;
    const code = randomCode();
    const expiresAt = Date.now() + 60_000;
    await this.ctx.storage.put({ code, expiresAt });
    await this.ctx.storage.setAlarm(expiresAt);
    return { ...current, code, expiresAt };
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/control/')) return this.control(request, url.pathname.slice('/control/'.length));
    if (url.pathname.startsWith('/file/')) return this.fileRequest(request, url.pathname.slice('/file/'.length));
    if (request.headers.get('Upgrade') === 'websocket') return this.join(request, url);
    return new Response('Not found', { status: 404 });
  }

  async control(request, action) {
    if (request.method === 'GET' || action === 'status') {
      const { enabled, code, expiresAt, settings } = await this.currentState();
      const options = await this.env.DB.prepare('SELECT allow_files, allow_extensions, deny_extensions, max_file_bytes, message_interval_ms FROM chat_settings WHERE id = 1').first();
      return json({
        enabled, code: enabled ? code : null, expiresAt,
        allowFiles: Boolean(options?.allow_files ?? settings.allowFiles),
        allowExtensions: options?.allow_extensions ?? settings.allowExtensions,
        denyExtensions: options?.deny_extensions ?? settings.denyExtensions,
        maxFileBytes: options?.max_file_bytes ?? settings.maxFileBytes,
        messageIntervalMs: options?.message_interval_ms ?? settings.messageIntervalMs,
      });
    }
    const input = await request.json().catch(() => ({}));
    if (action === 'settings') {
      await this.ctx.storage.put('settings', input);
      return json({ ok: true, ...(await this.state()) });
    }
    if (action === 'enable') {
      const code = randomCode();
      const expiresAt = Date.now() + 60_000;
      await this.ctx.storage.put({ enabled: true, code, expiresAt });
      await this.ctx.storage.setAlarm(expiresAt);
      return json({ ok: true, enabled: true, code, expiresAt });
    }
    if (action === 'rotate') {
      const current = await this.state();
      if (!current.enabled) return json({ error: '聊天室目前關閉。' }, 409);
      const code = randomCode();
      const expiresAt = Date.now() + 60_000;
      await this.ctx.storage.put({ code, expiresAt });
      await this.ctx.storage.setAlarm(expiresAt);
      return json({ ok: true, code, expiresAt });
    }
    if (action === 'disable') {
      await this.ctx.storage.put({ enabled: false, code: '', expiresAt: null });
      await this.ctx.storage.deleteAlarm();
      for (const socket of this.ctx.getWebSockets()) {
        try { socket.close(1001, '聊天室已關閉'); } catch { /* Socket is already closed. */ }
      }
      const files = await this.env.DB.prepare('SELECT storage_key FROM chat_files').all();
      for (const file of files.results) await this.env.FILES.delete(file.storage_key);
      let cursor;
      do {
        const page = await this.env.FILES.list({ prefix: 'chat/', cursor, limit: 1000 });
        for (const key of page.keys) await this.env.FILES.delete(key.name);
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      await this.env.DB.batch([
        this.env.DB.prepare('DELETE FROM chat_messages'),
        this.env.DB.prepare('DELETE FROM chat_files'),
      ]);
      return json({ ok: true, enabled: false, deleted: true });
    }
    return new Response('Not found', { status: 404 });
  }

  async failedJoin(ip) {
    const key = `failed:${ip}`;
    const current = await this.ctx.storage.get(key) || { count: 0, resetAt: 0 };
    if (current.resetAt < Date.now()) return { count: 0, resetAt: Date.now() + 10 * 60_000 };
    return current;
  }

  async join(request, url) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const attempts = await this.failedJoin(ip);
    if (attempts.count >= 10) return new Response('Too many code attempts. Please wait 10 minutes.', { status: 429 });
    const { enabled, code, expiresAt, settings } = await this.currentState();
    const requestedCode = url.searchParams.get('code') || '';
    if (!enabled || requestedCode !== code || !/^\d{6}$/u.test(requestedCode)) {
      attempts.count += 1;
      await this.ctx.storage.put(`failed:${ip}`, attempts);
      return new Response('聊天室未開啟，或驗證碼已更新。', { status: 403 });
    }
    await this.ctx.storage.delete(`failed:${ip}`);
    const displayName = (url.searchParams.get('name') || '訪客').replace(/[<>\u0000-\u001f]/gu, '').trim().slice(0, 32) || '訪客';
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const capability = crypto.randomUUID() + crypto.randomUUID();
    server.serializeAttachment({ capability, displayName, lastMessageAt: 0 });
    this.ctx.acceptWebSocket(server);
    const history = await this.env.DB.prepare(`SELECT m.id, m.display_name AS displayName, m.body, m.file_id AS fileId,
      m.created_at AS createdAt, f.filename, f.content_type AS contentType, f.size_bytes AS size
      FROM chat_messages m LEFT JOIN chat_files f ON f.id = m.file_id ORDER BY m.created_at DESC LIMIT 100`).all();
    server.send(JSON.stringify({ type: 'ready', capability, expiresAt, allowFiles: Boolean(settings.allowFiles), history: history.results.reverse() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, message) {
    if (typeof message !== 'string' || message.length > 10_000) return;
    const attachment = socket.deserializeAttachment() || {};
    const { enabled, settings } = await this.state();
    if (!enabled) return socket.close(1001, '聊天室已關閉');
    let input;
    try { input = JSON.parse(message); } catch { return; }
    if (input.type !== 'message') return;
    const body = String(input.body || '').trim();
    if (!body || body.length > 4000) return socket.send(JSON.stringify({ type: 'error', message: '訊息需為 1–4,000 個字元。' }));
    const now = Date.now();
    const minInterval = Math.max(500, Number(settings.messageIntervalMs) || 1000);
    if (now - Number(attachment.lastMessageAt || 0) < minInterval) return socket.send(JSON.stringify({ type: 'error', message: '請稍候再傳送下一則訊息。' }));
    attachment.lastMessageAt = now;
    socket.serializeAttachment(attachment);
    const item = { id: crypto.randomUUID(), displayName: attachment.displayName || '訪客', body, fileId: null, createdAt: now };
    await this.env.DB.prepare('INSERT INTO chat_messages (id, display_name, body, file_id, created_at) VALUES (?, ?, ?, NULL, ?)')
      .bind(item.id, item.displayName, item.body, item.createdAt).run();
    this.broadcast({ type: 'message', item });
  }

  webSocketClose(socket) {
    try { socket.close(); } catch { /* close callback can be invoked after closure */ }
  }

  webSocketError(socket) {
    try { socket.close(1011, 'Connection error'); } catch { /* already closed */ }
  }

  broadcast(value) {
    const data = JSON.stringify(value);
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.send(data); } catch { /* A stale connection is ignored. */ }
    }
  }

  activeCapability(value) {
    return this.ctx.getWebSockets().some((socket) => socket.deserializeAttachment()?.capability === value);
  }

  async fileRequest(request, id) {
    const url = new URL(request.url);
    const capability = url.searchParams.get('cap') || request.headers.get('x-chat-capability') || '';
    if (!this.activeCapability(capability)) return json({ error: '聊天室連線已失效，請重新加入。' }, 401);
    const { enabled, settings } = await this.state();
    if (!enabled) return json({ error: '聊天室已關閉。' }, 410);
    if (id === 'upload' && request.method === 'POST') return this.upload(request, settings, capability);
    if (request.method === 'GET' && id) return this.download(id);
    return new Response('Not found', { status: 404 });
  }

  async upload(request, settings, capability) {
    if (!settings.allowFiles) return json({ error: '管理員目前不允許傳送檔案。' }, 403);
    const filename = safeName(request.headers.get('x-file-name') || 'file');
    const extension = ext(filename);
    if (BLOCKED_EXTENSIONS.has(extension)) return json({ error: '此檔案類型不允許傳送。' }, 415);
    const allowed = new Set(String(settings.allowExtensions || '').split(',').map((item) => item.trim()).filter(Boolean));
    const denied = new Set(String(settings.denyExtensions || '').split(',').map((item) => item.trim()).filter(Boolean));
    if (allowed.size && !allowed.has(extension)) return json({ error: '此副檔名不在白名單中。' }, 415);
    if (denied.has(extension)) return json({ error: '此副檔名在黑名單中。' }, 415);
    const socket = this.ctx.getWebSockets().find((item) => item.deserializeAttachment()?.capability === capability);
    if (!socket) return json({ error: '聊天室連線已失效。' }, 401);
    const participant = socket.deserializeAttachment() || {};
    const now = Date.now();
    const minInterval = Math.max(500, Number(settings.messageIntervalMs) || 1000);
    if (now - Number(participant.lastMessageAt || 0) < minInterval) return json({ error: '請稍候再傳送下一則訊息。' }, 429);
    participant.lastMessageAt = now;
    socket.serializeAttachment(participant);
    const limit = Math.min(10 * 1024 * 1024, Number(settings.maxFileBytes) || 10 * 1024 * 1024);
    const bytes = await readBoundedBytes(request, limit);
    if (!bytes) return json({ error: '檔案超過目前的大小上限。' }, 413);
    const id = crypto.randomUUID();
    const key = `chat/${id}`;
    const contentType = String(request.headers.get('content-type') || 'application/octet-stream').slice(0, 100);
    await this.env.FILES.put(key, bytes, { metadata: { filename, contentType } });
    const createdAt = now;
    const messageId = crypto.randomUUID();
    try {
      await this.env.DB.batch([
        this.env.DB.prepare('INSERT INTO chat_files (id, filename, content_type, size_bytes, storage_key, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(id, filename, contentType, bytes.byteLength, key, createdAt),
        this.env.DB.prepare('INSERT INTO chat_messages (id, display_name, body, file_id, created_at) VALUES (?, ?, ?, ?, ?)')
          .bind(messageId, participant.displayName || '訪客', '', id, createdAt),
      ]);
    } catch (cause) {
      await this.env.FILES.delete(key);
      throw cause;
    }
    const item = { id: messageId, displayName: participant.displayName || '訪客', body: '', fileId: id, filename, contentType, size: bytes.byteLength, createdAt };
    this.broadcast({ type: 'message', item });
    return json({ ok: true, item });
  }

  async download(id) {
    const item = await this.env.DB.prepare('SELECT filename, content_type AS contentType, size_bytes AS size, storage_key AS key FROM chat_files WHERE id = ?').bind(id).first();
    if (!item) return json({ error: '找不到檔案。' }, 404);
    const value = await this.env.FILES.get(item.key, 'arrayBuffer');
    if (!value) return json({ error: '檔案在免費 KV 空間中已不可用。' }, 410);
    return new Response(value, { headers: {
      'content-type': item.contentType,
      'content-length': String(item.size),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(item.filename)}`,
      'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
    } });
  }

  async alarm() {
    const current = await this.state();
    if (!current.enabled) return;
    const code = randomCode();
    const expiresAt = Date.now() + 60_000;
    await this.ctx.storage.put({ code, expiresAt });
    await this.ctx.storage.setAlarm(expiresAt);
  }
}
