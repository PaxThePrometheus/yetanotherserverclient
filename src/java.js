'use strict';

const { execFile } = require('child_process');

/*
 * java.js — locate a Java runtime and build the launch command.
 *
 * We don't bundle a JRE; we just shell out to whatever `java` is on PATH (or a
 * path the user pinned in the server record). `detectJava` is best-effort and
 * never throws — the panel still opens if Java is missing, it just warns.
 */

function detectJava(bin = 'java') {
  return new Promise((resolve) => {
    execFile(bin, ['-version'], { timeout: 8000 }, (err, _stdout, stderr) => {
      // `java -version` prints to stderr by convention.
      const text = String(stderr || _stdout || '');
      if (err && !text) {
        resolve({ ok: false, bin, version: null, raw: err.message });
        return;
      }
      const m = text.match(/version "([^"]+)"/);
      const major = parseMajor(m && m[1]);
      resolve({ ok: true, bin, version: m ? m[1] : 'unknown', major, raw: text.trim() });
    });
  });
}

// "1.8.0_392" -> 8 ; "17.0.2" -> 17 ; "25" -> 25
function parseMajor(v) {
  if (!v) return null;
  const parts = String(v).split('.');
  if (parts[0] === '1' && parts[1]) return parseInt(parts[1], 10);
  return parseInt(parts[0], 10) || null;
}

// Standard, conservative flags for a headless MC server. Aikar's flags are
// great but version-sensitive; we keep it simple and reliable here.
function buildArgs({ jar, ramMB, extraFlags = [] }) {
  const args = [];
  if (ramMB) {
    args.push(`-Xms${Math.max(512, Math.floor(ramMB / 2))}M`);
    args.push(`-Xmx${ramMB}M`);
  }
  args.push('-Dfile.encoding=UTF-8');
  args.push(...extraFlags);
  args.push('-jar', jar, 'nogui');
  return args;
}

// Parse a memory string like "2G", "2048M", "1024" -> megabytes.
function parseRam(str, fallback = 2048) {
  if (!str) return fallback;
  const m = String(str).trim().match(/^(\d+(?:\.\d+)?)\s*([gmGM])?$/);
  if (!m) return fallback;
  const n = parseFloat(m[1]);
  const unit = (m[2] || 'M').toUpperCase();
  return Math.round(unit === 'G' ? n * 1024 : n);
}

function fmtRam(mb) {
  return mb >= 1024 && mb % 1024 === 0 ? mb / 1024 + 'G' : mb + 'M';
}

module.exports = { detectJava, buildArgs, parseRam, fmtRam, parseMajor };
