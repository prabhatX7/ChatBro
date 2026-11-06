import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import mongoose from 'mongoose';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { createSocket } from './socket.js';
import authRouter from './routes/auth.js';
import usersRouter from './routes/users.js';
import messagesRouter from './routes/messages.js';
import filesRouter from './routes/files.js';
import adminRouter from './routes/admin.js';
import { bootstrap } from './services/bootstrap.js';

fs.mkdirSync(config.uploadDir, { recursive: true });

const app = express();
const server = http.createServer(app);
const io = createSocket(server);

app.set('trust proxy', 1);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'blob:', 'data:'],
        mediaSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: null,
      },
    },
  })
);
app.use(cors({ origin: config.clientOrigin }));
app.use(express.json({ limit: '200kb' }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in a few minutes.' },
});

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/auth', authLimiter, authRouter(io));
app.use('/api/users', usersRouter(io));
app.use('/api/admin', adminRouter(io));
app.use('/api/messages', messagesRouter(io));
app.use('/api/files', filesRouter);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// In production the built React app is served by this same server.
if (fs.existsSync(config.clientDist)) {
  app.use(express.static(config.clientDist));
  app.use((req, res) => res.sendFile(path.join(config.clientDist, 'index.html')));
}

app.use((err, req, res, next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `File too large (max ${config.maxFileMB} MB)` });
  }
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

try {
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 8000 });
} catch (err) {
  console.error(`Could not connect to MongoDB at ${config.mongoUri}\n${err.message}`);
  process.exit(1);
}

// Make sure the admin account and the groups are in the right state before anyone can connect.
try {
  await bootstrap();
} catch (err) {
  console.error('Start-up check failed:', err);
  process.exit(1);
}

server.listen(config.port, () => {
  console.log(`ChatBro server listening on http://localhost:${config.port}`);
});
