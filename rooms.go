// Room sessions, presence, and server-side host election.
//
// Authority model: the HOST's browser runs game/engine.js and broadcasts
// snapshots. This server relays, stores the latest snapshot per room (so
// reconnects resume the exact same hand), and elects the next host when
// the host is gone for >10s. No P2P — everything goes over WS.
package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	hostGrace    = 10 * time.Second
	pingInterval = 30 * time.Second
	maxPlayers   = 24
	roomTTL      = time.Hour
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  64 * 1024,
	WriteBufferSize: 64 * 1024,
	// Party LAN: phones join by IP, no cookies/auth — accept any origin.
	CheckOrigin: func(r *http.Request) bool { return true },
}

// ---------- wire protocol ----------

type msg struct {
	T string `json:"t"`
	// create
	Name string `json:"name,omitempty"`
	Mode string `json:"mode,omitempty"`
	// create/join settings
	Target      int    `json:"target,omitempty"`
	Brutal      bool   `json:"brutal,omitempty"`
	Password    string `json:"password,omitempty"`
	AutoApprove string `json:"autoApprove,omitempty"` // auto|host|off
	// join / session
	Room     string `json:"room,omitempty"`
	PlayerID string `json:"playerId,omitempty"`
	Token    string `json:"token,omitempty"`
	// state relay
	Seq      int             `json:"seq,omitempty"`
	Snapshot json.RawMessage `json:"snapshot,omitempty"`
	// generic routing
	To       string          `json:"to,omitempty"`
	From     string          `json:"from,omitempty"`
	FromName string          `json:"fromName,omitempty"`
	Payload  json.RawMessage `json:"payload,omitempty"`
	// host decisions
	RequestID string `json:"requestId,omitempty"`
	Approve   bool   `json:"approve,omitempty"`
	Decision  string `json:"decision,omitempty"` // wait|drop
	Reason    string `json:"reason,omitempty"`
	// room snapshots for clients
	You      *seatInfo  `json:"you,omitempty"`
	Seats    []seatInfo `json:"seats,omitempty"`
	Settings settings   `json:"settings,omitempty"`
	InGame   bool       `json:"inGame"` // always present: followers match on === false
	HostID   string     `json:"hostId,omitempty"`
	HostName string     `json:"hostName,omitempty"`
}

type settings struct {
	Mode        string `json:"mode"`
	Target      int    `json:"target"`
	Brutal      bool   `json:"brutal"`
	AutoApprove string `json:"autoApprove"`
}

type seatInfo struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	IsHost    bool   `json:"isHost"`
	Connected bool   `json:"connected"`
	Spectator bool   `json:"spectator"`
	Waiting   bool   `json:"waiting"`
}

// ---------- model ----------

type client struct {
	hub  *hub
	conn *websocket.Conn
	send chan []byte
	room *room
	seat *seat
	// pendingReq is set while a mid-game join awaits host approval.
	pendingReq string
}

type seat struct {
	id        string
	name      string
	token     string
	cl        *client // live connection, nil when offline
	isHost    bool
	spectator bool
	waiting   bool
	order     int
}

type joinRequest struct {
	id   string
	name string
	cl   *client
}

type room struct {
	mu        sync.Mutex
	code      string
	passHash  [32]byte
	settings  settings
	seats     map[string]*seat
	order     []string
	kicked    map[string]bool // lowercased names banned for room lifetime
	pending   map[string]*joinRequest
	inGame    bool
	snapshot  json.RawMessage
	seq       int
	hostTimer *time.Timer
	touched   time.Time
}

type hub struct {
	mu    sync.Mutex
	rooms map[string]*room
	// autoPass keeps auto-generated room passwords so the host can
	// re-display the QR/link any time.
	autoPass map[string]string
}

func newHub() *hub { return &hub{rooms: map[string]*room{}, autoPass: map[string]string{}} }

func randHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

var codeAlphabet = []byte("ABCDEFGHJKMNPQRSTUVWXYZ23456789")

func randCode(n int) string {
	rb := make([]byte, n)
	if _, err := rand.Read(rb); err != nil {
		panic(err)
	}
	b := make([]byte, n)
	for i := range b {
		b[i] = codeAlphabet[int(rb[i])%len(codeAlphabet)]
	}
	return string(b)
}

func (h *hub) get(code string) *room {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.rooms[strings.ToUpper(code)]
}

