# PartCheck AI – photo inspection with PASS / FAIL

A web app where a user picks (or creates) an item, photographs it from several views,
and Azure OpenAI (gpt-4o vision) checks whether every required spare part is visible.
Result: **PASS** (100% confirmed), **FAIL** (part missing or serious damage) or **REVIEW** (unclear photos).

## Features
- **NEW – Scaffolding inspection module** (tab on the first screen): 15-check fixed scaffold and 12-check mobile tower
  checklists, scaffold details (type, duty, height, lifts, erector), critical safety checks and a GREEN / YELLOW / RED tag
- **NEW – Flash (torch) control** in photo mode and live scan: Off / On / Auto (auto fires when the scene is dark)
- **NEW – Click photo during live scan**: the round button takes a photo at once, checks it, and keeps it as proof
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
  verify.js     live scan: second check of OK results before the final result
  live.js       one live camera frame -> which pending parts are visible now
  evaluate.js   photos + checklist -> AI -> PASS/FAIL
  suggest.js    item name -> suggested checklist
  render3d.js   photos -> AI 3D-style render (optional)
  health.js     server status
lib/common.js   Azure OpenAI calls, auth, errors
lib/checks.js   strict check rules + scaffolding knowledge shared by all AI calls
lib/verify.js   skeptical second-check (audit) call
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
| `MIN_CONFIDENCE` | no | `0.7` (default) |
| `STRICT_VERIFY` | no | `1` (default) – second AI check of every OK result. `0` = off |

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

## Scaffolding module
Open the **Scaffolding inspection** tab, pick a checklist, fill the scaffold details, then use Live scan or Photo mode.

**Fixed scaffold (tube / cuplock) – 15 checks** (⚠ = critical)
| View | Checks |
|---|---|
| Base & foundation | ⚠ Base plates · ⚠ Sole boards / firm ground · Standards plumb |
| Full elevation | ⚠ Ledgers & transoms · ⚠ Bracing · ⚠ Ties to structure |
| Working platform | ⚠ Fully boarded · ⚠ Guardrail · ⚠ Mid rail · ⚠ Toe boards · Platform clear |
| Access ladder | ⚠ Ladder secured, ~1 m above landing |
| Scaffold tag | Tag / status board displayed |
| Any view | ⚠ Couplers / clamps · Tube condition |

**Mobile tower – 12 checks:** castor brakes, firm ground, outriggers, frames & braces, tower vertical, platform & trapdoor,
guardrails, toe boards, internal access, tag (critical ones marked ⚠).

**Tag rules:** PASS → GREEN · FAIL → RED · REVIEW with any critical check Not OK / Unclear → RED · other REVIEW → YELLOW.
Inspector override to PASS → GREEN. Write `!` at the start of any checklist line to make it critical, e.g.
`! Guardrail :: top guardrail on every open side`. The AI prompt gets scaffold terms and rules (sole boards vs bricks,
gaps in boards, open edges, bent tubes, loose couplers).

> AI result is a pre-inspection aid only, **not a scaffold certificate**. A competent person must inspect and sign the
> tag before use, as per your site rules and local standards (e.g. IS 3696 / IS 4014 in India, OSHA 1926.451, BS EN 12811).

## Accuracy: checks, not just parts (important)
Each checklist line is a **check that must be TRUE**, not just a part name.

| Write this | AI checks |
|---|---|
| `USB port` | the port is physically there |
| `USB cable :: plugged fully into a USB port of the laptop` | a plug is **visibly inside** the port – an empty port = Not OK |
| `Screen :: no cracks or dead areas` | screen visible and undamaged |
| `Earthing wire :: connected and tightened at the earth terminal` | the connection state |

Use `name :: rule` for anything about **connected / plugged / fitted / closed / switched on / no damage**.
Just writing "USB" only checks that a USB port exists – that is why a laptop without a cable used to PASS.
See the built-in example item **Laptop setup (cables connected)**.

How a PASS is protected:
1. The AI must write what it actually sees (evidence) before giving a verdict, with strict rules (empty port = false, hidden = unclear).
2. Live scan uses majority voting: a check is OK only after TRUE in 2+ frames and more TRUE than FALSE frames.
3. **Second check**: every OK result is re-checked by a skeptical second AI review on the exact frame/photo it was seen in.
   If that review disagrees, the check becomes Not OK or Unclear. (Costs one extra AI call per inspection.)
4. Confidence below `MIN_CONFIDENCE` (0.7) never counts as OK.

Tips: take a close-up view for small things like ports and plugs (a separate view "Left side ports"), use good light/flash,
and keep the inspector override for final sign-off.

## Flash and click photo
- **⚡ Flash button** cycles Off → On → Auto. The setting is shared by both modes and remembered on the device.
  Auto turns the torch on after ~0.7 s of darkness, off after ~2 s of strong light, and fires it just before a click
  in a dark scene. Uses the browser torch API: works in Chrome on most Android phones; most iPhone browsers do not
  allow it, so the button shows "not supported" there.
- **Click photo in live scan**: works even when auto scan is paused (so you can do click-only inspections with live hints).
  The photo is sent to the AI straight away and always becomes the proof photo of its view (📷 in the checklist,
  🎞 = auto frame). Tap a view in the checklist to lock clicks to it (📌); otherwise the view is taken from what
  the AI sees, or the next pending view.

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
