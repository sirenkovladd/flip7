// Flip 7 browser client.
// Layers: Net (WS auto-reconnect) + Host (runs game/engine.js when isHost)
// + UI (personal view default, Table toggle). No P2P: WS to Go server.
'use strict';

import * as FX from '/fx.js?v=0.3.0';

const $ = (id) => document.getElementById(id);
const APP_V = '0.3.1';

let E = null; // engine module, loaded lazily on host
async function engine() {
  if (!E) E = await import(`/game/engine.js?v=${APP_V}`);
  return E;
}

const S = {
  ws: null, retryMs: 500, shouldRun: true,
  room: null, pass: null,
  me: { id: null, token: null, name: '', isHost: false, spectator: false },
  seats: [], settings: {}, inGame: false,
  snap: null, seq: 0,
  G: null, // host engine state
  hostSeq: 0,
  joinReqs: [], dropped: [],
  tableMode: false,
  choice: {}, // staged picker state
};
function sessLoad() { try { return JSON.parse(localStorage.getItem('flip7sess') || 'null'); } catch { return null; } }
function sessSave(s) { localStorage.setItem('flip7sess', JSON.stringify(s)); }
function sessClear() { localStorage.removeItem('flip7sess'); }

// ---------- net ----------
function wsURL() {
  const p = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${p}//${location.host}/ws`;
}
function connect() {
  S.ws = new WebSocket(wsURL());
  setDot('wait');
  S.ws.onopen = () => {
    setDot('on'); S.retryMs = 500;
    const s = sessLoad();
    if (s && s.room && !S.room) {
      // auto-rejoin with token → same seat, same hand
      send({ t: 'join', room: s.room, name: s.name || $('nameInput').value, playerId: s.playerId, token: s.token });
    }
  };
  S.ws.onmessage = (ev) => route(JSON.parse(ev.data));
  S.ws.onclose = () => {
    setDot('off');
    if (!S.shouldRun) return;
    setTimeout(connect, S.retryMs);
    S.retryMs = Math.min(S.retryMs * 2, 8000);
  };
}
function send(m) {
  if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(m));
}
function setDot(cls) { $('connDot').className = 'dot ' + cls; }

// ---------- routing ----------
function route(m) {
  switch (m.t) {
    case 'created':
      S.room = m.room; S.pass = m.password || S.pass;
      S.me.id = m.playerId; S.me.token = m.token;
      sessSave({ room: S.room, playerId: m.playerId, token: m.token, name: S.me.name });
      break;
    case 'joined':
      S.me.id = m.playerId; S.me.token = m.token;
      sessSave({ room: S.room || m.room, playerId: m.playerId, token: m.token, name: S.me.name });
      S.room = S.room || m.room;
      break;
    case 'room': onRoom(m); break;
    case 'seats': S.seats = m.seats; syncMe(); render(); break;
    case 'state': setSnap(m.snapshot); S.seq = m.seq; render(); break;
    case 'intent': onIntent(m); break; // host only
    case 'peerMsg': onPeerMsg(m); break;
    case 'joinRequest': S.joinReqs.push({ id: m.requestId, name: m.fromName }); render(); break;
    case 'joinWithdrawn': S.joinReqs = S.joinReqs.filter((r) => r.id !== m.requestId); render(); break;
    case 'peerDropped':
      if (!S.dropped.some((d) => d.id === m.playerId)) S.dropped.push({ id: m.playerId, name: m.fromName });
      render(); break;
    case 'peerRejoined': S.dropped = S.dropped.filter((d) => d.id !== m.playerId); render(); break;
    case 'hostGone': banner(`Host ${esc(m.hostName)} dropped — 10s to return, then server picks next host.`); break;
    case 'hostBack': banner(`Host is back.`); setTimeout(clearBanner, 3000); render(); break;
    case 'hostChanged': onHostChanged(m); break;
    case 'roomPass': S.pass = m.password; renderPass(); break;
    case 'waitingApproval': showHome(`Knocking… wait for the host to let you in (${esc(m.room)}).`); break;
    case 'joinDenied': showHome(`Join denied: ${esc(m.reason)}`); sessClear(); break;
    case 'dropped':
      sessClear();
      S.room = null; S.snap = null; S.G = null; S.seats = []; S.dropped = []; S.joinReqs = [];
      S.me = { id: null, token: null, name: S.me.name, isHost: false, spectator: false };
      showHome(`Removed from the room (${esc(m.reason || 'by host')}). Rejoin only if they let you.`);
      break;
    case 'error': toast(m.reason); break;
    case 'pong': break;
  }
}

