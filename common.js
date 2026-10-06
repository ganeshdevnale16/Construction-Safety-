// Shared helpers used by every API route (works on Vercel functions and Express).
// Primary provider: Azure OpenAI. Fallback: OpenAI (only if Azure vars are missing).

// Read an env var in UPPER_CASE or lower_case (e.g. AZURE_OPENAI_ENDPOINT or azure_openai_endpoint).
function env(name, fallback = '') {
  return process.env[name] ?? process.env[name.toLowerCase()] ?? fallback;
}

const AZ = {
  endpoint: env('AZURE_OPENAI_ENDPOINT'),
  key: env('AZURE_OPENAI_API_KEY'),
  deployment: env('AZURE_OPENAI_DEPLOYMENT', 'gpt-4o'),
  version: env('AZURE_OPENAI_API_VERSION', '2024-10-21'),
  // Optional: a separate Azure deployment of gpt-image-1 for the AI 3D render feature.
  imageDeployment: env('AZURE_OPENAI_IMAGE_DEPLOYMENT'),
  imageVersion: env('AZURE_OPENAI_IMAGE_API_VERSION', '2025-04-01-preview'),
};
const OPENAI_KEY = env('OPENAI_API_KEY');

export const PROVIDER = AZ.endpoint && AZ.key ? 'azure' : OPENAI_KEY ? 'openai' : 'none';
export const MODEL = PROVIDER === 'azure' ? AZ.deployment : env('OPENAI_MODEL', 'gpt-4o');
export const RENDER_ENABLED =
  PROVIDER === 'azure' ? Boolean(AZ.imageDeployment) : PROVIDER === 'openai';
export const MIN_CONFIDENCE = Number(env('MIN_CONFIDENCE', '0.7'));
// Second-opinion check of every OK result (more accurate, ~1 extra AI call). Set STRICT_VERIFY=0 to switch off.
export const STRICT_VERIFY = !/^(0|false|off|no)$/i.test(env('STRICT_VERIFY', '1'));

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Optional protection so strangers can't spend your Azure credits. Set APP_PASSWORD to switch it on.
export function checkAuth(req, res) {
  const pw = env('APP_PASSWORD');
  if (!pw) return true;
  if (req.headers['x-app-password'] === pw) return true;
  res.status(401).json({ error: 'App password is missing or wrong. Open Settings and enter it.' });
  return false;
}

export function requirePost(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST for this endpoint.' });
    return false;
  }
  return true;
}

export function getBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { throw new HttpError(400, 'Body is not valid JSON.'); }
  }
  return req.body;
}

// Accepts "https://name.openai.azure.com", with or without trailing slash or extra path.
function azureBase() {
  try { return new URL(AZ.endpoint).origin; }
  catch { throw new HttpError(500, 'AZURE_OPENAI_ENDPOINT is not a valid URL.'); }
}

function chatTarget() {
  if (PROVIDER === 'azure') {
    return {
      url: `${azureBase()}/openai/deployments/${encodeURIComponent(AZ.deployment)}/chat/completions?api-version=${AZ.version}`,
      headers: { 'api-key': AZ.key },
      model: undefined, // Azure picks the model from the deployment name
    };
  }
  if (PROVIDER === 'openai') {
    return {
      url: 'https://api.openai.com/v1/chat/completions',
      headers: { Authorization: `Bearer ${OPENAI_KEY}` },
      model: MODEL,
    };
  }
  throw new HttpError(500, 'No AI provider configured. Set the AZURE_OPENAI_* variables on the server.');
}

function upstreamError(status, data) {
  const msg = data?.error?.message || `AI service returned status ${status}`;
  if (status === 401 || status === 403) return new HttpError(502, 'The AI service rejected the API key or endpoint. Check AZURE_OPENAI_API_KEY and AZURE_OPENAI_ENDPOINT.');
  if (status === 404) return new HttpError(502, 'Deployment not found. Check AZURE_OPENAI_DEPLOYMENT and AZURE_OPENAI_API_VERSION. ' + msg);
  if (status === 429) return new HttpError(429, 'Rate limit or quota reached. Wait a minute and try again. ' + msg);
  if (status === 400) return new HttpError(400, 'The AI service could not process the request: ' + msg);
  return new HttpError(502, msg);
}

