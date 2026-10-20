const app = document.querySelector('#app');
const REPO_URL = 'https://github.com/lbsus-sy/JasonMail';
const state = {
  csrf: '', user: null, settings: null, folder: 'inbox', page: 'mail', messages: [], counts: {},
  mailboxes: [], selectedId: null, selected: null, thread: [], search: '', busy: false, chatCode: '',
};

const folders = [
  ['inbox', '收件匣', '▤'], ['starred', '已加星號', '☆'], ['sent', '已寄出', '↗'],
  ['drafts', '草稿', '✎'], ['archive', '封存', '▣'], ['trash', '垃圾桶', '⌫'], ['unassigned', '未分類收件', '⌂'],
];

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/gu, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function base64UrlBytes(value) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function derivePasswordVerifier(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

async function makeLoginProof(verifier, challengeId, nonce, username) {
  const key = await crypto.subtle.importKey('raw', verifier, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const result = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`JasonMail login|${challengeId}|${nonce}|${username}`));
  return base64Url(new Uint8Array(result));
}

function icon(name) {
  const icons = { mail: '✉', compose: '＋', settings: '⚙', people: '⌘', chat: '◌', search: '⌕', star: '☆', trash: '⌫', archive: '▣', back: '←', send: '↗', check: '✓' };
  return icons[name] || '·';
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !(options.body instanceof FormData) && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes((options.method || 'GET').toUpperCase()) && state.csrf) headers.set('x-csrf-token', state.csrf);
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  const type = response.headers.get('content-type') || '';
  const body = type.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(body?.error || body || `Request failed (${response.status})`);
  return body;
}

function toast(message, kind = 'info') {
  document.querySelector('.toast')?.remove();
  const item = document.createElement('div');
  item.className = `toast toast-${kind}`;
  item.setAttribute('role', 'status');
  item.textContent = message;
  document.body.append(item);
  setTimeout(() => item.remove(), 4200);
}

function pageFrame(title, eyebrow, body) {
  return `<div class="page-frame"><div class="page-heading"><div><p class="eyebrow">${escapeHtml(eyebrow)}</p><h1>${escapeHtml(title)}</h1></div></div>${body}</div>`;
}

function authScreen({ mode, host, message = '' }) {
  const setupMode = mode === 'setup';
  app.innerHTML = `<main class="auth-layout">
    <section class="auth-art"><a class="brand lockup" href="/"><span class="brand-mark">JM</span><span>JASON MAIL<small>俊鵬郵件</small></span></a>
      <div class="art-copy"><p class="eyebrow">YOUR OWN PRIVATE POST</p><h1>把信箱，<br><em>帶回自己手中。</em></h1><p>簡單部署在 Cloudflare。你的郵件、你的網域、你的步調。</p></div>
      <div class="art-orbit"><div class="orbit-ring ring-one"></div><div class="orbit-ring ring-two"></div><div class="orbit-envelope">✉</div><span class="orbit-star star-a">✦</span><span class="orbit-star star-b">✧</span></div>
      <div class="art-foot"><span>私人 · 開源 · 自行託管</span><span>01 / 01</span></div>
    </section>
    <section class="auth-panel"><div class="auth-card">
      <p class="eyebrow">${setupMode ? 'FIRST-TIME SETUP' : 'WELCOME BACK'}</p>
      <h2>${setupMode ? '建立你的管理員帳號' : '登入你的郵局'}</h2>
      <p class="muted">${setupMode ? `網站已在 ${escapeHtml(host || '你的網域')} 啟動。設定一次性密鑰與登入資料。` : '輸入你在首次安裝時建立的帳號。'}</p>
      ${message ? `<div class="inline-error">${escapeHtml(message)}</div>` : ''}
      <form id="auth-form" class="form-stack">
        ${setupMode ? `<label>一次性安裝密鑰<input name="setupToken" type="password" autocomplete="one-time-code" required placeholder="貼上 SETUP_TOKEN" /></label>` : ''}
        <label>使用者名稱<input name="username" autocomplete="username" required minlength="3" maxlength="40" placeholder="你的管理員名稱" /></label>
        <label>密碼<input name="password" type="password" autocomplete="${setupMode ? 'new-password' : 'current-password'}" required minlength="${setupMode ? '12' : '1'}" placeholder="${setupMode ? '至少 12 個字元' : '你的密碼'}" /></label>
        ${setupMode ? `<label>郵件網域<input name="emailDomain" autocomplete="url" required value="${escapeHtml(host || '')}" placeholder="mail.example.com" /><span class="field-note">可以使用根網域或子網域；稍後還需要在 Resend 驗證。</span></label>` : ''}
        <button class="button button-primary button-wide" type="submit">${setupMode ? '建立郵局' : '登入'} <span>→</span></button>
      </form>
      <div class="auth-note"><span class="secure-dot"></span>資料留在你自己的 Cloudflare 帳戶中</div>
    </div><footer class="auth-footer"><span>Jason Mail · 自架網頁郵局</span><a href="${REPO_URL}" target="_blank" rel="noreferrer">開源專案 ↗</a></footer></section>
  </main>`;
  document.querySelector('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    try {
      const username = String(form.get('username') || '').trim();
      const password = String(form.get('password') || '');
      let result;
      if (setupMode) {
        if (password.length < 12) throw new Error('密碼至少需要 12 個字元。');
        const passwordSalt = crypto.getRandomValues(new Uint8Array(16));
        const passwordVerifier = await derivePasswordVerifier(password, passwordSalt, 600_000);
        result = await api('/api/setup', { method: 'POST', body: JSON.stringify({
          setupToken: form.get('setupToken'), username, emailDomain: form.get('emailDomain'), passwordLength: password.length,
          passwordSalt: base64Url(passwordSalt), passwordVerifier: base64Url(passwordVerifier),
        }) });
      } else {
        const challenge = await api('/api/auth/challenge', { method: 'POST', body: JSON.stringify({ username }) });
        const verifier = await derivePasswordVerifier(password, base64UrlBytes(challenge.salt), challenge.iterations);
        const proof = await makeLoginProof(verifier, challenge.challengeId, challenge.nonce, username);
        result = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, challengeId: challenge.challengeId, proof }) });
      }
      state.csrf = result.csrf;
      await loadApp();
    } catch (error) {
      button.disabled = false;
      toast(error.message, 'error');
    }
  });
}

