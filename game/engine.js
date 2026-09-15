// Pure game engine — no DOM, no sockets. Host browser runs it; tests import it.
import { buildDeck } from './deck.js';

export const MODES = ['vengeance', 'classic'];

export function createGame(opts = {}) {
  const {
    mode = 'vengeance',
    target = 200,
    brutal = false,
    tieMode = 'shared', // 'shared' | 'playoff'
    numDecks = 1,
    players = [],
    rand = Math.random,
  } = opts;
  if (!MODES.includes(mode)) throw new Error('bad mode');
  const g = {
    mode, target, brutal, tieMode, numDecks,
    players: players.map((p, i) => ({
      id: p.id || `p${i + 1}`, name: p.name || `Player ${i + 1}`,
      hand: [], mods: [], status: 'active', total: 0, shield: false,
    })),
    deck: [], discard: [], round: 0,
    dealerIdx: -1, turnIdx: 0,
    phase: 'lobby', // lobby|initialDeal|turns|roundEnd|gameOver
    dealPos: 0, dealt: 0,
    pending: null, // {kind,...} awaiting a target choice
    flip7PlayerId: null,
    winners: [],
    log: [],
    _rand: rand,
  };
  return g;
}

export function getPlayer(g, id) {
  const p = g.players.find((x) => x.id === id);
  if (!p) throw new Error('unknown player ' + id);
  return p;
}
export function leftOf(g, idx) { return (idx + 1) % g.players.length; }
function log(g, msg) { g.log.push(`R${g.round} ${msg}`); }

export function autoDecks(playerCount) { return playerCount >= 10 ? 2 : 1; }

function reshuffleIfNeeded(g) {
  if (g.deck.length === 0) {
    if (g.discard.length === 0) return false;
    g.deck = g.discard; g.discard = [];
    // shuffle with injected rand
    const r = g._rand || Math.random;
    for (let i = g.deck.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [g.deck[i], g.deck[j]] = [g.deck[j], g.deck[i]];
    }
    log(g, `reshuffled ${g.deck.length} discards into deck`);
  }
  return true;
}
function drawTop(g) {
  if (!reshuffleIfNeeded(g)) return null;
  return g.deck.pop();
}

// ---- hand helpers ----
export function uniqueCount(p) {
  return new Set(p.hand.map((c) => c.value)).size;
}
export function hasZero(p) { return p.hand.some((c) => c.value === 0); }
export function countValue(p, v) { return p.hand.filter((c) => c.value === v).length; }
export function hasLucky(p) { return p.hand.some((c) => c.special === 'lucky13'); }
export function hasDiv2(p) { return p.mods.some((c) => c.modifier === 'div2'); }
export function allFaceUpCards(g) {
  // [{ownerId, card, where:'hand'|'mods'}]
  const out = [];
  for (const p of g.players) {
    if (p.status === 'busted') continue;
    for (const c of p.hand) out.push({ ownerId: p.id, card: c, where: 'hand' });
    for (const c of p.mods) out.push({ ownerId: p.id, card: c, where: 'mods' });
  }
  return out;
}
function removeCardFrom(p, uid) {
  let i = p.hand.findIndex((c) => c.uid === uid);
  if (i >= 0) return { card: p.hand.splice(i, 1)[0], where: 'hand' };
  i = p.mods.findIndex((c) => c.uid === uid);
  if (i >= 0) return { card: p.mods.splice(i, 1)[0], where: 'mods' };
  return null;
}

// ---- bust / flip7 ----
export function checkBust(p) {
  // returns 'bust' or null. Lucky13 allows exactly 2x13.
  const n13 = countValue(p, 13);
  if (n13 >= 3) return 'bust';
  if (n13 === 2 && !hasLucky(p)) return 'bust';
  const seen = new Set();
  for (const c of p.hand) {
    if (c.value === 13) continue; // handled above
    if (seen.has(c.value)) return 'bust';
    seen.add(c.value);
  }
  return null;
}
export function checkFlip7(p) {
  return uniqueCount(p) >= 7;
}
function bustPlayer(g, p, why = 'duplicate') {
  p.status = 'busted';
  p.shield = false;
  log(g, `${p.name} BUSTS (${why})`);
}

