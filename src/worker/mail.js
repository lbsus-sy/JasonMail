import { base64ToBytes, bytesToBase64Url, error, json, readJson, requireCsrf, safeFilename, sha256, validateAddress } from './auth.js';
import { readBoundedBytes, readBoundedText } from './bounded-body.js';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_WEBHOOK_BYTES = 256 * 1024;
const MAX_RESEND_API_BYTES = 2 * 1024 * 1024;
const FREE_DAILY = 100;
const FREE_MONTHLY = 3000;
const folders = new Set(['inbox', 'sent', 'drafts', 'archive', 'trash', 'unassigned']);

class ProviderPayloadTooLarge extends Error {}
class PermanentAttachmentError extends Error {}

function isCapacityLimitError(cause) {
  const detail = cause instanceof Error ? cause.message : String(cause || '');
  return /quota|resource exhausted|database size|too many requests|limit exceeded|exceeded.{0,30}limit/iu.test(detail);
}

function asList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || '').split(/[;,\n]/u).map((item) => item.trim()).filter(Boolean);
}

function recipientObjects(input, kind = 'to') {
  return asList(input).map(validateAddress).filter(Boolean).map((address) => ({ address, kind }));
}

function normalizeSender(value) {
  const match = String(value || '').match(/<([^<>]+)>/u);
  return validateAddress(match?.[1] || value) || 'unknown@unknown.invalid';
}

