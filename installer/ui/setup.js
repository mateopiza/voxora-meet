// Instalador de VOXORA Meet — lógica de la UI. Habla con VoxoraMeetSetup.exe por
// window.chrome.webview.postMessage (UI → exe) y mensajes JSON (exe → UI):
//   UI → exe  ready | rendered | drag | minimize | close | browse {dir} | checkDir {dir}
//             install {dir, desktop} | uninstall {purge} | finish {launch} | openUrl {url} | openLog
//   exe → UI  init {...dirInfo, mode, version, preview, capture, screen, installed, uninstallDir}
//             dirInfo {dir, valid, freeText, requiredText, enoughSpace, programFiles}
//             progress {percent?, step, detail} | done {ok, error, cameraRegistered, cameraMessage, virtualMic, rebootNeeded}
// Abierto en un navegador normal (sin WebView2) usa un anfitrión simulado para diseñar.
(() => {
  'use strict';
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const host = window.chrome && window.chrome.webview;

  const INSTALL_STEPS = [
    { id: 'welcome', label: 'Bienvenida', sub: 'Qué es VOXORA Meet' },
    { id: 'license', label: 'Licencia', sub: 'Uso y privacidad' },
    { id: 'location', label: 'Ubicación', sub: 'Carpeta y accesos' },
    { id: 'progress', label: 'Instalación', sub: 'Copia y registro' },
    { id: 'done', label: 'Listo', sub: 'A doblar' },
  ];
  const UNINSTALL_STEPS = [
    { id: 'uninstall', label: 'Confirmar', sub: 'Qué se quita' },
    { id: 'progress', label: 'Desinstalación', sub: 'Archivos y registro' },
    { id: 'done', label: 'Listo', sub: 'Hasta pronto' },
  ];
  const INSTALL_PHASES = [
    { id: 'verify', label: 'Verificar el paquete', steps: ['verify', 'close'] },
    { id: 'files', label: 'Copiar archivos', steps: ['files', 'cleanup'] },
    { id: 'camera', label: 'Registrar la cámara virtual', steps: ['camera'] },
    { id: 'shortcuts', label: 'Accesos directos', steps: ['shortcuts'] },
    { id: 'registry', label: 'Registrar en Windows', steps: ['registry', 'done'] },
  ];
  const UNINSTALL_PHASES = [
    { id: 'close', label: 'Cerrar VOXORA Meet', steps: ['close'] },
    { id: 'camera', label: 'Quitar la cámara virtual', steps: ['camera', 'shortcuts'] },
    { id: 'files', label: 'Borrar archivos', steps: ['files'] },
    { id: 'registry', label: 'Quitar de Windows', steps: ['registry', 'data', 'done'] },
  ];

  const state = { mode: 'install', screen: null, dir: '', info: null, busy: false, result: null, phases: INSTALL_PHASES, capture: false };

  function send(msg) {
    if (host) host.postMessage(msg);
    else mockHost(msg);
  }

  // ── Ondas de voz (firma visual) ───────────────────────────────────────────
  function buildWave(el, count) {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < count; i += 1) {
      const bar = document.createElement('i');
      const t = i / (count - 1);
      const envelope = Math.sin(Math.PI * t) * 0.75 + 0.25;
      const jitter = 0.55 + 0.45 * Math.abs(Math.sin(i * 1.7) * Math.cos(i * 0.6));
      bar.style.setProperty('--s', Math.max(0.12, envelope * jitter).toFixed(3));
      bar.style.setProperty('--d', `${(-(i * 97) % 1250) / 1000}s`);
      frag.append(bar);
    }
    el.replaceChildren(frag);
  }

  // ── Pasos del lateral ─────────────────────────────────────────────────────
  function renderSteps() {
    const steps = state.mode === 'uninstall' ? UNINSTALL_STEPS : INSTALL_STEPS;
    $('#steps').replaceChildren(...steps.map((s, i) => {
      const li = document.createElement('li');
      li.className = 'step';
      li.dataset.step = s.id;
      li.innerHTML = `<span class="step__dot"><span>${i + 1}</span><svg class="i"><use href="#i-check"/></svg></span><span class="step__label"></span>`;
      const label = li.querySelector('.step__label');
      label.textContent = s.label;
      const sub = document.createElement('span');
      sub.className = 'step__sub';
      sub.textContent = s.sub;
      label.append(sub);
      return li;
    }));
  }

  function markSteps(screen) {
    const steps = $$('.step');
    const ids = steps.map((s) => s.dataset.step);
    let idx = ids.indexOf(screen === 'error' ? 'progress' : screen);
    if (idx < 0) idx = 0;
    const finished = screen === 'done';
    steps.forEach((el, i) => {
      el.classList.toggle('is-done', i < idx || (finished && i === idx));
      el.classList.toggle('is-active', i === idx && !finished);
    });
    const fill = steps.length > 1 ? (idx / (steps.length - 1)) * 100 : 0;
    $('#steps').style.setProperty('--fill', `${fill}%`);
  }

  function show(screen) {
    const prev = state.screen;
    if (prev === screen) return;
    for (const el of $$('.screen')) {
      const active = el.dataset.screen === screen;
      el.classList.toggle('is-active', active);
      el.classList.toggle('is-leaving', !active && el.dataset.screen === prev);
    }
    state.screen = screen;
    markSteps(screen);
    const focus = $(`.screen[data-screen="${screen}"] .btn--brand, .screen[data-screen="${screen}"] .btn--danger`);
    if (focus && !focus.disabled) setTimeout(() => focus.focus({ preventScroll: true }), 120);
  }

  // ── Ubicación ─────────────────────────────────────────────────────────────
  function applyDirInfo(info) {
    state.info = info;
    state.dir = info.dir || state.dir;
    $('#dirText').textContent = state.dir;
    $('#dirText').title = state.dir;
    $('#needText').textContent = info.requiredText || '—';
    $('#freeText').textContent = info.freeText || '—';
    $('#freeText').parentElement.classList.toggle('stat--bad', info.valid !== false && info.enoughSpace === false);
    const note = $('#dirNote');
    let text = '';
    let warn = false;
    if (info.valid === false) { text = 'Esa carpeta no es válida. Elige otra en un disco local.'; warn = true; }
    else if (info.enoughSpace === false) { text = `No hay espacio suficiente en ese disco (hacen falta ${info.requiredText}).`; warn = true; }
    else if (!info.programFiles) { text = 'Fuera de «Archivos de programa» el instalador dará permiso de lectura al servicio de cámara de Windows sobre esta carpeta.'; }
    note.hidden = !text;
    note.textContent = text;
    note.classList.toggle('note--warn', warn);
    $('#installCta').disabled = info.valid === false || info.enoughSpace === false;
  }

  // ── Progreso ──────────────────────────────────────────────────────────────
  const RING = 427.26;
  function renderPhases() {
    $('#phases').replaceChildren(...state.phases.map((p) => {
      const li = document.createElement('li');
      li.className = 'phase';
      li.dataset.phase = p.id;
      li.innerHTML = '<span class="phase__dot"><svg class="i"><use href="#i-check"/></svg></span><span></span>';
      li.lastChild.textContent = p.label;
      return li;
    }));
  }

  function setProgress(percent, step, detail) {
    if (typeof percent === 'number') {
      const pct = Math.max(0, Math.min(100, percent));
      $('#ringBar').style.strokeDashoffset = String(RING * (1 - pct / 100));
      $('#pctText').textContent = String(Math.floor(pct));
    }
    if (detail) $('#progDetail').textContent = detail;
    if (step) {
      const current = state.phases.findIndex((p) => p.steps.includes(step));
      $$('.phase').forEach((el, i) => {
        el.classList.toggle('is-done', current >= 0 && (i < current || step === 'done'));
        el.classList.toggle('is-active', i === current && step !== 'done');
      });
    }
  }

  function startWork() {
    state.busy = true;
    document.body.classList.add('is-busy');
    renderPhases();
    setProgress(0, state.phases[0].steps[0], 'Preparando…');
    show('progress');
    if (state.mode === 'uninstall') {
      send({ type: 'uninstall', purge: $('#purge').checked });
    } else {
      send({ type: 'install', dir: state.dir, desktop: $('#desktop').checked });
    }
  }

  function onDone(r) {
    state.busy = false;
    state.result = r;
    document.body.classList.remove('is-busy');
    if (!r.ok) {
      $('#errTitle').textContent = state.mode === 'uninstall' ? 'No se pudo completar la desinstalación' : 'No se pudo completar la instalación';
      $('#errText').textContent = r.error || 'Error desconocido.';
      show('error');
      return;
    }
    setProgress(100, 'done', state.mode === 'uninstall' ? 'VOXORA Meet se desinstaló.' : 'VOXORA Meet está instalado.');
    fillDone(r);
    setTimeout(() => show('done'), state.capture ? 0 : 650);
  }

  function fillDone(r) {
    const uninstall = state.mode === 'uninstall';
    $('#doneEyebrow').textContent = uninstall ? 'Desinstalación completada' : 'Instalación completada';
    $('#doneTitle').textContent = uninstall ? 'Hasta pronto.' : 'Todo listo.';
    const purge = $('#purge').checked;
    $('#doneLead').textContent = uninstall
      ? (purge ? 'VOXORA Meet y tus datos se borraron de este equipo. Gracias por usarlo.' : 'VOXORA Meet se quitó de este equipo. Tus ajustes y voces siguen guardados por si vuelves.')
      : `VOXORA Meet quedó instalado en ${state.dir}. Ábrelo, pega tus API keys y elige «VOXORA Meet Camera» en Meet.`;
    $('#doneCards').hidden = uninstall;
    $('#launchRow').hidden = uninstall;
    $('#finishCta').textContent = uninstall ? 'Cerrar' : 'Finalizar';
    $('#rebootNote').hidden = !r.rebootNeeded;
    if (uninstall) return;
    $('#camText').textContent = r.cameraMessage || (r.cameraRegistered ? '«VOXORA Meet Camera» registrada.' : 'No se pudo registrar.');
    $('#camBadge').textContent = r.cameraRegistered ? 'Lista' : 'Revisar';
    $('#camBadge').className = `badge${r.cameraRegistered ? '' : ' badge--warn'}`;
    $('#camCard').classList.toggle('is-warn', !r.cameraRegistered);
    const mic = r.virtualMic || {};
    $('#micCard').classList.toggle('is-warn', !mic.present);
    $('#micBadge').textContent = mic.present ? 'Detectado' : 'Falta';
    $('#micBadge').className = `badge${mic.present ? '' : ' badge--warn'}`;
    $('#micText').textContent = mic.present
      ? `${mic.ownDriver ? 'Driver de VOXORA' : mic.name || 'VB-CABLE'}: Meet escuchará tu voz doblada.`
      : 'Para que Meet escuche tu voz doblada instala VB-CABLE (gratis) y reinicia VOXORA Meet.';
    $('#micLink').hidden = Boolean(mic.present);
  }

  // ── Mensajes del instalador ──────────────────────────────────────────────
  function onInit(m) {
    state.mode = m.mode === 'uninstall' ? 'uninstall' : 'install';
    state.phases = state.mode === 'uninstall' ? UNINSTALL_PHASES : INSTALL_PHASES;
    state.capture = Boolean(m.capture);
    document.documentElement.classList.toggle('is-capture', state.capture);
    $('#versionChip').textContent = `v${m.version}`;
    $('#titlebarTitle').textContent = state.mode === 'uninstall' ? 'Desinstalador' : `Instalador · ${m.version}${m.preview ? ' · vista previa' : ''}`;
    renderSteps();
    applyDirInfo(m);
    const installed = m.installed;
    if (state.mode === 'install' && installed && installed.version) {
      const cmp = compareVersions(installed.version, m.version);
      $('#welcomeEyebrow').textContent = cmp < 0 ? `Actualización · ${installed.version} → ${m.version}` : cmp === 0 ? `Reinstalar · ${m.version}` : `Versión instalada más reciente · ${installed.version}`;
      $('#welcomeCta').firstChild.textContent = cmp < 0 ? 'Actualizar' : 'Comenzar';
    } else {
      $('#welcomeEyebrow').textContent = `Instalador · VOXORA Meet ${m.version}`;
    }
    $('#welcomeHint').textContent = m.requiredText && m.requiredText !== '0 MB' ? `Menos de un minuto · ${m.requiredText}` : '';
    $('#progEyebrow').textContent = state.mode === 'uninstall' ? 'Desinstalando' : 'Paso 4 de 4';
    $('#progTitle').textContent = state.mode === 'uninstall' ? 'Desinstalando VOXORA Meet' : installed ? 'Actualizando VOXORA Meet' : 'Instalando VOXORA Meet';
    $('#uninstallDir').textContent = m.uninstallDir || m.dir || '—';
    document.body.classList.remove('is-loading');
    openScreen(m.screen);
  }

  // /preview /screen=<id>: salta directo a una pantalla con datos de ejemplo.
  function openScreen(screen) {
    const s = String(screen || '');
    const sample = (mic) => ({ ok: true, cameraRegistered: true, cameraMessage: 'Cámara virtual «VOXORA Meet Camera» registrada.', virtualMic: mic, rebootNeeded: false });
    if (s === 'license') { show('license'); }
    else if (s === 'location') { $('#accept').checked = true; $('#acceptCta').disabled = false; show('location'); }
    else if (s === 'progress') { renderPhases(); document.body.classList.add('is-busy'); setProgress(64, 'files', 'Copiando node\\node.exe'); show('progress'); }
    else if (s === 'done') { fillDone(sample({ present: false })); show('done'); }
    else if (s === 'done-ok') { fillDone(sample({ present: true, name: 'CABLE Input (VB-Audio Virtual Cable)' })); show('done'); }
    else if (s === 'error') { $('#errText').textContent = 'No hay espacio suficiente en el disco (hacen falta 160 MB).'; show('error'); }
    else if (s === 'uninstall-done') { fillDone({ ok: true }); show('done'); }
    else show(state.mode === 'uninstall' ? 'uninstall' : 'welcome');
    requestAnimationFrame(() => setTimeout(() => send({ type: 'rendered', screen: state.screen }), 350));
  }

  function onMessage(m) {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'init') onInit(m);
    else if (m.type === 'dirInfo') applyDirInfo(m);
    else if (m.type === 'progress') setProgress(m.percent, m.step, m.detail);
    else if (m.type === 'done') onDone(m);
  }

  function compareVersions(a, b) {
    const pa = String(a).split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
    const pb = String(b).split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
    for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
    return 0;
  }

  // ── Eventos de la UI ──────────────────────────────────────────────────────
  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (go && !go.disabled) { show(go.dataset.go); return; }
    const act = e.target.closest('[data-act]');
    const url = e.target.closest('[data-url]');
    if (url) { send({ type: 'openUrl', url: url.dataset.url }); return; }
    if (!act || act.disabled) return;
    switch (act.dataset.act) {
      case 'minimize': send({ type: 'minimize' }); break;
      case 'close': if (!state.busy) send({ type: 'close' }); break;
      case 'browse': send({ type: 'browse', dir: state.dir }); break;
      case 'install': startWork(); break;
      case 'uninstall': startWork(); break;
      case 'finish': send({ type: 'finish', launch: state.mode === 'install' && $('#launch').checked }); break;
      case 'openLog': send({ type: 'openLog' }); break;
      default: break;
    }
  });
  $('#accept').addEventListener('change', (e) => { $('#acceptCta').disabled = !e.target.checked; });
  // Arrastre de la ventana (si el runtime no admite `app-region: drag`, el exe lo hace a mano).
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.detail > 1) return;
    const drag = e.target.closest('[data-drag], .rail');
    if (drag && !e.target.closest('button, input, label, a')) send({ type: 'drag' });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !state.busy && state.screen !== 'progress') send({ type: 'close' });
    if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') {
      const cta = $(`.screen[data-screen="${state.screen}"] .btn--brand`);
      if (cta && !cta.disabled) cta.click();
    }
  });
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  buildWave($('#welcomeWave'), 42);
  buildWave($('#progressWave'), 90);
  if (host) host.addEventListener('message', (e) => onMessage(e.data));

  // ── Anfitrión simulado (navegador normal) ────────────────────────────────
  function mockHost(msg) {
    const reply = (m) => setTimeout(() => onMessage(m), 30);
    const params = new URLSearchParams(location.search);
    const info = (dir) => ({ type: 'dirInfo', dir, valid: true, freeText: '212,4 GB', requiredText: '164 MB', enoughSpace: true, programFiles: /Program Files/i.test(dir) });
    if (msg.type === 'ready') {
      reply({ ...info('C:\\Program Files\\VOXORA Meet'), type: 'init', mode: params.get('mode') || 'install', version: '0.2.0', preview: true, capture: params.has('capture'), screen: params.get('screen') || '', installed: null, uninstallDir: 'C:\\Program Files\\VOXORA Meet' });
    } else if (msg.type === 'browse') {
      reply(info('D:\\Apps\\VOXORA Meet'));
    } else if (msg.type === 'install' || msg.type === 'uninstall') {
      let p = 0;
      const steps = msg.type === 'install' ? ['verify', 'files', 'files', 'files', 'camera', 'shortcuts', 'registry'] : ['close', 'camera', 'files', 'files', 'registry'];
      const timer = setInterval(() => {
        p += 4;
        const step = steps[Math.min(steps.length - 1, Math.floor((p / 100) * steps.length))];
        reply({ type: 'progress', percent: p, step, detail: step === 'files' ? 'Copiando node\\node.exe' : 'Trabajando…' });
        if (p >= 100) { clearInterval(timer); reply({ type: 'done', ok: true, cameraRegistered: true, cameraMessage: 'Cámara virtual «VOXORA Meet Camera» registrada.', virtualMic: { present: false } }); }
      }, 120);
    }
  }

  send({ type: 'ready' });
})();
