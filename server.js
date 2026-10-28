'use strict';
/**
 * server.js — «Глобальный ИИ». Node 22, только stdlib.
 * Сервер — единственный источник истины. Клиент шлёт намерения (POST JSON) и слушает SSE.
 */
const http = require('http');
const https = require('https');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const E = require('./engine.js');
const SC = require('./tools/selfcheck.js');

const PORT = Number(process.env.PORT) || 3000;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 3443;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const DEFAULT_CFG = path.join(DATA, 'default_config.json');
const WORK_CFG = path.join(DATA, 'config.json');
const ROOMS_FILE = path.join(DATA, 'rooms.json');
const WORDS = JSON.parse(fs.readFileSync(path.join(DATA, 'words.json'), 'utf8'));

let ADMIN_TOKEN = process.env.ADMIN_TOKEN;
if (!ADMIN_TOKEN) {
  ADMIN_TOKEN = crypto.randomBytes(9).toString('hex');
  console.log(`[admin] ADMIN_TOKEN не задан, сгенерирован: ${ADMIN_TOKEN}`);
}

// ------------------------------------------------------------ ГСЧ (crypto)
const rng = E.makeRng(() => crypto.randomInt(0, 2 ** 32) / 2 ** 32);

// ------------------------------------------------------------ конфиг
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
let currentCfg;
function loadWorkingConfig() {
  if (!fs.existsSync(WORK_CFG)) fs.copyFileSync(DEFAULT_CFG, WORK_CFG);
  currentCfg = readJson(WORK_CFG);
  E.compile(currentCfg); // упадёт сразу, если конфиг сломан
}

const KNOWN_MODS = new Set(['ares_att', 'athena_att', 'apollo_att', 'ares_def', 'athena_def', 'apollo_def', 'all_def',
  'relations_improve', 'science_all', 'science_branch_M', 'science_branch_MAX', 'ai_points_spheres', 'transform_group_I',
  'ai_points_total', 'x4_double_swan']);

/** Структурная проверка конфига (кроме формул). Возвращает список ошибок. */
function validateStructure(cfg) {
  const err = [];
  const need = ['resources', 'spheres', 'countries', 'techs', 'blackSwans', 'formulas', 'war', 'diplomacy', 'timers', 'victory', 'ladder', 'limits'];
  for (const k of need) if (cfg[k] === undefined) err.push(`нет раздела ${k}`);
  if (err.length) return err;
  const rids = new Set(cfg.resources.map((r) => r.id)), sids = new Set(cfg.spheres.map((r) => r.id));
  const cids = cfg.countries.map((c) => c.id);
  if (rids.size !== cfg.resources.length) err.push('resources: повторяются id');
  for (const c of cfg.countries) {
    for (const r of rids) {
      const s = c.start && c.start.resources && c.start.resources[r];
      if (!s || typeof s.B !== 'number' || typeof s.C !== 'number') err.push(`${c.id}: нет стартового значения ресурса ${r}`);
      else if (s.B < 1 || s.B > 10) err.push(`${c.id}: ресурс ${r} вне [1;10]`);
    }
    for (const s of sids) {
      const v = c.start && c.start.spheres && c.start.spheres[s];
      if (!v || typeof v.L !== 'number' || typeof v.M !== 'number') err.push(`${c.id}: нет стартового значения сферы ${s}`);
    }
    for (const o of cids) if (o !== c.id && typeof (c.relations || {})[o] !== 'number') err.push(`${c.id}: нет отношения к ${o}`);
  }
  const tids = new Set(cfg.techs.map((t) => t.id));
  const okTarget = (t) => t === 'all_spheres' || (t.startsWith('res:') && rids.has(t.slice(4))) || (t.startsWith('sph:') && sids.has(t.slice(4))) || (t.startsWith('mod:') && KNOWN_MODS.has(t.slice(4)));
  for (const t of cfg.techs) {
    for (const p of t.prereqs) if (!tids.has(p)) err.push(`tech ${t.id}: неизвестное требование ${p}`);
    for (const e of t.effects) if (!okTarget(e.target) || !['PZ', 'PP', 'MOD'].includes(e.kind)) err.push(`tech ${t.id}: неверный эффект ${JSON.stringify(e)}`);
  }
  if (cfg.blackSwans.length !== 60) err.push('blackSwans: должно быть 60 событий');
  cfg.blackSwans.forEach((s, i) => {
    if (s.id !== i + 1) err.push(`blackSwans[${i}]: id должен быть ${i + 1}`);
    if (!['global', 'national', 'bloc'].includes(s.type)) err.push(`blackSwan ${s.id}: неверный type`);
    for (const e of s.effects) if (!okTarget(e.target) || !['PZ', 'VZ', 'PP', 'VP', 'MOD'].includes(e.kind)) err.push(`blackSwan ${s.id}: неверный эффект ${JSON.stringify(e)}`);
  });
  const T = cfg.timers;
  if (!(T.turnSeconds > 0 && T.draftSeconds > 0 && T.startYear <= T.endYear)) err.push('timers: неверные значения');
  if (!cfg.limits.diffusion || !cfg.war.local || !cfg.war.totalLevels || !cfg.diplomacy.npcExchange) err.push('war/diplomacy/limits: не хватает полей');
  // v0.3 — новые ключи необязательны, но если заданы, то строго
  if (cfg.war.allowNpcTargets !== undefined && typeof cfg.war.allowNpcTargets !== 'boolean') err.push('war.allowNpcTargets: должно быть true или false');
  if (cfg.limits.draftMode !== undefined && !['random', 'pick'].includes(cfg.limits.draftMode)) err.push('limits.draftMode: допустимо "random" или "pick"');
  return err;
}
function checkConfig(cfg) {
  const errors = validateStructure(cfg), report = [];
  if (!errors.length) {
    try { E.compile(cfg); } catch (e) { errors.push(...(e.errors || [e.message])); }
  }
  if (!errors.length) {
    try { const r = SC.runChecks(cfg); report.push(...r.lines); } catch (e) { errors.push('selfcheck упал: ' + e.message); }
  }
  return { errors, report };
}

