// LIVE SCAN: one camera frame -> which checklist parts are visible right now.
// The browser calls this every ~1-3 s while the camera is steady.
// It only sends the parts that are NOT confirmed yet, so each call stays small and fast.
import {
  checkAuth, requirePost, getBody, chatJSON, isImageDataUrl, cleanText,
  sendError, HttpError, MIN_CONFIDENCE,
} from '../lib/common.js';

const ANY = 'Any view';

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
        required: ['view', 'name', 'status', 'confidence', 'box'],
        properties: {
          view: { type: 'string' },
          name: { type: 'string' },
          status: { type: 'string', enum: ['present', 'missing'] },
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

const SYSTEM = `You are a live visual inspector looking at ONE frame from a phone camera that is moving around an item.
Your job: say which of the listed parts are visible in THIS frame.
Rules:
- Report a part as "present" only if you can clearly see it in this frame.
- Report "missing" only if the exact place where that part belongs is clearly in view and the part is not there.
- If a part is simply not in this frame, or you are not sure, DO NOT report it at all. Never guess.
- Never assume a part exists because this kind of item normally has it.
- Use the EXACT part names and view names from the list. Each detection must name the view the part belongs to.
- confidence is 0 to 1.
- box is the part's location as [x, y, width, height], each a fraction 0-1 of the frame (x,y = top-left). Use [0,0,0,0] if unsure.
- view = which listed view the camera is showing now (exact name), or "unknown".
- item_visible = false if the frame does not show the item at all.
- hint = ONE short instruction (max 8 words) to help the user, e.g. "Move closer to the terminal block", "Too dark, turn on torch", "Now show the left side". Empty string if nothing to say.
- defects: only clearly visible damage (cracks, dents, rust, burns, leaks, loose or cut wires, broken seals). Empty if none.
Keep everything short.`;

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));

function validate(body) {
  const item = cleanText(body.item, 120);
  if (!item) throw new HttpError(400, 'Item name is required.');
  if (!isImageDataUrl(body.frame)) throw new HttpError(400, 'A camera frame is required.');
  if (body.frame.length > 1_500_000) throw new HttpError(413, 'Frame is too large.');
  const pending = (Array.isArray(body.pending) ? body.pending : []).slice(0, 80).map((p) => ({
    view: cleanText(p?.view, 60),
    part: cleanText(p?.part, 80),
  })).filter((p) => p.view && p.part);
  const views = (Array.isArray(body.views) ? body.views : []).map((v) => cleanText(v, 60)).filter(Boolean).slice(0, 12);
  return { item, description: cleanText(body.description, 600), pending, views, frame: body.frame };
}

export default async function handler(req, res) {
  if (!requirePost(req, res) || !checkAuth(req, res)) return;
  try {
    const input = validate(getBody(req));

    // Group pending parts by view for a compact prompt.
    const byView = {};
    input.pending.forEach((p) => { (byView[p.view] ||= []).push(p.part); });
    const task = {
      item: input.item,
      details: input.description || undefined,
      all_views: input.views,
      parts_still_to_find: Object.entries(byView).map(([view, parts]) => ({ view, parts })),
      note: `Parts under "${ANY}" can appear in any view.`,
    };

    const ai = await chatJSON({
      name: 'live_frame',
      schema,
      maxTokens: 700,
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Checklist:\n' + JSON.stringify(task) },
            { type: 'image_url', image_url: { url: input.frame, detail: 'high' } },
          ],
        },
      ],
    });

    // Keep only detections that match a pending part (by view + name). Drop low-confidence ones.
    const lookup = new Map(input.pending.map((p) => [norm(p.view) + '|' + norm(p.part), p]));
    const byName = new Map();
    input.pending.forEach((p) => { const k = norm(p.part); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(p); });

    const detections = [];
    const seen = new Set();
    (Array.isArray(ai.detections) ? ai.detections : []).forEach((d) => {
      let p = lookup.get(norm(d.view) + '|' + norm(d.name));
      // Fallback: AI got the view wrong but the part name is unique in the checklist.
      if (!p) { const list = byName.get(norm(d.name)); if (list?.length === 1) p = list[0]; }
      if (!p) return;
      const key = p.view + '|' + p.part;
      if (seen.has(key)) return;
      const confidence = clamp01(d.confidence);
      if (confidence < MIN_CONFIDENCE) return;
      seen.add(key);
      const b = Array.isArray(d.box) ? d.box.slice(0, 4).map(clamp01) : [0, 0, 0, 0];
      while (b.length < 4) b.push(0);
      detections.push({
        key, view: p.view, part: p.part,
        status: d.status === 'missing' ? 'missing' : 'present',
        confidence,
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
