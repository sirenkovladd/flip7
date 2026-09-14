# AGENTS.md — Flip 7 browser build

## What this is
Browser party game: FLIP 7 With a Vengeance + Classic. Go server (relay +
sessions + host election), PWA vanilla-JS client, shared JS rules engine
that runs in the HOST's browser. No P2P, no build step.

## Commands
- `go run .` (or `PORT=8080 go run .`) — serve on `:3000`
- `go build -o /tmp/flip7-server .` / `go vet ./...` — backend checks
- `npm test` — `node --test test/engine.test.js` (rules suite, no deps)

## Architecture rules (do not break)
1. **`game/` is pure logic, no DOM, no sockets.** Host client + tests import
   it. Deterministic RNG via injected `rand()` so tests can seed.
2. **Engine is source of truth for rules** (see README Locked rules). Rule
   change = failing test first, then engine fix, then UI.
3. **Server never decides game outcomes.** `rooms.go` relays
   (`intent` client→host, `state` host→room), stores the latest snapshot +
   seq per room, owns presence/tokens, runs the 10s host election, and
   gates joins (password, mid-game policy). No game imports in Go.
4. **Client `public/app.js` has 3 layers:** Net (WS + backoff reconnect +
   token session), Host (engine + intent validation + `pumpAndBroadcast`),
   UI (personal default + Table toggle, pickers). Keep them separable.
   The lobby is a pause room, never a reset: resume continues the kept
   engine/snapshot (scores intact); only Start/New-match builds a fresh engine.
5. **State is serializable JSON.** Migration/reconnect = load snapshot.
   Never send functions. `state` seq guards stale snapshots.
6. **Check bust/Flip7 after EVERY line change** (flip, swap, steal).
   FlipFour bust voids queue. Unlucky7 is immediate even mid-FlipFour.
7. **Scoring order is strict:** sum → ÷2 floor → −negatives → floor 0
   (skip in brutal) → +15. Zero w/o Flip7 = 0.
8. **Roster changes only via engine helpers:** mid-round `markLeft`,
   between rounds `removePlayer`/`addPlayer`. Server seat delete and engine
   roster must be updated together (client `renderNotices` / `startGame`).

## Protocol (WS JSON, `t` field)
Client→server: `create join start backToLobby toHost toPeer seatDecision
joinDecision state getPass ping`.
Server→client: `created joined room seats state intent peerMsg joinRequest
joinWithdrawn peerDropped peerRejoined hostGone hostBack hostChanged
roomPass waitingApproval joinDenied dropped error pong`.
Pending mid-game joins live in `room.pending` keyed by requestId; the
waiting socket is parked on `client.pendingReq` until decided.

## File map
- `main.go` — static cache (RAM + gzip + ETag), cache policies, `/api/health`
- `rooms.go` — hub/rooms/seats, relay, presence, host election, approvals
- `public/app.js` — lobby/QR-link, personal/table views, HIT/STAY bar,
  staged Swap/Steal/Discard pickers, drop/wait + approval dialogs,
  host-takeover restore
- `public/sw.js` — versioned shell cache (`flip7-v0.1.0` — bump together
  with `AppVersion` + `APP_V`)
- `game/deck.js` — builders + counts (vengeance 92+6+10, classic 79+6+9)
- `game/engine.js` — full rules + roster + snapshot/restore + `runCont` continuations (nested JOM/Flip chains never drop cards or turns)
- `test/engine.test.js` — 15 rules tests
- `test/stress.test.js` — 6 big-lobby tests (12/18p full games, per-round card conservation incl. in-flight queue cards, reshuffle)
- `public/vendor/qrcode.js` — vendored MIT QR lib (no CDN); lobby renders invite-link QR when password is known

## Versioning
Bump `AppVersion` (main.go) + `CACHE` (sw.js) + `APP_V` (`?v=` in
index.html/app.js) together on release so caches roll forward.

## Conventions
- Go: `gofmt` clean, `go vet` clean. ES modules in JS.
- Mobile-first CSS, bottom action bar, `view-home/lobby/game` sections.
- Every change: backend builds + `npm test` green + 2-tab playtest
  (host + joiner: action targeting, bust, drop→wait/rejoin, host-tab-close
  migration).
