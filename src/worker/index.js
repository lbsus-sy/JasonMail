import { currentUser, error, json, login, loginChallenge, logout, readJson, requireCsrf, requireSession, setup, setupState, validateAddress } from './auth.js';
import {
  addMailbox, deleteMailbox, deleteMessage, getAttachment, listMailboxes, listMessages, readMessage,
  receiveWebhook, saveDraft, sendMessage, status as mailStatus, updateMessage, usageStatus,
} from './mail.js';
import { adminChat, chatFile, connectChat } from './chat.js';

export { ChatRoom } from './durable/ChatRoom.js';

function withSecurityHeaders(response) {
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  headers.set('x-frame-options', 'DENY');
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' wss:; frame-src 'self' blob: data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function safeFailure(cause) {
  const detail = cause instanceof Error ? cause.message : '';
  if (/quota|resource exhausted|database size|too many requests|limit exceeded|exceeded.{0,30}limit/iu.test(detail)) {
    return error('Cloudflare 免費資源目前已達上限。Jason Mail 不會啟用付費服務；請查看 Cloudflare 用量、清理可刪除的郵件或附件，再重試。每日額度則需等重置後再試。', 507);
  }
  return error('伺服器暫時無法處理此要求。請檢查 Worker 設定和資料庫遷移。', 500);
}

async function settings(request, env, method) {
  if (method === 'GET') {
    const values = await env.DB.prepare('SELECT key, value FROM settings').all();
    const map = Object.fromEntries(values.results.map((item) => [item.key, item.value]));
    const chat = await env.DB.prepare('SELECT allow_files, allow_extensions, deny_extensions, max_file_bytes, message_interval_ms FROM chat_settings WHERE id = 1').first();
    return json({
      emailDomain: map.email_domain || new URL(request.url).hostname,
      senderName: map.sender_name || 'Jason Mail',
      providerConfigured: Boolean(env.RESEND_API_KEY && env.RESEND_WEBHOOK_SECRET),
      webhookUrl: `${new URL(request.url).origin}/api/webhooks/resend`,
      chat: {
        allowFiles: Boolean(chat?.allow_files), allowExtensions: chat?.allow_extensions || '',
        denyExtensions: chat?.deny_extensions || '', maxFileBytes: chat?.max_file_bytes || 10 * 1024 * 1024,
        messageIntervalMs: chat?.message_interval_ms || 1000,
      },
      usage: await usageStatus(env.DB),
    });
  }
  const auth = await requireCsrf(request, env);
  if (auth.response) return auth.response;
  const input = await readJson(request);
  if (!input) return error('設定格式無效。');
  const emailDomain = String(input.emailDomain || '').trim().toLowerCase();
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(emailDomain)) return error('請輸入有效的郵件網域。');
  const old = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('email_domain').first();
  const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM mailboxes').first();
  if (old?.value && old.value !== emailDomain && count.count > 0) return error('請先刪除現有地址，才可更換郵件網域。', 409);
  const senderName = String(input.senderName || 'Jason Mail').replace(/[<>\r\n]/gu, '').trim().slice(0, 80) || 'Jason Mail';
  await env.DB.batch([
    env.DB.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').bind('email_domain', emailDomain, Date.now()),
    env.DB.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').bind('sender_name', senderName, Date.now()),
  ]);
  return json({ ok: true, emailDomain, senderName });
}

async function api(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (path === '/api/setup/status' && method === 'GET') return setupState(request, env);
  if (path === '/api/setup' && method === 'POST') return setup(request, env);
  if (path === '/api/auth/challenge' && method === 'POST') return loginChallenge(request, env);
  if (path === '/api/auth/login' && method === 'POST') return login(request, env);
  if (path === '/api/webhooks/resend' && method === 'POST') return receiveWebhook(request, env);
  if (path === '/api/chat/connect' && method === 'GET') return connectChat(request, env);
  if (path === '/api/chat/files' && method === 'POST') return chatFile(request, env);
  const chatFileMatch = path.match(/^\/api\/chat\/files\/([0-9a-f-]{36})$/iu);
  if (chatFileMatch && method === 'GET') return chatFile(request, env, chatFileMatch[1]);

  const session = await requireSession(request, env);
  if (session.response) return session.response;
  if (path === '/api/auth/me' && method === 'GET') return currentUser(request, env);
  if (path === '/api/auth/logout' && method === 'POST') return logout(request, env);
  if (path === '/api/settings' && (method === 'GET' || method === 'PUT')) return settings(request, env, method);
  if (path === '/api/status' && method === 'GET') return mailStatus(request, env);
  if (path === '/api/mailboxes' && method === 'GET') return listMailboxes(env);
  if (path === '/api/mailboxes' && method === 'POST') return addMailbox(request, env);
  const mailboxMatch = path.match(/^\/api\/mailboxes\/([0-9a-f-]{36})$/iu);
  if (mailboxMatch && method === 'DELETE') return deleteMailbox(request, env, mailboxMatch[1]);
  if (path === '/api/messages' && method === 'GET') return listMessages(request, env);
  const messageMatch = path.match(/^\/api\/messages\/([0-9a-f-]{36})$/iu);
  if (messageMatch && method === 'GET') return readMessage(request, env, messageMatch[1]);
  if (messageMatch && method === 'PATCH') return updateMessage(request, env, messageMatch[1]);
  if (messageMatch && method === 'DELETE') return deleteMessage(request, env, messageMatch[1]);
  if (path === '/api/drafts' && method === 'POST') return saveDraft(request, env);
  const draftMatch = path.match(/^\/api\/drafts\/([0-9a-f-]{36})$/iu);
  if (draftMatch && method === 'PUT') return saveDraft(request, env, draftMatch[1]);
  if (path === '/api/send' && method === 'POST') return sendMessage(request, env);
  if (path === '/api/attachments' && method === 'GET') {
    const id = url.searchParams.get('id');
    if (!id || !/^[0-9a-f-]{36}$/iu.test(id)) return error('附件 ID 無效。', 400);
    return getAttachment(request, env, id);
  }
  const chatAdminMatch = path.match(/^\/api\/chat\/admin\/(status|enable|disable|rotate|settings)$/u);
  if (chatAdminMatch && ['GET', 'POST'].includes(method)) return adminChat(request, env, chatAdminMatch[1]);
  return error('找不到此 API 路徑。', 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) return withSecurityHeaders(await api(request, env, ctx));
      if (url.pathname.startsWith('/privchat/')) return withSecurityHeaders(await env.ASSETS.fetch(new Request(new URL('/', request.url), request)));
      return withSecurityHeaders(await env.ASSETS.fetch(request));
    } catch (cause) {
      console.error('Jason Mail request failed:', cause instanceof Error ? cause.message : 'unknown error');
      return withSecurityHeaders(safeFailure(cause));
    }
  },
};
