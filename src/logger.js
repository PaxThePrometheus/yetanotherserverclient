'use strict';

const fs = require('fs');
const path = require('path');

/*
 * logger.js — a tiny crash-safe file logger.
 *
 * Everything is appended synchronously so nothing is lost on a hard crash.
 * Volume is low (lifecycle events + errors, not per-frame), so the cost is
 * negligible. The log lives at  <project>/logs/yasc.log  — hand that file over
 * for bug reports. This is the *panel's* own log, separate from the Minecraft
 * server's logs/latest.log which the server itself writes.
 */

let filePath = null;

function init() {
  const dir = path.join(__dirname, '..', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  filePath = path.join(dir, 'yasc.log');
  // Keep the previous session for comparison, start this one fresh.
  try {
    if (fs.existsSync(filePath)) fs.renameSync(filePath, path.join(dir, 'yasc.prev.log'));
  } catch { /* non-fatal */ }
  fs.writeFileSync(filePath, '');
  return filePath;
}

function ts() {
  return new Date().toISOString();
}

function fmt(data) {
  if (data === undefined) return '';
  if (data instanceof Error) return ' ' + (data.stack || data.message);
  if (typeof data === 'string') return ' ' + data;
  try { return ' ' + JSON.stringify(data); } catch { return ' ' + String(data); }
}

function write(level, msg, data) {
  if (!filePath) return;
  const line = `${ts()} [${level}] ${msg}${fmt(data)}\n`;
  try { fs.appendFileSync(filePath, line); } catch { /* ignore */ }
}

// Append already-formatted text verbatim (used to tee captured stderr).
function raw(text) {
  if (!filePath || !text) return;
  try { fs.appendFileSync(filePath, text); } catch { /* ignore */ }
}

// Redirect console.* and process.stderr into the log so stray output doesn't
// smear across the TUI. Returns a restore() that puts the originals back.
function captureConsole() {
  const origErrWrite = process.stderr.write.bind(process.stderr);
  const origConsole = {
    log: console.log, info: console.info, warn: console.warn,
    error: console.error, debug: console.debug, trace: console.trace,
  };

  const join = (args) => args.map((a) =>
    a instanceof Error ? (a.stack || a.message)
      : typeof a === 'string' ? a
        : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()
  ).join(' ');

  console.log = (...a) => write('LOG', join(a));
  console.info = (...a) => write('INFO', join(a));
  console.debug = (...a) => write('DEBUG', join(a));
  console.warn = (...a) => write('WARN', join(a));
  console.error = (...a) => write('ERROR', join(a));
  console.trace = (...a) => write('TRACE', join(a));

  process.stderr.write = (chunk, enc, cb) => {
    raw(typeof chunk === 'string' ? chunk : chunk.toString());
    if (typeof enc === 'function') enc();
    else if (typeof cb === 'function') cb();
    return true;
  };

  // Node deprecation / process warnings come through here.
  const onWarning = (w) => write('WARN', `process warning: ${w.name}: ${w.message}`, w.stack);
  process.on('warning', onWarning);

  return function restore() {
    Object.assign(console, origConsole);
    process.stderr.write = origErrWrite;
    process.removeListener('warning', onWarning);
  };
}

module.exports = {
  init,
  captureConsole,
  getPath: () => filePath,
  info: (m, d) => write('INFO', m, d),
  warn: (m, d) => write('WARN', m, d),
  error: (m, d) => write('ERROR', m, d),
  event: (m, d) => write('EVENT', m, d),
  debug: (m, d) => write('DEBUG', m, d),
};
