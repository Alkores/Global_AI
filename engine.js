'use strict';
/**
 * engine.js — движок игры «Глобальный ИИ». Чистые функции, без ввода-вывода.
 * Правила: ПРАВИЛА_v0.2.md. Все числа берутся из config (default_config.json / админка).
 * Состояние игры G — обычный JSON-объект (сериализуется в rooms.json).
 */

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = r2; // всё хранится и считается до сотых
const f2 = (x) => r2(x).toFixed(2).replace('.', ',');
const num = (x) => (typeof x === 'number' && isFinite(x) ? x : 0);

// ---------------------------------------------------------------- ГСЧ
function makeRng(next) { // next(): число [0,1)
  const rng = {
    float: () => next(),
    int: (a, b) => a + Math.floor(next() * (b - a + 1)), // включительно
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    shuffle: (arr) => {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
      return a;
    },
  };
  return rng;
}
function seededRng(seed) { // mulberry32 — для тестов
  let a = seed >>> 0;
  return makeRng(() => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  });
}

// ---------------------------------------------------------------- компиляция формул
function compile(cfg) {
  const errors = [];
  const fx = { score: {}, growth: {}, dip: {} };
  const SP = ['res', 'sph', 'rel', 'pow', 'ln', 'min', 'max', 'ces', 'geo', 'sign', 'abs', 'exp'];
  const mk = (params, body, label, stmt) => {
    try { return new Function(...params, stmt ? body : 'return (' + body + ');'); }
    catch (e) { errors.push(`${label}: ${e.message}`); return null; }
  };
  const F = cfg.formulas || {};
  for (const k of ['ai', 'science']) {
    const f = F[k];
    if (!f || typeof f.x !== 'string') { errors.push(`formulas.${k}.x отсутствует`); continue; }
    fx.score[k] = { fn: mk(SP, f.x, `formulas.${k}.x`, true), n: num(f.n) || 1, k: num(f.k) || 0.55, normalize: f.normalize !== false };
  }
  for (const k of ['fp', 'transform']) {
    if (typeof F[k] !== 'string') { errors.push(`formulas.${k} отсутствует`); continue; }
    fx.score[k] = { fn: mk(SP, F[k], `formulas.${k}`, true), raw: true };
  }
  const GP = ['B', 'C', 'L', 'M', 'I', 'S', 'b', 'c', 'h', 'vp', 'dPZ', 'dPP', 'kI', 'kAI', 'pow', 'ln', 'min', 'max', 'abs'];
  for (const k of ['resB', 'resC', 'sphL', 'sphM']) {
    const s = F.growth && F.growth[k];
    if (typeof s !== 'string') { errors.push(`formulas.growth.${k} отсутствует`); continue; }
    fx.growth[k] = mk(GP, s, `formulas.growth.${k}`, false);
  }
  const D = cfg.diplomacy || {};
  const DP = ['M', 'w', 'sg', 'pow', 'ln', 'min', 'max', 'abs'];
  fx.dip.imp = mk(DP, D.chanceImprove, 'diplomacy.chanceImprove', false);
  fx.dip.wor = mk(DP, D.chanceWorsen, 'diplomacy.chanceWorsen', false);
  if (errors.length) { const e = new Error('Ошибки компиляции формул:\n' + errors.join('\n')); e.errors = errors; throw e; }
  return fx;
}

function runBody(fn, res, sph, rel) {
  const ces = (ids, rho) => {
    let s = 0;
    for (const id of ids) s += Math.pow(res[id] / 10, rho);
    return Math.pow(s / ids.length, 1 / rho);
  };
  const geo = (w) => {
    let p = 1;
    for (const id in w) p *= Math.pow((id in res ? res[id] : sph[id]) / 10, w[id]);
    return p;
  };
  return fn(res, sph, rel, Math.pow, Math.log, Math.min, Math.max, ces, geo, Math.sign, Math.abs, Math.exp);
}

// ---------------------------------------------------------------- состояние страны
function newCountryState(cfg, cid) {
  const c = cfg.countries.find((x) => x.id === cid);
  const C = {
    id: cid, isPlayer: false,
    res: {}, sph: {}, rel: {}, allies: {},
    techs: { done: {}, prog: {} },
    pending: [], active: [], mods: {},
    scores: {}, startScores: {}, points: { ai: 0, science: 0, fp: 0, transform: 0 },
    fpSpent: 0, exchange: {}, swan: { released: false, options: null, choice: null },
    techQueue: [], // очередь исследований по приоритету (как в Civ)
  };
  for (const r of cfg.resources) C.res[r.id] = { B: c.start.resources[r.id].B, C: c.start.resources[r.id].C };
  for (const s of cfg.spheres) C.sph[s.id] = { L: c.start.spheres[s.id].L, M: c.start.spheres[s.id].M };
  for (const o of cfg.countries) if (o.id !== cid) C.rel[o.id] = c.relations[o.id];
  return C;
}

function vzMap(C) {
  const m = {};
  for (const e of C.active) if (e.kind === 'VZ') m[e.target] = (m[e.target] || 0) + e.value;
  return m;
}
function realValues(cfg, C) {
  const vz = vzMap(C), res = {}, sph = {};
  const lo = cfg.limits.resMin, hi = cfg.limits.resMax;
  for (const r of cfg.resources) res[r.id] = r2(clamp(C.res[r.id].B + (vz['res:' + r.id] || 0), lo, hi));
  for (const s of cfg.spheres) sph[s.id] = r2(clamp(C.sph[s.id].L + (vz['sph:' + s.id] || 0), lo, hi));
  return { res, sph };
}
function getMod(C, key) {
  let v = C.mods[key] || 0;
  for (const e of C.active) if (e.kind === 'MOD' && e.target === 'mod:' + key) v += e.value;
  return v;
}
function relArray(cfg, C) { return cfg.countries.filter((c) => c.id !== C.id).map((c) => C.rel[c.id]); }

function scoresOf(cfg, fx, C, normalize = true) {
  const { res, sph } = realValues(cfg, C);
  const rel = relArray(cfg, C);
  const out = {};
  for (const k of ['ai', 'science']) {
    const f = fx.score[k];
    const x = runBody(f.fn, res, sph, rel);
    const s = (v) => Math.pow(v, f.n) / (Math.pow(f.k, f.n) + Math.pow(v, f.n));
    out[k] = 100 * s(x) / (normalize && f.normalize ? s(1) : 1);
  }
  for (const k of ['fp', 'transform']) out[k] = runBody(fx.score[k].fn, res, sph, rel);
  if (normalize) for (const k in out) out[k] = r2(clamp(out[k], 0, 100));
  return out;
}

