#!/usr/bin/env bash
# =============================================================================
# deploy.sh — Deploy HC800 kiosk files and run the installer
#
# Usage:
#   HC800_HOST=192.168.1.x HC800_PASS=your_password ./scripts/deploy.sh
#
#   Or set the password interactively (prompted if HC800_PASS not set).
#   HC800_HOST defaults to 192.168.1.147.
#
# What this does:
#   1. Copies all files from kiosk/ to /www/c4kiosk/ on the HC800
#   2. Runs install-browser.sh on the HC800 (downloads NetSurf-FB, shim, etc)
#   3. Registers and starts the kiosk API service
#
# Requirements (on this machine):
#   - sshpass    (brew install sshpass)
#   - ssh / scp  (standard)
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIOSK_DIR="$(cd "$SCRIPT_DIR/../kiosk" && pwd)"

HC800_HOST="${HC800_HOST:-192.168.1.147}"
HC800_USER="${HC800_USER:-root}"
HC800_PASS="${HC800_PASS:-}"
REMOTE_DIR="${REMOTE_DIR:-/www/c4kiosk}"

# ── Colour helpers ─────────────────────────────────────────────────────────
bold='\033[1m'; green='\033[0;32m'; red='\033[0;31m'; yellow='\033[0;33m'; reset='\033[0m'
info()  { echo -e "  ${green}✓${reset} $*"; }
warn()  { echo -e "  ${yellow}⚠${reset} $*"; }
error() { echo -e "  ${red}✗${reset} $*" >&2; exit 1; }
step()  { echo -e "\n${bold}▶ $*${reset}"; }

echo -e "\n${bold}HC800 Kiosk — Deploy${reset}"
echo    "  Host: $HC800_HOST"
echo    "  User: $HC800_USER"
echo    "  Dest: $REMOTE_DIR"

# ── Get password ────────────────────────────────────────────────────────────
if [[ -z "$HC800_PASS" ]]; then
  read -rs -p "  Password for $HC800_USER@$HC800_HOST: " HC800_PASS
  echo
fi

if ! command -v sshpass &>/dev/null; then
  error "sshpass not found. Install with: brew install sshpass"
fi

# ── Shared SSH/SCP options ──────────────────────────────────────────────────
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o PubkeyAuthentication=no)
alias c4ssh="sshpass -p '$HC800_PASS' ssh ${SSH_OPTS[*]} $HC800_USER@$HC800_HOST"
alias c4scp="sshpass -p '$HC800_PASS' scp -O ${SSH_OPTS[*]}"

_ssh() { sshpass -p "$HC800_PASS" ssh "${SSH_OPTS[@]}" "$HC800_USER@$HC800_HOST" "$@"; }
_scp() { sshpass -p "$HC800_PASS" scp -O "${SSH_OPTS[@]}" "$@"; }

# ── Test connectivity ────────────────────────────────────────────────────────
step "Testing connectivity"
if ! _ssh "echo ok" &>/dev/null; then
  error "Cannot connect to $HC800_HOST — check host, user, and password"
fi
info "Connected to $HC800_HOST"

# ── Create remote directory ─────────────────────────────────────────────────
step "Creating $REMOTE_DIR"
_ssh "mkdir -p '$REMOTE_DIR' && chmod 755 '$REMOTE_DIR'"
info "Remote directory ready"

# ── Upload kiosk files ──────────────────────────────────────────────────────
step "Uploading kiosk files"
FILES=(api.js index.html start-api.sh stop-api.sh config.json install-browser.sh c4kiosk-init.sh fake-vt-shim.c fake-vt-shim.so react-host-demo.html react-host-demo.js)
for f in "${FILES[@]}"; do
  src="$KIOSK_DIR/$f"
  if [[ ! -f "$src" ]]; then
    warn "$f not found locally — skipping"
    continue
  fi
  _scp "$src" "$HC800_USER@$HC800_HOST:$REMOTE_DIR/$f"
  info "Uploaded $f"
done

# ── Fix permissions ─────────────────────────────────────────────────────────
_ssh "chmod 755 '$REMOTE_DIR/api.js' '$REMOTE_DIR/start-api.sh' \
  '$REMOTE_DIR/stop-api.sh' '$REMOTE_DIR/install-browser.sh' \
  '$REMOTE_DIR/c4kiosk-init.sh' '$REMOTE_DIR/fake-vt-shim.so'; \
  chmod 644 '$REMOTE_DIR/index.html' '$REMOTE_DIR/config.json' '$REMOTE_DIR/fake-vt-shim.c' \
  '$REMOTE_DIR/react-host-demo.html' '$REMOTE_DIR/react-host-demo.js'"
info "Permissions set"

# ── Run the browser installer ───────────────────────────────────────────────
step "Running browser installer (this downloads ~30 MB — takes 1-3 minutes)"
echo "    You'll see progress logs from the HC800..."
echo
_ssh "sh '$REMOTE_DIR/install-browser.sh'" || warn "Installer exited non-zero — check output above"
echo

# ── Register init.d service ─────────────────────────────────────────────────
step "Registering init.d service"
_ssh "cp '$REMOTE_DIR/c4kiosk-init.sh' /etc/init.d/c4kiosk && \
  chmod 755 /etc/init.d/c4kiosk && \
  update-rc.d c4kiosk defaults 2>/dev/null || \
  ln -sf /etc/init.d/c4kiosk /etc/rc5.d/S99c4kiosk 2>/dev/null || true" \
  && info "Service registered" || warn "init.d registration failed — start manually with start-api.sh"

# ── Start the API ────────────────────────────────────────────────────────────
step "Starting kiosk API"
_ssh "sh '$REMOTE_DIR/start-api.sh'" && info "API started on port 8099" || warn "API start failed — check logs"

# ── Done ─────────────────────────────────────────────────────────────────────
echo
echo -e "${bold}${green}All done!${reset}"
echo
echo "  Control panel:  http://$HC800_HOST/c4kiosk/"
echo "  API:            http://$HC800_HOST:8099/api/status"
echo
echo "  To display a URL:"
echo "    curl -X POST http://$HC800_HOST:8099/api/url \\"
echo "         -H 'Content-Type: application/json' \\"
echo "         -d '{\"url\":\"http://$HC800_HOST/c4kiosk/\"}'"
echo
