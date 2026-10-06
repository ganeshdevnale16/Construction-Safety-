// LIVE SCAN: one camera frame -> verdicts for the checks that are still open.
// Only checks the AI can actually judge in THIS frame are returned. Unseen checks are left out.
import {
  checkAuth, requirePost, getBody, chatJSON, isImageDataUrl, cleanText,
  sendError, HttpError, MIN_CONFIDENCE,
} from '../lib/common.js';
import { statement, moduleHints, STRICT_RULES } from '../lib/checks.js';

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['item_visible', 'view', 'frame_quality', 'hint', 'detections', 'defects'],
  properties: {
    item_visible: { type: 'boolean' },
    view: { type: 'string' },
    frame_quality: { type: 'string', enum: ['good', 'acceptable', 'poor'] },
    hint: { type: 'string' },
    detections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'evidence', 'verdict', 'confidence', 'box'],
        properties: {
          id: { type: 'string' },
          evidence: { type: 'string' },
          verdict: { type: 'string', enum: ['true', 'false'] },
          confidence: { type: 'number' },
          // [x, y, width, height] as fractions 0-1 of the frame. [0,0,0,0] if not sure where.
          box: { type: 'array', items: { type: 'number' } },
        },
      },
    },
    defects: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['description', 'severity'],
        properties: {
          description: { type: 'string' },
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
      },
    },
  },
};

const SYSTEM = `You are a strict live visual inspector looking at ONE frame from a phone camera moving around an item.
For each open check, decide if THIS frame proves it TRUE or proves it FALSE.
${STRICT_RULES}
Live-scan rules:
- If a check cannot be judged from this frame (area not in view, too small, blurry), DO NOT include it at all.
- Include a check as "false" only if the exact spot is clearly in view and the statement is clearly not true
  (e.g. the USB port is clearly visible and it is empty).
- box = location of the spot you judged as [x, y, width, height], fractions 0-1 of the frame. [0,0,0,0] if unsure.
- view = which listed view the camera shows now (exact name), or "unknown".
- item_visible = false if the frame does not show the item at all.
- hint = ONE short instruction (max 8 words) for the user, e.g. "Move closer to the USB port". Empty if nothing to say.
- defects: only clearly visible damage. Empty if none.`;

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));

function validate(body) {
  const item = cleanText(body.item, 120);
  if (!item) throw new HttpError(400, 'Item name is required.');
  if (!isImageDataUrl(body.frame)) throw new HttpError(400, 'A camera frame is required.');
  if (body.frame.length > 1_500_000) throw new HttpError(413, 'Frame is too large.');
  const pending = (Array.isArray(body.pending) ? body.pending : []).slice(0, 80).map((p, i) => ({
    id: 'c' + (i + 1),
    view: cleanText(p?.view, 60),
    part: cleanText(p?.part, 300),
  })).filter((p) => p.view && p.part);
  const views = (Array.isArray(body.views) ? body.views : []).map((v) => cleanText(v, 60)).filter(Boolean).slice(0, 12);
  const viewHint = cleanText(body.viewHint, 60);
  const module = ['scaffold'].includes(body.module) ? body.module : '';
  return { item, module, description: cleanText(body.description, 900), pending, views, frame: body.frame, viewHint: views.includes(viewHint) ? viewHint : '' };
}

export default async function handler(req, res) {
  if (!requirePost(req, res) || !checkAuth(req, res)) return;
  try {
    const input = validate(getBody(req));
    const byView = {};
    input.pending.forEach((p) => { (byView[p.view] ||= []).push({ id: p.id, must_be_true: statement(p.part) }); });
    const task = {
      item: input.item,
      details: input.description || undefined,
      all_views: input.views,
      open_checks: Object.entries(byView).map(([view, checks]) => ({ view, checks })),
      note: 'Checks under "Any view" can be judged from any view.',
      user_says_this_photo_shows_view: input.viewHint || undefined,
    };

    const ai = await chatJSON({
      name: 'live_frame',
      schema,
      maxTokens: 1200,
      messages: [
        { role: 'system', content: SYSTEM + moduleHints(input.module) },
        { role: 'user', content: [
          { type: 'text', text: 'Checklist:\n' + JSON.stringify(task) },
          { type: 'image_url', image_url: { url: input.frame, detail: 'high' } },
        ] },
      ],
    });

    const byId = new Map(input.pending.map((p) => [p.id, p]));
    const seen = new Set();
    const detections = [];
    (Array.isArray(ai.detections) ? ai.detections : []).forEach((d) => {
      const p = byId.get(String(d.id || ''));
      if (!p || seen.has(p.id)) return;
      const confidence = clamp01(d.confidence);
      if (confidence < MIN_CONFIDENCE) return; // not sure -> ignore this frame for that check
      seen.add(p.id);
      const b = Array.isArray(d.box) ? d.box.slice(0, 4).map(clamp01) : [0, 0, 0, 0];
      while (b.length < 4) b.push(0);
      detections.push({
        key: p.view + '|' + p.part, view: p.view, part: p.part,
        status: d.verdict === 'true' ? 'present' : 'missing',
        confidence,
        evidence: cleanText(d.evidence, 160),
        box: b[2] > 0.01 && b[3] > 0.01 ? b : null,
      });
    });

    const viewMatch = input.views.find((v) => norm(v) === norm(ai.view));
    res.status(200).json({
      itemVisible: ai.item_visible !== false,
      view: viewMatch || null,
      frameQuality: ['good', 'acceptable', 'poor'].includes(ai.frame_quality) ? ai.frame_quality : 'acceptable',
      hint: cleanText(ai.hint, 80),
      detections,
      defects: (Array.isArray(ai.defects) ? ai.defects : []).slice(0, 5).map((d) => ({
        description: cleanText(d.description, 160),
        severity: ['low', 'medium', 'high'].includes(d.severity) ? d.severity : 'low',
      })).filter((d) => d.description),
      minConfidence: MIN_CONFIDENCE,
    });
  } catch (err) {
    sendError(res, err);
  }
}