// ---------------------------------------------------------------- вспомогательное
const nm = (cfg, cid) => (cfg.countries.find((c) => c.id === cid) || { name: cid }).name;
const resName = (cfg, id) => (cfg.resources.find((r) => r.id === id) || { name: id }).name;
const sphName = (cfg, id) => (cfg.spheres.find((r) => r.id === id) || { name: id }).name;
const fmt = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + String(Math.abs(r3(v))).replace('.', ',');
const MODNAMES = {
  ares_att: 'атака Ареса', athena_att: 'атака Афины', apollo_att: 'атака Аполлона',
  ares_def: 'защита Ареса', athena_def: 'защита Афины', apollo_def: 'защита Аполлона', all_def: 'вся оборона',
  relations_improve: 'улучшение отношений', science_all: 'эффективность науки',
  science_branch_M: 'наука ветви «Модели»', science_branch_MAX: 'наука ветвей M/A/X',
  ai_points_spheres: 'очки ИИ в сферы', ai_points_total: 'эффективность очков ИИ',
  transform_group_I: 'трансформация группы I', x4_double_swan: 'карты прорывов/рисков (2 броска D60)',
};
function describeTarget(cfg, t) {
  if (t === 'all_spheres') return 'все сферы ИИ';
  const [k, id] = t.split(':');
  if (k === 'res') return resName(cfg, id);
  if (k === 'sph') return 'сфера «' + sphName(cfg, id) + '»';
  return MODNAMES[id] || id;
}
function describeEffect(cfg, e) {
  const t = describeTarget(cfg, e.target);
  if (e.kind === 'MOD') return e.target === 'mod:x4_double_swan' ? t : `${t} ${fmt(e.value * 100)}%` + (e.ttl ? ' (1 ход)' : '');
  const kn = { PZ: 'ПЗ', VZ: 'ВЗ', PP: 'ПП', VP: 'ВП' }[e.kind];
  return `${t}: ${kn} ${fmt(e.value)}`;
}
function expandEffects(cfg, effects) {
  const out = [];
  for (const e of effects) {
    if (e.target === 'all_spheres') for (const s of cfg.spheres) out.push({ ...e, target: 'sph:' + s.id });
    else out.push({ ...e });
  }
  return out;
}
function pushLog(G, text, kind = 'info', extra) {
  G.logSeq = (G.logSeq || 0) + 1;
  G.log.push({ id: G.logSeq, year: G.year, kind, text, ...(extra || {}) });
  if (G.log.length > 600) G.log.splice(0, G.log.length - 600);
}
function setAlly(G, a, b, flag) {
  if (flag) { G.C[a].allies[b] = true; G.C[b].allies[a] = true; }
  else { delete G.C[a].allies[b]; delete G.C[b].allies[a]; }
}
function addRel(cfg, G, a, b, d, both = false) {
  const lo = cfg.diplomacy.minCode, hi = cfg.diplomacy.maxCode;
  G.C[a].rel[b] = r2(clamp(G.C[a].rel[b] + d, lo, hi));
  if (both) G.C[b].rel[a] = r2(clamp(G.C[b].rel[a] + d, lo, hi));
}
function statusLabel(cfg, code) {
  for (const l of cfg.ladder) {
    if ('le' in l && code <= l.le) return l.label;
    if ('lt' in l && code < l.lt) return l.label;
    if ('eq' in l && code === l.eq) return l.label;
    if (l.else) return l.label;
  }
  return '';
}

// ---------------------------------------------------------------- шансы дипломатии NPC
function chances(cfg, fx, M, Nraw, relMod = 0) {
  const N = Math.max(0, Nraw) * (1 + relMod);
  const w = Math.min(1, Math.log(1 + N) / Math.log(1 + cfg.diplomacy.wDenominator));
  const sg = M === 0 ? 0 : Math.sign(M) * Math.pow(Math.abs(M) / 5, 1.25);
  const R = fx.dip.imp(M, w, sg, Math.pow, Math.log, Math.min, Math.max, Math.abs);
  const T = fx.dip.wor(M, w, sg, Math.pow, Math.log, Math.min, Math.max, Math.abs);
  return { R, T, S: Math.max(0, 1 - R - T), w, N };
}

// ---------------------------------------------------------------- технологии
function techPrice(cfg, tech, nOthers) {
  const d = cfg.limits.diffusion;
  return tech.cost * Math.max(d.minFactor, 1 - d.perCountry * nOthers);
}
function techDoneCount(G, tid, exceptCid) {
  let n = 0;
  for (const p of G.players) if (p !== exceptCid && G.C[p].techs.done[tid]) n++;
  return n;
}
function scienceMult(cfg, C, tech) {
  let m = 1 + getMod(C, 'science_all');
  if (tech.id[0] === 'M') m += getMod(C, 'science_branch_M');
  if ('MAX'.includes(tech.id[0])) m += getMod(C, 'science_branch_MAX');
  return Math.max(0, m);
}
function giveTech(cfg, G, cid, tech) {
  const C = G.C[cid];
  C.techs.done[tech.id] = G.year;
  delete C.techs.prog[tech.id];
  C.techQueue = (C.techQueue || []).filter((x) => x !== tech.id);
  C.pending.push(...expandEffects(cfg, tech.effects));
}
function techAvailable(cfg, C, tech) {
  return !C.techs.done[tech.id] && tech.prereqs.every((p) => C.techs.done[p]);
}
/**
 * Очки науки по очереди приоритетов: всё в приоритет 1 до его полной стоимости, остаток — в 2, и т.д.
 * Технологии, у которых ещё не изучены требования, в этом году пропускаются (остаются в очереди).
 * Вложение никогда не превышает недостающую стоимость — очки не сгорают в переплате.
 */
function allocScience(cfg, G, cid) {
  const C = G.C[cid], out = {};
  let left = r2(C.points.science || 0);
  for (const tid of C.techQueue || []) {
    if (left <= 0) break;
    const t = cfg.techs.find((x) => x.id === tid);
    if (!t || !techAvailable(cfg, C, t)) continue;
    const mult = scienceMult(cfg, C, t);
    if (mult <= 0) continue;
    const need = Math.ceil(Math.max(0, techPrice(cfg, t, techDoneCount(G, tid, cid)) - (C.techs.prog[tid] || 0)) / mult * 100 - 1e-9) / 100;
    const give = r2(Math.min(need, left));
    if (give > 0) { out[tid] = give; left = r2(left - give); }
  }
  return out;
}
function setTechQueue(cfg, G, cid, ids) {
  const C = G.C[cid], known = new Set(cfg.techs.map((t) => t.id));
  if (!Array.isArray(ids)) return { error: 'Неверная очередь' };
  C.techQueue = [...new Set(ids.filter((id) => known.has(id) && !C.techs.done[id]))];
  return {};
}