// ---- scoring ----
export function scorePlayer(g, p) {
  if (p.status === 'busted') return 0;
  if (g.mode === 'classic') {
    let s = p.hand.reduce((a, c) => a + c.value, 0);
    const hasX2 = p.mods.some((c) => c.modifier === 'x2');
    if (hasX2) s = s * 2;
    for (const m of p.mods) {
      if (m.modifier?.startsWith('plus')) s += parseInt(m.modifier.slice(4), 10);
    }
    if (checkFlip7(p)) s += 15;
    return s;
  }
  // vengeance
  if (hasZero(p) && uniqueCount(p) < 7) return 0;
  let s = p.hand.reduce((a, c) => a + c.value, 0);
  if (hasDiv2(p)) s = Math.floor(s / 2);
  for (const m of p.mods) {
    if (m.modifier?.startsWith('minus')) s -= parseInt(m.modifier.slice(5), 10);
  }
  if (!g.brutal && s < 0) s = 0;
  if (checkFlip7(p)) s += 15; // brutal -15 handled at endRound via opts
  return s;
}

// ---- round lifecycle ----
export function startRound(g) {
  if (g.phase === 'turns' || g.phase === 'initialDeal') throw new Error('round in progress');
  g.round += 1;
  g.dealerIdx = (g.dealerIdx + 1) % g.players.length;
  for (const p of g.players) { p.hand = []; p.mods = []; p.status = 'active'; p.shield = false; }
  if (g.round === 1 || g.deck.length === 0 && g.discard.length === 0) {
    // fresh shoe (round 1) — buildDeck already shuffled with rand
  }
  if (g.round === 1) {
    const { buildDeck: bd } = { buildDeck };
    g.deck = bd(g.mode, g.numDecks, g._rand || Math.random);
    g.discard = [];
  }
  g.phase = 'initialDeal';
  g.dealPos = leftOf(g, g.dealerIdx);
  g.dealt = 0;
  g.pending = null;
  g.flip7PlayerId = null;
  log(g, `round ${g.round} starts (dealer ${g.players[g.dealerIdx].name}, ${g.mode}, decks:${g.numDecks})`);
}

export function dealDone(g) { return g.dealt >= g.players.length; }

// Deal one card of initial deal. Returns {ok, needChoice?:pending}.
// Caller pumps until dealDone then beginTurns.
export function dealNext(g) {
  if (g.phase !== 'initialDeal') throw new Error('not in initial deal');
  if (g.pending) throw new Error('resolve pending choice first');
  if (dealDone(g)) { beginTurns(g); return { ok: true, done: true }; }
  const p = g.players[g.dealPos];
  const card = drawTop(g);
  if (!card) { beginTurns(g); return { ok: true, done: true }; }
  log(g, `deal ${card.label} → ${p.name}`);
  if (card.kind === 'number') {
    placeNumber(g, p, card);
    if (p.status !== 'busted' && checkFlip7(p)) return endRound(g, 'flip7', p.id);
    advanceDeal(g);
  } else if (card.kind === 'modifier') {
    if (g.mode === 'classic') { p.mods.push(card); log(g, `${p.name} keeps ${card.label}`); advanceDeal(g); }
    else g.pending = { kind: 'modifierChoice', holderId: p.id, card, cont: { after: 'deal' } };
  } else {
    g.pending = { kind: 'actionChoice', holderId: p.id, card, cont: { after: 'deal' } };
  }
  return { ok: true, pending: g.pending };
}
function advanceDeal(g) {
  g.dealt += 1;
  g.dealPos = leftOf(g, g.dealPos);
  if (dealDone(g)) beginTurns(g);
}
function beginTurns(g) {
  g.phase = 'turns';
  // first active left of dealer
  let i = leftOf(g, g.dealerIdx);
  for (let k = 0; k < g.players.length; k++) {
    if (g.players[i].status === 'active') break;
    i = leftOf(g, i);
  }
  g.turnIdx = i;
}
export function currentPlayer(g) { return g.players[g.turnIdx]; }

function advanceTurn(g) {
  if (g.phase !== 'turns') return;
  if (checkRoundEnd(g)) return;
  let i = leftOf(g, g.turnIdx);
  for (let k = 0; k < g.players.length; k++) {
    if (g.players[i].status === 'active') { g.turnIdx = i; return; }
    i = leftOf(g, i);
  }
  endRound(g, 'allDone');
}
function checkRoundEnd(g) {
  const anyActive = g.players.some((p) => p.status === 'active');
  if (!anyActive) { endRound(g, 'allDone'); return true; }
  return false;
}