// reaper drops rooms with nobody connected/waiting for > roomTTL.
func (h *hub) reapLoop() {
	for range time.Tick(5 * time.Minute) {
		now := time.Now()
		h.mu.Lock()
		for code, r := range h.rooms {
			r.mu.Lock()
			alive := false
			for _, s := range r.seats {
				if s.cl != nil || s.waiting {
					alive = true
					break
				}
			}
			if !alive && now.Sub(r.touched) > roomTTL {
				delete(h.rooms, code)
			}
			r.mu.Unlock()
		}
		h.mu.Unlock()
	}
}

// ---------- room helpers (caller holds r.mu) ----------

func (r *room) touch() { r.touched = time.Now() }

func (r *room) hostSeat() *seat {
	for _, s := range r.seats {
		if s.isHost {
			return s
		}
	}
	return nil
}

func (r *room) seatList() []seatInfo {
	out := []seatInfo{}
	for _, id := range r.order {
		s, ok := r.seats[id]
		if !ok {
			continue
		}
		out = append(out, seatInfo{
			ID: s.id, Name: s.name, IsHost: s.isHost,
			Connected: s.cl != nil, Spectator: s.spectator, Waiting: s.waiting,
		})
	}
	return out
}

func pushTo(cl *client, raw []byte) {
	if cl == nil {
		return
	}
	select {
	case cl.send <- raw:
	default:
		// slow client: drop rather than block the room
	}
}

func (r *room) broadcastLocked(m msg) {
	raw, err := json.Marshal(m)
	if err != nil {
		return
	}
	for _, s := range r.seats {
		pushTo(s.cl, raw)
	}
}

func (r *room) sendToLocked(s *seat, m msg) {
	if s == nil {
		return
	}
	raw, err := json.Marshal(m)
	if err != nil {
		return
	}
	pushTo(s.cl, raw)
}

func (r *room) roomMsgLocked(forSeat *seat) msg {
	m := msg{
		T: "room", Room: r.code, Seats: r.seatList(),
		Settings: r.settings, InGame: r.inGame,
		Seq: r.seq, Snapshot: r.snapshot,
	}
	if h := r.hostSeat(); h != nil {
		m.HostID = h.id
		m.HostName = h.name
	}
	if forSeat != nil {
		m.You = &seatInfo{
			ID: forSeat.id, Name: forSeat.name, IsHost: forSeat.isHost,
			Connected: true, Spectator: forSeat.spectator, Waiting: forSeat.waiting,
		}
	}
	return m
}

func uniqueNameLocked(r *room, want string) string {
	if want == "" {
		want = "Player"
	}
	taken := map[string]bool{}
	for _, s := range r.seats {
		taken[s.name] = true
	}
	if !taken[want] {
		return want
	}
	for i := 2; ; i++ {
		if cand := fmt.Sprintf("%s (%d)", want, i); !taken[cand] {
			return cand
		}
	}
}

// electNextLocked promotes the earliest-joined connected seat.
func (r *room) electNextLocked(reason string) *seat {
	var best *seat
	for _, id := range r.order {
		s, ok := r.seats[id]
		if !ok || s.cl == nil {
			continue
		}
		if best == nil || s.order < best.order {
			best = s
		}
	}
	for _, s := range r.seats {
		s.isHost = (best != nil && s == best)
	}
	if best != nil {
		r.broadcastLocked(msg{
			T: "hostChanged", HostID: best.id, HostName: best.name,
			Reason: reason, Seq: r.seq, Snapshot: r.snapshot,
		})
		r.broadcastLocked(r.roomMsgLocked(nil))
		log.Printf("room %s: new host %s (%s)", r.code, best.name, reason)
	}
	return best
}

func (r *room) scheduleHostElectionLocked() {
	if r.hostTimer != nil {
		r.hostTimer.Stop()
	}
	r.hostTimer = time.AfterFunc(hostGrace, func() {
		r.mu.Lock()
		defer r.mu.Unlock()
		r.hostTimer = nil
		if h := r.hostSeat(); h != nil && h.cl != nil {
			return // host came back in time
		}
		r.electNextLocked("host timeout (10s)")
	})
}

