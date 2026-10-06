import {
  checkAuth, requirePost, getBody, chatJSON, isImageDataUrl, cleanText,
  sendError, HttpError, MODEL, PROVIDER, MIN_CONFIDENCE,
} from '../lib/common.js';

const partSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'status', 'confidence', 'note'],
  properties: {
    name: { type: 'string' },
    status: { type: 'string', enum: ['present', 'missing', 'unclear'] },
    confidence: { type: 'number' },
    note: { type: 'string' },
  },
};

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['item_identified', 'item_matches', 'summary', 'angles', 'general_parts', 'defects', 'recommendations'],
  properties: {
    item_identified: { type: 'string' },
    item_matches: { type: 'boolean' },
    summary: { type: 'string' },
    angles: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['angle', 'correct_view', 'image_quality', 'quality_issues', 'parts', 'observations'],
        properties: {
          angle: { type: 'string' },
          correct_view: { type: 'boolean' },
          image_quality: { type: 'string', enum: ['good', 'acceptable', 'poor'] },
          quality_issues: { type: 'array', items: { type: 'string' } },
          parts: { type: 'array', items: partSchema },
          observations: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    general_parts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'status', 'confidence', 'found_in', 'note'],
        properties: {
          name: { type: 'string' },
          status: { type: 'string', enum: ['present', 'missing', 'unclear'] },
          confidence: { type: 'number' },
          found_in: { type: 'string' },
          note: { type: 'string' },
        },
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
    recommendations: { type: 'array', items: { type: 'string' } },
  },
};

const SYSTEM = `You are a strict visual quality inspector. You check photos of one physical item against a required-parts checklist.
Rules:
- Mark a part "present" only if you can clearly see it in the photo for that view.
- Mark "missing" if that area is clearly visible but the part is not there.
- Mark "unclear" if the area is blocked, cropped, blurry, too dark, too far, or you are not sure. Never guess.
- Never assume a part exists just because this kind of item normally has it.
- confidence is 0 to 1: how sure you are about the status you chose.
- Use the EXACT part names and view names given to you. Report every listed part.
- For each view, say whether the photo really shows the requested view (correct_view) and rate image quality.
- Record visible damage: cracks, dents, rust, burns, leaks, loose or cut wires, missing screws, broken seals.
- Ignore the small timestamp strip at the bottom of each photo.
- item_matches is false if the photos show a different kind of item than the one named.
Write notes in short, simple English.`;

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function cleanList(arr, max = 20, len = 80) {
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
  return {
    item,
    description: cleanText(body.description, 600),
    angles,
    general_parts: cleanList(body.general_parts, 10),
  };
}

function buildMessages(input) {
  const shot = input.angles.filter((a) => a.image);
  const checklist = {
    item: input.item,
    details: input.description || undefined,
    views: shot.map((a) => ({ view: a.name, how_it_should_look: a.guidance || undefined, required_parts: a.parts })),
    parts_visible_from_any_view: input.general_parts,
  };
  const content = [
    { type: 'text', text: 'Inspection checklist:\n' + JSON.stringify(checklist, null, 2) + '\n\nPhotos follow, one per view.' },
  ];
  shot.forEach((a) => {
    content.push({ type: 'text', text: `Photo for view: "${a.name}"` });
    content.push({ type: 'image_url', image_url: { url: a.image, detail: 'high' } });
  });
  return [{ role: 'system', content: SYSTEM }, { role: 'user', content }];
}

// Merge the AI answer back onto the requested checklist and apply fixed rules.
function score(ai, input) {
  const aiAngles = Array.isArray(ai.angles) ? ai.angles : [];
  const shot = input.angles.filter((a) => a.image);
  const checklist = [];

  const effective = (rp) => {
    if (!rp) return { status: 'unclear', confidence: 0, note: 'Not reported by AI' };
    const conf = Math.max(0, Math.min(1, Number(rp.confidence) || 0));
    let status = rp.status;
    let note = cleanText(rp.note, 200);
    if (status === 'present' && conf < MIN_CONFIDENCE) {
      status = 'unclear';
      note = (note ? note + ' ' : '') + `(low confidence ${Math.round(conf * 100)}%)`;
    }
    return { status, confidence: conf, note };
  };

  input.angles.forEach((a) => {
    if (!a.image) {
      a.parts.forEach((p) => checklist.push({ group: a.name, part: p, status: 'missing', confidence: 1, note: 'This view was not photographed' }));
      return;
    }
    const idx = shot.indexOf(a);
    const ra = aiAngles.find((x) => norm(x.angle) === norm(a.name)) || aiAngles[idx] || { parts: [] };
    a.parts.forEach((p) => {
      const rp = (ra.parts || []).find((x) => norm(x.name) === norm(p));
      checklist.push({ group: a.name, part: p, ...effective(rp) });
    });
  });

  const aiGeneral = Array.isArray(ai.general_parts) ? ai.general_parts : [];
  input.general_parts.forEach((p) => {
    const rp = aiGeneral.find((x) => norm(x.name) === norm(p));
    checklist.push({ group: 'Any view', part: p, foundIn: cleanText(rp?.found_in, 60), ...effective(rp) });
  });

  const total = checklist.length;
  const present = checklist.filter((c) => c.status === 'present').length;
  const missing = checklist.filter((c) => c.status === 'missing').length;
  const unclear = total - present - missing;
  const completion = total ? Math.round((present / total) * 100) : 100;

  const defects = Array.isArray(ai.defects) ? ai.defects : [];
  const highDefects = defects.filter((d) => d.severity === 'high');
  const badViews = aiAngles.filter((a) => a.correct_view === false).map((a) => a.angle);
  const poorViews = aiAngles.filter((a) => a.image_quality === 'poor').map((a) => a.angle);

  const reasons = [];
  if (missing) reasons.push(`${missing} required part${missing > 1 ? 's' : ''} missing`);
  if (highDefects.length) reasons.push(`${highDefects.length} serious defect${highDefects.length > 1 ? 's' : ''} found`);
  if (unclear) reasons.push(`${unclear} part${unclear > 1 ? 's' : ''} could not be confirmed`);
  if (poorViews.length) reasons.push(`Poor photo quality: ${poorViews.join(', ')}`);
  if (badViews.length) reasons.push(`Wrong view captured: ${badViews.join(', ')}`);
  if (ai.item_matches === false) reasons.push(`Photos look like "${cleanText(ai.item_identified, 80)}", not "${input.item}"`);

  let status = 'PASS';
  if (missing || highDefects.length) status = 'FAIL';
  else if (unclear || poorViews.length || badViews.length || ai.item_matches === false) status = 'REVIEW';
  if (status === 'PASS') reasons.push('All required parts confirmed');

  return { status, completion, counts: { total, present, missing, unclear }, reasons, checklist };
}

export default async function handler(req, res) {
  if (!requirePost(req, res) || !checkAuth(req, res)) return;
  try {
    const input = validate(getBody(req));
    const ai = await chatJSON({ name: 'inspection', schema, messages: buildMessages(input) });
    const result = score(ai, input);
    res.status(200).json({
      ...result,
      ai,
      provider: PROVIDER,
      model: MODEL,
      minConfidence: MIN_CONFIDENCE,
      evaluatedAt: new Date().toISOString(),
    });
  } catch (err) {
    sendError(res, err);
  }
}
