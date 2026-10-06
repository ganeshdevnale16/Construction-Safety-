import { checkAuth, requirePost, getBody, chatJSON, cleanText, sendError, HttpError } from '../lib/common.js';

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['angles', 'general_parts'],
  properties: {
    angles: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'guidance', 'parts'],
        properties: {
          name: { type: 'string' },
          guidance: { type: 'string' },
          parts: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    general_parts: { type: 'array', items: { type: 'string' } },
  },
};

export default async function handler(req, res) {
  if (!requirePost(req, res) || !checkAuth(req, res)) return;
  try {
    const body = getBody(req);
    const item = cleanText(body.item, 120);
    const description = cleanText(body.description, 600);
    if (!item) throw new HttpError(400, 'Enter an item name first.');

    const out = await chatJSON({
      name: 'checklist',
      schema,
      messages: [
        {
          role: 'system',
          content:
            'You design photo-inspection checklists for field technicians. ' +
            'Return 3 to 6 camera views (angles) that together show the whole item. ' +
            'For each view give a short name (e.g. "Front", "Left side", "Inside - door open"), ' +
            'one sentence of guidance on how to frame the photo, and 2 to 6 concrete, visually checkable ' +
            'components or spare parts that should be visible from that view. ' +
            'Put parts that could be visible from several views in general_parts (0 to 4 items). ' +
            'Use short, plain part names. Do not invent brand names.',
        },
        { role: 'user', content: `Item: ${item}\n${description ? 'Details: ' + description : ''}` },
      ],
    });

    const angles = (out.angles || []).slice(0, 8).map((a) => ({
      name: cleanText(a.name, 60),
      guidance: cleanText(a.guidance, 200),
      parts: (a.parts || []).map((p) => cleanText(p, 80)).filter(Boolean).slice(0, 10),
    })).filter((a) => a.name);
    const general_parts = (out.general_parts || []).map((p) => cleanText(p, 80)).filter(Boolean).slice(0, 8);
    res.status(200).json({ angles, general_parts });
  } catch (err) {
    sendError(res, err);
  }
}