function localDay(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

async function reserveUsage(db, units) {
  const now = new Date();
  const day = localDay(now);
  const month = day.slice(0, 7);
  const row = await db.prepare(`
    INSERT INTO usage_counters (bucket, day_key, daily_count, month_key, monthly_count, updated_at)
    VALUES ('global', ?, ?, ?, ?, ?)
    ON CONFLICT(bucket) DO UPDATE SET
      daily_count = CASE WHEN usage_counters.day_key = excluded.day_key THEN usage_counters.daily_count + excluded.daily_count ELSE excluded.daily_count END,
      day_key = excluded.day_key,
      monthly_count = CASE WHEN usage_counters.month_key = excluded.month_key THEN usage_counters.monthly_count + excluded.monthly_count ELSE excluded.monthly_count END,
      month_key = excluded.month_key,
      updated_at = excluded.updated_at
    WHERE (CASE WHEN usage_counters.day_key = excluded.day_key THEN usage_counters.daily_count ELSE 0 END) + excluded.daily_count <= ${FREE_DAILY}
      AND (CASE WHEN usage_counters.month_key = excluded.month_key THEN usage_counters.monthly_count ELSE 0 END) + excluded.monthly_count <= ${FREE_MONTHLY}
    RETURNING daily_count, monthly_count
  `).bind(day, units, month, units, Date.now()).first();
  return row;
}

async function releaseUsage(db, units) {
  const day = localDay();
  const month = day.slice(0, 7);
  await db.prepare(`UPDATE usage_counters SET
      daily_count = CASE WHEN day_key = ? THEN MAX(0, daily_count - ?) ELSE daily_count END,
      monthly_count = CASE WHEN month_key = ? THEN MAX(0, monthly_count - ?) ELSE monthly_count END,
      updated_at = ? WHERE bucket = 'global'`)
    .bind(day, units, month, units, Date.now()).run();
}

export async function usageStatus(db) {
  const day = localDay();
  const row = await db.prepare('SELECT day_key, daily_count, month_key, monthly_count FROM usage_counters WHERE bucket = ?').bind('global').first();
  return {
    daily: row?.day_key === day ? row.daily_count : 0,
    dailyLimit: FREE_DAILY,
    monthly: row?.month_key === day.slice(0, 7) ? row.monthly_count : 0,
    monthlyLimit: FREE_MONTHLY,
  };
}

function decodeFileBase64(value) {
  const clean = String(value || '').replace(/^data:[^,]+,/u, '');
  try {
    return base64ToBytes(clean);
  } catch {
    return null;
  }
}

function safeAttachmentType(value) {
  const contentType = String(value || 'application/octet-stream').slice(0, 120);
  return /^[\w.+-]+\/[\w.+-]+$/u.test(contentType) ? contentType : 'application/octet-stream';
}

async function saveMessage(db, data, recipientRows, attachmentRows, extraStatements = []) {
  const stmts = [db.prepare(`INSERT INTO messages
      (id, direction, folder, sender, subject, text_body, html_body, thread_id, external_id, is_read, is_starred, received_at, created_at, size_bytes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`)
    .bind(data.id, data.direction, data.folder, data.sender, data.subject, data.text, data.html, data.threadId, data.externalId, data.isRead ? 1 : 0, data.receivedAt, Date.now(), data.sizeBytes)];
  for (const recipient of recipientRows) {
    stmts.push(db.prepare('INSERT INTO recipients (message_id, address, kind) VALUES (?, ?, ?)').bind(data.id, recipient.address, recipient.kind));
  }
  for (const attachment of attachmentRows) {
    stmts.push(db.prepare(`INSERT INTO attachments (id, message_id, filename, content_type, size_bytes, storage_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(attachment.id, data.id, attachment.filename, attachment.contentType, attachment.size, attachment.key, Date.now()));
  }
  stmts.push(...extraStatements);
  await db.batch(stmts);
}

async function storeOutboundAttachments(env, messageId, files) {
  const prepared = [];
  let total = 0;
  for (const file of files) {
    const bytes = decodeFileBase64(file.data);
    if (!bytes) throw new Error(`無法讀取附件「${safeFilename(file.name)}」。`);
    total += bytes.byteLength;
    if (bytes.byteLength > MAX_FILE_BYTES || total > MAX_FILE_BYTES) throw new Error('全部附件合計不可超過 10 MiB。');
    prepared.push({ id: crypto.randomUUID(), bytes, data: String(file.data).replace(/^data:[^,]+,/u, ''), filename: safeFilename(file.name), contentType: safeAttachmentType(file.type) });
  }
  const rows = [];
  const resendAttachments = [];
  try {
    for (const file of prepared) {
      const key = `mail/${messageId}/${file.id}`;
      await env.FILES.put(key, file.bytes, { metadata: { filename: file.filename, contentType: file.contentType } });
      rows.push({ id: file.id, key, filename: file.filename, contentType: file.contentType, size: file.bytes.byteLength });
      resendAttachments.push({ filename: file.filename, content: file.data });
    }
  } catch (cause) {
    for (const row of rows) await env.FILES.delete(row.key).catch(() => undefined);
    throw cause;
  }
  return { rows, resendAttachments, total };
}

export async function listMailboxes(env) {
  const { results } = await env.DB.prepare('SELECT id, address, label, created_at AS createdAt FROM mailboxes ORDER BY address COLLATE NOCASE').all();
  return json({ mailboxes: results });
}

export async function addMailbox(request, env) {
  const auth = await requireCsrf(request, env);
  if (auth.response) return auth.response;
  const input = await readJson(request);
  const address = validateAddress(input?.address);
  const label = String(input?.label || '').trim().slice(0, 80);
  const setting = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('email_domain').first();
  if (!address || !setting?.value || address.split('@')[1] !== setting.value) return error('郵件地址必須使用目前設定的郵件網域。');
  try {
    await env.DB.prepare('INSERT INTO mailboxes (id, address, label, created_at) VALUES (?, ?, ?, ?)')
      .bind(crypto.randomUUID(), address, label || address.split('@')[0], Date.now()).run();
  } catch {
    return error('此郵件地址已存在。', 409);
  }
  return json({ ok: true }, 201);
}

export async function deleteMailbox(request, env, id) {
  const auth = await requireCsrf(request, env);
  if (auth.response) return auth.response;
  const mailbox = await env.DB.prepare('SELECT id, address FROM mailboxes WHERE id = ?').bind(id).first();
  if (!mailbox) return error('找不到郵件地址。', 404);
  await env.DB.prepare('DELETE FROM mailboxes WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

export async function listMessages(request, env) {
  const url = new URL(request.url);
  const requestedFolder = url.searchParams.get('folder');
  const folder = requestedFolder === 'starred' ? 'starred' : folders.has(requestedFolder) ? requestedFolder : 'inbox';
  const query = (url.searchParams.get('q') || '').trim().slice(0, 160);
  const page = Math.max(0, Math.min(1000, Number.parseInt(url.searchParams.get('page') || '0', 10) || 0));
  const needle = `%${query.replace(/[\\%_]/gu, '\\$&')}%`;
  const { results } = await env.DB.prepare(`SELECT m.id, m.direction, m.folder, m.sender, m.subject, m.text_body AS preview,
      m.thread_id AS threadId, m.is_read AS isRead, m.is_starred AS isStarred, m.received_at AS receivedAt,
      m.size_bytes AS sizeBytes, GROUP_CONCAT(r.address, ',') AS recipientList,
      (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.id) AS attachmentCount
    FROM messages m LEFT JOIN recipients r ON r.message_id = m.id
    WHERE (? = 'starred' AND m.is_starred = 1 OR ? != 'starred' AND m.folder = ?)
      AND (? = '' OR m.sender LIKE ? ESCAPE '\\' OR m.subject LIKE ? ESCAPE '\\' OR m.text_body LIKE ? ESCAPE '\\' OR r.address LIKE ? ESCAPE '\\')
    GROUP BY m.id ORDER BY m.received_at DESC LIMIT 50 OFFSET ?`)
    .bind(folder, folder, folder, query, needle, needle, needle, needle, page * 50).all();
  const totals = await env.DB.prepare(`SELECT folder, COUNT(*) AS count FROM messages GROUP BY folder`).all();
  return json({ messages: results.map((row) => ({ ...row, isRead: Boolean(row.isRead), isStarred: Boolean(row.isStarred), preview: row.preview.slice(0, 200) })), counts: Object.fromEntries(totals.results.map((row) => [row.folder, row.count])), page });
}

export async function readMessage(request, env, id) {
  const row = await env.DB.prepare(`SELECT id, direction, folder, sender, subject, text_body AS text, html_body AS html,
      thread_id AS threadId, is_read AS isRead, is_starred AS isStarred, received_at AS receivedAt, size_bytes AS sizeBytes
    FROM messages WHERE id = ?`).bind(id).first();
  if (!row) return error('找不到這封郵件。', 404);
  await env.DB.prepare('UPDATE messages SET is_read = 1 WHERE id = ?').bind(id).run();
  const recipients = await env.DB.prepare('SELECT address, kind FROM recipients WHERE message_id = ? ORDER BY id').bind(id).all();
  const attachments = await env.DB.prepare(`SELECT id, filename, content_type AS contentType, size_bytes AS size
      FROM attachments WHERE message_id = ? ORDER BY created_at`).bind(id).all();
  const thread = row.threadId
    ? await env.DB.prepare(`SELECT m.id, m.direction, m.folder, m.sender, m.subject, m.text_body AS text,
        m.html_body AS html, m.thread_id AS threadId, m.received_at AS receivedAt,
        (SELECT GROUP_CONCAT(address, ',') FROM recipients WHERE message_id = m.id) AS recipients
      FROM messages m WHERE m.thread_id = ? AND m.id != ? ORDER BY m.received_at ASC`).bind(row.threadId, id).all()
    : { results: [] };
  return json({ message: { ...row, isRead: true, isStarred: Boolean(row.isStarred), recipients: recipients.results, attachments: attachments.results }, thread: thread.results });
}

export async function updateMessage(request, env, id) {
  const auth = await requireCsrf(request, env);
  if (auth.response) return auth.response;
  const input = await readJson(request);
  const current = await env.DB.prepare('SELECT id, folder, is_read, is_starred FROM messages WHERE id = ?').bind(id).first();
  if (!current) return error('找不到這封郵件。', 404);
  const folder = input?.folder && folders.has(input.folder) ? input.folder : current.folder;
  const isRead = typeof input?.isRead === 'boolean' ? Number(input.isRead) : current.is_read;
  const isStarred = typeof input?.isStarred === 'boolean' ? Number(input.isStarred) : current.is_starred;
  await env.DB.prepare('UPDATE messages SET folder = ?, is_read = ?, is_starred = ? WHERE id = ?').bind(folder, isRead, isStarred, id).run();
  return json({ ok: true });
}

export async function deleteMessage(request, env, id) {
  const auth = await requireCsrf(request, env);
  if (auth.response) return auth.response;
  const attachments = await env.DB.prepare('SELECT storage_key AS key FROM attachments WHERE message_id = ?').bind(id).all();
  for (const item of attachments.results) await env.FILES.delete(item.key);
  await env.DB.prepare('DELETE FROM messages WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

export async function saveDraft(request, env, id = null) {
  const auth = await requireCsrf(request, env);
  if (auth.response) return auth.response;
  const input = await readJson(request);
  if (!input) return error('草稿內容無效。');
  const draftId = String(id || input.draftId || '').trim();
  if (draftId) {
    const existing = await env.DB.prepare("SELECT id FROM messages WHERE id = ? AND folder = 'drafts'").bind(draftId).first();
    if (!existing) return error('找不到這份草稿，請重新載入草稿清單。', 404);
  }
  const messageId = draftId || crypto.randomUUID();
  const from = validateAddress(input.from);
  const to = recipientObjects(input.to);
  const cc = recipientObjects(input.cc, 'cc');
  const bcc = recipientObjects(input.bcc, 'bcc');
  if (!from) return error('請選擇有效的寄件地址。');
  const batches = [env.DB.prepare(`INSERT INTO messages
    (id, direction, folder, sender, subject, text_body, html_body, thread_id, received_at, created_at, size_bytes)
    VALUES (?, 'outbound', 'drafts', ?, ?, ?, '', ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      sender = excluded.sender, subject = excluded.subject, text_body = excluded.text_body, thread_id = excluded.thread_id,
      size_bytes = excluded.size_bytes, folder = 'drafts'`)
    .bind(messageId, from, String(input.subject || '').slice(0, 998), String(input.text || '').slice(0, 200_000), input.replyToThread || input.replyTo || null, Date.now(), Date.now(), String(input.text || '').length)];
  batches.push(env.DB.prepare('DELETE FROM recipients WHERE message_id = ?').bind(messageId));
  for (const recipient of [...to, ...cc, ...bcc]) batches.push(env.DB.prepare('INSERT INTO recipients (message_id, address, kind) VALUES (?, ?, ?)').bind(messageId, recipient.address, recipient.kind));
  await env.DB.batch(batches);
  return json({ ok: true, id: messageId });
}

export async function sendMessage(request, env, id = null) {
  const auth = await requireCsrf(request, env);
  if (auth.response) return auth.response;
  if (!env.RESEND_API_KEY) return error('尚未設定 RESEND_API_KEY，請按 README 設定 Resend。', 503);
  const input = await readJson(request);
  if (!input) return error('郵件內容無效。');
  const from = validateAddress(input.from);
  const to = recipientObjects(input.to);
  const cc = recipientObjects(input.cc, 'cc');
  const bcc = recipientObjects(input.bcc, 'bcc');
  const draftId = String(input.draftId || '').trim();
  const all = [...to, ...cc, ...bcc];
  const subject = String(input.subject || '').trim().slice(0, 998);
  const text = String(input.text || '').slice(0, 200_000);
  if (!from || !to.length || !subject || (!text.trim() && !input.attachments?.length)) return error('請填寫寄件人、至少一位收件人、主旨和郵件內容。');
  if (all.length !== asList(input.to).length + asList(input.cc).length + asList(input.bcc).length || all.length > 25) return error('收件地址無效，或收件人超過 25 位。');
  const mailbox = await env.DB.prepare('SELECT id FROM mailboxes WHERE address = ? COLLATE NOCASE').bind(from).first();
  const domain = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('email_domain').first();
  const senderSetting = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('sender_name').first();
  if (!mailbox || !domain?.value || from.split('@')[1] !== domain.value) return error('寄件地址必須是已建立的本機地址。');
  if (draftId) {
    const draft = await env.DB.prepare("SELECT id FROM messages WHERE id = ? AND folder = 'drafts'").bind(draftId).first();
    if (!draft) return error('找不到這份草稿，請重新載入草稿清單。', 404);
  }
  const units = all.length;
  const quota = await reserveUsage(env.DB, units);
  if (!quota) return error('已達本安裝實例的免費寄件上限（每日 100 位收件人或每月 3,000 位收件人）。額度重置後可再寄送。', 429);
  const messageId = id || crypto.randomUUID();
  let savedFiles = { rows: [], resendAttachments: [], total: 0 };
  let providerAccepted = false;
  let externalId = null;
  try {
    const files = Array.isArray(input.attachments) ? input.attachments.slice(0, 10) : [];
    savedFiles = await storeOutboundAttachments(env, messageId, files);
    const plainHtml = `<div style="white-space:pre-wrap;font:15px/1.6 Arial,sans-serif">${text.replace(/[&<>"']/gu, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])}</div>`;
    const payload = {
      from: `${String(input.senderName || senderSetting?.value || 'Jason Mail').replace(/[<>\r\n]/gu, '').slice(0, 80)} <${from}>`,
      to: to.map((item) => item.address), subject, text, html: plainHtml,
      ...(cc.length ? { cc: cc.map((item) => item.address) } : {}),
      ...(bcc.length ? { bcc: bcc.map((item) => item.address) } : {}),
      ...(input.replyToId ? { headers: { 'In-Reply-To': String(input.replyToId).slice(0, 998) } } : {}),
      ...(savedFiles.resendAttachments.length ? { attachments: savedFiles.resendAttachments } : {}),
    };
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.message || result.error || `Resend 回應 ${response.status}`);
    providerAccepted = true;
    externalId = result.id || null;
    const recipients = [...all];
    const savedRecipients = [...recipients, ...(input.replyToId ? [] : [])];
    await saveMessage(env.DB, {
      id: messageId, direction: 'outbound', folder: 'sent', sender: from, subject, text, html: plainHtml,
      threadId: input.replyToThread || input.replyToId || null, externalId,
      receivedAt: Date.now(), isRead: true, sizeBytes: text.length + savedFiles.total,
    }, savedRecipients, savedFiles.rows, draftId ? [env.DB.prepare('DELETE FROM messages WHERE id = ? AND folder = ?').bind(draftId, 'drafts')] : []);
    return json({ ok: true, id: messageId, externalId, usage: await usageStatus(env.DB) });
  } catch (cause) {
    if (providerAccepted) {
      console.error('Resend accepted outbound mail, but local persistence did not finish.', cause instanceof Error ? cause.message : 'unknown error');
      return json({ ok: true, acceptedByProvider: true, id: messageId, externalId, warning: 'Resend 已接受郵件，但本地寄件備份或草稿清理未完成。請勿重寄，先檢查寄件匣。' });
    }
    await releaseUsage(env.DB, units);
    for (const file of savedFiles.rows) await env.FILES.delete(file.key).catch(() => undefined);
    return error(cause instanceof Error ? cause.message : '寄送失敗，請稍後再試。', 502);
  }
}

async function verifyWebhook(request, env, rawBody) {
  if (!env.RESEND_WEBHOOK_SECRET) return false;
  const id = request.headers.get('svix-id') || request.headers.get('webhook-id');
  const timestamp = request.headers.get('svix-timestamp') || request.headers.get('webhook-timestamp');
  const signature = request.headers.get('svix-signature') || request.headers.get('webhook-signature');
  if (!id || !timestamp || !signature || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const rawSecret = String(env.RESEND_WEBHOOK_SECRET).replace(/^whsec_/u, '');
  let key;
  try { key = base64ToBytes(rawSecret); } catch { return false; }
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signatureBytes = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`));
  let binary = '';
  for (const byte of new Uint8Array(signatureBytes)) binary += String.fromCharCode(byte);
  const expected = btoa(binary);
  return signature.split(' ').some((item) => {
    const candidate = item.split(',', 2)[1];
    if (!candidate || candidate.length !== expected.length) return false;
    let diff = 0;
    for (let index = 0; index < candidate.length; index += 1) diff |= candidate.charCodeAt(index) ^ expected.charCodeAt(index);
    return diff === 0;
  });
}

async function resendGet(env, path) {
  const response = await fetch(`https://api.resend.com${path}`, { headers: { authorization: `Bearer ${env.RESEND_API_KEY}` } });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Resend 回應 ${response.status}`);
  }
  const rawBody = await readBoundedText(response, MAX_RESEND_API_BYTES);
  if (rawBody === null) throw new ProviderPayloadTooLarge('Resend API 回應超過 2 MiB 限制。');
  let body;
  try { body = JSON.parse(rawBody || '{}'); } catch { throw new Error('Resend API 回應格式無效。'); }
  return body;
}

async function downloadResendFile(urlValue, maxBytes) {
  let url;
  try { url = new URL(urlValue); } catch { throw new PermanentAttachmentError('Resend 附件網址無效。'); }
  if (url.protocol !== 'https:' || !(url.hostname === 'resend.com' || url.hostname.endsWith('.resend.com') || url.hostname === 'resend.dev' || url.hostname.endsWith('.resend.dev'))) {
    throw new PermanentAttachmentError('Resend 附件下載網址不在允許的供應商網域。');
  }
  const response = await fetch(url, { redirect: 'manual' });
  if (response.status === 429 || response.status >= 500) throw new Error(`Resend 附件下載暫時失敗（${response.status}）。`);
  if (!response.ok || response.status >= 300) throw new PermanentAttachmentError('Resend 附件下載連結已失效。');
  const bytes = await readBoundedBytes(response, maxBytes);
  if (!bytes) throw new PermanentAttachmentError('附件超過 Jason Mail 的 10 MiB 限制。');
  return bytes;
}

async function storeIncoming(env, event, eventId) {
  const data = event.data || {};
  const emailId = String(data.email_id || '');
  if (!emailId || !/^[\w-]{8,150}$/u.test(emailId)) throw new Error('Webhook 缺少有效的 email_id。');
  const already = await env.DB.prepare('SELECT event_id FROM webhook_events WHERE event_id = ?').bind(eventId).first();
  if (already) return;
  const recipients = [...recipientObjects(data.to), ...recipientObjects(data.cc, 'cc')];
  const quota = await reserveUsage(env.DB, 1);
  if (!quota) {
    await env.DB.prepare('INSERT OR IGNORE INTO webhook_events (event_id, received_at) VALUES (?, ?)').bind(eventId, Date.now()).run();
    await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').bind('quota_blocked_at', String(Date.now()), Date.now()).run();
    return;
  }
  const id = crypto.randomUUID();
  const attachments = [];
  try {
  let email;
  try {
    email = await resendGet(env, `/emails/receiving/${encodeURIComponent(emailId)}`);
  } catch (cause) {
    if (!(cause instanceof ProviderPayloadTooLarge)) throw cause;
    const known = await env.DB.prepare('SELECT address FROM mailboxes').all();
    const knownAddresses = new Set(known.results.map((row) => row.address.toLowerCase()));
    const knownRecipient = recipients.some((item) => knownAddresses.has(item.address));
    const subject = String(data.subject || '').slice(0, 998);
    const text = 'Jason Mail 已保存這封郵件的基本資訊，但 Resend 回傳的郵件內容超過 2 MiB 匯入上限，因此正文和附件未能保存。請到 Resend Dashboard 查看完整郵件。';
    await saveMessage(env.DB, {
      id, direction: 'inbound', folder: knownRecipient ? 'inbox' : 'unassigned',
      sender: normalizeSender(data.from), subject, text, html: '', threadId: null,
      externalId: emailId, receivedAt: Date.parse(data.created_at || '') || Date.now(),
      isRead: false, sizeBytes: text.length,
    }, recipients, [], [
      env.DB.prepare('INSERT OR IGNORE INTO webhook_events (event_id, received_at) VALUES (?, ?)').bind(eventId, Date.now()),
    ]);
    return;
  }
  const body = email.data || email;
  const known = await env.DB.prepare('SELECT address FROM mailboxes').all();
  const knownAddresses = new Set(known.results.map((row) => row.address.toLowerCase()));
  const knownRecipient = recipients.some((item) => knownAddresses.has(item.address));
  const subject = String(body.subject || data.subject || '').slice(0, 998);
  let text = String(body.text || body.text_body || '').slice(0, 500_000);
  const html = String(body.html || body.html_body || '').slice(0, 500_000);
  const headers = body.headers && typeof body.headers === 'object' ? body.headers : {};
  const replyHeader = headers['in-reply-to'] || headers['In-Reply-To'] || '';
  const threadId = String(replyHeader || subject.toLowerCase().replace(/^re:\s*/iu, '')).slice(0, 998) || null;
  let fileItems = [];
  try {
    const filesResult = await resendGet(env, `/emails/receiving/${encodeURIComponent(emailId)}/attachments`);
    fileItems = Array.isArray(filesResult.data) ? filesResult.data : [];
  } catch (cause) {
    if (!(cause instanceof ProviderPayloadTooLarge)) throw cause;
    text += '\n\n[Jason Mail：附件清單超過 2 MiB 匯入上限，附件未能保存。]';
  }
  let total = 0;
  let skippedCount = 0;
  const skippedNames = [];
  const skipAttachment = (file) => {
    skippedCount += 1;
    if (skippedNames.length < 5) skippedNames.push(safeFilename(file.filename || 'attachment').slice(0, 80));
  };
  for (const file of fileItems) {
    if (!file.download_url) { skipAttachment(file); continue; }
    const declaredSize = Number(file.size || 0);
    if (declaredSize > MAX_FILE_BYTES || total + declaredSize > MAX_FILE_BYTES) { skipAttachment(file); continue; }
    try {
      const bytes = await downloadResendFile(file.download_url, MAX_FILE_BYTES - total);
      const fileId = crypto.randomUUID();
      const key = `mail/${id}/${fileId}`;
      const filename = safeFilename(file.filename || 'attachment');
      const contentType = safeAttachmentType(file.content_type);
      await env.FILES.put(key, bytes, { metadata: { filename, contentType } });
      attachments.push({ id: fileId, key, filename, contentType, size: bytes.byteLength });
      total += bytes.byteLength;
    } catch (cause) {
      if (cause instanceof PermanentAttachmentError || isCapacityLimitError(cause)) {
        skipAttachment(file);
        continue;
      }
      throw cause;
    }
  }
  if (skippedCount) {
    const names = skippedNames.length ? `檔案：${skippedNames.join('、')}${skippedCount > skippedNames.length ? '…' : ''}` : '';
    text += `\n\n[Jason Mail：${skippedCount} 個附件未匯入（檔案過大、下載連結失效或免費儲存額度已滿）。${names}]`;
  }
    await saveMessage(env.DB, {
      id, direction: 'inbound', folder: knownRecipient ? 'inbox' : 'unassigned',
      sender: normalizeSender(body.from || data.from), subject, text, html, threadId,
      externalId: emailId, receivedAt: Date.parse(body.created_at || data.created_at || '') || Date.now(),
      isRead: false, sizeBytes: text.length + html.length + total,
    }, recipients, attachments, [
      env.DB.prepare('INSERT OR IGNORE INTO webhook_events (event_id, received_at) VALUES (?, ?)').bind(eventId, Date.now()),
    ]);
  } catch (cause) {
    for (const item of attachments) await env.FILES.delete(item.key).catch(() => undefined);
    await releaseUsage(env.DB, 1);
    throw cause;
  }
}

export async function receiveWebhook(request, env) {
  if (!env.RESEND_API_KEY || !env.RESEND_WEBHOOK_SECRET) return error('Resend webhook 尚未設定。', 503);
  const rawBody = await readBoundedText(request, MAX_WEBHOOK_BYTES);
  if (rawBody === null) return error('Webhook 內容不可超過 256 KiB。', 413);
  if (!(await verifyWebhook(request, env, rawBody))) return error('Webhook 簽章驗證失敗。', 401);
  let event;
  try { event = JSON.parse(rawBody); } catch { return error('Webhook JSON 格式無效。'); }
  const eventId = request.headers.get('svix-id') || request.headers.get('webhook-id') || `${event.type}:${event.data?.email_id || crypto.randomUUID()}`;
  if (event.type === 'email.received') {
    try { await storeIncoming(env, event, eventId); } catch (cause) {
      console.error('Jason Mail inbound email processing failed:', cause instanceof Error ? cause.message : 'unknown error');
      return error('收件處理失敗；Resend 可重試此 webhook。', 503);
    }
  }
  return json({ ok: true });
}

export async function getAttachment(request, env, id) {
  const item = await env.DB.prepare('SELECT id, filename, content_type AS contentType, size_bytes AS size, storage_key AS key FROM attachments WHERE id = ?').bind(id).first();
  if (!item) return error('找不到附件。', 404);
  const object = await env.FILES.get(item.key, 'arrayBuffer');
  if (!object) return error('附件在免費 KV 空間中已不可用。', 410);
  return new Response(object, { headers: {
    'content-type': item.contentType,
    'content-length': String(item.size),
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(item.filename)}`,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  } });
}

export async function status(request, env) {
  const [usage, domain, mailboxes] = await Promise.all([
    usageStatus(env.DB),
    env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('email_domain').first(),
    env.DB.prepare('SELECT COUNT(*) AS count FROM mailboxes').first(),
  ]);
  return json({ usage, emailDomain: domain?.value || '', mailboxCount: mailboxes?.count || 0, providerConfigured: Boolean(env.RESEND_API_KEY && env.RESEND_WEBHOOK_SECRET) });
}