// ------------------------------------------------------------ комнаты
const rooms = new Map(); // code -> room (runtime: fx, sse)
function attachRuntime(room) {
  room.fx = E.compile(room.cfg);
  room.sse = new Map();
  return room;
}
function saveRoomsNow() {
  const out = {};
  for (const [code, r] of rooms) {
    const { fx, sse, ...plain } = r;
    out[code] = plain;
  }
  const tmp = ROOMS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out));
  fs.renameSync(tmp, ROOMS_FILE);
}
let saveTimer = null;
function persist() { if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; try { saveRoomsNow(); } catch (e) { console.error('persist:', e.message); } }, 150); }
function loadRooms() {
  if (!fs.existsSync(ROOMS_FILE)) return;
  try {
    const data = readJson(ROOMS_FILE);
    for (const code in data) rooms.set(code, attachRuntime(data[code]));
    console.log(`[rooms] восстановлено комнат: ${rooms.size}`);
  } catch (e) { console.error('[rooms] не удалось прочитать снапшот:', e.message); }
}

const normCode = (s) => String(s || '').trim().toUpperCase().replace(/Ё/g, 'Е');
function newCode() {
  const free = WORDS.map((w) => w.toUpperCase().replace(/Ё/g, 'Е')).filter((w) => !rooms.has(w));
  return free.length ? rng.pick(free) : null;
}
const newToken = () => crypto.randomBytes(16).toString('hex');

function bump(room) {
  room.version = (room.version || 0) + 1;
  const msg = `data: ${JSON.stringify({ v: room.version })}\n\n`;
  for (const set of room.sse.values()) for (const res of set) { try { res.write(msg); } catch (_) { /* закрыто */ } }
}

class ApiError extends Error { constructor(msg, code = 400) { super(msg); this.code = code; } }
const fail = (m, c) => { throw new ApiError(m, c); };