// ---------------------------------------------------------------- план хода
const emptyPlan = () => ({
  transform: {}, ai: {}, science: {},
  fp: { improve: {}, attack: {}, defense: { ares: 0, athena: 0, apollo: 0 }, downgrade: [], breakAlliance: [] },
});
const nn = (x) => { x = Number(String(x).replace(",", ".")); return isFinite(x) && x > 0 ? Math.min(1000, Math.round(x * 100) / 100) : 0; };

function sanitizePlan(cfg, G, cid, raw) {
  const p = emptyPlan();
  raw = raw || {};
  const rids = new Set(cfg.resources.map((r) => r.id));
  const sids = new Set(cfg.spheres.map((r) => r.id));
  const tids = new Set(cfg.techs.map((r) => r.id));
  const cids = new Set(cfg.countries.map((r) => r.id));
  for (const id in raw.transform || {}) if (rids.has(id)) {
    const v = nn(raw.transform[id].v), pp = nn(raw.transform[id].p);
    if (v || pp) p.transform[id] = { v, p: pp };
  }
  for (const id in raw.ai || {}) if (sids.has(id)) { const v = nn(raw.ai[id]); if (v) p.ai[id] = v; }
  void tids; // наука распределяется только очередью приоритетов
  p.science = allocScience(cfg, G, cid);
  const fp = raw.fp || {};
  for (const id in fp.improve || {}) if (cids.has(id) && id !== cid && !G.C[id].isPlayer) { const v = nn(fp.improve[id]); if (v) p.fp.improve[id] = v; }
  // v0.3: войны только против стран-игроков; war.allowNpcTargets=true возвращает поведение v0.2
  const allowNpcWar = cfg.war.allowNpcTargets ?? false;
  for (const id in fp.attack || {}) if (cids.has(id) && id !== cid && (allowNpcWar || G.C[id].isPlayer)) {
    const a = fp.attack[id] || {};
    const o = { ares: nn(a.ares), athena: nn(a.athena), apollo: nn(a.apollo) };
    if (o.ares || o.athena || o.apollo) p.fp.attack[id] = o;
  }
  const d = fp.defense || {};
  p.fp.defense = { ares: nn(d.ares), athena: nn(d.athena), apollo: nn(d.apollo) };
  p.fp.downgrade = [...new Set((fp.downgrade || []).filter((id) => cids.has(id) && id !== cid))];
  p.fp.breakAlliance = [...new Set((fp.breakAlliance || []).filter((id) => cids.has(id) && id !== cid))];
  return p;
}
const sum = (o, f = (x) => x) => Object.values(o).reduce((a, b) => a + f(b), 0);
function planSpend(plan) {
  return {
    transform: sum(plan.transform, (x) => x.v + x.p),
    ai: sum(plan.ai),
    science: sum(plan.science),
    fp: sum(plan.fp.improve) + sum(plan.fp.attack, (x) => x.ares + x.athena + x.apollo) + sum(plan.fp.defense),
  };
}
const EPS = 1e-6;
function validatePlan(cfg, G, cid, plan) {
  const C = G.C[cid], errors = [], sp = planSpend(plan);
  if (sp.transform > C.points.transform + EPS) errors.push(`Трансформация: превышение (${r2(sp.transform)} из ${r2(C.points.transform)})`);
  if (sp.ai > C.points.ai + EPS) errors.push(`ИИ: превышение (${r2(sp.ai)} из ${r2(C.points.ai)})`);
  if (sp.science > C.points.science + EPS) errors.push(`Наука: превышение (${r2(sp.science)} из ${r2(C.points.science)})`);
  if (sp.fp + C.fpSpent > C.points.fp + EPS) errors.push(`Внешняя политика: превышение (${r2(sp.fp + C.fpSpent)} из ${r2(C.points.fp)})`);
  for (const tid in plan.science) {
    const t = cfg.techs.find((x) => x.id === tid);
    if (!techAvailable(cfg, C, t)) errors.push(`Технология ${tid}: недоступна (нет требований или уже изучена)`);
  }
  return { errors, spend: sp };
}
/** При разрешении хода: «грязные» части плана отбрасываются, а не угадываются. */
function enforcePlan(cfg, G, cid, plan) {
  const C = G.C[cid], p = plan, sp = planSpend(p);
  if (sp.transform > C.points.transform + EPS) p.transform = {};
  if (sp.ai > C.points.ai + EPS) p.ai = {};
  if (sp.science > C.points.science + EPS) p.science = {};
  if (sp.fp + C.fpSpent > C.points.fp + EPS) { p.fp.improve = {}; p.fp.attack = {}; p.fp.defense = { ares: 0, athena: 0, apollo: 0 }; }
  for (const tid in p.science) {
    const t = cfg.techs.find((x) => x.id === tid);
    if (!techAvailable(cfg, C, t)) delete p.science[tid];
  }
  return p;
}