function navButton(page, label, glyph, current) {
  return `<button class="nav-link ${current === page ? 'is-active' : ''}" data-page="${page}"><span class="nav-glyph">${glyph}</span><span>${label}</span></button>`;
}

function renderShell() {
  const activeFolder = state.folder === 'starred' ? 'starred' : state.folder;
  const title = folders.find((item) => item[0] === state.folder)?.[1] || '郵件';
  app.innerHTML = `<div class="app-shell">
    <header class="topbar"><button class="mobile-menu" data-action="toggle-nav" aria-label="開啟導覽">☰</button>
      <a class="brand compact-lockup" href="#"><span class="brand-mark">JM</span><span>Jason Mail</span></a>
      <div class="top-search"><span>${icon('search')}</span><input id="search-input" type="search" value="${escapeHtml(state.search)}" placeholder="搜尋郵件、寄件人…" aria-label="搜尋郵件" /><kbd>⌘ K</kbd></div>
      <div class="top-actions"><span class="domain-pill"><i></i>${escapeHtml(state.settings?.emailDomain || '')}</span><button class="user-chip" data-action="logout" title="登出"><span class="avatar avatar-gold">${escapeHtml((state.user?.username || 'J').slice(0, 1).toUpperCase())}</span><span class="user-name">${escapeHtml(state.user?.username || '管理員')}</span><span class="chevron">⌄</span></button></div>
    </header>
    <aside class="sidebar" id="sidebar">
      <button class="button button-compose" data-action="compose"><span>${icon('compose')}</span> 撰寫郵件</button>
      <p class="nav-caption">郵件</p><nav class="mail-nav">${folders.map(([key, label, glyph]) => `<button class="nav-link ${activeFolder === key ? 'is-active' : ''}" data-folder="${key}"><span class="nav-glyph">${glyph}</span><span>${label}</span>${state.counts[key] ? `<b class="nav-count">${state.counts[key]}</b>` : ''}</button>`).join('')}</nav>
      <div class="sidebar-rule"></div><p class="nav-caption">工作區</p><nav>${navButton('addresses', '郵件地址', '⌘', state.page)}${navButton('chat', '私人聊天室', '◌', state.page)}${navButton('settings', '網域與設定', '⚙', state.page)}</nav>
      <div class="sidebar-spacer"></div><div class="quota-card"><div class="quota-heading"><span class="quota-dot"></span><span>免費用量</span><span class="quota-live">本實例</span></div><p>${state.settings?.usage?.daily || 0} <small>/ 100 今日額度單位</small></p><div class="quota-track"><i style="--fill:${Math.min(100, (state.settings?.usage?.daily || 0) / 100 * 100)}%"></i></div><p class="quota-month">${state.settings?.usage?.monthly || 0} / 3,000 本月額度單位</p></div>
      <div class="sidebar-bottom"><span class="online-indicator"></span> 系統已就緒 <a href="${REPO_URL}" target="_blank" rel="noreferrer">Source ↗</a></div>
    </aside>
    <main class="main-area ${state.selectedId ? 'message-open' : ''}" id="main-area">${renderCurrentPage(title)}</main>
    <div id="modal-root"></div>
  </div>`;
  bindShell();
}

function renderCurrentPage(title) {
  if (state.page === 'addresses') return renderAddresses();
  if (state.page === 'settings') return renderSettings();
  if (state.page === 'chat') return renderChatAdmin();
  return renderMailPage(title);
}

function renderMailPage(title) {
  const activeMessages = state.folder === 'starred' ? state.messages : state.messages;
  return `<section class="mail-workspace">
    <div class="message-list-pane ${state.selectedId ? 'mobile-hidden' : ''}">
      <div class="list-heading"><div><p class="eyebrow">YOUR MAIL</p><h1>${escapeHtml(title)}</h1></div><button class="icon-button refresh-button" data-action="refresh" title="重新整理">↻</button></div>
      <div class="list-toolbar"><button class="check-control" data-action="mark-visible" title="選取">□</button><span class="toolbar-divider"></span><button class="icon-button" data-action="refresh" title="重新整理">↻</button><span class="results-count">${activeMessages.length} 封</span></div>
      <div class="message-list" id="message-list">${activeMessages.length ? activeMessages.map(renderMessageRow).join('') : `<div class="empty-list"><span class="empty-symbol">${state.folder === 'inbox' ? '✉' : '◌'}</span><strong>${state.search ? '沒有找到符合的郵件' : '這裡還沒有郵件'}</strong><p>${state.search ? '試試其他關鍵字。' : '有新信時會出現在這裡。'}</p>${state.folder === 'inbox' ? `<button class="text-button" data-action="open-settings">設定收件 DNS 指引 →</button>` : ''}</div>`}</div>
      <div class="list-foot"><span>最多顯示 50 封</span><span>由新到舊排序</span></div>
    </div>
    <div class="reader-pane ${state.selectedId ? 'mobile-visible' : ''}" id="reader-pane">${renderReader()}</div>
  </section>`;
}

function renderMessageRow(message) {
  const name = message.direction === 'outbound' ? (message.recipientList || '收件人') : message.sender;
  const preview = (message.preview || '').replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ').trim();
  const date = new Date(message.receivedAt).toLocaleDateString('zh-HK', { month: 'short', day: 'numeric' });
  return `<article class="message-row ${message.isRead ? '' : 'is-unread'} ${state.selectedId === message.id ? 'is-selected' : ''}" data-message="${escapeHtml(message.id)}" tabindex="0">
      <span class="sender-avatar">${escapeHtml(String(name).slice(0, 1).toUpperCase())}</span>
      <div class="row-copy"><div class="row-top"><span class="sender-name">${escapeHtml(name)}</span><time>${escapeHtml(date)}</time></div>
        <div class="row-subject"><span>${escapeHtml(message.subject || '(沒有主旨)')}</span>${message.attachmentCount ? '<span class="attachment-indicator">⌕</span>' : ''}</div>
        <p class="row-preview">${escapeHtml(preview || '（沒有文字預覽）')}</p>
      </div><button class="row-star ${message.isStarred ? 'is-starred' : ''}" data-action="star" data-id="${escapeHtml(message.id)}" title="${message.isStarred ? '取消星號' : '加上星號'}">${message.isStarred ? '★' : '☆'}</button>
    </article>`;
}

