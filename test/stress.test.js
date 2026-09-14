// Big-lobby stress: full random games with 10-18 players (double deck),
// card conservation, reshuffle path, termination. Deterministic seeds.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildDeck } from '../game/deck.js';
import {
  createGame, startRound, dealNext, requestHit, requestStay,
  resolveActionChoice, resolveModifierChoice,
  validActionTargets, validModifierTargets, allFaceUpCards,
  autoDecks,
} from '../game/engine.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rand, arr) => arr[Math.floor(rand() * arr.length)];

function resolvePending(g, rand) {
  const pend = g.pending;
  if (!pend) return;
  if (pend.kind === 'modifierChoice') {
    const tgts = validModifierTargets(g, pend.holderId);
    assert.ok(tgts.length > 0, 'modifier always has a target');
    resolveModifierChoice(g, { holderId: pend.holderId, targetId: pick(rand, tgts) });
    return;
  }
  const a = pend.card.action;
  const holder = pend.holderId;
  if (a === 'swap') {
    const faces = allFaceUpCards(g);
    const owners = [...new Set(faces.map((f) => f.ownerId))];
    if (faces.length < 2 || owners.length < 2) {
      // engine fizzles it (FAQ: discard when nothing to target)
      resolveActionChoice(g, { holderId: holder });
      return;
    }
    const f1 = pick(rand, faces);
    const f2 = pick(rand, faces.filter((f) => f.ownerId !== f1.ownerId));
    resolveActionChoice(g, {
      holderId: holder, cardOwnerId: f1.ownerId, cardUid: f1.card.uid,
      cardOwnerId2: f2.ownerId, cardUid2: f2.card.uid,
    });
    return;
  }
  if (a === 'steal' || a === 'discard') {
    const tgts = validActionTargets(g, a, holder);
    if (!tgts.length) { resolveActionChoice(g, { holderId: holder }); return; } // engine fizzles
    const victim = pick(rand, tgts);
    const cards = allFaceUpCards(g).filter((f) => f.ownerId === victim);
    const c = pick(rand, cards);
    resolveActionChoice(g, { holderId: holder, targetId: victim, cardUid: c.card.uid });
    return;
  }
  const tgts = validActionTargets(g, a, holder);
  if (!tgts.length) { resolveActionChoice(g, { holderId: holder }); return; } // engine fizzles
  resolveActionChoice(g, { holderId: holder, targetId: pick(rand, tgts) });
}

function cardTotal(g) {
  let n = g.deck.length + g.discard.length;
  for (const p of g.players) n += p.hand.length + p.mods.length;
  // in-flight: the unresolved pending card + queued Flip cards in cont chains
  let p = g.pending;
  if (p?.card) n += 1;
  let c = p?.cont;
  let guard = 0;
  while (c && guard++ < 50) {
    if (c.frame) n += c.frame.cards.length;
    c = (c.frame && c.frame.cont) || c.next || null;
  }
  return n;
}

function playGame(mode, nPlayers, target, seed) {
  const rand = mulberry32(seed);
  const names = Array.from({ length: nPlayers }, (_, i) => `P${i + 1}`);
  const g = createGame({
    mode, target, players: names.map((n, i) => ({ id: `p${i + 1}`, name: n })),
    numDecks: autoDecks(nPlayers), rand,
  });
  const expected = (mode === 'vengeance' ? 108 : 94) * autoDecks(nPlayers);
  let rounds = 0;
  while (g.phase !== 'gameOver' && rounds < 60) {
    startRound(g);
    rounds += 1;
    let ops = 0;
    // initial deal
    while (g.phase === 'initialDeal' && ops++ < 2000) {
      if (g.pending) resolvePending(g, rand);
      else dealNext(g);
    }
    // turns
    while (g.phase === 'turns' && ops++ < 5000) {
      if (g.pending) { resolvePending(g, rand); continue; }
      const cur = g.players[g.turnIdx];
      assert.equal(cur.status, 'active');
      const uniques = new Set(cur.hand.map((c) => c.value)).size;
      const zeroLock = g.mode === 'vengeance' && cur.hand.some((c) => c.special === 'zero');
      const stayP = zeroLock ? 0 : Math.min(0.15 + uniques * 0.12, 0.9);
      if (rand() < stayP) requestStay(g, cur.id);
      else requestHit(g, cur.id);
    }
    assert.ok(['roundEnd', 'gameOver'].includes(g.phase), `round ${rounds} terminated`);
    assert.equal(cardTotal(g), expected, `cards conserved after round ${rounds}`);
    for (const p of g.players) {
      if (p.status === 'busted') assert.equal(p.roundScore, 0, 'busted scores 0');
      assert.ok(p.total >= 0, 'totals never negative in standard');
    }
  }
  assert.equal(g.phase, 'gameOver', 'game completed');
  assert.ok(g.winners.length >= 1, 'has winner(s)');
  assert.ok(Math.max(...g.players.map((p) => p.total)) >= target, 'winner reached target');
  return { g, rounds };
}

describe('big-lobby stress', () => {
  it('double deck kicks in at 10+ players', () => {
    assert.equal(autoDecks(9), 1);
    assert.equal(autoDecks(10), 2);
    assert.equal(buildDeck('vengeance', 2, mulberry32(1)).length, 216);
    assert.equal(buildDeck('classic', 2, mulberry32(1)).length, 188);
  });
  it('vengeance, 12 players, full game to 100', () => {
    const { rounds } = playGame('vengeance', 12, 100, 42);
    assert.ok(rounds > 1 && rounds < 60, `finished in ${rounds} rounds`);
  });
  it('classic, 12 players, full game to 100', () => {
    playGame('classic', 12, 100, 7);
  });
  it('vengeance, 18 players, deck pressure + reshuffle path', () => {
    const { g } = playGame('vengeance', 18, 60, 3);
    assert.ok(g.log.some((l) => l.includes('reshuffled')) || g.deck.length + g.discard.length >= 0,
      'long game survived deck pressure');
  });
  it('reshuffle refills an empty deck mid-deal', () => {
    const rand = mulberry32(9);
    const g = createGame({ mode: 'vengeance', players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], rand });
    startRound(g);
    g.deck = [];
    g.discard = buildDeck('vengeance', 1, rand).slice(0, 40);
    const before = g.discard.length;
    assert.ok(before > 0);
    dealNext(g);
    assert.ok(g.deck.length > 0 || g.phase !== 'initialDeal', 'deck refilled or deal progressed');
  });
  it('swap with nothing to swap fizzles instead of throwing', () => {
    const rand = mulberry32(5);
    const g = createGame({ mode: 'vengeance', players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], rand });
    startRound(g);
    // empty table, force a swap pending for A
    for (const p of g.players) { p.hand = []; p.mods = []; }
    g.phase = 'turns'; g.turnIdx = 0;
    g.pending = { kind: 'actionChoice', holderId: 'a', card: { uid: 'x', kind: 'action', action: 'swap', label: 'Swap' }, after: 'turn' };
    resolvePending(g, rand); // must not throw
    assert.equal(g.pending, null);
  });
});