function onRoom(m) {
  S.seats = m.seats; S.settings = m.settings; S.inGame = m.inGame;
  if (!m.inGame) S.choice = {};
  if (m.snapshot && !S.me.isHost) {
    // Followers track the server's latest snapshot.
    setSnap(m.snapshot); S.seq = m.seq || 0;
  } else if (m.snapshot && S.me.isHost && (m.seq || 0) > S.hostSeq) {
    // Defensive: host fell behind (e.g. missed its own broadcast).
    // Adopt the newer snapshot rather than staying stuck.
    adoptSnapshot(m.snapshot, m.seq || 0);
  }
  // NOTE: a host NEVER applies room snapshots with seq <= its own:
  // its local engine is always ahead (e.g. the stale echo of its own
  // `start` message arriving after the fresh `state` was rendered).
  syncMe(); render();
}
async function adoptSnapshot(snap, seq) {
  const eng = await engine();
  S.G = eng.restore(snap);
  S.hostSeq = seq;
  setSnap(window.__E_snapshot(S.G));
  render();
}
function setSnap(s) { S.prevSnap = S.snap; S.snap = s; }
function syncMe() {
  const me = S.seats.find((s) => s.id === S.me.id);
  if (me) { S.me.isHost = me.isHost; S.me.spectator = me.spectator; }
  else if (S.me.id) { S.me.isHost = false; }
}
async function onHostChanged(m) {
  if (m.hostId === S.me.id) {
    // Server picked ME: restore the exact snapshot and keep hosting.
    const eng = await engine();
    S.G = eng.restore(m.snapshot);
    S.hostSeq = m.seq || 0;
    S.me.isHost = true;
    banner('You are the host now — game continues.');
    pumpAndBroadcast();
  } else {
    banner(`New host: ${esc(m.hostName)}. Game continues.`);
  }
  render();
}

// ---------- host engine glue ----------
async function becomeHostEngine() {
  const eng = await engine();
  const seats = S.seats; // fresh start: everyone at the table plays
  S.G = eng.createGame({
    mode: S.settings.mode, target: S.settings.target, brutal: S.settings.brutal,
    numDecks: eng.autoDecks(seats.length),
    players: seats.map((s) => ({ id: s.id, name: s.name })),
  });
}
function broadcast() {
  if (!S.G) return;
  S.hostSeq += 1;
  send({ t: 'state', seq: S.hostSeq, snapshot: S.G && window.__E_snapshot(S.G) });
}
// snapshot() strips _rand (functions can't cross WS anyway)
window.__E_snapshot = (g) => {
  const { _rand, ...rest } = g;
  return JSON.parse(JSON.stringify(rest));
};

async function pumpAndBroadcast() {
  if (!S.G || !S.me.isHost) return;
  const eng = await engine();
  try {
    let guard = 0;
    while (S.G.phase === 'initialDeal' && !S.G.pending && guard++ < 500) eng.dealNext(S.G);
  } catch (e) { console.warn('pump', e); }
  setSnap(window.__E_snapshot(S.G));
  render();
  broadcast();
}

function peerError(to, err) {
  send({ t: 'toPeer', to, payload: { err: String(err && err.message || err) } });
}
function onPeerMsg(m) {
  const p = m.payload || {};
  if (p.err) toast(p.err);
}

async function onIntent(m) {
  if (!S.me.isHost || !S.G) return;
  const eng = await engine();
  const from = m.from, p = m.payload || {};
  try {
    if (p.op === 'hit') eng.requestHit(S.G, from);
    else if (p.op === 'stay') eng.requestStay(S.G, from);
    else if (p.op === 'modifierTarget') eng.resolveModifierChoice(S.G, { holderId: from, targetId: p.targetId });
    else if (p.op === 'actionTarget') {
      eng.resolveActionChoice(S.G, {
        holderId: from, targetId: p.targetId,
        cardUid: p.cardUid, cardOwnerId: p.cardOwnerId,
        cardUid2: p.cardUid2, cardOwnerId2: p.cardOwnerId2,
      });
    } else return;
  } catch (e) { peerError(from, e); return; }
  pumpAndBroadcast();
}

// unified player action: host applies locally, others send intent
async function doOp(op) {
  if (S.me.spectator) return;
  if (S.me.isHost) {
    const eng = await engine();
    try {
      if (op.op === 'hit') eng.requestHit(S.G, S.me.id);
      else if (op.op === 'stay') eng.requestStay(S.G, S.me.id);
      else if (op.op === 'modifierTarget') eng.resolveModifierChoice(S.G, { holderId: S.me.id, targetId: op.targetId });
      else if (op.op === 'actionTarget') {
        eng.resolveActionChoice(S.G, {
          holderId: S.me.id, targetId: op.targetId,
          cardUid: op.cardUid, cardOwnerId: op.cardOwnerId,
          cardUid2: op.cardUid2, cardOwnerId2: op.cardOwnerId2,
        });
      }
    } catch (e) { toast(e.message); return; }
    S.choice = {};
    pumpAndBroadcast();
  } else {
    send({ t: 'toHost', payload: op });
  }
}