// sniffSnapshot updates server-side flags from a host snapshot:
// game phase and spectator promotion (a spectator whose id shows up
// in engine players is now playing).
func (r *room) sniffSnapshotLocked() {
	if len(r.snapshot) == 0 {
		return
	}
	var s struct {
		Phase   string `json:"phase"`
		Players []struct {
			ID string `json:"id"`
		} `json:"players"`
	}
	if err := json.Unmarshal(r.snapshot, &s); err != nil {
		return
	}
	switch s.Phase {
	case "turns", "initialDeal", "roundEnd":
		r.inGame = true
	case "gameOver", "lobby":
		r.inGame = false
	}
	if len(s.Players) > 0 {
		inEngine := map[string]bool{}
		for _, p := range s.Players {
			inEngine[p.ID] = true
		}
		changed := false
		for id, seat := range r.seats {
			if seat.spectator && inEngine[id] {
				seat.spectator = false
				changed = true
			}
		}
		if changed {
			r.broadcastLocked(msg{T: "seats", Seats: r.seatList()})
		}
	}
}

// ---------- connection handling ----------

func serveWS(h *hub, w http.ResponseWriter, req *http.Request) {
	conn, err := upgrader.Upgrade(w, req, nil)
	if err != nil {
		return
	}
	c := &client{hub: h, conn: conn, send: make(chan []byte, 64)}
	go c.writeLoop()
	c.readLoop()
}

func (c *client) emit(m msg) {
	raw, err := json.Marshal(m)
	if err != nil {
		return
	}
	select {
	case c.send <- raw:
	default:
	}
}

func (c *client) writeLoop() {
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()
	for {
		select {
		case raw, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, raw); err != nil {
				return
			}
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *client) readLoop() {
	defer c.onDisconnect()
	c.conn.SetReadLimit(2 << 20) // 2MB snapshots max
	c.conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(90 * time.Second))
		return nil
	})
	for {
		var m msg
		if err := c.conn.ReadJSON(&m); err != nil {
			return
		}
		c.conn.SetReadDeadline(time.Now().Add(90 * time.Second))
		c.handle(m)
	}
}

func (c *client) onDisconnect() {
	defer c.conn.Close()
	if c.room == nil {
		return
	}
	r := c.room
	r.mu.Lock()
	defer r.mu.Unlock()
	// Mid-game join still awaiting approval: just drop the request.
	if c.pendingReq != "" {
		delete(r.pending, c.pendingReq)
		if h := r.hostSeat(); h != nil {
			r.sendToLocked(h, msg{T: "joinWithdrawn", RequestID: c.pendingReq})
		}
		return
	}
	s := c.seat
	if s == nil || s.cl != c {
		return // seat already taken over by a reconnect
	}
	s.cl = nil
	r.touch()
	if s.isHost {
		// 10s grace for the host to return before the server picks next.
		r.scheduleHostElectionLocked()
		r.broadcastLocked(msg{T: "hostGone", HostID: s.id, HostName: s.name, Reason: "host disconnected — 10s to return"})
		r.broadcastLocked(r.roomMsgLocked(nil))
	} else {
		r.broadcastLocked(r.roomMsgLocked(nil))
		if r.inGame {
			if h := r.hostSeat(); h != nil {
				r.sendToLocked(h, msg{T: "peerDropped", PlayerID: s.id, FromName: s.name})
			}
		}
	}
}

func (c *client) handle(m msg) {
	switch m.T {
	case "create":
		c.doCreate(m)
	case "join":
		c.doJoin(m)
	case "start", "backToLobby", "seatDecision", "joinDecision":
		c.hostOnly(m)
	case "toHost":
		c.doToHost(m)
	case "toPeer":
		c.doToPeer(m)
	case "state":
		c.doState(m)
	case "getPass":
		c.doGetPass()
	case "ping":
		c.emit(msg{T: "pong"})
	}
}

func (c *client) doCreate(m msg) {
	mode := m.Mode
	if mode != "classic" && mode != "vengeance" {
		mode = "vengeance"
	}
	target := m.Target
	if target < 50 || target > 1000 {
		target = 200
	}
	auto := m.AutoApprove
	if auto != "auto" && auto != "host" && auto != "off" {
		auto = "host"
	}
	pw := m.Password
	if pw == "" {
		pw = randCode(4) // auto password, embedded in QR/link
	}
	h := c.hub
	h.mu.Lock()
	var r *room
	for {
		code := randCode(6)
		if _, ok := h.rooms[code]; ok {
			continue
		}
		r = &room{
			code:     code,
			passHash: sha256.Sum256([]byte(pw)),
			settings: settings{Mode: mode, Target: target, Brutal: m.Brutal, AutoApprove: auto},
			seats:    map[string]*seat{},
			pending:  map[string]*joinRequest{},
			kicked:   map[string]bool{},
			touched:  time.Now(),
		}
		h.rooms[code] = r
		h.autoPass[code] = pw
		break
	}
	h.mu.Unlock()

	name := m.Name
	if name == "" {
		name = "Host"
	}
	r.mu.Lock()
	s := &seat{id: randHex(8), name: name, token: randHex(16), isHost: true, order: 0, cl: c}
	r.seats[s.id] = s
	r.order = append(r.order, s.id)
	r.touch()
	c.room, c.seat = r, s
	r.mu.Unlock()

	c.emit(msg{T: "created", Room: r.code, Password: pw, PlayerID: s.id, Token: s.token})
	r.mu.Lock()
	r.broadcastLocked(r.roomMsgLocked(nil))
	r.mu.Unlock()
	log.Printf("room %s created by %s (mode=%s target=%d approve=%s)", r.code, name, mode, target, auto)
}

