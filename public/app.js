'use strict';
/* «Глобальный ИИ» — клиент. Ванильный JS. Весь расчёт — на сервере, здесь только отображение и намерения. */

// ------------------------------------------------------------------ утилиты
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// ввод принимает «0,5» и «0.5»; всё хранится и показывается до сотых
const num = (v) => { const x = parseFloat(String(v == null ? '' : v).replace(',', '.')); return isFinite(x) && x > 0 ? Math.round(x * 100) / 100 : 0; };
const fx = (x) => (Math.round((Number(x) || 0) * 100) / 100).toFixed(2).replace('.', ',');
const sgn = (x) => (x > 0.004 ? '+' : x < -0.004 ? '−' : '') + fx(Math.abs(x));
const GROUPS = {
  I: 'I. Материально-физическая и вычислительная база', II: 'II. Программно-алгоритмический потенциал',
  III: 'III. Данные, модели и информационная безопасность', IV: 'IV. Люди, организация и экономика внедрения',
  V: 'V. Правовая, институциональная и социальная среда', VI: 'VI. Устойчивость жизненного цикла',
};
const SCALES = [['ai', 'ИИ'], ['science', 'Наука'], ['fp', 'Внешняя политика'], ['transform', 'Трансформация']];
const KEY = 'globalAI.session';

const S = {
  room: null, token: null, cfg: null, st: null, plan: null, planYear: null, skew: 0, es: null, sel: null,
  finAnim: false, // ponytail: анимация итогов проигрывается один раз за партию
  lastPhase: null, // фаза предыдущего рендера — по ней ловится момент «игра → итоги»
  raw: {}, // path -> строка, которую игрок набрал (не перетирается ре-рендером)
  ui: { tab: 'transform', nick: '', roomcode: '', tf: { give: { res: {}, techs: [] }, want: { res: {}, techs: [] }, years: 1, gr: 'energy', ga: '0.5', gt: '', wr: 'energy', wa: '0.5', wt: '' }, npc: { npc: '', give: 'energy', want: 'chem', amount: '0.5' } },
};

function toast(msg, info) {
  const d = document.createElement('div');
  d.className = 'toast' + (info ? ' info' : '');
  d.textContent = msg;
  $('#toasts').appendChild(d);
  setTimeout(() => d.remove(), 4500);
}
async function api(name, body = {}) {
  const r = await fetch('/api/' + name, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: S.room, token: S.token, ...body }) });
  const d = await r.json().catch(() => ({ error: 'Ошибка ответа сервера' }));
  if (!r.ok) throw Object.assign(new Error(d.error || 'Ошибка'), { status: r.status });
  return d;
}
const run = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };
function setPath(root, path, val) {
  const ks = path.split('.'); let o = root;
  for (let i = 0; i < ks.length - 1; i++) { if (o[ks[i]] == null || typeof o[ks[i]] !== 'object') o[ks[i]] = {}; o = o[ks[i]]; }
  o[ks[ks.length - 1]] = val;
}
const getPath = (root, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), root);
const cname = (id) => (S.cfg.countries.find((c) => c.id === id) || { name: id }).name;
const rname = (id) => (S.cfg.resources.find((c) => c.id === id) || { name: id }).name;
const sname = (id) => (S.cfg.spheres.find((c) => c.id === id) || { name: id }).name;
function statusLabel(code) {
  for (const l of S.cfg.ladder) {
    if ('le' in l && code <= l.le) return l.label;
    if ('lt' in l && code < l.lt) return l.label;
    if ('eq' in l && code === l.eq) return l.label;
    if (l.else) return l.label;
  }
  return '';
}

// ------------------------------------------------------------------ сеанс / SSE
function saveSession() { localStorage.setItem(KEY, JSON.stringify({ room: S.room, token: S.token, nick: S.ui.nick })); }
function leave() {
  if (S.es) S.es.close();
  S.es = null; S.room = S.token = S.st = S.plan = S.cfg = null; S.sel = null;
  S.finAnim = false; S.lastPhase = null;
  stopOutro();
  MAP.intro = null; MAP.introDone = false; setMapGlow(null); setMapLocator(null); mapUnfocus(0);
  const cv = document.getElementById('confetti'); if (cv) cv.remove();
  localStorage.removeItem(KEY);
  render();
}
function connect() {
  if (S.es) S.es.close();
  S.es = new EventSource(`/events?room=${encodeURIComponent(S.room)}&token=${S.token}`);
  S.es.onmessage = () => refresh();
}
let refreshing = false, again = false;
async function refresh() {
  if (!S.room) return;
  if (refreshing) { again = true; return; }
  refreshing = true;
  try {
    if (!S.cfg) S.cfg = await api('cfg');
    applyState(await api('state'));
  } catch (e) {
    if (e.status === 403 || e.status === 404) { leave(); toast('Сессия недействительна'); }
  } finally { refreshing = false; if (again) { again = false; refresh(); } }
}
function applyState(st) {
  S.skew = st.now - Date.now();
  S.st = st;
  if (st.game && st.me.plan && (S.planYear !== st.game.year || !S.plan)) { S.plan = JSON.parse(JSON.stringify(st.me.plan)); S.planYear = st.game.year; S.raw = {}; }
  render();
}
async function enter(room, token) {
  S.room = room; S.token = token; S.finAnim = false; saveSession();
  connect(); await refresh();
}
let saveT = null;
function schedSave() {
  clearTimeout(saveT);
  saveT = setTimeout(run(async () => { applyState(await api('plan', { plan: S.plan })); }), 350);
}
async function flushSave() { clearTimeout(saveT); applyState(await api('plan', { plan: S.plan })); }

// ------------------------------------------------------------------ карта
const ATLAS = 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json';
const MAP = { host: null, state: 'idle', paths: {}, dots: {}, feats: {}, geom: {}, geoPath: null, mode: null, iso2cid: {}, intro: null, introDone: false, glow: null, loc: null };
function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('CDN недоступен')); document.head.appendChild(s); });
}
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
async function initMap() {
  MAP.state = 'loading';
  try {
    await withTimeout((async () => {
      if (!window.d3) await loadScript('https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js');
      if (!window.topojson) await loadScript('https://cdn.jsdelivr.net/npm/topojson-client@3/dist/topojson-client.min.js');
      const world = await (await fetch(ATLAS)).json();
      buildSvg(world);
    })(), 9000);
    MAP.state = 'ready';
  } catch (e) { MAP.state = 'failed'; buildChips(); }
  updateMap();
  runMapIntro();
}
function buildSvg(world) {
  const feats = topojson.feature(world, world.objects.countries).features;
  const proj = d3.geoNaturalEarth1().fitSize([960, 500], { type: 'Sphere' });
  const path = d3.geoPath(proj);
  MAP.host.innerHTML = '';
  MAP.geoPath = path; MAP.feats = {}; MAP.geom = {};
  const svg = d3.select(MAP.host).append('svg').attr('viewBox', '0 0 960 500');
  svg.append('path').attr('class', 'sphere').attr('d', path({ type: 'Sphere' }));
  svg.append('g').selectAll('path').data(feats).join('path').attr('class', 'land').attr('d', path).each(function (d) {
    const cid = MAP.iso2cid[+d.id];
    this.setAttribute('fill', '#1b2230'); this.setAttribute('stroke', '#2b3547');
    if (cid) { MAP.paths[cid] = this; MAP.feats[cid] = d; this.dataset.cid = cid; this.dataset.act = 'mapclick'; this.style.cursor = 'pointer'; }
  });
  const pts = { israel: [34.9, 31.5], uae: [54.3, 24.0] };
  for (const cid in pts) {
    const [x, y] = proj(pts[cid]);
    const c = svg.append('circle').attr('cx', x).attr('cy', y).attr('r', 5.5).attr('class', 'mk').attr('data-cid', cid).attr('data-act', 'mapclick');
    MAP.dots[cid] = c.node();
  }
}
function buildChips() {
  MAP.host.innerHTML = '<div class="chips"></div>';
  const box = MAP.host.firstChild;
  for (const c of S.cfg.countries) {
    const d = document.createElement('div');
    d.className = 'mchip'; d.textContent = c.name; d.dataset.cid = c.id; d.dataset.act = 'mapclick';
    box.appendChild(d); MAP.paths[c.id] = d;
  }
}
function mapHost() {
  if (!MAP.host) {
    MAP.host = document.createElement('div');
    MAP.host.className = 'mapbox';
    MAP.host.innerHTML = '<div class="maploading">Загрузка карты…</div>';
    for (const c of S.cfg.countries) MAP.iso2cid[c.iso] = c.id;
    initMap();
  }
  return MAP.host;
}
/** fn(cid) -> {fill, stroke, dash, title} */
function updateMap() {
  if (!MAP.mode || MAP.state === 'idle' || MAP.state === 'loading') return;
  for (const cid of Object.keys(MAP.paths)) {
    const st = MAP.mode(cid), el = MAP.paths[cid];
    if (MAP.state === 'failed') { el.style.background = st.fill; el.style.borderColor = st.stroke; el.style.color = st.text || '#fff'; el.title = st.title || ''; continue; }
    el.setAttribute('fill', st.fill); el.setAttribute('stroke', st.stroke); el.setAttribute('stroke-width', st.w || 1);
    el.setAttribute('stroke-dasharray', st.dash || '');
    let t = el.querySelector('title'); if (!t) { t = document.createElementNS('http://www.w3.org/2000/svg', 'title'); el.appendChild(t); }
    t.textContent = st.title || '';
  }
  for (const cid of Object.keys(MAP.dots)) {
    const st = MAP.mode(cid), el = MAP.dots[cid];
    el.setAttribute('fill', st.fill === 'transparent' ? '#444' : st.fill); el.setAttribute('stroke', st.stroke);
    el.setAttribute('stroke-dasharray', st.dash || '');
  }
}
function attachMap() {
  const ph = $('#mapslot'); if (!ph) return;
  ph.appendChild(mapHost());
  updateMap();
  runMapIntro();
}