// ---------- rendering ----------
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function show(view) {
  for (const v of ['view-home', 'view-lobby', 'view-game']) $(v).hidden = v !== view;
}
function toast(msg) {
  banner(esc(msg)); setTimeout(() => { if (!$('banner').dataset.sticky) clearBanner(); }, 3500);
}
function banner(html, sticky) {
  const b = $('banner'); b.innerHTML = html; b.hidden = false;
  if (sticky) b.dataset.sticky = '1'; else delete b.dataset.sticky;
  if (!sticky && $('view-game').hidden) { /* lobby uses alerts instead */ }
}
function clearBanner() { $('banner').hidden = true; $('banner').innerHTML = ''; }
function showHome(msg) { show('view-home'); if (msg) $('homeErr').innerHTML = msg; }

function mePlayer() {
  if (!S.snap) return null;
  return (S.snap.players || []).find((p) => p.id === S.me.id) || null;
}
function alivePlayers() { return (S.snap?.players || []).filter((p) => p.status !== 'busted'); }

function render() {
  $('tableToggleWrap').hidden = !(S.room && (S.snap || S.me.isHost));
  if (!S.room) { show('view-home'); return; }
  // Lobby doubles as the score room: any time we're not playing, show it
  // (fresh room, paused game, round break, or finished match).
  if (!S.inGame) { renderLobby(); show('view-lobby'); return; }
  if (!S.snap) { renderLobby(); show('view-lobby'); return; } // follower awaiting first state
  renderGame(); show('view-game');
}

function renderLobby() {
  $('roomCode').textContent = S.room || '------';
  $('seatCount').textContent = `(${S.seats.length})`;
  $('lobbySettings').textContent =
    `${S.settings.mode === 'classic' ? 'Classic' : 'With a Vengeance'} · 🎯 ${S.settings.target}` +
    `${S.settings.brutal ? ' · Brutal' : ''} · joins: ${S.settings.autoApprove}`;
  $('modeBadge').hidden = true;
  $('seatList').innerHTML = S.seats.map((s) =>
    `<li>${esc(s.name)} ${s.isHost ? '<span class="tag host">HOST</span>' : ''}` +
    `${s.spectator ? '<span class="tag spec">WATCH</span>' : ''}` +
    `${s.waiting ? '<span class="tag">WAITING</span>' : ''}` +
    `${!s.connected ? '<span class="tag off">OFFLINE</span>' : ''}` +
    `${(S.me.isHost && s.id !== S.me.id) ? `<button data-kick="${s.id}" data-name="${esc(s.name)}" class="danger">Kick</button>` : ''}</li>`).join('');
  $('seatList').querySelectorAll('[data-kick]').forEach((b) => {
    b.onclick = () => kickSeat(b.dataset.kick, b.dataset.name);
  });
  // Lobby buttons depend on match state: fresh → Start; break/pause → Resume;
  // scores present → New match offers an explicit reset. Scores are never reset otherwise.
  const snap = S.snap;
  const hasMatch = !!(snap && (snap.players || []).length);
  const phase = snap?.phase;
  $('scorePanel').hidden = !hasMatch;
  if (hasMatch) {
    $('lobbyScores').innerHTML = (snap.players || []).map((p) =>
      `<span>${esc(p.name)}: <b>${p.total}</b>${(snap.winners || []).includes(p.id) ? ' 🏆' : ''}</span>`).join('');
  }
  const pausedMidRound = hasMatch && (phase === 'turns' || phase === 'initialDeal');
  $('startBtn').hidden = !(S.me.isHost && !hasMatch);
  $('resumeBtn').hidden = !(S.me.isHost && hasMatch && phase !== 'gameOver');
  if (hasMatch && phase !== 'gameOver') {
    $('resumeBtn').textContent = pausedMidRound ? `Resume round ${snap.round}` : `Resume — Round ${snap.round + 1}`;
  }
  $('newMatchBtn').hidden = !(S.me.isHost && hasMatch);
  $('showPassBtn').hidden = !S.me.isHost;
  const ap = $('approvalPanel');
  ap.hidden = !(S.me.isHost && S.joinReqs.length);
  $('approvalList').innerHTML = S.joinReqs.map((r) =>
    `<li>${esc(r.name)}<button data-approve="${r.id}">Let in</button><button data-deny="${r.id}">Deny</button></li>`).join('');
  $('approvalList').querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.approve || b.dataset.deny;
      send({ t: 'joinDecision', requestId: id, approve: !!b.dataset.approve });
      S.joinReqs = S.joinReqs.filter((r) => r.id !== id);
      render();
    };
  });
  renderPass();
}

