/**
 * Tiny HTTP server that exposes uploaded photos at a public URL so Civitai
 * can fetch them. The bot writes a file into temp/ and gets back a
 * { publicUrl, dispose } pair; the file is auto-deleted after PHOTO_TTL_SECONDS
 * or when dispose() is called.
 *
 * Why a server instead of base64? Civitai's createVariant takes "image" as a
 * plain URL string and does not document base64 support. Hosting from the VPS
 * is the most reliable path.
 */

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths } from '../utils/paths.mjs';
import { config } from '../config/config.mjs';

const app = express();

// Health check — useful for "is the firewall open?" debugging
app.get('/healthz', (_req, res) => res.type('text/plain').send('ok\n'));

// Serve photos. immutable: once written, content never changes.
app.use(
  '/photos',
  express.static(paths.temp, {
    maxAge: '15m',
    immutable: true,
    fallthrough: true,
    dotfiles: 'deny',
    index: false,
  })
);
app.use('/photos', (_req, res) => res.status(404).type('text/plain').send('not found'));

// Catch-all 404 for everything else
app.use((_req, res) => res.status(404).type('text/plain').send('not found'));

let serverHandle = null;

export function startPhotoHost() {
  if (serverHandle) return serverHandle;
  return new Promise((resolve, reject) => {
    serverHandle = app
      .listen(config.photoHostPort, () => {
        console.log(`[photoHost] listening on :${config.photoHostPort} -> ${config.publicHostUrl}`);
        resolve(serverHandle);
      })
      .on('error', reject);
  });
}

export function stopPhotoHost() {
  if (!serverHandle) return Promise.resolve();
  return new Promise((resolve) => serverHandle.close(() => resolve()));
}

/**
 * Save a Buffer to temp/ and return a publicly accessible URL plus a
 * dispose() helper that deletes the file. Files are also TTL-cleaned in case
 * dispose() is never called (e.g. on a crash).
 */
export function hostPhoto(buffer, ext = 'jpg') {
  const id = crypto.randomBytes(12).toString('hex');
  const filename = `${id}.${ext}`;
  const filepath = path.join(paths.temp, filename);
  fs.writeFileSync(filepath, buffer);

  const publicUrl = `${config.publicHostUrl}/photos/${filename}`;
  let disposed = false;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    fs.promises.unlink(filepath).catch(() => {});
  };

  setTimeout(dispose, config.photoTtlSeconds * 1000).unref();

  return { publicUrl, dispose, filepath };
}

// Sweep on startup: kill any temp files older than the TTL (in case of crash-restart)
export function sweepStaleTempFiles() {
  const cutoff = Date.now() - config.photoTtlSeconds * 1000;
  for (const name of fs.readdirSync(paths.temp)) {
    const f = path.join(paths.temp, name);
    try {
      const stat = fs.statSync(f);
      if (stat.isFile() && stat.mtimeMs < cutoff) fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
}
