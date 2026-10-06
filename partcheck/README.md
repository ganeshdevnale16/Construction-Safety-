# PartCheck AI – photo inspection with PASS / FAIL

A web app where a user picks (or creates) an item, photographs it from several views,
and Azure OpenAI (gpt-4o vision) checks whether every required spare part is visible.
Result: **PASS** (100% confirmed), **FAIL** (part missing or serious damage) or **REVIEW** (unclear photos).

## Features
- **NEW – Live scan mode**: keep the camera on and move around the item. Parts are ticked off automatically,
  boxes show where the AI saw them, and the scan auto-finishes at 100% (see *Live scan* below)
- Ready-made items + **custom items** with views (Front, Back, Inside…) and required parts per view
- **"Suggest checklist with AI"** – type an item name, AI proposes views and parts
- Guided capture like face-KYC: yellow frame, view name, live **light / blur check**, retake
- Works with live camera or **Upload photo** (on phones this opens the camera)
- Timestamp, item name and optional **GPS watermark** on every photo (anti-fraud)
- AI evaluation per part: present / missing / unclear + confidence %, wrong-view and photo-quality detection, damage report, recommendations
- **Server decides PASS/FAIL with fixed rules** (AI only reports what it sees); low-confidence "present" counts as unclear
- Inspector **override** with remarks
- **360° viewer** (drag through captured views) + optional **AI 3D render** (gpt-image-1)
- Print / save as PDF, export CSV and JSON
- History saved on the device, optional **app password** to protect your Azure credits

## Project structure
```
api/            serverless API routes (Vercel) – also used by render-server.js
  live.js       one live camera frame -> which pending parts are visible now
  evaluate.js   photos + checklist -> AI -> PASS/FAIL
  suggest.js    item name -> suggested checklist
  render3d.js   photos -> AI 3D-style render (optional)
  health.js     server status
lib/common.js   Azure OpenAI calls, auth, errors
public/         the web app (index.html, styles.css, app.js)
render-server.js  Express server for Render.com and local use
vercel.json, render.yaml, .env.example
```

## 1. Azure setup
1. In Azure AI Foundry / Azure OpenAI, deploy **gpt-4o** (version 2024-08-06 or newer). Note the deployment name.
2. Copy the endpoint (`https://<resource>.openai.azure.com`) and an API key.
3. API version: use `2024-10-21` (or any version from `2024-08-01-preview` onward). Older versions still work through a JSON-mode fallback.
4. *(Optional, for the 3D render)* Deploy **gpt-image-1** (needs access approval from Microsoft) and set `AZURE_OPENAI_IMAGE_DEPLOYMENT` to its deployment name.

## 2. Environment variables
| Variable | Required | Example |
|---|---|---|
| `AZURE_OPENAI_ENDPOINT` | yes | `https://myres.openai.azure.com` |
| `AZURE_OPENAI_API_KEY` | yes | `xxxxxxxx` |
| `AZURE_OPENAI_DEPLOYMENT` | yes | `gpt-4o` |
| `AZURE_OPENAI_API_VERSION` | yes | `2024-10-21` |
| `AZURE_OPENAI_IMAGE_DEPLOYMENT` | no | `gpt-image-1` |
| `AZURE_OPENAI_IMAGE_API_VERSION` | no | `2025-04-01-preview` |
| `APP_PASSWORD` | recommended | any secret word |
| `MIN_CONFIDENCE` | no | `0.6` |

Lower-case names (e.g. `azure_openai_endpoint`) also work. **Never put the key in the front-end code.**

## 3. Run locally (Node 20.6+)
```bash
npm install
cp .env.example .env      # fill in your Azure values
npm run dev               # http://localhost:3000
```
Camera preview needs `localhost` or HTTPS. On a phone, open the deployed HTTPS URL.

## 4. Deploy on Vercel
1. Push this folder to a GitHub repo.
2. Vercel → **Add New Project** → import the repo. Framework preset: **Other**. No build command.
3. Add the environment variables above → **Deploy**.
4. Note: Vercel limits a request to **4.5 MB**. The app compresses photos to ~1024 px, which fits about 10 views.
   API routes are allowed 60 s (`vercel.json`).

## 5. Deploy on Render
1. Push to GitHub → Render → **New → Blueprint** (uses `render.yaml`), or **New → Web Service**:
   build `npm install`, start `npm start`.
2. Add the environment variables → deploy.
3. Free plan sleeps when idle; the first request after sleep takes ~30–50 s.

## Live scan – how it works
1. On the phone, every 250 ms the app checks light, blur and movement locally (no AI cost).
2. Only when the camera is **steady and sharp**, one frame (cropped to what you see on screen, ~768 px) goes to `/api/live`.
3. The AI is asked only about parts **not yet confirmed**, so calls get smaller as you go.
4. A part is confirmed when seen in **2 frames**, or once with ≥ 85% confidence. "Missing" also needs 2 frames.
5. The same unchanged scene is sent at most twice – move the camera to continue (saves credits).
6. The best frame of each view is kept (watermarked) as the proof photo in the report.
7. At 100% the scan finishes by itself. **Finish & see result** ends it early; views never shown count as missing.
8. **Run deep check** sends the saved best frames to the normal `/api/evaluate` for a full report.

Speed: Azure gpt-4o answers in about 1.5–4 s, so the checklist updates every few seconds (near-live).
Cost: roughly 1,000–1,500 input tokens per frame; a typical 30–60 s scan uses 15–40 frames.
Tune everything in the `CFG` block at the top of `public/live.js` (frame size, confirm rules, max frames per scan).

For true 30 fps detection (no waiting), train a YOLO model on the proof frames this app collects and run it
in the browser with ONNX Runtime Web / TensorFlow.js – keep gpt-4o only for the final check.

## How PASS / FAIL is decided
- **FAIL**: any required part missing, any view not photographed (its parts count as missing), or a high-severity defect.
- **REVIEW**: nothing missing, but some part is unclear, a photo is poor, a wrong view was captured, or the photos show a different item.
- **PASS**: every required part confirmed present (≥ `MIN_CONFIDENCE`).
- Completion % = present parts ÷ total required parts.

## Tips for accuracy
- Use clear, specific part names ("Red emergency stop button", not "Button").
- One view should show the parts listed for it; add close-up views for small parts.
- Good light, steady hand, fill the yellow frame.
- AI vision can make mistakes – keep the inspector override for final sign-off.

## Next steps (when moving to production / mobile app)
- Store inspections in a database (Supabase / Azure SQL / Cosmos DB) and photos in Azure Blob Storage instead of browser storage
- User login and roles (inspector, supervisor)
- For very high accuracy, train a custom detection model (Azure Custom Vision / YOLO) using the photos collected with this app
- Wrap the same front end into an app (PWA or Capacitor), or rebuild in Flutter / React Native
