import { PROVIDER, MODEL, RENDER_ENABLED, MIN_CONFIDENCE } from '../lib/common.js';

// Lists only the NAMES of missing variables (never their values) to help with setup.
const REQUIRED = ['AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_DEPLOYMENT', 'AZURE_OPENAI_API_VERSION'];
const has = (n) => Boolean(process.env[n] || process.env[n.toLowerCase()]);

export default function handler(req, res) {
  const missing = PROVIDER === 'openai' ? [] : REQUIRED.filter((n) => !has(n));
  res.status(200).json({
    ok: PROVIDER !== 'none' && missing.length === 0,
    provider: PROVIDER,
    model: MODEL,
    missing,
    renderEnabled: RENDER_ENABLED,
    minConfidence: MIN_CONFIDENCE,
    passwordRequired: has('APP_PASSWORD'),
    passwordSet: has('APP_PASSWORD'),
  });
}
