// LIVE SCAN final step: skeptical second check of every check the live scan marked OK,
// using the exact frames in which each check was seen.
import { checkAuth, requirePost, getBody, isImageDataUrl, cleanText, sendError, HttpError, STRICT_VERIFY, MIN_CONFIDENCE } from '../lib/common.js';
import { statement } from '../lib/checks.js';
import { verifyClaims } from '../lib/verify.js';

export default async function handler(req, res) {
  if (!requirePost(req, res) || !checkAuth(req, res)) return;
  try {
    const body = getBody(req);
    const item = cleanText(body.item, 120);
    if (!item) throw new HttpError(400, 'Item name is required.');
    const frames = (Array.isArray(body.frames) ? body.frames : []).slice(0, 8)
      .filter((f) => isImageDataUrl(f?.url))
      .map((f, i) => ({ label: cleanText(f.label, 40) || `Frame ${i + 1}`, url: f.url }));
    const labels = new Set(frames.map((f) => f.label));
    const claims = (Array.isArray(body.claims) ? body.claims : []).slice(0, 60).map((c, i) => ({
      key: cleanText(c?.key, 400),
      id: 'k' + (i + 1),
      statement: statement(cleanText(c?.part, 300)),
      frame: labels.has(c?.frame) ? c.frame : '',
    })).filter((c) => c.key);
    if (!frames.length || !claims.length) throw new HttpError(400, 'Nothing to verify.');
    if (!STRICT_VERIFY) {
      return res.status(200).json({ skipped: true, results: claims.map((c) => ({ key: c.key, status: 'present', confidence: 1, evidence: '' })) });
    }
    const module = ['scaffold'].includes(body.module) ? body.module : '';
    const out = await verifyClaims({ item, module, description: cleanText(body.description, 900), frames, claims });
    res.status(200).json({
      skipped: false,
      minConfidence: MIN_CONFIDENCE,
      results: claims.map((c) => ({ key: c.key, ...out.get(c.id) })),
    });
  } catch (err) {
    sendError(res, err);
  }
}