// ---- камера карты: приближение к стране и подсветка. Второго рендерера нет — только CSS-трансформ существующего <svg>.
const mapSvg = () => (MAP.host ? MAP.host.querySelector('svg') : null);
/** Крупнейший полигон страны: для США — континентальная часть, для Франции — метрополия, а не Гвиана.
 *  Центр общего bbox мультиполигона уезжает в океан, центроид всей фичи взвешен по заморским территориям. */
function mainPolygon(feat) {
  const g = feat && feat.geometry; if (!g) return null;
  if (g.type === 'Polygon') return g;
  if (g.type !== 'MultiPolygon' || !MAP.geoPath) return null;
  let best = null, bestA = -1;
  for (const coords of g.coordinates) {
    const poly = { type: 'Polygon', coordinates: coords };
    const a = Math.abs(MAP.geoPath.area(poly));
    if (a > bestA) { bestA = a; best = poly; }
  }
  return best;
}
/** Центр и размер страны в единицах viewBox — общая опора для наезда камеры и локатора. */
function countryGeom(cid) {
  if (!cid) return null;
  if (MAP.geom[cid]) return MAP.geom[cid];
  let g = null;
  const main = MAP.geoPath && mainPolygon(MAP.feats[cid]);
  if (main) {
    const c = MAP.geoPath.centroid(main), b = MAP.geoPath.bounds(main);
    if (isFinite(c[0]) && isFinite(c[1])) g = { cx: c[0], cy: c[1], w: Math.abs(b[1][0] - b[0][0]), h: Math.abs(b[1][1] - b[0][1]) };
  }
  if (!g) { // фолбэк: отрисованный путь или точечный маркер
    const el = MAP.paths[cid] || MAP.dots[cid];
    let b = null;
    if (el && typeof el.getBBox === 'function') { try { b = el.getBBox(); } catch (_) { b = null; } }
    if (b && (b.width || b.height)) g = { cx: b.x + b.width / 2, cy: b.y + b.height / 2, w: b.width, h: b.height };
  }
  if (g) MAP.geom[cid] = g;
  return g;
}
/** Приблизить карту к стране. Вернёт false, если карта не отрисована (фолбэк-чипы, CDN недоступен). */
function mapFocus(cid, scale, ms) {
  const svg = mapSvg(); if (!svg) return false;
  const g = countryGeom(cid); if (!g) return false;
  const cx = (g.cx / 960) * 100, cy = (g.cy / 500) * 100;
  svg.style.transition = ms ? `transform ${ms}ms cubic-bezier(.33,.72,.25,1)` : 'none';
  svg.style.transformOrigin = `${cx.toFixed(2)}% ${cy.toFixed(2)}%`;
  svg.style.transform = `scale(${scale})`;
  return true;
}
function mapUnfocus(ms) {
  const svg = mapSvg(); if (!svg) return;
  svg.style.transition = ms ? `transform ${ms}ms cubic-bezier(.33,.72,.25,1)` : 'none';
  svg.style.transform = 'scale(1)';
}
function setMapGlow(cid) {
  const prev = MAP.glow && (MAP.paths[MAP.glow] || MAP.dots[MAP.glow]);
  if (prev) prev.classList.remove('ownglow');
  MAP.glow = cid || null;
  const el = cid && (MAP.paths[cid] || MAP.dots[cid]);
  if (el) el.classList.add('ownglow');
}
/** Масштаб наезда считается по размеру крупнейшего полигона страны: крупная страна берётся почти целиком,
 *  точечная — приближается сильнее, пока не станет различимой. */
function focusScale(cid, min, max) {
  const g = countryGeom(cid);
  if (!g) return min;
  const span = Math.max(g.w / 960, g.h / 500);
  if (!(span > 0)) return max;
  return Math.max(min, Math.min(max, 0.26 / span));
}
const SVGNS = 'http://www.w3.org/2000/svg';
/** Локатор страны: кольцо, расходящийся пульс и подпись в центре. Размер кольца почти не зависит от площади
 *  страны, поэтому Южную Корею видно так же, как Россию. */
function setMapLocator(cid, label) {
  const svg = mapSvg(); if (!svg) return false;
  const old = svg.querySelector('.mloc'); if (old) old.remove();
  MAP.loc = null;
  if (!cid) return true;
  const geo = countryGeom(cid); if (!geo) return false;
  const cx = geo.cx, cy = geo.cy;
  const r = Math.max(15, Math.min(40, Math.max(geo.w, geo.h) * 0.62));
  const g = document.createElementNS(SVGNS, 'g');
  g.setAttribute('class', 'mloc');
  g.style.transformOrigin = `${cx.toFixed(2)}px ${cy.toFixed(2)}px`;
  for (const cls of ['mloc-pulse', 'mloc-ring']) {
    const c = document.createElementNS(SVGNS, 'circle');
    c.setAttribute('class', cls); c.setAttribute('cx', cx.toFixed(2)); c.setAttribute('cy', cy.toFixed(2)); c.setAttribute('r', r.toFixed(2));
    g.appendChild(c);
  }
  if (label) {
    const t = document.createElementNS(SVGNS, 'text');
    t.setAttribute('class', 'mloc-label'); t.setAttribute('x', cx.toFixed(2)); t.setAttribute('y', (cy - r - 8).toFixed(2));
    t.textContent = label;
    g.appendChild(t);
  }
  svg.appendChild(g);
  MAP.loc = { g, cx, cy };
  return true;
}
/** Удержать кольцо и подпись одного экранного размера, пока камера наезжает. */
function locCounterScale(k, ms) {
  const L = MAP.loc; if (!L) return;
  L.g.style.transition = ms ? `transform ${ms}ms cubic-bezier(.33,.72,.25,1)` : 'none';
  L.g.style.transform = `scale(${(1 / k).toFixed(4)})`;
}
/** Заказать вступительный наезд на страну; сыграется, как только карта будет готова и вставлена в DOM. */
function requestMapIntro(cid) {
  if (!cid || MAP.introDone) return;
  MAP.intro = cid;
  runMapIntro();
}
function runMapIntro() {
  const cid = MAP.intro;
  if (!cid || MAP.introDone || MAP.state === 'idle' || MAP.state === 'loading') return;
  if (!MAP.host || !MAP.host.isConnected) return;
  MAP.introDone = true; MAP.intro = null;
  setMapGlow(cid);
  setMapLocator(cid, cname(cid));
  if (reduceMotion() || MAP.state === 'failed') return;
  const k = focusScale(cid, 2, 7);
  if (!mapFocus(cid, 1, 0)) return;
  locCounterScale(1, 0);
  requestAnimationFrame(() => {
    mapFocus(cid, k, 1500); locCounterScale(k, 1500);
    setTimeout(() => { mapUnfocus(1700); locCounterScale(1, 1700); }, 2700);
  });
}
function relColor(v) {
  const a = Math.pow(Math.min(1, Math.abs(v) / 5), 0.75);
  if (v < 0) return `rgba(255,30,30,${a.toFixed(3)})`;
  if (v > 0) return `rgba(6,110,40,${Math.min(1, a * 1.05).toFixed(3)})`;
  return 'transparent';
}
function gameMapMode() {
  const st = S.st, me = st.me.country, G = st.game;
  MAP.mode = (cid) => {
    const c = G.countries[cid];
    if (cid === me) return { fill: '#ffffff', stroke: '#ffffff', w: 1.6, title: cname(cid) + ' — это вы' };
    const rel = G.countries[me].rel[cid];
    const who = c.isPlayer ? `игрок ${c.owner}` : 'NPC';
    const rc = relColor(rel);
    return {
      fill: rc, stroke: c.isPlayer ? '#4da3ff' : '#8b98a9', dash: c.isPlayer ? '' : '3 2', w: c.isPlayer ? 1.6 : 1, text: Math.abs(rel) > 2.5 ? '#fff' : '#fff',
      title: `${cname(cid)} (${who})\nОтношение ${sgn(rel)} — ${statusLabel(rel)}${G.countries[me].allies.includes(cid) ? '\nСоюзник' : ''}`,
    };
  };
}
function draftMapMode() {
  const taken = new Set(S.st.draft.taken);
  const mine = S.st.draft.myPick;
  if ((S.st.draft.mode ?? 'random') === 'random') {
    const owner = {};
    for (const q of S.st.players) if (q.country) owner[q.country] = q.nick;
    MAP.mode = (cid) => {
      if (cid === mine) return { fill: '#f2cc60', stroke: '#fff3c4', w: 1.8, title: cname(cid) + ' — ваша страна' };
      if (cid === S.sel) return { fill: '#5b6b80', stroke: '#ffffff', w: 1.8, title: cname(cid) + (owner[cid] ? ` — ${owner[cid]}` : ' — без игрока') };
      if (owner[cid]) return { fill: '#2d5a8c', stroke: '#6aa7e0', w: 1.4, title: `${cname(cid)} — ${owner[cid]}` };
      return { fill: '#222a36', stroke: '#39445a', dash: '3 2', title: cname(cid) + ' — без игрока' };
    };
    return;
  }
  MAP.mode = (cid) => {
    if (cid === mine) return { fill: '#ffffff', stroke: '#fff', w: 1.6, title: cname(cid) + ' — ваша страна' };
    if (cid === S.sel) return { fill: '#ffffff', stroke: '#fff', w: 1.6, title: cname(cid) };
    if (taken.has(cid)) return { fill: '#2a1a22', stroke: '#4a2a35', title: cname(cid) + ' — занята' };
    return { fill: '#2d5a8c', stroke: '#6aa7e0', title: cname(cid) };
  };
}

