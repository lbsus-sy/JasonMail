const encoder = new TextEncoder();
const SESSION_DAYS = 7;

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function error(message, status = 400) {
  return json({ error: message }, status);
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export function randomToken(bytes = 32) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return bytesToBase64Url(data);
}

export function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

export function base64ToBytes(value) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function sha256(value) {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function equal(a, b) {
  const left = encoder.encode(String(a));
  const right = encoder.encode(String(b));
  let diff = left.length ^ right.length;
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i += 1) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

function cookies(request) {
  const header = request.headers.get('cookie') || '';
  return Object.fromEntries(header.split(';').map((part) => part.trim().split(/=(.*)/u, 2)).filter(([key]) => key));
}

function sessionCookie(token, request, maxAge = SESSION_DAYS * 86400) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `jm_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

async function createSession(request, env) {
  const token = randomToken();
  const csrf = randomToken(24);
  const now = Date.now();
  const expiresAt = now + SESSION_DAYS * 86400_000;
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now).run();
  await env.DB.prepare('INSERT INTO sessions (id_hash, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(token), csrf, expiresAt, now).run();
  return json({ ok: true, csrf, expiresAt }, 200, { 'set-cookie': sessionCookie(token, request) });
}

async function rateLimited(request, env, kind, recordFailure = false) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const keyHash = await sha256(`${kind}:${ip}`);
  const now = Date.now();
  const row = await env.DB.prepare('SELECT attempts, reset_at FROM auth_attempts WHERE key_hash = ?').bind(keyHash).first();
  if (row && row.reset_at > now && row.attempts >= 10) return true;
  if (recordFailure) {
    await env.DB.prepare(`INSERT INTO auth_attempts (key_hash, attempts, reset_at) VALUES (?, 1, ?)
      ON CONFLICT(key_hash) DO UPDATE SET
        attempts = CASE WHEN auth_attempts.reset_at > ? THEN auth_attempts.attempts + 1 ELSE 1 END,
        reset_at = CASE WHEN auth_attempts.reset_at > ? THEN auth_attempts.reset_at ELSE ? END`)
      .bind(keyHash, now + 15 * 60_000, now, now, now + 15 * 60_000).run();
  }
  return false;
}

export async function setupState(request, env) {
  const admin = await env.DB.prepare('SELECT username FROM administrator WHERE id = 1').first();
  return json({ configured: Boolean(admin), suggestedDomain: new URL(request.url).hostname });
}

export async function setup(request, env) {
  if (await rateLimited(request, env, 'setup')) return error('嘗試次數過多，請 15 分鐘後再試。', 429);
  const input = await readJson(request);
  if (!env.SETUP_TOKEN || !input || !equal(input.setupToken, env.SETUP_TOKEN)) {
    await rateLimited(request, env, 'setup', true);
    return error('安裝密鑰不正確，請檢查 Worker secret。', 401);
  }
  const username = String(input.username || '').trim();
  let passwordSalt;
  let passwordVerifier;
  try {
    passwordSalt = base64ToBytes(String(input.passwordSalt || ''));
    passwordVerifier = base64ToBytes(String(input.passwordVerifier || ''));
  } catch {
    return error('密碼安全資料無效，請重新輸入密碼。');
  }
  const emailDomain = String(input.emailDomain || new URL(request.url).hostname).trim().toLowerCase();
  if (username.length < 3 || username.length > 40 || !/^[\p{L}\p{N}._-]+$/u.test(username)) return error('使用者名稱需為 3–40 個字元，只能使用文字、數字、句點、底線或連字號。');
  if (Number(input.passwordLength) < 12 || Number(input.passwordLength) > 256) return error('密碼至少需要 12 個字元。');
  if (passwordSalt.length !== 16 || passwordVerifier.length !== 32) return error('密碼安全資料無效，請重新輸入密碼。');
  if (emailDomain.length > 253 || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(emailDomain)) return error('請輸入有效的郵件網域，例如 mail.example.com。');
  const existing = await env.DB.prepare('SELECT id FROM administrator WHERE id = 1').first();
  if (existing) return error('管理員已建立；一次性安裝已鎖定。', 409);
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO administrator (id, username, password_salt, password_hash, created_at) VALUES (1, ?, ?, ?, ?)')
        .bind(username, bytesToBase64Url(passwordSalt), bytesToBase64Url(passwordVerifier), Date.now()),
      env.DB.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (\'email_domain\', ?, ?)')
        .bind(emailDomain, Date.now()),
      env.DB.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (\'sender_name\', ?, ?)')
        .bind('Jason Mail', Date.now()),
    ]);
  } catch {
    return error('管理員已建立或資料庫尚未完成遷移。', 409);
  }
  return createSession(request, env);
}

export async function loginChallenge(request, env) {
  if (await rateLimited(request, env, 'login')) return error('嘗試次數過多，請 15 分鐘後再試。', 429);
  const input = await readJson(request);
  if (!input) return error('請輸入使用者名稱。');
  const username = String(input.username || '').trim();
  const admin = await env.DB.prepare('SELECT username, password_salt, password_hash FROM administrator WHERE id = 1').first();
  const challengeId = randomToken(18);
  const nonce = randomToken(32);
  const known = Boolean(admin && equal(username, admin.username));
  const salt = known ? admin.password_salt : bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  await env.DB.prepare('DELETE FROM login_challenges WHERE expires_at <= ?').bind(Date.now()).run();
  await env.DB.prepare('INSERT INTO login_challenges (id, username, nonce, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(challengeId, username, nonce, Date.now() + 5 * 60_000, Date.now()).run();
  await rateLimited(request, env, 'login', true);
  return json({ challengeId, nonce, salt, iterations: 600_000 });
}

export async function login(request, env) {
  const input = await readJson(request);
  if (!input) return error('請輸入使用者名稱和密碼。');
  const username = String(input.username || '').trim();
  const challengeId = String(input.challengeId || '');
  const challenge = await env.DB.prepare('SELECT id, username, nonce FROM login_challenges WHERE id = ? AND expires_at > ?').bind(challengeId, Date.now()).first();
  await env.DB.prepare('DELETE FROM login_challenges WHERE id = ?').bind(challengeId).run();
  const admin = await env.DB.prepare('SELECT username, password_hash FROM administrator WHERE id = 1').first();
  let expected = '';
  if (challenge && admin && equal(username, admin.username) && equal(challenge.username, admin.username)) {
    try {
      const verifier = base64ToBytes(admin.password_hash);
      const key = await crypto.subtle.importKey('raw', verifier, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const proof = await crypto.subtle.sign('HMAC', key, encoder.encode(`JasonMail login|${challenge.id}|${challenge.nonce}|${username}`));
      expected = bytesToBase64Url(new Uint8Array(proof));
    } catch { expected = ''; }
  }
  if (!expected || !equal(String(input.proof || ''), expected)) return error('帳號或密碼不正確，或登入驗證已過期。', 401);
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  await env.DB.prepare('DELETE FROM auth_attempts WHERE key_hash = ?').bind(await sha256(`login:${ip}`)).run();
  return createSession(request, env);
}

export async function requireSession(request, env, { mutate = false } = {}) {
  const token = cookies(request).jm_session;
  if (!token) return { response: error('請先登入。', 401) };
  const now = Date.now();
  const session = await env.DB.prepare('SELECT id_hash, csrf_token, expires_at FROM sessions WHERE id_hash = ? AND expires_at > ?')
    .bind(await sha256(token), now).first();
  if (!session) return { response: error('登入已過期，請重新登入。', 401) };
  if (mutate && !equal(request.headers.get('x-csrf-token'), session.csrf_token)) return { response: error('安全驗證失敗，請重新載入頁面。', 403) };
  return { session };
}

export async function currentUser(request, env) {
  const result = await requireSession(request, env);
  if (result.response) return result.response;
  const admin = await env.DB.prepare('SELECT username FROM administrator WHERE id = 1').first();
  const settings = await env.DB.prepare('SELECT key, value FROM settings').all();
  return json({ username: admin.username, emailDomain: settings.results.find((row) => row.key === 'email_domain')?.value ?? '', csrf: result.session.csrf_token });
}

export async function logout(request, env) {
  const result = await requireSession(request, env, { mutate: true });
  if (result.response) return result.response;
  await env.DB.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(result.session.id_hash).run();
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', request, 0) });
}

export async function requireCsrf(request, env) {
  return requireSession(request, env, { mutate: true });
}

export function validateAddress(value) {
  const address = String(value || '').trim().toLowerCase();
  return address.length <= 254 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,63}$/u.test(address) ? address : null;
}

export function safeFilename(value) {
  return String(value || 'file').replace(/[\\/\u0000-\u001f\u007f]/gu, '_').slice(0, 180) || 'file';
}