function renderPass() {
  $('passLine').textContent = S.pass ? `password: ${S.pass}` : '';
  renderQR();
}
function inviteLink() {
  return `${location.origin}/?r=${S.room}${S.pass ? `&p=${encodeURIComponent(S.pass)}` : ''}`;
}
function renderQR() {
  const wrap = $('qrWrap');
  if (!S.room || !S.pass || typeof qrcode === 'undefined') { wrap.hidden = true; return; }
  const link = inviteLink();
  if (S._qrLink === link) { wrap.hidden = false; return; }
  try {
    const qr = qrcode(0, 'M');
    qr.addData(link);
    qr.make();
    $('qrBox').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    S._qrLink = link;
    wrap.hidden = false;
  } catch { wrap.hidden = true; }
}

function cardHTML(c, facedown) {
  if (facedown) return `<div class="card facedown" data-uid="${c.uid || ''}">🂠</div>`;
  let cls = 'card', sub = '';
  if (c.kind === 'modifier') { cls += ' mod'; }
  else if (c.kind === 'action') { cls += ' act'; }
  else {
    if (c.special === 'zero') { cls += ' zero'; sub = '<small>ZERO</small>'; }
    else if (c.special === 'unlucky7') { cls += ' unlucky'; sub = '<small>UNLUCKY</small>'; }
    else if (c.special === 'lucky13') { cls += ' lucky'; sub = '<small>LUCKY</small>'; }
  }
  return `<div class="${cls}" data-uid="${c.uid || ''}">${esc(c.label)}${sub}</div>`;
}

