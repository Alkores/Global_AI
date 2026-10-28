'use strict';
// Самопроверка движка: node tools/selfcheck.js
const fs = require('fs');
const path = require('path');
const E = require('../engine.js');

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/** Сверка формул и перехода года с Excel (США). Возвращает {ok, lines}. Используется и админкой. */
function excelCheck(cfg, fx) {
  const lines = []; let ok = true;
  const say = (good, msg) => { lines.push((good ? 'OK   ' : 'FAIL ') + msg); if (!good) ok = false; };
  const ex = cfg.selfcheck;
  if (!ex) return { ok: true, lines: ['(нет эталона selfcheck в конфиге)'] };
  const usa = E.newCountryState(cfg, 'usa');
  const sc = E.scoresOf(cfg, fx, usa, false);
  for (const [k, label] of [['ai', 'ИИ'], ['science', 'наука'], ['fp', 'ВП'], ['transform', 'трансформация']])
    say(near(sc[k], ex.usa2026[k], 1e-6), `США 2026, ${label} без нормировки: ${sc[k].toFixed(4)} (Excel ${ex.usa2026[k].toFixed(4)})`);
  const scn = E.scoresOf(cfg, fx, usa, true);
  say(scn.ai >= sc.ai && scn.science >= sc.science, `нормировка не уменьшает: ИИ ${scn.ai.toFixed(2)}, наука ${scn.science.toFixed(2)}`);
  // переход года при нулевых вложениях
  const plan = E.emptyPlan();
  const next = E.transitionCountry(cfg, fx, usa, plan, true);
  let bad = 0;
  for (const id in ex.usa2027.res) {
    if (!near(next.res[id].B, ex.usa2027.res[id].B, 1e-9) || !near(next.res[id].C, ex.usa2027.res[id].C, 1e-9)) { bad++; lines.push(`   расхождение ресурса ${id}: ${JSON.stringify(next.res[id])} vs ${JSON.stringify(ex.usa2027.res[id])}`); }
  }
  for (const id in ex.usa2027.sph)
    if (!near(next.sph[id].L, ex.usa2027.sph[id].L, 1e-9) || !near(next.sph[id].M, ex.usa2027.sph[id].M, 1e-9)) { bad++; lines.push(`   расхождение сферы ${id}`); }
  say(bad === 0, `Переход 2026→2027 (США, нулевые вложения): 43 ресурса и 8 сфер совпали с листом «США 2027» (B'=B+C)`);
  // максимум = 100
  const full = E.newCountryState(cfg, 'usa');
  for (const r of cfg.resources) full.res[r.id].B = 10;
  for (const s of cfg.spheres) full.sph[s.id].L = 10;
  const mx = E.scoresOf(cfg, fx, full, true);
  say(near(mx.ai, 100, 1e-6) && near(mx.science, 100, 1e-6), `при всех значениях 10: ИИ=${mx.ai.toFixed(4)}, наука=${mx.science.toFixed(4)} (нормировка → 100)`);
  return { ok, lines };
}

