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

# Open in default browser
open "$URL"

echo "   ✅ Server running at: $URL"
echo "   🎮 Opening game in browser..."
echo ""
echo "   To stop the server:"
echo "   kill $SERVER_PID"
echo ""
echo "🤠 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
