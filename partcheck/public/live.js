/* PartCheck AI – LIVE SCAN mode
   Camera stays on. The phone checks light / blur / movement locally every 250 ms
   (like face-KYC "hold steady"). When the picture is steady and shows something new,
   one frame is sent to /api/live. Parts are ticked off the checklist as the AI sees them.
   When every part is found -> auto finish -> same result screen as photo mode. */
(() => {
  'use strict';
  const PC = window.PartCheck;
  if (!PC) return;
  const { $, $$, esc, toast } = PC;

  // ---------- tuning (change these if needed) ----------
  const CFG = {
    AI_SIDE: 768,            // frame size sent to the AI (bigger = sees small parts better, but slower)
    EVIDENCE_SIDE: 1024,     // frame size kept as proof photo in the report
    JPEG_Q: 0.72,
    SAMPLE_MS: 250,          // local quality / motion check interval
    MIN_GAP_MS: 900,         // minimum time between two AI calls
    STEADY_SAMPLES: 2,       // camera must be steady for this many samples before sending
    MOTION_MAX: 10,          // 0-255 mean pixel change; below = steady
    SAME_SCENE: 7,           // change vs last sent frame below this = same scene
    SAME_SCENE_REPEAT: 2,    // max AI calls on an unchanged scene (saves credits)
    CONFIRM_HITS: 2,         // part confirmed when seen in this many frames...
    STRONG_CONF: 0.85,       // ...or once with confidence >= this
    MISSING_HITS: 2,         // "missing" needs this many frames (or one strong one)
    MAX_CALLS: 150,          // safety cap per scan (protects Azure credits)
    TIMEOUT_MS: 20000,
    BOX_TTL: 2200,           // how long a detection box stays on screen
  };
  const ANY = 'Any view';

  // ---------- live state ----------
  const L = {
    stream: null, track: null, facing: 'environment', torch: false,
    timer: null, paused: false, busy: false, abort: null, active: false,
    parts: new Map(), order: [], viewsSeen: new Set(), viewBest: {},
    defects: new Map(), calls: 0, notVisible: 0, startedAt: 0, elapsed: 0,
    lastSendAt: 0, lastSentSig: null, sameScene: 0, prevSig: null, steady: 0,
    boxes: [], currentView: null, hint: '', lastErrAt: 0, finishing: false, minConfidence: null,
  };

  const video = $('#lvVideo');
  const overlay = $('#lvOverlay');
  const stage = $('#lvStage');

  // ---------- start a new live inspection ----------
  $('#btnLive').addEventListener('click', () => {
    try { PC.newRecord('live'); } catch (e) { toast(e.message, true); return; }
    resetTallies();
    PC.show('live');
    renderAll();
    startCamera();
  });

  function resetTallies() {
    const cur = PC.state.cur;
    L.parts.clear(); L.order = [];
    cur.angles.forEach((a) => a.parts.forEach((p) => addPart(a.name, p)));
    (cur.general_parts || []).forEach((p) => addPart(ANY, p));
    Object.assign(L, {
      viewsSeen: new Set(), viewBest: {}, defects: new Map(), calls: 0, notVisible: 0,
      elapsed: 0, startedAt: 0, lastSendAt: 0, lastSentSig: null, sameScene: 0, prevSig: null,
      steady: 0, boxes: [], currentView: null, hint: '', paused: false, finishing: false,
    });
    $('#lvDone').hidden = true;
  }
  function addPart(view, part) {
    const key = view + '|' + part;
    if (L.parts.has(key)) return;
    L.parts.set(key, { key, view, part, hits: 0, missHits: 0, bestConf: 0, missConf: 0, status: 'pending', foundIn: '' });
    L.order.push(key);
  }

  // ---------- camera ----------
  async function startCamera() {
    $('#lvNocam').hidden = true;
    stopCamera();
    if (!navigator.mediaDevices?.getUserMedia) { $('#lvNocam').hidden = false; return; }
    try {
      L.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: L.facing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      video.srcObject = L.stream;
      await video.play().catch(() => {});
      L.track = L.stream.getVideoTracks()[0];
      const caps = L.track.getCapabilities?.() || {};
      $('#lvTorch').hidden = !caps.torch;
      if (caps.focusMode?.includes('continuous')) L.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
      L.torch = false;
      L.active = true;
      L.startedAt = Date.now();
      clearInterval(L.timer);
      L.timer = setInterval(tick, CFG.SAMPLE_MS);
      setState(L.paused ? 'Paused' : 'Scanning');
      setHint(nextInstruction());
    } catch {
      $('#lvNocam').hidden = false;
      toast('Camera blocked or not found. Allow camera access, or use Photo mode.', true);
    }
  }

  function stopCamera() {
    clearInterval(L.timer); L.timer = null;
    L.abort?.abort();
    if (L.active && L.startedAt) L.elapsed += Date.now() - L.startedAt;
    L.active = false; L.startedAt = 0;
    if (L.stream) { L.stream.getTracks().forEach((t) => t.stop()); L.stream = null; L.track = null; }
    video.srcObject = null;
    stage.classList.remove('busy');
  }

  const seconds = () => Math.round((L.elapsed + (L.active && L.startedAt ? Date.now() - L.startedAt : 0)) / 1000);

  // stop the camera whenever the user leaves this screen
  window.addEventListener('pc:view', (e) => { if (e.detail !== 'live') stopCamera(); });
  // "Continue live scan" button on the result screen
  window.addEventListener('pc:resume-live', () => {
    if (!PC.state.cur || PC.state.cur.mode !== 'live') return;
    if (!L.parts.size) resetTallies();
    L.finishing = false; L.paused = false;
    $('#lvDone').hidden = true;
    PC.show('live'); renderAll(); startCamera();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) L.abort?.abort(); });

  $('#lvToggle').addEventListener('click', () => {
    L.paused = !L.paused;
    $('#lvToggle').textContent = L.paused ? 'Resume scan' : 'Pause scan';
    setState(L.paused ? 'Paused' : 'Scanning');
  });
  $('#lvTorch').addEventListener('click', async () => {
    if (!L.track) return;
    try { L.torch = !L.torch; await L.track.applyConstraints({ advanced: [{ torch: L.torch }] }); }
    catch { L.torch = false; toast('Torch not supported on this camera.', true); }
    $('#lvTorch').classList.toggle('on', L.torch);
  });
  $('#lvFlip').addEventListener('click', () => { L.facing = L.facing === 'environment' ? 'user' : 'environment'; startCamera(); });
  $('#lvBack').addEventListener('click', () => {
    if (confirmedCount() && !confirm('Leave the live scan? Found parts will be lost.')) return;
    PC.show('setup');
  });

  // ---------- frame helpers ----------
  // The video uses object-fit: cover, so we crop to exactly what the user sees on screen.
  function visibleRect() {
    const vw = video.videoWidth, vh = video.videoHeight;
    const ew = stage.clientWidth || vw, eh = stage.clientHeight || vh;
    const s = Math.max(ew / vw, eh / vh);
    const sw = ew / s, sh = eh / s;
    return { sx: (vw - sw) / 2, sy: (vh - sh) / 2, sw, sh };
  }
  function grab(side) {
    const r = visibleRect();
    const k = Math.min(1, side / Math.max(r.sw, r.sh));
    const c = document.createElement('canvas');
    c.width = Math.round(r.sw * k); c.height = Math.round(r.sh * k);
    c.getContext('2d').drawImage(video, r.sx, r.sy, r.sw, r.sh, 0, 0, c.width, c.height);
    return c;
  }
  // Tiny 32x24 grayscale fingerprint to measure movement and "same scene".
  const sigCanvas = document.createElement('canvas');
  sigCanvas.width = 32; sigCanvas.height = 24;
  function signature(src) {
    const ctx = sigCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, 32, 24);
    const d = ctx.getImageData(0, 0, 32, 24).data;
    const g = new Uint8Array(32 * 24);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) g[j] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    return g;
  }
  const diff = (a, b) => { if (!a || !b) return 255; let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };

  // ---------- main loop (runs every 250 ms) ----------
  function tick() {
    drawBoxes();
    $('#lvStats').textContent = statsText();
    if (!L.active || L.paused || L.finishing || document.hidden || !video.videoWidth) return;

    const small = grab(256);
    const q = PC.analyze(small, small.width, small.height);
    const sig = signature(small);
    const motion = diff(L.prevSig, sig);
    L.prevSig = sig;
    const steadyNow = motion < CFG.MOTION_MAX;
    L.steady = steadyNow && q.ok ? L.steady + 1 : 0;
    renderQuality(q, steadyNow);

    if (L.busy) return;
    if (!q.ok) { setState(q.issues[0]); return; }
    if (!steadyNow || L.steady < CFG.STEADY_SAMPLES) { setState('Hold steady'); return; }
    if (Date.now() - L.lastSendAt < CFG.MIN_GAP_MS) return;

    const sceneChange = diff(L.lastSentSig, sig);
    if (sceneChange < CFG.SAME_SCENE && L.sameScene >= CFG.SAME_SCENE_REPEAT) {
      setState('Move to the next part');
      return;
    }
    if (L.calls >= CFG.MAX_CALLS) {
      L.paused = true; $('#lvToggle').textContent = 'Resume scan';
      setState('Paused'); toast(`Scan limit of ${CFG.MAX_CALLS} frames reached. Finish now or resume.`, true);
      return;
    }
    L.sameScene = sceneChange < CFG.SAME_SCENE ? L.sameScene + 1 : 1;
    L.lastSentSig = sig;
    sendFrame(q);
  }

  async function sendFrame(quality) {
    const pending = L.order.map((k) => L.parts.get(k)).filter((p) => p.status !== 'present');
    if (!pending.length) { complete(); return; }
    const cur = PC.state.cur;
    const evidence = grab(CFG.EVIDENCE_SIDE);
    const k = Math.min(1, CFG.AI_SIDE / Math.max(evidence.width, evidence.height));
    const ai = document.createElement('canvas');
    ai.width = Math.round(evidence.width * k); ai.height = Math.round(evidence.height * k);
    ai.getContext('2d').drawImage(evidence, 0, 0, ai.width, ai.height);

    L.busy = true; L.lastSendAt = Date.now();
    stage.classList.add('busy'); setState('Checking…');
    L.abort = new AbortController();
    const timeout = setTimeout(() => L.abort?.abort(), CFG.TIMEOUT_MS);
    try {
      const res = await PC.api('/api/live', {
        item: cur.item,
        description: cur.description,
        views: cur.angles.map((a) => a.name),
        pending: pending.map((p) => ({ view: p.view, part: p.part })),
        frame: ai.toDataURL('image/jpeg', CFG.JPEG_Q),
      }, { signal: L.abort.signal });
      if (!L.active || PC.state.cur !== cur) return; // user left meanwhile
      apply(res, evidence, quality);
    } catch (e) {
      if (e.name === 'AbortError') { setState('Slow network – retrying'); }
      else if (e.status === 429) { L.lastSendAt = Date.now() + 5000; setHint('AI is busy, waiting a few seconds'); }
      else if (e.status === 401) { L.paused = true; $('#lvToggle').textContent = 'Resume scan'; }
      else if (Date.now() - L.lastErrAt > 8000) { L.lastErrAt = Date.now(); toast(e.message, true); }
    } finally {
      clearTimeout(timeout);
      L.busy = false; L.abort = null;
      stage.classList.remove('busy');
      if (!L.paused && !L.finishing) setState('Scanning');
    }
  }

  // ---------- merge one AI answer into the running checklist ----------
  function apply(res, evidence, quality) {
    L.calls++;
    if (res.minConfidence != null) L.minConfidence = res.minConfidence;
    if (!res.itemVisible) L.notVisible++;
    L.currentView = res.view || null;
    if (res.view) L.viewsSeen.add(res.view);

    const newly = [];
    const perView = {};
    const now = Date.now();
    res.detections.forEach((d) => {
      const p = L.parts.get(d.key);
      if (!p) return;
      if (d.view !== ANY) L.viewsSeen.add(d.view);
      if (d.box) L.boxes.push({ box: d.box, label: d.part, status: d.status, t: now });
      if (d.status === 'present') {
        p.hits++;
        p.bestConf = Math.max(p.bestConf, d.confidence);
        if (p.status !== 'present' && (p.hits >= CFG.CONFIRM_HITS || d.confidence >= CFG.STRONG_CONF)) {
          p.status = 'present';
          p.foundIn = d.view === ANY ? (res.view || '') : d.view;
          newly.push(p);
        }
        const v = d.view === ANY ? res.view : d.view;
        if (v) perView[v] = (perView[v] || 0) + 1;
      } else {
        p.missHits++;
        p.missConf = Math.max(p.missConf, d.confidence);
        if (p.status === 'pending' && (p.missHits >= CFG.MISSING_HITS || d.confidence >= CFG.STRONG_CONF)) p.status = 'missing';
      }
    });

    // keep the best frame per view as proof photo
    if (res.view && !perView[res.view]) perView[res.view] = 0.5;
    Object.entries(perView).forEach(([view, score]) => {
      const old = L.viewBest[view];
      const s = score + (res.frameQuality === 'good' ? 0.3 : 0);
      if (old && old.score >= s) return;
      const c = document.createElement('canvas');
      c.width = evidence.width; c.height = evidence.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(evidence, 0, 0);
      PC.watermark(ctx, c.width, c.height, view + ' (live)');
      L.viewBest[view] = { score: s, dataUrl: c.toDataURL('image/jpeg', CFG.JPEG_Q), quality, ts: new Date().toISOString() };
    });

    res.defects.forEach((d) => {
      const k = d.description.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 50);
      const old = L.defects.get(k);
      const rank = { low: 0, medium: 1, high: 2 };
      if (old) { old.count++; if (rank[d.severity] > rank[old.severity]) old.severity = d.severity; }
      else L.defects.set(k, { ...d, count: 1, view: res.view || '' });
    });

    setHint(!res.itemVisible ? 'Point the camera at the item' : res.hint || nextInstruction());
    if (newly.length) {
      navigator.vibrate?.(60);
      toast('✓ ' + newly.map((p) => p.part).join(', '));
    }
    renderAll();
    if (L.order.every((k) => L.parts.get(k).status === 'present')) complete();
  }

  function complete() {
    if (L.finishing) return;
    L.finishing = true;
    navigator.vibrate?.([80, 60, 80]);
    $('#lvDone').hidden = false;
    setState('Done');
    setTimeout(() => finish(true), 1300);
  }

  // ---------- finish -> build the same result object as photo mode ----------
  $('#lvFinish').addEventListener('click', () => finish(false));

  function finish(auto) {
    const cur = PC.state.cur;
    if (!cur) return;
    if (!auto) {
      const unscanned = cur.angles.filter((a) => a.parts.length && !L.viewsSeen.has(a.name)).map((a) => a.name);
      if (unscanned.length && !confirm(`Not scanned yet: ${unscanned.join(', ')}.\nTheir parts will be marked missing. Finish anyway?`)) return;
    }
    L.finishing = true;
    stopCamera();
    cur.shots = {};
    cur.angles.forEach((a) => { const b = L.viewBest[a.name]; if (b) cur.shots[a.name] = { dataUrl: b.dataUrl, quality: b.quality, ts: b.ts }; });
    cur.result = buildResult(cur);
    cur.override = { status: '', remarks: '' };
    cur.render3d = null;
    cur.saved = false;
    PC.renderResult();
    PC.show('result');
  }

  function buildResult(cur) {
    const minConf = L.minConfidence ?? PC.state.server.minConfidence ?? 0.6;
    const checklist = L.order.map((k) => {
      const p = L.parts.get(k);
      const group = p.view;
      const row = { group, part: p.part };
      if (p.status === 'present') return { ...row, status: 'present', confidence: p.bestConf, foundIn: p.foundIn, note: `Seen in ${p.hits} frame${p.hits > 1 ? 's' : ''}` };
      if (p.status === 'missing') return { ...row, status: 'missing', confidence: p.missConf, note: 'Its place was in view but the part was not seen' };
      if (group !== ANY && !L.viewsSeen.has(group) && !p.hits) return { ...row, status: 'missing', confidence: 1, note: 'This view was not scanned' };
      return { ...row, status: 'unclear', confidence: p.bestConf, note: p.hits ? 'Seen only once – not confirmed' : 'Not clearly seen – scan closer' };
    });

    const total = checklist.length;
    const present = checklist.filter((c) => c.status === 'present').length;
    const missing = checklist.filter((c) => c.status === 'missing').length;
    const unclear = total - present - missing;
    const completion = total ? Math.round((present / total) * 100) : 100;

    const defects = [...L.defects.values()];
    const highSure = defects.filter((d) => d.severity === 'high' && d.count >= 2);
    const highOnce = defects.filter((d) => d.severity === 'high' && d.count < 2);
    const itemMatches = !(L.calls >= 3 && L.notVisible / L.calls > 0.6);

    const reasons = [];
    if (missing) reasons.push(`${missing} required part${missing > 1 ? 's' : ''} missing`);
    if (highSure.length) reasons.push(`${highSure.length} serious defect${highSure.length > 1 ? 's' : ''} found`);
    if (highOnce.length) reasons.push(`${highOnce.length} possible serious defect${highOnce.length > 1 ? 's' : ''} seen once – verify`);
    if (unclear) reasons.push(`${unclear} part${unclear > 1 ? 's' : ''} could not be confirmed`);
    if (!itemMatches) reasons.push('Most frames did not show the item');

    let status = 'PASS';
    if (missing || highSure.length) status = 'FAIL';
    else if (unclear || highOnce.length || !itemMatches) status = 'REVIEW';
    if (status === 'PASS') reasons.push('All required parts confirmed in live scan');

    const recs = [];
    const unscannedViews = [...new Set(checklist.filter((c) => c.note === 'This view was not scanned').map((c) => c.group))];
    unscannedViews.forEach((v) => recs.push(`Scan the "${v}" view – it was never shown to the camera`));
    checklist.filter((c) => c.status === 'missing' && c.note !== 'This view was not scanned').forEach((c) => recs.push(`Check or fit: ${c.part} (${c.group})`));
    checklist.filter((c) => c.status === 'unclear').forEach((c) => recs.push(`Scan closer: ${c.part} (${c.group})`));

    return {
      status, completion, counts: { total, present, missing, unclear }, reasons, checklist,
      ai: {
        item_identified: cur.item,
        item_matches: itemMatches,
        summary: `Live scan checked ${L.calls} frames in ${seconds()} s. ${present} of ${total} parts confirmed${missing ? `, ${missing} missing` : ''}${unclear ? `, ${unclear} unclear` : ''}.`,
        angles: cur.angles.filter((a) => cur.shots[a.name]).map((a) => ({
          angle: a.name, correct_view: true,
          image_quality: cur.shots[a.name].quality?.ok ? 'good' : 'acceptable',
          quality_issues: cur.shots[a.name].quality?.issues || [], parts: [], observations: [],
        })),
        general_parts: [],
        defects: defects.map((d) => ({ angle: d.view || 'Live scan', description: d.description + (d.count > 1 ? ` (seen ${d.count}×)` : ''), severity: d.severity })),
        recommendations: recs.slice(0, 10),
      },
      provider: PC.state.server.provider || 'azure',
      model: PC.state.server.model || 'gpt-4o',
      minConfidence: minConf,
      evaluatedAt: new Date().toISOString(),
      liveStats: { calls: L.calls, seconds: seconds() },
    };
  }

  // Deep check = send the saved best frame of each view to the normal /api/evaluate (full report).
  $('#lvDeep').addEventListener('click', async () => {
    const cur = PC.state.cur;
    const views = Object.keys(L.viewBest).filter((v) => cur.angles.some((a) => a.name === v));
    if (!views.length) { toast('No frames saved yet. Scan the item first.', true); return; }
    L.paused = true;
    cur.shots = {};
    views.forEach((v) => { const b = L.viewBest[v]; cur.shots[v] = { dataUrl: b.dataUrl, quality: b.quality, ts: b.ts }; });
    await PC.evaluate();
    if (!$('#view-live').hidden) { L.paused = false; setState('Scanning'); }
  });

  // ---------- UI ----------
  const confirmedCount = () => L.order.filter((k) => L.parts.get(k).status === 'present').length;

  function statsText() {
    const s = seconds();
    return `${confirmedCount()}/${L.order.length} parts found · ${L.calls} frames checked · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function setState(t) { $('#lvState').textContent = t; }
  function setHint(t) { L.hint = t || ''; $('#lvHint').textContent = L.hint; $('#lvHint').hidden = !L.hint; }

  function nextInstruction() {
    const cur = PC.state.cur;
    if (!cur) return '';
    const left = (v) => L.order.filter((k) => { const p = L.parts.get(k); return p.view === v && p.status !== 'present'; }).length;
    if (L.currentView && left(L.currentView)) return `Keep scanning ${L.currentView}: ${left(L.currentView)} left`;
    const next = cur.angles.find((a) => left(a.name));
    if (next) return `Now show: ${next.name}`;
    if (left(ANY)) return 'Look for the remaining general parts';
    return '';
  }

  function renderQuality(q, steady) {
    const light = q.brightness < 55 ? ['bad', 'Too dark'] : q.brightness > 215 ? ['bad', 'Too bright'] : ['good', 'Light OK'];
    const sharp = q.sharpness < 40 ? ['bad', 'Blurry'] : ['good', 'Sharp'];
    const st = steady ? ['good', 'Steady'] : ['bad', 'Moving'];
    $('#lvQbar').innerHTML = [light, sharp, st].map(([c, t]) => `<span class="qpill ${c}">${t}</span>`).join('');
  }

  function renderAll() {
    const cur = PC.state.cur;
    if (!cur) return;
    $('#lvItem').textContent = cur.item + (cur.meta.serial ? ` · #${cur.meta.serial}` : '');
    $('#lvStats').textContent = statsText();
    $('#lvView').textContent = L.currentView ? 'Seeing: ' + L.currentView : '';
    $('#lvView').hidden = !L.currentView;

    const total = L.order.length || 1;
    const pct = Math.round((confirmedCount() / total) * 100);
    $('#lvPct').textContent = pct + '%';
    $('#lvRingFg').style.strokeDasharray = `${(pct / 100) * 97.4} 97.4`;

    const groups = [...cur.angles.map((a) => a.name), ...(cur.general_parts?.length ? [ANY] : [])];
    $('#lvList').innerHTML = groups.map((g) => {
      const rows = L.order.map((k) => L.parts.get(k)).filter((p) => p.view === g);
      if (!rows.length) return '';
      const done = rows.filter((p) => p.status === 'present').length;
      const cls = ['lv-group', g === L.currentView ? 'cur' : '', done === rows.length ? 'complete' : '', L.viewsSeen.has(g) ? 'seen' : ''].join(' ');
      return `<div class="${cls}">
        <div class="lv-gh"><b>${esc(g)}</b><span>${done}/${rows.length}</span></div>
        <ul>${rows.map((p) => {
          const st = p.status === 'present' ? 'present' : p.status === 'missing' ? 'missing' : p.hits ? 'partial' : 'pending';
          const icon = { present: '✓', missing: '✕', partial: '◐', pending: '' }[st];
          return `<li class="${st}"><span class="lv-ic">${icon}</span>${esc(p.part)}</li>`;
        }).join('')}</ul>
      </div>`;
    }).join('');
    $('#lvNext').textContent = nextInstruction();

    const defs = [...L.defects.values()];
    $('#lvDefects').hidden = !defs.length;
    $('#lvDefects').innerHTML = defs.length
      ? `<h3>Damage spotted</h3><ul>${defs.map((d) => `<li><span class="sev ${d.severity}">${d.severity}</span> ${esc(d.description)}${d.count > 1 ? ` <em>(${d.count}×)</em>` : ''}</li>`).join('')}</ul>`
      : '';
  }

  // Boxes are approximate (AI estimate on the frame that was sent) and fade out quickly.
  function drawBoxes() {
    const dpr = window.devicePixelRatio || 1;
    const w = stage.clientWidth, h = stage.clientHeight;
    if (overlay.width !== Math.round(w * dpr) || overlay.height !== Math.round(h * dpr)) {
      overlay.width = Math.round(w * dpr); overlay.height = Math.round(h * dpr);
    }
    const ctx = overlay.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const now = Date.now();
    L.boxes = L.boxes.filter((b) => now - b.t < CFG.BOX_TTL);
    ctx.font = '600 13px Barlow, Arial, sans-serif';
    L.boxes.forEach((b) => {
      const a = 1 - (now - b.t) / CFG.BOX_TTL;
      const [x, y, bw, bh] = b.box;
      const color = b.status === 'present' ? `rgba(30,132,73,${a})` : `rgba(192,57,43,${a})`;
      ctx.strokeStyle = color; ctx.lineWidth = 3;
      ctx.strokeRect(x * w, y * h, bw * w, bh * h);
      const label = (b.status === 'present' ? '✓ ' : '✕ ') + b.label;
      const tw = ctx.measureText(label).width + 10;
      ctx.fillStyle = color;
      ctx.fillRect(x * w, Math.max(0, y * h - 20), tw, 20);
      ctx.fillStyle = `rgba(255,255,255,${a})`;
      ctx.fillText(label, x * w + 5, Math.max(0, y * h - 20) + 14);
    });
  }
})();