function renderGame() {
  const g = S.snap;
  S.fxGen = (S.fxGen || 0) + 1;
  clearTimeout(S.bustT); // a fresher snapshot cancels staged drama
  const evts = (S.prevSnap && S.me.id) ? FX.diffHands(S.prevSnap, S.snap, S.me.id) : [];
  $('modeBadge').hidden = false;
  $('modeBadge').textContent = g.mode === 'classic' ? 'Classic' : 'Vengeance';
  $('roundLine').textContent = `Round ${g.round}`;
  $('deckLine').textContent = `🂠 ${g.deck ? g.deck.length : '?'}`;
  $('targetLine').textContent = `🎯 ${S.settings.target || g.target}`;
  const dealer = (g.players || [])[g.dealerIdx];
  $('dealerLine').textContent = dealer ? `Dealer: ${dealer.name}` : '';
  const turn = g.phase === 'turns' ? (g.players || [])[g.turnIdx] : null;
  $('turnLine').textContent = turn ? `▶ ${turn.name}` : (g.phase === 'roundEnd' ? 'Round over' : g.phase === 'gameOver' ? 'Game over 🏆' : 'Dealing…');
  $('scoreLine').innerHTML = (g.players || []).map((p) =>
    `<span>${esc(p.name)}: <b data-pid="${p.id}">${p.total}</b>${p.roundScore != null && g.phase !== 'turns' && g.phase !== 'initialDeal' ? ` (+${p.roundScore})` : ''}` +
    `${(g.winners || []).includes(p.id) ? ' 🏆' : ''}</span>`).join('');
  if (S.prevSnap) FX.tweenTotals($('scoreLine'), FX.diffTotals(S.prevSnap, S.snap));

  const me = mePlayer();
  const forcedTable = S.me.spectator || !me;
  const showTable = forcedTable || S.tableMode;
  $('tablePanel').hidden = !showTable;
  $('tableToggle').checked = S.tableMode;

  if (!me) {
    $('myTitle').textContent = 'Spectating 👀';
    $('myStatus').textContent = 'You join as a player next round.';
    $('myCards').innerHTML = ''; $('myMods').innerHTML = '';
  } else {
    $('myTitle').textContent = `${me.name}'s cards ${me.status !== 'active' ? `(${me.status.toUpperCase()})` : ''}`;
    const zero = (me.hand || []).some((c) => c.special === 'zero');
    $('myStatus').textContent =
      me.status === 'busted' ? 'Busted — 0 this round.' :
      me.status === 'stayed' ? 'Stayed — locked in (still targetable!).' :
      g.phase !== 'turns' ? '' :
      zero && g.mode === 'vengeance' ? 'ZERO: you must HIT.' : (turn && turn.id === me.id ? 'Your turn!' : `Waiting for ${turn ? turn.name : '…'}`);
    // Bust drama: face-up shake ~1.2s, then the normal face-down render.
    // Purely cosmetic — state is already busted, input already hidden.
    const bkey = me.status === 'busted' ? `${g.round}:${(me.hand || []).map((c) => c.uid).join(',')}` : null;
    const bustNew = bkey && evts.some((e) => e.type === 'bust') && S.bustAck !== bkey && !FX.reducedMotion();
    if (bustNew) {
      S.bustAck = bkey;
      const gen = S.fxGen;
      $('myCards').innerHTML = (me.hand || []).map((c) => cardHTML(c, false)).join('');
      $('myMods').innerHTML = (me.mods || []).map((c) => cardHTML(c, false)).join('');
      $('myCards').classList.add('busting');
      const dup = FX.findDuplicateUid(me.hand || []);
      const dupEl = dup && $('myCards').querySelector(`[data-uid="${dup}"]`);
      if (dupEl) dupEl.classList.add('shake');
      S.bustT = setTimeout(() => { if (S.fxGen === gen) render(); }, 1250);
    } else {
      $('myCards').classList.remove('busting');
      const down = me.status === 'busted';
      $('myCards').innerHTML = (me.hand || []).map((c) => cardHTML(c, down)).join('') || '<span class="hint">no cards yet</span>';
      $('myMods').innerHTML = (me.mods || []).map((c) => cardHTML(c, down)).join('');
      // enter motion for fresh cards + soft cues for stay/loss
      const dealtU = evts.filter((e) => e.type === 'dealt').flatMap((e) => e.cards.map((c) => c.uid));
      const modU = evts.filter((e) => e.type === 'mod').flatMap((e) => e.cards.map((c) => c.uid));
      FX.playDealt($('myCards'), dealtU, $('deckLine'));
      FX.playDealt($('myMods'), modU, $('deckLine'));
      if (evts.some((e) => e.type === 'stay') || evts.some((e) => e.type === 'lost')) {
        $('myCards').classList.add('cue');
        setTimeout(() => $('myCards').classList.remove('cue'), 450);
      }
    }
  }

  if (showTable) {
    $('tableHands').innerHTML = (g.players || []).filter((p) => !me || p.id !== me.id).map((p) =>
      `<div class="opp"><h3>${esc(p.name)} <small>(${p.status}, total ${p.total})</small></h3>` +
      `<div class="hand">${(p.hand || []).map((c) => cardHTML(c, p.status === 'busted')).join('')}</div>` +
      `<div class="hand mods">${(p.mods || []).map((c) => cardHTML(c, false)).join('')}</div></div>`).join('');
  }

  // action bar
  const canAct = me && me.status === 'active' && g.phase === 'turns' && turn && turn.id === me.id && !S.me.spectator;
  const zero = me && (me.hand || []).some((c) => c.special === 'zero') && g.mode === 'vengeance';
  $('hitBtn').disabled = !canAct;
  $('stayBtn').disabled = !canAct || !!zero;
  $('hitBtn').style.display = canAct ? '' : 'none';
  $('stayBtn').style.display = canAct && !zero ? '' : 'none';
  document.querySelector('.actionbar').style.display = canAct ? '' : 'none';
  $('statusPanel').classList.toggle('myturn', !!canAct);

  $('nextRoundBtn').hidden = !(S.me.isHost && (g.phase === 'roundEnd' || g.phase === 'gameOver'));
  $('nextRoundBtn').textContent = g.phase === 'gameOver' ? 'New game' : 'Next round';
  $('toLobbyBtn').hidden = !S.me.isHost;
  $('leaveGameBtn').hidden = S.me.isHost;

  renderChoice();
  renderNotices();
  const log = $('logBox');
  log.innerHTML = (g.log || []).slice(-30).reverse().map((l) => `<div>${esc(l)}</div>`).join('');
}

