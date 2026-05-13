#!/usr/bin/env node
'use strict';

/*
 * HC800 framebuffer kiosk control API.
 *
 * Runs directly on the HC800 with the built-in Node.js v10 runtime. No npm
 * packages are required. The headless browser runs off-device and POSTs raw
 * 1280x720 BGRX frames to this API, which writes them to /dev/fb0.
 */

var http = require('http');
var fs = require('fs');
var path = require('path');
var url = require('url');
var childProcess = require('child_process');

var VERSION = '0.1.0';
var ROOT = '/www/c4kiosk';
var FB = process.env.C4KIOSK_FB || '/dev/fb0';
var PORT = parseInt(process.env.C4KIOSK_PORT || '8099', 10);
var WIDTH = parseInt(process.env.C4KIOSK_WIDTH || '1280', 10);
var HEIGHT = parseInt(process.env.C4KIOSK_HEIGHT || '720', 10);
var STRIDE = parseInt(process.env.C4KIOSK_STRIDE || '5120', 10);
var BYTES_PER_PIXEL = 4;
var FRAME_SIZE = STRIDE * HEIGHT;
var MAX_BODY = FRAME_SIZE + 1024;
var CONFIG_PATH = path.join(ROOT, 'config.json');
var TOKEN_PATH = path.join(ROOT, 'token.txt');
var LOGO_RAW = process.env.C4KIOSK_LOGO_RAW || '/var/c4kiosk-logo.raw';
var LAST_RAW = process.env.C4KIOSK_LAST_RAW || '/var/c4kiosk-last-frame.raw';
// NetSurf-FB launcher wrapper installed by install.sh
var BROWSER_BIN = process.env.C4KIOSK_BROWSER || '/mnt/internal/browser/launch.sh';

var startedAt = Date.now();
var lastFrame = null;

// Browser child-process state (persists across requests)
var browserProc = null;
var browserState = {
  pid: null,
  url: null,
  startedAt: null,
  restarts: 0,
  exitCode: null,
  stderr: ''
};

function nowIso() {
  return new Date().toISOString();
}

function log(message) {
  console.log(nowIso() + ' ' + message);
}

function readText(filePath, fallback) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return fallback;
  }
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

function defaultConfig() {
  return {
    enabled: true,
    url: 'http://192.168.1.147/c4kiosk/',
    fps: 1,
    width: WIDTH,
    height: HEIGHT,
    pixelFormat: 'bgrx',
    updatedAt: nowIso()
  };
}

function getConfig() {
  var cfg = readJson(CONFIG_PATH, null);
  if (!cfg || typeof cfg !== 'object') {
    cfg = defaultConfig();
    try { writeJson(CONFIG_PATH, cfg); } catch (err) {}
  }
  if (typeof cfg.enabled !== 'boolean') cfg.enabled = true;
  if (!cfg.url) cfg.url = defaultConfig().url;
  if (!cfg.fps || cfg.fps < 0.1) cfg.fps = 1;
  cfg.width = WIDTH;
  cfg.height = HEIGHT;
  cfg.pixelFormat = 'bgrx';
  return cfg;
}

function setConfig(partial) {
  var cfg = getConfig();
  if (typeof partial.enabled === 'boolean') cfg.enabled = partial.enabled;
  if (typeof partial.url === 'string' && partial.url.length > 0) cfg.url = partial.url;
  if (typeof partial.fps === 'number' && isFinite(partial.fps)) {
    cfg.fps = Math.max(0.1, Math.min(10, partial.fps));
  }
  cfg.updatedAt = nowIso();
  writeJson(CONFIG_PATH, cfg);
  return cfg;
}

function tokenValue() {
  var txt = readText(TOKEN_PATH, '').trim();
  return txt || null;
}

function requireToken(req, parsed) {
  var token = tokenValue();
  if (!token) return true;
  var supplied = req.headers['x-c4kiosk-token'] || parsed.query.token || '';
  return supplied === token;
}

function send(res, status, body, contentType) {
  var headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-C4Kiosk-Token',
    'Cache-Control': 'no-store'
  };
  if (contentType) headers['Content-Type'] = contentType;
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj, null, 2) + '\n', 'application/json');
}

function notFound(res) {
  sendJson(res, 404, { ok: false, error: 'not_found' });
}

// ── Browser process management ─────────────────────────────────────────────

function isBrowserRunning() {
  return browserProc !== null;
}

/**
 * Kill the running browser (if any) then invoke cb().
 * Sends SIGTERM and waits up to 1 s before SIGKILL.
 */
