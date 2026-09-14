// HTTP entrypoint: cached static files (PWA shell + shared engine),
// health endpoint, and the WS hub.
package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"log"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// ---------- in-memory static cache ----------
//
// One process serves a whole party off RAM after first hit:
// file bytes + pre-compressed gzip + ETag, revalidated against mtime.
// Paired with client-side PWA caching (sw.js) this is the full stack:
//   - memory cache here (no disk on hot path)
//   - HTTP cache headers (browser cache)
//   - Service Worker cache (offline + instant second load)

// AppVersion is bumped on each release; clients requesting static
// assets with ?v=<version> get immutable long-term caching.
const AppVersion = "0.2.1"

type staticEntry struct {
	data    []byte
	gz      []byte // nil for non-compressible types
	etag    string
	ctype   string
	modtime time.Time
	size    int64
}

var staticCache sync.Map // fsPath -> *staticEntry

func contentTypeFor(name string) string {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".webmanifest":
		return "application/manifest+json"
	case ".js":
		return "text/javascript; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".html":
		return "text/html; charset=utf-8"
	case ".svg":
		return "image/svg+xml"
	case ".json":
		return "application/json"
	}
	if t := mime.TypeByExtension(filepath.Ext(name)); t != "" {
		return t
	}
	return "application/octet-stream"
}

func compressible(ctype string) bool {
	return strings.HasPrefix(ctype, "text/") ||
		strings.Contains(ctype, "javascript") ||
		strings.Contains(ctype, "json") ||
		strings.Contains(ctype, "svg")
}

func loadStaticEntry(fsPath string, info os.FileInfo) (*staticEntry, error) {
	data, err := os.ReadFile(fsPath)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(data)
	e := &staticEntry{
		data:    data,
		etag:    `"` + hex.EncodeToString(sum[:16]) + `"`,
		ctype:   contentTypeFor(fsPath),
		modtime: info.ModTime(),
		size:    info.Size(),
	}
	if compressible(e.ctype) && len(data) > 512 {
		var buf bytes.Buffer
		gz, err := gzip.NewWriterLevel(&buf, gzip.BestSpeed)
		if err == nil {
			if _, err := gz.Write(data); err == nil {
				if err := gz.Close(); err == nil {
					e.gz = buf.Bytes()
				}
			}
		}
	}
	return e, nil
}

func getStaticEntry(fsPath string) (*staticEntry, error) {
	info, err := os.Stat(fsPath)
	if err != nil {
		return nil, err
	}
	if v, ok := staticCache.Load(fsPath); ok {
		if e := v.(*staticEntry); e.modtime.Equal(info.ModTime()) && e.size == info.Size() {
			return e, nil // hot path: RAM, no disk
		}
	}
	e, err := loadStaticEntry(fsPath, info)
	if err != nil {
		return nil, err
	}
	staticCache.Store(fsPath, e)
	return e, nil
}

// cachePolicy: versioned URLs (?v=AppVersion) are immutable for a year;
// app shell entry points always revalidate (so updates roll out);
// everything else revalidates hourly via ETag.
func cachePolicy(urlPath, rawQuery string) string {
	base := path.Base(urlPath)
	if base == "sw.js" || base == "manifest.webmanifest" || urlPath == "/" || base == "index.html" {
		return "no-cache"
	}
	if strings.Contains(rawQuery, "v="+AppVersion) {
		return "public, max-age=31536000, immutable"
	}
	return "public, max-age=3600"
}

func serveStatic(publicDir, gameDir string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upath := path.Clean("/" + strings.TrimPrefix(r.URL.Path, "/"))
		var fsPath string
		switch {
		case strings.HasPrefix(upath, "/game/"):
			rel := strings.TrimPrefix(upath, "/game/")
			if strings.Contains(rel, "..") {
				http.Error(w, "bad path", http.StatusBadRequest)
				return
			}
			fsPath = filepath.Join(gameDir, filepath.FromSlash(rel))
		default:
			rel := strings.TrimPrefix(upath, "/")
			if strings.Contains(rel, "..") {
				http.Error(w, "bad path", http.StatusBadRequest)
				return
			}
			fsPath = filepath.Join(publicDir, filepath.FromSlash(rel))
			if info, err := os.Stat(fsPath); err == nil && info.IsDir() {
				fsPath = filepath.Join(fsPath, "index.html")
			}
		}
		e, err := getStaticEntry(fsPath)
		if err != nil {
			// SPA fallback: extensionless routes serve the app shell.
			if !strings.Contains(path.Base(upath), ".") {
				if fb, ferr := getStaticEntry(filepath.Join(publicDir, "index.html")); ferr == nil {
					e, err = fb, nil
				}
			}
			if err != nil {
				http.NotFound(w, r)
				return
			}
		}
		h := w.Header()
		h.Set("Content-Type", e.ctype)
		h.Set("ETag", e.etag)
		h.Set("Cache-Control", cachePolicy(upath, r.URL.RawQuery))
		h.Set("Vary", "Accept-Encoding")
		if r.Header.Get("If-None-Match") == e.etag {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		if e.gz != nil && strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			h.Set("Content-Encoding", "gzip")
			h.Set("Content-Length", itoaLen(len(e.gz)))
			w.Write(e.gz)
			return
		}
		h.Set("Content-Length", itoaLen(len(e.data)))
		w.Write(e.data)
	})
}

func itoaLen(n int) string {
	if n == 0 {
		return "0"
	}
	b := []byte{}
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}
	h := newHub()
	go h.reapLoop()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.Write([]byte(`{"ok":true,"version":"` + AppVersion + `"}`))
	})
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		serveWS(h, w, r)
	})
	mux.Handle("/", serveStatic("public", "game"))

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	log.Printf("flip7 server v%s on :%s", AppVersion, port)
	log.Fatal(srv.ListenAndServe())
}