// ------------------------------------------------------------ жизненный цикл
/** v0.3: 'random' — страна выдаётся случайно, драфт превращается в экран ознакомления; 'pick' — выбор как в v0.2. */
const draftMode = (room) => (room.cfg.limits.draftMode ?? 'random');
function startDraft(room) {
  room.phase = 'draft';
  room.draft = { deadline: Date.now() + room.cfg.timers.draftSeconds * 1000, taken: {} };
  for (const p of room.players) { p.picked = null; p.ready = false; }
  if (draftMode(room) === 'random') for (const p of room.players) autoPick(room, p);
}
function takeCountry(room, p, cid) {
  if (room.draft.taken[cid]) return false;
  room.draft.taken[cid] = p.token; p.picked = cid;
  return true;
}
function checkDraftDone(room) {
  if (draftMode(room) === 'random') { if (room.players.every((p) => p.ready)) startGame(room); }
  else if (room.players.every((p) => p.picked)) startGame(room);
}
function autoPick(room, p) {
  const free = room.cfg.countries.map((c) => c.id).filter((id) => !room.draft.taken[id]);
  takeCountry(room, p, rng.pick(free));
}
function startGame(room) {
  room.phase = 'game';
  for (const p of room.players) p.country = p.picked;
  room.G = E.newGame(room.cfg, room.fx, room.players.map((p) => p.country), rng);
  room.deadline = Date.now() + room.cfg.timers.turnSeconds * 1000;
  for (const p of room.players) p.submitted = false;
  persist();
}
function resolveRoom(room) {
  const G = room.G;
  E.resolveTurn(room.cfg, room.fx, G, rng);
  for (const p of room.players) p.submitted = false;
  if (G.phase === 'finished') { room.phase = 'finished'; room.deadline = null; }
  else room.deadline = Date.now() + room.cfg.timers.turnSeconds * 1000;
  persist();
  bump(room);
}
/** Досрочно закрыть комнату: идущая игра получает итоги, лобби/драфт удаляются. */
function endRoom(room, reason) {
  if (room.phase === 'game') {
    E.finishEarly(room.cfg, room.G, reason);
    room.phase = 'finished'; room.deadline = null;
    persist(); bump(room);
  } else if (room.phase !== 'finished') {
    rooms.delete(room.code); persist();
    for (const set of room.sse.values()) for (const res of set) { try { res.end(); } catch (_) { /* */ } }
  }
}
const isOnline = (room) => room.players.some((q) => (room.sse.get(q.token) || new Set()).size > 0);
function tick() {
  const now = Date.now();
  for (const room of rooms.values()) {
    // все игроки офлайн дольше offlineEndSeconds → партия завершается
    if (room.phase !== 'finished' && !isOnline(room)) {
      room.offlineSince = room.offlineSince || now;
      if (now - room.offlineSince >= (room.cfg.timers.offlineEndSeconds ?? 30) * 1000) { endRoom(room, 'все игроки офлайн'); continue; }
    } else room.offlineSince = null;
    try {
      if (room.phase === 'draft' && now >= room.draft.deadline) {
        for (const p of room.players) if (!p.picked) autoPick(room, p);
        if (draftMode(room) === 'random') startGame(room); else checkDraftDone(room); // по таймеру старт принудительно
        persist(); bump(room);
      } else if (room.phase === 'game' && room.deadline && now >= room.deadline) resolveRoom(room);
    } catch (e) { console.error('tick error', room.code, e); }
    if (now - (room.touched || now) > 12 * 3600 * 1000) { rooms.delete(room.code); persist(); }
  }
}

// ------------------------------------------------------------ представление состояния
function clientConfig(room) {
  const cfg = room.cfg;
  const profiles = {};
  for (const c of cfg.countries) profiles[c.id] = E.profile(cfg, room.fx, c.id);
  const startRes = {};
  for (const c of cfg.countries) startRes[c.id] = c.start;
  return {
    resources: cfg.resources, spheres: cfg.spheres,
    countries: cfg.countries.map((c) => ({ id: c.id, name: c.name, iso: c.isoNumeric })),
    techs: cfg.techs.map((t) => ({ id: t.id, branch: t.branch, level: t.level, name: t.name, cost: t.cost, prereqs: t.prereqs, essence: t.essence, effectText: t.effectText })),
    swans: cfg.blackSwans.map((s) => ({ id: s.id, type: s.type, sign: s.sign, title: s.title, text: s.text })),
    ladder: cfg.ladder, timers: cfg.timers, limits: cfg.limits,
    war: { allowNpcTargets: cfg.war.allowNpcTargets ?? false },
    diplomacy: { improveCost: cfg.diplomacy.improveCost, allianceMin: cfg.diplomacy.allianceMin, npcExchange: cfg.diplomacy.npcExchange },
    profiles,
  };
}
const round3 = (x) => Math.round(x * 100) / 100; // всё до сотых

