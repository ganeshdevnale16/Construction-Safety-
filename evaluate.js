// PHOTO MODE: photos + checklist -> AI first pass -> skeptical second check -> fixed PASS/FAIL rules.
import {
  checkAuth, requirePost, getBody, chatJSON, isImageDataUrl, cleanText,
  sendError, HttpError, MODEL, PROVIDER, MIN_CONFIDENCE, STRICT_VERIFY,
} from '../lib/common.js';
import { statement, parseCheck, moduleHints, STRICT_RULES, VERDICT_TO_STATUS } from '../lib/checks.js';
import { verifyClaims } from '../lib/verify.js';

const checkSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'evidence', 'verdict', 'confidence'],
  properties: {
    id: { type: 'string' },
    evidence: { type: 'string' },
    verdict: { type: 'string', enum: ['true', 'false', 'unclear'] },
    confidence: { type: 'number' },
  },
};

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['item_identified', 'item_matches', 'angles', 'general_checks', 'defects', 'summary', 'recommendations'],
  properties: {
    item_identified: { type: 'string' },
    item_matches: { type: 'boolean' },
    angles: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['angle', 'correct_view', 'image_quality', 'quality_issues', 'checks', 'observations'],
        properties: {
          angle: { type: 'string' },
          correct_view: { type: 'boolean' },
          image_quality: { type: 'string', enum: ['good', 'acceptable', 'poor'] },
          quality_issues: { type: 'array', items: { type: 'string' } },
          checks: { type: 'array', items: checkSchema },
          observations: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    general_checks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'evidence', 'verdict', 'confidence', 'found_in'],
        properties: { ...checkSchema.properties, found_in: { type: 'string' } },
      },
    },
    defects: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['angle', 'description', 'severity'],
        properties: {
          angle: { type: 'string' },
          description: { type: 'string' },
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
      },
    },
    summary: { type: 'string' },
    recommendations: { type: 'array', items: { type: 'string' } },
  },
};

const SYSTEM = `You are a strict visual quality inspector. You check photos of one physical item against a checklist.
${STRICT_RULES}
Other rules:
- Use the exact check ids given. Report EVERY check id of a view in that view's "checks".
- For each view, say whether the photo really shows the requested view (correct_view) and rate image quality.
- Record visible damage: cracks, dents, rust, burns, leaks, loose or cut wires, missing screws, broken seals.
- Ignore the small timestamp strip at the bottom of each photo.
- item_matches is false if the photos show a different kind of item than the one named.
Write evidence and notes in short, simple English.`;

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));

function cleanList(arr, max = 20, len = 300) {
  return (Array.isArray(arr) ? arr : []).map((p) => cleanText(p, len)).filter(Boolean).slice(0, max);
}

function validate(body) {
  const item = cleanText(body.item, 120);
  if (!item) throw new HttpError(400, 'Item name is required.');
  const angles = (Array.isArray(body.angles) ? body.angles : []).slice(0, 12).map((a) => ({
    name: cleanText(a?.name, 60),
    guidance: cleanText(a?.guidance, 200),
    parts: cleanList(a?.parts),
    image: isImageDataUrl(a?.image) ? a.image : null,
  })).filter((a) => a.name);
  if (!angles.some((a) => a.image)) throw new HttpError(400, 'Capture at least one photo before evaluating.');
  const module = ['scaffold'].includes(body.module) ? body.module : '';
  return { item, module, description: cleanText(body.description, 900), angles, general_parts: cleanList(body.general_parts, 10) };
}

// Give every check a short id (v1c1, v1c2, g1 ...) so matching never depends on the AI copying names.
function withIds(input) {
  input.angles.forEach((a, vi) => { a.checks = a.parts.map((p, ci) => ({ id: `v${vi + 1}c${ci + 1}`, part: p, statement: statement(p) })); });
  input.general = input.general_parts.map((p, i) => ({ id: `g${i + 1}`, part: p, statement: statement(p) }));
  return input;
}

function buildMessages(input) {
  const shot = input.angles.filter((a) => a.image);
  const checklist = {
    item: input.item,
    details: input.description || undefined,
    views: shot.map((a) => ({
      view: a.name,
      how_it_should_look: a.guidance || undefined,
      checks: a.checks.map((c) => ({ id: c.id, must_be_true: c.statement })),
    })),
    checks_for_any_view: input.general.map((c) => ({ id: c.id, must_be_true: c.statement })),
  };
  const content = [{ type: 'text', text: 'Inspection checklist:\n' + JSON.stringify(checklist, null, 1) + '\n\nPhotos follow, one per view.' }];
  shot.forEach((a) => {
    content.push({ type: 'text', text: `Photo for view: "${a.name}"` });
    content.push({ type: 'image_url', image_url: { url: a.image, detail: 'high' } });
  });
  return [{ role: 'system', content: SYSTEM + moduleHints(input.module) }, { role: 'user', content }];
}

