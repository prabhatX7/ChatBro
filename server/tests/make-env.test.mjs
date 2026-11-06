import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/make-env.mjs');

// Runs the script inside a throw-away project folder so the real server/.env is never touched.
function inSandbox(existingEnv, args = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatbro-env-'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.mkdirSync(path.join(dir, 'server'));
  fs.copyFileSync(script, path.join(dir, 'scripts', 'make-env.mjs'));
  const envPath = path.join(dir, 'server', '.env');
  if (existingEnv !== null) fs.writeFileSync(envPath, existingEnv);
  const out = execFileSync(process.execPath, [path.join(dir, 'scripts', 'make-env.mjs'), ...args], { encoding: 'utf8' });
  const text = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  fs.rmSync(dir, { recursive: true, force: true });
  return { out, text };
}

test('fresh install: writes secrets, the admin email and a setup code', () => {
  const { text } = inSandbox(null, ['boss@example.com']);
  assert.match(text, /^JWT_SECRET=[a-f0-9]{96}$/m);
  assert.match(text, /^ADMIN_EMAIL=boss@example\.com$/m);
  assert.match(text, /^ADMIN_SETUP_CODE=[a-f0-9]{18}$/m);
  assert.doesNotMatch(text, /INVITE_CODE/);
});

test('upgrade: keeps the old settings (including the old invite code) and only adds what is missing', () => {
  const old = 'PORT=5000\nJWT_SECRET=' + 'x'.repeat(64) + '\nINVITE_CODE=ddc8fb150aa9\nMAX_FILE_MB=100\n';
  const { text, out } = inSandbox(old, ['boss@example.com']);
  assert.ok(text.startsWith(old), 'existing lines must stay exactly as they were');
  assert.match(text, /^ADMIN_EMAIL=boss@example\.com$/m);
  assert.match(text, /^ADMIN_SETUP_CODE=[a-f0-9]{18}$/m);
  assert.match(out, /Updated server\/\.env/);
});

test('upgrade without an email: adds the setup code and tells you how to set the email', () => {
  const { text, out } = inSandbox('JWT_SECRET=' + 'x'.repeat(64) + '\n');
  assert.doesNotMatch(text, /^ADMIN_EMAIL=/m);
  assert.match(out, /init-env -- you@example\.com/);
});

test('running it again changes nothing', () => {
  const complete = 'JWT_SECRET=' + 'x'.repeat(64) + '\nADMIN_EMAIL=boss@example.com\nADMIN_SETUP_CODE=abcdef123456\n';
  const { text, out } = inSandbox(complete, ['other@example.com']);
  assert.equal(text, complete);
  assert.match(out, /already has everything/);
});

test('a file without a trailing newline is handled', () => {
  const { text } = inSandbox('JWT_SECRET=' + 'x'.repeat(64), ['boss@example.com']);
  assert.match(text, /x\nADMIN_EMAIL=boss@example\.com\n/);
});