// ------------------------------------------------------------------ рендер: общий каркас
function timerHtml(deadline) {
  return `<span class="timer" data-deadline="${deadline || ''}">--:--</span>`;
}
setInterval(() => {
  document.querySelectorAll('[data-deadline]').forEach((el) => {
    const d = Number(el.dataset.deadline); if (!d) return;
    const left = Math.max(0, Math.round((d - (Date.now() + S.skew)) / 1000));
    el.textContent = String(Math.floor(left / 60)).padStart(2, '0') + ':' + String(left % 60).padStart(2, '0');
    el.classList.toggle('low', left <= 60);
  });
}, 500);

function render() {
  const app = $('#app');
  const st0 = S.st;
  // кинематографичный финал: игровой экран остаётся на месте, переход играется поверх него
  if (FIN.playing) return;
  if (st0 && S.cfg && st0.room.phase === 'finished' && S.lastPhase === 'game' && !S.finAnim && !reduceMotion() && st0.game && st0.game.result) {
    S.finAnim = true; S.lastPhase = 'finished';
    playOutro(st0.game.result);
    return;
  }
  // сохранить прокрутку и фокус
  const scr = {}; document.querySelectorAll('[data-scroll]').forEach((e) => { scr[e.dataset.scroll] = e.scrollTop; });
  const winY = window.scrollY;
  const ae = document.activeElement;
  const focus = ae && ae.dataset && ae.dataset.p ? { p: ae.dataset.p, s: ae.selectionStart, e: ae.selectionEnd } : (ae && ae.id ? { id: ae.id, s: ae.selectionStart, e: ae.selectionEnd } : null);
  if (MAP.host && MAP.host.parentNode) MAP.host.parentNode.removeChild(MAP.host);

  const st = S.st;
  let html, finFirst = false;
  if (!S.room || !st) html = viewLogin();
  else if (st.room.phase === 'lobby') html = viewLobby();
  else if (st.room.phase === 'draft') html = viewDraft();
  else if (st.room.phase === 'game') html = viewGame();
  else { finFirst = !S.finAnim && !reduceMotion(); S.finAnim = true; html = viewFinished(finFirst); }
  app.classList.remove('outro-freeze');
  app.innerHTML = html;
  S.lastPhase = st ? st.room.phase : null;
  if (finFirst) confetti(); // ponytail: ровно один раз за партию

  if (st && S.cfg) {
    if (st.room.phase === 'draft') { draftMapMode(); requestMapIntro(st.draft.myPick); }
    if (st.room.phase === 'game') { gameMapMode(); if (MAP.glow) { setMapGlow(null); setMapLocator(null); mapUnfocus(600); } }
    if (st.room.phase === 'draft' || st.room.phase === 'game') attachMap();
  }
  document.querySelectorAll('[data-scroll]').forEach((e) => { if (scr[e.dataset.scroll] != null) e.scrollTop = scr[e.dataset.scroll]; });
  window.scrollTo(0, winY);
  if (focus) {
    const el = focus.p ? document.querySelector(`[data-p="${focus.p}"]`) : document.getElementById(focus.id);
    if (el) { el.focus(); try { if (focus.s != null) el.setSelectionRange(focus.s, focus.e); } catch (_) { /* number input */ } }
  }
  updateLive();
  drawTreeLinks();
}

// ------------------------------------------------------------------ экраны: вход / лобби
function viewLogin() {
  return `<div class="screen">
    <h1>Глобальный ИИ</h1><div class="sub">Многопользовательская стратегия 2026–2040</div>
    <label>Ник</label><input data-p="ui.nick" value="${esc(S.ui.nick)}" maxlength="20" placeholder="Например, Алиса" autofocus>
    <label>Код комнаты</label><input data-p="ui.roomcode" value="${esc(S.ui.roomcode)}" maxlength="5" placeholder="5 букв, например СЛОВО" style="text-transform:uppercase">
    <div class="btns"><button class="primary" data-act="join">Войти</button><button data-act="create">Создать комнату</button></div>
  </div>`;
}
function viewLobby() {
  const st = S.st;
  return `<div class="screen wide">
    <h2 class="center muted">Код комнаты (нажмите, чтобы скопировать)</h2>
    <div class="code" data-act="copycode">${esc(st.room.code)}</div>
    <p class="center muted">Передайте код игрокам. Когда все подключились, хост нажимает «Все здесь».</p>
    <ul class="players">${st.players.map((p) => `<li><span><span class="dot ${p.connected ? 'on' : ''}"></span>${esc(p.nick)}${p.nick === st.me.nick ? ' (вы)' : ''}</span><span class="muted">${p.isHost ? 'хост' : ''}</span></li>`).join('')}</ul>
    <div class="btns">${st.me.isHost ? `<button class="primary" data-act="start">Все здесь — начать драфт</button>` : `<div class="muted center grow">Ждём, пока хост начнёт драфт…</div>`}<button data-act="leave">Выйти</button></div>
  </div>`;
}

