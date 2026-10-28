'use strict';
/**
 * Простой ИИ-игрок для «Глобального ИИ» (правила v0.3).
 * Headless-клиент: ходит через тот же HTTP API, что и браузер, сервер и движок не трогает.
 *
 *   node tools/bot.js --room КОД [--nick Бот] [--base http://localhost:3000]
 *   node tools/bot.js --create            # сам создаёт комнату, печатает код и ждёт
 *   node tools/bot.js --create --autostart 2   # (для smoke) хост стартует, когда в лобби N игроков
 *
 * Цикл: опрос /api/state раз в секунду. SSE открывается только для того, чтобы сервер
 * считал бота онлайн (иначе комната гасится по offlineEndSeconds).
 */
const http = require('http');

// ------------------------------------------------------------------ транспорт
async function api(base, name, body) {
  const r = await fetch(`${base}/api/${name}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({ error: 'не JSON' }));
  if (r.status >= 400) { const e = new Error(data.error || `HTTP ${r.status}`); e.status = r.status; throw e; }
  return data;
}
/** Держим SSE-соединение: сервер определяет «онлайн» именно по нему. */
function keepAlive(base, room, token) {
  const u = new URL(`${base}/events?room=${encodeURIComponent(room)}&token=${token}`);
  const req = http.get(u, (res) => { res.on('data', () => {}); res.on('error', () => {}); });
  req.on('error', () => {});
  return req;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const f2 = (x) => (Math.round(x * 100) / 100).toFixed(2);
const floor2 = (x) => Math.floor(Math.max(0, x) * 100) / 100;

// ------------------------------------------------------------------ стратегия
// ponytail: greedy, без поиска по дереву
/** Весь «интеллект» бота: по состоянию строит очередь технологий и план хода. */
function think(cfg, st) {
  const me = st.me, mine = st.game.countries[me.country], pts = me.points;

  // трансформация: 3 самых слабых ресурса по реальному значению, 70% в значение, 30% в прирост
  const transform = {};
  const weakRes = cfg.resources.map((r) => r.id).sort((a, b) => mine.res[a][2] - mine.res[b][2]).slice(0, 3);
  const trShare = floor2(pts.transform / weakRes.length);
  for (const id of weakRes) {
    const v = floor2(trShare * 0.7), p = floor2(trShare * 0.3);
    if (v || p) transform[id] = { v, p };
  }

  // ИИ: 3 самые слабые сферы поровну
  const ai = {};
  const weakSph = cfg.spheres.map((s) => s.id).sort((a, b) => mine.sph[a][2] - mine.sph[b][2]).slice(0, 3);
  const aiShare = floor2(pts.ai / weakSph.length);
  for (const id of weakSph) if (aiShare) ai[id] = aiShare;

  // наука: все доступные технологии по возрастанию цены (сервер сам распределит очки по очереди)
  const queue = cfg.techs
    .filter((t) => me.techInfo[t.id] && me.techInfo[t.id].available)
    .sort((a, b) => me.techInfo[a.id].price - me.techInfo[b.id].price)
    .map((t) => t.id);

  // внешняя политика: 20% в оборону, остальное — на отношения с 3 худшими NPC.
  // Атак нет вовсе: по NPC они запрещены правилами v0.3, а живых игроков бот принципиально не трогает.
  const fpBudget = Math.max(0, pts.fp - (me.fpSpent || 0));
  const dShare = floor2(fpBudget * 0.2 / 3);
  const defense = { ares: dShare, athena: dShare, apollo: dShare };
  const improve = {};
  const npcs = Object.keys(st.game.countries)
    .filter((id) => id !== me.country && !st.game.countries[id].isPlayer)
    .sort((a, b) => mine.rel[a] - mine.rel[b]).slice(0, 3);
  const impShare = floor2((fpBudget - dShare * 3) / (npcs.length || 1));
  for (const id of npcs) if (impShare) improve[id] = impShare;

  return { queue, plan: { transform, ai, fp: { improve, attack: {}, defense, downgrade: [], breakAlliance: [] } } };
}

// ------------------------------------------------------------------ бот
function startBot(opts) {
  const base = opts.base || 'http://localhost:3000';
  const nick = opts.nick || 'Бот';
  const say = (m) => { if (opts.quiet !== true) console.log(`[${nick}] ${m}`); };
  const handle = { nick, base, room: null, token: null, country: null, state: null, log: [], done: false };

  handle.promise = (async () => {
    const auth = opts.create ? await api(base, 'create', { nick }) : await api(base, 'join', { room: opts.room, nick });
    handle.room = auth.room; handle.token = auth.token;
    say(opts.create ? `комната создана: ${auth.room}` : `вошёл в комнату ${auth.room}`);
    const sse = keepAlive(base, handle.room, handle.token);
    let cfg = null, lastYear = null, started = false;
    try {
      for (let i = 0; i < (opts.maxTicks || 3000); i++) {
        let st;
        try { st = await api(base, 'state', { room: handle.room, token: handle.token }); }
        catch (e) { say('опрос состояния: ' + e.message); await sleep(1000); continue; }
        handle.state = st;
        if (st.game) for (const e of st.game.log) if (!handle.log.some((x) => x.id === e.id)) handle.log.push(e);

        if (st.room.phase === 'lobby') {
          // хост сам игру не начинает — ждёт указания (кроме явного --autostart для тестов)
          if (opts.autostart && st.me.isHost && st.players.length >= opts.autostart && !started) {
            started = true; say('все на месте, стартую'); try { await api(base, 'start', { room: handle.room, token: handle.token }); } catch (e) { say('старт: ' + e.message); started = false; }
          }
        } else if (st.room.phase === 'draft') {
          if (!st.me.ready) {
            say(`страна: ${st.draft.myPick} — готов`);
            try { await api(base, 'draftReady', { room: handle.room, token: handle.token }); } catch (e) { say('готовность: ' + e.message); }
          }
        } else if (st.room.phase === 'game') {
          if (!cfg) cfg = await api(base, 'cfg', { room: handle.room, token: handle.token });
          handle.country = st.me.country;
          if (!st.me.submitted) {
            // входящие предложения отношений/союза принимаются автоматически — они бесплатны для адресата
            for (const pr of st.game.proposals) {
              if (pr.status === 'pending' && pr.to === st.me.country) {
                try { await api(base, 'respond', { room: handle.room, token: handle.token, pid: pr.id, accept: true }); say(`принял предложение №${pr.id} (${pr.type})`); } catch (e) { say('ответ на предложение: ' + e.message); }
              }
            }
            const { queue, plan } = think(cfg, st);
            try {
              if (queue.length) await api(base, 'techQueue', { room: handle.room, token: handle.token, queue });
              const after = await api(base, 'plan', { room: handle.room, token: handle.token, plan });
              if (after.me.preview.errors.length) { say('план с ошибками: ' + after.me.preview.errors.join('; ')); await sleep(1000); continue; }
              await api(base, 'submit', { room: handle.room, token: handle.token });
            } catch (e) { say('сдача хода: ' + e.message); await sleep(1000); continue; }
            if (st.room.year !== lastYear) {
              lastYear = st.room.year;
              const s = st.game.countries[st.me.country].scores;
              say(`${st.room.year} ${st.me.country}: ИИ ${f2(s.ai)} / наука ${f2(s.science)} / ВП ${f2(s.fp)} / трансф. ${f2(s.transform)}`
                + ` → ресурсы ${Object.keys(plan.transform).join(',')}; сферы ${Object.keys(plan.ai).join(',')};`
                + ` техи ${queue.slice(0, 3).join(',') || '—'}; отношения ${Object.keys(plan.fp.improve).join(',') || '—'}`);
            }
          }
        } else if (st.room.phase === 'finished') {
          const res = st.game.result || {}, r = res.table || [];
          say(`партия окончена: победитель ${res.winner || '—'} (${res.typeName || '—'}), год ${st.room.year}`);
          for (const row of r) say(`  ${row.cid}: ${f2(row.startSum)} → ${f2(row.finalSum)} (${row.delta >= 0 ? '+' : ''}${f2(row.delta)}), технологий ${row.techs}`);
          handle.done = true;
          return st;
        }
        await sleep(opts.pollMs || 1000);
      }
      throw new Error('бот исчерпал лимит тактов, партия не завершилась');
    } finally { try { sse.destroy(); } catch (_) { /* */ } }
  })();
  return handle;
}

// ------------------------------------------------------------------ CLI
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--create') o.create = true;
    else if (a === '--room') o.room = argv[++i];
    else if (a === '--nick') o.nick = argv[++i];
    else if (a === '--base') o.base = argv[++i];
    else if (a === '--autostart') o.autostart = Number(argv[++i]);
  }
  return o;
}
if (require.main === module) {
  const o = parseArgs(process.argv.slice(2));
  if (!o.create && !o.room) { console.error('Укажите --room КОД или --create'); process.exit(2); }
  startBot(o).promise.then(() => process.exit(0), (e) => { console.error('Бот остановлен: ' + e.message); process.exit(1); });
}
module.exports = { startBot, think, api };
