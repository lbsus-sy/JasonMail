import { access, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { platform } from 'node:os';

const required = [
  'public/index.html',
  'public/app.js',
  'public/styles.css',
  'src/worker/index.js',
  'src/worker/durable/ChatRoom.js',
  'migrations/0001_initial.sql',
  'migrations/0002_private_chat.sql',
  'README.md',
];

for (const file of required) {
  await access(new URL(`../${file}`, import.meta.url));
}

const config = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
if (!config.includes('"main": "src/worker/index.js"')) {
  throw new Error('wrangler.jsonc must point to src/worker/index.js');
}

console.log(`Jason Mail source check passed (${required.length} required files).`);

const result = spawnSync('wrangler', ['deploy', '--dry-run'], {
  stdio: 'inherit',
  shell: platform() === 'win32',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
