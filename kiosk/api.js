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
var HDMI_I2CSET = process.env.C4KIOSK_I2CSET || '/usr/sbin/i2cset';
var HDMI_I2CGET = process.env.C4KIOSK_I2CGET || '/usr/sbin/i2cget';
var HDMI_I2C_BUS = process.env.C4KIOSK_HDMI_I2C_BUS || '6';
var HDMI_I2C_ADDR = process.env.C4KIOSK_HDMI_I2C_ADDR || '0x39';

var startedAt = Date.now();
var lastFrame = null;
var lastDisplayWake = null;

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

function commandPath(primary, fallback) {
  return fs.existsSync(primary) ? primary : fallback;
}

function runQuiet(bin, args) {
  try {
    childProcess.execFileSync(bin, args, { stdio: 'ignore', timeout: 2000 });
    return true;
  } catch (err) {
    return false;
  }
}

function readCommand(bin, args) {
  try {
    return childProcess.execFileSync(bin, args, { encoding: 'utf8', timeout: 2000 }).trim();
  } catch (err) {
    return '';
  }
}

function hexByte(value) {
  value = value & 255;
  return '0x' + (value < 16 ? '0' : '') + value.toString(16);
}

function i2cReadReg(reg) {
  return readCommand(commandPath(HDMI_I2CGET, 'i2cget'), ['-y', HDMI_I2C_BUS, HDMI_I2C_ADDR, reg]);
}

function i2cWriteReg(reg, value) {
  return runQuiet(commandPath(HDMI_I2CSET, 'i2cset'), ['-y', HDMI_I2C_BUS, HDMI_I2C_ADDR, reg, value]);
}

function ensureDisplayOutput(reason) {
  var result = {
    at: nowIso(),
    reason: reason || 'manual',
    mode: false,
    unblank: false,
    adv7511Power: false,
    adv7511Tmds: false,
    regs: {}
  };

  try {
    fs.writeFileSync('/sys/class/graphics/fb0/mode', 'U:' + WIDTH + 'x' + HEIGHT + 'p-0\n');
    result.mode = true;
  } catch (err) {
    result.modeError = err.message;
  }

  try {
    fs.writeFileSync('/sys/class/graphics/fb0/blank', '0\n');
    result.unblank = true;
  } catch (err) {
    result.unblankError = err.message;
  }

  // HC800 HDMI is driven by an ADV7511/ADV7513-compatible transmitter on I2C
  // bus 6 at 7-bit address 0x39. Register 0xd6 bit 4 enables TMDS output.
  // If this bit is clear, /dev/fb0 can contain correct pixels while HDMI says
  // "no signal". Preserve the other register bits and set only TMDS enable.
  var power = i2cReadReg('0x41');
  if (power) {
    result.regs.beforePower = power;
    var powerValue = parseInt(power, 16);
    if (!isNaN(powerValue)) {
      result.adv7511Power = i2cWriteReg('0x41', hexByte(powerValue & ~0x40));
    }
  }

  var power2 = i2cReadReg('0xd6');
  if (power2) {
    result.regs.beforePower2 = power2;
    var power2Value = parseInt(power2, 16);
    if (!isNaN(power2Value)) {
      result.adv7511Tmds = i2cWriteReg('0xd6', hexByte(power2Value | 0x10));
    }
  }

  result.regs.power = i2cReadReg('0x41');
  result.regs.status = i2cReadReg('0x42');
  result.regs.pll = i2cReadReg('0x9e');
  result.regs.ddc = i2cReadReg('0xc8');
  result.regs.power2 = i2cReadReg('0xd6');

  lastDisplayWake = result;
  log('display wake: ' + JSON.stringify(result));
  return result;
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

function send(res, status, body, contentType, extraHeaders) {
  var headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-C4Kiosk-Token',
    'Cache-Control': 'no-store'
  };
  if (contentType) headers['Content-Type'] = contentType;
  if (extraHeaders) {
    Object.keys(extraHeaders).forEach(function (k) { headers[k] = extraHeaders[k]; });
  }
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj, null, 2) + '\n', 'application/json');
}

function notFound(res) {
  sendJson(res, 404, { ok: false, error: 'not_found' });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (ch) {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[ch];
  });
}

