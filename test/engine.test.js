import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  vengeanceNumbers, vengeanceModifiers, vengeanceActions,
  classicNumbers, classicModifiers, classicActions,
  numCard, modCard, actionCard,
} from '../game/deck.js';
import {
  createGame, startRound, dealNext, requestHit, requestStay,
  resolveActionChoice, resolveModifierChoice,
  checkBust, checkFlip7, scorePlayer,
  markLeft, removePlayer, addPlayer, getPlayer,
} from '../game/engine.js';

const quietRand = () => 0; // deterministic shuffle
function newGame(mode = 'vengeance', names = ['A', 'B', 'C']) {
  const g = createGame({ mode, players: names.map((n, i) => ({ id: `p${i + 1}`, name: n })), rand: quietRand });
  startRound(g);
  // skip initial deal randomness: jump straight to turns with empty hands
  g.phase = 'turns';
  g.turnIdx = 0;
  for (const p of g.players) { p.hand = []; p.mods = []; p.status = 'active'; }
  g.deck = [];
  return g;
}

describe('deck composition', () => {
  it('vengeance = 92 numbers + 6 modifiers + 10 actions', () => {
    assert.equal(vengeanceNumbers().length, 92);
    assert.equal(vengeanceModifiers().length, 6);
    assert.equal(vengeanceActions().length, 10);
  });
  it('vengeance has one Zero, one Unlucky7, one Lucky13', () => {
    const n = vengeanceNumbers();
    assert.equal(n.filter((c) => c.special === 'zero').length, 1);
    assert.equal(n.filter((c) => c.special === 'unlucky7').length, 1);
    assert.equal(n.filter((c) => c.special === 'lucky13').length, 1);
    assert.equal(n.filter((c) => c.value === 7).length, 7);
    assert.equal(n.filter((c) => c.value === 13).length, 13);
  });
  it('classic = 79 numbers + 6 modifiers + 9 actions', () => {
    assert.equal(classicNumbers().length, 79);
    assert.equal(classicModifiers().length, 6);
    assert.equal(classicActions().length, 9);
  });
});

describe('bust & lucky 13', () => {
  it('duplicate numbers bust', () => {
    const g = newGame();
    const p = g.players[0];
    p.hand = [numCard(5), numCard(5)];
    assert.equal(checkBust(p), 'bust');
  });
  it('two 13s bust without Lucky, safe with Lucky, third busts', () => {
    const g = newGame();
    const p = g.players[0];
    p.hand = [numCard(13), numCard(13)];
    assert.equal(checkBust(p), 'bust');
    p.hand = [numCard(13), numCard(13, 'lucky13')];
    assert.equal(checkBust(p), null);
    p.hand.push(numCard(13));
    assert.equal(checkBust(p), 'bust');
  });
});

describe('unlucky 7', () => {
  it('wipes hand and mods, keeps only itself', () => {
    const g = newGame();
    const p = g.players[0];
    p.hand = [numCard(5), numCard(9)];
    p.mods = [modCard('minus6')];
    g.deck = [numCard(7, 'unlucky7')];
    requestHit(g, p.id);
    assert.equal(p.hand.length, 1);
    assert.equal(p.hand[0].special, 'unlucky7');
    assert.equal(p.mods.length, 0);
    assert.equal(p.status, 'active');
  });
});

describe('zero', () => {
  it('scores 0 unless Flip 7', () => {
    const g = newGame();
    const p = g.players[0];
    p.hand = [numCard(0, 'zero'), numCard(12), numCard(11)];
    assert.equal(scorePlayer(g, p), 0);
    p.hand = [numCard(0, 'zero'), numCard(1), numCard(2), numCard(3), numCard(4), numCard(5), numCard(6)];
    assert.equal(checkFlip7(p), true);
    assert.equal(scorePlayer(g, p), 0 + 1 + 2 + 3 + 4 + 5 + 6 + 15);
  });
  it('zero holder cannot stay', () => {
    const g = newGame();
    const p = g.players[0];
    p.hand = [numCard(0, 'zero')];
    assert.throws(() => requestStay(g, p.id), /Zero must HIT/);
  });
});

