#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
ELECTRON="$DIR/node_modules/.bin/electron"

if [ ! -f "$ELECTRON" ]; then
  echo "Electron not found. Run: npm install"
  exit 1
fi

# Kill any existing JARVIS instance first
pkill -f "electron.*jarvis" 2>/dev/null
sleep 0.5

# Fully detach from terminal — prevents EIO crash
nohup "$ELECTRON" "$DIR" --no-sandbox > "$HOME/jarvis.log" 2>&1 &

echo ""
echo "✅  JARVIS launched (PID: $!)"
echo "🔵  Look for the orb in the top-left corner of your screen"
echo "📋  Logs: tail -f ~/jarvis.log"
echo ""