function decodeFormPart(s) {
  try {
    return decodeURIComponent(String(s || '').replace(/\+/g, ' '));
  } catch (err) {
    return String(s || '');
  }
}

function parseUrlEncoded(text) {
  var out = {};
  String(text || '').split('&').forEach(function (part) {
    if (!part) return;
    var idx = part.indexOf('=');
    var key = idx >= 0 ? part.slice(0, idx) : part;
    var val = idx >= 0 ? part.slice(idx + 1) : '';
    out[decodeFormPart(key)] = decodeFormPart(val);
  });
  return out;
}

function isFormRequest(req) {
  var ct = String(req.headers['content-type'] || '').toLowerCase();
  return ct.indexOf('application/x-www-form-urlencoded') >= 0 || ct.indexOf('multipart/form-data') >= 0;
}

function controlPanelUrl(req) {
  var referer = String(req.headers.referer || '');
  if (/^https?:\/\//i.test(referer)) return referer;
  var host = String(req.headers.host || '').split(':')[0] || '192.168.1.147';
  return 'http://' + host + '/c4kiosk/';
}

function sendHtmlAction(res, status, title, message, backUrl, details) {
  var body = '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta http-equiv="refresh" content="2;url=' + escapeHtml(backUrl) + '">' +
    '<title>' + escapeHtml(title) + '</title>' +
    '<style>body{margin:0;background:#111827;color:#e5e7eb;font-family:Arial,sans-serif}' +
    'main{max-width:760px;margin:0 auto;padding:32px 20px}pre{white-space:pre-wrap;background:#020617;padding:12px}' +
    'a{color:#93c5fd}</style></head><body><main>' +
    '<h1>' + escapeHtml(title) + '</h1><p>' + escapeHtml(message) + '</p>' +
    '<p><a href="' + escapeHtml(backUrl) + '">Back to kiosk control</a></p>' +
    '<pre>' + escapeHtml(JSON.stringify(details || {}, null, 2)) + '</pre>' +
    '</main></body></html>';
  send(res, status, body, 'text/html; charset=utf-8');
}

function sendActionResult(req, res, status, obj, title, message) {
  if (isFormRequest(req)) {
    return sendHtmlAction(res, status, title || (obj.ok ? 'Command complete' : 'Command failed'), message || obj.message || obj.error || '', controlPanelUrl(req), obj);
  }
  return sendJson(res, status, obj);
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
    ensureDisplayOutput('browser-start');
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
  ensureDisplayOutput('frame-write');
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
    displayWake: lastDisplayWake,
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

function handlePostObject(req, res, cb) {
  readBody(req, 65536, function (err, body) {
    var text;
    if (err) return sendActionResult(req, res, 400, { ok: false, error: err.message }, 'Bad request', err.message);
    text = body.toString('utf8') || '';
    if (isFormRequest(req)) return cb(parseUrlEncoded(text));
    try {
      cb(JSON.parse(text || '{}'));
    } catch (parseErr) {
      sendActionResult(req, res, 400, { ok: false, error: 'bad_json' }, 'Bad request', 'bad_json');
    }
  });
}

function route(req, res) {
  var parsed = url.parse(req.url, true);
  var p = parsed.pathname;

  if (req.method === 'OPTIONS') return send(res, 204, '', 'text/plain');

  // Serve the control panel UI directly from port 8099
  if (req.method === 'GET' && (p === '/' || p === '/kiosk' || p === '/index.html')) {
    try {
      var html = fs.readFileSync(path.join(ROOT, 'index.html'));
      return send(res, 200, html, 'text/html; charset=utf-8');
    } catch (readErr) {
      return sendJson(res, 500, { ok: false, error: 'index.html not found: ' + readErr.message });
    }
  }

  if (p === '/api' || p === '/api/') {
    return sendJson(res, 200, {
      ok: true,
      name: 'c4hc800-kiosk-api',
      version: VERSION,
      endpoints: ['/api/status', '/api/config', '/api/url', '/api/browser', '/api/display/wake', '/api/frame', '/api/test', '/api/black', '/api/restore-logo', '/api/framebuffer', '/api/capture.raw', '/api/browser/stop']
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
    return sendActionResult(req, res, 403, { ok: false, error: 'bad_token' }, 'Forbidden', 'The request token was missing or incorrect.');
  }

  if (p === '/api/display/wake' && req.method === 'POST') {
    return sendActionResult(req, res, 200, { ok: true, displayWake: ensureDisplayOutput('api-display-wake') }, 'HDMI wake command sent', 'The framebuffer mode, blanking state, and HDMI transmitter were reasserted.');
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
    return handlePostObject(req, res, function (obj) {
      if (typeof obj.url !== 'string' || !obj.url.trim()) {
        return sendActionResult(req, res, 400, { ok: false, error: 'url field required (string)' }, 'Missing URL', 'Enter a URL before pressing Display.');
      }
      var cfg = setConfig({ url: obj.url.trim(), enabled: true });
      startBrowser(cfg.url, function (err) {
        if (err) return sendActionResult(req, res, 503, { ok: false, error: err.message }, 'Browser launch failed', err.message);
        sendActionResult(req, res, 200, {
          ok: true,
          url: cfg.url,
          pid: browserState.pid,
          message: 'browser launched — URL should appear on HDMI output'
        }, 'Browser launched', 'The URL should appear on HDMI output in a few seconds.');
      });
    });
  }

  // POST /api/browser/stop — stop the browser, leave framebuffer as-is
  if (p === '/api/browser/stop' && req.method === 'POST') {
    stopBrowser(function () {
      sendActionResult(req, res, 200, { ok: true, message: 'browser stopped' }, 'Browser stopped', 'NetSurf-FB was stopped.');
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
        sendActionResult(req, res, 200, { ok: true, bytes: FRAME_SIZE, at: lastFrame.at }, 'Test pattern written', 'A test pattern was written directly to the framebuffer.');
      } catch (err) {
        sendActionResult(req, res, 500, { ok: false, error: err.message }, 'Test pattern failed', err.message);
      }
    });
    return;
  }

  if (p === '/api/black' && req.method === 'POST') {
    stopBrowser(function () {
      try {
        writeFrameBuffer(makeBlackFrame());
        sendActionResult(req, res, 200, { ok: true, bytes: FRAME_SIZE, at: lastFrame.at }, 'Screen blanked', 'A black frame was written directly to the framebuffer.');
      } catch (err) {
        sendActionResult(req, res, 500, { ok: false, error: err.message }, 'Blank failed', err.message);
      }
    });
    return;
  }

  if (p === '/api/restore-logo' && req.method === 'POST') {
    try {
      var logo = fs.readFileSync(LOGO_RAW);
      writeFrameBuffer(logo);
      lastFrame.source = 'restore-logo';
      return sendActionResult(req, res, 200, { ok: true, bytes: logo.length, at: lastFrame.at }, 'Logo restored', 'The saved startup framebuffer was restored.');
    } catch (err) {
      return sendActionResult(req, res, 500, { ok: false, error: err.message }, 'Restore failed', err.message);
    }
  }

  // GET /api/framebuffer — current framebuffer as raw BGRX bytes.
  // Response headers describe geometry so clients need no out-of-band config.
  if (p === '/api/framebuffer' && req.method === 'GET') {
    try {
      var fbBuf = readFixed(FB, FRAME_SIZE);
      return send(res, 200, fbBuf, 'application/octet-stream', {
        'X-FB-Width':  String(WIDTH),
        'X-FB-Height': String(HEIGHT),
        'X-FB-Stride': String(STRIDE),
        'X-FB-Format': 'bgrx',
        'X-FB-Bytes':  String(FRAME_SIZE)
      });
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

  ensureDisplayOutput('startup');

  // Re-assert HDMI after short delays to win the race against Control4 director
  // which may reset the ADV7511 transmitter during its own startup sequence.
  setTimeout(function () { ensureDisplayOutput('startup-retry-5s'); }, 5000);
  setTimeout(function () { ensureDisplayOutput('startup-retry-30s'); }, 30000);

  // Periodic re-assertion while browser is running to keep signal alive.
  setInterval(function () {
    if (isBrowserRunning()) ensureDisplayOutput('periodic');
  }, 120000);

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