// ------------------------------------------------------------------ драфт
function viewDraft() {
  if ((S.st.draft.mode ?? 'random') === 'random') return viewDraftRandom();
  return viewDraftPick();
}
/** v0.3: страна выдана случайно — брифинг в три колонки (дипломатия · карта · страна) и кнопка «Готов». */
function viewDraftRandom() {
  const st = S.st, cfg = S.cfg, mine = st.draft.myPick;
  const p = mine ? cfg.profiles[mine] : null;
  const y0 = (cfg.timers && cfg.timers.startYear) || 2026, y1 = (cfg.timers && cfg.timers.endYear) || 2040;
  const readyN = st.players.filter((q) => q.ready).length;

  const head = `<div class="topbar bf-top">
    <span class="year">${y0}</span><span class="bf-phase">Брифинг перед стартом</span>${timerHtml(st.room.deadline)}
    <span class="grow">${st.players.map((q) => `<span class="chip ${q.ready ? 'done' : ''}" title="${q.ready ? 'готов' : 'читает брифинг'}">${q.ready ? '✔ ' : ''}${esc(q.nick)}${q.country ? ' — ' + esc(cname(q.country)) : ''}</span>`).join('')}</span>
    <button class="small" data-act="leave">Выйти</button></div>`;

  const map = `<section class="bf-map">
    <div class="bf-mapframe"><div id="mapslot"></div></div>
    <div class="bf-legend"><span><i class="sw gold"></i>вы</span><span><i class="sw blue"></i>другие игроки</span><span><i class="sw grey"></i>страны без игрока</span><span class="muted">нажмите страну, чтобы подсветить</span></div>
  </section>`;

  if (!p) return head + `<div class="brief">${map}<aside class="bf-right"><div class="panel"><p class="muted">Жребий бросается…</p></div></aside></div>`;

  const scales = SCALES.map(([k, n]) => `<div class="sc${k === p.best ? ' top' : ''}">
      <div class="sc-h"><span>${n}</span><b>${fx(p.scores[k])}</b></div>
      <div class="sc-bar"><i style="width:${Math.max(2, Math.min(100, p.scores[k]))}%"></i></div></div>`).join('');
  const rchips = (arr, cls) => (arr || []).map((n) => `<span class="rchip ${cls}">${esc(n)}</span>`).join('');

  const right = `<aside class="bf-right">
    <div class="bf-id">
      <div class="bf-name">${esc(cname(mine))}</div>
      <div class="bf-tag">Ваша страна до ${y1} года. Жребий уже брошен — менять нельзя.</div>
    </div>
    <div class="panel">
      <h3>Стартовые шкалы</h3>${scales}
      <p class="note">Выделена шкала, с которой вы начинаете сильнее всего.</p>
    </div>
    <div class="panel">
      <h3>Ресурсная база</h3>
      <div class="bf-res"><span class="k">Опора</span><span class="v">${rchips(p.strong, 'good')}</span></div>
      <div class="bf-res"><span class="k">Узкие места</span><span class="v">${rchips(p.weak, 'bad')}</span></div>
    </div>
    <div class="panel bf-go">
      ${st.me.ready
      ? `<div class="bf-waiting">Вы готовы. Ждём остальных.</div>`
      : `<button class="primary big" data-act="dready">Готов</button>`}
      <div class="bf-count"><span>Готовы ${readyN} из ${st.players.length}</span>${timerHtml(st.room.deadline)}</div>
      <p class="note">Когда истечёт время, партия начнётся без опоздавших.</p>
    </div>
  </aside>`;

  const owner = {};
  for (const q of st.players) if (q.country) owner[q.country] = q;
  const allies = new Set(p.allies || []), foes = new Set(p.enemies || []);
  const stance = (cid) => (allies.has(cname(cid)) ? ['Партнёр', 'good'] : foes.has(cname(cid)) ? ['Противник', 'bad'] : ['Нейтралитет', 'mid']);
  const dprow = (c) => {
    const [lab, cls] = stance(c.id), q = owner[c.id], me = c.id === mine;
    return `<button class="dprow${me ? ' me' : ''}${S.sel === c.id ? ' sel' : ''}" data-act="mapclick" data-cid="${c.id}">
      <span class="dp-c">${esc(c.name)}</span>
      <span class="dp-w">${me ? 'вы' : q ? esc(q.nick) : ''}</span>
      <span class="dp-s ${me ? 'self' : cls}">${me ? '—' : lab}</span></button>`;
  };
  const played = cfg.countries.filter((c) => owner[c.id]), npc = cfg.countries.filter((c) => !owner[c.id]);
  const left = `<aside class="bf-left">
    <div class="panel">
      <h3>Расклад на старте</h3>
      <div class="dp-group">За кого играют</div>
      ${played.map(dprow).join('')}
      <div class="dp-group">Без игрока</div>
      ${npc.map(dprow).join('')}
      <p class="note">Партнёры и противники — отношения, с которыми ваша страна входит в ${y0} год. Точные значения по лестнице отношений откроются на вкладке «Дипломатия» в первый же ход.</p>
    </div>
  </aside>`;

  return head + `<div class="brief">${map}${left}${right}</div>`;
}
function viewDraftPick() {
  const st = S.st, cfg = S.cfg, taken = new Set(st.draft.taken), mine = st.draft.myPick;
  const bar = (v, cls) => `<div class="bar ${cls || ''}"><i style="width:${Math.min(100, v)}%"></i></div>`;
  const tiles = cfg.countries.map((c) => {
    const p = cfg.profiles[c.id], t = taken.has(c.id);
    return `<div class="tile ${S.sel === c.id ? 'sel' : ''} ${t ? 'taken' : ''} ${mine === c.id ? 'mine' : ''}" data-act="seltile" data-cid="${c.id}">
      <h3>${esc(c.name)} ${mine === c.id ? '✔' : t ? '<span class="muted">· занята</span>' : ''}</h3>
      ${SCALES.map(([k, n], i) => `<div class="lbl"><span>${n}</span><span>${fx(p.scores[k])}</span></div>${bar(p.scores[k], ['', 'gold', 'green', ''][i])}`).join('')}
    </div>`;
  }).join('');
  const sel = S.sel && cfg.profiles[S.sel];
  const side = `<div class="sidepanel">
    <div class="row" style="justify-content:space-between"><h2>Драфт стран</h2>${timerHtml(st.room.deadline)}</div>
    <div id="mapslot"></div><div class="legend" style="display:none"></div>
    ${sel ? `<h3 style="margin-top:10px">${esc(cname(S.sel))}</h3><p>${esc(sel.desc)}</p>` : '<p class="muted">Выберите плитку — страна подсветится на карте.</p>'}
    ${mine ? `<div class="ok center">Вы выбрали: <b>${esc(cname(mine))}</b>. Ждём остальных игроков…</div>`
      : `<button class="primary big" data-act="pick" ${!S.sel || taken.has(S.sel) ? 'disabled' : ''}>Выбрать${S.sel ? ' — ' + esc(cname(S.sel)) : ''}</button>`}
    <p class="muted" style="font-size:12px">Игроков определились: ${st.players.filter((p) => p.ready).length} из ${st.players.length}. Не выбравший за 2 минуты получает случайную страну.</p>
  </div>`;
  return `<div class="draft"><div class="tiles">${tiles}</div>${side}</div>${mine ? '' : `<button class="dice" data-act="random" title="Случайная страна">🎲</button>`}`;
}

// ------------------------------------------------------------------ игра
function spendNow() {
  const p = S.plan || {}; let tr = 0, ai = 0, sc = 0, fp = 0;
  for (const k in p.transform || {}) tr += num(p.transform[k].v) + num(p.transform[k].p);
  for (const k in p.ai || {}) ai += num(p.ai[k]);
  for (const k in (S.st.me.plan && S.st.me.plan.science) || {}) sc += num(S.st.me.plan.science[k]); // наука — из очереди на сервере
  const f = p.fp || {};
  for (const k in f.improve || {}) fp += num(f.improve[k]);
  for (const k in f.attack || {}) { const a = f.attack[k]; fp += num(a.ares) + num(a.athena) + num(a.apollo); }
  const d = f.defense || {}; fp += num(d.ares) + num(d.athena) + num(d.apollo);
  fp += S.st.me.fpSpent || 0;
  return { transform: tr, ai, science: sc, fp };
}
function updateLive() {
  if (!S.st || S.st.room.phase !== 'game' || !S.st.me.points) return;
  const sp = spendNow(), pts = S.st.me.points;
  document.querySelectorAll('[data-live]').forEach((el) => {
    const k = el.dataset.live, rest = pts[k] - sp[k];
    el.innerHTML = `Очки: <b>${fx(pts[k])}</b> · распределено ${fx(sp[k])} · остаток <b class="${rest < -1e-6 ? 'bad' : 'ok'}">${fx(rest)}</b>`;
    el.classList.toggle('neg', rest < -1e-6);
  });
  document.querySelectorAll('[data-rest]').forEach((el) => {
    const k = el.dataset.rest, rest = pts[k] - sp[k];
    el.textContent = fx(rest); el.classList.toggle('neg', rest < -1e-6);
  });
}
const shown = (path) => { if (path in S.raw) return S.raw[path]; const v = getPath(S, path); return v == null || v === '' || v === 0 ? '' : String(v).replace('.', ','); };
const numInput = (path, attrs = '') => `<input type="text" inputmode="decimal" autocomplete="off" data-p="${path}" value="${esc(shown(path))}" ${attrs}>`;
const inp = (path) => numInput(path);
const lockAttr = () => (S.st.me.submitted ? 'disabled' : '');

function viewGame() {
  const st = S.st, me = st.me.country, G = st.game;
  const players = st.players;
  const waiting = players.filter((p) => !p.submitted).map((p) => p.nick);
  const top = `<div class="topbar">
    <span class="year">${G.year}</span> ${timerHtml(st.room.deadline)}
    <span><b>${esc(cname(me))}</b> <span class="muted">· ${esc(st.me.nick)} · комната ${esc(st.room.code)}</span></span>
    <span class="grow">${players.map((p) => `<span class="chip ${p.submitted ? 'done' : ''}" title="${p.submitted ? 'сдал ход' : 'думает'}">${p.submitted ? '✔ ' : ''}${esc(p.nick)} · ${esc(cname(p.country))}</span>`).join('')}</span>
    ${st.me.isHost ? `<button class="small" data-act="endturn" title="Разрешить ход немедленно">Завершить ход</button>` : ''}
    <button class="small" data-act="leave">Выйти</button></div>`;
  return top + `<div class="game ${S.ui.tab === 'science' ? 'treemode' : ''}">
    <div class="col boardcol">${viewBoard()}</div>
    <div class="col">${viewTabs()}${viewSwanSubmit(waiting)}</div>
    <div class="col">${viewRight()}</div></div>`;
}

// ---- центр: вкладки
const TABS = [['transform', 'Трансформация', () => viewTransform()], ['ai', 'Искусственный интеллект', () => viewAI()], ['science', 'Дерево технологий', () => viewScience()], ['fp', 'Дипломатия', () => viewFP()]];
function viewTabs() {
  const cur = TABS.find((t) => t[0] === S.ui.tab) || TABS[0];
  return `<div class="tabbar">${TABS.map(([k, n]) => `<button class="tab ${k === cur[0] ? 'act' : ''}" data-act="tab" data-tab="${k}">${n}<span class="tabpts" data-rest="${k}"></span></button>`).join('')}</div>${cur[2]()}`;
}

