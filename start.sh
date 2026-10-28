#!/bin/bash

# 🚀 Space Cowboy - Game Launcher
# Starts a local HTTP server and opens the game in your browser

# SC_PORT=8095 ./start.sh   → another port (default 8081). Not PORT: a shell that
#                             already exports PORT would make the kill below hit
#                             some other program's server.
# ./start.sh --no-browser   → serve only, do not open a browser (tests, remote use)
# ./start.sh --lan          → also listen on the network so the iPad can load the game
#                             (prints its URL). Default: this Mac only (127.0.0.1).
#                             Needs node: the python fallback has no deny list for
#                             .env, .git/, certs/ etc., so it stays local-only and
#                             --lan without node refuses to start.
cd "$(dirname "$0")" || exit 1   # serve this game folder, wherever the script is run from
PORT="${SC_PORT:-8081}"
OPEN_BROWSER=1
LAN=0
ARGS=()
for a in "$@"; do
    if [[ "$a" == "--no-browser" ]]; then OPEN_BROWSER=0
    elif [[ "$a" == "--lan" ]]; then LAN=1
    else ARGS+=("$a"); fi
done
[[ -n "${NO_BROWSER:-}" ]] && OPEN_BROWSER=0

USE_NODE=0
if command -v node >/dev/null 2>&1 && [[ -f scripts/serve.mjs ]]; then USE_NODE=1; fi
if [[ $LAN -eq 1 && $USE_NODE -eq 0 ]]; then
    echo "   ❌ --lan needs node and scripts/serve.mjs: the python fallback has no deny list"
    echo "      (it would hand .env, .git/ and certs/ to the network), so it stays on 127.0.0.1."
    echo "      Install node, or run ./start.sh without --lan."
    exit 1
fi

# Free the port, but only from an old copy of this game's server (never another app).
for PID in $(lsof -ti :"$PORT" -sTCP:LISTEN 2>/dev/null); do
    if ps -o command= -p "$PID" 2>/dev/null | grep -Eq 'serve\.mjs|http\.server'; then
        kill -9 "$PID" 2>/dev/null
    else
        echo "   ❌ Port $PORT is in use by another program (pid $PID). Try: SC_PORT=8095 ./start.sh"
        exit 1
    fi
done
sleep 0.5

echo ""
echo "🤠 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   S P A C E   C O W B O Y"
echo "   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "   🌐 Starting server on port $PORT..."
echo ""

# Serve from this folder with NOTHING to download (2026-10-22). It used to run
# `npx --yes http-server`, which asks the npm registry first; with Wi-Fi up but
# no internet that hung for a minute or more and the browser opened on a dead
# page. scripts/serve.mjs is plain node (no-cache headers like http-server -c-1,
# so the browser always loads the code on disk: owner 2026-09-09 "not seeing the
# changes"). three.js is already local under vendor/. build-tag stamps
# data/build-tag.json so the corner hash is the checkout's real commit
# (Ipad.md §2.5 update-honesty law); it only calls local git.
# The published site artifact has no scripts/ folder: there (or without node)
# python serves the same way, still with no download.
(node scripts/build-tag.mjs >/dev/null 2>&1 || true)
SERVER_OUT=/dev/null
SERVE_ARGS=(--port "$PORT")
if [[ $LAN -eq 1 ]]; then
    SERVE_ARGS+=(--lan)
    SERVER_OUT="$(mktemp -t sc-serve)"
fi
if [[ $USE_NODE -eq 1 ]]; then
    node scripts/serve.mjs "${SERVE_ARGS[@]}" >"$SERVER_OUT" 2>&1 &
    SERVER_PID=$!
else
    python3 - "$PORT" >/dev/null 2>&1 <<'PY' &
import http.server, sys
class NoStore(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()
http.server.ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), NoStore).serve_forever()
PY
    SERVER_PID=$!
fi

# Wait (up to ~15 s) until the server really answers, before anything opens.
READY=0
for _ in $(seq 1 60); do
    if curl -s -o /dev/null -m 1 "http://127.0.0.1:$PORT/" 2>/dev/null; then READY=1; break; fi
    kill -0 $SERVER_PID 2>/dev/null || break
    sleep 0.25
done

# Verify server started
if [[ $READY -ne 1 ]]; then
    kill $SERVER_PID 2>/dev/null
    echo "   ❌ The server did not start on port $PORT. Try: SC_PORT=8095 ./start.sh"
    exit 1
fi

# Optional query string argument — pass the URL params you want, with or
# without a leading "?". Examples:
#   ./start.sh                   → http://localhost:$PORT/
#   ./start.sh autoProfile=1     → http://localhost:$PORT/?autoProfile=1
#   ./start.sh '?perfReport=1&tier=LOW'
#                                → http://localhost:$PORT/?perfReport=1&tier=LOW
QS="${ARGS[0]:-}"
QS="${QS#\?}"   # strip leading '?' if user supplied one
if [[ -n "$QS" ]]; then
  URL="http://localhost:$PORT/?$QS"
else
  URL="http://localhost:$PORT/"
fi

# Open in default browser.
#
# --disable-features=SkiaGraphite: Brave Nightly / Chromium canary channels
# ship the experimental Skia Graphite Metal compositing backend (brave://gpu
# → "Skia Graphite: Enabled"), which drops the WebGL canvas IOSurface at
# composite time → flashing BLACK RECTANGLES over the game while the
# framebuffer stays healthy (proven by ?bfp=2 pixel reads, 2026-08-31, dumps
# bfp-dump-1788217897/1788218027; a window resize heals it by rebuilding the
# swap-chain). Stable channels run Graphite disabled, so the flag is a
# harmless no-op there.
#
# CAVEAT: Chromium-family browsers apply launch flags ONLY on a fresh process
# start. If the browser is already running, the URL opens in the existing
# instance and the flag is ignored — fully quit the browser first (Cmd+Q).
BROWSER_FLAGS="--disable-features=SkiaGraphite"
if pgrep -f "Brave Browser Nightly" >/dev/null 2>&1; then
    echo "   ⚠️  Brave Nightly is already running — $BROWSER_FLAGS only applies"
    echo "      on a fresh launch. Quit it fully (Cmd+Q) and re-run ./start.sh,"
    echo "      or ignore this if you're playing in stable Brave/Safari/Chrome."
fi
echo "   ✅ Server running at: $URL"
if [[ $LAN -eq 1 ]]; then
    echo "   📱 iPad / other devices on this network:"
    grep '^LAN ' "$SERVER_OUT" | sed 's/^LAN /      /'
    rm -f "$SERVER_OUT"
fi
if [[ $OPEN_BROWSER -eq 1 ]]; then
    open "$URL" --args $BROWSER_FLAGS
    echo "   🎮 Opening game in browser..."
fi
echo ""
echo "   To stop the server:"
echo "   kill $SERVER_PID"
echo ""
echo "🤠 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