// ---------------------------------------------------------------- переход года для одной страны
function transitionCountry(cfg, fx, C, plan, previewOnly = false) {
  const g = fx.growth, lim = cfg.limits;
  const kAI = 1 + getMod(C, 'ai_points_spheres') + getMod(C, 'ai_points_total');
  const kIg = 1 + getMod(C, 'transform_group_I');
  const dPZ = {}, dPP = {}, vp = {}, newActive = [], newMods = {};
  if (!previewOnly) {
    for (const e of C.pending) {
      if (e.kind === 'PZ') dPZ[e.target] = (dPZ[e.target] || 0) + e.value;
      else if (e.kind === 'PP') dPP[e.target] = (dPP[e.target] || 0) + e.value;
      else if (e.kind === 'VP') vp[e.target] = (vp[e.target] || 0) + e.value;
      else if (e.kind === 'VZ') newActive.push({ ...e });
      else if (e.kind === 'MOD') {
        if (e.ttl) newActive.push({ ...e });
        else { const k = e.target.slice(4); newMods[k] = (newMods[k] || 0) + e.value; }
      }
    }
  }
  const rv = realValues(cfg, C);
  const out = { res: {}, sph: {} };
  const P = [Math.pow, Math.log, Math.min, Math.max, Math.abs];
  for (const r of cfg.resources) {
    const s = C.res[r.id], t = 'res:' + r.id, pl = plan.transform[r.id] || { v: 0, p: 0 };
    const kI = r.group === 'I' ? kIg : 1;
    const B2 = g.resB(s.B, s.C, 0, 0, rv.res[r.id], 0, pl.v, pl.p, 0, vp[t] || 0, dPZ[t] || 0, dPP[t] || 0, kI, kAI, ...P);
    const C2 = g.resC(s.B, s.C, 0, 0, rv.res[r.id], 0, pl.v, pl.p, 0, vp[t] || 0, dPZ[t] || 0, dPP[t] || 0, kI, kAI, ...P);
    out.res[r.id] = { B: r2(clamp(num(B2), lim.resMin, lim.resMax)), C: r2(Math.min(lim.growthMax, num(C2))) };
  }
  for (const sp of cfg.spheres) {
    const s = C.sph[sp.id], t = 'sph:' + sp.id, h = plan.ai[sp.id] || 0;
    const L2 = g.sphL(0, 0, s.L, s.M, 0, rv.sph[sp.id], 0, 0, h, vp[t] || 0, dPZ[t] || 0, dPP[t] || 0, 1, kAI, ...P);
    const M2 = g.sphM(0, 0, s.L, s.M, 0, rv.sph[sp.id], 0, 0, h, vp[t] || 0, dPZ[t] || 0, dPP[t] || 0, 1, kAI, ...P);
    out.sph[sp.id] = { L: r2(clamp(num(L2), lim.resMin, lim.resMax)), M: r2(Math.min(lim.growthMax, num(M2))) };
  }
  if (!previewOnly) {
    for (const id in out.res) C.res[id] = out.res[id];
    for (const id in out.sph) C.sph[id] = out.sph[id];
    for (const k in newMods) C.mods[k] = (C.mods[k] || 0) + newMods[k];
    C.active = newActive;
    C.pending = [];
  }
  return out;
}

function previewPlan(cfg, fx, G, cid) {
  const C = G.C[cid], plan = G.P[cid] || emptyPlan();
  const { errors, spend } = validatePlan(cfg, G, cid, plan);
  const tr = transitionCountry(cfg, fx, C, plan, true);
  const relMod = getMod(C, 'relations_improve');
  const ch = {};
  for (const o of cfg.countries) if (o.id !== cid && !G.C[o.id].isPlayer)
    ch[o.id] = chances(cfg, fx, C.rel[o.id], plan.fp.improve[o.id] || 0, relMod);
  return { errors, spend, next: tr, chances: ch };
}

// ---------------------------------------------------------------- очки хода
function refreshPoints(cfg, fx, G) {
  for (const cid in G.C) {
    const C = G.C[cid];
    C.scores = scoresOf(cfg, fx, C);
    if (C.isPlayer) {
      C.points = { ...C.scores };
      C.fpSpent = 0; C.exchange = {};
      C.swan = { released: false, options: null, choice: null };
    }
  }
}

function newGame(cfg, fx, playerIds, rng) {
  const G = {
    year: cfg.timers.startYear, phase: 'game', players: playerIds.slice(), C: {}, P: {},
    proposals: [], propSeq: 0, board: [], boardSeq: 0, deals: [], log: [], logSeq: 0, result: null, winnerHistory: [],
  };
  for (const c of cfg.countries) G.C[c.id] = newCountryState(cfg, c.id);
  for (const p of playerIds) { G.C[p].isPlayer = true; G.P[p] = emptyPlan(); }
  refreshPoints(cfg, fx, G);
  for (const cid in G.C) G.C[cid].startScores = { ...G.C[cid].scores };
  syncNpcAlliances(cfg, G);
  pushLog(G, `Игра началась. Играют: ${playerIds.map((p) => nm(cfg, p)).join(', ')}. Год ${G.year}.`, 'system');
  return G;
}

function syncNpcAlliances(cfg, G) {
  const d = cfg.diplomacy;
  for (const p of G.players) for (const n in G.C) {
    if (n === p || G.C[n].isPlayer) continue;
    const code = G.C[p].rel[n];
    if (code > d.npcAllianceOn) setAlly(G, p, n, true);
    else if (code <= d.npcAllianceOff) setAlly(G, p, n, false);
  }
}

// ---------------------------------------------------------------- предложения
function propose(cfg, G, from, to, type) {
  const F = G.C[from], T = G.C[to];
  if (!T || !T.isPlayer || from === to) return { error: 'Предложение возможно только другому игроку' };
  if (type !== 'improve' && type !== 'alliance') return { error: 'Неизвестный тип предложения' };
  if (G.proposals.some((p) => p.status === 'pending' && p.from === from && p.to === to && p.type === type && p.year === G.year))
    return { error: 'Такое предложение уже отправлено' };
  const d = cfg.diplomacy;
  if (type === 'improve') {
    if (F.rel[to] >= d.maxCode) return { error: 'Отношения уже максимальные' };
    const spend = planSpend(G.P[from]).fp + F.fpSpent;
    if (F.points.fp - spend < d.improveCost - EPS) return { error: 'Не хватает внешнеполитических очков' };
    F.fpSpent += d.improveCost;
  } else {
    if (F.allies[to]) return { error: 'Союз уже есть' };
    if (Math.min(F.rel[to], T.rel[from]) <= d.allianceMin) return { error: `Для союза нужны отношения выше «Партнёрство» (код > ${d.allianceMin}) с обеих сторон` };
  }
  G.propSeq++;
  const pr = { id: G.propSeq, type, from, to, year: G.year, status: 'pending', applied: false };
  G.proposals.push(pr);
  pushLog(G, type === 'improve'
    ? `${nm(cfg, from)} предлагает повышение отношений с ${nm(cfg, to)} на +1`
    : `${nm(cfg, from)} предлагает союз ${nm(cfg, to)}`, 'proposal', { pid: pr.id });
  return { ok: true, proposal: pr };
}
function respond(cfg, G, cid, pid, accept) {
  const pr = G.proposals.find((p) => p.id === pid);
  if (!pr || pr.to !== cid) return { error: 'Предложение не найдено' };
  if (pr.status !== 'pending') return { error: 'Предложение уже обработано' };
  pr.status = accept ? 'accepted' : 'rejected';
  return { ok: true };
}