// ---- левая колонка: доска торгов
function describeItems(it) {
  const parts = [];
  for (const id in it.res) parts.push(`${esc(rname(id))} ×${fx(it.res[id])}`);
  for (const t of it.techs) parts.push(`⚙ ${t} ${esc((S.cfg.techs.find((x) => x.id === t) || {}).name || '')}`);
  return parts.length ? parts.join(', ') : '—';
}
function viewBoard() {
  const st = S.st, me = st.me.country, G = st.game, tf = S.ui.tf, cfg = S.cfg;
  const resOpts = (sel) => cfg.resources.map((r) => `<option value="${r.id}" ${sel === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
  const myTechs = G.countries[me].techs, notMine = cfg.techs.filter((t) => !myTechs.includes(t.id));
  const tags = (side) => Object.entries(tf[side].res).map(([id, a]) => `<span class="tag">${esc(rname(id))} ×${fx(a)}<button data-act="tfdel" data-side="${side}" data-id="${id}">×</button></span>`).join('')
    + tf[side].techs.map((t) => `<span class="tag">⚙ ${t}<button data-act="tfdelt" data-side="${side}" data-id="${t}">×</button></span>`).join('');
  const form = `<div>
    <div class="formgrp"><b class="ok">Отдаю</b><div>${tags('give') || '<span class="muted">—</span>'}</div>
      <div class="row"><select data-p="ui.tf.gr" style="max-width:150px">${resOpts(tf.gr)}</select>${numInput('ui.tf.ga')}<button class="small" data-act="tfadd" data-side="give">+ ресурс</button></div>
      <div class="row"><select data-p="ui.tf.gt" style="max-width:190px"><option value="">технология…</option>${cfg.techs.filter((t) => myTechs.includes(t.id)).map((t) => `<option value="${t.id}" ${tf.gt === t.id ? 'selected' : ''}>${t.id} ${esc(t.name)}</option>`).join('')}</select><button class="small" data-act="tfaddt" data-side="give">+</button></div></div>
    <div class="formgrp"><b class="warn">Хочу</b><div>${tags('want') || '<span class="muted">—</span>'}</div>
      <div class="row"><select data-p="ui.tf.wr" style="max-width:150px">${resOpts(tf.wr)}</select>${numInput('ui.tf.wa')}<button class="small" data-act="tfadd" data-side="want">+ ресурс</button></div>
      <div class="row"><select data-p="ui.tf.wt" style="max-width:190px"><option value="">технология…</option>${notMine.map((t) => `<option value="${t.id}" ${tf.wt === t.id ? 'selected' : ''}>${t.id} ${esc(t.name)}</option>`).join('')}</select><button class="small" data-act="tfaddt" data-side="want">+</button></div></div>
    <div class="row formgrp">Срок, лет: ${numInput('ui.tf.years', 'inputmode="numeric" style="width:55px"')}<button class="primary grow" data-act="tfpost">Разместить</button></div></div>`;
  const list = G.board.slice().reverse().map((l) => {
    const mine = l.owner === me;
    const act = l.status === 'open' ? (mine ? `<button class="small danger" data-act="tcancel" data-id="${l.id}">Снять</button>` : `<button class="small primary" data-act="taccept" data-id="${l.id}">Принять</button>`)
      : `<span class="muted">${l.status === 'done' ? 'исполнено: ' + esc(cname(l.acceptedBy)) : 'снято'}</span>`;
    const mineL = l.owner === me || l.acceptedBy === me;
    return `<div class="listing ${l.status !== 'open' ? 'done' : ''} ${mineL ? '' : 'other'}"><div class="row" style="justify-content:space-between"><b>№${l.id} · ${esc(cname(l.owner))}</b>${act}</div>
      <div class="g">Отдаёт: ${describeItems(l.give)}</div><div class="w">Хочет: ${describeItems(l.want)}</div><div class="muted">срок: ${l.years} г.</div></div>`;
  }).join('') || '<div class="muted">Объявлений нет</div>';
  const npcs = cfg.countries.filter((c) => !G.countries[c.id].isPlayer && G.countries[me].rel[c.id] >= cfg.diplomacy.npcExchange.minRelation);
  if (!npcs.some((c) => c.id === S.ui.npc.npc)) S.ui.npc.npc = npcs[0] ? npcs[0].id : '';
  const ex = `<div class="formgrp"><div>Отдаю ${cfg.diplomacy.npcExchange.rate} → получаю 1 (лимит ${fx(cfg.diplomacy.npcExchange.maxReceivePerNpcPerTurn)} получаемых на NPC за ход)</div>
    <div class="row"><select data-p="ui.npc.npc">${npcs.map((c) => `<option value="${c.id}" ${S.ui.npc.npc === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
    <div class="row">отдаю <select data-p="ui.npc.give" style="max-width:130px">${resOpts(S.ui.npc.give)}</select></div>
    <div class="row">получаю <select data-p="ui.npc.want" style="max-width:130px">${resOpts(S.ui.npc.want)}</select> ×${numInput('ui.npc.amount')}</div>
    <button class="grow" data-act="npcx" ${npcs.length ? '' : 'disabled'}>Обменять</button></div>`;
  return `<div class="card"><h2>Доска торгов</h2>${form}</div>
    <div class="card"><h2>Объявления</h2><div class="scroll" data-scroll="board" style="max-height:44vh">${list}</div></div>
    <div class="card"><h2>Обмен с NPC 2:1</h2>${ex}</div>`;
}

// ---- центр: трансформация
function viewTransform() {
  const st = S.st, me = st.me.country, C = st.game.countries[me], cfg = S.cfg, pv = st.me.preview.next, lock = lockAttr();
  let rows = '', grp = '';
  for (const r of cfg.resources) {
    if (r.group !== grp) { grp = r.group; rows += `<tr class="grp"><td colspan="7">${GROUPS[grp]}</td></tr>`; }
    const [B, Cg, real] = C.res[r.id], n = pv.res[r.id];
    const dB = n.B - B, dC = n.C - Cg;
    rows += `<tr><td>${esc(r.name)}</td><td class="n">${fx(real)}${Math.abs(real - B) > 0.005 ? `<span class="muted" title="база">/${fx(B)}</span>` : ''}</td><td class="n">${sgn(Cg)}</td>
      <td>${numInput(`plan.transform.${r.id}.v`, lock)}</td><td>${numInput(`plan.transform.${r.id}.p`, lock)}</td>
      <td class="n"><span class="${dB > 0.0005 ? 'up' : ''}">${fx(n.B)}</span></td><td class="n"><span class="${dC > 0.0005 ? 'up' : ''}">${sgn(n.C)}</span></td></tr>`;
  }
  return `<div class="card"><h2>Трансформация <span class="pts" data-live="transform"></span></h2>
    <div class="scroll" data-scroll="tr" style="max-height:420px"><table><thead><tr><th>Ресурс</th><th class="n">Значение</th><th class="n">Прирост</th><th>В значение</th><th>В прирост</th><th class="n">→ знач.</th><th class="n">→ прир.</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="muted" style="font-size:12px">«→» — прогноз базы на следующий год (без эффектов технологий и событий).</div></div>`;
}
function viewAI() {
  const st = S.st, me = st.me.country, C = st.game.countries[me], cfg = S.cfg, pv = st.me.preview.next, lock = lockAttr();
  const mod = (st.me.mods.ai_points_spheres || 0) + (st.me.mods.ai_points_total || 0);
  const rows = cfg.spheres.map((s) => {
    const [L, M, real] = C.sph[s.id], n = pv.sph[s.id];
    return `<tr><td>${esc(s.name)}</td><td class="n">${fx(real)}</td><td class="n">${sgn(M)}</td><td>${numInput(`plan.ai.${s.id}`, lock)}</td><td class="n">${fx(n.L)}</td><td class="n"><span class="${n.M - M > 0.0005 ? 'up' : ''}">${sgn(n.M)}</span></td></tr>`;
  }).join('');
  return `<div class="card"><h2>Искусственный интеллект <span class="pts" data-live="ai"></span></h2>
    <table><thead><tr><th>Сфера внедрения</th><th class="n">Значение</th><th class="n">Прирост</th><th>Вложение</th><th class="n">→ знач.</th><th class="n">→ прир.</th></tr></thead><tbody>${rows}</tbody></table>
    ${mod ? `<div class="muted">Модификатор эффективности очков ИИ: ${sgn(mod * 100)}%</div>` : ''}</div>`;
}
// ---- дерево технологий (как в Civ): колонки — уровни, строки — ветви, линии — требования
const LEVELS = ['I', 'II', 'III', 'IV', 'V', 'V+'];
const techById = (id) => S.cfg.techs.find((t) => t.id === id);
function viewScience() {
  const st = S.st, cfg = S.cfg, info = st.me.techInfo, q = st.me.techQueue || [], alloc = st.me.plan.science || {}, locked = !!st.me.submitted;
  const branches = [...new Set(cfg.techs.map((t) => t.branch))];
  const card = (t) => {
    const i = info[t.id], pos = q.indexOf(t.id);
    const status = i.done ? 'done' : i.progress > 0 && i.available ? 'progress' : i.available ? 'open' : 'locked';
    const label = { done: 'изучено', progress: 'в процессе', open: 'доступно', locked: 'закрыто' }[status];
    const pct = Math.min(100, i.progress / i.price * 100), add = alloc[t.id] || 0;
    const addPct = Math.min(100 - pct, add * i.mult / i.price * 100);
    return `<div class="tnode ${status} ${pos >= 0 ? 'queued' : ''}" id="tn-${t.id}" data-act="${i.done || locked ? '' : 'tq'}" data-id="${t.id}"
      title="${esc(t.essence || '')}&#10;Эффект: ${esc(t.effectText)}${t.prereqs.length ? '&#10;Требует: ' + t.prereqs.join(', ') : ''}">
      ${pos >= 0 ? `<span class="prio">${pos + 1}</span>` : ''}
      <div class="tn-h"><b>${t.id}</b><span class="badge ${status}">${label}</span></div>
      <div class="tn-name">${esc(t.name)}</div>
      <div class="tn-eff">${esc(t.effectText)}</div>
      ${i.done ? '' : `<div class="bar gold tbar"><i style="width:${pct}%"></i><i class="add" style="left:${pct}%;width:${addPct}%"></i></div>
      <div class="lbl"><span>${fx(i.progress)} / ${fx(i.price)}${i.others ? ` <span class="up" title="диффузия: уже изучили ${i.others} стр.">−${i.others * 10}%</span>` : ''}</span><span class="${add ? 'up' : 'muted'}">${add ? '+' + fx(add) : ''}${i.mult !== 1 ? ' ×' + fx(i.mult) : ''}</span></div>`}
    </div>`;
  };
  const rows = branches.map((b) => `<div class="tb-name">${esc(b)}</div>` + LEVELS.map((lv) => {
    const ts = cfg.techs.filter((t) => t.branch === b && t.level === lv);
    return `<div class="tcell">${ts.map(card).join('')}</div>`;
  }).join('')).join('');
  const spent = Object.values(alloc).reduce((a, b) => a + b, 0), pts = st.me.points.science;
  const queue = q.length ? q.map((id, k) => {
    const t = techById(id), a = alloc[id] || 0, i = info[id];
    return `<div class="qitem ${a ? '' : 'idle'}"><span class="prio">${k + 1}</span><span class="grow">${id} · ${esc(t.name)}</span>
      <span class="${a ? 'up' : 'muted'}">${a ? '+' + fx(a) : i.available ? '0,00' : 'ждёт требований'}</span>
      <button class="small" data-act="tqmove" data-id="${id}" data-d="-1" ${k === 0 || locked ? 'disabled' : ''}>▲</button><button class="small" data-act="tqmove" data-id="${id}" data-d="1" ${k === q.length - 1 || locked ? 'disabled' : ''}>▼</button><button class="small danger" data-act="tq" data-id="${id}" ${locked ? 'disabled' : ''}>✕</button></div>`;
  }).join('') : '<div class="muted">Очередь пуста. Нажмите на технологию в дереве — она и её недостающие требования встанут в очередь.</div>';
  return `<div class="card"><h2>Дерево технологий <span class="pts">Очки науки: <b>${fx(pts)}</b> · в очереди ${fx(spent)} · остаток <b class="${pts - spent > 0.004 && q.length ? 'warn' : 'ok'}">${fx(pts - spent)}</b></span></h2>
    <div class="tqueue"><div class="row" style="justify-content:space-between"><b>Очередь исследований</b>${q.length && !locked ? '<button class="small" data-act="tqclear">Очистить</button>' : ''}</div>
      <div class="muted" style="font-size:12px;margin:2px 0 6px">Все очки идут в приоритет 1 до его полной стоимости, остаток — в приоритет 2, и так далее. Закрытые технологии ждут своих требований; очередь сохраняется между годами.</div>${queue}</div>
    <div class="ttree-wrap" data-scroll="tree"><div class="ttree" id="ttree">
      <div class="tb-name"></div>${LEVELS.map((l) => `<div class="tlevel">Уровень ${l}</div>`).join('')}${rows}
      <svg class="tlinks" id="tlinks"></svg></div></div></div>`;
}
function drawTreeLinks() {
  const tree = $('#ttree'), svg = $('#tlinks'); if (!tree || !svg) return;
  const base = tree.getBoundingClientRect(), done = new Set(S.st.game.countries[S.st.me.country].techs), q = new Set(S.st.me.techQueue || []);
  svg.setAttribute('width', tree.scrollWidth); svg.setAttribute('height', tree.scrollHeight);
  let html = '';
  for (const t of S.cfg.techs) for (const pr of t.prereqs) {
    const a = $('#tn-' + pr), b = $('#tn-' + t.id); if (!a || !b) continue;
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    const x1 = ra.right - base.left, y1 = ra.top + ra.height / 2 - base.top, x2 = rb.left - base.left, y2 = rb.top + rb.height / 2 - base.top;
    const dx = Math.max(24, (x2 - x1) / 2);
    const cls = done.has(pr) && done.has(t.id) ? 'done' : q.has(t.id) ? 'queued' : done.has(pr) ? 'open' : '';
    html += `<path class="${cls}" d="M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}"/>`;
  }
  svg.innerHTML = html;
}
window.addEventListener('resize', () => drawTreeLinks());
/** Клик по технологии: добавить её с недостающими требованиями в очередь или убрать вместе с зависимыми. */
function toggleQueue(id) {
  const me = S.st.me.country, done = new Set(S.st.game.countries[me].techs);
  let q = [...(S.st.me.techQueue || [])];
  if (q.includes(id)) {
    const drop = new Set([id]); let grew = true;
    while (grew) { grew = false; for (const x of q) if (!drop.has(x) && techById(x).prereqs.some((p) => drop.has(p))) { drop.add(x); grew = true; } }
    q = q.filter((x) => !drop.has(x));
  } else {
    const add = (tid) => { if (done.has(tid) || q.includes(tid)) return; techById(tid).prereqs.forEach(add); q.push(tid); };
    add(id);
  }
  return q;
}

// ---- внешняя политика
function viewFP() {
  const st = S.st, me = st.me.country, G = st.game, cfg = S.cfg, C = G.countries[me], pv = st.me.preview, lock = lockAttr();
  const plan = S.plan, f = plan.fp;
  const pend = (to, type) => G.proposals.some((p) => p.status === 'pending' && p.from === me && p.to === to && p.type === type);
  const allowNpcWar = !!(cfg.war && cfg.war.allowNpcTargets); // v0.3: война только с игроками
  const rows = cfg.countries.filter((c) => c.id !== me).map((c) => {
    const o = G.countries[c.id], rel = C.rel[c.id], ally = C.allies.includes(c.id);
    let act;
    if (o.isPlayer) {
      act = `<button class="small" data-act="propose" data-to="${c.id}" data-type="improve" ${lock} ${pend(c.id, 'improve') ? 'disabled' : ''}>Предложить +1 (${cfg.diplomacy.improveCost})</button>
        ${ally ? '' : `<button class="small" data-act="propose" data-to="${c.id}" data-type="alliance" ${lock} ${pend(c.id, 'alliance') ? 'disabled' : ''}>Союз</button>`}`;
    } else {
      const ch = pv.chances[c.id];
      act = `<div class="row">вложить ${numInput(`plan.fp.improve.${c.id}`, lock)}</div>
        <div style="font-size:11px" title="шанс улучшения / без изменений / ухудшения"><span class="up">↑${fx(ch.R * 100)}%</span> · =${fx(ch.S * 100)}% · <span class="down">↓${fx(ch.T * 100)}%</span></div>`;
    }
    const dg = f.downgrade.includes(c.id), br = f.breakAlliance.includes(c.id);
    return `<tr><td><b>${esc(c.name)}</b><br><span class="muted" style="font-size:11px">${o.isPlayer ? 'игрок ' + esc(o.owner) : 'NPC'}</span></td>
      <td class="n" style="white-space:nowrap">${sgn(rel)}<br><span class="muted" style="font-size:11px">${esc(statusLabel(rel))}</span></td>
      <td>${ally ? '<span class="ok">союз</span>' : '<span class="muted">—</span>'}</td>
      <td>${act}<div class="row" style="margin-top:3px"><button class="small ${dg ? 'on' : ''}" data-act="toggle" data-list="downgrade" data-id="${c.id}" ${lock}>Понизить</button>${ally ? `<button class="small ${br ? 'on' : ''}" data-act="toggle" data-list="breakAlliance" data-id="${c.id}" ${lock}>Разорвать союз</button>` : ''}</div></td>
      <td>${o.isPlayer || allowNpcWar
        ? ['ares', 'athena', 'apollo'].map((k, i) => numInput(`plan.fp.attack.${c.id}.${k}`, `${lock} placeholder="${['Арес', 'Афина', 'Аполл.'][i]}" style="width:78px"`)).join('<br>')
        : '<span class="muted" title="Войны против NPC запрещены">—</span>'}</td></tr>`;
  }).join('');
  const defense = ['ares', 'athena', 'apollo'].map((k, i) => `${['Арес', 'Афина', 'Аполлон'][i]} ${numInput(`plan.fp.defense.${k}`, lock)}`).join(' &nbsp; ');
  return `<div class="card"><h2>Дипломатия и внешняя политика <span class="pts" data-live="fp"></span></h2>
    <div class="scroll" data-scroll="fp" style="max-height:520px"><table><thead><tr><th>Страна</th><th class="n">Отношение</th><th>Союз</th><th>Дипломатия</th><th>Атака: Арес / Афина / Аполлон</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="formgrp"><b>Оборона</b> (против каждой атаки на вас): ${defense}</div>
    <div class="muted" style="font-size:12px">Предложения игрокам списывают ${cfg.diplomacy.improveCost} очков ВП сразу (потрачено на них: ${fx(st.me.fpSpent)}). Атака снижает отношения на 1 и разрывает союз.${allowNpcWar ? '' : ' Воевать можно только со странами-игроками: по NPC атака недоступна, с ними доступны лишь вложения в отношения.'}</div></div>`;
}

// ---- лебедь и сдача хода
function viewSwanSubmit(waiting) {
  const st = S.st, sw = st.me.swan, cfg = S.cfg;
  let swan;
  if (!sw.released) swan = `<button class="big" data-act="swan" ${lockAttr()}>🦢 Выпустить чёрного лебедя</button><div class="muted" style="font-size:12px">Один раз за ход. Все страны увидят уведомление, эффект раскроется при разрешении хода.</div>`;
  else if (sw.options) {
    swan = `<div class="gold">Карты прорывов/рисков (X4): выберите один из двух бросков D60</div>` + sw.options.map((id, i) => {
      const s = cfg.swans.find((x) => x.id === id);
      return `<div class="swanopt ${sw.choice === i || (sw.choice == null && i === 0) ? 'sel' : ''}"><div class="row"><b>№${s.id} ${s.sign === '+' ? '▲' : '▼'} ${esc(s.title)}</b><button class="small" data-act="swanpick" data-i="${i}">Выбрать</button></div><div class="muted" style="font-size:12px">${esc(s.text)}</div></div>`;
    }).join('');
  } else swan = `<div class="gold">🦢 Чёрный лебедь выпущен. Эффект станет известен при разрешении хода.</div>`;
  const errs = st.me.preview.errors;
  const submit = st.me.submitted ? `<button class="big" disabled>Ход сдан. Ждём: ${esc(waiting.join(', ')) || '—'}</button>` : `<button class="primary big" data-act="submit">Сдать ход ${S.st.game.year}</button>`;
  return `<div class="card swanbox"><h2>Чёрный лебедь</h2>${swan}</div>
    <div class="card">${errs.length ? `<div class="err">${errs.map(esc).join('<br>')}</div>` : ''}${submit}<div class="muted center" style="margin-top:6px">Неиспользованные очки сгорают.</div></div>`;
}

// ---- правая колонка: карта, рейтинг, лог
function viewRight() {
  const st = S.st, G = st.game, cfg = S.cfg, me = st.me.country;
  const pl = st.players.map((p) => ({ p, c: G.countries[p.country] }));
  const rank = `<table><thead><tr><th>Игрок</th>${SCALES.map(([, n], i) => `<th class="n" title="${n}">${['ИИ', 'Нау', 'ВП', 'Тр'][i]}</th>`).join('')}</tr></thead><tbody>${pl.map(({ p, c }) =>
    `<tr class="${p.country === me ? '' : 'other'}"><td>${p.country === me ? '<b>' : ''}${esc(p.nick)} <span class="muted">${esc(cname(p.country))}</span>${p.country === me ? '</b>' : ''}</td>${SCALES.map(([k]) => `<td class="n">${fx(c.scores[k])}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const mine = G.countries[me].scores;
  const log = G.log.slice().reverse().map((l) => {
    let body = esc(l.text).replace(/\n/g, '<br>');
    let mineLog = l.kind === 'system' || l.text.includes(cname(me));
    if (l.kind === 'proposal') {
      const p = G.proposals.find((x) => x.id === l.pid);
      if (p) {
        mineLog = p.from === me || p.to === me;
        const label = { pending: 'На рассмотрении', accepted: 'Принято', rejected: 'Отклонено' }[p.status];
        body += `<br><b class="st-${p.status}">${label}</b>${p.note ? ` <span class="muted">(${esc(p.note)})</span>` : ''}`;
        if (p.status === 'pending' && p.to === me) body += `<div class="row" style="margin-top:4px"><button class="small primary" data-act="respond" data-pid="${p.id}" data-yes="1">Принять</button><button class="small danger" data-act="respond" data-pid="${p.id}" data-yes="0">Отклонить</button></div>`;
      }
    }
    return `<div class="logitem ${l.kind} ${mineLog ? '' : 'other'}"><span class="y">${l.year}</span> ${body}</div>`;
  }).join('');
  return `<div class="card"><h2>Карта мира</h2><div id="mapslot"></div><div class="legend"></div>
      <div class="lbl"><span>−5 враждебно</span><span>0</span><span>+5 интеграция</span></div>
      <div class="muted" style="font-size:12px">Белая — вы · синяя рамка — игрок · пунктир — NPC · цвет по вашим отношениям</div></div>
    <div class="card"><h2>Рейтинг</h2>${rank}</div>
    <div class="card"><h2>Мировые события</h2><div class="log" data-scroll="log">${log || '<span class="muted">Пока тихо</span>'}</div></div>`;
}

// ------------------------------------------------------------------ итоги
const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
// ponytail: конфетти без физики и без библиотеки — прямоугольники, гравитация, самоудаление
function confetti() {
  const old = document.getElementById('confetti'); if (old) old.remove();
  const cv = document.createElement('canvas');
  cv.id = 'confetti';
  cv.width = window.innerWidth; cv.height = window.innerHeight;
  document.body.appendChild(cv);
  const ctx = cv.getContext('2d');
  const COL = ['#f2cc60', '#4da3ff', '#2ea043', '#f85149', '#ffffff'];
  const P = [];
  for (let i = 0; i < 110; i++) {
    P.push({
      x: Math.random() * cv.width, y: -20 - Math.random() * cv.height * 0.6,
      vx: (Math.random() - 0.5) * 1.6, vy: 1.5 + Math.random() * 2.5,
      w: 4 + Math.random() * 5, h: 7 + Math.random() * 7,
      a: Math.random() * Math.PI, va: (Math.random() - 0.5) * 0.25,
      c: COL[(Math.random() * COL.length) | 0],
    });
  }
  const t0 = performance.now();
  (function frame(t) {
    const age = t - t0;
    if (age > 3800 || !document.getElementById('confetti')) { cv.remove(); return; }
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.globalAlpha = age > 2800 ? Math.max(0, (3800 - age) / 1000) : 1;
    for (const p of P) {
      p.vy += 0.045; p.x += p.vx; p.y += p.vy; p.a += p.va;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a);
      ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    requestAnimationFrame(frame);
  })(t0);
}
// ---- кинематографичный переход «планшет управления → лидерборд»
const FIN = { playing: false, timers: [], onKey: null };
const finAt = (ms, fn) => FIN.timers.push(setTimeout(fn, ms));
function stopOutro() {
  FIN.timers.forEach(clearTimeout); FIN.timers = [];
  FIN.playing = false;
  if (FIN.onKey) { document.removeEventListener('keydown', FIN.onKey); FIN.onKey = null; }
  const o = document.getElementById('outro'); if (o) o.remove();
  const app = $('#app'); if (app) app.classList.remove('outro-freeze');
  setMapGlow(null); setMapLocator(null); mapUnfocus(0);
  const svg = mapSvg(); if (svg) svg.style.transition = '';
}
/** Режим карты на время финала: мир гаснет, страна-победитель горит золотом. */
function finaleMapMode(winner) {
  MAP.mode = (cid) => (cid === winner
    ? { fill: '#f2cc60', stroke: '#fff3c4', w: 2, title: cname(cid) }
    : { fill: '#10151d', stroke: '#1d2534', w: 1, title: cname(cid) });
}
function playOutro(r) {
  const win = r.winner, nick = (S.st.players.find((p) => p.country === win) || {}).nick || '';
  const app = $('#app');
  FIN.playing = true;

  // 1. планшет управления замирает и опадает панель за панелью
  app.classList.add('outro-freeze');
  const panels = [...app.querySelectorAll('.topbar, .tabbar, .game .card')];
  panels.sort((a, b) => { const x = a.getBoundingClientRect(), y = b.getBoundingClientRect(); return x.left - y.left || x.top - y.top; });
  panels.forEach((el, i) => {
    el.style.animationDelay = (0.05 + i * 0.06).toFixed(2) + 's';
    el.style.setProperty('--rot', ((i % 2 ? 1 : -1) * (0.8 + Math.random())).toFixed(2) + 'deg');
    el.classList.add('outro-fall');
  });

  // 2. сцена поверх уходящего экрана
  const o = document.createElement('div');
  o.id = 'outro'; o.className = 'outro';
  o.innerHTML = `<div class="outro-bg"></div><div class="outro-flash"></div><div class="outro-wave"></div>
    <div class="outro-stage"><div class="outro-mapslot"></div></div>
    <div class="outro-title">
      <div class="ot-kicker">Партия окончена</div>
      <div class="ot-country">${esc(cname(win))}</div>
      <div class="ot-nick">${esc(nick)}</div>
      <div class="ot-type">${esc(r.typeName)}</div>
    </div>
    <button class="outro-skip" data-act="skipoutro">Пропустить</button>`;
  document.body.appendChild(o);

  // пропуск: клик по сцене, Esc, пробел
  o.addEventListener('click', skipOutro);
  FIN.onKey = (e) => { if (e.key === 'Escape' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); skipOutro(); } };
  document.addEventListener('keydown', FIN.onKey);

  // 3. карта выходит на передний план — тот же рендерер, другой режим
  const slot = o.querySelector('.outro-mapslot');
  const haveMap = !!(MAP.host && MAP.state !== 'idle' && MAP.state !== 'loading');
  if (haveMap) {
    finaleMapMode(win);
    slot.appendChild(MAP.host);
    updateMap();
    mapUnfocus(0);
    finAt(1250, () => { setMapGlow(win); mapFocus(win, 2.2, 1900); });
  } else {
    o.classList.add('nomap'); // CDN недоступен и чипы не построены — деградируем до объявления победителя
  }

  // 4. объявление победителя и конфетти ровно в этот момент
  finAt(2700, () => { o.classList.add('shout'); confetti(); });
  // 5. мир растворяется, из него собирается лидерборд
  finAt(4300, () => o.classList.add('outro-exit'));
  finAt(5000, () => { stopOutro(); renderFinished(); });
}
function skipOutro() {
  if (!FIN.playing) return;
  stopOutro();
  renderFinished(true);
}
function renderFinished(skipped) {
  const app = $('#app');
  app.classList.remove('outro-freeze');
  app.innerHTML = viewFinished(!skipped);
  S.lastPhase = 'finished';
  if (MAP.host && MAP.host.parentNode) MAP.host.parentNode.removeChild(MAP.host);
}

function viewFinished(anim) {
  const st = S.st, r = st.game.result, cfg = S.cfg;
  const nick = (cid) => (st.players.find((p) => p.country === cid) || {}).nick || '';
  const t0 = r.table[0], rest = r.table.slice(1);
  const scale = Math.max(1, ...r.table.map((t) => Math.abs(t.delta)));
  const dly = (s) => (anim ? ` style="animation-delay:${s.toFixed(2)}s"` : '');
  const cls = (base, add) => `class="${base}${anim ? ' ' + add : ''}"`;

  const mini = (t) => SCALES.map(([k, n]) => `<div class="ch-sc"><span>${n}</span><b>${fx(t.final[k])}</b>
      <div class="ch-bar"><i style="width:${Math.max(2, Math.min(100, t.final[k]))}%"></i></div></div>`).join('');

  const champ = t0 ? `<section ${cls('champ', 'fin-rise')}${dly(0.05)}>
    <div class="ch-rank">1</div>
    <div class="ch-id">
      <div class="ch-country">${esc(cname(t0.cid))}</div>
      <div class="ch-nick">${esc(nick(t0.cid))}</div>
      <div class="ch-type">Победа ${esc(r.typeName)}</div>
    </div>
    <div class="ch-delta"><b class="${t0.delta >= 0 ? 'up' : 'down'}">${sgn(t0.delta)}</b><span>прирост очков за партию</span>
      <div class="ch-sum">${fx(t0.startSum)} → ${fx(t0.finalSum)}</div>
      <div class="ch-tech">${t0.techs} из ${cfg.techs.length} технологий</div></div>
    <div class="ch-scales">${mini(t0)}</div>
  </section>` : '';

  const rows = rest.map((t, i) => `<li ${cls('rankrow', 'fin-rise')}${dly(0.35 + i * 0.12)}>
    <span class="rk">${i + 2}</span>
    <span class="rr-id"><b>${esc(cname(t.cid))}</b><span class="muted">${esc(nick(t.cid))}</span></span>
    <span class="rr-bar"><i class="${t.delta >= 0 ? '' : 'neg'}" style="width:${Math.round((Math.abs(t.delta) / scale) * 100)}%"></i></span>
    <span class="rr-delta ${t.delta >= 0 ? 'up' : 'down'}">${sgn(t.delta)}</span>
    <span class="rr-meta">${fx(t.startSum)} → ${fx(t.finalSum)}<br>${t.techs}/${cfg.techs.length} технологий</span></li>`).join('');

  const tail = 0.35 + rest.length * 0.12 + 0.1;
  return `<div class="fin${anim ? ' finwrap' : ''}">
    <header ${cls('fin-head', 'fin-rise')}>
      <h1>Итоги партии</h1>
      <span class="fin-years">${(cfg.timers && cfg.timers.startYear) || 2026}—${(cfg.timers && cfg.timers.endYear) || 2040}</span>
    </header>
    ${champ}
    <ol class="ranks">${rows}</ol>
    <div ${cls('fin-foot', 'fin-rise')}${dly(tail)}>
      <span class="muted">Прирост очков — сумма четырёх шкал на финише минус на старте.</span>
      <button class="primary" data-act="leave">В начало</button></div>
  </div>`;
}

// ------------------------------------------------------------------ обработчики
function onInputEvent(e) {
  const el = e.target;
  if (!el.dataset || !el.dataset.p) return;
  const p = el.dataset.p;
  if (el.inputMode === 'decimal' || el.inputMode === 'numeric') {
    const clean = el.value.replace(/[^0-9.,]/g, '');
    if (clean !== el.value) { const c = el.selectionStart - (el.value.length - clean.length); el.value = clean; el.setSelectionRange(c, c); }
    S.raw[p] = clean;
    setPath(S, p, p.startsWith('plan.') ? num(clean) : clean);
  } else setPath(S, p, el.type === 'checkbox' ? el.checked : el.value);
  if (el.dataset.p.startsWith('plan.')) { schedSave(); updateLive(); }
}
document.addEventListener('input', onInputEvent);
document.addEventListener('change', onInputEvent);

const ACT = {
  join: run(async () => {
    const d = await fetch('/api/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nick: S.ui.nick, room: S.ui.roomcode }) });
    const j = await d.json(); if (!d.ok) throw new Error(j.error);
    await enter(j.room, j.token);
  }),
  create: run(async () => {
    const d = await fetch('/api/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nick: S.ui.nick }) });
    const j = await d.json(); if (!d.ok) throw new Error(j.error);
    await enter(j.room, j.token);
  }),
  leave: () => leave(),
  copycode: () => { navigator.clipboard && navigator.clipboard.writeText(S.room).then(() => toast('Код скопирован', true)).catch(() => {}); },
  start: run(async () => { await api('start'); await refresh(); }),
  seltile: (el) => { S.sel = el.dataset.cid; render(); },
  mapclick: (el) => {
    const st = S.st; if (!st || st.room.phase !== 'draft') return;
    // в режиме «страна выдана» клик — только подсветка, выбор уже сделан за игрока
    if ((st.draft.mode ?? 'random') === 'random' || !st.draft.myPick) { S.sel = S.sel === el.dataset.cid ? null : el.dataset.cid; render(); }
  },
  skipoutro: () => skipOutro(),
  pick: run(async () => { await api('draftPick', { country: S.sel }); await refresh(); }),
  dready: run(async () => { await api('draftReady'); await refresh(); }),
  random: run(async () => { await api('draftPick', { random: true }); await refresh(); }),
  submit: run(async () => { await flushSave(); applyState(await api('submit', { plan: S.plan })); }),
  endturn: run(async () => { if (confirm('Завершить ход для всех немедленно?')) { await flushSave(); applyState(await api('endturn')); } }),
  propose: run(async (el) => { applyState(await api('propose', { to: el.dataset.to, type: el.dataset.type })); toast('Предложение отправлено', true); }),
  respond: run(async (el) => { applyState(await api('respond', { pid: el.dataset.pid, accept: el.dataset.yes === '1' })); }),
  toggle: (el) => {
    const arr = S.plan.fp[el.dataset.list], i = arr.indexOf(el.dataset.id);
    if (i >= 0) arr.splice(i, 1); else arr.push(el.dataset.id);
    schedSave(); render();
  },
  swan: run(async () => { if (confirm('Выпустить чёрного лебедя? Все страны увидят уведомление.')) applyState(await api('swan')); }),
  swanpick: run(async (el) => { applyState(await api('swanPick', { index: Number(el.dataset.i) })); }),
  tab: (el) => { S.ui.tab = el.dataset.tab; render(); },
  tq: run(async (el) => { applyState(await api('techQueue', { queue: toggleQueue(el.dataset.id) })); }),
  tqmove: run(async (el) => {
    const q = [...S.st.me.techQueue], i = q.indexOf(el.dataset.id), j = i + Number(el.dataset.d);
    [q[i], q[j]] = [q[j], q[i]];
    applyState(await api('techQueue', { queue: q }));
  }),
  tqclear: run(async () => { applyState(await api('techQueue', { queue: [] })); }),
  tfadd: (el) => {
    const side = el.dataset.side, tf = S.ui.tf, rid = tf[side[0] + 'r'], amt = num(tf[side[0] + 'a']);
    if (!amt) return toast('Укажите количество');
    tf[side].res[rid] = amt; render();
  },
  tfaddt: (el) => { const side = el.dataset.side, tf = S.ui.tf, t = tf[side[0] + 't']; if (t && !tf[side].techs.includes(t)) tf[side].techs.push(t); render(); },
  tfdel: (el) => { delete S.ui.tf[el.dataset.side].res[el.dataset.id]; render(); },
  tfdelt: (el) => { const a = S.ui.tf[el.dataset.side].techs; a.splice(a.indexOf(el.dataset.id), 1); render(); },
  tfpost: run(async () => {
    const tf = S.ui.tf;
    applyState(await api('tradePost', { give: tf.give, want: tf.want, years: Math.max(1, Math.round(num(tf.years))) || 1 }));
    tf.give = { res: {}, techs: [] }; tf.want = { res: {}, techs: [] }; render(); toast('Объявление размещено', true);
  }),
  taccept: run(async (el) => { applyState(await api('tradeAccept', { id: el.dataset.id })); toast('Сделка заключена', true); }),
  tcancel: run(async (el) => { applyState(await api('tradeCancel', { id: el.dataset.id })); }),
  npcx: run(async () => { const n = S.ui.npc; applyState(await api('tradeNpc', { npc: n.npc, give: n.give, want: n.want, amount: num(n.amount) })); toast('Обмен выполнен', true); }),
};
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const f = ACT[el.dataset.act]; if (f) f(el, e);
});

// ------------------------------------------------------------------ старт
(async function boot() {
  // у игры нет service worker; чужие (от прошлых проектов на этом порту) снимаем
  try {
    const regs = navigator.serviceWorker ? await navigator.serviceWorker.getRegistrations() : [];
    if (regs.length) {
      await Promise.all(regs.map((r) => r.unregister()));
      if (window.caches) for (const k of await caches.keys()) await caches.delete(k);
      if (!sessionStorage.getItem('swCleaned')) { sessionStorage.setItem('swCleaned', '1'); location.reload(); return; }
    }
  } catch (_) { /* нет доступа к SW — не мешаем загрузке */ }
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (s && s.room && s.token) { S.ui.nick = s.nick || ''; S.ui.roomcode = s.room; await enter(s.room, s.token); return; }
  } catch (_) { /* пусто */ }
  render();
})();