function buildState(room, p) {
  const cfg = room.cfg;
  const randomDraft = room.phase === 'draft' && draftMode(room) === 'random';
  const st = {
    v: room.version || 0, now: Date.now(),
    room: { code: room.code, phase: room.phase, deadline: room.phase === 'draft' ? room.draft.deadline : room.deadline, year: room.G ? room.G.year : null },
    me: { nick: p.nick, country: p.country || null, isHost: p.isHost, picked: !!p.picked, ready: !!p.ready, submitted: !!p.submitted },
    players: room.players.map((q) => ({
      nick: q.nick, isHost: q.isHost, connected: (room.sse.get(q.token) || new Set()).size > 0,
      ready: randomDraft ? !!q.ready : !!q.picked, submitted: !!q.submitted,
      country: room.phase === 'game' || room.phase === 'finished' ? q.country : (randomDraft ? q.picked || null : null),
    })),
  };
  if (room.phase === 'draft') st.draft = { mode: draftMode(room), taken: Object.keys(room.draft.taken), myPick: p.picked };
  if (room.G && (room.phase === 'game' || room.phase === 'finished')) {
    const G = room.G;
    const ownerOf = {};
    for (const q of room.players) ownerOf[q.country] = q.nick;
    const countries = {};
    for (const cid in G.C) {
      const C = G.C[cid], rv = E.realValues(cfg, C), res = {}, sph = {};
      for (const r of cfg.resources) res[r.id] = [round3(C.res[r.id].B), round3(C.res[r.id].C), round3(rv.res[r.id])];
      for (const s of cfg.spheres) sph[s.id] = [round3(C.sph[s.id].L), round3(C.sph[s.id].M), round3(rv.sph[s.id])];
      countries[cid] = {
        owner: ownerOf[cid] || null, isPlayer: C.isPlayer, scores: C.scores, startScores: C.startScores, res, sph, rel: C.rel,
        allies: Object.keys(C.allies), techs: Object.keys(C.techs.done),
        submitted: C.isPlayer ? !!room.players.find((q) => q.country === cid).submitted : null,
        swan: C.isPlayer ? C.swan.released : null,
      };
    }
    st.game = {
      year: G.year, countries, proposals: G.proposals.slice(-120), board: G.board, log: G.log.slice(-200), result: G.result,
    };
    if (p.country && room.phase === 'game') {
      const C = G.C[p.country];
      if (!C.techQueue) C.techQueue = [];
      G.P[p.country] = E.sanitizePlan(cfg, G, p.country, G.P[p.country]); // наука — из очереди приоритетов
      const prev = E.previewPlan(cfg, room.fx, G, p.country);
      const techInfo = {};
      for (const t of cfg.techs) {
        const n = E.techDoneCount(G, t.id, p.country);
        techInfo[t.id] = {
          done: !!C.techs.done[t.id], available: E.techAvailable(cfg, C, t), progress: round3(C.techs.prog[t.id] || 0),
          price: round3(E.techPrice(cfg, t, n)), others: n, mult: round3(E.scienceMult(cfg, C, t)),
        };
      }
      const mods = {};
      for (const k of Object.keys(C.mods)) mods[k] = C.mods[k];
      for (const e of C.active) if (e.kind === 'MOD') mods[e.target.slice(4)] = (mods[e.target.slice(4)] || 0) + e.value;
      st.me.points = C.points; st.me.plan = G.P[p.country]; st.me.preview = prev; st.me.techInfo = techInfo;
      st.me.fpSpent = C.fpSpent; st.me.swan = C.swan; st.me.mods = mods; st.me.exchange = C.exchange;
      st.me.pending = C.pending.length;
      st.me.techQueue = C.techQueue;
    }
  }
  return st;
}

// ------------------------------------------------------------ API
function getPlayer(room, token) {
  const p = room.players.find((q) => q.token === token);
  if (!p) fail('Игрок не найден в комнате', 403);
  return p;
}
function needGame(room) { if (room.phase !== 'game') fail('Игра не в фазе хода'); }
function newPlayer(nick, isHost) {
  return { token: newToken(), nick, isHost, country: null, picked: null, ready: false, submitted: false };
}
const cleanNick = (s) => String(s || '').trim().replace(/\s+/g, ' ').slice(0, 20);

