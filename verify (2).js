// SECOND OPINION: a skeptical re-check of every check that was marked OK.
// A check only stays OK if this second look also says TRUE. This removes most false PASS results.
import { chatJSON, cleanText, MIN_CONFIDENCE } from './common.js';
import { STRICT_RULES, moduleHints } from './checks.js';

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'evidence', 'verdict', 'confidence'],
        properties: {
          id: { type: 'string' },
          evidence: { type: 'string' },
          verdict: { type: 'string', enum: ['true', 'false', 'unclear'] },
          confidence: { type: 'number' },
        },
      },
    },
  },
};

const SYSTEM = `You are a strict SECOND inspector doing a final audit.
Another inspector claims every statement below is TRUE. Many of these claims are wrong.
For each claim, look again very carefully at the photo it refers to and actively try to find evidence that it is FALSE
(e.g. the port is empty, the plug is not fully inserted, the part is a different part, the part is hidden).
Answer "true" only if the photo clearly proves the statement.
${STRICT_RULES}
Return one result for EVERY claim id. Ignore the small timestamp strip at the bottom of photos.`;

/**
 * frames: [{ label, url }]   – images (data URLs), max ~8
 * claims: [{ id, statement, frame }]  – frame = label of the photo to look at ('' = any photo)
 * returns Map(id -> { status, confidence, evidence })
 */
export async function verifyClaims({ item, description, frames, claims, module = '' }) {
  const out = new Map();
  if (!claims.length || !frames.length) return out;

  const content = [{
    type: 'text',
    text: `Item: ${item}${description ? '\nDetails: ' + description : ''}\n\nClaims to audit:\n` +
      JSON.stringify(claims.map((c) => ({ id: c.id, statement: c.statement, look_in: c.frame || 'any photo' })), null, 1),
  }];
  frames.forEach((f) => {
    content.push({ type: 'text', text: `Photo: "${f.label}"` });
    content.push({ type: 'image_url', image_url: { url: f.url, detail: 'high' } });
  });

  const ai = await chatJSON({
    name: 'audit',
    schema,
    maxTokens: 2500,
    messages: [{ role: 'system', content: SYSTEM + moduleHints(module) }, { role: 'user', content }],
  });

  (Array.isArray(ai.results) ? ai.results : []).forEach((r) => {
    const id = String(r.id || '');
    if (!claims.some((c) => c.id === id) || out.has(id)) return;
    const confidence = Math.max(0, Math.min(1, Number(r.confidence) || 0));
    let status = r.verdict === 'true' ? 'present' : r.verdict === 'false' ? 'missing' : 'unclear';
    if (status === 'present' && confidence < MIN_CONFIDENCE) status = 'unclear';
    // a "false" from the auditor with very low confidence is treated as unclear, not a hard fail
    if (status === 'missing' && confidence < 0.5) status = 'unclear';
    out.set(id, { status, confidence, evidence: cleanText(r.evidence, 200) });
  });
  // claims the auditor skipped are NOT confirmed
  claims.forEach((c) => { if (!out.has(c.id)) out.set(c.id, { status: 'unclear', confidence: 0, evidence: 'Not confirmed in second check' }); });
  return out;
}