func (c *client) doGetPass() {
	if c.room == nil || c.seat == nil || !c.seat.isHost {
		return
	}
	c.hub.mu.Lock()
	pw := c.hub.autoPass[c.room.code]
	c.hub.mu.Unlock()
	c.emit(msg{T: "roomPass", Room: c.room.code, Password: pw})
}

func (c *client) doJoin(m msg) {
	r := c.hub.get(m.Room)
	if r == nil {
		c.emit(msg{T: "error", Reason: "room not found"})
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.touch()
	// Reconnect with token → same seat, same hand. No host action needed.
	if m.PlayerID != "" && m.Token != "" {
		if s, ok := r.seats[m.PlayerID]; ok && subtle.ConstantTimeCompare([]byte(s.token), []byte(m.Token)) == 1 {
			if s.cl != nil && s.cl != c {
				s.cl.conn.Close() // take over from the stale socket
			}
			if r.hostTimer != nil && s.isHost {
				r.hostTimer.Stop()
				r.hostTimer = nil
				r.broadcastLocked(msg{T: "hostBack", HostID: s.id, HostName: s.name})
			}
			s.waiting = false
			s.cl = c
			c.room, c.seat, c.pendingReq = r, s, ""
			c.emit(r.roomMsgLocked(s))
			r.broadcastLocked(r.roomMsgLocked(nil))
			if r.inGame {
				if h := r.hostSeat(); h != nil && h != s {
					r.sendToLocked(h, msg{T: "peerRejoined", PlayerID: s.id, FromName: s.name})
				}
			}
			log.Printf("room %s: %s reconnected", r.code, s.name)
			return
		}
	}
	// New seat: password check.
	sum := sha256.Sum256([]byte(m.Password))
	if subtle.ConstantTimeCompare(sum[:], r.passHash[:]) != 1 {
		c.emit(msg{T: "joinDenied", Reason: "wrong password"})
		return
	}
	if r.kicked[strings.ToLower(m.Name)] {
		c.emit(msg{T: "joinDenied", Reason: "kicked by host"})
		return
	}
	if len(r.seats) >= maxPlayers {
		c.emit(msg{T: "joinDenied", Reason: "room is full"})
		return
	}
	name := uniqueNameLocked(r, m.Name)
	if !r.inGame {
		s := &seat{id: randHex(8), name: name, token: randHex(16), order: len(r.order), cl: c}
		if len(r.seats) == 0 {
			s.isHost = true // first seat in an empty room becomes host
		}
		r.seats[s.id] = s
		r.order = append(r.order, s.id)
		c.room, c.seat = r, s
		c.emit(msg{T: "joined", Room: r.code, PlayerID: s.id, Token: s.token})
		c.emit(r.roomMsgLocked(s))
		r.broadcastLocked(r.roomMsgLocked(nil))
		log.Printf("room %s: %s joined", r.code, name)
		return
	}
	// Mid-game join.
	switch r.settings.AutoApprove {
	case "off":
		c.emit(msg{T: "joinDenied", Reason: "game in progress — joins closed"})
	case "auto":
		s := &seat{id: randHex(8), name: name, token: randHex(16), order: len(r.order), spectator: true, cl: c}
		r.seats[s.id] = s
		r.order = append(r.order, s.id)
		c.room, c.seat = r, s
		c.emit(msg{T: "joined", Room: r.code, PlayerID: s.id, Token: s.token})
		c.emit(r.roomMsgLocked(s))
		r.broadcastLocked(r.roomMsgLocked(nil))
	default: // host decides
		reqID := randHex(6)
		r.pending[reqID] = &joinRequest{id: reqID, name: name, cl: c}
		c.room = r
		c.pendingReq = reqID
		c.emit(msg{T: "waitingApproval", Room: r.code, RequestID: reqID})
		if h := r.hostSeat(); h != nil {
			r.sendToLocked(h, msg{T: "joinRequest", RequestID: reqID, FromName: name})
		}
	}
}

// hostOnly routes host-gated messages; drops anything from non-hosts.
func (c *client) hostOnly(m msg) {
	if c.room == nil || c.seat == nil || !c.seat.isHost {
		c.emit(msg{T: "error", Reason: "host only"})
		return
	}
	r := c.room
	r.mu.Lock()
	defer r.mu.Unlock()
	switch m.T {
	case "start":
		r.inGame = true
		r.broadcastLocked(r.roomMsgLocked(nil))
	case "backToLobby":
		r.inGame = false
		// NOTE: snapshot/seq are kept on purpose — the lobby doubles as
		// the score room and a paused mid-round game resumes from it.
		r.broadcastLocked(r.roomMsgLocked(nil))
	case "seatDecision":
		s, ok := r.seats[m.PlayerID]
		if !ok {
			return
		}
		if m.PlayerID == c.seat.id && m.Decision != "wait" {
			c.emit(msg{T: "error", Reason: "you cannot remove yourself"})
			return
		}
		if m.Decision == "wait" {
			s.waiting = true // seat reserved; auto-reassign on reconnect
		} else {
			// drop/kick: free the seat. Host's engine marks them out via markLeft/removePlayer.
			reason := "removed by host"
			if m.Decision == "kick" {
				r.kicked[strings.ToLower(s.name)] = true // banned for room lifetime
				reason = "kicked by host"
			}
			if s.cl != nil {
				r.sendToLocked(s, msg{T: "dropped", Reason: reason})
			}
			delete(r.seats, m.PlayerID)
			for i, id := range r.order {
				if id == m.PlayerID {
					r.order = append(r.order[:i], r.order[i+1:]...)
					break
				}
			}
		}
		r.broadcastLocked(msg{T: "seats", Seats: r.seatList()})
	case "joinDecision":
		req, ok := r.pending[m.RequestID]
		if !ok {
			return
		}
		delete(r.pending, m.RequestID)
		wc := req.cl
		if !m.Approve {
			if wc != nil {
				wc.emit(msg{T: "joinDenied", Reason: "host declined"})
			}
			return
		}
		name := uniqueNameLocked(r, req.name)
		s := &seat{id: randHex(8), name: name, token: randHex(16), order: len(r.order), spectator: true}
		r.seats[s.id] = s
		r.order = append(r.order, s.id)
		if wc != nil {
			s.cl = wc
			wc.room, wc.seat, wc.pendingReq = r, s, ""
			wc.emit(msg{T: "joined", Room: r.code, PlayerID: s.id, Token: s.token})
			wc.emit(r.roomMsgLocked(s))
		}
		r.broadcastLocked(r.roomMsgLocked(nil))
	}
}

func (c *client) doToHost(m msg) {
	if c.room == nil || c.seat == nil {
		return
	}
	r := c.room
	r.mu.Lock()
	defer r.mu.Unlock()
	h := r.hostSeat()
	if h == nil || h.cl == nil {
		c.emit(msg{T: "error", Reason: "host unavailable, retry shortly"})
		return
	}
	r.sendToLocked(h, msg{T: "intent", From: c.seat.id, FromName: c.seat.name, Payload: m.Payload})
}

func (c *client) doToPeer(m msg) {
	if c.room == nil || c.seat == nil || !c.seat.isHost {
		return
	}
	r := c.room
	r.mu.Lock()
	defer r.mu.Unlock()
	if s, ok := r.seats[m.To]; ok {
		r.sendToLocked(s, msg{T: "peerMsg", Payload: m.Payload})
	}
}

func (c *client) doState(m msg) {
	if c.room == nil || c.seat == nil || !c.seat.isHost {
		c.emit(msg{T: "error", Reason: "only the host broadcasts state"})
		return
	}
	r := c.room
	r.mu.Lock()
	defer r.mu.Unlock()
	if m.Seq < r.seq {
		return // stale snapshot, ignore
	}
	r.seq = m.Seq
	r.snapshot = m.Snapshot
	r.touch()
	r.sniffSnapshotLocked()
	raw, _ := json.Marshal(msg{T: "state", Seq: r.seq, Snapshot: r.snapshot, HostID: c.seat.id})
	for _, s := range r.seats {
		if s == c.seat {
			continue
		}
		pushTo(s.cl, raw)
	}
}