const handlers = {
  create(body) {
    const nick = cleanNick(body.nick); if (!nick) fail('Введите ник');
    const code = newCode(); if (!code) fail('Нет свободных кодов комнат');
    const cfg = JSON.parse(JSON.stringify(currentCfg));
    const room = attachRuntime({ code, cfg, phase: 'lobby', players: [], created: Date.now(), touched: Date.now(), version: 1 });
    const p = newPlayer(nick, true); room.players.push(p);
    rooms.set(code, room); persist();
    return { room: code, token: p.token };
  },
  join(body) {
    const room = rooms.get(normCode(body.room)); if (!room) fail('Комната не найдена', 404);
    const nick = cleanNick(body.nick); if (!nick) fail('Введите ник');
    const same = room.players.find((q) => q.nick.toLowerCase() === nick.toLowerCase());
    if (room.phase !== 'lobby') {
      if (same) return { room: room.code, token: same.token }; // возврат в идущую игру
      fail('Игра уже началась');
    }
    if (same) fail('Этот ник уже занят в комнате');
    if (room.players.length >= room.cfg.limits.maxPlayers) fail('Комната заполнена');
    const p = newPlayer(nick, false); room.players.push(p);
    room.touched = Date.now(); persist(); bump(room);
    return { room: room.code, token: p.token };
  },
  cfg(body, room) { return clientConfig(room); },
  state(body, room, p) { return buildState(room, p); },
  start(body, room, p) {
    if (!p.isHost) fail('Только хост', 403);
    if (room.phase !== 'lobby') fail('Уже начато');
    startDraft(room); persist(); bump(room);
    return { ok: true };
  },
  draftPick(body, room, p) {
    if (room.phase !== 'draft') fail('Сейчас не драфт');
    if (draftMode(room) === 'random') fail('Страна выдана случайно');
    if (p.picked) fail('Вы уже выбрали страну');
    if (body.random) {
      const free = room.cfg.countries.map((c) => c.id).filter((id) => !room.draft.taken[id]);
      if (!free.length) fail('Нет свободных стран');
      takeCountry(room, p, rng.pick(free));
    } else {
      if (!room.cfg.countries.some((c) => c.id === body.country)) fail('Неизвестная страна');
      if (!takeCountry(room, p, body.country)) fail('Страна уже выбрана другим игроком');
    }
    checkDraftDone(room); persist(); bump(room);
    return { ok: true, country: p.picked };
  },
  draftReady(body, room, p) {
    if (room.phase !== 'draft') fail('Сейчас не драфт');
    if (draftMode(room) !== 'random') fail('В этом режиме страну нужно выбрать');
    if (!p.picked) autoPick(room, p);
    p.ready = true;
    checkDraftDone(room); persist(); bump(room);
    return { ok: true, country: p.picked };
  },
  plan(body, room, p) {
    needGame(room); if (p.submitted) fail('Ход уже сдан');
    room.G.P[p.country] = E.sanitizePlan(room.cfg, room.G, p.country, body.plan);
    return buildState(room, p);
  },
  submit(body, room, p) {
    needGame(room); if (p.submitted) return buildState(room, p);
    const G = room.G;
    G.P[p.country] = E.sanitizePlan(room.cfg, G, p.country, body.plan || G.P[p.country]);
    const v = E.validatePlan(room.cfg, G, p.country, G.P[p.country]);
    if (v.errors.length) fail('Нельзя сдать ход: ' + v.errors.join('; '));
    p.submitted = true;
    if (room.players.every((q) => q.submitted)) resolveRoom(room); else { persist(); bump(room); }
    return buildState(room, p);
  },
  endturn(body, room, p) {
    needGame(room); if (!p.isHost) fail('Только хост', 403);
    resolveRoom(room);
    return buildState(room, p);
  },
  propose(body, room, p) {
    needGame(room); if (p.submitted) fail('Ход уже сдан');
    const to = room.players.find((q) => q.country === body.to);
    if (!to) fail('Адресат — не игрок');
    const r = E.propose(room.cfg, room.G, p.country, body.to, body.type);
    if (r.error) fail(r.error);
    persist(); bump(room); return buildState(room, p);
  },
  respond(body, room, p) {
    needGame(room);
    const r = E.respond(room.cfg, room.G, p.country, Number(body.pid), !!body.accept);
    if (r.error) fail(r.error);
    persist(); bump(room); return buildState(room, p);
  },
  tradePost(body, room, p) {
    needGame(room);
    const r = E.postListing(room.cfg, room.G, p.country, body);
    if (r.error) fail(r.error);
    persist(); bump(room); return buildState(room, p);
  },
  tradeAccept(body, room, p) {
    needGame(room);
    const r = E.acceptListing(room.cfg, room.G, p.country, Number(body.id));
    if (r.error) fail(r.error);
    persist(); bump(room); return buildState(room, p);
  },
  tradeCancel(body, room, p) {
    needGame(room);
    const r = E.cancelListing(room.cfg, room.G, p.country, Number(body.id));
    if (r.error) fail(r.error);
    persist(); bump(room); return buildState(room, p);
  },
  tradeNpc(body, room, p) {
    needGame(room);
    const r = E.npcExchange(room.cfg, room.G, p.country, body.npc, body.give, body.want, body.amount);
    if (r.error) fail(r.error);
    persist(); bump(room); return buildState(room, p);
  },
  techQueue(body, room, p) {
    needGame(room); if (p.submitted) fail('Ход уже сдан');
    const r = E.setTechQueue(room.cfg, room.G, p.country, body.queue);
    if (r.error) fail(r.error);
    room.G.P[p.country] = E.sanitizePlan(room.cfg, room.G, p.country, room.G.P[p.country]);
    persist(); return buildState(room, p);
  },
  swan(body, room, p) {
    needGame(room); if (p.submitted) fail('Ход уже сдан');
    const r = E.releaseSwan(room.cfg, room.G, p.country, rng);
    if (r.error) fail(r.error);
    persist(); bump(room); return buildState(room, p);
  },
  swanPick(body, room, p) {
    needGame(room);
    const r = E.pickSwan(room.G, p.country, Number(body.index));
    if (r.error) fail(r.error);
    persist(); return buildState(room, p);
  },
};
const NO_ROOM = new Set(['create', 'join']);

