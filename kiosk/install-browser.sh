#!/bin/sh
# =============================================================================
# install-browser.sh — On-device NetSurf-FB installer (runs ON the HC800)
# =============================================================================
#
# This script is uploaded to the HC800 by install.sh and executed via SSH.
# It downloads the NetSurf-FB framebuffer browser from the Debian Jessie
# archive and extracts it into /mnt/internal/browser/, then fetches all
# missing shared libraries (also from Debian Jessie i386) and places them
# in /mnt/internal/browser/lib/ so the dynamic linker can find them.
#
# Why NetSurf-FB from Debian Jessie i386?
#   - Renders HTML/CSS/JS directly to /dev/fb0 via SDL fbcon — no X11/GL/EGL
#   - Built against glibc 2.19, exactly matching the HC800 (Intel Atom D525,
#     BusyBox Linux, kernel 3.16.38, glibc 2.19)
#   - All libraries also sourced from Jessie i386, same glibc ABI
#   - SDL is directed to the Linux framebuffer via SDL_VIDEODRIVER=fbcon
#
# =============================================================================

set -e

BROWSER_DIR=/mnt/internal/browser
DEBIAN_BASE="http://archive.debian.org/debian"
# Use /mnt/internal for downloads — HC800 has no /tmp
DLDIR=/mnt/internal/browser-dl
LIBS_DIR="$BROWSER_DIR/lib"
EXTRACT_DIR="$DLDIR/extract"

log() { echo "[browser-install] $*"; }

log "Creating directories..."
mkdir -p "$BROWSER_DIR" "$DLDIR" "$LIBS_DIR"

# ── Download and extract NetSurf-FB ───────────────────────────────────────────
FB_DEB="netsurf-fb_3.2+dfsg-2+b1_i386.deb"
COMMON_DEB="netsurf-common_3.2+dfsg-2_all.deb"
NETSURF_BASE="$DEBIAN_BASE/pool/main/n/netsurf"

log "Downloading $FB_DEB (~664 KB)..."
wget -q -T 60 \
  "$NETSURF_BASE/$FB_DEB" -O "$DLDIR/netsurf-fb.deb" \
  || { log "ERROR: Download failed for $FB_DEB"; exit 1; }

log "Downloading $COMMON_DEB (~290 KB)..."
wget -q -T 60 \
  "$NETSURF_BASE/$COMMON_DEB" -O "$DLDIR/netsurf-common.deb" \
  || { log "ERROR: Download failed for $COMMON_DEB"; exit 1; }

log "Extracting netsurf-fb package..."
dpkg -x "$DLDIR/netsurf-fb.deb" "$BROWSER_DIR"

log "Extracting netsurf-common package (resources, CSS, icons)..."
dpkg -x "$DLDIR/netsurf-common.deb" "$BROWSER_DIR"

chmod +x "$BROWSER_DIR/usr/bin/netsurf-fb" 2>/dev/null || true

# ── Fetch Jessie package index ────────────────────────────────────────────────
log "Downloading Jessie package index (for missing shared libraries)..."
PKGS_GZ="$DLDIR/Packages.gz"
PKGS_FILE="$DLDIR/Packages"
wget -q -T 60 \
  "$DEBIAN_BASE/dists/jessie/main/binary-i386/Packages.gz" -O "$PKGS_GZ" \
  || { log "ERROR: Could not download Jessie Packages.gz"; exit 1; }
gunzip -c "$PKGS_GZ" > "$PKGS_FILE"
log "Package index ready."

