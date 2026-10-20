import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { receiveWebhook, sendMessage } from '../src/worker/mail.js';

class D1Statement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async first() {
    return this.database.sqlite.prepare(this.sql).get(...this.values) ?? null;
  }

  async all() {
    return { results: this.database.sqlite.prepare(this.sql).all(...this.values) };
  }

  async run() {
    const result = this.database.sqlite.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

class TestD1 {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
    this.sqlite.exec(readFileSync(new URL('../migrations/0002_private_chat.sql', import.meta.url), 'utf8'));
  }

  prepare(sql) {
    return new D1Statement(this, sql);
  }

  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try {
      const results = statements.map((statement) => this.sqlite.prepare(statement.sql).run(...statement.values));
      this.sqlite.exec('COMMIT');
      return results;
    } catch (cause) {
      this.sqlite.exec('ROLLBACK');
      throw cause;
    }
  }

  close() {
    this.sqlite.close();
  }
}

function seedMailbox(database) {
  const now = Date.now();
  database.sqlite.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('email_domain', 'mail.example.test', now);
  database.sqlite.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('sender_name', 'Jason Mail', now);
  database.sqlite.prepare('INSERT INTO mailboxes (id, address, label, created_at) VALUES (?, ?, ?, ?)')
    .run('box-01', 'hello@mail.example.test', 'Hello', now);
}

function authenticatedRequest(path, body) {
  const token = 'local-test-session-token';
  const csrf = 'local-test-csrf-token';
  const hash = createHash('sha256').update(token).digest('hex');
  const now = Date.now();
  return {
    request: new Request(`https://mail.example.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `jm_session=${token}`, 'x-csrf-token': csrf },
      body: JSON.stringify(body),
    }),
    seed(database) {
      database.sqlite.prepare('INSERT INTO sessions (id_hash, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?)')
        .run(hash, csrf, now + 60_000, now);
    },
  };
}

function webhookSecret() {
  return `whsec_${Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1)).toString('base64')}`;
}

test('sends mail through the configured provider and saves it in Sent', async (t) => {
  const database = new TestD1();
  t.after(() => database.close());
  seedMailbox(database);
  const auth = authenticatedRequest('/api/send', {
    from: 'hello@mail.example.test',
    to: 'friend@example.org',
    subject: 'Hello from Jason Mail',
    text: 'This is a local test.',
  });
  auth.seed(database);
  let providerUrl = '';
  let providerPayload;
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    providerUrl = String(input);
    providerPayload = JSON.parse(init.body);
    return Response.json({ id: 're_local_message_01' });
  });

  const response = await sendMessage(auth.request, { DB: database, FILES: {}, RESEND_API_KEY: 're_test_local_only' });
  const sent = database.sqlite.prepare('SELECT direction, folder, sender, subject, text_body, external_id FROM messages').get();

  assert.equal(response.status, 200);
  assert.equal(providerUrl, 'https://api.resend.com/emails');
  assert.deepEqual(providerPayload.to, ['friend@example.org']);
  assert.equal(providerPayload.from, 'Jason Mail <hello@mail.example.test>');
  assert.equal(sent.direction, 'outbound');
  assert.equal(sent.folder, 'sent');
  assert.equal(sent.external_id, 're_local_message_01');
  assert.equal(sent.text_body, 'This is a local test.');
});

test('stores a valid Resend inbound webhook in the matching inbox', async (t) => {
  const database = new TestD1();
  t.after(() => database.close());
  seedMailbox(database);
  const secret = webhookSecret();
  const emailId = '5aa00000-0000-4000-8000-000000000002';
  const payload = {
    type: 'email.received',
    created_at: '2026-10-20T10:00:00.000Z',
    data: {
      email_id: emailId,
      from: 'friend@example.org',
      to: ['hello@mail.example.test'],
      cc: [],
      subject: 'A message for Jason',
    },
  };
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = String(input);
    if (url.endsWith('/attachments')) return Response.json({ object: 'list', data: [] });
    return Response.json({ data: {
      from: 'friend@example.org',
      to: ['hello@mail.example.test'],
      subject: 'A message for Jason',
      text: 'This is an inbound test.',
      html: '<p>This is an inbound test.</p>',
      created_at: '2026-10-20T10:00:00.000Z',
      headers: {},
    } });
  });

  const response = await receiveWebhook(await signedWebhook(secret, payload), {
    DB: database,
    FILES: { put: async () => undefined, delete: async () => undefined },
    RESEND_API_KEY: 're_test_local_only',
    RESEND_WEBHOOK_SECRET: secret,
  });
  const saved = database.sqlite.prepare('SELECT direction, folder, sender, subject, text_body, external_id FROM messages').get();

  assert.equal(response.status, 200);
  assert.equal(saved.direction, 'inbound');
  assert.equal(saved.folder, 'inbox');
  assert.equal(saved.sender, 'friend@example.org');
  assert.equal(saved.subject, 'A message for Jason');
  assert.equal(saved.text_body, 'This is an inbound test.');
  assert.equal(saved.external_id, emailId);
});

async function signedWebhook(secret, payload) {
  const id = 'msg_local_test_01';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = JSON.stringify(payload);
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`));
  const headers = {
    'content-type': 'application/json',
    'svix-id': id,
    'svix-timestamp': timestamp,
    'svix-signature': `v1,${Buffer.from(signature).toString('base64')}`,
  };
  return new Request('https://mail.example.test/api/webhooks/resend', { method: 'POST', headers, body: rawBody });
}

test('logs the provider reason when a valid inbound webhook fails so it can be diagnosed', async (t) => {
  const database = new TestD1();
  t.after(() => database.close());
  const secret = webhookSecret();
  const payload = {
    type: 'email.received',
    data: {
      email_id: '5aa00000-0000-4000-8000-000000000001',
      from: 'friend@example.org',
      to: ['hello@mail.example.test'],
      subject: 'Local diagnostic check',
    },
  };
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 401 }));
  const log = t.mock.method(console, 'error', () => undefined);

  const response = await receiveWebhook(await signedWebhook(secret, payload), {
    DB: database,
    FILES: { put: async () => undefined, delete: async () => undefined },
    RESEND_API_KEY: 're_test_local_only',
    RESEND_WEBHOOK_SECRET: secret,
  });

  assert.equal(response.status, 503);
  const logged = log.mock.calls.flatMap((call) => call.arguments).join(' ');
  assert.match(logged, /Resend 回應 401/u);
});