// Engine-side removal shared by drop (offline) and kick (online).
async function removeSeatLocal(id) {
  if (!S.G) return true;
  const eng = await engine();
  try {
    if (['turns', 'initialDeal'].includes(S.G.phase)) eng.markLeft(S.G, id);
    else eng.removePlayer(S.G, id);
  } catch (e) { toast(e.message); return false; }
  return true;
}
async function kickSeat(id, name) {
  if (!confirm(`Kick ${name}? They can't rejoin this room.`)) return;
  if (!(await removeSeatLocal(id))) return;
  send({ t: 'seatDecision', playerId: id, decision: 'kick' });
  S.dropped = S.dropped.filter((d) => d.id !== id);
  pumpAndBroadcast();
}
function renderNotices() {
  const box = $('noticePanel');
  let html = '';
  if (S.me.isHost) {
    for (const d of S.dropped) {
      html += `<div class="panel accent"><b>${esc(d.name)}</b> dropped. ` +
        `<button data-wait="${d.id}">Wait (auto-rejoin)</button> ` +
        `<button data-drop="${d.id}" class="danger">Drop &amp; reset</button></div>`;
    }
  }
  // Mid-game knocks must be visible here, not just in the lobby.
  for (const q of S.joinReqs) {
    html += `<div class="panel accent">🚪 <b>${esc(q.name)}</b> wants in. ` +
      `<button data-approve="${q.id}">Let in</button> ` +
      `<button data-deny="${q.id}">Deny</button></div>`;
  }
  box.innerHTML = html;
  box.querySelectorAll('[data-approve],[data-deny]').forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.approve || b.dataset.deny;
      send({ t: 'joinDecision', requestId: id, approve: !!b.dataset.approve });
      S.joinReqs = S.joinReqs.filter((r) => r.id !== id);
      render();
    };
  });
  box.querySelectorAll('button').forEach((b) => {
    if (b.dataset.approve || b.dataset.deny) return; // handled above
    b.onclick = async () => {
      const id = b.dataset.wait || b.dataset.drop;
      const wait = !!b.dataset.wait;
      if (!wait && !(await removeSeatLocal(id))) return;
      send({ t: 'seatDecision', playerId: id, decision: wait ? 'wait' : 'drop' });
      S.dropped = S.dropped.filter((d) => d.id !== id);
      pumpAndBroadcast();
    };
  });
  // Host player list with kick (works on online players, unlike the drop box above).
  const pp = $('playersPanel');
  if (!S.me.isHost) { pp.hidden = true; return; }
  pp.hidden = false;
  $('gameSeatList').innerHTML = S.seats.map((s) =>
    `<li>${esc(s.name)} ${s.isHost ? '<span class="tag host">HOST</span>' : ''}` +
    `${s.spectator ? '<span class="tag spec">WATCH</span>' : ''}` +
    `${!s.connected ? '<span class="tag off">OFFLINE</span>' : ''}` +
    `${(s.id !== S.me.id) ? `<button data-kick="${s.id}" data-name="${esc(s.name)}" class="danger">Kick</button>` : ''}</li>`).join('');
  $('gameSeatList').querySelectorAll('[data-kick]').forEach((b) => {
    b.onclick = () => kickSeat(b.dataset.kick, b.dataset.name);
  });
}

// ---------- pending choice picker ----------
function validTargetsLocal(action) {
  const ps = S.snap.players || [];
  const me = S.me.id;
  if (S.snap.mode === 'classic') {
    if (action === 'freeze' || action === 'flipThree') return ps.filter((p) => p.status === 'active' && p.id !== me);
    if (action === 'secondChance') return ps.filter((p) => p.status === 'active' && !p.shield);
    return [];
  }
  const alive = ps.filter((p) => p.status !== 'busted');
  if (action === 'steal') return alive.filter((p) => p.id !== me && ((p.hand || []).length + (p.mods || []).length) > 0);
  if (action === 'discard') return alive.filter((p) => ((p.hand || []).length + (p.mods || []).length) > 0);
  return alive;
}
function faceCards(pid) {
  const p = (S.snap.players || []).find((x) => x.id === pid);
  if (!p) return [];
  return [...(p.hand || []).map((c) => ({ ...c, owner: pid, where: 'hand' })),
    ...(p.mods || []).map((c) => ({ ...c, owner: pid, where: 'mods' }))];
}

