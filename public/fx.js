// fx.js — cosmetic animation layer. Game state/sync untouched: snapshots
// apply instantly, this module diffs prev vs next and plays motion on top.
// Card motion is scoped to MY hand (perf); totals/turn cues are cheap DOM.
// Silent by design (no audio/vibration). Honors prefers-reduced-motion.

// ---------- pure diff (node-testable, no DOM) ----------

function handOf(snap, id) {
  return (snap?.players || []).find((p) => p.id === id) || null;
}

// Events for my hand: dealt+ (new number cards), mod+ (new modifiers),
// lost (removed cards: stolen/discarded/swapped away, U7 wipe),
// bust (active/stayed → busted), stay (active → stayed).
export function diffHands(prev, next, myId) {
  const evts = [];
  const po = prev ? handOf(prev, myId) : null;
  const pn = next ? handOf(next, myId) : null;
  if (!po || !pn) return evts;
  const prevU = new Set(po.hand.map((c) => c.uid));
  const nextU = new Set(pn.hand.map((c) => c.uid));
  const dealt = [], lost = [];
  for (const c of pn.hand) if (!prevU.has(c.uid)) dealt.push(c);
  for (const c of po.hand) if (!nextU.has(c.uid)) lost.push(c);
  const prevM = new Set(po.mods.map((c) => c.uid));
  const mods = pn.mods.filter((c) => !prevM.has(c.uid));
  if (dealt.length) evts.push({ type: 'dealt', cards: dealt });
  if (mods.length) evts.push({ type: 'mod', cards: mods });
  if (lost.length) evts.push({ type: 'lost', cards: lost });
  if (po.status !== 'busted' && pn.status === 'busted') evts.push({ type: 'bust' });
  if (po.status === 'active' && pn.status === 'stayed') evts.push({ type: 'stay' });
  return evts;
}

// { id: { from, to } } for changed totals (round-end count-ups).
export function diffTotals(prev, next) {
  const out = {};
  if (!prev || !next) return out;
  const pm = Object.fromEntries((prev.players || []).map((p) => [p.id, p.total]));
  for (const p of next.players || []) {
    if (pm[p.id] !== undefined && pm[p.id] !== p.total) out[p.id] = { from: pm[p.id], to: p.total };
  }
  return out;
}

// Card to spotlight in the bust shake (display only; engine owns the truth).
export function findDuplicateUid(hand) {
  const seen = {};
  for (const c of hand) {
    if (c.value === 13) continue; // Lucky-13 nuance ignored on stage
    if (seen[c.value]) return c.uid;
    seen[c.value] = true;
  }
  const s2 = {};
  for (const c of hand) {
    if (s2[c.value]) return c.uid;
    s2[c.value] = true;
  }
  return hand.length ? hand[hand.length - 1].uid : null;
}

export function reducedMotion() {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ---------- DOM player (browser only; no-ops without document) ----------

// Fly freshly dealt cards from the deck anchor to their slots.
// The real elements are already rendered: hide, fly a clone, reveal.
export function playDealt(container, uids, anchorEl, staggerMs = 90) {
  if (typeof document === 'undefined' || reducedMotion()) return;
  if (!container || !anchorEl) return;
  uids.forEach((uid, i) => {
    const el = container.querySelector(`[data-uid="${uid}"]`);
    if (!el) return;
    const start = () => {
      const r = el.getBoundingClientRect();
      if (r.width === 0) return; // off-screen: skip motion, keep card
      const a = anchorEl.getBoundingClientRect();
      const dx = a.left + a.width / 2 - (r.left + r.width / 2);
      const dy = a.top + a.height / 2 - (r.top + r.height / 2);
      const ghost = el.cloneNode(true);
      ghost.removeAttribute('data-uid');
      ghost.style.cssText += `;position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;margin:0;z-index:50;pointer-events:none;` +
        `transform:translate(${dx}px,${dy}px) scale(.45);opacity:.35;transition:transform .45s cubic-bezier(.2,.7,.3,1.05),opacity .45s;`;
      el.style.visibility = 'hidden';
      document.body.appendChild(ghost);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        ghost.style.transform = 'none';
        ghost.style.opacity = '1';
      }));
      setTimeout(() => { ghost.remove(); el.style.visibility = ''; }, 500);
    };
    if (i === 0 || !staggerMs) start();
    else setTimeout(start, i * staggerMs);
  });
}

// Tween <b data-pid> totals inside a score container from old to new.
export function tweenTotals(container, deltas, durMs = 750) {
  if (typeof document === 'undefined' || typeof requestAnimationFrame === 'undefined') return;
  if (reducedMotion()) return;
  for (const [pid, { from, to }] of Object.entries(deltas)) {
    const b = container.querySelector(`[data-pid="${pid}"]`);
    if (!b) continue;
    if (b._tween) cancelAnimationFrame(b._tween);
    const t0 = performance.now();
    b.textContent = String(from);
    const step = (t) => {
      const k = Math.min(1, (t - t0) / durMs);
      const eased = 1 - Math.pow(1 - k, 3);
      b.textContent = String(Math.round(from + (to - from) * eased));
      if (k < 1) b._tween = requestAnimationFrame(step);
      else { b.textContent = String(to); b._tween = null; }
    };
    b._tween = requestAnimationFrame(step);
  }
}