const adminHandlers = {
  get() { return { config: currentCfg, tokenOk: true }; },
  validate(body) {
    let cfg = body.config;
    if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg); } catch (e) { return { ok: false, errors: ['JSON: ' + e.message], report: [] }; } }
    const r = checkConfig(cfg);
    return { ok: r.errors.length === 0, errors: r.errors, report: r.report };
  },
  save(body) {
    let cfg = body.config;
    if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg); } catch (e) { return { ok: false, errors: ['JSON: ' + e.message], report: [] }; } }
    const r = checkConfig(cfg);
    if (r.errors.length) return { ok: false, errors: r.errors, report: r.report };
    fs.writeFileSync(WORK_CFG, JSON.stringify(cfg, null, 1));
    currentCfg = cfg;
    return { ok: true, errors: [], report: r.report, saved: true };
  },
  rooms() {
    return { rooms: [...rooms.values()].map((r) => ({
      code: r.code, phase: r.phase, year: r.G ? r.G.year : null,
      players: r.players.map((q) => ({ nick: q.nick, country: q.country, online: (r.sse.get(q.token) || new Set()).size > 0 })),
    })) };
  },
  endRoom(body) {
    const room = rooms.get(normCode(body.code));
    if (!room) return { ok: false, errors: ['Комната не найдена'] };
    if (room.phase === 'finished') return { ok: false, errors: ['Партия уже завершена'] };
    endRoom(room, 'решение администратора');
    return { ok: true };
  },
  reset() {
    fs.copyFileSync(DEFAULT_CFG, WORK_CFG);
    currentCfg = readJson(WORK_CFG);
    return { ok: true, config: currentCfg };
  },
};

