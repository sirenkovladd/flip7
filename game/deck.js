// Shared deck builders — pure, no DOM. Used by host client + tests.
// Card: { uid, kind:'number'|'modifier'|'action', label, value?, special?, modifier?, action? }
let uidCounter = 0;
export function mkUid(prefix = 'c') {
  uidCounter += 1;
  return `${prefix}${Date.now().toString(36)}${uidCounter}`;
}
export function resetUidCounter() { uidCounter = 0; }

export const VENGEANCE_ACTIONS = ['justOneMore', 'swap', 'steal', 'discard', 'flipFour'];
export const CLASSIC_ACTIONS = ['freeze', 'flipThree', 'secondChance'];

export function numCard(value, special = null, label = null) {
  return { uid: mkUid('n'), kind: 'number', value, special, label: label || specialLabel(value, special) };
}
function specialLabel(value, special) {
  if (special === 'zero') return '0 ★ Zero';
  if (special === 'unlucky7') return '7 ☠ Unlucky 7';
  if (special === 'lucky13') return '13 🍀 Lucky 13';
  return String(value);
}
export function modCard(modifier) {
  const labels = { x2: '×2', plus2: '+2', plus4: '+4', plus6: '+6', plus8: '+8', plus10: '+10', div2: '÷2', minus2: '−2', minus4: '−4', minus6: '−6', minus8: '−8', minus10: '−10' };
  return { uid: mkUid('m'), kind: 'modifier', modifier, label: labels[modifier] || modifier };
}
export function actionCard(action) {
  const labels = { freeze: 'Freeze ❄', flipThree: 'Flip Three +3', secondChance: '2nd Chance ♥', justOneMore: 'Just 1 More +1', swap: 'Swap ⇄', steal: 'Steal ✋', discard: 'Discard 🗑', flipFour: 'Flip Four +4' };
  return { uid: mkUid('a'), kind: 'action', action, label: labels[action] || action };
}

// Vengeance numbers: 0×1(zero),1×1,2×2..6×6,7×6+U7×1,8×8..12×12,13×12+L13×1 = 92
export function vengeanceNumbers() {
  const out = [];
  out.push(numCard(0, 'zero'));
  for (let v = 1; v <= 13; v++) {
    if (v === 7) {
      for (let i = 0; i < 6; i++) out.push(numCard(7));
      out.push(numCard(7, 'unlucky7'));
    } else if (v === 13) {
      for (let i = 0; i < 12; i++) out.push(numCard(13));
      out.push(numCard(13, 'lucky13'));
    } else {
      for (let i = 0; i < v; i++) out.push(numCard(v));
    }
  }
  return out;
}
export function vengeanceModifiers() {
  return ['div2', 'minus2', 'minus4', 'minus6', 'minus8', 'minus10'].map(modCard);
}
export function vengeanceActions() {
  const out = [];
  for (const a of VENGEANCE_ACTIONS) { out.push(actionCard(a)); out.push(actionCard(a)); }
  return out;
}
// Classic numbers: 0×1,1×1..12×12 = 79
export function classicNumbers() {
  const out = [numCard(0)];
  for (let v = 1; v <= 12; v++) for (let i = 0; i < v; i++) out.push(numCard(v));
  return out;
}
export function classicModifiers() {
  return ['plus2', 'plus4', 'plus6', 'plus8', 'plus10', 'x2'].map(modCard);
}
export function classicActions() {
  const out = [];
  for (const a of CLASSIC_ACTIONS) for (let i = 0; i < 3; i++) out.push(actionCard(a));
  return out;
}

export function buildDeck(mode = 'vengeance', numDecks = 1, rand = Math.random) {
  let single;
  if (mode === 'classic') single = [...classicNumbers(), ...classicModifiers(), ...classicActions()];
  else single = [...vengeanceNumbers(), ...vengeanceModifiers(), ...vengeanceActions()];
  let deck = [];
  for (let d = 0; d < numDecks; d++) {
    // re-uid per deck copy so identities are unique
    for (const c of single) deck.push({ ...c, uid: mkUid('d') });
  }
  // Fisher-Yates with injected rand
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export function deckCounts(deck) {
  const c = { number: 0, modifier: 0, action: 0, total: deck.length };
  for (const k of deck) c[k.kind] += 1;
  return c;
}
