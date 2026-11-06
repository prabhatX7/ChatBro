import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load server/.env no matter which folder the server is started from.
dotenv.config({ path: path.resolve(__dirname, '../.env') });

function required(name, hint = 'Copy server/.env.example to server/.env and fill it in.') {
  const value = (process.env[name] || '').trim();
  if (!value) {
    console.error(`Missing ${name} in server/.env. ${hint}`);
    process.exit(1);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT) || 5000,
  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/chatbro',
  jwtSecret: required('JWT_SECRET'),

  // The account with this email is the admin. The admin's password is whatever they choose when they sign up
  // (it is never stored on the server, because the browser uses it to unlock the encryption keys).
  adminEmail: required(
    'ADMIN_EMAIL',
    'Add a line like ADMIN_EMAIL=you@example.com (or run: npm run init-env -- you@example.com).'
  ).toLowerCase(),

  // A secret only the admin knows. Needed once, to create the admin account, so nobody else can grab that email first.
  adminSetupCode: (process.env.ADMIN_SETUP_CODE || '').trim(),

  // Old single invite code from before groups existed. On the first start after upgrading it becomes the code of
  // the "Original group" that your existing members are moved into. It is not used for anything else.
  legacyInviteCode: (process.env.INVITE_CODE || '').trim(),

  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  maxFileMB: Number(process.env.MAX_FILE_MB) || 100,
  uploadDir: path.resolve(__dirname, '../uploads'),
  clientDist: path.resolve(__dirname, '../../client/dist'),
};

if (config.jwtSecret.length < 32) {
  console.error('JWT_SECRET must be at least 32 characters.');
  process.exit(1);
}
if (config.adminSetupCode && config.adminSetupCode.length < 8) {
  console.error('ADMIN_SETUP_CODE must be at least 8 characters.');
  process.exit(1);
}