function stopBrowser(cb) {
  if (!isBrowserRunning()) {
    if (cb) cb();
    return;
  }
  var proc = browserProc;
  browserProc = null;
  var done = false;
  function finish() {
    if (done) return;
    done = true;
    if (cb) cb();
  }
  var killer = setTimeout(function () {
    try { proc.kill('SIGKILL'); } catch (e) {}
    finish();
  }, 1000);
  proc.once('exit', function () { clearTimeout(killer); finish(); });
  try { proc.kill('SIGTERM'); } catch (e) { clearTimeout(killer); finish(); }
}

/**
 * Launch the browser for targetUrl.
 * Stops any existing browser first, then spawns BROWSER_BIN.
 * Calls cb(err) immediately after spawning (does not wait for browser to finish).
 */
function startBrowser(targetUrl, cb) {
  if (!fs.existsSync(BROWSER_BIN)) {
    var err = new Error('browser_not_installed — run install.sh first');
    log(err.message);
    if (cb) cb(err);
    return;
  }
  stopBrowser(function () {
    log('startBrowser: ' + targetUrl);
    var env = {};
    Object.keys(process.env).forEach(function (k) { env[k] = process.env[k]; });
    env.NETSURFRES = '/mnt/internal/browser/usr/share/netsurf';

    var proc = childProcess.spawn(BROWSER_BIN, [targetUrl], {
      env: env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    browserProc = proc;
    var pid = proc.pid;
    browserState.pid = pid;
    browserState.url = targetUrl;
    browserState.startedAt = nowIso();
    browserState.exitCode = null;
    browserState.stderr = '';
    browserState.restarts += 1;

    function tapStream(stream) {
      stream.on('data', function (d) {
        var s = d.toString('utf8').trim();
        if (s) log('browser[' + pid + ']: ' + s.slice(0, 200));
        browserState.stderr = (browserState.stderr + s + '\n').slice(-4096);
      });
    }
    tapStream(proc.stdout);
    tapStream(proc.stderr);

    proc.on('exit', function (code, signal) {
      log('browser exited: pid=' + pid + ' code=' + code + ' signal=' + signal);
      browserState.exitCode = code !== null ? code : -1;
      if (browserProc === proc) browserProc = null;
    });

    if (cb) cb(null);
  });
}

function readBody(req, limit, cb) {
  var chunks = [];
  var total = 0;
  var done = false;

  function finish(err, buf) {
    if (done) return;
    done = true;
    cb(err, buf);
  }

  req.on('data', function (chunk) {
    total += chunk.length;
    if (total > limit) {
      finish(new Error('body_too_large'));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', function () {
    finish(null, Buffer.concat(chunks, total));
  });
  req.on('error', function (err) { finish(err); });
}

function framebufferInfo() {
  function sys(name) {
    return readText('/sys/class/graphics/fb0/' + name, '').trim();
  }
  return {
    device: FB,
    procFb: readText('/proc/fb', '').trim(),
    name: sys('name'),
    virtualSize: sys('virtual_size'),
    bitsPerPixel: sys('bits_per_pixel'),
    stride: sys('stride'),
    modes: sys('modes'),
    expected: {
      width: WIDTH,
      height: HEIGHT,
      stride: STRIDE,
      bytes: FRAME_SIZE,
      pixelFormat: 'bgrx'
    }
  };
}

function writeFrameBuffer(buf) {
  if (!Buffer.isBuffer(buf)) throw new Error('frame_not_buffer');
  if (buf.length !== FRAME_SIZE) {
    throw new Error('bad_frame_size:' + buf.length + ':expected:' + FRAME_SIZE);
  }
  fs.writeFileSync(LAST_RAW, buf);
  fs.writeFileSync(FB, buf);
  lastFrame = {
    bytes: buf.length,
    at: nowIso(),
    source: 'api'
  };
}

function readFixed(filePath, size) {
  var fd = fs.openSync(filePath, 'r');
  try {
    var buf = Buffer.alloc(size);
    var offset = 0;
    while (offset < size) {
      var n = fs.readSync(fd, buf, offset, size - offset, null);
      if (n <= 0) break;
      offset += n;
    }
    return offset === size ? buf : buf.slice(0, offset);
  } finally {
    fs.closeSync(fd);
  }
}

function captureLogoIfNeeded() {
  try {
    if (!fs.existsSync(LOGO_RAW) && fs.existsSync(FB)) {
      var buf = readFixed(FB, FRAME_SIZE);
      if (buf.length === FRAME_SIZE) {
        fs.writeFileSync(LOGO_RAW, buf);
        log('captured startup framebuffer to ' + LOGO_RAW);
      }
    }
  } catch (err) {
    log('startup framebuffer capture failed: ' + err.message);
  }
}

function makeTestPattern() {
  var buf = Buffer.alloc(FRAME_SIZE);
  var colors = [
    [255, 255, 255], [255, 255, 0], [0, 255, 255], [0, 255, 0],
    [255, 0, 255], [255, 0, 0], [0, 0, 255], [0, 0, 0]
  ];
  for (var y = 0; y < HEIGHT; y++) {
    for (var x = 0; x < WIDTH; x++) {
      var r, g, b;
      if (x < 8 || y < 8 || x >= WIDTH - 8 || y >= HEIGHT - 8) {
        r = g = b = 255;
      } else if (x < 16 || y < 16 || x >= WIDTH - 16 || y >= HEIGHT - 16) {
        r = g = b = 0;
      } else if (y < HEIGHT / 4) {
        var c = colors[Math.floor(x * colors.length / WIDTH)];
        r = c[0]; g = c[1]; b = c[2];
      } else {
        r = Math.floor(255 * x / (WIDTH - 1));
        g = Math.floor(255 * y / (HEIGHT - 1));
        b = Math.floor(255 * (WIDTH - 1 - x) / (WIDTH - 1));
        if (Math.abs(x - WIDTH / 2) <= 3 || Math.abs(y - HEIGHT / 2) <= 3) {
          r = g = b = 255;
        }
      }
      var off = y * STRIDE + x * BYTES_PER_PIXEL;
      buf[off] = b;
      buf[off + 1] = g;
      buf[off + 2] = r;
      buf[off + 3] = 0;
    }
  }
  return buf;
}

function makeBlackFrame() {
  return Buffer.alloc(FRAME_SIZE);
}

function status() {
  return {
    ok: true,
    version: VERSION,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    node: process.version,
    pid: process.pid,
    framebuffer: framebufferInfo(),
    config: getConfig(),
    lastFrame: lastFrame,
    logoRawExists: fs.existsSync(LOGO_RAW),
    lastRawExists: fs.existsSync(LAST_RAW),
    browser: {
      installed: fs.existsSync(BROWSER_BIN),
      running: isBrowserRunning(),
      pid: browserState.pid,
      url: browserState.url,
      startedAt: browserState.startedAt,
      restarts: browserState.restarts,
      exitCode: browserState.exitCode
    }
  };
}

function handlePostJson(req, res, cb) {
  readBody(req, 65536, function (err, body) {
    if (err) return sendJson(res, 400, { ok: false, error: err.message });
    try {
      cb(JSON.parse(body.toString('utf8') || '{}'));
    } catch (parseErr) {
      sendJson(res, 400, { ok: false, error: 'bad_json' });
    }
  });
}

function route(req, res) {
  var parsed = url.parse(req.url, true);
  var p = parsed.pathname;

  if (req.method === 'OPTIONS') return send(res, 204, '', 'text/plain');

  if (p === '/' || p === '/api' || p === '/api/') {
    return sendJson(res, 200, {
      ok: true,
      name: 'c4hc800-kiosk-api',
      version: VERSION,
      endpoints: ['/api/status', '/api/config', '/api/url', '/api/browser', '/api/frame', '/api/test', '/api/black', '/api/restore-logo', '/api/capture.raw', '/api/browser/stop']
    });
  }

  if (p === '/api/status' && req.method === 'GET') return sendJson(res, 200, status());
  if (p === '/api/config' && req.method === 'GET') return sendJson(res, 200, { ok: true, config: getConfig() });
  if ((p === '/api/next' || p === '/api/command') && req.method === 'GET') return sendJson(res, 200, { ok: true, command: getConfig() });

  // Browser status — returns what URL is displayed and process info
  if (p === '/api/url' && req.method === 'GET') {
    var cfg = getConfig();
    return sendJson(res, 200, {
      ok: true,
      url: cfg.url,
      enabled: cfg.enabled,
      browser: {
        installed: fs.existsSync(BROWSER_BIN),
        running: isBrowserRunning(),
        pid: browserState.pid,
        startedAt: browserState.startedAt,
        exitCode: browserState.exitCode
      }
    });
  }

  if (p === '/api/browser' && req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      bin: BROWSER_BIN,
      installed: fs.existsSync(BROWSER_BIN),
      running: isBrowserRunning(),
      pid: browserState.pid,
      url: browserState.url,
      startedAt: browserState.startedAt,
      restarts: browserState.restarts,
      exitCode: browserState.exitCode,
      recentLog: browserState.stderr
    });
  }

  if (req.method === 'POST' && !requireToken(req, parsed)) {
    return sendJson(res, 403, { ok: false, error: 'bad_token' });
  }

  if (p === '/api/config' && req.method === 'POST') {
    return handlePostJson(req, res, function (obj) {
      var oldUrl = getConfig().url;
      var cfg = setConfig(obj);
      // Restart browser if the URL or enabled flag changed
      if (cfg.enabled && cfg.url && cfg.url !== oldUrl) {
        startBrowser(cfg.url, function (err) {
          if (err) log('browser restart failed: ' + err.message);
        });
      } else if (!cfg.enabled && isBrowserRunning()) {
        stopBrowser(null);
      }
      sendJson(res, 200, { ok: true, config: cfg });
    });
  }

  // POST /api/url — set the URL to display and launch the browser immediately
  if (p === '/api/url' && req.method === 'POST') {
    return handlePostJson(req, res, function (obj) {
      if (typeof obj.url !== 'string' || !obj.url.trim()) {
        return sendJson(res, 400, { ok: false, error: 'url field required (string)' });
      }
      var cfg = setConfig({ url: obj.url.trim(), enabled: true });
      startBrowser(cfg.url, function (err) {
        if (err) return sendJson(res, 503, { ok: false, error: err.message });
        sendJson(res, 200, {
          ok: true,
          url: cfg.url,
          pid: browserState.pid,
          message: 'browser launched — URL should appear on HDMI output'
        });
      });
    });
  }

  // POST /api/browser/stop — stop the browser, leave framebuffer as-is
  if (p === '/api/browser/stop' && req.method === 'POST') {
    stopBrowser(function () {
      sendJson(res, 200, { ok: true, message: 'browser stopped' });
    });
    return;
  }

  if (p === '/api/frame' && req.method === 'POST') {
    return readBody(req, MAX_BODY, function (err, body) {
      if (err) return sendJson(res, 400, { ok: false, error: err.message });
      // Stop browser before writing so it doesn't overwrite our frame
      stopBrowser(function () {
        try {
          writeFrameBuffer(body);
          sendJson(res, 200, { ok: true, bytes: body.length, at: lastFrame.at });
        } catch (writeErr) {
          sendJson(res, 400, { ok: false, error: writeErr.message });
        }
      });
    });
  }

  if (p === '/api/test' && req.method === 'POST') {
    stopBrowser(function () {
      try {
        writeFrameBuffer(makeTestPattern());
        sendJson(res, 200, { ok: true, bytes: FRAME_SIZE, at: lastFrame.at });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: err.message });
      }
    });
    return;
  }

  if (p === '/api/black' && req.method === 'POST') {
    stopBrowser(function () {
      try {
        writeFrameBuffer(makeBlackFrame());
        sendJson(res, 200, { ok: true, bytes: FRAME_SIZE, at: lastFrame.at });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: err.message });
      }
    });
    return;
  }

  if (p === '/api/restore-logo' && req.method === 'POST') {
    try {
      var logo = fs.readFileSync(LOGO_RAW);
      writeFrameBuffer(logo);
      lastFrame.source = 'restore-logo';
      return sendJson(res, 200, { ok: true, bytes: logo.length, at: lastFrame.at });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  if (p === '/api/capture.raw' && req.method === 'GET') {
    try {
      var cap = readFixed(FB, FRAME_SIZE);
      return send(res, 200, cap, 'application/octet-stream');
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  return notFound(res);
}

captureLogoIfNeeded();
var server = http.createServer(route);
server.listen(PORT, '0.0.0.0', function () {
  log('c4hc800-kiosk-api listening on 0.0.0.0:' + PORT);
  log('browser bin: ' + BROWSER_BIN + (fs.existsSync(BROWSER_BIN) ? ' (installed)' : ' (NOT INSTALLED — run install.sh)'));

  // Auto-launch browser on startup if a URL is configured
  var _cfg = getConfig();
  if (_cfg.enabled && _cfg.url && fs.existsSync(BROWSER_BIN)) {
    log('auto-launching browser: ' + _cfg.url);
    startBrowser(_cfg.url, function (err) {
      if (err) log('auto-launch failed: ' + err.message);
    });
  }
});

process.on('SIGTERM', function () {
  log('SIGTERM received — stopping browser and shutting down');
  stopBrowser(function () { process.exit(0); });
});

process.on('uncaughtException', function (err) {
  log('uncaughtException: ' + (err && err.stack ? err.stack : err));
});