function sanitizeEmailHtml(html) {
  const documentCopy = new DOMParser().parseFromString(String(html || ''), 'text/html');
  const allowed = new Set(['A', 'B', 'BLOCKQUOTE', 'BR', 'CODE', 'DIV', 'EM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'I', 'LI', 'OL', 'P', 'PRE', 'S', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'U', 'UL']);
  for (const node of [...documentCopy.body.querySelectorAll('*')]) {
    if (!allowed.has(node.tagName)) { node.replaceWith(...node.childNodes); continue; }
    const href = node.tagName === 'A' ? node.getAttribute('href') : null;
    for (const attribute of [...node.attributes]) node.removeAttribute(attribute.name);
    if (node.tagName === 'A') {
      if (href && /^(https?:|mailto:)/iu.test(href)) { node.setAttribute('href', href); node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
    }
  }
  const content = documentCopy.body.innerHTML;
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'"><meta charset="utf-8"><style>body{font:15px/1.65 Arial,sans-serif;color:#302c38;margin:22px;overflow-wrap:anywhere}a{color:#6854a5}table{border-collapse:collapse}td,th{padding:5px;border:1px solid #ccc}blockquote{border-left:3px solid #dac783;padding-left:12px;color:#625c68}</style></head><body>${content}</body></html>`;
}

function renderEmailBody(message) {
  if (message.html) return `<iframe class="email-frame" title="郵件內容" sandbox="allow-popups allow-popups-to-escape-sandbox" srcdoc="${escapeHtml(sanitizeEmailHtml(message.html))}"></iframe>`;
  return `<pre class="plain-email">${escapeHtml(message.text || '（此郵件沒有文字內容。）')}</pre>`;
}

function renderThreadItem(item, isCurrent = false) {
  const sender = item.direction === 'outbound' ? '我' : item.sender;
  return `<article class="thread-item ${isCurrent ? 'thread-current' : ''}"><div class="thread-head"><span class="sender-avatar small-avatar">${escapeHtml(String(sender).slice(0, 1).toUpperCase())}</span><div><strong>${escapeHtml(sender)}</strong><small>${escapeHtml(new Date(item.receivedAt).toLocaleString('zh-HK'))}</small></div></div>${item.html ? renderEmailBody(item) : `<pre class="plain-email thread-body">${escapeHtml(item.text || '')}</pre>`}</article>`;
}

function renderReader() {
  if (!state.selected) return `<div class="reader-empty"><div class="reader-illustration"><div class="paper-plane">✉</div><span class="spark spark-one">✦</span><span class="spark spark-two">✧</span></div><h2>你的郵件，<em>從這裡開始。</em></h2><p>選取左邊一封郵件，展開閱讀。</p><span class="reader-tip">按 <kbd>⌘ K</kbd> 搜尋郵件</span></div>`;
  const message = state.selected;
  const recipients = message.recipients?.map((item) => item.address).join(', ') || '';
  const attachmentHtml = (message.attachments || []).map((item) => `<a class="attachment-chip" href="/api/attachments?id=${encodeURIComponent(item.id)}"><span>⇩</span><span><b>${escapeHtml(item.filename)}</b><small>${formatBytes(item.size)}</small></span></a>`).join('');
  return `<div class="reader-toolbar"><button class="mobile-back icon-button" data-action="back-list" title="返回列表">←</button><div class="reader-actions"><button class="icon-button" data-action="archive" title="封存">▣</button><button class="icon-button" data-action="trash" title="移至垃圾桶">⌫</button><span class="toolbar-divider"></span><button class="icon-button" data-action="reply" title="回覆">↶</button><button class="icon-button" data-action="forward" title="轉寄">↗</button><button class="icon-button" data-action="toggle-read" title="標記未讀">✉</button></div><div class="reader-actions right-actions"><button class="icon-button ${message.isStarred ? 'is-starred' : ''}" data-action="star-current" title="星號">${message.isStarred ? '★' : '☆'}</button>${message.folder === 'trash' ? `<button class="icon-button danger-icon" data-action="delete-permanently" title="永久刪除">⌫</button>` : ''}</div></div>
    <article class="message-content"><div class="message-kicker"><span class="label-pill">${message.direction === 'inbound' ? '收到' : message.folder === 'drafts' ? '草稿' : '已寄出'}</span><time>${escapeHtml(new Date(message.receivedAt).toLocaleString('zh-HK'))}</time></div>
      <h1 class="message-subject">${escapeHtml(message.subject || '(沒有主旨)')}</h1><div class="message-meta"><span class="sender-avatar">${escapeHtml(String(message.sender).slice(0, 1).toUpperCase())}</span><div class="meta-copy"><strong>${escapeHtml(message.sender)}</strong><span>寄給 ${escapeHtml(recipients || '我')}</span></div><button class="meta-more" title="更多資訊">···</button></div>
      ${message.attachments?.length ? `<div class="attachment-list">${attachmentHtml}</div>` : ''}
      ${state.thread.length ? `<div class="thread-stack">${state.thread.map((item) => renderThreadItem(item)).join('')}</div>` : ''}
      <div class="message-body">${renderEmailBody(message)}</div>
      <div class="message-bottom"><button class="button button-light" data-action="reply">↶　回覆</button><button class="button button-light" data-action="forward">↗　轉寄</button></div>
    </article>`;
}

function formatBytes(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function renderAddresses() {
  const rows = state.mailboxes.map((mailbox) => `<div class="address-row"><span class="mailbox-badge">@</span><div><strong>${escapeHtml(mailbox.address)}</strong><small>${escapeHtml(mailbox.label || '郵件地址')}</small></div><button class="icon-button danger-icon" data-action="delete-mailbox" data-id="${escapeHtml(mailbox.id)}" title="刪除地址">⌫</button></div>`).join('');
  return pageFrame('郵件地址', 'YOUR ADDRESSES', `<div class="settings-grid"><section class="settings-card address-create"><div class="card-heading"><div><p class="eyebrow">LOCAL MAILBOXES</p><h2>新增地址</h2><p>建立你網域下任意本機地址，由同一位管理員收件。</p></div><span class="card-icon">@</span></div><form id="mailbox-form" class="inline-form"><label><span>郵件地址</span><div class="address-input"><input name="localPart" required maxlength="64" pattern="[a-zA-Z0-9._+-]+" placeholder="hello" /><span>@${escapeHtml(state.settings?.emailDomain || '')}</span></div></label><label><span>顯示名稱</span><input name="label" maxlength="80" placeholder="例如：個人郵件" /></label><button class="button button-primary" type="submit">建立地址</button></form></section><section class="settings-card"><div class="card-heading"><div><p class="eyebrow">MAILBOX LIST</p><h2>已建立的地址 <span class="count-chip">${state.mailboxes.length}</span></h2></div></div><div class="address-list">${rows || `<div class="empty-state compact-empty"><span>⌂</span><strong>尚未建立地址</strong><p>新增第一個郵件地址後即可開始收件和寄件。</p></div>`}</div></section><div class="info-strip"><span class="info-icon">i</span><p>此版本只有一位管理員，所有地址都共用同一個收件匣。未知收件地址會進入「未分類收件」。</p></div></div>`);
}

function renderSettings() {
  const settings = state.settings || {};
  return pageFrame('網域與設定', 'POST OFFICE SETTINGS', `<div class="settings-grid">
    <section class="settings-card"><div class="card-heading"><div><p class="eyebrow">SENDER IDENTITY</p><h2>郵件網域</h2><p>目前應用部署在這個主機名下。Resend 需要驗證同一個網域。</p></div><span class="card-icon">◎</span></div>
      <form id="settings-form" class="form-stack settings-form"><label>郵件網域<input name="emailDomain" required value="${escapeHtml(settings.emailDomain || '')}" placeholder="mail.example.com" /><span class="field-note">要更換網域，請先刪除已建立的郵件地址。</span></label><label>寄件顯示名稱<input name="senderName" maxlength="80" value="${escapeHtml(settings.senderName || 'Jason Mail')}" /></label><button class="button button-primary" type="submit">儲存設定</button></form>
    </section>
    <section class="settings-card dns-card"><div class="card-heading"><div><p class="eyebrow">RECEIVING & DELIVERY</p><h2>連接 Resend</h2><p>郵件透過 Resend Free 收發，內容仍在這個網頁郵局中管理。</p></div><span class="provider-status ${settings.providerConfigured ? 'is-ready' : ''}">${settings.providerConfigured ? '已設定' : '待設定'}</span></div>
      <div class="dns-steps"><div class="dns-step"><span>01</span><div><strong>在 Resend 驗證網域</strong><p>加入它提供的 SPF、DKIM 與收件 MX 記錄。DNS 記錄值以 Resend Dashboard 顯示為準。</p></div></div><div class="dns-step"><span>02</span><div><strong>設定寄件驗證</strong><p>加入 DMARC TXT 記錄。建議先用 <code>p=none</code> 觀察報告，再逐步收緊政策。</p></div></div><div class="dns-step"><span>03</span><div><strong>建立收件 Webhook</strong><p>在 Resend 建立 <code>email.received</code> webhook，貼上這個網址：</p><div class="copy-line"><code>${escapeHtml(settings.webhookUrl || '')}</code><button class="button button-small" data-action="copy" data-copy="${escapeHtml(settings.webhookUrl || '')}">複製</button></div></div></div></div>
      <div class="callout warning-callout"><span>!</span><p><strong>根網域提醒</strong>如果根網域已有 MX 記錄，改成 Resend 可能會影響目前收件服務。建議先用專用子網域，例如 <code>send.example.com</code>。</p></div>
    </section><section class="settings-card"><div class="card-heading"><div><p class="eyebrow">FREE PLAN GUARD</p><h2>免費額度保護</h2><p>超過本安裝實例的額度時，應用會停止寄送或處理新收件。</p></div><span class="card-icon">⌁</span></div><div class="limit-pair"><div><strong>100</strong><span>額度單位／每日</span></div><div><strong>3,000</strong><span>額度單位／每月</span></div><div><strong>10 MiB</strong><span>附件合計上限</span></div></div><p class="fine-print">外寄郵件按收件人數計額度單位；每封入站郵件計 1 單位。Resend 額度是帳戶共用，其他應用也可能消耗。SPF、DKIM、DMARC 可改善驗證，但無法保證郵件一定進入收件匣。網域註冊費不包含在免費服務內。</p></section>
    <div class="info-strip"><span class="info-icon">i</span><p>Jason Mail 不會替你修改 Cloudflare DNS。請手動加入 Worker Route、郵件 MX、SPF、DKIM 和 DMARC 記錄，完整步驟請看 <a href="${REPO_URL}#readme" target="_blank" rel="noreferrer">README</a>。</p></div>
  </div>`);
}

function renderChatAdmin() {
  const chat = state.settings?.chat || {};
  return pageFrame('私人聊天室', 'A ROOM OF YOUR OWN', `<div class="settings-grid chat-grid"><section class="settings-card chat-control-card"><div class="card-heading"><div><p class="eyebrow">PRIVATE CHAT</p><h2>${state.chatCode ? '聊天室已開啟' : '只在需要時開啟'}</h2><p>分享短效驗證碼，朋友無需建立帳號即可加入。</p></div><span class="chat-status ${state.chatCode ? 'is-online' : ''}"><i></i>${state.chatCode ? '開啟中' : '已關閉'}</span></div>
      ${state.chatCode ? `<div class="code-panel"><div><small>當前訪問碼</small><strong id="chat-code">${escapeHtml(state.chatCode)}</strong><span id="chat-countdown">每 60 秒自動更新</span></div><button class="button button-gold" data-action="copy-chat">複製邀請連結</button></div><div class="chat-url"><span>${escapeHtml(location.origin)}/privchat/${escapeHtml(state.chatCode)}</span><button class="icon-button" data-action="copy-chat" title="複製">⧉</button></div><div class="chat-buttons"><button class="button button-light" data-action="rotate-chat">⟳　立即刷新驗證碼</button><button class="button button-danger" data-action="disable-chat">關閉聊天室</button></div><p class="field-note">舊驗證碼更新後無法再加入；已連線的朋友仍可繼續聊天。關閉聊天室會斷開所有人並刪除聊天訊息與檔案。</p>` : `<div class="chat-closed"><div class="closed-orb">◌</div><div><strong>目前沒有開放的聊天室</strong><p>開啟後會產生每分鐘更新的六位數驗證碼。</p></div><button class="button button-primary" data-action="enable-chat">開啟聊天室　→</button></div>`}</section>
    <section class="settings-card"><div class="card-heading"><div><p class="eyebrow">ROOM RULES</p><h2>聊天室設定</h2><p>規則會在伺服器端檢查。</p></div><span class="card-icon">⚙</span></div><form id="chat-settings-form" class="form-stack settings-form">
      <label class="toggle-row"><span><strong>允許傳送檔案</strong><small>關閉時不接受檔案上傳</small></span><input type="checkbox" name="allowFiles" ${chat.allowFiles ? 'checked' : ''} /><i class="toggle-switch"></i></label>
      <label>副檔名白名單 <span class="field-note">留空代表允許所有非黑名單類型</span><input name="allowExtensions" value="${escapeHtml(chat.allowExtensions || '')}" placeholder="pdf,png,jpg" /></label>
      <label>副檔名黑名單<input name="denyExtensions" value="${escapeHtml(chat.denyExtensions || 'exe,com,bat,cmd,msi,js,vbs,ps1,sh,jar,scr')}" placeholder="exe,bat,js" /><span class="field-note">可執行檔類型會固定封鎖。</span></label>
      <label>單檔大小上限（MiB）<input name="maxFileMiB" type="number" min="1" max="10" value="${Math.min(10, Math.max(1, Math.round((chat.maxFileBytes || 10485760) / 1048576)))}" /></label>
      <label>訊息最短間隔（毫秒）<input name="messageIntervalMs" type="number" min="500" max="60000" value="${chat.messageIntervalMs || 1000}" /></label>
      <button class="button button-primary" type="submit">儲存聊天室設定</button>
    </form></section><div class="callout privacy-callout"><span>i</span><p>驗證碼只限制新加入者，並非端對端加密。訊息和檔案會經過你的 Worker，聊天室關閉時應用會清除紀錄。</p></div></div>`);
}

function renderPublicChat(code) {
  app.innerHTML = `<main class="public-chat-page"><header class="chat-topbar"><a class="brand compact-lockup" href="/"><span class="brand-mark">JM</span><span>Jason Mail <small>PRIVATE ROOM</small></span></a><span class="live-room"><i></i> 私人聊天室</span></header><section class="public-chat-card"><div class="chat-room-head"><div><p class="eyebrow">INVITED ROOM</p><h1>加入私人聊天室</h1><p class="muted">此連結使用短效驗證碼。請輸入你希望顯示的名稱。</p></div><div class="chat-room-seal">◌</div></div><form id="join-chat-form" class="join-chat-form"><label>你的名稱<input name="name" required maxlength="32" placeholder="例如：Jason" value="${escapeHtml(sessionStorage.getItem('jm-chat-name') || '')}" /></label><div class="room-code-field"><span>驗證碼</span><strong>${escapeHtml(code)}</strong></div><button class="button button-primary button-wide" type="submit">進入聊天室　→</button></form><div id="join-chat-error" class="inline-error hidden"></div><div id="public-room" class="public-room hidden"><div class="room-status-line"><span class="online-indicator"></span><span>已安全連線</span><span class="room-code-small">${escapeHtml(code)}</span></div><div class="chat-transcript" id="chat-transcript" aria-live="polite"></div><form id="chat-message-form" class="chat-compose"><textarea name="body" maxlength="4000" rows="1" placeholder="寫下訊息…" required></textarea><label class="file-pick hidden" title="傳送檔案">⌕<input type="file" id="chat-file-input" /></label><button class="button button-primary" type="submit">傳送</button></form></div></section><p class="public-chat-footer">訊息與檔案會經過聊天室主人的自架服務。關閉聊天室時，記錄會被刪除。</p></main>`;
  document.querySelector('#join-chat-form').addEventListener('submit', (event) => { event.preventDefault(); joinRoom(code, new FormData(event.currentTarget).get('name')); });
}

function renderChatItem(item) {
  const time = new Date(item.createdAt).toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit' });
  const file = item.fileId ? `<a class="chat-file-card" href="/api/chat/files/${encodeURIComponent(item.fileId)}?cap=${encodeURIComponent(chatCapability)}"><span>⇩</span><span><b>${escapeHtml(item.filename || '聊天室檔案')}</b><small>${formatBytes(item.size || 0)}</small></span></a>` : '';
  const body = item.body ? `<p>${escapeHtml(item.body).replace(/\n/gu, '<br>')}</p>` : '';
  return `<article class="chat-message"><div class="chat-message-meta"><strong>${escapeHtml(item.displayName || '訪客')}</strong><time>${escapeHtml(time)}</time></div><div class="chat-bubble">${body}${file}</div></article>`;
}

let chatSocket = null;
let chatCapability = '';

function appendChatItem(item) {
  const transcript = document.querySelector('#chat-transcript');
  if (!transcript) return;
  transcript.insertAdjacentHTML('beforeend', renderChatItem(item));
  transcript.scrollTop = transcript.scrollHeight;
}

function joinRoom(code, name) {
  const errorBox = document.querySelector('#join-chat-error');
  errorBox.classList.add('hidden');
  const cleanName = String(name || '').trim().slice(0, 32);
  if (!cleanName) { errorBox.textContent = '請輸入顯示名稱。'; errorBox.classList.remove('hidden'); return; }
  sessionStorage.setItem('jm-chat-name', cleanName);
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const query = new URLSearchParams({ code, name: cleanName });
  chatSocket = new WebSocket(`${scheme}//${location.host}/api/chat/connect?${query}`);
  const form = document.querySelector('#join-chat-form');
  form.querySelector('button').disabled = true;
  chatSocket.addEventListener('message', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === 'ready') {
      chatCapability = payload.capability;
      document.querySelector('#chat-file-input')?.closest('.file-pick')?.classList.toggle('hidden', !payload.allowFiles);
      document.querySelector('#public-room').classList.remove('hidden');
      form.classList.add('hidden');
      for (const item of payload.history || []) appendChatItem(item);
    } else if (payload.type === 'message') appendChatItem(payload.item);
    else if (payload.type === 'error') toast(payload.message, 'error');
  });
  chatSocket.addEventListener('error', () => { errorBox.textContent = '無法連線。驗證碼可能已更新，請向聊天室主人索取新連結。'; errorBox.classList.remove('hidden'); form.querySelector('button').disabled = false; });
  chatSocket.addEventListener('close', () => { if (!chatCapability) { errorBox.textContent = '聊天室未開啟或驗證碼已更新。'; errorBox.classList.remove('hidden'); form.querySelector('button').disabled = false; } else toast('聊天室連線已關閉。', 'error'); });
  document.querySelector('#chat-message-form').addEventListener('submit', (event) => {
    event.preventDefault(); const input = event.currentTarget.elements.body; const body = input.value.trim();
    if (body && chatSocket?.readyState === WebSocket.OPEN) { chatSocket.send(JSON.stringify({ type: 'message', body })); input.value = ''; input.focus(); }
  }, { once: true });
  document.querySelector('#chat-file-input').addEventListener('change', uploadChatFile, { once: true });
}

async function uploadChatFile(event) {
  const input = event.currentTarget; const file = input.files?.[0]; if (!file) return;
  if (file.size > 10 * 1024 * 1024) { toast('檔案不能超過 10 MiB。', 'error'); input.value = ''; return; }
  try {
    const response = await fetch('/api/chat/files?cap=' + encodeURIComponent(chatCapability), { method: 'POST', body: file, headers: { 'x-file-name': file.name, 'content-type': file.type || 'application/octet-stream' } });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || '檔案傳送失敗。');
    input.value = '';
  } catch (error) { toast(error.message, 'error'); }
  input.addEventListener('change', uploadChatFile, { once: true });
}

async function loadApp() {
  const [user, settings, mailboxResult] = await Promise.all([api('/api/auth/me'), api('/api/settings'), api('/api/mailboxes')]);
  state.user = user; state.csrf = user.csrf || state.csrf; state.settings = settings; state.mailboxes = mailboxResult.mailboxes;
  await refreshMessages();
}

async function refreshMessages() {
  try {
    const folder = state.folder;
    const params = new URLSearchParams({ folder, q: state.search });
    const result = await api(`/api/messages?${params}`);
    state.messages = result.messages;
    state.counts = result.counts;
    state.settings = { ...state.settings, usage: (await api('/api/status')).usage };
    if (state.selectedId) await selectMessage(state.selectedId, false);
    renderShell();
  } catch (error) { toast(error.message, 'error'); }
}

async function selectMessage(id, rerender = true) {
  state.selectedId = id;
  try {
    const result = await api(`/api/messages/${encodeURIComponent(id)}`);
    state.selected = result.message; state.thread = result.thread || [];
  } catch (error) { toast(error.message, 'error'); state.selectedId = null; state.selected = null; }
  if (rerender) renderShell();
}

async function refreshSettings() {
  const [settings, mailboxResult] = await Promise.all([api('/api/settings'), api('/api/mailboxes')]);
  state.settings = settings; state.mailboxes = mailboxResult.mailboxes;
}

function openCompose({ draft = null, reply = null, forward = null } = {}) {
  const source = draft || reply || forward || {};
  const recipients = source.recipients || [];
  const to = draft ? recipients.filter((item) => item.kind === 'to').map((item) => item.address).join(', ') : reply ? source.sender : forward ? '' : '';
  const cc = draft ? recipients.filter((item) => item.kind === 'cc').map((item) => item.address).join(', ') : '';
  const bcc = draft ? recipients.filter((item) => item.kind === 'bcc').map((item) => item.address).join(', ') : '';
  const original = reply || forward;
  const quote = original ? `\n\n${reply ? '────── 原始郵件 ──────\n' : '────── 轉寄郵件 ──────\n'}${original.text || original.html?.replace(/<[^>]*>/gu, ' ') || ''}` : '';
  const defaultFrom = draft?.sender || state.mailboxes[0]?.address || '';
  const html = `<div class="modal-scrim" data-action="close-compose"><section class="compose-window" role="dialog" aria-modal="true" aria-labelledby="compose-title"><header class="compose-head"><div><p class="eyebrow">NEW MESSAGE</p><h2 id="compose-title">${reply ? '回覆郵件' : forward ? '轉寄郵件' : draft ? '編輯草稿' : '撰寫郵件'}</h2></div><button class="icon-button" data-action="close-compose" title="關閉">×</button></header><form id="compose-form"><label class="compose-line"><span>寄件人</span><select name="from" required>${state.mailboxes.map((mailbox) => `<option value="${escapeHtml(mailbox.address)}" ${mailbox.address === defaultFrom ? 'selected' : ''}>${escapeHtml(mailbox.address)}</option>`).join('')}</select></label><label class="compose-line"><span>收件人</span><input name="to" value="${escapeHtml(to)}" placeholder="name@example.com，多位請用逗號分隔" required /></label><details class="cc-fields" ${cc || bcc ? 'open' : ''}><summary>副本與密件副本</summary><label class="compose-line"><span>副本</span><input name="cc" value="${escapeHtml(cc)}" placeholder="name@example.com" /></label><label class="compose-line"><span>密件副本</span><input name="bcc" value="${escapeHtml(bcc)}" placeholder="name@example.com" /></label></details><label class="compose-line"><span>主旨</span><input name="subject" value="${escapeHtml(draft?.subject || (forward ? `Fwd: ${forward.subject}` : reply ? `Re: ${reply.subject}` : ''))}" placeholder="郵件主旨" required /></label><textarea name="text" class="compose-body" placeholder="寫下你的郵件…" required>${escapeHtml(draft?.text || '')}${escapeHtml(quote)}</textarea><div class="compose-foot"><label class="attach-action">⌕ 附加檔案<input type="file" name="files" multiple /></label><span id="attachment-note">附件總計上限 10 MiB</span><div class="compose-spacer"></div><button type="button" class="button button-quiet" data-action="save-draft">存成草稿</button><button class="button button-primary" type="submit">寄出　↗</button></div><input type="hidden" name="draftId" value="${escapeHtml(draft?.id || '')}" /><input type="hidden" name="replyToId" value="${escapeHtml(reply?.externalId || '')}" /><input type="hidden" name="replyToThread" value="${escapeHtml(reply?.threadId || reply?.id || '')}" /></form></section></div>`;
  document.querySelector('#modal-root').innerHTML = html;
  const scrim = document.querySelector('.modal-scrim');
  scrim.addEventListener('click', (event) => { if (event.target === scrim || event.target.closest('[data-action="close-compose"]')) document.querySelector('#modal-root').innerHTML = ''; });
  const form = document.querySelector('#compose-form');
  form.addEventListener('change', () => {
    const files = [...form.elements.files.files]; const total = files.reduce((sum, file) => sum + file.size, 0);
    document.querySelector('#attachment-note').textContent = files.length ? `${files.length} 個檔案 · ${formatBytes(total)} / 10 MiB` : '附件總計上限 10 MiB';
  });
  form.addEventListener('submit', (event) => { event.preventDefault(); submitCompose(form, false); });
  form.querySelector('[data-action="save-draft"]').addEventListener('click', () => submitCompose(form, true));
  form.querySelector('input[name="to"]').focus();
}

async function readFileData(file) {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error(`讀取 ${file.name} 失敗。`)); reader.readAsDataURL(file); });
}

