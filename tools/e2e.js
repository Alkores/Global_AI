'use strict';
// Сквозной сценарий: сервер должен быть запущен (BASE=http://localhost:3111 ADMIN_TOKEN=test node tools/e2e.js)
const http = require('http');
const BASE = process.env.BASE || 'http://localhost:3111';
const ADMIN = process.env.ADMIN_TOKEN || 'test';
let fails = 0;
const ok = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) fails++; };
async function api(name, body, admin) {
  const r = await fetch(`${BASE}/api/${admin ? 'admin/' : ''}${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
}
const expectErr = async (name, body, msg) => { const r = await api(name, body); ok(r.status >= 400 && r.data.error, `${msg} → «${r.data.error}»`); };

(async () => {
  // SSE
  let sseEvents = 0;
  const A = await api('create', { nick: 'Алиса' });
  ok(A.status === 200 && /^[А-Я]{5}$/.test(A.data.room), `комната создана, код ${A.data.room}`);
  const code = A.data.room, ta = A.data.token;
  const B = await api('join', { room: code.toLowerCase(), nick: 'Боб' });
  ok(B.status === 200, 'Боб вошёл по коду (регистр не важен)');
  const tb = B.data.token;
  await expectErr('join', { room: code, nick: 'Боб' }, 'дубль ника отклонён');
  await expectErr('join', { room: 'ЯЯЯЯЯ', nick: 'Х' }, 'неверный код отклонён');
  const sse = http.get(`${BASE}/events?room=${code}&token=${ta}`, (res) => { res.on('data', (c) => { if (String(c).includes('data:')) sseEvents++; }); });
  await expectErr('start', { room: code, token: tb }, 'не-хост не может начать');
  let s = (await api('start', { room: code, token: ta })).data;
  ok(s.ok, 'хост нажал «Все здесь» → драфт');
  const cfg = (await api('cfg', { room: code, token: ta })).data;
  ok(cfg.countries.length === 16 && cfg.techs.length === 40 && cfg.profiles.usa.desc.length > 20, 'cfg: 16 стран, 40 технологий, профили для драфта');
  // v0.3: страны раздаются случайно, драфт — экран ознакомления с кнопкой «Готов»
  ok(cfg.limits.draftMode === 'random' && cfg.war.allowNpcTargets === false, 'конфиг v0.3: draftMode=random, allowNpcTargets=false');
  let st = (await api('state', { room: code, token: ta })).data;
  const ac = st.draft.myPick;
  ok(!!ac && st.draft.mode === 'random', `Алисе случайно выдана страна: ${ac}`);
  st = (await api('state', { room: code, token: tb })).data;
  const bc = st.draft.myPick;
  ok(!!bc && bc !== ac && st.draft.taken.length === 2, `Бобу выдана другая страна: ${bc}`);
  await expectErr('draftPick', { room: code, token: ta, country: ac }, 'ручной выбор страны запрещён');
  ok((await api('draftReady', { room: code, token: ta })).data.ok, 'Алиса нажала «Готов»');
  st = (await api('state', { room: code, token: tb })).data;
  ok(st.room.phase === 'draft' && st.players.some((p) => p.nick === 'Алиса' && p.ready), 'игра ждёт готовности Боба');
  ok((await api('draftReady', { room: code, token: tb })).data.ok, 'Боб нажал «Готов»');
  st = (await api('state', { room: code, token: ta })).data;
  ok(st.room.phase === 'game' && st.game.year === 2026, 'все готовы → старт 2026');
  ok(st.me.country === ac && st.me.points.ai > 0 && st.me.points.science > 0, `Алиса играет за ${ac}, очки ИИ = ${st.me.points.ai.toFixed(2)}`);
  const npcs = Object.keys(st.game.countries).filter((id) => !st.game.countries[id].isPlayer);
  const [n1, n2] = npcs;
  const sciPts = st.me.points.science;

  // планы
  const planA = { transform: { energy: { v: 2, p: 1 } }, ai: { cognition: 3, production: 2 },
    fp: { improve: { [n1]: 1, [n2]: 2 }, attack: { [bc]: { ares: 2, athena: 1, apollo: 1 } }, defense: { ares: 1, athena: 0, apollo: 0 } } };
  let r = await api('plan', { room: code, token: ta, plan: planA });
  ok(r.status === 200 && r.data.me.preview.errors.length === 0, 'план Алисы принят без ошибок: ' + JSON.stringify(r.data.me.preview.errors));
  ok(r.data.me.preview.next.res.energy.B > 0 && r.data.me.preview.chances[n1].R > 0, 'предпросмотр и шансы NPC посчитаны сервером');
  ok(Object.keys(r.data.me.plan.fp.attack).join() === bc, `атака принята только по стране-игроку (${bc})`);
  r = await api('plan', { room: code, token: ta, plan: { ...planA, fp: { ...planA.fp, attack: { [n1]: { ares: 5, athena: 0, apollo: 0 } } } } });
  ok(Object.keys(r.data.me.plan.fp.attack).length === 0, `v0.3: атака по NPC (${n1}) отброшена`);
  r = await api('plan', { room: code, token: tb, plan: { transform: { energy: { v: 9999, p: 0 } } } });
  ok(r.data.me.preview.errors.length > 0, 'перерасход очков → ошибка в предпросмотре');
  await expectErr('submit', { room: code, token: tb }, 'сдать ход с ошибками нельзя');
  r = await api('plan', { room: code, token: tb, plan: { transform: { energy: { v: 1, p: 1 } }, ai: { war: 1 }, fp: { defense: { ares: 1, athena: 1, apollo: 1 } } } });
  ok(r.data.me.preview.errors.length === 0, 'план Боба исправлен');
  r = await api('techQueue', { room: code, token: ta, queue: ['C6'] });
  ok(Object.keys(r.data.me.plan.science).length === 0, 'закрытая C6 в очереди не получает очков');
  r = await api('techQueue', { room: code, token: ta, queue: ['C1', 'M1', 'D1', 'BAD'] });
  const firstSci = Math.min(r.data.me.techInfo.C1.price, Math.round(sciPts * 100) / 100);
  ok(r.data.me.techQueue.join() === 'C1,M1,D1' && Math.abs(r.data.me.plan.science.C1 - firstSci) < 0.02, `очередь C1→M1→D1: на C1 ушло ${r.data.me.plan.science.C1} из ${sciPts.toFixed(2)}`);
  r = await api('techQueue', { room: code, token: tb, queue: ['M1'] });
  ok(r.data.me.plan.science.M1 > 0, 'Боб: очередь M1');
  await api('plan', { room: code, token: ta, plan: planA });

  // предложения
  r = await api('propose', { room: code, token: ta, to: bc, type: 'improve' });
  ok(r.status === 200, 'Алиса предложила повышение отношений Бобу (−5 очков ВП)');
  const pid = r.data.game.proposals[r.data.game.proposals.length - 1].id;
  st = (await api('state', { room: code, token: tb })).data;
  ok(st.game.proposals.some((p) => p.id === pid && p.status === 'pending' && p.to === bc), 'Боб видит предложение «На рассмотрении»');
  ok((await api('respond', { room: code, token: tb, pid, accept: true })).status === 200, 'Боб принял');
  await expectErr('respond', { room: code, token: ta, pid, accept: true }, 'чужое предложение обработать нельзя');
  r = await api('propose', { room: code, token: ta, to: bc, type: 'alliance' });
  ok(r.status === 200 || /отношени/.test(r.data.error), 'союз: ' + (r.data.error || 'предложение отправлено (отношения > 1)'));

  // торговля
  const cs = (await api('state', { room: code, token: ta })).data.game.countries;
  const ids = Object.keys(cs[ac].res);
  const X = ids.find((i) => cs[ac].res[i][0] >= 1.5 && cs[bc].res[i][0] <= 9);
  const Y = ids.find((i) => i !== X && cs[bc].res[i][0] >= 1.5 && cs[ac].res[i][0] <= 9);
  r = await api('tradePost', { room: code, token: ta, give: { res: { [X]: 0.5 } }, want: { res: { [Y]: 0.3 } }, years: 2 });
  ok(r.status === 200, 'объявление размещено');
  const lid = r.data.game.board[r.data.game.board.length - 1].id;
  const before = cs[bc].res[Y][0];
  r = await api('tradeAccept', { room: code, token: tb, id: lid });
  ok(r.status === 200 && Math.abs(r.data.game.countries[bc].res[Y][0] - (before - 0.3)) < 1e-6, `Боб принял сделку (${r.data.error || 'ok'})`);
  await expectErr('tradeAccept', { room: code, token: tb, id: lid }, 'повторное принятие отклонено');
  const nx = npcs.find((id) => cs[ac].rel[id] >= (cfg.diplomacy.npcExchange.minRelation ?? 0) && cs[id].res.water[0] >= 1.5) || n1;
  r = await api('tradeNpc', { room: code, token: ta, npc: nx, give: 'devices', want: 'water', amount: 0.5 });
  ok(r.status === 200, `обмен с NPC ${nx} 2:1 (${r.data.error || 'ok'})`);

  // лебедь
  r = await api('swan', { room: code, token: ta });
  ok(r.status === 200 && r.data.game.log.some((l) => l.text.includes('выпустила чёрного лебедя')), 'лебедь выпущен, уведомление в логе');
  await expectErr('swan', { room: code, token: ta }, 'второй лебедь за ход запрещён');

  // сдача хода
  r = await api('submit', { room: code, token: ta });
  ok(r.data.me.submitted, 'Алиса сдала ход');
  r = await api('submit', { room: code, token: tb });
  ok(r.data.game.year === 2027, `оба сдали → разрешение хода, год ${r.data.game.year}`);
  const g = r.data.game;
  ok(g.proposals.find((p) => p.id === pid).status === 'accepted', 'предложение осталось «Принято»');
  ok(g.log.some((l) => l.kind === 'war') && g.log.some((l) => l.kind === 'swan' && l.text.includes('№')), 'в логе война и результат лебедя');
  ok(g.countries[ac].techs.length >= 1, `${ac} изучила технологии по очереди: ` + g.countries[ac].techs.join(','));
  console.log('   лог:', g.log.slice(-6).map((l) => l.text.split('\n')[0]).join(' | '));

  // 2027: второй ход через «Завершить ход» хоста
  await api('techQueue', { room: code, token: ta, queue: ['C2'] });
  await api('plan', { room: code, token: ta, plan: { ai: { economy: 10 } } });
  r = await api('endturn', { room: code, token: ta });
  ok(r.data.game.year === 2028, 'хост завершил ход 2027 досрочно');
  st = (await api('state', { room: code, token: tb })).data;
  ok(st.me.submitted === false, 'после хода флаги сдачи сброшены');

  ok(sseEvents >= 3, `SSE доставил события: ${sseEvents}`);
  sse.destroy();

  // админка
  let a = await api('get', { token: 'bad' }, true); ok(a.status === 403, 'админка: неверный токен → 403');
  a = await api('get', { token: ADMIN }, true); ok(a.data.config && a.data.config.techs.length === 40, 'админка: конфиг получен');
  const bad = JSON.parse(JSON.stringify(a.data.config)); bad.formulas.fp = 'return (((';
  let v = await api('validate', { token: ADMIN, config: bad }, true); ok(!v.data.ok && v.data.errors.length, 'админка: ошибка компиляции формулы возвращена');
  v = await api('validate', { token: ADMIN, config: a.data.config }, true); ok(v.data.ok && v.data.report.length > 10, `админка: проверка прошла (${v.data.report.length} строк отчёта)`);
  v = await api('save', { token: ADMIN, config: a.data.config }, true); ok(v.data.saved, 'админка: сохранено');
  v = await api('reset', { token: ADMIN }, true); ok(v.data.ok, 'админка: сброс к умолчанию');

  // статика
  for (const f of ['/', '/app.js', '/style.css', '/admin']) { const x = await fetch(BASE + f); ok(x.status === 200, `GET ${f} → ${x.status}`); }

  console.log(fails ? `\nОШИБОК: ${fails}` : '\nE2E: ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