// ---------------------------------------------------------------- торговля
function canPay(cfg, G, cid, give, want) {
  // give — что страна cid отдаёт, want — что получает (ресурсы {rid:amt})
  const C = G.C[cid], lim = cfg.limits;
  const ids = new Set([...Object.keys(give), ...Object.keys(want)]);
  for (const id of ids) {
    const nb = C.res[id].B - (give[id] || 0) + (want[id] || 0);
    if (nb < lim.resMin - EPS) return `У страны ${nm(cfg, cid)} ресурс «${resName(cfg, id)}» не может опуститься ниже ${lim.resMin}`;
    if (nb > lim.resMax + EPS) return `У страны ${nm(cfg, cid)} ресурс «${resName(cfg, id)}» не может превысить ${lim.resMax}`;
  }
  return null;
}
function cleanRes(cfg, o) {
  const out = {}, rids = new Set(cfg.resources.map((r) => r.id));
  for (const id in o || {}) if (rids.has(id)) { const v = Math.min(cfg.limits.tradeMaxAmount, nn(o[id])); if (v) out[id] = v; }
  return out;
}
function cleanTechs(cfg, a) {
  const t = new Set(cfg.techs.map((x) => x.id));
  return [...new Set((a || []).filter((x) => t.has(x)))];
}
function techsOk(cfg, G, giver, taker, techs) {
  for (const tid of techs) {
    if (!G.C[giver].techs.done[tid]) return `У страны ${nm(cfg, giver)} нет технологии ${tid}`;
    if (G.C[taker].techs.done[tid]) return `У страны ${nm(cfg, taker)} технология ${tid} уже есть`;
  }
  return null;
}
function postListing(cfg, G, cid, raw) {
  const give = { res: cleanRes(cfg, raw.give && raw.give.res), techs: cleanTechs(cfg, raw.give && raw.give.techs) };
  const want = { res: cleanRes(cfg, raw.want && raw.want.res), techs: cleanTechs(cfg, raw.want && raw.want.techs) };
  const years = clamp(Math.round(Number(raw.years) || 1), 1, cfg.limits.tradeMaxYears);
  if (!Object.keys(give.res).length && !give.techs.length && !Object.keys(want.res).length && !want.techs.length)
    return { error: 'Пустое объявление' };
  const e = canPay(cfg, G, cid, give.res, want.res);
  if (e) return { error: e };
  for (const tid of give.techs) if (!G.C[cid].techs.done[tid]) return { error: `У вас нет технологии ${tid}` };
  for (const tid of want.techs) if (G.C[cid].techs.done[tid]) return { error: `Технология ${tid} у вас уже есть` };
  G.boardSeq++;
  const l = { id: G.boardSeq, owner: cid, give, want, years, status: 'open', year: G.year, acceptedBy: null };
  G.board.push(l);
  pushLog(G, `${nm(cfg, cid)} разместила объявление на доске торгов №${l.id}`, 'trade');
  return { ok: true, listing: l };
}
function cancelListing(cfg, G, cid, id) {
  const l = G.board.find((x) => x.id === id);
  if (!l || l.owner !== cid || l.status !== 'open') return { error: 'Нельзя снять это объявление' };
  l.status = 'cancelled';
  return { ok: true };
}
function transferRes(cfg, G, a, b, ab, ba) { // a→b: ab, b→a: ba
  for (const id in ab) { G.C[a].res[id].B = r3(G.C[a].res[id].B - ab[id]); G.C[b].res[id].B = r3(G.C[b].res[id].B + ab[id]); }
  for (const id in ba) { G.C[b].res[id].B = r3(G.C[b].res[id].B - ba[id]); G.C[a].res[id].B = r3(G.C[a].res[id].B + ba[id]); }
}
function acceptListing(cfg, G, cid, id) {
  const l = G.board.find((x) => x.id === id);
  if (!l || l.status !== 'open') return { error: 'Объявление недоступно' };
  if (l.owner === cid) return { error: 'Нельзя принять своё объявление' };
  if (!G.C[cid] || !G.C[cid].isPlayer) return { error: 'Только игрок может принять' };
  const o = l.owner;
  const e = canPay(cfg, G, o, l.give.res, l.want.res) || canPay(cfg, G, cid, l.want.res, l.give.res)
    || techsOk(cfg, G, o, cid, l.give.techs) || techsOk(cfg, G, cid, o, l.want.techs);
  if (e) return { error: e };
  transferRes(cfg, G, o, cid, l.give.res, l.want.res);
  for (const tid of l.give.techs) giveTech(cfg, G, cid, cfg.techs.find((t) => t.id === tid));
  for (const tid of l.want.techs) giveTech(cfg, G, o, cfg.techs.find((t) => t.id === tid));
  l.status = 'done'; l.acceptedBy = cid;
  if (l.years > 1 && (Object.keys(l.give.res).length || Object.keys(l.want.res).length))
    G.deals.push({ id: l.id, a: o, b: cid, give: l.give.res, want: l.want.res, left: l.years - 1 });
  pushLog(G, `Сделка №${l.id}: ${nm(cfg, o)} ⇄ ${nm(cfg, cid)}${l.years > 1 ? ` (на ${l.years} лет)` : ''}`, 'trade');
  return { ok: true };
}
function npcExchange(cfg, G, cid, npc, giveRid, wantRid, amount) {
  const d = cfg.diplomacy.npcExchange, C = G.C[cid];
  const nc = G.C[npc];
  if (!nc || nc.isPlayer || npc === cid) return { error: 'Обмен возможен только с NPC' };
  if (C.rel[npc] < d.minRelation) return { error: `Отношения с ${nm(cfg, npc)} ниже ${d.minRelation}` };
  if (!C.res[giveRid] || !C.res[wantRid] || giveRid === wantRid) return { error: 'Неверные ресурсы' };
  amount = r2(Math.min(nn(amount), cfg.limits.tradeMaxAmount));
  if (!amount) return { error: 'Укажите количество' };
  const got = (C.exchange[npc] || 0) + amount;
  if (got > d.maxReceivePerNpcPerTurn + EPS) return { error: `Лимит обмена с NPC: ${d.maxReceivePerNpcPerTurn} за ход` };
  const give = { [giveRid]: amount * d.rate }, want = { [wantRid]: amount };
  const e = canPay(cfg, G, cid, give, want);
  if (e) return { error: e };
  C.res[giveRid].B = r3(C.res[giveRid].B - amount * d.rate);
  C.res[wantRid].B = r3(C.res[wantRid].B + amount);
  C.exchange[npc] = got;
  pushLog(G, `${nm(cfg, cid)} обменяла с ${nm(cfg, npc)}: −${amount * d.rate} «${resName(cfg, giveRid)}», +${amount} «${resName(cfg, wantRid)}»`, 'trade');
  return { ok: true };
}