async function submitCompose(form, saveOnly) {
  const data = new FormData(form);
  const files = [...form.elements.files.files];
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (!saveOnly && total > 10 * 1024 * 1024) return toast('所有附件合計不可超過 10 MiB。', 'error');
  const payload = Object.fromEntries(['from', 'to', 'cc', 'bcc', 'subject', 'text', 'draftId', 'replyToId', 'replyToThread'].map((key) => [key, String(data.get(key) || '')]));
  const button = form.querySelector('button[type="submit"]'); if (button) button.disabled = true;
  try {
    if (saveOnly) {
      const path = payload.draftId ? `/api/drafts/${encodeURIComponent(payload.draftId)}` : '/api/drafts';
      await api(path, { method: payload.draftId ? 'PUT' : 'POST', body: JSON.stringify(payload) });
      toast(files.length ? '草稿已儲存；附件不會保存在草稿中，之後請重新附加。' : '草稿已儲存。');
    } else {
      payload.attachments = await Promise.all(files.map(async (file) => ({ name: file.name, type: file.type, data: await readFileData(file) })));
      const result = await api('/api/send', { method: 'POST', body: JSON.stringify(payload) });
      toast(result.warning || '郵件已寄出。', result.warning ? 'error' : 'success');
    }
    document.querySelector('#modal-root').innerHTML = '';
    await refreshSettings(); await refreshMessages(); renderShell();
  } catch (error) { if (button) button.disabled = false; toast(error.message, 'error'); }
}