// ------------------------------------------------------------ HTTP
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };
function send(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(s);
}
function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new ApiError('Слишком большой запрос', 413)); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new ApiError('Неверный JSON')); } });
    req.on('error', reject);
  });
}
// Чужой service worker, оставшийся на этом origin от другого проекта, может подменять страницу
// (так было: «Could not load this space»). На запрос его скрипта отдаём «самоубийцу».
const SW_KILL = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) await caches.delete(k);
  await self.registration.unregister();
  for (const c of await self.clients.matchAll({ type: 'window' })) c.navigate(c.url);
})()));`;
const SW_NAME = /^(sw|service-?worker|serviceworker|ngsw-worker|firebase-messaging-sw|workbox-sw)\.js$/i;
function serveStatic(req, res, urlPath) {
  if (SW_NAME.test(path.basename(urlPath)) || (req.headers['service-worker'] === 'script' && !fs.existsSync(path.join(PUBLIC, path.basename(urlPath))))) {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(SW_KILL);
  }
  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath === '/admin') urlPath = '/admin.html';
  const file = path.normalize(path.join(PUBLIC, decodeURIComponent(urlPath)));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Не найдено'); }
    if (file.endsWith('.html')) {
      // версия по mtime: после правки файлов браузер гарантированно берёт свежие app.js/style.css
      const ver = (f) => { try { return Math.floor(fs.statSync(path.join(PUBLIC, f)).mtimeMs); } catch (_) { return 0; } };
      buf = Buffer.from(buf.toString('utf8').replace(/(href|src)="(app\.js|style\.css)"/g, (m, a, f) => `${a}="${f}?v=${ver(f)}"`));
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

// ───────────────────────── HTTPS в локальной сети ─────────────────────────
// Публичный CA сертификат на приватный IP не выдаст, поэтому выпускаем самоподписанный
// с IP машины в SAN — сами, при старте. Нет openssl или что-то сломалось — работаем по HTTP.
const CERT_DIR = path.join(ROOT, 'certs');
const CUSTOM_TLS = !!(process.env.TLS_KEY || process.env.TLS_CERT);
const TLS_KEY = process.env.TLS_KEY || path.join(CERT_DIR, 'server.key');
const TLS_CERT = process.env.TLS_CERT || path.join(CERT_DIR, 'server.crt');
const NO_HTTPS = /^(1|true|yes|on)$/i.test(String(process.env.NO_HTTPS || ''));
const CERT_DAYS = Number(process.env.CERT_DAYS) || 825; // больше браузеры не принимают

function lanIps() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal && !out.includes(a.address)) out.push(a.address);
  }
  return out;
}
function findOpenssl() {
  // OPENSSL задан явно — пробуем только его, без запасных путей
  const cand = process.env.OPENSSL ? [process.env.OPENSSL]
    : ['openssl', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
      'C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe', '/mingw64/bin/openssl', '/usr/bin/openssl'];
  for (const c of cand) {
    try { execFileSync(c, ['version'], { stdio: 'ignore' }); return c; } catch (_) { /* дальше */ }
  }
  return null;
}
function sanSpec(ips) {
  const host = String(os.hostname() || 'localhost').split('.')[0];
  const lc = host.toLowerCase();
  const names = [...new Set(['localhost', lc, host, `${lc}.local`, `${host}.local`])];
  const san = [...names.map((n) => `DNS:${n}`), 'IP:127.0.0.1', ...ips.map((ip) => `IP:${ip}`)];
  const extra = String(process.env.EXTRA_SAN || '').trim();
  if (extra) san.push(...extra.split(',').map((s) => s.trim()).filter(Boolean));
  return { host: lc, san: [...new Set(san)].join(',') };
}
const certSan = (openssl, file) => {
  try { return execFileSync(openssl, ['x509', '-noout', '-ext', 'subjectAltName', '-in', file], { encoding: 'utf8' }); }
  catch (_) { return ''; }
};
const fingerprint = (openssl, file) => {
  try {
    return execFileSync(openssl, ['x509', '-noout', '-fingerprint', '-sha256', '-in', file], { encoding: 'utf8' }).split('=').slice(1).join('=').trim();
  } catch (_) { return '?'; }
};
function issueCert(openssl, ips) {
  const { host, san } = sanSpec(ips);
  fs.mkdirSync(CERT_DIR, { recursive: true });
  execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', String(CERT_DAYS),
    '-keyout', TLS_KEY, '-out', TLS_CERT, '-subj', `/CN=${host}`,
    '-addext', `subjectAltName=${san}`,
    '-addext', 'basicConstraints=critical,CA:FALSE',
    '-addext', 'keyUsage=critical,digitalSignature,keyEncipherment',
    '-addext', 'extendedKeyUsage=serverAuth'],
  { stdio: 'ignore', env: { ...process.env, MSYS2_ARG_CONV_EXCL: '*', MSYS_NO_PATHCONV: '1' } });
  try { fs.chmodSync(TLS_KEY, 0o600); } catch (_) { /* неважно */ }
  return san;
}
/** @returns {{key:Buffer,cert:Buffer}|null} — null означает «работаем только по HTTP». */
function ensureCert({ force = false } = {}) {
  if (NO_HTTPS) return null;
  const have = fs.existsSync(TLS_KEY) && fs.existsSync(TLS_CERT);
  if (CUSTOM_TLS) { // свои файлы не трогаем никогда
    if (have) return { key: fs.readFileSync(TLS_KEY), cert: fs.readFileSync(TLS_CERT) };
    console.log(`[tls] не найдены TLS_KEY/TLS_CERT (${TLS_KEY}), HTTPS отключён`);
    return null;
  }
  const openssl = findOpenssl();
  if (!openssl) {
    if (have) return { key: fs.readFileSync(TLS_KEY), cert: fs.readFileSync(TLS_CERT) };
    console.log(`[tls] openssl не найден, HTTPS отключён, игра доступна по http://localhost:${PORT}`);
    return null;
  }
  try {
    const ips = lanIps();
    let why = '';
    if (force) why = 'перевыпуск по --regen-cert';
    else if (!have) why = 'сертификата не было';
    else {
      const san = certSan(openssl, TLS_CERT);
      const miss = ips.filter((ip) => !san.includes(`IP Address:${ip}`));
      if (!san) why = 'сертификат нечитаем';
      else if (miss.length) why = `IP машины сменился (нет в SAN: ${miss.join(', ')})`;
    }
    if (why) {
      const san = issueCert(openssl, ips);
      console.log(`[tls] сертификат выпущен (${why}); SAN: ${san}`);
      console.log(`[tls] SHA-256: ${fingerprint(openssl, TLS_CERT)}`);
    }
    return { key: fs.readFileSync(TLS_KEY), cert: fs.readFileSync(TLS_CERT) };
  } catch (e) {
    console.log(`[tls] не удалось выпустить сертификат (${e.message.split('\n')[0]}), работаем по HTTP`);
    return have ? { key: fs.readFileSync(TLS_KEY), cert: fs.readFileSync(TLS_CERT) } : null;
  }
}

