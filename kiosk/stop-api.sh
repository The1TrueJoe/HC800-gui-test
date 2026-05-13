#!/bin/sh
set -e

PIDFILE=/var/run/c4kiosk-api.pid

if [ ! -f "$PIDFILE" ]; then
  echo "c4kiosk api pidfile not found"
  exit 0
fi

PID=$(cat "$PIDFILE" 2>/dev/null || true)
if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
  kill "$PID" || true
  sleep 1
  if kill -0 "$PID" 2>/dev/null; then
    kill -9 "$PID" || true
  fi
  echo "stopped c4kiosk api pid=$PID"
else
  echo "c4kiosk api was not running"
fi
rm -f "$PIDFILE"
