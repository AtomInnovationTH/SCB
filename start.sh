#!/bin/bash

# 🚀 Space Cowboy - Game Launcher
# Starts a local HTTP server and opens the game in your browser

PORT=8081

# Kill any existing process on port 8081 to ensure it's available
lsof -ti :$PORT | xargs kill -9 2>/dev/null
sleep 0.5

echo ""
echo "🤠 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   S P A C E   C O W B O Y"
echo "   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "   🌐 Starting server on port $PORT..."
echo ""

# Start the Python HTTP server in the background
python3 -m http.server $PORT >/dev/null 2>&1 &
SERVER_PID=$!

# Wait for server to be ready
sleep 1

# Verify server started
if ! kill -0 $SERVER_PID 2>/dev/null; then
    echo "   ❌ Failed to start server!"
    exit 1
fi

# Optional query string argument — pass the URL params you want, with or
# without a leading "?". Examples:
#   ./start.sh                   → http://localhost:8081/
#   ./start.sh autoProfile=1     → http://localhost:8081/?autoProfile=1
#   ./start.sh '?perfReport=1&tier=LOW'
#                                → http://localhost:8081/?perfReport=1&tier=LOW
QS="${1:-}"
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
open "$URL" --args $BROWSER_FLAGS

echo "   ✅ Server running at: $URL"
echo "   🎮 Opening game in browser..."
echo ""
echo "   To stop the server:"
echo "   kill $SERVER_PID"
echo ""
echo "🤠 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
