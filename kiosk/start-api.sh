#!/bin/sh
set -e

ROOT=/www/c4kiosk
PORT=${C4KIOSK_PORT:-8099}
PIDFILE=/var/run/c4kiosk-api.pid
LOG=/var/log/debug/c4kiosk-api.log
NODE=/usr/bin/node

if [ ! -x "$NODE" ]; then
  echo "node not found at $NODE" >&2
  exit 1
fi

if [ -f "$PIDFILE" ]; then
  OLD=$(cat "$PIDFILE" 2>/dev/null || true)
  if [ -n "$OLD" ] && kill -0 "$OLD" 2>/dev/null; then
    echo "c4kiosk api already running pid=$OLD"
    exit 0
  fi
fi

mkdir -p /var/run /var/log/debug
cd "$ROOT"
nohup "$NODE" "$ROOT/api.js" >> "$LOG" 2>&1 &
PID=$!
echo "$PID" > "$PIDFILE"
sleep 1
if kill -0 "$PID" 2>/dev/null; then
  echo "started c4kiosk api pid=$PID port=$PORT log=$LOG"
else
  echo "c4kiosk api failed to start; log follows:" >&2
  tail -40 "$LOG" >&2 || true
  exit 1
fi
