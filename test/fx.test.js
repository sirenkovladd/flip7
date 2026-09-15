import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { diffHands, diffTotals, findDuplicateUid } from '../public/fx.js';

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