function runChecks(cfg) {
  const lines = []; let ok = true;
  const say = (good, msg) => { lines.push((good ? 'OK   ' : 'FAIL ') + msg); if (!good) ok = false; };
  let fx;
  try { fx = E.compile(cfg); say(true, 'формулы скомпилированы'); } catch (e) { return { ok: false, lines: ['FAIL ' + e.message] }; }
  const x = excelCheck(cfg, fx); ok = ok && x.ok; lines.push(...x.lines);

  const newG = (players = ['usa', 'china']) => E.newGame(cfg, fx, players, E.seededRng(1));
  const turn = (G, seed = 7, rngOverride) => E.resolveTurn(cfg, fx, G, rngOverride || E.seededRng(seed));

  // --- постоянный эффект суммируется 3 года подряд (регрессия на главную жалобу)
  {
    const G = newG();
    const U = G.C.usa;
    U.res.dc.B = 5; U.res.dc.C = 0.1; U.res.compute.B = 5; U.res.compute.C = 0.1;
    G.C.usa.techQueue = ['C1'];
    const b0 = U.res.compute.B, c0 = U.res.dc.C, bdc0 = U.res.dc.B;
    turn(G, 1);
    say(!!U.techs.done.C1, 'технология C1 изучена после вложения 20');
    // C1: Вычислительные компоненты ПЗ +0,2; ЦОД ПП +0,05
    const b1 = U.res.compute.B;
    say(near(b1, b0 + 0.1 + 0.2, 1e-9), `ПЗ +0,2 применён один раз: compute ${b0} → ${b1.toFixed(3)}`);
    say(near(U.res.dc.C, c0 + 0.05, 1e-9), `ПП +0,05 внесён в прирост: dc.C ${c0} → ${U.res.dc.C.toFixed(3)}`);
    const dc1 = U.res.dc.B;
    turn(G, 2); const dc2 = U.res.dc.B;
    turn(G, 3); const dc3 = U.res.dc.B;
    turn(G, 4); const dc4 = U.res.dc.B;
    say(near(dc2 - dc1, c0 + 0.05, 1e-9) && near(dc3 - dc2, c0 + 0.05, 1e-9) && near(dc4 - dc3, c0 + 0.05, 1e-9),
      `прирост ЦОД +0,05 действует 3 года подряд: Δ=${(dc2 - dc1).toFixed(3)}, ${(dc3 - dc2).toFixed(3)}, ${(dc4 - dc3).toFixed(3)}; всего с начала +${(dc4 - bdc0).toFixed(3)}`);
    say(near(U.res.compute.B, Math.min(10, b1 + 3 * 0.1), 1e-9), 'ПЗ не исчезает и не повторяется в следующие годы');
  }
  // --- временный эффект исчезает через 1 ход
  {
    const G = newG();
    const U = G.C.usa;
    for (const s of cfg.spheres) { U.sph[s.id].L = 5; U.sph[s.id].M = 0; }
    U.res.finance.B = 5; U.res.finance.C = 0;
    U.swan.released = true;
    const rng3 = E.makeRng(() => 0.5); rng3.int = () => 3; // D60 №3: всем сферам ВЗ +0,15; Финансы ВЗ +0,25
    turn(G, 1, rng3);
    const rv = E.realValues(cfg, U);
    say(near(rv.sph.production, 5.15, 1e-9) && near(rv.res.finance, 5.25, 1e-9), `ВЗ действует в следующем году: сфера ${rv.sph.production}, финансы ${rv.res.finance}`);
    turn(G, 2);
    const rv2 = E.realValues(cfg, U);
    say(near(rv2.sph.production, 5, 1e-9) && near(rv2.res.finance, 5, 1e-9), `ВЗ исчез через 1 ход: сфера ${rv2.sph.production}, финансы ${rv2.res.finance}`);
    say(G.C.china.pending.length === 0 && G.C.china.active.length === 0, 'глобальный лебедь уже учтён у всех игроков, очередь пуста');
  }
  // --- ВП добавляется к приросту один раз
  {
    const C = E.newCountryState(cfg, 'usa'); C.res.providers.B = 5; C.res.providers.C = 0.1;
    C.pending.push({ target: 'res:providers', kind: 'VP', value: 0.08 });
    E.transitionCountry(cfg, fx, C, E.emptyPlan());
    const b1 = C.res.providers.B; E.transitionCountry(cfg, fx, C, E.emptyPlan());
    say(near(b1, 5.18, 1e-9) && near(C.res.providers.B, 5.28, 1e-9), `ВП +0,08 учтён один раз: ${b1}, затем +0,1 (${C.res.providers.B})`);
  }
  // --- торговля меняет B навсегда
  {
    const G = newG();
    G.C.usa.res.energy.B = 6; G.C.usa.res.energy.C = 0; G.C.china.res.chem.B = 6; G.C.china.res.chem.C = 0;
    const r = E.postListing(cfg, G, 'usa', { give: { res: { energy: 1 } }, want: { res: { chem: 0.5 } }, years: 1 });
    const a = E.acceptListing(cfg, G, 'china', r.listing.id);
    say(r.ok && a.ok && near(G.C.usa.res.energy.B, 5) && near(G.C.china.res.energy.B, G.C.china.res.energy.B) && near(G.C.usa.res.chem.B, G.C.usa.res.chem.B), 'сделка исполнена сразу: у США энергия 6 → 5');
    const chinaE = G.C.china.res.energy.B;
    turn(G, 1); turn(G, 2);
    say(near(G.C.usa.res.energy.B, 5, 1e-9) && near(G.C.china.res.energy.B, chinaE, 1e-9), 'после двух переходов года результат сделки сохранился (B изменён навсегда)');
    const bad = E.acceptListing(cfg, G, 'china', r.listing.id);
    say(!!bad.error, '«1 объявление = 1 сделка»: повторное принятие отклонено');
    // многолетняя
    const G2 = newG();
    G2.C.usa.res.energy.B = 8; G2.C.usa.res.energy.C = 0; G2.C.china.res.energy.B = 4; G2.C.china.res.energy.C = 0;
    const l = E.postListing(cfg, G2, 'usa', { give: { res: { energy: 1 } }, want: {}, years: 3 });
    E.acceptListing(cfg, G2, 'china', l.listing.id);
    turn(G2, 1); turn(G2, 2);
    say(near(G2.C.usa.res.energy.B, 5, 1e-9) && near(G2.C.china.res.energy.B, 7, 1e-9), `3-летняя сделка: передано 3 раза (США ${G2.C.usa.res.energy.B}, Китай ${G2.C.china.res.energy.B})`);
    turn(G2, 3);
    say(near(G2.C.usa.res.energy.B, 5, 1e-9), 'после срока передачи прекращаются');
    // границы
    const G3 = newG(); G3.C.usa.res.energy.B = 1.5;
    say(!!E.postListing(cfg, G3, 'usa', { give: { res: { energy: 1 } }, want: {} }).error, 'ресурс не может уйти ниже 1');
    // NPC 2:1
    const G4 = newG(); G4.C.usa.rel.japan = 2; G4.C.usa.res.energy.B = 8; G4.C.usa.res.chem.B = 5;
    const ex = E.npcExchange(cfg, G4, 'usa', 'japan', 'energy', 'chem', 0.5);
    say(ex.ok && near(G4.C.usa.res.energy.B, 7) && near(G4.C.usa.res.chem.B, 5.5), 'обмен с NPC 2:1: −1 энергии, +0,5 химии');
    G4.C.usa.rel.russia = -1;
    say(!!E.npcExchange(cfg, G4, 'usa', 'russia', 'energy', 'chem', 0.5).error, 'обмен запрещён при отношении < 0');
  }
  // --- война
  {
    let okp = true;
    for (const [a, b] of [[1, 1], [10, 1], [0.5, 30], [100, 0], [3, 7]]) {
      const p = E.warProbs(cfg, a, b);
      if (!near(p.A + p.B + p.draw, 1, 1e-12) || p.draw < 0) okp = false;
    }
    say(okp, 'вероятности войны: P_A + P_ничья + P_B = 1 для разных сил');
    const p = E.warProbs(cfg, 20, 10);
    say(near(p.draw, 0.8 * (2 / 3) * (1 / 3), 1e-12) && near(p.A, (1 - p.draw) * (2 / 3), 1e-12), `P_ничьи=0,8·pA·pB=${p.draw.toFixed(4)}, P_A=${p.A.toFixed(4)}`);
    // эмпирически через resolveWar
    const cnt = { A: 0, draw: 0, B: 0 }; const N = 4000;
    for (let i = 0; i < N; i++) {
      const G = newG();
      G.P.china.fp.defense = { ares: 10, athena: 0, apollo: 0 };
      const o = E.resolveWar(cfg, G, 'usa', 'china', { ares: 20, athena: 0, apollo: 0 }, E.seededRng(i + 100));
      cnt[o.outcome]++;
    }
    const pp = E.warProbs(cfg, 20, 10);
    say(Math.abs(cnt.A / N - pp.A) < 0.03 && Math.abs(cnt.draw / N - pp.draw) < 0.03, `частоты исходов D60 ~ теории: A ${(cnt.A / N).toFixed(3)} vs ${pp.A.toFixed(3)}, ничья ${(cnt.draw / N).toFixed(3)} vs ${pp.draw.toFixed(3)}`);
    // атака рвёт союз и снижает отношения
    const G = newG(); G.C.usa.rel.china = 3; G.C.china.rel.usa = 3;
    G.C.usa.allies.china = true; G.C.china.allies.usa = true;
    E.resolveWar(cfg, G, 'usa', 'china', { ares: 5, athena: 0, apollo: 0 }, E.seededRng(5));
    say(near(G.C.usa.rel.china, 2) && near(G.C.china.rel.usa, 2) && !G.C.usa.allies.china, 'атака: отношения −1 у обеих сторон, союз разорван');
  }
  // --- диффузия цены
  {
    const t = cfg.techs.find((q) => q.id === 'C1');
    say(near(E.techPrice(cfg, t, 0), 20) && near(E.techPrice(cfg, t, 3), 14) && near(E.techPrice(cfg, t, 9), 10), 'диффузия цены: 20 → 14 (3 страны) → 10 (минимум 50%)');
    const G = newG(['usa', 'china', 'india']);
    G.C.usa.techQueue = ['C1']; turn(G, 1);
    G.C.china.techQueue = ['C1']; // со скидкой 10% цена 18
    const al = E.allocScience(cfg, G, 'china');
    turn(G, 2);
    say(!!G.C.china.techs.done.C1 && near(al.C1, 18), `скидка за диффузию: Китай изучил C1 за ${al.C1} очков после США`);
  }
  // --- очередь приоритетов науки (как в Civ)
  {
    const G = newG(['usa']);
    const U = G.C.usa; U.points.science = 50;
    U.techQueue = ['C2', 'C1', 'M1', 'D1', 'A1'];
    const al = E.allocScience(cfg, G, 'usa');
    say(!al.C2 && near(al.C1, 20) && near(al.M1, 20) && near(al.D1, 10) && !al.A1,
      `очередь: C2 (закрыта) пропущена, C1 20 → M1 20 → D1 10 (остаток), A1 0: ${JSON.stringify(al)}`);
    U.techs.prog.C1 = 15;
    const al2 = E.allocScience(cfg, G, 'usa');
    say(near(al2.C1, 5) && near(al2.M1, 20) && near(al2.D1, 20) && near(al2.A1, 5), `частичный прогресс: в C1 только недостающие 5: ${JSON.stringify(al2)}`);
    U.points.science = 100; U.techQueue = ['C1', 'C2'];
    turn(G, 3);
    say(!!U.techs.done.C1 && !U.techs.done.C2 && U.techQueue.join() === 'C2', 'изученная технология уходит из очереди, C2 ждёт требования до следующего года');
  }
  // --- предложения, союз
  {
    const G = newG(['usa', 'china']);
    G.C.usa.rel.china = 2.5; G.C.china.rel.usa = 2.5;
    const p = E.propose(cfg, G, 'usa', 'china', 'improve');
    const al = E.propose(cfg, G, 'usa', 'china', 'alliance');
    E.respond(cfg, G, 'china', p.proposal.id, true); E.respond(cfg, G, 'china', al.proposal.id, true);
    turn(G, 3);
    say(G.C.usa.allies.china && G.C.china.allies.usa && near(G.C.usa.rel.china, 3.5, 1) , 'принятые предложения: +1 к отношениям и союз применены при разрешении');
    const G2 = newG(['usa', 'china']);
    const p2 = E.propose(cfg, G2, 'usa', 'china', 'improve');
    turn(G2, 3);
    say(G2.proposals[0].status === 'rejected', 'предложение без ответа → «Отклонено»');
  }
  // --- все 60 лебедей применяются без NaN и в границах
  {
    let okAll = true;
    for (const sw of cfg.blackSwans) {
      const C = E.newCountryState(cfg, 'russia');
      C.pending.push(...sw.effects.flatMap((e) => (e.target === 'all_spheres' ? cfg.spheres.map((s) => ({ ...e, target: 'sph:' + s.id })) : [e])));
      E.transitionCountry(cfg, fx, C, E.emptyPlan());
      const rv = E.realValues(cfg, C);
      for (const v of [...Object.values(rv.res), ...Object.values(rv.sph)]) if (!isFinite(v) || v < 1 || v > 10) okAll = false;
    }
    say(okAll, 'все 60 событий D60 применимы; значения остаются в [1;10]');
  }
  // --- полная симуляция 15 лет, 4 игрока, случайные планы
  {
    const players = ['usa', 'china', 'russia', 'india'];
    const G = E.newGame(cfg, fx, players, E.seededRng(11));
    const rng = E.seededRng(99);
    let years = 0, valid = true;
    while (G.phase === 'game' && years < 20) {
      for (const cid of players) {
        const C = G.C[cid]; const pl = E.emptyPlan();
        const k = rng.float();
        const rid = rng.pick(cfg.resources).id; pl.transform[rid] = { v: C.points.transform * 0.5, p: C.points.transform * 0.4 };
        pl.ai[rng.pick(cfg.spheres).id] = C.points.ai * 0.9;
        const avail = cfg.techs.filter((t) => E.techAvailable(cfg, C, t));
        if (avail.length) C.techQueue = [rng.pick(avail).id];
        const tgt = rng.pick(cfg.countries.filter((c) => c.id !== cid)).id;
        if (k < 0.5) pl.fp.attack[tgt] = { ares: C.points.fp * 0.3, athena: C.points.fp * 0.1, apollo: C.points.fp * 0.1 };
        pl.fp.defense.ares = C.points.fp * 0.1;
        G.P[cid] = pl;
        if (rng.float() < 0.3) E.releaseSwan(cfg, G, cid, rng);
      }
      E.resolveTurn(cfg, fx, G, rng); years++;
      for (const cid of players) {
        for (const r of cfg.resources) { const s = G.C[cid].res[r.id]; if (!(s.B >= 1 && s.B <= 10 && isFinite(s.C) && s.C <= 1)) valid = false; }
        for (const s of Object.values(G.C[cid].scores)) if (!(s >= 0 && s <= 100)) valid = false;
      }
    }
    say(valid && G.phase === 'finished' && years <= 15, `симуляция: ${years} ходов, итог — победитель ${E.nm(cfg, G.result.winner)} (${G.result.typeName}), инварианты соблюдены`);
  }
  // --- победа по технологиям / тай-брейк
  {
    const G = newG(['usa', 'china']);
    for (const t of cfg.techs) { G.C.usa.techs.done[t.id] = 2026; G.C.china.techs.done[t.id] = 2026; }
    G.C.usa.startScores = { ai: 50, science: 50, fp: 50, transform: 50 };
    G.C.china.startScores = { ai: 10, science: 10, fp: 10, transform: 10 };
    turn(G, 1);
    say(G.phase === 'finished' && G.result.winner === 'china' && G.result.type === 'tech', 'одновременная победа: выигрывает страна с худшим стартом (Китай)');
  }
  return { ok, lines };
}

module.exports = { runChecks, excelCheck };

if (require.main === module) {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'default_config.json'), 'utf8'));
  const { ok, lines } = runChecks(cfg);
  console.log(lines.join('\n'));
  console.log(ok ? '\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : '\nЕСТЬ ОШИБКИ');
  process.exit(ok ? 0 : 1);
}