// ---------------------------------------------------------------- чёрный лебедь
function releaseSwan(cfg, G, cid, rng) {
  const C = G.C[cid];
  if (C.swan.released) return { error: 'Лебедь уже выпущен в этом ходу' };
  C.swan.released = true;
  if (getMod(C, 'x4_double_swan') > 0) C.swan.options = [rng.int(1, 60), rng.int(1, 60)];
  pushLog(G, `Страна ${nm(cfg, cid)} выпустила чёрного лебедя`, 'swan');
  return { ok: true };
}
function pickSwan(G, cid, idx) {
  const C = G.C[cid];
  if (!C.swan.released || !C.swan.options) return { error: 'Нет вариантов для выбора' };
  if (idx !== 0 && idx !== 1) return { error: 'Неверный вариант' };
  C.swan.choice = idx;
  return { ok: true };
}

// ---------------------------------------------------------------- войны
function warProbs(cfg, PA, PB) {
  const pA = PA + PB > 0 ? PA / (PA + PB) : 0.5, pB = 1 - pA;
  const draw = cfg.war.drawFactor * pA * pB;
  return { pA, pB, draw, A: (1 - draw) * pA, B: (1 - draw) * pB };
}
function power(cfg, c) { const w = cfg.war.power; return c.ares * w.ares + c.athena * w.athena + c.apollo * w.apollo; }

function resolveWar(cfg, G, A, T, atk, rng) {
  const W = cfg.war, CA = G.C[A], CT = G.C[T];
  // атака: -1 ступень, союз разрывается
  addRel(cfg, G, A, T, -W.relationDropOnAttack, true);
  setAlly(G, A, T, false);
  const mA = (k) => 1 + getMod(CA, k + '_att');
  const aC = { ares: atk.ares * mA('ares'), athena: atk.athena * mA('athena'), apollo: atk.apollo * mA('apollo') };
  let dC;
  if (CT.isPlayer) {
    const d = (G.P[T] || emptyPlan()).fp.defense, all = getMod(CT, 'all_def');
    const mD = (k) => Math.max(0, 1 + getMod(CT, k + '_def') + all);
    dC = { ares: d.ares * mD('ares'), athena: d.athena * mD('athena'), apollo: d.apollo * mD('apollo') };
  } else dC = { ...W.npcDefense };
  const PA = power(cfg, aC), PB = power(cfg, dC);
  const pr = warProbs(cfg, PA, PB);
  const die = W.dieSize;
  const a = Math.round(die * pr.A);
  let dr = Math.round(die * pr.draw);
  if (a + dr > die) dr = die - a;
  const roll = rng.int(1, die);
  let outcome, degree = 0;
  if (roll <= a) { outcome = 'A'; degree = roll / a <= 1 / 3 ? 1 : roll / a <= 2 / 3 ? 2 : 3; }
  else if (roll <= a + dr) outcome = 'draw';
  else { outcome = 'B'; const sz = die - a - dr, pos = (roll - a - dr) / sz; degree = pos <= 1 / 3 ? 1 : pos <= 2 / 3 ? 2 : 3; }
  const lines = [];
  const eff = (cid, sign, parts) => { // parts — список эффектов для страны-игрока
    if (!G.C[cid].isPlayer) return;
    G.C[cid].pending.push(...parts);
  };
  const L = W.totalLevels;
  const randRes = () => rng.pick(cfg.resources).id, randSph = () => rng.pick(cfg.spheres).id;
  const randCountry = (self) => rng.pick(cfg.countries.filter((c) => c.id !== self)).id;
  if (outcome !== 'draw') {
    const win = outcome === 'A' ? A : T, lose = outcome === 'A' ? T : A;
    const chans = rng.shuffle(['resource', 'society', 'diplomacy']).slice(0, degree);
    for (const [cid, sg] of [[win, 1], [lose, -1]]) {
      for (const ch of chans) {
        if (ch === 'resource') {
          const rid = randRes(), [v, gr] = L.resource[degree - 1];
          eff(cid, sg, [{ target: 'res:' + rid, kind: 'PZ', value: sg * v }, { target: 'res:' + rid, kind: 'PP', value: sg * gr }]);
          if (G.C[cid].isPlayer) lines.push(`${nm(cfg, cid)}: «${resName(cfg, rid)}» ${fmt(sg * v)} / прирост ${fmt(sg * gr)}`);
        } else if (ch === 'society') {
          const sid = randSph(), v = L.sphere[degree - 1];
          eff(cid, sg, [{ target: 'sph:' + sid, kind: 'PP', value: sg * v }]);
          if (G.C[cid].isPlayer) lines.push(`${nm(cfg, cid)}: сфера «${sphName(cfg, sid)}» прирост ${fmt(sg * v)}`);
        } else {
          const x = randCountry(cid), v = L.relation[degree - 1];
          if (G.C[cid].isPlayer) { addRel(cfg, G, cid, x, sg * v); lines.push(`${nm(cfg, cid)}: отношения с ${nm(cfg, x)} ${fmt(sg * v)}`); }
        }
      }
    }
  }
  // локальные исходы по каналам
  const loc = W.local;
  const chs = [['ares', 'Арес'], ['athena', 'Афина'], ['apollo', 'Аполлон']];
  for (const [k, label] of chs) {
    const ea = aC[k], eb = dC[k], hi = Math.max(ea, eb), lo = Math.min(ea, eb);
    if (hi - lo < loc.minDiff) continue;
    const ratio = lo <= 0 ? Infinity : hi / lo;
    const lvl = ratio >= loc.ratios[2] ? 3 : ratio >= loc.ratios[1] ? 2 : ratio >= loc.ratios[0] ? 1 : 0;
    if (!lvl) continue;
    const win = ea > eb ? A : T, lose = ea > eb ? T : A;
    for (const [cid, sg] of [[win, 1], [lose, -1]]) {
      if (!G.C[cid].isPlayer) continue;
      if (k === 'ares') {
        const grp = cfg.resources.filter((r) => r.group === loc.ares.group);
        for (const r of rng.shuffle(grp).slice(0, lvl)) {
          eff(cid, sg, [{ target: 'res:' + r.id, kind: 'PZ', value: sg * loc.ares.value[lvl - 1] }, { target: 'res:' + r.id, kind: 'PP', value: sg * loc.ares.growth[lvl - 1] }]);
          lines.push(`${label}: ${nm(cfg, cid)} «${resName(cfg, r.id)}» ${fmt(sg * loc.ares.value[lvl - 1])}`);
        }
      } else if (k === 'athena') {
        for (const s of rng.shuffle(cfg.spheres).slice(0, lvl)) {
          eff(cid, sg, [{ target: 'sph:' + s.id, kind: 'PP', value: sg * loc.athena[lvl - 1] }]);
          lines.push(`${label}: ${nm(cfg, cid)} сфера «${s.name}» прирост ${fmt(sg * loc.athena[lvl - 1])}`);
        }
      } else {
        for (const c of rng.shuffle(cfg.countries.filter((c) => c.id !== cid)).slice(0, lvl)) {
          addRel(cfg, G, cid, c.id, sg * loc.apollo[lvl - 1]);
          lines.push(`${label}: ${nm(cfg, cid)} отношения с ${c.name} ${fmt(sg * loc.apollo[lvl - 1])}`);
        }
      }
    }
  }
  const res = outcome === 'A' ? `победа ${nm(cfg, A)} (степень ${degree})` : outcome === 'B' ? `победа ${nm(cfg, T)} (степень ${degree})` : 'ничья';
  pushLog(G, `Война ${nm(cfg, A)} → ${nm(cfg, T)}: сила ${r2(PA)} против ${r2(PB)}; P(A)=${Math.round(pr.A * 100)}%, ничья ${Math.round(pr.draw * 100)}%, P(B)=${Math.round(pr.B * 100)}%; бросок D${die}: ${roll} — ${res}.` + (lines.length ? '\n' + lines.join('\n') : ''), 'war');
  return { outcome, degree, roll, probs: pr, PA, PB };
}