// ---- core placement ----
function placeNumber(g, p, card) {
  // Second-chance shield (classic) saves from deck duplicates only
  p.hand.push(card);
  if (card.special === 'unlucky7') {
    // wipe everything else
    const kept = card;
    const wiped = p.hand.filter((c) => c.uid !== kept.uid);
    const wipedMods = [...p.mods];
    p.hand = [kept];
    p.mods = [];
    g.discard.push(...wiped.filter((c) => c.uid !== kept.uid), ...wipedMods);
    log(g, `${p.name} hit UNLUCKY 7 — discards all else, keeps 7`);
    return;
  }
  const bust = checkBust(p);
  if (bust) {
    if (g.mode === 'classic' && p.shield) {
      // consume shield + duplicate
      p.hand.pop();
      p.shield = false;
      g.discard.push(card);
      // shield is a flag (no card object held)
      log(g, `${p.name} saved by Second Chance (duplicate ${card.label} discarded)`);
      return;
    }
    bustPlayer(g, p, `${card.label} duplicates`);
  }
}

// ---- turns ----
export function mustHit(p) {
  // vengeance Zero forces hit
  return p.hand.some((c) => c.special === 'zero');
}
export function requestHit(g, playerId) {
  if (g.phase !== 'turns') throw new Error('not in turns phase');
  if (g.pending) throw new Error('resolve pending first');
  const p = getPlayer(g, playerId);
  if (p.status !== 'active') throw new Error('not active');
  if (currentPlayer(g).id !== playerId) throw new Error('not your turn');
  const card = drawTop(g);
  if (!card) { endRound(g, 'deckOut'); return { ok: true }; }
  log(g, `${p.name} hits → ${card.label}`);
  if (card.kind === 'number') {
    placeNumber(g, p, card);
    if (p.status === 'busted') { advanceTurn(g); return { ok: true, bust: true }; }
    if (checkFlip7(p)) return endRound(g, 'flip7', p.id);
    advanceTurn(g);
  } else if (card.kind === 'modifier') {
    if (g.mode === 'classic') { p.mods.push(card); log(g, `${p.name} keeps ${card.label}`); advanceTurn(g); }
    else g.pending = { kind: 'modifierChoice', holderId: p.id, card, cont: { after: 'turn' } };
  } else {
    g.pending = { kind: 'actionChoice', holderId: p.id, card, cont: { after: 'turn' } };
  }
  return { ok: true, pending: g.pending };
}
export function requestStay(g, playerId) {
  if (g.phase !== 'turns') throw new Error('not in turns phase');
  if (g.pending) throw new Error('resolve pending first');
  const p = getPlayer(g, playerId);
  if (p.status !== 'active') throw new Error('not active');
  if (currentPlayer(g).id !== playerId) throw new Error('not your turn');
  if (p.hand.some((c) => c.special === 'zero')) throw new Error('Zero must HIT');
  p.status = 'stayed';
  log(g, `${p.name} stays (${handSummary(p)})`);
  if (!checkRoundEnd(g)) advanceTurn(g);
  return { ok: true };
}
function handSummary(p) {
  return `${p.hand.map((c) => c.label).join(',') || '∅'}${p.mods.length ? ' [' + p.mods.map((c) => c.label).join(',') + ']' : ''}`;
}

// ---- targeting ----
export function validActionTargets(g, action, holderId) {
  const holder = getPlayer(g, holderId);
  if (g.mode === 'classic') {
    if (action === 'freeze' || action === 'flipThree')
      return g.players.filter((p) => p.status === 'active' && p.id !== holderId).map((p) => p.id);
    if (action === 'secondChance')
      return g.players.filter((p) => p.status === 'active' && !p.shield).map((p) => p.id);
    return [];
  }
  // vengeance: any non-busted incl self & stayed
  const alive = g.players.filter((p) => p.status !== 'busted');
  if (action === 'steal')
    return alive.filter((p) => p.id !== holderId && (p.hand.length + p.mods.length) > 0).map((p) => p.id);
  if (action === 'swap')
    return alive.map((p) => p.id); // card-level check later
  if (action === 'discard')
    return alive.filter((p) => (p.hand.length + p.mods.length) > 0).map((p) => p.id);
  return alive.map((p) => p.id); // justOneMore, flipFour
}
export function validModifierTargets(g, holderId) {
  const alive = g.players.filter((p) => p.status !== 'busted');
  if (alive.length === 1) return alive.map((p) => p.id);
  return alive.map((p) => p.id);
}