describe('vengeance scoring order', () => {
  it('sum → ÷2 floor → minus → floor 0 → +15', () => {
    const g = newGame();
    const p = g.players[0];
    p.hand = [numCard(13), numCard(11), numCard(8)]; // 32
    p.mods = [modCard('div2'), modCard('minus6')];
    assert.equal(scorePlayer(g, p), 10);
    p.mods.push(modCard('minus10'));
    assert.equal(scorePlayer(g, p), 0); // floor, not negative
    g.brutal = true;
    assert.equal(scorePlayer(g, p), 0); // 16-6-10 = 0 even in brutal
    p.mods.push(modCard('minus2'));
    assert.equal(scorePlayer(g, p), -2); // brutal allows negative
  });
});

describe('swap & steal', () => {
  it('swap can bust both players', () => {
    const g = newGame('vengeance', ['A', 'B']);
    const [a, b] = g.players;
    const a10 = numCard(10), a11 = numCard(11), b10 = numCard(10), b11 = numCard(11);
    a.hand = [a10, a11]; b.hand = [b10, b11];
    g.deck = [actionCard('swap')];
    requestHit(g, a.id);
    assert.equal(g.pending?.kind, 'actionChoice');
    resolveActionChoice(g, { holderId: a.id, cardOwnerId: a.id, cardUid: a10.uid, cardOwnerId2: b.id, cardUid2: b11.uid });
    assert.equal(a.status, 'busted');
    assert.equal(b.status, 'busted');
  });
  it('steal completing 7th unique ends round with Flip 7', () => {
    const g = newGame('vengeance', ['A', 'B']);
    const [a, b] = g.players;
    a.hand = [numCard(1), numCard(2), numCard(3), numCard(4), numCard(5), numCard(6)];
    const seventh = numCard(9);
    b.hand = [seventh, numCard(12)];
    g.deck = [actionCard('steal')];
    requestHit(g, a.id);
    resolveActionChoice(g, { holderId: a.id, targetId: b.id, cardUid: seventh.uid });
    assert.equal(g.phase, 'roundEnd');
    assert.equal(g.flip7PlayerId, a.id);
    assert.ok(a.roundScore >= 1 + 2 + 3 + 4 + 5 + 6 + 9 + 15);
  });
});

describe('flip four', () => {
  it('bust mid-flip voids queued actions', () => {
    const g = newGame('vengeance', ['A', 'B']);
    const [a] = g.players;
    a.hand = [numCard(5)];
    const dup = numCard(5);
    // pop order: last element first → 9, then discard(action), then dup(5) busts
    g.deck = [dup, actionCard('discard'), numCard(9)];
    // force a FlipFour on A via direct pending (as if A drew it and targeted self)
    g.deck.push(actionCard('flipFour'));
    requestHit(g, a.id);
    resolveActionChoice(g, { holderId: a.id, targetId: a.id });
    assert.equal(a.status, 'busted');
    assert.equal(g.pending, null);
    assert.ok(g.discard.some((c) => c.action === 'discard'), 'queued action voided to discard');
  });
});

describe('roster', () => {
  it('markLeft busts mid-round and advances turn', () => {
    const g = newGame('vengeance', ['A', 'B']);
    markLeft(g, 'p1');
    assert.equal(getPlayer(g, 'p1').status, 'busted');
    assert.equal(g.players[g.turnIdx].id, 'p2');
  });
  it('remove/add between rounds', () => {
    const g = newGame();
    g.phase = 'roundEnd';
    removePlayer(g, 'p3');
    assert.equal(g.players.length, 2);
    addPlayer(g, { id: 'p9', name: 'Z' });
    assert.equal(g.players.length, 3);
    assert.equal(getPlayer(g, 'p9').total, 0);
  });
});

describe('classic basics', () => {
  it('x2 doubles numbers only, then plus, then +15', () => {
    const g = newGame('classic', ['A']);
    const [a] = g.players;
    a.hand = [numCard(10), numCard(5)];
    a.mods = [modCard('x2'), modCard('plus10')];
    assert.equal(scorePlayer(g, a), 15 * 2 + 10);
  });
});