function renderChoice() {
  const panel = $('choicePanel'), body = $('choiceBody');
  const pend = S.snap && S.snap.pending;
  if (!pend || pend.holderId !== S.me.id || S.me.spectator) { panel.hidden = true; body.innerHTML = ''; return; }
  panel.hidden = false;
  const ch = S.choice;
  if (pend.kind === 'modifierChoice') {
    $('choiceTitle').textContent = `Give ${pend.card.label} to…`;
    const tgts = S.snap.brutal ? S.snap.players : alivePlayers();
    body.innerHTML = `<div class="pickgrid">` + tgts.map((p) =>
      `<button data-t="${p.id}">${esc(p.name)}${p.id === S.me.id ? ' (you)' : ''}</button>`).join('') + `</div>`;
    body.querySelectorAll('button').forEach((b) => b.onclick = () => doOp({ op: 'modifierTarget', targetId: b.dataset.t }));
    return;
  }
  const a = pend.card.action;
  const names = { justOneMore: 'Just 1 More: force a draw, then they stay', swap: 'Swap: pick TWO cards from different players', steal: 'Steal: take a card', discard: 'Discard: remove a card', flipFour: 'Flip Four: force 4 draws', freeze: 'Freeze: lock a player', flipThree: 'Flip Three: force 3 draws', secondChance: '2nd Chance: protect someone' };
  if (a === 'swap') return renderSwapPicker(body, ch);
  if (a === 'steal' || a === 'discard') {
    const needVictim = !ch.step;
    if (needVictim) {
      $('choiceTitle').textContent = `${names[a]} — pick player`;
      const tgts = validTargetsLocal(a);
      // Nobody pickable (e.g. early game, everyone cardless/busted):
      // offer the fizzle explicitly instead of stranding the table.
      if (!tgts.length) { fizzleBox(body, 'Nobody to target'); return; }
      body.innerHTML = `<div class="pickgrid">` + tgts.map((p) =>
        `<button data-t="${p.id}">${esc(p.name)}${p.id === S.me.id ? ' (you)' : ''}</button>`).join('') + `</div>`;
      body.querySelectorAll('button').forEach((b) => b.onclick = () => { S.choice = { step: 'card', victim: b.dataset.t }; renderChoice(); });
    } else {
      $('choiceTitle').textContent = `${names[a]} — pick card`;
      const cards = faceCards(ch.victim);
      if (!cards.length) { fizzleBox(body, `${nameOf(ch.victim)} has nothing to take`, true); return; }
      body.innerHTML = `<div class="pickgrid">` + cards.map((c) =>
        `<button data-c="${c.uid}">${esc(c.label)}</button>`).join('') +
        `</div><button id="backBtn" class="link">← back</button>`;
      $('backBtn').onclick = () => { S.choice = {}; renderChoice(); };
      body.querySelectorAll('[data-c]').forEach((b) => b.onclick = () =>
        doOp({ op: 'actionTarget', targetId: ch.victim, cardUid: b.dataset.c }));
    }
    return;
  }
  $('choiceTitle').textContent = names[a] || a;
  const tgts = validTargetsLocal(a);
  if (!tgts.length) { fizzleBox(body, 'No valid target'); return; }
  body.innerHTML = `<div class="pickgrid">` + tgts.map((p) =>
    `<button data-t="${p.id}">${esc(p.name)}${p.id === S.me.id ? ' (you)' : ''}</button>`).join('') + `</div>`;
  body.querySelectorAll('button').forEach((b) => b.onclick = () => doOp({ op: 'actionTarget', targetId: b.dataset.t }));
}

function nameOf(pid) {
  const p = (S.snap.players || []).find((x) => x.id === pid);
  return p ? p.name : 'that player';
}
// Dead-end escape hatch: discards the pending action instead of soft-locking
// the table when nothing (or nothing left) is legally pickable.
function fizzleBox(body, why, withBack) {
  $('choiceTitle').textContent = 'No valid target';
  body.innerHTML = `<p class="hint">${esc(why)} — the card fizzles and is discarded.</p>` +
    `<div class="pickgrid"><button id="fizzleBtn">OK, discard</button></div>` +
    (withBack ? `<button id="backBtn" class="link">← back</button>` : '');
  $('fizzleBtn').onclick = () => doOp({ op: 'actionTarget' });
  const back = $('backBtn');
  if (back) back.onclick = () => { S.choice = {}; renderChoice(); };
}
function renderSwapPicker(body, ch) {
  $('choiceTitle').textContent = ch.first ? 'Swap: pick SECOND card (another player)' : 'Swap: pick FIRST card';
  const ps = alivePlayers();
  const allFaces = ps.flatMap((p) => faceCards(p.id));
  if (new Set(allFaces.map((c) => c.owner)).size < 2) { fizzleBox(body, 'Swap needs two cards on different lines'); return; }
  let html = '';
  for (const p of ps) {
    const cards = faceCards(p.id).filter((c) => !ch.first || (c.owner !== ch.first.owner));
    if (!cards.length) continue;
    html += `<div class="opp"><h3>${esc(p.name)}</h3><div class="pickgrid">` +
      cards.map((c) => `<button data-o="${c.owner}" data-c="${c.uid}" class="${ch.first && ch.first.uid === c.uid ? 'chosen' : ''}">${esc(c.label)}</button>`).join('') +
      `</div></div>`;
  }
  body.innerHTML = html + (ch.first ? `<button id="backBtn" class="link">← restart</button>` : '');
  const back = $('backBtn'); if (back) back.onclick = () => { S.choice = {}; renderChoice(); };
  body.querySelectorAll('[data-c]').forEach((b) => b.onclick = () => {
    const pick = { owner: b.dataset.o, uid: b.dataset.c };
    if (!S.choice.first) { S.choice = { first: pick }; renderChoice(); }
    else {
      doOp({
        op: 'actionTarget', cardOwnerId: S.choice.first.owner, cardUid: S.choice.first.uid,
        cardOwnerId2: pick.owner, cardUid2: pick.uid,
      });
    }
  });
}