export function resolveModifierChoice(g, { holderId, targetId }) {
  const pend = g.pending;
  if (!pend || pend.kind !== 'modifierChoice') throw new Error('no modifier pending');
  if (pend.holderId !== holderId) throw new Error('wrong holder');
  const tgts = validModifierTargets(g, holderId);
  // brutal allows busted targets too
  const brutalTgts = g.brutal ? g.players.map((p) => p.id) : tgts;
  if (!brutalTgts.includes(targetId)) throw new Error('illegal modifier target');
  const t = getPlayer(g, targetId);
  t.mods.push(pend.card);
  log(g, `${getPlayer(g, holderId).name} gives ${pend.card.label} → ${t.name}`);
  g.pending = null;
  runCont(g, pend.cont);
  return { ok: true };
}

export function resolveActionChoice(g, sel) {
  // sel: {holderId, targetId, cardUid?, cardOwnerId?, cardUid2?, cardOwnerId2?}
  const pend = g.pending;
  if (!pend || pend.kind !== 'actionChoice') throw new Error('no action pending');
  const { holderId } = sel;
  if (pend.holderId !== holderId) throw new Error('wrong holder');
  const action = pend.card.action;
  const holder = getPlayer(g, holderId);
  const hcont = pend.cont || {};
  g.pending = null; // cleared; nested effects (Flip/JOM draws) may set a fresh one

  const needTarget = ['freeze', 'flipThree', 'justOneMore', 'flipFour', 'steal', 'discard'].includes(action);
  let targetId = sel.targetId || holderId;
  if (action === 'swap') {
    // No two cards on different lines yet (e.g. early initial deal) → fizzle.
    const faces = allFaceUpCards(g);
    const owners = new Set(faces.map((f) => f.ownerId));
    if (faces.length < 2 || owners.size < 2) {
      g.discard.push(pend.card);
      log(g, `${holder.name}'s Swap fizzles (nothing to swap) → discarded`);
      runCont(g, hcont);
      return { ok: true };
    }
    try {
      applySwap(g, holderId, sel);
    } catch (e) {
      // Stale pick (victim busted/emptied mid-choice): fizzle, never stuck.
      log(g, `${holder.name}'s Swap fizzles (${e.message})`);
    }
    g.discard.push(pend.card); // consumed either way — never leaks, never stuck
    if (g.phase === 'roundEnd' || g.phase === 'gameOver') return { ok: true };
    runCont(g, hcont);
    return { ok: true };
  }
  if (action === 'secondChance') {
    const tgts = validActionTargets(g, action, holderId);
    if (!tgts.includes(targetId)) {
      // no valid target → discard
      g.discard.push(pend.card); log(g, `${pend.card.label} discarded (no target)`);
    } else {
      getPlayer(g, targetId).shield = true;
      g.discard.push(pend.card); // shield is a flag; the card itself is consumed
      log(g, `${holder.name} gives 2nd Chance → ${getPlayer(g, targetId).name}`);
    }
    runCont(g, hcont);
    return { ok: true };
  }
  const tgts = validActionTargets(g, action, holderId);
  if (needTarget && !tgts.includes(targetId)) {
    // Special: steal/discard with no cards → discard action
    g.discard.push(pend.card);
    log(g, `${holder.name}'s ${pend.card.label} fizzles (no target) → discarded`);
    runCont(g, hcont);
    return { ok: true };
  }
  g.discard.push(pend.card); // actions are consumed up front
  try {
    switch (action) {
      case 'freeze': {
        const t = getPlayer(g, targetId);
        t.status = 'stayed';
        log(g, `${holder.name} FREEZES ${t.name}`);
        break;
      }
      case 'flipThree': applyFlipDraws(g, targetId, 3, hcont); break;
      case 'justOneMore': applyJustOneMore(g, targetId, hcont); break;
      case 'flipFour': applyFlipDraws(g, targetId, 4, hcont); break;
      case 'steal': {
        const v = getPlayer(g, targetId);
        if (v.status === 'busted') throw new Error(`${v.name} already busted`);
        applySteal(g, holderId, targetId, sel.cardUid);
        break;
      }
      case 'discard': {
        const v = getPlayer(g, targetId);
        if (v.status === 'busted') throw new Error(`${v.name} already busted`);
        applyDiscard(g, holderId, targetId, sel.cardUid);
        break;
      }
      default: throw new Error('unknown action ' + action);
    }
  } catch (e) {
    // Stale pick (victim busted/emptied mid-choice): fizzle, never stuck, never leak.
    log(g, `${holder.name}'s ${pend.card.label} fizzles (${e.message})`);
  }
  if (g.phase === 'roundEnd' || g.phase === 'gameOver') { g.pending = null; return { ok: true }; }
  if (g.pending) return { ok: true }; // nested choice awaiting UI (chains back via cont)
  runCont(g, hcont);
  return { ok: true };
}
// ---- continuations ----
// A cont resumes suspended flow after a choice resolves:
//   { after }                              — fire after ('deal'|'turn'|jomStay), done
//   { frame:{targetId, cards, cont} }       — pop next queued Flip card, else run frame.cont
//   { after, next }                        — fire after, then run parent cont (nested JOM/Flip)
// Every card drawn from the deck lives in exactly one of: deck, discard,
// a hand/mods, a queued frame, or an unresolved pending — never dropped.
function runCont(g, cont) {
  let c = cont, guard = 0;
  while (c && guard++ < 500) {
    if (g.phase !== 'turns' && g.phase !== 'initialDeal') return;
    if (c.frame && c.frame.cards.length > 0) { popFrame(g, c); return; }
    if (c.after !== undefined) fireAfter(g, c.after);
    if (g.phase !== 'turns' && g.phase !== 'initialDeal') return;
    c = (c.frame && c.frame.cont) || c.next || null;
  }
}
function fireAfter(g, after) {
  if (g.phase !== 'turns' && g.phase !== 'initialDeal') return;
  if (after === 'deal') advanceDeal(g);
  else if (after === 'turn') advanceTurn(g);
  else if (after && after.type === 'jomStay') doJomStay(g, after.targetId);
}
function doJomStay(g, targetId) {
  const t = getPlayer(g, targetId);
  if (t.status === 'active' && g.phase === 'turns') {
    // JOM forces stay (even with Zero)
    t.status = 'stayed';
    log(g, `${t.name} stays (Just One More)`);
    checkRoundEnd(g);
  }
}
function popFrame(g, cont) {
  const f = cont.frame;
  const [card, ...rest] = f.cards;
  const nextCont = rest.length > 0
    ? { frame: { targetId: f.targetId, cards: rest, cont: f.cont } }
    : f.cont; // drained: continue parent continuation directly
  if (card.kind === 'modifier') {
    g.pending = { kind: 'modifierChoice', holderId: f.targetId, card, cont: nextCont };
  } else {
    g.pending = { kind: 'actionChoice', holderId: f.targetId, card, cont: nextCont };
  }
}

