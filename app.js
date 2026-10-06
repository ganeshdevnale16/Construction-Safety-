/* PartCheck AI – front end (no framework, no build step) */
(() => {
  'use strict';

  // ---------- small helpers ----------
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const splitLines = (s) => String(s || '').split(/\n/).map((x) => x.trim()).filter(Boolean);
  // "USB cable :: plugged into the laptop" -> { name: 'USB cable', rule: 'plugged into the laptop' }
  // "! Guardrails :: fitted" -> critical check. "USB cable :: plugged in" -> check with rule.
  const splitCheck = (s) => {
    let t = String(s || '').trim();
    const critical = t.startsWith('!');
    if (critical) t = t.slice(1);
    const [n, ...r] = t.split('::');
    return { name: n.trim(), rule: r.join('::').trim(), critical };
  };
  const checkLabel = (s) => { const c = splitCheck(s); return (c.critical ? '⚠ ' : '') + (c.rule ? `${c.name} – ${c.rule}` : c.name); };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const fmtDate = (iso) => new Date(iso).toLocaleString();

  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  };

  const MAX_SIDE = 1024;      // photo size sent to the AI (keeps Vercel's 4.5 MB request limit safe)
  const JPEG_Q = 0.72;
  const THUMB_SIDE = 480;     // size stored in history

  // ---------- built-in sample items ----------
  // ---------- SCAFFOLDING module templates ----------
  // "!" = critical safety check (a Not OK or Unclear critical check gives a RED tag).
  const SCAFFOLD_TEMPLATES = [
    {
      id: 'tpl-scaffold-fixed', module: 'scaffold', name: 'Scaffold – fixed (tube / cuplock)',
      description: 'Independent or putlog access scaffold against a building',
      angles: [
        { name: 'Base & foundation', guidance: 'Low angle along the bottom: all uprights, base plates and the ground in view', parts: [
          '! Base plates :: a steel base plate under every visible standard (upright)',
          '! Sole boards / firm ground :: base plates rest on timber sole boards on firm, level ground – no bricks, blocks or loose packing',
          'Standards plumb :: uprights look vertical, not leaning, bent or sinking',
        ] },
        { name: 'Full elevation', guidance: 'Step back and capture the whole face of the scaffold from bottom to top', parts: [
          '! Ledgers and transoms :: horizontal tubes present at every lift, none missing',
          '! Bracing :: diagonal (face) bracing fitted along the scaffold face',
          '! Ties to structure :: scaffold is tied to the building / structure at regular intervals',
        ] },
        { name: 'Working platform', guidance: 'At platform level: deck, edges and rails in view', parts: [
          '! Platform fully boarded :: boards or decks cover the full width, no gaps, broken or loose boards',
          '! Guardrail :: top guardrail on every open side of the working platform',
          '! Mid rail :: intermediate rail between guardrail and toe board on open sides',
          '! Toe boards :: toe boards fitted along the open edges of the platform',
          'Platform clear :: no heavy stacks of material, debris or trip hazards on the platform',
        ] },
        { name: 'Access ladder', guidance: 'Ladder and the landing where it reaches the platform', parts: [
          '! Access ladder :: ladder is tied / secured and extends about 1 m above the landing',
        ] },
        { name: 'Scaffold tag', guidance: 'Close-up of the tag / status board at the access point', parts: [
          'Scaffold tag :: an inspection tag or status board is displayed at the access point',
        ] },
      ],
      general_parts: [
        '! Couplers / clamps :: fitted at the joints, none missing or hanging loose',
        'Tube condition :: no bent, cracked, crushed or heavily rusted tubes',
      ],
    },
    {
      id: 'tpl-scaffold-mobile', module: 'scaffold', name: 'Scaffold – mobile tower',
      description: 'Aluminium or steel mobile scaffold tower on castor wheels',
      angles: [
        { name: 'Base & castors', guidance: 'Low angle: all wheels, base frame and ground visible', parts: [
          '! Castor brakes :: every castor wheel has its brake locked',
          '! Firm level ground :: tower stands on firm, level ground with no packing under wheels',
          '! Outriggers / stabilisers :: outriggers fitted and touching the ground (if tower is tall)',
        ] },
        { name: 'Full elevation', guidance: 'Step back: whole tower from wheels to top', parts: [
          '! Frames and braces :: all frames connected and diagonal / horizontal braces fitted, none missing',
          'Tower vertical :: tower looks upright, not leaning',
        ] },
        { name: 'Top platform', guidance: 'Top working platform with rails in view', parts: [
          '! Platform :: platform fully decked and locked in place, trapdoor closes',
          '! Guardrails :: guardrail and mid rail on all four sides of the top platform',
          '! Toe boards :: toe boards fitted around the top platform',
        ] },
        { name: 'Access', guidance: 'Built-in ladder / stair frames', parts: [
          'Internal access :: access is by built-in ladder or stair frames inside the tower (no climbing on the outside)',
        ] },
      ],
      general_parts: ['Scaffold tag :: inspection tag or label displayed on the tower'],
    },
  ];

  const DEFAULT_TEMPLATES = [
    ...SCAFFOLD_TEMPLATES,
    {
      id: 'tpl-laptop-conn', name: 'Laptop setup (cables connected)', description: 'Laptop on desk with charger and USB device connected',
      angles: [
        { name: 'Left side ports', guidance: 'Close-up of the left edge, ports and plugs clearly visible', parts: [
          'USB cable :: a USB cable plug is fully inserted into a USB port on the laptop',
          'Charger cable :: the charger plug is inserted into the laptop charging port',
        ] },
        { name: 'Right side ports', guidance: 'Close-up of the right edge, ports and plugs clearly visible', parts: [
          'USB port :: present on the laptop',
        ] },
        { name: 'Screen on', guidance: 'Lid open, whole screen visible', parts: [
          'Screen :: switched on and showing an image',
          'Screen damage :: no cracks, lines or dead areas on the screen',
        ] },
      ],
      general_parts: ['Serial number / service tag label'],
    },
    {
      id: 'tpl-panel', name: 'Electrical control panel', description: 'Wall-mounted LT control panel',
      angles: [
        { name: 'Front (door closed)', guidance: 'Whole front face in frame, door closed', parts: ['Door handle / lock', 'Indicator lamps', 'Emergency stop button', 'Danger warning sticker'] },
        { name: 'Inside (door open)', guidance: 'Open the door, capture all components', parts: ['MCBs / breakers', 'Contactor', 'Terminal block', 'Earthing wire', 'Wire ferrules / labels'] },
        { name: 'Left side', guidance: 'Full left side panel', parts: ['Ventilation louvers', 'Cable gland'] },
        { name: 'Right side', guidance: 'Full right side panel', parts: ['Ventilation louvers'] },
      ],
      general_parts: ['Nameplate / serial label'],
    },
    {
      id: 'tpl-laptop', name: 'Laptop (handover check)', description: 'Company laptop returned by employee',
      angles: [
        { name: 'Lid closed', guidance: 'Top of the closed lid, whole laptop visible', parts: ['Brand logo'] },
        { name: 'Open – screen & keyboard', guidance: 'Lid open, screen and keyboard fully visible', parts: ['Screen (no cracks)', 'Keyboard with all keys', 'Touchpad', 'Webcam'] },
        { name: 'Left side', guidance: 'Close-up of all left-side ports', parts: ['Charging port', 'USB port'] },
        { name: 'Right side', guidance: 'Close-up of all right-side ports', parts: ['USB port', 'Audio jack'] },
        { name: 'Bottom', guidance: 'Flip the laptop, whole base visible', parts: ['Rubber feet', 'Base screws'] },
      ],
      general_parts: ['Serial number / service tag label', 'Charger adapter'],
    },
    {
      id: 'tpl-pump', name: 'Water pump with motor', description: 'Monoblock pump set',
      angles: [
        { name: 'Front', guidance: 'Pump casing and inlet facing the camera', parts: ['Pump casing', 'Suction inlet', 'Nameplate'] },
        { name: 'Top', guidance: 'From above, outlet and priming plug visible', parts: ['Delivery outlet', 'Priming plug'] },
        { name: 'Motor side', guidance: 'Full motor body side view', parts: ['Motor body', 'Fan cover', 'Terminal box'] },
        { name: 'Base', guidance: 'Mounting base and bolts', parts: ['Mounting base', 'Foundation bolts'] },
      ],
      general_parts: [],
    },
  ];

  // ---------- state ----------
  const state = {
    templates: LS.get('pc_templates', null) || clone(DEFAULT_TEMPLATES),
    tplId: null,
    module: LS.get('pc_module', 'general'),
    editingId: null,
    server: {},
    cur: null,          // current inspection record
    angleIdx: 0,
    stream: null,
    liveTimer: null,
    spinTimer: null,
  };
  if (!LS.get('pc_templates', null)) LS.set('pc_templates', state.templates);
  // add new built-in examples for people who already have saved items
  if (!LS.get('pc_tpl_v3', false)) {
    DEFAULT_TEMPLATES.forEach((t) => { if (!state.templates.some((x) => x.id === t.id)) state.templates.unshift(clone(t)); });
    LS.set('pc_templates', state.templates); LS.set('pc_tpl_v3', true);
  }

  // ---------- UI basics ----------
  let toastTimer;
  function toast(msg, isErr = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('err', isErr);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), isErr ? 5000 : 2800);
  }
  function loading(on, text = 'Working…') {
    $('#loading').hidden = !on;
    $('#loadingText').textContent = text;
  }

  function show(view) {
    $$('.view').forEach((v) => (v.hidden = v.id !== `view-${view}`));
    $$('.nav [data-nav]').forEach((b) => b.classList.toggle('active', b.dataset.nav === view || (view !== 'history' && b.dataset.nav === 'setup')));
    $('#steps').hidden = view === 'history';
    const order = ['setup', 'capture', 'result'];
    $$('#steps li').forEach((li) => {
      const i = order.indexOf(li.dataset.step), cur = order.indexOf(view === 'live' ? 'capture' : view);
      li.classList.toggle('on', i === cur);
      li.classList.toggle('done', i < cur);
    });
    if (view !== 'capture') stopCamera();
    if (view !== 'result') stopSpin();
    window.dispatchEvent(new CustomEvent('pc:view', { detail: view }));
    window.scrollTo({ top: 0 });
  }

  // ---------- API ----------
  async function api(path, body, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const pw = LS.get('pc_pw', '');
    if (pw) headers['x-app-password'] = pw;
    let r;
    try {
      r = await fetch(path, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, signal: opts.signal });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new Error('Cannot reach the server. Check your internet connection.');
    }
    let data;
    try { data = await r.json(); } catch { data = {}; }
    if (r.status === 401) { openSettings('Enter the app password to use AI features.'); throw new Error(data.error || 'App password required.'); }
    if (r.status === 413) throw new Error('Photos are too large to send. Remove the extra views or retake fewer photos.');
    if (r.status === 504) throw new Error('The AI took too long to answer. Try again with fewer photos.');
    if (!r.ok) { const err = new Error(data.error || `Request failed (${r.status}).`); err.status = r.status; throw err; }
    return data;
  }

  async function loadServerInfo() {
    try { state.server = await api('/api/health'); } catch { state.server = {}; }
    if (state.server.passwordRequired && !LS.get('pc_pw', '')) openSettings('This app is protected. Enter the app password.');
    if (state.server.missing?.length) toast(`Missing in Vercel environment variables: ${state.server.missing.join(', ')}. Add them, then Redeploy.`, true);
    else if (state.server.ok === false) toast('Server has no AI keys set. Add the AZURE_OPENAI_* variables, then Redeploy.', true);
  }

  // ---------- settings ----------
  function openSettings(msg = '') {
    $('#settingsMsg').textContent = msg;
    $('#sPassword').value = LS.get('pc_pw', '');
    const s = state.server;
    $('#serverInfo').innerHTML = s.provider
      ? `<div><span>AI provider</span><b>${esc(s.provider === 'azure' ? 'Azure OpenAI' : s.provider)}</b></div>
         <div><span>Model / deployment</span><b>${esc(s.model)}</b></div>
         <div><span>AI 3D render</span><b>${s.renderEnabled ? 'On' : 'Off'}</b></div>
         <div><span>Min. confidence</span><b>${Math.round((s.minConfidence || 0) * 100)}%</b></div>
         <div><span>Setup</span><b>${s.missing?.length ? 'Missing: ' + esc(s.missing.join(', ')) : 'All variables set'}</b></div>`
      : 'Server status unknown.';
    const d = $('#dlgSettings');
    if (!d.open) d.showModal();
  }
  $('#btnSettings').addEventListener('click', () => openSettings());
  $('#dlgSettings').addEventListener('close', () => {
    if ($('#dlgSettings').returnValue === 'save') {
      LS.set('pc_pw', $('#sPassword').value.trim());
      toast('Settings saved');
      loadServerInfo();
    }
  });

  // ---------- STEP 1: templates ----------
  function saveTemplates() { LS.set('pc_templates', state.templates); }
  function getTpl(id) { return state.templates.find((t) => t.id === id); }

  const modOf = (t) => t?.module || 'general';
  const visibleTemplates = () => state.templates.filter((t) => modOf(t) === state.module);

  function setModule(m) {
    state.module = m === 'scaffold' ? 'scaffold' : 'general';
    LS.set('pc_module', state.module);
    $$('#moduleTabs [data-module]').forEach((b) => {
      const on = b.dataset.module === state.module;
      b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on));
    });
    const sc = state.module === 'scaffold';
    $('#scaffoldFields').hidden = !sc;
    $('#mSerialLabel').textContent = sc ? 'Scaffold ID / tag number' : 'Serial / asset / job number';
    closeEditor();
    renderTplSelect();
  }
  $$('#moduleTabs [data-module]').forEach((b) => b.addEventListener('click', () => setModule(b.dataset.module)));

  function renderTplSelect() {
    const sel = $('#tplSelect');
    const list = visibleTemplates();
    sel.innerHTML = list.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
    if (!list.some((t) => t.id === state.tplId)) state.tplId = list[0]?.id || null;
    sel.value = state.tplId || '';
    renderTplPreview();
  }

  function renderTplPreview() {
    const t = getTpl(state.tplId);
    const box = $('#tplPreview');
    if (!t) { box.innerHTML = '<p class="muted">No items yet. Create a custom item to begin.</p>'; return; }
    const lines = t.angles.map((a) => `<div class="view-line"><b>${esc(a.name)}</b><span>${esc(a.parts.map(checkLabel).join(' · ') || 'Photo only')}</span></div>`);
    if (t.general_parts?.length) lines.push(`<div class="view-line"><b>Any view</b><span>${esc(t.general_parts.map(checkLabel).join(' · '))}</span></div>`);
    box.innerHTML = lines.join('');
  }

  $('#tplSelect').addEventListener('change', (e) => { state.tplId = e.target.value; renderTplPreview(); closeEditor(); });

  function angleRow(a = { name: '', guidance: '', parts: [] }) {
    const div = document.createElement('div');
    div.className = 'ed-angle';
    div.innerHTML = `
      <div class="ed-top">
        <input class="aname" placeholder="View name, e.g. Front" maxlength="60" value="${esc(a.name)}" />
        <button type="button" class="ed-x" title="Remove view" aria-label="Remove view">×</button>
      </div>
      <input class="guide" placeholder="How to frame the photo (optional)" maxlength="200" value="${esc(a.guidance || '')}" />
      <textarea class="aparts" rows="3" placeholder="One check per line. Add a rule after :: when a state matters, e.g.&#10;USB cable :: plugged fully into a USB port&#10;Screen :: no cracks">${esc((a.parts || []).join('\n'))}</textarea>`;
    $('.ed-x', div).addEventListener('click', () => div.remove());
    return div;
  }

  function openEditor(tpl) {
    state.editingId = tpl?.id || null;
    $('#editorTitle').textContent = tpl ? `Edit: ${tpl.name}` : 'Custom item';
    $('#edName').value = tpl?.name || '';
    $('#edDesc').value = tpl?.description || '';
    $('#edGeneral').value = (tpl?.general_parts || []).join('\n');
    const box = $('#edAngles');
    box.innerHTML = '';
    (tpl?.angles?.length ? tpl.angles : [{ name: 'Front', guidance: '', parts: [] }, { name: 'Back', guidance: '', parts: [] }, { name: 'Left side', guidance: '', parts: [] }, { name: 'Right side', guidance: '', parts: [] }])
      .forEach((a) => box.appendChild(angleRow(a)));
    $('#btnDeleteTpl').hidden = !tpl;
    $('#editor').hidden = false;
    $('#edName').focus();
  }
  function closeEditor() { $('#editor').hidden = true; state.editingId = null; }

  function readEditor() {
    const name = $('#edName').value.trim();
    const angles = $$('#edAngles .ed-angle').map((row) => ({
      name: $('.aname', row).value.trim(),
      guidance: $('.guide', row).value.trim(),
      parts: splitLines($('.aparts', row).value),
    })).filter((a) => a.name);
    const names = angles.map((a) => a.name.toLowerCase());
    if (!name) throw new Error('Enter an item name.');
    if (!angles.length) throw new Error('Add at least one view.');
    if (new Set(names).size !== names.length) throw new Error('Each view needs a different name.');
    const module = state.editingId ? modOf(getTpl(state.editingId)) : state.module;
    return { id: state.editingId || 'tpl-' + uid(), module, name, description: $('#edDesc').value.trim(), angles, general_parts: splitLines($('#edGeneral').value) };
  }

  $('#btnEditTpl').addEventListener('click', () => { const t = getTpl(state.tplId); t ? openEditor(t) : openEditor(null); });
  $('#btnNewTpl').addEventListener('click', () => openEditor(null));
  $('#btnCancelTpl').addEventListener('click', closeEditor);
  $('#btnAddAngle').addEventListener('click', () => { const r = angleRow(); $('#edAngles').appendChild(r); $('.aname', r).focus(); });

  $('#btnSaveTpl').addEventListener('click', () => {
    try {
      const t = readEditor();
      const i = state.templates.findIndex((x) => x.id === t.id);
      if (i >= 0) state.templates[i] = t; else state.templates.push(t);
      saveTemplates();
      state.tplId = t.id;
      renderTplSelect();
      closeEditor();
      toast('Item saved');
    } catch (e) { toast(e.message, true); }
  });

  $('#btnDeleteTpl').addEventListener('click', () => {
    if (!state.editingId || !confirm('Delete this item and its checklist?')) return;
    state.templates = state.templates.filter((t) => t.id !== state.editingId);
    saveTemplates();
    closeEditor();
    renderTplSelect();
    toast('Item deleted');
  });

  $('#btnSuggest').addEventListener('click', async () => {
    const item = $('#edName').value.trim();
    if (!item) { toast('Type the item name first.', true); $('#edName').focus(); return; }
    loading(true, 'AI is building a checklist…');
    try {
      const out = await api('/api/suggest', { item, description: $('#edDesc').value.trim() });
      const box = $('#edAngles');
      box.innerHTML = '';
      out.angles.forEach((a) => box.appendChild(angleRow(a)));
      $('#edGeneral').value = out.general_parts.join('\n');
      toast('Checklist suggested. Review it, then save.');
    } catch (e) { toast(e.message, true); }
    finally { loading(false); }
  });

  // inspection details (remember inspector name)
  $('#mInspector').value = LS.get('pc_inspector', '');

  // Builds a fresh inspection record from the selected item + details. Used by photo mode and live scan.
  function newRecord(mode = 'photo') {
    const tpl = !$('#editor').hidden ? readEditor() : getTpl(state.tplId);
    if (!tpl) throw new Error('Choose or create an item first.');
    LS.set('pc_inspector', $('#mInspector').value.trim());

    const module = modOf(tpl);
    let scaffold = null;
    let description = tpl.description || '';
    if (module === 'scaffold') {
      scaffold = {
        type: $('#sfType').value, duty: $('#sfDuty').value, height: $('#sfHeight').value, lifts: $('#sfLifts').value,
        erector: $('#sfErector').value.trim(), lastInspection: $('#sfLast').value, reason: $('#sfReason').value,
      };
      LS.set('pc_scaffold_last', { erector: scaffold.erector });
      const bits = [
        scaffold.type && `Type: ${scaffold.type}`, scaffold.duty && `Duty: ${scaffold.duty}`,
        scaffold.height && `Height about ${scaffold.height} m`, scaffold.lifts && `${scaffold.lifts} lifts`,
        scaffold.reason && `Inspection: ${scaffold.reason}`,
      ].filter(Boolean).join('; ');
      if (bits) description = (description ? description + '. ' : '') + bits;
    }

    state.cur = {
      mode,
      module,
      scaffold,
      id: uid(),
      createdAt: new Date().toISOString(),
      item: tpl.name,
      description,
      angles: clone(tpl.angles),
      general_parts: clone(tpl.general_parts || []),
      meta: {
        inspector: $('#mInspector').value.trim(),
        serial: $('#mSerial').value.trim(),
        location: $('#mLocation').value.trim(),
        notes: $('#mNotes').value.trim(),
        gps: null,
      },
      shots: {},
      result: null,
      render3d: null,
      override: { status: '', remarks: '' },
      saved: false,
    };
    state.angleIdx = 0;
    if ($('#mGps').checked) getGps();
    return state.cur;
  }

  $('#btnStart').addEventListener('click', () => {
    try { newRecord('photo'); } catch (e) { toast(e.message, true); return; }
    show('capture');
    renderCapture();
    startCamera();
  });

  function getGps() {
    if (!navigator.geolocation) return toast('GPS is not available on this device.', true);
    navigator.geolocation.getCurrentPosition(
      (p) => { if (state.cur) state.cur.meta.gps = { lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6), acc: Math.round(p.coords.accuracy) }; },
      () => toast('Location permission denied. Photos will not have GPS.', true),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  // ---------- FLASH (torch) control – shared by photo mode and live scan ----------
  // Modes: Off / On / Auto. Auto turns the torch on when the picture stays dark,
  // and off again when it is clearly bright. Uses the browser torch API
  // (works in Chrome on most Android phones; iPhone browsers usually do not allow it).
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function createFlash(btn, getTrack) {
    const LABEL = { off: 'Off', on: 'On', auto: 'Auto' };
    const ctl = { mode: LS.get('pc_flash', 'off'), lit: false, supported: false, darkSince: 0, brightSince: 0, lastBrightness: 128 };

    function paint() {
      if (!ctl.supported) { btn.textContent = '⚡ Flash: not supported'; btn.disabled = true; btn.classList.remove('on'); return; }
      btn.disabled = false;
      btn.textContent = `⚡ Flash: ${LABEL[ctl.mode]}${ctl.mode === 'auto' && ctl.lit ? ' (on)' : ''}`;
      btn.classList.toggle('on', ctl.lit);
      btn.setAttribute('aria-pressed', String(ctl.lit));
    }
    async function set(on) {
      const t = getTrack();
      if (!t || !ctl.supported) return false;
      try { await t.applyConstraints({ advanced: [{ torch: on }] }); ctl.lit = on; }
      catch { ctl.lit = false; if (on) toast('Could not turn on the flash on this camera.', true); }
      paint();
      return ctl.lit === on;
    }
    // call after a camera stream starts
    ctl.attach = () => {
      const t = getTrack();
      ctl.supported = Boolean(t?.getCapabilities?.().torch);
      ctl.mode = LS.get('pc_flash', ctl.mode); // same flash setting in photo mode and live scan
      ctl.lit = false; ctl.darkSince = 0; ctl.brightSince = 0;
      paint();
      if (ctl.supported && ctl.mode === 'on') set(true);
    };
    ctl.detach = () => { ctl.lit = false; ctl.supported = false; };
    // feed the latest brightness (0-255) for Auto mode
    ctl.feed = (b) => {
      ctl.lastBrightness = b;
      if (ctl.mode !== 'auto' || !ctl.supported) return;
      const now = Date.now();
      if (!ctl.lit && b < 60) { ctl.darkSince ||= now; if (now - ctl.darkSince > 700) set(true); }
      else ctl.darkSince = 0;
      if (ctl.lit && b > 185) { ctl.brightSince ||= now; if (now - ctl.brightSince > 2000) set(false); }
      else ctl.brightSince = 0;
    };
    // before taking a photo: in Auto mode fire the flash if the scene is dark (like a real camera flash)
    ctl.beforeShot = async () => {
      if (ctl.mode === 'auto' && ctl.supported && !ctl.lit && ctl.lastBrightness < 70) {
        if (await set(true)) await sleep(700); // give the camera time to adjust exposure
      }
    };
    btn.addEventListener('click', () => {
      ctl.mode = ctl.mode === 'off' ? 'on' : ctl.mode === 'on' ? 'auto' : 'off';
      LS.set('pc_flash', ctl.mode);
      if (ctl.mode === 'on') set(true);
      else if (ctl.mode === 'off') set(false);
      else paint();
    });
    paint();
    return ctl;
  }

  // ---------- STEP 2: capture ----------
  const video = $('#video');
  const photoFlash = createFlash($('#btnFlash'), () => state.stream?.getVideoTracks()[0]);

  async function startCamera() {
    $('#nocam').hidden = true;
    if (state.stream) { startLiveCheck(); return; }
    if (!navigator.mediaDevices?.getUserMedia) { $('#nocam').hidden = false; $('#btnShoot').disabled = true; return; }
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } },
        audio: false,
      });
      video.srcObject = state.stream;
      await video.play().catch(() => {});
      $('#btnShoot').disabled = false;
      photoFlash.attach();
      startLiveCheck();
    } catch (e) {
      $('#nocam').hidden = false;
      $('#btnShoot').disabled = true;
      toast('Camera blocked or not found. Use Upload photo instead.', true);
    }
  }

  function stopCamera() {
    clearInterval(state.liveTimer);
    state.liveTimer = null;
    if (state.stream) { state.stream.getTracks().forEach((t) => t.stop()); state.stream = null; }
    photoFlash.detach();
    video.srcObject = null;
  }

  // Brightness + sharpness check (like the "move closer / too dark" hints in face KYC)
  const qCanvas = document.createElement('canvas');
  function analyze(src, sw, sh) {
    const w = 256, h = Math.max(1, Math.round((sh / sw) * 256));
    qCanvas.width = w; qCanvas.height = h;
    const ctx = qCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const g = new Float32Array(w * h);
    let sum = 0;
    for (let i = 0, j = 0; i < d.length; i += 4, j++) { g[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; sum += g[j]; }
    const brightness = sum / g.length;
    let n = 0, m = 0, m2 = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
      n++; const delta = lap - m; m += delta / n; m2 += delta * (lap - m);
    }
    const sharpness = n > 1 ? m2 / (n - 1) : 0;
    const issues = [];
    if (brightness < 55) issues.push('Too dark');
    else if (brightness > 215) issues.push('Too bright');
    if (sharpness < 40) issues.push('Blurry – hold steady');
    return { brightness: Math.round(brightness), sharpness: Math.round(sharpness), ok: issues.length === 0, issues };
  }

  function qualityPills(q) {
    if (!q) return '';
    const light = q.brightness < 55 ? ['bad', 'Too dark'] : q.brightness > 215 ? ['bad', 'Too bright'] : ['good', 'Light OK'];
    const sharp = q.sharpness < 40 ? ['bad', 'Blurry'] : ['good', 'Sharp'];
    return [light, sharp].map(([c, t]) => `<span class="qpill ${c}">${t}</span>`).join('');
  }

  function startLiveCheck() {
    clearInterval(state.liveTimer);
    state.liveTimer = setInterval(() => {
      if (!state.cur || $('#view-capture').hidden) return;
      const a = state.cur.angles[state.angleIdx];
      if (state.cur.shots[a?.name] || !video.videoWidth) return;
      const q = analyze(video, video.videoWidth, video.videoHeight);
      photoFlash.feed(q.brightness);
      $('#qbar').innerHTML = qualityPills(q);
    }, 500);
  }

  function watermark(ctx, w, h, angleName) {
    const strip = Math.max(18, Math.round(h * 0.034));
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, h - strip, w, strip);
    ctx.fillStyle = '#fff';
    ctx.font = `${Math.round(strip * 0.6)}px Arial, sans-serif`;
    ctx.textBaseline = 'middle';
    const gps = state.cur.meta.gps ? `  |  ${state.cur.meta.gps.lat}, ${state.cur.meta.gps.lng}` : '';
    const text = `${state.cur.item}  |  ${angleName}  |  ${new Date().toLocaleString()}${gps}`;
    ctx.fillText(text, Math.round(strip * 0.4), h - strip / 2, w - strip);
  }

  function processImage(src, sw, sh) {
    const a = state.cur.angles[state.angleIdx];
    const scale = Math.min(1, MAX_SIDE / Math.max(sw, sh));
    const w = Math.round(sw * scale), h = Math.round(sh * scale);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(src, 0, 0, w, h);
    const quality = analyze(c, w, h);
    watermark(ctx, w, h, a.name);
    state.cur.shots[a.name] = { dataUrl: c.toDataURL('image/jpeg', JPEG_Q), quality, ts: new Date().toISOString() };
    state.cur.result = null; // photos changed -> old result no longer valid
    if (!quality.ok) toast(`Photo saved, but: ${quality.issues.join(', ')}. Retake for a better result.`, true);
    renderCapture();
  }

  $('#btnShoot').addEventListener('click', async () => {
    if (!video.videoWidth) { toast('Camera is still starting…'); return; }
    const btn = $('#btnShoot');
    btn.disabled = true;
    try {
      await photoFlash.beforeShot();
      $('#stage').classList.remove('snap'); void $('#stage').offsetWidth; $('#stage').classList.add('snap');
      processImage(video, video.videoWidth, video.videoHeight);
    } finally { btn.disabled = false; }
  });

  $('#fileInput').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (!f.type.startsWith('image/')) { toast('Choose an image file.', true); return; }
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => { processImage(img, img.naturalWidth, img.naturalHeight); URL.revokeObjectURL(url); };
    img.onerror = () => { toast('Could not read that image. Try JPG or PNG.', true); URL.revokeObjectURL(url); };
    img.src = url;
  });

  $('#btnRetake').addEventListener('click', () => {
    const a = state.cur.angles[state.angleIdx];
    delete state.cur.shots[a.name];
    state.cur.result = null;
    renderCapture();
  });

  $('#btnNext').addEventListener('click', () => {
    const angles = state.cur.angles;
    const nextMissing = angles.findIndex((a, i) => i > state.angleIdx && !state.cur.shots[a.name]);
    const anyMissing = angles.findIndex((a) => !state.cur.shots[a.name]);
    state.angleIdx = nextMissing >= 0 ? nextMissing : anyMissing >= 0 ? anyMissing : state.angleIdx;
    renderCapture();
  });

  $('#btnExtraAngle').addEventListener('click', () => {
    const name = prompt('Name for the extra view (e.g. "Close-up of damage"):');
    if (!name?.trim()) return;
    if (state.cur.angles.some((a) => a.name.toLowerCase() === name.trim().toLowerCase())) { toast('A view with that name already exists.', true); return; }
    state.cur.angles.push({ name: name.trim().slice(0, 60), guidance: 'Extra evidence photo', parts: [], extra: true });
    state.angleIdx = state.cur.angles.length - 1;
    renderCapture();
  });

  $('#btnBackSetup').addEventListener('click', () => show('setup'));

  function renderCapture() {
    const cur = state.cur;
    const a = cur.angles[state.angleIdx];
    const shot = cur.shots[a.name];
    const done = cur.angles.filter((x) => cur.shots[x.name]).length;

    $('#capItem').textContent = cur.item;
    $('#capProgress').textContent = `${done} of ${cur.angles.length} views captured${cur.meta.serial ? ' · ' + cur.meta.serial : ''}`;

    $('#angleChips').innerHTML = cur.angles.map((x, i) => {
      const s = cur.shots[x.name];
      const cls = ['chip', i === state.angleIdx ? 'cur' : '', s ? (s.quality.ok ? 'ok' : 'warn') : ''].join(' ');
      return `<button type="button" role="tab" class="${cls}" data-i="${i}" aria-selected="${i === state.angleIdx}">${esc(x.name)}</button>`;
    }).join('');
    $$('#angleChips .chip').forEach((b) => b.addEventListener('click', () => { state.angleIdx = +b.dataset.i; renderCapture(); }));
    $('#angleChips .chip.cur')?.scrollIntoView({ inline: 'center', block: 'nearest' });

    $('#stageLabel').textContent = a.name;
    $('#angleName').textContent = a.name;
    $('#angleGuide').textContent = a.guidance || 'Fill the yellow frame with this view of the item.';
    $('#angleParts').innerHTML = a.parts.length
      ? a.parts.map((p) => `<li>${esc(checkLabel(p))}</li>`).join('')
      : '<li class="none">No required parts. This photo is extra evidence.</li>';

    const stage = $('#stage');
    stage.classList.toggle('has-shot', Boolean(shot));
    $('#preview').hidden = !shot;
    video.hidden = Boolean(shot);
    if (shot) {
      $('#preview').src = shot.dataUrl;
      $('#qbar').innerHTML = qualityPills(shot.quality);
      $('#nocam').hidden = true;
    } else {
      $('#qbar').innerHTML = '';
      $('#nocam').hidden = Boolean(state.stream) || !$('#btnShoot').disabled;
    }
    $('#btnShoot').hidden = Boolean(shot);
    $('#lblUpload').hidden = Boolean(shot);
    $('#btnRetake').hidden = !shot;
    const allDone = done === cur.angles.length;
    $('#btnNext').hidden = !shot || allDone;

    const ev = $('#btnEvaluate');
    ev.disabled = done === 0;
    ev.textContent = allDone ? 'Evaluate photos' : `Evaluate photos (${done}/${cur.angles.length})`;
  }

  // ---------- evaluate ----------
  $('#btnEvaluate').addEventListener('click', evaluate);

  async function evaluate() {
    const cur = state.cur;
    const missingViews = cur.angles.filter((a) => !cur.shots[a.name] && a.parts.length);
    if (missingViews.length && !confirm(`${missingViews.length} view(s) not photographed: ${missingViews.map((a) => a.name).join(', ')}.\nTheir parts will be marked missing. Evaluate anyway?`)) return;

    const payload = {
      item: cur.item,
      module: cur.module || '',
      description: cur.description,
      general_parts: cur.general_parts,
      angles: cur.angles.map((a) => ({ name: a.name, guidance: a.guidance || '', parts: a.parts, image: cur.shots[a.name]?.dataUrl || null })),
    };
    const sizeMb = JSON.stringify(payload).length / 1048576;
    if (sizeMb > 4.2 && !confirm(`Upload is ${sizeMb.toFixed(1)} MB. On Vercel the limit is 4.5 MB and it may fail. Continue?`)) return;

    loading(true, 'AI is inspecting your photos…');
    try {
      cur.result = await api('/api/evaluate', payload);
      cur.override = { status: '', remarks: '' };
      cur.render3d = null;
      cur.saved = false;
      stopCamera();
      renderResult();
      show('result');
    } catch (e) {
      toast(e.message, true);
    } finally {
      loading(false);
    }
  }

  // ---------- STEP 3: result ----------
  const ICON = { present: '✓', missing: '✕', unclear: '?' };
  const STATUS_TEXT = { present: 'OK', missing: 'Not OK', unclear: 'Unclear' };

  function finalStatus(rec) { return rec.override?.status || rec.result.status; }

  function renderResult() {
    const rec = state.cur;
    const r = rec.result;
    const ai = r.ai || {};
    const st = finalStatus(rec);
    const metaBits = [rec.meta.serial && `#${rec.meta.serial}`, rec.meta.inspector, fmtDate(r.evaluatedAt || rec.createdAt)].filter(Boolean);
    const shotAngles = rec.angles.filter((a) => rec.shots[a.name]);

    const viewCards = rec.angles.map((a) => {
      const shot = rec.shots[a.name];
      const aa = (ai.angles || []).find((x) => x.angle?.toLowerCase() === a.name.toLowerCase()) || null;
      const rows = r.checklist.filter((c) => c.group === a.name);
      const q = aa?.image_quality;
      return `
        <article class="vcard">
          ${shot ? `<img src="${shot.dataUrl}" alt="${esc(a.name)} photo" data-zoom />` : '<div class="noimg">Not photographed</div>'}
          <div class="vbody">
            <div class="vhead">
              <h3>${esc(a.name)}</h3>
              ${q ? `<span class="badge ${q}">Photo ${q}</span>` : ''}
            </div>
            ${aa && aa.correct_view === false ? '<p class="sev high">This photo does not show the requested view.</p>' : ''}
            ${aa?.quality_issues?.length ? `<p class="muted">${esc(aa.quality_issues.join('; '))}</p>` : ''}
            ${rows.length ? `<ul class="plist">${rows.map(partRow).join('')}</ul>` : '<p class="muted">No required parts for this view.</p>'}
            ${aa?.observations?.length ? `<ul class="obs">${aa.observations.map((o) => `<li>${esc(o)}</li>`).join('')}</ul>` : ''}
          </div>
        </article>`;
    }).join('');

    const general = r.checklist.filter((c) => c.group === 'Any view');
    const defects = ai.defects || [];

    $('#view-result').innerHTML = `
      <div class="result-top">
        <div class="tag">
          <div class="tag-item">${esc(rec.item)}</div>
          <div class="tag-meta">${esc(metaBits.join('  ·  '))}</div>
          <span class="stamp ${st}">${st}</span>
          ${rec.module === 'scaffold' ? scaffoldTagHtml(rec) : ''}
          <div class="meter-label"><span>Checklist complete</span><span>${r.completion}%</span></div>
          <div class="meter" role="progressbar" aria-valuenow="${r.completion}" aria-valuemin="0" aria-valuemax="100"><div style="width:${r.completion}%"></div></div>
          <div class="counts">
            <div><b style="color:var(--pass)">${r.counts.present}</b><small>OK</small></div>
            <div><b style="color:var(--fail)">${r.counts.missing}</b><small>Not OK</small></div>
            <div><b style="color:var(--review)">${r.counts.unclear}</b><small>Unclear</small></div>
          </div>
          <ul class="reasons">${r.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
          <div class="override">
            <label class="field"><span>Inspector decision</span>
              <select id="ovStatus">
                <option value="">Use AI result (${r.status})</option>
                <option value="PASS">Override: PASS</option>
                <option value="FAIL">Override: FAIL</option>
                <option value="REVIEW">Override: REVIEW</option>
              </select>
            </label>
            <label class="field"><span>Remarks</span><textarea id="ovRemarks" rows="2" maxlength="500" placeholder="Reason for override, follow-up actions">${esc(rec.override.remarks)}</textarea></label>
            ${rec.override.status ? `<p class="muted">AI said ${r.status}; inspector changed it to ${rec.override.status}.</p>` : ''}
          </div>
        </div>

        <div class="panel summary-panel">
          <h2>Summary</h2>
          ${ai.item_matches === false ? `<div class="warn-box">The photos look like <b>${esc(ai.item_identified)}</b>, not ${esc(rec.item)}.</div>` : ''}
          <p>${esc(ai.summary || '')}</p>
          ${rec.meta.location || rec.meta.notes || rec.meta.gps ? `<p class="muted">${esc([rec.meta.location, rec.meta.notes, rec.meta.gps && `GPS ${rec.meta.gps.lat}, ${rec.meta.gps.lng}`].filter(Boolean).join(' | '))}</p>` : ''}
          ${ai.recommendations?.length ? `<h3>Recommended actions</h3><ul>${ai.recommendations.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
          <p class="muted">${r.liveStats ? esc(`Live scan: ${r.liveStats.calls} frames checked in ${r.liveStats.seconds}s. `) : ''}Checked by ${esc(r.provider === 'azure' ? 'Azure OpenAI' : r.provider)} (${esc(r.model)}). Checks below ${Math.round((r.minConfidence || 0) * 100)}% confidence count as unclear.${r.secondCheck ? ' Every OK result was double-checked by a second AI review.' : ''}</p>
          <div class="actions">
            <button type="button" class="btn primary" id="btnSave">${rec.saved ? 'Update saved copy' : 'Save to history'}</button>
            <button type="button" class="btn ghost" id="btnPrint">Print / save PDF</button>
            <button type="button" class="btn ghost" id="btnCsv">Export CSV</button>
            <button type="button" class="btn ghost" id="btnJson">Export JSON</button>
            ${rec.angles.length && Object.keys(rec.shots).length && !rec.fromHistory ? `<button type="button" class="btn ghost" id="btnRecapture">${rec.mode === 'live' ? 'Continue live scan' : 'Retake photos'}</button>` : ''}
            <button type="button" class="btn ghost" id="btnNewInspection">New inspection</button>
          </div>
        </div>
      </div>

      ${general.length ? `<div class="panel section"><h2>Checks across all views</h2><ul class="plist">${general.map(partRow).join('')}</ul></div>` : ''}

      ${defects.length ? `<div class="panel section"><h2>Damage and defects</h2><div class="table-wrap"><table class="defects">
          <thead><tr><th>View</th><th>Finding</th><th>Severity</th></tr></thead>
          <tbody>${defects.map((d) => `<tr><td>${esc(d.angle)}</td><td>${esc(d.description)}</td><td class="sev ${esc(d.severity)}">${esc(d.severity)}</td></tr>`).join('')}</tbody>
        </table></div></div>` : ''}

      <h2>Views</h2>
      <div class="views">${viewCards}</div>

      ${shotAngles.length ? `
      <div class="panel section">
        <h2>360° view and 3D render</h2>
        <div class="viewer-grid">
          <div>
            <div class="spin" id="spin"><img id="spinImg" alt="Item rotation view" /><span class="spin-label" id="spinLabel"></span></div>
            <div class="spin-ctrl">
              <button type="button" class="btn ghost small" id="spinPrev" aria-label="Previous view">◀</button>
              <button type="button" class="btn ghost small" id="spinPlay">Auto-rotate</button>
              <button type="button" class="btn ghost small" id="spinNext" aria-label="Next view">▶</button>
              <span class="muted">Drag the photo sideways to turn the item.</span>
            </div>
          </div>
          <div>
            <div class="render-box" id="renderBox">
              ${rec.render3d ? `<img src="${rec.render3d}" alt="AI 3D render of ${esc(rec.item)}" data-zoom />`
                : state.server.renderEnabled ? '<p>Build a single 3D-style product image from your photos.</p>'
                : '<p>AI 3D render is off. Deploy gpt-image-1 in Azure and set AZURE_OPENAI_IMAGE_DEPLOYMENT to turn it on.</p>'}
            </div>
            <div class="spin-ctrl">
              <button type="button" class="btn primary small" id="btnRender" ${state.server.renderEnabled ? '' : 'disabled'}>${rec.render3d ? 'Generate again' : 'Generate 3D render'}</button>
              ${rec.render3d ? `<a class="btn ghost small" download="${esc(rec.item)}-3d.png" href="${rec.render3d}">Download</a>` : ''}
            </div>
          </div>
        </div>
      </div>` : ''}
    `;

    // wire up
    $('#ovStatus').value = rec.override.status;
    $('#ovStatus').addEventListener('change', (e) => { rec.override.status = e.target.value; renderResult(); });
    $('#ovRemarks').addEventListener('input', (e) => { rec.override.remarks = e.target.value; });
    $('#btnSave').addEventListener('click', () => saveToHistory(rec));
    $('#btnPrint').addEventListener('click', () => window.print());
    $('#btnCsv').addEventListener('click', () => exportCsv(rec));
    $('#btnJson').addEventListener('click', () => download(`${slug(rec.item)}-${rec.id}.json`, JSON.stringify(stripForExport(rec), null, 2), 'application/json'));
    $('#btnNewInspection').addEventListener('click', () => { state.cur = null; $('#mSerial').value = ''; $('#mNotes').value = ''; show('setup'); });
    $('#btnRecapture')?.addEventListener('click', () => {
      if (rec.mode === 'live') { window.dispatchEvent(new CustomEvent('pc:resume-live')); return; }
      show('capture'); renderCapture(); startCamera();
    });
    $('#btnRender')?.addEventListener('click', () => generateRender(rec));
    $$('#view-result [data-zoom]').forEach((img) => img.addEventListener('click', () => zoom(img.src)));
    if (shotAngles.length) setupSpin(shotAngles.map((a) => ({ name: a.name, src: rec.shots[a.name].dataUrl })));
  }

  // ---------- scaffold tag (Green / Yellow / Red) ----------
  function scaffoldTag(rec) {
    const st = finalStatus(rec);
    const rows = rec.result?.checklist || [];
    const critBad = rows.some((c) => (c.critical ?? splitCheck(c.part).critical) && c.status !== 'present');
    if (rec.override?.status === 'PASS') return { color: 'GREEN', text: 'Safe to use – passed by inspector' };
    if (st === 'FAIL' || (st === 'REVIEW' && critBad)) return { color: 'RED', text: 'DO NOT USE – fix or verify the flagged items' };
    if (st === 'REVIEW') return { color: 'YELLOW', text: 'Use with caution – competent person to verify flagged items' };
    return { color: 'GREEN', text: 'AI pre-check passed – competent person to sign the tag' };
  }
  function scaffoldTagHtml(rec) {
    const t = scaffoldTag(rec);
    const sf = rec.scaffold || {};
    const facts = [sf.type, sf.duty, sf.height && `${sf.height} m`, sf.lifts && `${sf.lifts} lifts`, sf.erector && `Erected by ${sf.erector}`, sf.lastInspection && `Last insp. ${sf.lastInspection}`, sf.reason]
      .filter(Boolean).map(esc).join(' · ');
    return `<div class="sc-tag ${t.color}" role="status"><b>${t.color} TAG</b><span>${esc(t.text)}</span></div>
      ${facts ? `<p class="sc-facts">${facts}</p>` : ''}
      <p class="safety-note">AI pre-inspection only. Not a scaffold certificate – a competent person must inspect and sign before use.</p>`;
  }

  function partRow(c) {
    const where = c.group === 'Any view' && c.foundIn ? ` – seen in ${c.foundIn}` : '';
    return `<li>
      <span class="ic ${c.status}" aria-label="${STATUS_TEXT[c.status]}">${ICON[c.status]}</span>
      <span><span class="pn">${(c.critical ?? splitCheck(c.part).critical) ? '<span class="crit">CRITICAL</span> ' : ''}${esc(splitCheck(c.part).name)}</span>${splitCheck(c.part).rule ? `<span class="prule">Must be: ${esc(splitCheck(c.part).rule)}</span>` : ''}<span class="pnote">${esc(STATUS_TEXT[c.status] + where + (c.note ? ' – ' + c.note : ''))}</span></span>
      <span class="pc">${Math.round((c.confidence || 0) * 100)}%</span>
    </li>`;
  }

  function zoom(src) {
    const lb = document.createElement('div');
    lb.className = 'lightbox';
    lb.innerHTML = `<img src="${src}" alt="Enlarged photo" />`;
    lb.addEventListener('click', () => lb.remove());
    document.addEventListener('keydown', function k(e) { if (e.key === 'Escape') { lb.remove(); document.removeEventListener('keydown', k); } });
    document.body.appendChild(lb);
  }

  // 360° viewer: drag across captured views
  function setupSpin(frames) {
    let idx = 0;
    const img = $('#spinImg'), label = $('#spinLabel'), box = $('#spin');
    const draw = () => { img.src = frames[idx].src; label.textContent = `${frames[idx].name} (${idx + 1}/${frames.length})`; };
    const step = (d) => { idx = (idx + d + frames.length) % frames.length; draw(); };
    draw();
    $('#spinPrev').addEventListener('click', () => step(-1));
    $('#spinNext').addEventListener('click', () => step(1));
    $('#spinPlay').addEventListener('click', (e) => {
      if (state.spinTimer) { stopSpin(); e.target.textContent = 'Auto-rotate'; }
      else { state.spinTimer = setInterval(() => step(1), 900); e.target.textContent = 'Stop'; }
    });
    let startX = null;
    box.addEventListener('pointerdown', (e) => { startX = e.clientX; box.setPointerCapture(e.pointerId); });
    box.addEventListener('pointermove', (e) => {
      if (startX === null) return;
      const dx = e.clientX - startX;
      if (Math.abs(dx) > 45) { step(dx > 0 ? -1 : 1); startX = e.clientX; }
    });
    const end = () => { startX = null; };
    box.addEventListener('pointerup', end);
    box.addEventListener('pointercancel', end);
  }
  function stopSpin() { clearInterval(state.spinTimer); state.spinTimer = null; }

  async function generateRender(rec) {
    const images = rec.angles.filter((a) => rec.shots[a.name]).slice(0, 6).map((a) => rec.shots[a.name].dataUrl);
    loading(true, 'Creating 3D render… this can take up to a minute');
    try {
      const out = await api('/api/render3d', { item: rec.item, images });
      rec.render3d = out.image;
      renderResult();
      toast('3D render ready');
    } catch (e) { toast(e.message, true); }
    finally { loading(false); }
  }

  // ---------- export ----------
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'inspection';

  function download(name, content, type) {
    const blob = content instanceof Blob ? content : new Blob([content], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  function stripForExport(rec) {
    const { fromHistory, saved, ...rest } = rec;
    return { ...rest, finalStatus: finalStatus(rec) };
  }

  function exportCsv(rec) {
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['Item', 'Serial / scaffold ID', 'Inspector', 'Date', 'Final status', 'AI status', 'Scaffold tag', 'Completion %', 'View', 'Check', 'Critical', 'Status', 'Confidence %', 'Note'];
    const tag = rec.module === 'scaffold' ? scaffoldTag(rec).color : '';
    const rows = rec.result.checklist.map((c) => [
      rec.item, rec.meta.serial, rec.meta.inspector, fmtDate(rec.result.evaluatedAt), finalStatus(rec), rec.result.status,
      tag, rec.result.completion, c.group, c.part, (c.critical ?? splitCheck(c.part).critical) ? 'yes' : '', c.status, Math.round(c.confidence * 100), c.note,
    ]);
    const csv = '\uFEFF' + [head, ...rows].map((r) => r.map(q).join(',')).join('\r\n');
    download(`${slug(rec.item)}-${rec.id}.csv`, csv, 'text/csv;charset=utf-8');
  }

  // ---------- history (stored on this device) ----------
  function shrink(dataUrl, side = THUMB_SIDE, qual = 0.6) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const s = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', qual));
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }

  async function saveToHistory(rec) {
    const small = { ...clone({ ...rec, shots: {}, render3d: null }), saved: true, fromHistory: false };
    for (const [name, s] of Object.entries(rec.shots)) {
      small.shots[name] = { ...s, dataUrl: await shrink(s.dataUrl) };
    }
    if (rec.render3d) small.render3d = await shrink(rec.render3d, 512, 0.7);

    let hist = LS.get('pc_history', []).filter((h) => h.id !== rec.id);
    hist.unshift(small);
    let ok = LS.set('pc_history', hist);
    let dropped = 0;
    while (!ok && hist.length > 1) { hist.pop(); dropped++; ok = LS.set('pc_history', hist); }
    if (!ok) { toast('Device storage is full. Export and clear history first.', true); return; }
    rec.saved = true;
    renderResult();
    toast(dropped ? `Saved. ${dropped} oldest inspection(s) removed to make space.` : 'Saved to history');
  }

  function renderHistory() {
    const hist = LS.get('pc_history', []);
    const list = $('#historyList');
    if (!hist.length) {
      list.innerHTML = '<div class="empty"><p><b>No saved inspections yet.</b></p><p class="muted">Finish an inspection and choose Save to history.</p><button type="button" class="btn primary" data-go="setup">Start an inspection</button></div>';
      $('[data-go]', list).addEventListener('click', () => show('setup'));
      return;
    }
    list.innerHTML = hist.map((h) => {
      const first = Object.values(h.shots)[0];
      const st = h.override?.status || h.result.status;
      return `<div class="hrow">
        ${first?.dataUrl ? `<img src="${first.dataUrl}" alt="" />` : '<img alt="" />'}
        <div>
          <div class="ht">${esc(h.item)}${h.meta.serial ? ' · #' + esc(h.meta.serial) : ''}</div>
          <div class="hs">${esc(fmtDate(h.result.evaluatedAt || h.createdAt))} · ${h.result.completion}% complete${h.meta.inspector ? ' · ' + esc(h.meta.inspector) : ''}</div>
        </div>
        <div class="hbtns">
          ${h.module === 'scaffold' ? `<span class="htag ${scaffoldTag(h).color}">${scaffoldTag(h).color}</span>` : ''}
          <span class="hstat ${st}">${st}</span>
          <button type="button" class="btn ghost small" data-open="${h.id}">Open</button>
          <button type="button" class="btn danger-ghost small" data-del="${h.id}" aria-label="Delete">✕</button>
        </div>
      </div>`;
    }).join('');
    $$('[data-open]', list).forEach((b) => b.addEventListener('click', () => {
      const rec = LS.get('pc_history', []).find((h) => h.id === b.dataset.open);
      if (!rec) return;
      state.cur = { ...rec, fromHistory: true, saved: true };
      renderResult();
      show('result');
    }));
    $$('[data-del]', list).forEach((b) => b.addEventListener('click', () => {
      if (!confirm('Delete this inspection?')) return;
      LS.set('pc_history', LS.get('pc_history', []).filter((h) => h.id !== b.dataset.del));
      renderHistory();
    }));
  }

  $('#btnExportAll').addEventListener('click', () => {
    const hist = LS.get('pc_history', []);
    if (!hist.length) { toast('Nothing to export yet.'); return; }
    download(`partcheck-history-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(hist, null, 2), 'application/json');
  });
  $('#btnClearHistory').addEventListener('click', () => {
    if (!confirm('Delete ALL saved inspections from this device?')) return;
    LS.set('pc_history', []);
    renderHistory();
    toast('History cleared');
  });

  // ---------- navigation ----------
  $$('[data-nav]').forEach((el) => el.addEventListener('click', (e) => {
    e.preventDefault();
    const v = el.dataset.nav;
    if (v === 'history') renderHistory();
    show(v);
  }));

  window.addEventListener('beforeunload', (e) => {
    if (state.cur && Object.keys(state.cur.shots).length && !state.cur.saved) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---------- bridge for live.js ----------
  window.PartCheck = { state, $, $$, esc, toast, loading, show, api, analyze, watermark, newRecord, renderResult, evaluate, createFlash, LS, checkLabel, splitCheck };

  // ---------- boot ----------
  $('#sfErector').value = LS.get('pc_scaffold_last', {}).erector || '';
  setModule(state.module);
  show('setup');
  loadServerInfo();
})();