async function postChat(body) {
  const t = chatTarget();
  const r = await fetch(t.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...t.headers },
    body: JSON.stringify(t.model ? { model: t.model, ...body } : body),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

// Chat call that returns JSON matching `schema`.
// Tries strict structured outputs first; if the API version / model doesn't support it,
// retries in plain JSON mode with the schema written into the prompt.
export async function chatJSON({ messages, schema, name, maxTokens = 4000 }) {
  let res = await postChat({
    messages,
    temperature: 0,
    max_tokens: maxTokens,
    response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } },
  });

  const unsupported =
    !res.ok && res.status === 400 && /response_format|json_schema/i.test(res.data?.error?.message || '');
  if (unsupported) {
    const withSchema = [
      ...messages.slice(0, 1),
      { role: 'system', content: 'Reply ONLY with a JSON object that follows this JSON Schema exactly:\n' + JSON.stringify(schema) },
      ...messages.slice(1),
    ];
    res = await postChat({ messages: withSchema, temperature: 0, max_tokens: maxTokens, response_format: { type: 'json_object' } });
  }
  if (!res.ok) throw upstreamError(res.status, res.data);

  const choice = res.data.choices?.[0];
  if (choice?.finish_reason === 'content_filter') throw new HttpError(422, 'Azure content filter blocked this request. Try different photos.');
  if (choice?.message?.refusal) throw new HttpError(422, 'The AI declined to analyse these images: ' + choice.message.refusal);
  try {
    return JSON.parse(choice?.message?.content || '');
  } catch {
    throw new HttpError(502, 'The AI reply was not valid JSON. Try again.');
  }
}

// Several reference photos -> one generated "3D product render" (needs gpt-image-1).
export async function imageFromReferences({ images, prompt, size = '1024x1024', quality = 'medium' }) {
  if (!RENDER_ENABLED) {
    throw new HttpError(501, 'AI 3D render is off. Deploy gpt-image-1 in Azure and set AZURE_OPENAI_IMAGE_DEPLOYMENT.');
  }
  let url, headers;
  const form = new FormData();
  if (PROVIDER === 'azure') {
    url = `${azureBase()}/openai/deployments/${encodeURIComponent(AZ.imageDeployment)}/images/edits?api-version=${AZ.imageVersion}`;
    headers = { 'api-key': AZ.key };
  } else {
    url = 'https://api.openai.com/v1/images/edits';
    headers = { Authorization: `Bearer ${OPENAI_KEY}` };
    form.append('model', env('OPENAI_IMAGE_MODEL', 'gpt-image-1'));
  }
  form.append('prompt', prompt);
  form.append('size', size);
  form.append('quality', quality);
  const field = images.length > 1 ? 'image[]' : 'image';
  images.forEach((dataUrl, i) => {
    const { mime, buffer } = decodeDataUrl(dataUrl);
    const ext = mime.split('/')[1] === 'jpeg' ? 'jpg' : mime.split('/')[1] || 'jpg';
    form.append(field, new Blob([buffer], { type: mime }), `view-${i + 1}.${ext}`);
  });

  const r = await fetch(url, { method: 'POST', headers, body: form });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw upstreamError(r.status, data);
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new HttpError(502, 'The image service did not return an image.');
  return `data:image/png;base64,${b64}`;
}

export function decodeDataUrl(dataUrl) {
  const m = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(dataUrl || '');
  if (!m) throw new HttpError(400, 'Each image must be a base64 data URL.');
  return { mime: m[1].toLowerCase(), buffer: Buffer.from(m[2], 'base64') };
}

export function isImageDataUrl(v) {
  return typeof v === 'string' && /^data:image\/[a-z+.-]+;base64,/i.test(v);
}

export function cleanText(v, max = 200) {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function sendError(res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Unexpected server error.' });
}