// ---- action effects ----
function applyJustOneMore(g, targetId, hcont) {
  const t = getPlayer(g, targetId);
  const nested = { after: { type: 'jomStay', targetId }, next: hcont || null };
  if (t.status === 'busted') return;
  const card = drawTop(g);
  if (!card) return;
  log(g, `Just One More: ${t.name} draws ${card.label}`);
  if (card.kind === 'number') {
    placeNumber(g, t, card);
    if (t.status !== 'busted' && checkFlip7(t)) { endRound(g, 'flip7', t.id); return; }
    if (t.status !== 'busted' && g.phase === 'turns') {
      t.status = 'stayed';
      log(g, `${t.name} stays (Just One More)`);
      checkRoundEnd(g);
    }
  } else if (card.kind === 'modifier') {
    if (g.mode === 'classic') {
      t.mods.push(card);
      if (t.status === 'active') { t.status = 'stayed'; log(g, `${t.name} stays (Just One More)`); }
    } else {
      g.pending = { kind: 'modifierChoice', holderId: t.id, card, cont: nested };
    }
  } else {
    g.pending = { kind: 'actionChoice', holderId: t.id, card, cont: nested };
  }
}

function applyFlipDraws(g, targetId, n, hcont) {
  const t = getPlayer(g, targetId);
  if (!t || t.status === 'busted') return;
  const queued = [];
  for (let i = 0; i < n; i++) {
    const card = drawTop(g);
    if (!card) break;
    log(g, `Flip${n===4?'Four':'Three'} [${i + 1}/${n}]: ${t.name} ← ${card.label}`);
    if (card.kind === 'number') {
      if (card.special === 'unlucky7') {
        placeNumber(g, t, card); // immediate wipe
        continue;
      }
      placeNumber(g, t, card);
      if (t.status === 'busted') {
        // void queue
        for (const q of queued) g.discard.push(q);
        log(g, `${t.name} busts mid-Flip — queued ${queued.length} voided`);
        checkRoundEnd(g);
        return;
      }
      if (checkFlip7(t)) { for (const q of queued) g.discard.push(q); endRound(g, 'flip7', t.id); return; }
    } else {
      queued.push(card); // delayed until all flips survive
    }
  }
  if (queued.length > 0) {
    // queued cards resolve in drawn order; then the holder's level continues
    runCont(g, { frame: { targetId: t.id, cards: queued, cont: hcont || null } });
  }
}

