import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { diffHands, diffTotals, findDuplicateUid, stealVictims, discardVictims, actionVictims, faceCardsOf, swapReady } from '../public/fx.js';

const c = (uid, value, extra = {}) => ({ uid, kind: 'number', value, label: String(value), ...extra });
const P = (id, hand = [], mods = [], status = 'active', total = 0) => ({ id, name: id, hand, mods, status, total });
const G = (players) => ({ players });

describe('fx diff', () => {
  it('detects dealt + mod + lost', () => {
    const a = c('a', 5), b = c('b', 9), m = { uid: 'm1', kind: 'modifier', modifier: 'minus2', label: '−2' };
    const prev = G([P('me', [a], [], 'active')]);
    const next = G([P('me', [a, b], [m], 'active')]);
    const evts = diffHands(prev, next, 'me');
    assert.deepEqual(evts.find((e) => e.type === 'dealt').cards.map((x) => x.uid), ['b']);
    assert.deepEqual(evts.find((e) => e.type === 'mod').cards.map((x) => x.uid), ['m1']);
    assert.equal(evts.find((e) => e.type === 'lost'), undefined);
  });
  it('detects bust and stay transitions', () => {
    assert.equal(diffHands(G([P('me', [], [], 'active')]), G([P('me', [], [], 'busted')]), 'me')[0].type, 'bust');
    assert.equal(diffHands(G([P('me', [], [], 'active')]), G([P('me', [], [], 'stayed')]), 'me')[0].type, 'stay');
    assert.deepEqual(diffHands(G([P('me', [], [], 'stayed')]), G([P('me', [], [], 'stayed')]), 'me'), []);
  });
  it('empty on missing snapshots or unknown player', () => {
    assert.deepEqual(diffHands(null, G([P('me')]), 'me'), []);
    assert.deepEqual(diffHands(G([P('me')]), G([P('other')]), 'me'), []);
  });
  it('diffTotals reports only changed totals', () => {
    const d = diffTotals(G([P('a', [], [], 'active', 10), P('b', [], [], 'active', 5)]), G([P('a', [], [], 'active', 39), P('b', [], [], 'active', 5)]));
    assert.deepEqual(d, { a: { from: 10, to: 39 } });
  });
  it('findDuplicateUid skips lucky-13 nuance, falls back sanely', () => {
    assert.equal(findDuplicateUid([c('x', 5), c('y', 5), c('z', 9)]), 'y');
    assert.equal(findDuplicateUid([c('x', 13), c('y', 13)]), 'y');
    assert.equal(findDuplicateUid([]), null);
  });
});

describe('fx picker rules', () => {
  const NC = (id, status = 'active', hand = [], mods = []) => ({ id, name: id, status, hand, mods });
  const n5 = { uid: 'n5', kind: 'number', value: 5, label: '5' };
  // Beginning of game: holder drew Steal first, nobody has any cards.
  it('steal with all-empty hands offers nobody (fizzle, not stuck)', () => {
    const snap = { mode: 'vengeance', players: [NC('me'), NC('op1'), NC('op2')] };
    assert.deepEqual(stealVictims(snap, 'me'), []);
    assert.deepEqual(discardVictims(snap, 'me'), []);
    assert.equal(swapReady(snap).ok, false);
  });
  it('steal lists only card-holding opponents; busted never listed', () => {
    const snap = {
      mode: 'vengeance',
      players: [NC('me', 'active', [n5]), NC('rich', 'active', [n5]), NC('poor'), NC('dead', 'busted', [n5])],
    };
    assert.deepEqual(stealVictims(snap, 'me').map((p) => p.id), ['rich']);
    assert.deepEqual(discardVictims(snap, 'me').map((p) => p.id).sort(), ['me', 'rich']);
    assert.deepEqual(faceCardsOf(snap, 'dead'), []);
    assert.equal(faceCardsOf(snap, 'poor').length, 0);
    assert.equal(faceCardsOf(snap, 'rich').length, 1);
  });
  it('justOneMore/flipFour list cardless-but-live players (busted excluded)', () => {
    const snap = { mode: 'vengeance', players: [NC('me'), NC('op1'), NC('dead', 'busted')] };
    assert.deepEqual(actionVictims(snap, 'me', 'justOneMore').map((p) => p.id).sort(), ['me', 'op1']);
    assert.deepEqual(actionVictims(snap, 'me', 'steal').map((p) => p.id), []);
  });
  it('swap needs two lines; single line is not ready', () => {
    const one = { mode: 'vengeance', players: [NC('me', 'active', [n5]), NC('op1')] };
    assert.equal(swapReady(one).ok, false);
    const two = { mode: 'vengeance', players: [NC('me', 'active', [n5]), NC('op1', 'active', [{ ...n5, uid: 'n6' }])] };
    assert.equal(swapReady(two).ok, true);
  });
  it('classic freeze targets active others only', () => {
    const snap = { mode: 'classic', players: [NC('me'), NC('op1'), NC('stayed', 'stayed'), NC('dead', 'busted')] };
    assert.deepEqual(actionVictims(snap, 'me', 'freeze').map((p) => p.id), ['op1']);
  });
});
