// Server for Render.com and local development.
// (Vercel does NOT use this file; it runs /api/*.js as serverless functions and serves /public.)
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import health from './api/health.js';
import evaluate from './api/evaluate.js';
import suggest from './api/suggest.js';
import render3d from './api/render3d.js';
import live from './api/live.js';
import verify from './api/verify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '25mb' }));
app.all('/api/health', health);
app.all('/api/evaluate', evaluate);
app.all('/api/suggest', suggest);
app.all('/api/render3d', render3d);
app.all('/api/live', live);
app.all('/api/verify', verify);
app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown API route.' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Photos are too large. Retake with fewer or smaller photos.' });
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error.' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`PartCheck AI running on http://localhost:${port}`));