function applySwap(g, holderId, sel) {
  const { cardOwnerId, cardUid, cardOwnerId2, cardUid2 } = sel;
  if (!cardUid || !cardUid2) throw new Error('swap needs two cards');
  if (cardOwnerId === cardOwnerId2) throw new Error('swap needs two different players');
  const A = getPlayer(g, cardOwnerId);
  const B = getPlayer(g, cardOwnerId2);
  if (A.status === 'busted' || B.status === 'busted') throw new Error('cannot swap busted');
  const ra = removeCardFrom(A, cardUid);
  const rb = removeCardFrom(B, cardUid2);
  if (!ra || !rb) {
    // restore partial
    if (ra) (ra.where === 'hand' ? A.hand : A.mods).push(ra.card);
    if (rb) (rb.where === 'hand' ? B.hand : B.mods).push(rb.card);
    throw new Error('swap cards not found');
  }
  (ra.where === 'hand' ? B.hand : B.mods).push(ra.card);
  (rb.where === 'hand' ? A.hand : A.mods).push(rb.card);
  log(g, `${getPlayer(g, holderId).name} SWAPS ${A.name}'s ${ra.card.label} ⇄ ${B.name}'s ${rb.card.label}`);
  // receipt effects: U7 wipe for anyone who RECEIVED unlucky7
  for (const p of [A, B]) {
    const gotU7 = p.hand.some((c) => c.special === 'unlucky7' && (c.uid === cardUid || c.uid === cardUid2));
    if (gotU7) {
      const keptUid = p.hand.find((c) => c.special === 'unlucky7').uid;
      const wiped = p.hand.filter((c) => c.uid !== keptUid);
      const wm = [...p.mods];
      p.hand = p.hand.filter((c) => c.uid === keptUid);
      p.mods = [];
      g.discard.push(...wiped, ...wm);
      log(g, `${p.name} receives UNLUCKY 7 via swap — wipes to 7`);
    }
  }
  // bust/flip7 checks for both
  for (const p of [A, B]) {
    if (p.status !== 'busted' && checkBust(p)) bustPlayer(g, p, 'swap duplicate');
  }
  for (const p of [A, B]) {
    if (p.status !== 'busted' && checkFlip7(p)) { endRound(g, 'flip7', p.id); return; }
  }
  checkRoundEnd(g);
}

function applySteal(g, holderId, victimId, cardUid) {
  const h = getPlayer(g, holderId);
  const v = getPlayer(g, victimId);
  if (!cardUid) throw new Error('steal needs cardUid');
  const found = removeCardFrom(v, cardUid);
  if (!found) throw new Error('steal card not found');
  (found.where === 'hand' ? h.hand : h.mods).push(found.card);
  log(g, `${h.name} STEALS ${found.card.label} from ${v.name}`);
  if (found.card.special === 'unlucky7') {
    const keptUid = found.card.uid;
    const wiped = h.hand.filter((c) => c.uid !== keptUid);
    const wm = [...h.mods];
    h.hand = h.hand.filter((c) => c.uid === keptUid);
    h.mods = [];
    g.discard.push(...wiped, ...wm);
    log(g, `${h.name} stole UNLUCKY 7 — wipes to 7`);
    return;
  }
  if (h.status !== 'busted' && checkBust(h)) bustPlayer(g, h, 'steal duplicate');
  else if (h.status !== 'busted' && checkFlip7(h)) { endRound(g, 'flip7', h.id); return; }
}

function applyDiscard(g, holderId, victimId, cardUid) {
  const v = getPlayer(g, victimId);
  if (!cardUid) throw new Error('discard needs cardUid');
  const found = removeCardFrom(v, cardUid);
  if (!found) throw new Error('discard card not found');
  g.discard.push(found.card);
  log(g, `${getPlayer(g, holderId).name} DISCARDS ${v.name}'s ${found.card.label}`);
}