# ── Helper: resolve, download, and extract one Debian package ─────────────────
# Finds the package's Filename: in Packages, downloads the .deb, and copies
# all .so / .so.* files flat into $LIBS_DIR.
install_pkg() {
  _pkgname="$1"
  log "  Installing $_pkgname..."
  _filename=$(awk -v pkg="$_pkgname" '
    /^Package:/  { cur = $2; fn = ""; done = 0 }
    /^Filename:/ { fn = $2 }
    /^$/         { if (cur == pkg && fn != "") { print fn; done = 1; exit } }
    END          { if (!done && cur == pkg && fn != "") print fn }
  ' "$PKGS_FILE")
  if [ -z "$_filename" ]; then
    log "  WARNING: $_pkgname not found in index — skipping"
    return 0
  fi
  wget -q -T 60 "$DEBIAN_BASE/$_filename" -O "$DLDIR/pkg.deb" \
    || { log "  WARNING: download failed for $_pkgname — skipping"; return 0; }
  rm -rf "$EXTRACT_DIR"
  mkdir -p "$EXTRACT_DIR"
  dpkg -x "$DLDIR/pkg.deb" "$EXTRACT_DIR"
  # Copy all versioned .so files and symlinks flat into LIBS_DIR
  find "$EXTRACT_DIR" \( -name "*.so" -o -name "*.so.*" \) | while read sofile; do
    cp -d "$sofile" "$LIBS_DIR/" 2>/dev/null || true
  done
  rm -f "$DLDIR/pkg.deb"
}

# ── Install all missing shared libraries ─────────────────────────────────────
log "Installing missing shared libraries to $LIBS_DIR ..."

# libxcb.so.1  and  libxcb-shm.so.0  (both from the libxcb source package)
install_pkg libxcb1
install_pkg libxcb-shm0
# XCB extension libs required by netsurf-fb
install_pkg libxcb-util0
install_pkg libxcb-icccm4
install_pkg libxcb-image0
install_pkg libxcb-keysyms1
# SpiderMonkey JS engine
install_pkg libmozjs185-1.0
# SDL 1.2 (used as the display backend; directed to fbcon below)
install_pkg libsdl1.2debian
# X11/Xau/Xdmcp libs — SDL links against these even when using the fbcon driver
install_pkg libxau6
install_pkg libxdmcp6
install_pkg libx11-6
install_pkg libxext6

log "All shared libraries installed."

# ── Fix libpng12 symlink (points to nonexistent Debian path on HC800) ────────
log "Fixing libpng12 symlink..."
if ls "$LIBS_DIR"/libpng12.so.0.* > /dev/null 2>&1; then
  _png=$(ls "$LIBS_DIR"/libpng12.so.0.* | head -1)
  ln -sf "$_png" "$LIBS_DIR/libpng12.so.0"
  log "  libpng12.so.0 -> $_png"
else
  log "  WARNING: libpng12 not found in $LIBS_DIR — PNG rendering may fail"
fi

# ── Install DejaVu fonts for text rendering ───────────────────────────────────
log "Installing DejaVu fonts..."
FONT_DIR="$BROWSER_DIR/usr/share/netsurf"
mkdir -p "$FONT_DIR"
_font_packages="fonts-dejavu-core fonts-dejavu"
for _pkg in $_font_packages; do
  _fn=$(awk -v pkg="$_pkg" '
    /^Package:/  { cur = $2; fn = "" }
    /^Filename:/ { fn = $2 }
    /^$/         { if (cur == pkg && fn != "") { print fn; exit } }
    END          { if (cur == pkg && fn != "") print fn }
  ' "$PKGS_FILE")
  if [ -n "$_fn" ]; then
    wget -q -T 60 "$DEBIAN_BASE/$_fn" -O "$DLDIR/pkg.deb" || true
    rm -rf "$EXTRACT_DIR"
    mkdir -p "$EXTRACT_DIR"
    dpkg -x "$DLDIR/pkg.deb" "$EXTRACT_DIR" 2>/dev/null || true
    find "$EXTRACT_DIR" -name "*.ttf" | while read ttf; do
      cp "$ttf" "$FONT_DIR/" 2>/dev/null || true
    done
    rm -f "$DLDIR/pkg.deb"
    log "  Installed fonts from $_pkg"
    break
  fi
done

# Create required symlinks for font names NetSurf expects
cd "$FONT_DIR"
for src in DejaVuSans-Bold DejaVuSans-Oblique DejaVuSans-BoldOblique \
           DejaVuSerif DejaVuSerif-Bold DejaVuSansMono DejaVuSansMono-Bold; do
  if [ ! -f "${src}.ttf" ]; then
    # Try to find best match
    case "$src" in
      DejaVuSans-Oblique|DejaVuSans-BoldOblique) ln -sf DejaVuSans.ttf "${src}.ttf" 2>/dev/null || true ;;
      DejaVuSerif*) ln -sf DejaVuSans.ttf "${src}.ttf" 2>/dev/null || true ;;
      *) ln -sf DejaVuSans.ttf "${src}.ttf" 2>/dev/null || true ;;
    esac
  fi
done
cd /
log "Fonts ready in $FONT_DIR"

# ── Compile and install fake-vt-shim ─────────────────────────────────────────
#
# The HC800 uses inteldrmfb (no VT console). NetSurf-FB's SDL fbcon backend
# tries VT/KD ioctls on startup and crashes if they fail. This shim:
#  - Intercepts VT_OPENQRY, VT_GETMODE, VT_SETMODE, VT_ACTIVATE...
#  - Intercepts KD ioctls (KDSETMODE, KDGKBMODE, KDSIGACCEPT)
#  - Strips SDL_FULLSCREEN/SDL_HWSURFACE/SDL_DOUBLEBUF from SetVideoMode
#
# Requires: gcc, libSDL1.2-dev headers (or SDL.h available)
# The source file fake-vt-shim.c and pre-compiled fake-vt-shim.so are
# deployed alongside this script by deploy_hc800_www.sh.
log "Installing fake-vt-shim.so..."
# Look for files next to this script (deployed by deploy_hc800_www.sh)
SCRIPT_DIR_SELF="$(cd "$(dirname "$0")" 2>/dev/null && pwd || echo /www/c4kiosk)"
SHIM_SO="$LIBS_DIR/fake-vt-shim.so"
SHIM_SO_SRC="$SCRIPT_DIR_SELF/fake-vt-shim.so"
SHIM_C_SRC="$SCRIPT_DIR_SELF/fake-vt-shim.c"

