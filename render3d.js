import { checkAuth, requirePost, getBody, imageFromReferences, isImageDataUrl, cleanText, sendError, HttpError } from '../lib/common.js';

export default async function handler(req, res) {
  if (!requirePost(req, res) || !checkAuth(req, res)) return;
  try {
    const body = getBody(req);
    const item = cleanText(body.item, 120) || 'object';
    const images = (Array.isArray(body.images) ? body.images : []).filter(isImageDataUrl).slice(0, 6);
    if (!images.length) throw new HttpError(400, 'Send at least one photo to build the 3D render.');

    const prompt =
      `The reference photos show the same ${item} from different angles. ` +
      `Create one photorealistic 3D product render of the complete ${item} in a three-quarter isometric view, ` +
      'on a plain light-grey studio background with soft shadows. Keep the real shape, colours, proportions, ' +
      'labels and every visible component faithful to the photos. Do not add or remove parts. No text, no watermark.';

    const image = await imageFromReferences({ images, prompt });
    res.status(200).json({ image });
  } catch (err) {
    sendError(res, err);
  }
}
