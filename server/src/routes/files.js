import crypto from 'node:crypto';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import User from '../models/User.js';
import { config } from '../config.js';
import { requireAuth, wrap } from '../middleware/auth.js';

const FILE_ID = /^[a-f0-9]{32}$/;

// Files arrive already encrypted by the sender's browser; the server stores opaque bytes
// under a random id (no name, no type, no extension).
const storage = multer.diskStorage({
  destination: config.uploadDir,
  filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex')),
});
const upload = multer({
  storage,
  limits: { fileSize: config.maxFileMB * 1024 * 1024 + 1024, files: 1 }, // +1 KB for the GCM tag
});

const r = Router();
r.use(requireAuth);

r.post('/', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  res.status(201).json({ fileId: req.file.filename });
});

// Only a participant of a message that references the file may download it.
r.get(
  '/:id',
  wrap(async (req, res) => {
    const { id } = req.params;
    if (!FILE_ID.test(id)) return res.status(400).json({ error: 'Bad id' });
    const allowed = await User.exists({ _id: req.userId, 'messages.fileId': id });
    if (!allowed) return res.status(404).json({ error: 'Not found' });

    res.set({
      'Content-Type': 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
    res.sendFile(path.join(config.uploadDir, id));
  })
);

export default r;
