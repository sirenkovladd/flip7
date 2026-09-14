# FLIP 7 — With a Vengeance (browser party build)

Play **FLIP 7: With a Vengeance** (and **Classic Flip 7**) in the browser with friends in the same room.
One server, zero pairing pain: create a room, share the link/QR, play. No P2P — everything goes over WebSocket through the Go server.

## Locked rules (v1 source of truth)

Agreed before build — `game/engine.js` implements exactly this:

- **Goal:** configurable target (default **200**). At round end where anyone ≥ target, **highest total wins**. Tie = **shared win**.
- **Decks**
  - Vengeance 108: numbers 92 = `0×1, 1×1, 2×2 … 6×6, 7×6+Unlucky7×1, 8×8, 9×9, 10×10, 11×11, 12×12, 13×12+Lucky13×1`; modifiers 6 = `÷2,−2,−4,−6,−8,−10` (×1); actions 10 = `JustOneMore/Swap/Steal/Discard/FlipFour ×2 each`.
  - Classic 94: numbers 79 = `0×1, 1×1 … 12×12`; modifiers 6 = `+2,+4,+6,+8,+10,x2` (×1); actions 9 = `Freeze/FlipThree/SecondChance ×3 each`.
  - Big lobbies: **auto 2nd deck** at ≥10 players.
- **Round:** discards persist; reshuffle only when the deck runs out mid-round (hands untouched). Dealer rotates left.
- **Initial deal:** clockwise face-up incl. dealer. Every Action/Modifier pauses dealing, receiver resolves (KEEP/self or GIVE to any non-busted incl. STAYED; must KEEP/SELF if sole non-busted; must-use if legal target else discarded).
- **Turns:** sequential clockwise, skip non-ACTIVE. `HIT` draws, `STAY` banks. **Zero-holder must HIT** (JustOneMore overrides: draw 1 then STAY).
- **Bust/Flip7 checked after EVERY line change** (deck flip, Swap, Steal — Swap/Steal can bust one or two players, and can complete Flip 7 → round ends instantly +15).
- **Specials:** Zero (scores 0 unless Flip7, counts 1/7), Unlucky7 (on receipt incl. Swap/Steal: discard all else, keep it; mid-FlipFour wipes priors then continues; leaving never refunds), Lucky13 (exactly 2×13 allowed, 3rd busts).
- **Actions:** JustOneMore (draw 1 then STAY; nested action resolved first), Swap (any 2 face-up from different players), Steal, Discard (incl. self-dump of ÷2/negatives/Zero), FlipFour (up to 4 one-by-one, stop on bust/Flip7; Unlucky7 immediate, rest queued in order; STAYED target stays STAYED).
- **Scoring (standard):** busted=0; else `sum(numbers) → ÷2 floor → −negatives → floor 0 → +15 if Flip7`. Zero w/o Flip7 = 0. ÷2 never touches +15. Brutal: no floor, modifiers may target BUSTED, Flip7 auto +15 (manual −15 choice is a known v1 gap — see Improvements).

## Run it

```bash
go run .              # http://localhost:3000  (PORT=8080 go run .)
npm test              # engine rules tests (15 green)
```

Same-room flow: **Create** (mode/target/brutal/password/mid-game-join policy) → **share link** (code + auto password inside) → players **Join** → host **Starts**.
Default view = **your cards only** (big center, deck/round top, HIT/STAY bottom). Toggle **Table** for one shared screen (all hands). Spectators always see the table.

## Sessions, drops & host migration (all server-side)

- **Names + rooms:** pick a name (auto-uniquified), 6-char room code, password per room (blank = auto 4-char, embedded in the invite link).
- **Reconnect = same seat:** the server issues a secret token per seat (kept in `localStorage`). Rejoin with it and you're back with the **same hand** — the server replays the latest host snapshot. No host action needed.
- **Player drops mid-game:** the host gets a card — **Wait** (seat reserved; rejoin auto-assigns) or **Drop & reset** (seat freed, engine busts/removes them, game continues).
- **Host drops:** 10s grace to return; otherwise the **server picks the next host** (earliest-joined connected player), who restores the exact snapshot and continues. Old host returning late rejoins as a normal player.
- **Mid-game joins:** policy per room — `host` (knock + approve → spectate until next round), `auto` (straight to spectate), `off` (closed).

## Caching (all layers)

- **Server RAM:** static files + pre-compressed gzip + ETags held in memory, revalidated by mtime — no disk on the hot path.
- **HTTP:** `?v=<current>` assets → `immutable, 1yr`; app shell (`/`, `sw.js`, manifest) → `no-cache`; rest → `public, 1h` + ETag/`304`.
- **PWA:** `sw.js` stale-while-revalidate shell (`/`, css/js, `game/*.js`, icons) → instant second load + offline. Installable (manifest + icons).

## Layout

- `main.go` — HTTP + cached static + `/api/health` + `/ws`
- `rooms.go` — rooms, seats/tokens, relay, presence, 10s host election, join approval
- `public/` — PWA (`index.html`, `styles.css`, `app.js`, `sw.js`, `manifest.webmanifest`, `icons/`)
- `game/` — `deck.js`, `engine.js` (pure, runs in HOST browser + `npm test`)
- `test/engine.test.js` — rules regression suite

## Improvements (suggested, not built)

1. Brutal −15 choice UI (currently auto +15 self).
2. Real QR code in lobby (add a tiny vendored QR lib — no CDN, keep offline).
3. Second-deck/18+ stress test + deck-exhaustion end (`deckOut` path).
4. Bot players to fill seats.
5. Game history / rematch stats in `localStorage`.
6. `wss` reverse-proxy snippet (Caddy/nginx) for play over the internet.