function bindShell() {
  document.querySelectorAll('[data-folder]').forEach((button) => button.addEventListener('click', async () => {
    state.folder = button.dataset.folder; state.page = 'mail'; state.selectedId = null; state.selected = null; state.search = '';
    await refreshMessages();
  }));
  document.querySelectorAll('[data-page]').forEach((button) => button.addEventListener('click', async () => {
    state.page = button.dataset.page; state.selectedId = null; state.selected = null;
    if (state.page === 'addresses' || state.page === 'settings') await refreshSettings();
    if (state.page === 'chat') await refreshChatState();
    renderShell();
  }));
  document.querySelectorAll('[data-message]').forEach((row) => {
    row.addEventListener('click', async (event) => {
      if (event.target.closest('[data-action="star"]')) return;
      const message = state.messages.find((item) => item.id === row.dataset.message);
      if (message?.folder === 'drafts') {
        try { const result = await api(`/api/messages/${encodeURIComponent(message.id)}`); openCompose({ draft: result.message }); }
        catch (error) { toast(error.message, 'error'); }
      } else await selectMessage(row.dataset.message);
    });
    row.addEventListener('keydown', (event) => { if (event.key === 'Enter') row.click(); });
  });
  const search = document.querySelector('#search-input');
  let timer;
  search.addEventListener('input', () => { state.search = search.value; clearTimeout(timer); timer = setTimeout(refreshMessages, 250); });
  document.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', handleAction));
  const mailboxForm = document.querySelector('#mailbox-form');
  mailboxForm?.addEventListener('submit', async (event) => {
    event.preventDefault(); const form = new FormData(mailboxForm); const address = `${form.get('localPart')}@${state.settings.emailDomain}`;
    try { await api('/api/mailboxes', { method: 'POST', body: JSON.stringify({ address, label: form.get('label') }) }); toast(`已建立 ${address}`); await refreshSettings(); renderShell(); }
    catch (error) { toast(error.message, 'error'); }
  });
  document.querySelector('#settings-form')?.addEventListener('submit', async (event) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    try { await api('/api/settings', { method: 'PUT', body: JSON.stringify(Object.fromEntries(form.entries())) }); toast('設定已儲存。'); await refreshSettings(); renderShell(); }
    catch (error) { toast(error.message, 'error'); }
  });
  document.querySelector('#chat-settings-form')?.addEventListener('submit', async (event) => {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    try { await api('/api/chat/admin/settings', { method: 'POST', body: JSON.stringify({ allowFiles: data.has('allowFiles'), allowExtensions: data.get('allowExtensions'), denyExtensions: data.get('denyExtensions'), maxFileBytes: Number(data.get('maxFileMiB')) * 1024 * 1024, messageIntervalMs: Number(data.get('messageIntervalMs')) }) }); toast('聊天室設定已儲存。'); await refreshChatState(); renderShell(); }
    catch (error) { toast(error.message, 'error'); }
  });
  startChatPolling();
}