// ---- round/game end ----
export function endRound(g, reason, flip7PlayerId = null, brutalOpts = {}) {
  if (g.phase === 'roundEnd' || g.phase === 'gameOver') return { ok: true };
  g.phase = 'roundEnd';
  g.flip7PlayerId = flip7PlayerId;
  const scores = {};
  for (const p of g.players) {
    scores[p.id] = scorePlayer(g, p);
  }
  // brutal -15 choice: {minus15To: playerId} when flip7 happened
  if (g.brutal && flip7PlayerId && brutalOpts.minus15To) {
    scores[flip7PlayerId] -= 15; // remove the +15
    const t = getPlayer(g, brutalOpts.minus15To);
    t.total -= 0; // totals applied below; apply gift as round delta
    scores[brutalOpts.minus15To] = (scores[brutalOpts.minus15To] || 0) - 15;
    log(g, `${getPlayer(g, flip7PlayerId).name} sends −15 to ${t.name} (Brutal Flip7)`);
  }
  for (const p of g.players) {
    p.total += scores[p.id];
    p.roundScore = scores[p.id];
    // move cards to discard
    g.discard.push(...p.hand, ...p.mods);
    p.hand = []; p.mods = [];
  }
  g.lastScores = scores;
  log(g, `round ${g.round} ends (${reason}) scores ${JSON.stringify(scores)}`);
  const champ = g.players.some((p) => p.total >= g.target);
  if (champ) {
    g.phase = 'gameOver';
    const best = Math.max(...g.players.map((p) => p.total));
    g.winners = g.players.filter((p) => p.total === best).map((p) => p.id);
    log(g, `game over — winner(s): ${g.winners.join(',')} @ ${best}`);
  }
  return { ok: true, scores };
}

// ---- roster (drop / wait / mid-game join) ----
// Mid-round drop&reset: bust the seat out, hand stays face-down till round end.
export function markLeft(g, id) {
  const p = getPlayer(g, id);
  if (p.status === 'busted') { p.left = true; return; }
  if (g.phase === 'turns' || g.phase === 'initialDeal') {
    if (g.pending && (g.pending.holderId === id || g.pending.targetId === id)) {
      throw new Error('cannot drop while pending choice');
    }
    p.status = 'busted';
    p.left = true;
    log(g, `${p.name} left — reset for this round`);
    if (g.phase === 'turns') {
      if (currentPlayer(g).id === id) advanceTurn(g);
      else checkRoundEnd(g);
    }
  } else {
    removePlayer(g, id);
  }
}
// Between rounds (lobby/roundEnd/gameOver): remove seat entirely.
export function removePlayer(g, id) {
  if (['turns', 'initialDeal'].includes(g.phase)) throw new Error('remove only between rounds');
  const i = g.players.findIndex((x) => x.id === id);
  if (i < 0) return;
  const [p] = g.players.splice(i, 1);
  g.discard.push(...p.hand, ...p.mods);
  if (g.dealerIdx >= g.players.length) g.dealerIdx = -1;
  else if (i <= g.dealerIdx) g.dealerIdx -= 1;
  if (g.turnIdx >= g.players.length) g.turnIdx = 0;
  log(g, `${p.name} removed from roster`);
}
// Between rounds: add a seat (approved mid-game joiner, spectator promotion).
export function addPlayer(g, { id, name }) {
  if (['turns', 'initialDeal'].includes(g.phase)) throw new Error('add only between rounds');
  if (g.players.some((x) => x.id === id)) return getPlayer(g, id);
  const p = { id, name, hand: [], mods: [], status: 'active', total: 0, shield: false };
  g.players.push(p);
  log(g, `${name} joins the game`);
  return p;
}

// ---- snapshots (host migration) ----
export function snapshot(g) {
  const { _rand, ...rest } = g;
  return JSON.parse(JSON.stringify({ ...rest, seq: g.seq || 0 }));
}
export function restore(data) {
  const g = { ...JSON.parse(JSON.stringify(data)), _rand: Math.random, log: data.log || [] };
  return g;
}
export function serializeForLog(g) {
  return {
    round: g.round, phase: g.phase, dealer: g.players[g.dealerIdx]?.name,
    turn: g.players[g.turnIdx]?.name, totals: Object.fromEntries(g.players.map((p) => [p.name, p.total])),
  };
}