if [ -f "$SHIM_SO_SRC" ]; then
  # Pre-compiled binary deployed alongside this script
  cp "$SHIM_SO_SRC" "$SHIM_SO"
  chmod 755 "$SHIM_SO"
  log "  fake-vt-shim.so installed from pre-compiled binary"
else
  # Fall back: compile from source (requires gcc on target device)
  log "  No pre-compiled shim found at $SHIM_SO_SRC — trying to compile from source..."
  _gcc=$(which gcc 2>/dev/null || which cc 2>/dev/null || echo "")
  if [ -z "$_gcc" ]; then
    log "  WARNING: gcc not found and no pre-compiled shim available"
    log "  Browser VT ioctls will fail — HDMI output will be blank"
  elif [ ! -f "$SHIM_C_SRC" ]; then
    log "  WARNING: neither fake-vt-shim.so nor fake-vt-shim.c found"
    log "  Re-run deploy_hc800_www.sh on the installer machine then re-run this script"
  else
    _sdl_inc=""
    for _d in /usr/include/SDL /usr/include; do
      if [ -f "$_d/SDL.h" ]; then _sdl_inc="-I$_d"; break; fi
    done
    "$_gcc" -shared -fPIC -O2 -o "$SHIM_SO" "$SHIM_C_SRC" \
      $_sdl_inc -ldl -D_GNU_SOURCE 2>&1 \
      && log "  fake-vt-shim.so compiled successfully at $SHIM_SO" \
      || log "  WARNING: shim compilation failed — browser VT ioctls will fail"
  fi
fi

# ── Write kiosk Choices file ──────────────────────────────────────────────────
log "Writing NetSurf kiosk Choices..."
mkdir -p /root/.netsurf
cat > /root/.netsurf/Choices << 'EOCHOICES'
window_width:1280
window_height:720
window_screen_width:1280
window_screen_height:720
fb_toolbar_size:1
fb_furniture_size:1
fb_toolbar_layout:
EOCHOICES
log "  Choices written: window 1280x720, toolbar hidden"

# ── Create launcher wrapper ───────────────────────────────────────────────────
log "Writing launcher: $BROWSER_DIR/launch.sh"
cat > "$BROWSER_DIR/launch.sh" << 'EOLAUNCH'
#!/bin/sh
# NetSurf-FB kiosk launcher — HC800 (inteldrmfb, i386)
#
# Requirements:
#   - HTML pages MUST include <meta charset="UTF-8"> or serve with
#     Content-Type: text/html; charset=UTF-8 — otherwise NetSurf reports
#     "BadEncoding" and renders a white page.
#   - The fake-vt-shim.so intercepts VT/KD ioctls that fail on inteldrmfb.
export NETSURFRES=/mnt/internal/browser/usr/share/netsurf
export HOME=/root
export SDL_VIDEODRIVER=fbcon
export SDL_FBDEV=/dev/fb0
export DISPLAY=
export LD_LIBRARY_PATH=/mnt/internal/browser/lib:/mnt/internal/browser/usr/lib:/usr/lib:/lib
export LD_PRELOAD=/mnt/internal/browser/lib/fake-vt-shim.so
exec /mnt/internal/browser/usr/bin/netsurf-fb "$@"
EOLAUNCH
chmod +x "$BROWSER_DIR/launch.sh"

# ── Cleanup ───────────────────────────────────────────────────────────────────
log "Removing temporary download files..."
rm -rf "$DLDIR"

# ── Smoke test — report any still-missing libraries ──────────────────────────
log "Checking for still-missing libraries..."
LD_LIBRARY_PATH=$BROWSER_DIR/lib:$BROWSER_DIR/usr/lib:/usr/lib:/lib \
  LD_TRACE_LOADED_OBJECTS=1 \
  /mnt/internal/browser/usr/bin/netsurf-fb 2>&1 | grep "not found" \
  && log "WARNING: some libs still missing (see above)" \
  || log "All libraries resolved successfully!"

log "Browser installation complete."
log "  Binary:    $BROWSER_DIR/usr/bin/netsurf-fb"
log "  Launcher:  $BROWSER_DIR/launch.sh"
log "  Shim:      $LIBS_DIR/fake-vt-shim.so"
log "  Libs:      $LIBS_DIR"
log "  Resources: $BROWSER_DIR/usr/share/netsurf"
log "  Choices:   /root/.netsurf/Choices (1280x720 kiosk, toolbar hidden)"
log ""
log "IMPORTANT: HTML pages must include <meta charset=\"UTF-8\">!"
log "Test with:  POST http://<hc800>:8099/api/url  {\"url\":\"http://example.com\"}"
