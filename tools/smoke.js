'use strict';
/**
 * Smoke-прогон: поднимает сервер, сажает за стол двух ботов (tools/bot.js) и ждёт конца партии.
 *   node tools/smoke.js                       # свой сервер на свободном порту
 *   BASE=http://localhost:3111 node tools/smoke.js   # на уже запущенном
 * Таймеры не трогаем: боты сдают ход сразу, год закрывается по «все сдали».
 */
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { startBot, api } = require('./bot.js');

const ROOT = path.join(__dirname, '..');
const ROOMS = path.join(ROOT, 'data', 'rooms.json');
const BUDGET_MS = 90000;
let fails = 0;
const ok = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const f2 = (x) => (Math.round(x * 100) / 100).toFixed(2);

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
async function waitUp(base, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(base + '/'); if (r.status) return true; } catch (_) { /* ещё не слушает */ }
    await sleep(200);
  }
  return false;
}
const withTimeout = (p, ms, msg) => Promise.race([p, sleep(ms).then(() => { throw new Error(msg); })]);

(async () => {
  let child = null, base = process.env.BASE || null, stderr = '', roomsBackup = null;
  if (!base) {
    roomsBackup = fs.existsSync(ROOMS) ? fs.readFileSync(ROOMS) : null;
    const port = await freePort();
    base = `http://localhost:${port}`;
    child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), ADMIN_TOKEN: 'test' } });
    child.stdout.on('data', () => {});
    child.stderr.on('data', (c) => { stderr += String(c); });
    ok(await waitUp(base, 10000), `сервер поднят на ${base}`);
  } else ok(true, `используется запущенный сервер ${base}`);

  const stop = () => {
    if (child && child.exitCode === null) child.kill();
    if (roomsBackup !== null) fs.writeFileSync(ROOMS, roomsBackup);
    else if (child && fs.existsSync(ROOMS)) fs.unlinkSync(ROOMS);
  };

  try {
    const b1 = startBot({ base, nick: 'Бот-1', create: true, autostart: 2, pollMs: 400 });
    for (let i = 0; i < 100 && !b1.room; i++) await sleep(100);
    if (!b1.room) throw new Error('первый бот не создал комнату');
    const b2 = startBot({ base, nick: 'Бот-2', room: b1.room, pollMs: 400 });

    await withTimeout(Promise.all([b1.promise, b2.promise]), BUDGET_MS,
      `партия не завершилась за ${BUDGET_MS / 1000} с (фазы: ${[b1, b2].map((b) => b.state && b.state.room.phase + '@' + (b.state.room.year || '-')).join(', ')})`);

    const st = b1.state, res = (st.game && st.game.result) || {};
    ok(b1.country && b2.country && b1.country !== b2.country, `разные страны: ${b1.country} и ${b2.country}`);
    ok(st.room.phase === 'finished', `партия завершена, фаза ${st.room.phase}`);
    ok(res.type !== 'early' && st.room.year >= 2040, `дошли до конца: год ${st.room.year}, итог «${res.typeName}», победитель ${res.winner}`);

    for (const row of res.table || []) ok(row.finalSum >= row.startSum, `${row.cid}: очки ${f2(row.startSum)} → ${f2(row.finalSum)} (${row.delta >= 0 ? '+' : ''}${f2(row.delta)}), технологий ${row.techs}`);
    ok((res.table || []).length === 2, 'в итоговой таблице обе страны');

    const cfg = await api(base, 'cfg', { room: b1.room, token: b1.token });
    const players = new Set([b1.country, b2.country]);
    const npcNames = cfg.countries.filter((c) => !players.has(c.id)).map((c) => c.name);
    const log = [...b1.log, ...b2.log].filter((e, i, a) => a.findIndex((x) => x.id === e.id) === i);
    const npcWars = log.filter((e) => e.kind === 'war' && npcNames.some((n) => e.text.includes(n)));
    ok(npcWars.length === 0, `войн против NPC нет (всего военных записей ${log.filter((e) => e.kind === 'war').length})`);
    ok(log.length > 10, `лог собран: ${log.length} записей`);

    if (child) {
      const crash = /Внутренняя ошибка|tick error|at [A-Za-z]+ \(/.test(stderr);
      ok(child.exitCode === null && !crash, 'сервер жив, необработанных ошибок нет' + (crash ? ':\n' + stderr.slice(0, 600) : ''));
      const closed = new Promise((r) => child.once('exit', r));
      child.kill();
      ok(await withTimeout(closed.then(() => true), 5000, 'сервер не погас').catch((e) => { console.log(e.message); return false; }), 'сервер корректно погашен');
    }
  } catch (e) {
    ok(false, 'прогон: ' + e.message);
  } finally { stop(); }

  console.log(fails ? `\n${fails} FAIL` : '\nвсе проверки пройдены');
  process.exit(fails ? 1 : 0);
})();