// ---------- wiring ----------
function init() {
  const q = new URLSearchParams(location.search);
  if (q.get('r')) $('codeInput').value = q.get('r').toUpperCase();
  if (q.get('p')) { $('joinPassInput').value = q.get('p'); S.pass = q.get('p'); }
  const s = sessLoad();
  if (s && s.room) {
    $('rejoinHint').hidden = false;
    $('rejoinBtn').onclick = () => {
      S.room = s.room; S.me.name = s.name; S.me.id = s.playerId; S.me.token = s.token;
      if (S.ws.readyState === 1) send({ t: 'join', room: s.room, name: s.name, playerId: s.playerId, token: s.token });
    };
    $('forgetBtn').onclick = () => { sessClear(); $('rejoinHint').hidden = true; };
  }
  $('createBtn').onclick = () => {
    const name = $('nameInput').value.trim() || 'Host';
    S.me.name = name;
    send({
      t: 'create', name, mode: $('modeSel').value,
      target: parseInt($('targetInput').value, 10) || 200,
      brutal: $('brutalCheck').checked, password: $('passInput').value.trim(),
      autoApprove: $('approveSel').value,
    });
  };
  $('joinBtn').onclick = () => {
    const name = $('nameInput').value.trim() || 'Player';
    S.me.name = name;
    S.room = $('codeInput').value.trim().toUpperCase();
    send({ t: 'join', room: S.room, name, password: $('joinPassInput').value.trim() });
  };
  $('copyLinkBtn').onclick = async () => {
    const link = inviteLink();
    try { await navigator.clipboard.writeText(link); toast('Invite link copied!'); }
    catch { prompt('Copy invite link:', link); }
  };
  $('showPassBtn').onclick = () => send({ t: 'getPass' });
  $('startBtn').onclick = startGame;
  $('resumeBtn').onclick = resumeGame;
  $('newMatchBtn').onclick = () => { if (confirm('Start a new match? All scores reset.')) startGame(); };
  $('leaveBtn').onclick = () => { sessClear(); location.href = '/'; };
  $('hitBtn').onclick = () => doOp({ op: 'hit' });
  $('stayBtn').onclick = () => doOp({ op: 'stay' });
  $('nextRoundBtn').onclick = resumeGame;
  $('toLobbyBtn').onclick = () => {
    // Host pauses to lobby: match (scores + engine) is kept, echo confirms.
    S.inGame = false; S.choice = {}; S.dropped = [];
    send({ t: 'backToLobby' });
    render();
  };
  $('leaveGameBtn').onclick = () => { sessClear(); location.href = '/'; };
  $('tableToggle').onchange = (e) => { S.tableMode = e.target.checked; render(); };
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  connect();
}

// Roster sync (breaks only): approved spectators join, removed seats leave.
// Never resets totals — scores persist until an explicit New match.
async function syncRoster() {
  const eng = await engine();
  const seatIds = new Set(S.seats.map((s) => s.id));
  for (const s of S.seats) {
    if (!S.G.players.some((p) => p.id === s.id)) {
      try { eng.addPlayer(S.G, { id: s.id, name: s.name }); } catch {}
    }
  }
  for (const p of [...S.G.players]) {
    if (!seatIds.has(p.id)) {
      try { eng.removePlayer(S.G, p.id); } catch {}
    }
  }
}
// Fresh match: new engine, scores reset. Only via Start / New match buttons.
async function startGame() {
  if (!S.me.isHost) return;
  const eng = await engine();
  await becomeHostEngine();
  try {
    eng.startRound(S.G);
  } catch (e) { toast(e.message); return; }
  send({ t: 'start' });
  S.inGame = true;
  S.choice = {};
  pumpAndBroadcast();
}
// Resume: keep the match (scores + engine). Round break → next round;
// mid-round pause → continue the very same round.
async function resumeGame() {
  if (!S.me.isHost) return;
  const eng = await engine();
  if (!S.G) {
    if (!S.snap) return; // e.g. host refreshed: rebuild engine from the kept snapshot
    S.G = eng.restore(S.snap);
    S.hostSeq = S.seq;
  }
  if (['roundEnd', 'gameOver'].includes(S.G.phase)) {
    if (S.G.phase === 'gameOver') { startGame(); return; } // match over → resume means a new match
    await syncRoster();
    try {
      eng.startRound(S.G);
    } catch (e) { toast(e.message); return; }
  }
  // mid-round pause: engine continues untouched (roster changes apply at next break)
  send({ t: 'start' });
  S.inGame = true;
  S.choice = {};
  pumpAndBroadcast();
}

document.addEventListener('DOMContentLoaded', init);