// ---------------------------------------------------------------- разрешение хода
function applySwan(cfg, G, cid, rng) {
  const C = G.C[cid];
  let id;
  if (C.swan.options) id = C.swan.options[C.swan.choice === 1 ? 1 : 0];
  else id = rng.int(1, 60);
  const sw = cfg.blackSwans.find((s) => s.id === id);
  let targets;
  if (sw.type === 'global') targets = G.players.slice();
  else if (sw.type === 'national') targets = [cid];
  else targets = [cid, ...G.players.filter((p) => p !== cid && C.allies[p])];
  for (const t of targets) G.C[t].pending.push(...expandEffects(cfg, sw.effects));
  pushLog(G, `Чёрный лебедь страны ${nm(cfg, cid)}: №${sw.id} «${sw.title}» (${sw.sign === '+' ? 'благоприятное' : 'неблагоприятное'}). Затронуты: ${targets.map((t) => nm(cfg, t)).join(', ')}. Эффект: ${sw.effects.map((e) => describeEffect(cfg, e)).join('; ')}`, 'swan');
}

function checkVictory(cfg, G) {
  const V = cfg.victory, out = [];
  for (const cid of G.players) {
    const C = G.C[cid], types = [];
    if (V.scales.enabled && ['ai', 'science', 'fp', 'transform'].every((k) => C.scores[k] >= V.scales.min - 1e-9)) types.push('scales');
    if (V.tech.enabled && cfg.techs.every((t) => C.techs.done[t.id])) types.push('tech');
    if (V.diplomacy.enabled && cfg.countries.every((c) => c.id === cid || C.allies[c.id])) types.push('diplomacy');
    if (types.length) out.push({ cid, types });
  }
  return out;
}
const sumScores = (s) => s.ai + s.science + s.fp + s.transform;
const TYPE_NAMES = { scales: 'по всем шкалам', tech: 'технологическая', diplomacy: 'дипломатическая', score: 'по очкам на конец игры', early: 'досрочное завершение (по приросту очков)' };

function finish(cfg, G, winnerCid, type) {
  G.phase = 'finished';
  const table = G.players.map((cid) => {
    const C = G.C[cid];
    return { cid, start: C.startScores, final: C.scores, startSum: sumScores(C.startScores), finalSum: sumScores(C.scores), delta: sumScores(C.scores) - sumScores(C.startScores), techs: Object.keys(C.techs.done).length };
  });
  table.sort((a, b) => (winnerCid === a.cid ? -1 : winnerCid === b.cid ? 1 : 0) || b.delta - a.delta || a.startSum - b.startSum);
  G.result = { winner: winnerCid, type, typeName: TYPE_NAMES[type], table };
  pushLog(G, `Игра окончена. Победитель: ${nm(cfg, winnerCid)} (${TYPE_NAMES[type]}).`, 'system');
}