function firstPass(ai, input) {
  const aiAngles = Array.isArray(ai.angles) ? ai.angles : [];
  const allChecks = [...aiAngles.flatMap((a) => (Array.isArray(a.checks) ? a.checks : [])), ...(Array.isArray(ai.general_checks) ? ai.general_checks : [])];
  const byId = new Map();
  allChecks.forEach((c) => { if (c?.id && !byId.has(c.id)) byId.set(String(c.id), c); });

  const rows = [];
  const fromAI = (c, group, extra = {}) => {
    const r = byId.get(c.id);
    if (!r) return { id: c.id, group, part: c.part, status: 'unclear', confidence: 0, note: 'Not reported by AI', ...extra };
    const confidence = clamp01(r.confidence);
    let status = VERDICT_TO_STATUS[r.verdict] || 'unclear';
    let note = cleanText(r.evidence, 200);
    if (status === 'present' && confidence < MIN_CONFIDENCE) { status = 'unclear'; note += ` (low confidence ${Math.round(confidence * 100)}%)`; }
    return { id: c.id, group, part: c.part, status, confidence, note, ...extra, foundIn: cleanText(r.found_in, 60) || extra.foundIn || '' };
  };
  input.angles.forEach((a) => {
    a.checks.forEach((c) => {
      if (!a.image) rows.push({ id: c.id, group: a.name, part: c.part, status: 'missing', confidence: 1, note: 'This view was not photographed' });
      else rows.push(fromAI(c, a.name));
    });
  });
  input.general.forEach((c) => rows.push(fromAI(c, 'Any view')));
  rows.forEach((r) => { r.critical = parseCheck(r.part).critical; });
  return rows;
}

async function secondCheck(rows, input) {
  const claims = rows.filter((r) => r.status === 'present');
  if (!STRICT_VERIFY || !claims.length) return { ran: false, changed: 0 };
  const frames = input.angles.filter((a) => a.image).map((a) => ({ label: a.name, url: a.image }));
  const stmt = new Map([...input.angles.flatMap((a) => a.checks), ...input.general].map((c) => [c.id, c.statement]));
  const res = await verifyClaims({
    item: input.item, description: input.description, frames, module: input.module,
    claims: claims.map((r) => ({ id: r.id, statement: stmt.get(r.id), frame: r.group === 'Any view' ? (r.foundIn || '') : r.group })),
  });
  let changed = 0;
  claims.forEach((r) => {
    const v = res.get(r.id);
    if (!v || v.status === 'present') { if (v) r.confidence = Math.min(r.confidence, v.confidence); r.note += ' · confirmed by second check'; return; }
    changed++;
    r.status = v.status;
    r.confidence = v.confidence;
    r.note = `Second check: ${v.evidence || (v.status === 'missing' ? 'not true' : 'could not confirm')}`;
  });
  return { ran: true, changed };
}

function decide(rows, ai, verify) {
  const total = rows.length;
  const present = rows.filter((c) => c.status === 'present').length;
  const missing = rows.filter((c) => c.status === 'missing').length;
  const unclear = total - present - missing;
  const completion = total ? Math.round((present / total) * 100) : 100;

  const aiAngles = Array.isArray(ai.angles) ? ai.angles : [];
  const defects = Array.isArray(ai.defects) ? ai.defects : [];
  const highDefects = defects.filter((d) => d.severity === 'high');
  const badViews = aiAngles.filter((a) => a.correct_view === false).map((a) => a.angle);
  const poorViews = aiAngles.filter((a) => a.image_quality === 'poor').map((a) => a.angle);

  const reasons = [];
  const critFail = rows.filter((c) => c.critical && c.status === 'missing').length;
  const critUnclear = rows.filter((c) => c.critical && c.status === 'unclear').length;
  if (critFail) reasons.push(`${critFail} CRITICAL safety check${critFail > 1 ? 's' : ''} failed`);
  if (missing) reasons.push(`${missing} check${missing > 1 ? 's' : ''} failed`);
  if (critUnclear) reasons.push(`${critUnclear} critical check${critUnclear > 1 ? 's' : ''} not confirmed`);
  if (highDefects.length) reasons.push(`${highDefects.length} serious defect${highDefects.length > 1 ? 's' : ''} found`);
  if (unclear) reasons.push(`${unclear} check${unclear > 1 ? 's' : ''} could not be confirmed`);
  if (poorViews.length) reasons.push(`Poor photo quality: ${poorViews.join(', ')}`);
  if (badViews.length) reasons.push(`Wrong view captured: ${badViews.join(', ')}`);
  if (ai.item_matches === false) reasons.push(`Photos look like "${cleanText(ai.item_identified, 80)}", not the selected item`);
  if (verify.changed) reasons.push(`Second check overturned ${verify.changed} first-pass OK result${verify.changed > 1 ? 's' : ''}`);

  let status = 'PASS';
  if (missing || highDefects.length) status = 'FAIL';
  else if (unclear || poorViews.length || badViews.length || ai.item_matches === false) status = 'REVIEW';
  if (status === 'PASS') reasons.push(verify.ran ? 'All checks confirmed twice' : 'All checks confirmed');
  return { status, completion, counts: { total, present, missing, unclear }, reasons };
}

export default async function handler(req, res) {
  if (!requirePost(req, res) || !checkAuth(req, res)) return;
  try {
    const input = withIds(validate(getBody(req)));
    const ai = await chatJSON({ name: 'inspection', schema, messages: buildMessages(input) });
    const checklist = firstPass(ai, input);
    const verify = await secondCheck(checklist, input);
    const decision = decide(checklist, ai, verify);
    // keep "angle" names in the AI block aligned to the requested names for the result screen
    (ai.angles || []).forEach((a) => { const m = input.angles.find((x) => norm(x.name) === norm(a.angle)); if (m) a.angle = m.name; });
    res.status(200).json({
      ...decision,
      checklist,
      ai,
      provider: PROVIDER,
      model: MODEL,
      minConfidence: MIN_CONFIDENCE,
      secondCheck: verify.ran,
      evaluatedAt: new Date().toISOString(),
    });
  } catch (err) {
    sendError(res, err);
  }
}