async function handleAction(event) {
  const button = event.currentTarget; const action = button.dataset.action; const id = button.dataset.id || state.selectedId;
  if (action === 'compose') return openCompose();
  if (action === 'close-compose') { if (event.target === button || button.classList.contains('icon-button')) document.querySelector('#modal-root').innerHTML = ''; return; }
  if (action === 'refresh') return refreshMessages();
  if (action === 'back-list') { state.selectedId = null; state.selected = null; return renderShell(); }
  if (action === 'toggle-nav') return document.querySelector('#sidebar').classList.toggle('nav-open');
  if (action === 'logout') {
    try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); } catch { /* expired cookie still gets cleared below */ }
    location.reload(); return;
  }
  if (action === 'open-settings') { state.page = 'settings'; await refreshSettings(); renderShell(); return; }
  if (action === 'star' || action === 'star-current') {
    const item = state.messages.find((message) => message.id === id) || state.selected;
    if (!item) return;
    try { await api(`/api/messages/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ isStarred: !item.isStarred }) }); await refreshMessages(); }
    catch (error) { toast(error.message, 'error'); } return;
  }
  if (action === 'archive' || action === 'trash') {
    if (!id) return;
    try { await api(`/api/messages/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ folder: action === 'archive' ? 'archive' : 'trash' }) }); state.selected = null; state.selectedId = null; await refreshMessages(); }
    catch (error) { toast(error.message, 'error'); } return;
  }
  if (action === 'toggle-read') {
    if (!id) return;
    try { await api(`/api/messages/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ isRead: false }) }); await refreshMessages(); }
    catch (error) { toast(error.message, 'error'); } return;
  }
  if (action === 'delete-permanently') {
    if (!id || !confirm('永久刪除這封郵件和它的附件？此操作無法還原。')) return;
    try { await api(`/api/messages/${encodeURIComponent(id)}`, { method: 'DELETE' }); state.selected = null; state.selectedId = null; await refreshMessages(); }
    catch (error) { toast(error.message, 'error'); } return;
  }
  if (action === 'reply' || action === 'forward') { if (state.selected) openCompose({ [action]: state.selected }); return; }
  if (action === 'delete-mailbox') {
    if (!confirm('刪除這個郵件地址？既有郵件會保留。')) return;
    try { await api(`/api/mailboxes/${encodeURIComponent(button.dataset.id)}`, { method: 'DELETE' }); await refreshSettings(); renderShell(); }
    catch (error) { toast(error.message, 'error'); } return;
  }
  if (action === 'copy') { await navigator.clipboard.writeText(button.dataset.copy || ''); toast('已複製。'); return; }
  if (action === 'enable-chat' || action === 'disable-chat' || action === 'rotate-chat') {
    const endpoint = action === 'enable-chat' ? 'enable' : action === 'disable-chat' ? 'disable' : 'rotate';
    if (endpoint === 'disable' && !confirm('關閉聊天室並刪除所有聊天記錄和檔案？')) return;
    try { const result = await api(`/api/chat/admin/${endpoint}`, { method: 'POST', body: '{}' }); state.chatCode = result.code || ''; await refreshChatState(); renderShell(); }
    catch (error) { toast(error.message, 'error'); } return;
  }
  if (action === 'copy-chat') { if (state.chatCode) { await navigator.clipboard.writeText(`${location.origin}/privchat/${state.chatCode}`); toast('聊天室邀請連結已複製。'); } return; }
}

async function refreshChatState() {
  const result = await api('/api/chat/admin/status');
  state.chatCode = result.enabled ? result.code : '';
  if (state.settings) state.settings.chat = { ...state.settings.chat, allowFiles: result.allowFiles, allowExtensions: result.allowExtensions, denyExtensions: result.denyExtensions, maxFileBytes: result.maxFileBytes, messageIntervalMs: result.messageIntervalMs };
  return result;
}

let chatPollTimer;
function startChatPolling() {
  clearInterval(chatPollTimer);
  if (state.page !== 'chat') return;
  chatPollTimer = setInterval(async () => {
    const old = state.chatCode;
    try { await refreshChatState(); if (state.page === 'chat' && old !== state.chatCode) renderShell(); } catch { /* keep the last displayed status during a transient error */ }
  }, 5000);
}

async function boot() {
  const privateMatch = location.pathname.match(/^\/privchat\/(\d{6})\/?$/u);
  if (privateMatch) return renderPublicChat(privateMatch[1]);
  try {
    const setup = await api('/api/setup/status');
    if (!setup.configured) return authScreen({ mode: 'setup', host: setup.suggestedDomain });
    try {
      const user = await api('/api/auth/me'); state.user = user; state.csrf = user.csrf || '';
      await loadApp(); renderShell();
    } catch (error) {
      if (/登入|session|先登入/iu.test(error.message)) return authScreen({ mode: 'login' });
      return authScreen({ mode: 'login', message: error.message });
    }
  } catch (error) {
    authScreen({ mode: 'setup', host: location.hostname, message: `資料庫尚未就緒：${error.message}。請先完成 README 的 D1 migration 和 Worker 設定。` });
  }
}

document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); document.querySelector('#search-input')?.focus(); }
  if (event.key === 'Escape') document.querySelector('#modal-root').innerHTML = '';
});

boot();