function resolveTurn(cfg, fx, G, rng) {
  const year = G.year;
  const players = G.players;
  // 0. нормализация планов
  for (const cid of players) G.P[cid] = enforcePlan(cfg, G, cid, sanitizePlan(cfg, G, cid, G.P[cid]));
  // 1. блокировка, предложения без ответа
  for (const p of G.proposals) if (p.status === 'pending') { p.status = 'rejected'; p.note = 'нет ответа'; }
  // 2. технологии
  const snap = {};
  for (const t of cfg.techs) snap[t.id] = techDoneCount(G, t.id, null);
  const completed = [];
  for (const cid of players) {
    const C = G.C[cid];
    for (const tid in G.P[cid].science) {
      const t = cfg.techs.find((x) => x.id === tid);
      C.techs.prog[tid] = (C.techs.prog[tid] || 0) + G.P[cid].science[tid] * scienceMult(cfg, C, t);
      if (C.techs.prog[tid] + 1e-9 >= techPrice(cfg, t, snap[tid])) completed.push([cid, t]);
    }
  }
  for (const [cid, t] of completed) { giveTech(cfg, G, cid, t); pushLog(G, `${nm(cfg, cid)} изучила технологию ${t.id} «${t.name}»`, 'tech'); }
  // 3. дипломатия
  const pairKey = (a, b) => [a, b].sort().join('|');
  const usedPairs = new Set();
  for (const cid of players) {
    const fp = G.P[cid].fp;
    for (const t of fp.breakAlliance) if (G.C[cid].allies[t]) { setAlly(G, cid, t, false); pushLog(G, `${nm(cfg, cid)} разорвала союз с ${nm(cfg, t)}`, 'diplo'); }
    for (const t of fp.downgrade) { addRel(cfg, G, cid, t, -1, G.C[t].isPlayer); pushLog(G, `${nm(cfg, cid)} понизила отношения с ${nm(cfg, t)} на 1`, 'diplo'); }
  }
  for (const p of G.proposals) {
    if (p.status !== 'accepted' || p.applied) continue;
    p.applied = true;
    if (p.type === 'improve') {
      const k = pairKey(p.from, p.to);
      if (usedPairs.has(k)) { p.status = 'rejected'; p.note = 'лимит +1 на пару за ход'; continue; }
      usedPairs.add(k);
      addRel(cfg, G, p.from, p.to, 1, true);
      pushLog(G, `Отношения ${nm(cfg, p.from)} и ${nm(cfg, p.to)} улучшены на +1`, 'diplo');
    } else {
      if (Math.min(G.C[p.from].rel[p.to], G.C[p.to].rel[p.from]) <= cfg.diplomacy.allianceMin) { p.status = 'rejected'; p.note = 'отношения упали'; continue; }
      setAlly(G, p.from, p.to, true);
      pushLog(G, `Заключён союз: ${nm(cfg, p.from)} и ${nm(cfg, p.to)}`, 'diplo');
    }
  }
  for (const cid of players) {
    const C = G.C[cid], relMod = getMod(C, 'relations_improve'), up = [], down = [];
    for (const n of cfg.countries) {
      if (n.id === cid || G.C[n.id].isPlayer) continue;
      const ch = chances(cfg, fx, C.rel[n.id], G.P[cid].fp.improve[n.id] || 0, relMod);
      const u = rng.float() * 100;
      if (u < ch.R * 100) { addRel(cfg, G, cid, n.id, 1); up.push(n.name); }
      else if (u >= (ch.R + ch.S) * 100) { addRel(cfg, G, cid, n.id, -1); down.push(n.name); }
    }
    if (up.length || down.length)
      pushLog(G, `${nm(cfg, cid)}: ` + [up.length ? `отношения улучшились с ${up.join(', ')}` : '', down.length ? `ухудшились с ${down.join(', ')}` : ''].filter(Boolean).join('; '), 'diplo');
  }
  syncNpcAlliances(cfg, G);
  // 4. войны
  for (const A of players) for (const T in G.P[A].fp.attack) {
    if (!(cfg.war.allowNpcTargets ?? false) && !G.C[T].isPlayer) { // v0.3: NPC атаковать нельзя
      pushLog(G, `${nm(cfg, A)}: атака на ${nm(cfg, T)} отменена — войны против NPC запрещены`, 'war');
      continue;
    }
    resolveWar(cfg, G, A, T, G.P[A].fp.attack[T], rng);
  }
  // 5. чёрные лебеди
  for (const cid of players) if (G.C[cid].swan.released) applySwan(cfg, G, cid, rng);
  // 6. переход года + многолетние сделки
  for (const cid of players) transitionCountry(cfg, fx, G.C[cid], G.P[cid], false);
  for (const d of G.deals.slice()) {
    const e = canPay(cfg, G, d.a, d.give, d.want) || canPay(cfg, G, d.b, d.want, d.give);
    if (e) { pushLog(G, `Сделка №${d.id} расторгнута: ${e}`, 'trade'); G.deals.splice(G.deals.indexOf(d), 1); continue; }
    transferRes(cfg, G, d.a, d.b, d.give, d.want);
    if (--d.left <= 0) { G.deals.splice(G.deals.indexOf(d), 1); pushLog(G, `Сделка №${d.id} завершена`, 'trade'); }
  }
  G.board = G.board.filter((l) => l.status === 'open' || l.year >= year - 1);
  G.year = year + 1;
  for (const cid of players) G.P[cid] = emptyPlan();
  // 7. очки и победа
  refreshPoints(cfg, fx, G);
  pushLog(G, `Итоги ${year}:\n` + players.map((cid) => { const s = G.C[cid].scores; return `${nm(cfg, cid)} — ИИ ${f2(s.ai)}, наука ${f2(s.science)}, ВП ${f2(s.fp)}, трансф. ${f2(s.transform)}`; }).join('\n'), 'summary');
  const wins = checkVictory(cfg, G);
  if (wins.length) {
    wins.sort((a, b) => sumScores(G.C[a.cid].startScores) - sumScores(G.C[b.cid].startScores));
    finish(cfg, G, wins[0].cid, wins[0].types[0]);
  } else if (G.year > cfg.timers.endYear) {
    finish(cfg, G, leaderByDelta(G), 'score');
  }
  return G;
}
/** Лидер по приросту суммы очков; при равенстве — худший старт. */
function leaderByDelta(G) {
  const sc = G.players.map((cid) => ({ cid, d: sumScores(G.C[cid].scores) - sumScores(G.C[cid].startScores), s: sumScores(G.C[cid].startScores) }));
  sc.sort((a, b) => b.d - a.d || a.s - b.s);
  return sc[0].cid;
}
/** Досрочное завершение партии (админ или все игроки офлайн): итог по текущим очкам. */
function finishEarly(cfg, G, reason) {
  if (G.phase === 'finished') return G;
  pushLog(G, `Партия завершена досрочно: ${reason}.`, 'system');
  finish(cfg, G, leaderByDelta(G), 'early');
  return G;
}

// ---------------------------------------------------------------- профиль страны для драфта
function profile(cfg, fx, cid) {
  const C = newCountryState(cfg, cid);
  const sc = scoresOf(cfg, fx, C);
  const rs = cfg.resources.map((r) => ({ name: r.name, v: C.res[r.id].B })).sort((a, b) => b.v - a.v);
  const strong = rs.slice(0, 3).map((x) => x.name), weak = rs.slice(-3).reverse().map((x) => x.name);
  const names = { ai: 'ИИ', science: 'Наука', fp: 'Внешняя политика', transform: 'Трансформация' };
  const best = Object.keys(sc).sort((a, b) => sc[b] - sc[a])[0];
  const rel = Object.entries(C.rel).map(([id, v]) => ({ id, v })).sort((a, b) => b.v - a.v);
  const allies = rel.filter((x) => x.v >= 2.5).slice(0, 3).map((x) => nm(cfg, x.id));
  const enemies = rel.slice().reverse().filter((x) => x.v <= -1).slice(0, 3).map((x) => nm(cfg, x.id));
  const desc = `Сильные стороны: ${strong.join(', ')}. Слабые: ${weak.join(', ')}. Лучшая шкала: ${names[best]} (${Math.round(sc[best])}). ` +
    `Ключевые партнёры: ${allies.length ? allies.join(', ') : 'нет явных'}. Противники: ${enemies.length ? enemies.join(', ') : 'нет явных'}.`;
  return { scores: sc, strong, weak, best, allies, enemies, desc };
}

module.exports = {
  finishEarly, allocScience, setTechQueue,
  clamp, r2, makeRng, seededRng, compile, runBody, newCountryState, realValues, getMod, scoresOf, relArray, chances,
  techPrice, techAvailable, giveTech, emptyPlan, sanitizePlan, validatePlan, enforcePlan, planSpend, transitionCountry,
  previewPlan, refreshPoints, newGame, syncNpcAlliances, propose, respond, postListing, cancelListing, acceptListing,
  npcExchange, releaseSwan, pickSwan, warProbs, resolveWar, resolveTurn, checkVictory, profile, statusLabel, describeEffect,
  scienceMult, pushLog, nm, sumScores, techDoneCount, TYPE_NAMES,
};
