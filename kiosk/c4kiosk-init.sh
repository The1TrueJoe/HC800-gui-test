#!/bin/sh
### BEGIN INIT INFO
# Provides:          c4kiosk
# Required-Start:    $network $local_fs
# Required-Stop:     $network $local_fs
# Default-Start:     2 3 4 5
# Default-Stop:      0 1 6
# Short-Description: Control4 HC800 kiosk display API
# Description:       Starts the Node.js kiosk API that renders web content
#                    to the HC800 HDMI output via the NetSurf-FB browser.
### END INIT INFO

# Path constants — must match what deploy/start-api.sh uses
STARTSCRIPT=/www/c4kiosk/start-api.sh
STOPSCRIPT=/www/c4kiosk/stop-api.sh
PIDFILE=/var/run/c4kiosk-api.pid
NAME=c4kiosk

case "$1" in
  start)
    if [ -x "$STARTSCRIPT" ]; then
      echo "Starting $NAME..."
      "$STARTSCRIPT"
    else
      echo "Error: $STARTSCRIPT not found" >&2
      exit 1
    fi
    ;;
  stop)
    if [ -x "$STOPSCRIPT" ]; then
      echo "Stopping $NAME..."
      "$STOPSCRIPT"
    else
      PID=$(cat "$PIDFILE" 2>/dev/null || echo "")
      if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
        kill "$PID"
      fi
    fi
    ;;
  restart)
    "$0" stop
    sleep 1
    "$0" start
    ;;
  status)
    PID=$(cat "$PIDFILE" 2>/dev/null || echo "")
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
      echo "$NAME is running (pid $PID)"
      exit 0
    else
      echo "$NAME is not running"
      exit 1
    fi
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status}" >&2
    exit 1
    ;;
esac
