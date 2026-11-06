// Creates or completes server/.env.
//
//   npm run init-env -- you@example.com
//
// - New project: writes server/.env with fresh random secrets and your admin email.
// - Upgrading: keeps your existing server/.env and only adds the missing ADMIN_EMAIL / ADMIN_SETUP_CODE lines.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, 'server', '.env');

const email = process.argv.slice(2).find((a) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a));
const setupCode = crypto.randomBytes(9).toString('hex'); // 18 characters
const hint = 'Run:  npm run init-env -- you@example.com   (use the email you will log in as admin with)';

if (!fs.existsSync(envPath)) {
  const lines = [
    'PORT=5000',
    'MONGO_URI=mongodb://127.0.0.1:27017/chatbro',
    `JWT_SECRET=${crypto.randomBytes(48).toString('hex')}`,
    `ADMIN_EMAIL=${email || ''}`,
    `ADMIN_SETUP_CODE=${setupCode}`,
    'CLIENT_ORIGIN=http://localhost:5173',
    'MAX_FILE_MB=100',
    '',
  ];
  fs.writeFileSync(envPath, lines.join('\n'), { mode: 0o600 });
  console.log('Created server/.env');
  console.log(`Admin setup code (needed once, to create the admin account): ${setupCode}`);
  if (!email) console.log(`\nADMIN_EMAIL is empty. ${hint}`);
  process.exit(0);
}

// Upgrading an existing project: only add what is missing.
let text = fs.readFileSync(envPath, 'utf8');
const has = (key) => new RegExp(`^${key}=\\S`, 'm').test(text);
const add = [];

if (!has('ADMIN_EMAIL')) {
  if (email) add.push(`ADMIN_EMAIL=${email}`);
  else console.log(`server/.env has no ADMIN_EMAIL. ${hint}`);
}
if (!has('ADMIN_SETUP_CODE')) add.push(`ADMIN_SETUP_CODE=${setupCode}`);

if (add.length === 0) {
  console.log('server/.env already has everything it needs, leaving it as it is.');
} else {
  if (!text.endsWith('\n')) text += '\n';
  fs.writeFileSync(envPath, `${text}${add.join('\n')}\n`);
  console.log(`Updated server/.env: added ${add.map((l) => l.split('=')[0]).join(', ')}`);
  if (add.some((l) => l.startsWith('ADMIN_SETUP_CODE'))) {
    console.log(`Admin setup code (needed once, only if the admin account does not exist yet): ${setupCode}`);
  }
}