// Один обработчик — два слушателя (http + https).
async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/events') {
      const room = rooms.get(normCode(url.searchParams.get('room')));
      const p = room && room.players.find((q) => q.token === url.searchParams.get('token'));
      if (!p) { res.writeHead(403); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`retry: 2000\ndata: ${JSON.stringify({ v: room.version })}\n\n`);
      if (!room.sse.has(p.token)) room.sse.set(p.token, new Set());
      room.sse.get(p.token).add(res);
      bump(room);
      req.on('close', () => { const s = room.sse.get(p.token); if (s) { s.delete(res); if (!s.size) room.sse.delete(p.token); } bump(room); });
      return;
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/admin/')) {
      const body = await readBody(req);
      if (body.token !== ADMIN_TOKEN) return send(res, 403, { error: 'Неверный админ-токен' });
      const h = adminHandlers[url.pathname.slice('/api/admin/'.length)];
      if (!h) return send(res, 404, { error: 'Нет такого метода' });
      return send(res, 200, h(body));
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      const name = url.pathname.slice(5);
      const h = handlers[name];
      if (!h) return send(res, 404, { error: 'Нет такого метода' });
      const body = await readBody(req);
      if (NO_ROOM.has(name)) return send(res, 200, h(body));
      const room = rooms.get(normCode(body.room));
      if (!room) return send(res, 404, { error: 'Комната не найдена' });
      const p = getPlayer(room, body.token);
      room.touched = Date.now();
      return send(res, 200, h(body, room, p));
    }
    if (req.method === 'GET') return serveStatic(req, res, url.pathname);
    res.writeHead(405); res.end();
  } catch (e) {
    if (e instanceof ApiError) return send(res, e.code, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Внутренняя ошибка: ' + e.message });
  }
}

const server = http.createServer(handleRequest);

if (require.main === module) {
  if (process.argv.includes('--regen-cert')) { // ручной перевыпуск, без запуска сервера
    process.exit(ensureCert({ force: true }) ? 0 : 1);
  }
  loadWorkingConfig();
  loadRooms();
  setInterval(tick, 1000); // таймеры и persist — общие на процесс, второй слушатель их не дублирует
  setInterval(() => { for (const r of rooms.values()) for (const set of r.sse.values()) for (const res of set) { try { res.write(': ping\n\n'); } catch (_) { /* */ } } }, 20000);
  const tls = ensureCert();
  server.listen(PORT, () => {
    console.log(`«Глобальный ИИ»: http://localhost:${PORT}   админка: http://localhost:${PORT}/admin`);
    if (!tls) for (const ip of lanIps()) console.log(`  по сети:  http://${ip}:${PORT}/`);
  });
  if (tls) {
    const secure = https.createServer(tls, handleRequest);
    secure.on('error', (e) => console.log(`[tls] HTTPS не поднялся на ${HTTPS_PORT} (${e.code || e.message}), HTTP работает`));
    secure.listen(HTTPS_PORT, () => {
      console.log(`  https:    https://localhost:${HTTPS_PORT}/`);
      for (const ip of lanIps()) console.log(`  с телефона: https://${ip}:${HTTPS_PORT}/   (самоподписанный — принять предупреждение)`);
    });
  }
}
module.exports = { server, ensureCert };
