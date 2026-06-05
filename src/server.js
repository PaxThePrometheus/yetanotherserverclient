'use strict';

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { spawn } = require('child_process');
const log = require('./logger');

/*
 * server.js — owns the running Minecraft server process.
 *
 * It spawns `java … -jar <jar> nogui` in the server directory, streams its
 * console (stdout/stderr) into a ring buffer, parses meaningful lines (server
 * ready, player join/leave, chat, the `list` reply), and lets the panel send
 * console commands back over stdin. Nothing here draws — it just emits events
 * and exposes state for the TUI to render.
 *
 * Events: 'line' (console line), 'state' (status changed), 'players',
 *         'eula' (server needs EULA acceptance), 'exit'.
 */

const STATUS = {
  STOPPED: 'stopped',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopping',
  CRASHED: 'crashed',
};

// Minecraft section-sign formatting -> ANSI, so colored console lines (MOTD
// echoes, plugin output) keep their color in our renderer.
const MC_ANSI = {
  '0': '\x1b[30m', '1': '\x1b[34m', '2': '\x1b[32m', '3': '\x1b[36m',
  '4': '\x1b[31m', '5': '\x1b[35m', '6': '\x1b[33m', '7': '\x1b[37m',
  '8': '\x1b[90m', '9': '\x1b[94m', 'a': '\x1b[92m', 'b': '\x1b[96m',
  'c': '\x1b[91m', 'd': '\x1b[95m', 'e': '\x1b[93m', 'f': '\x1b[97m',
  'l': '\x1b[1m', 'o': '\x1b[3m', 'n': '\x1b[4m', 'm': '\x1b[9m', 'r': '\x1b[0m',
};
function mcToAnsi(s) {
  return String(s).replace(/§([0-9a-fk-or])/gi, (_, c) =>
    MC_ANSI[c.toLowerCase()] || '');
}

// Server consoles (esp. Paper via JLine) emit carriage returns, cursor-move
// escapes, tabs and the occasional bare ESC. Left in, those bytes corrupt the
// TUI when rendered. Keep only SGR color codes (\x1b[…m); strip the rest.
function sanitizeConsole(s) {
  return String(s)
    // OSC sequences: \x1b]…BEL or \x1b]…ST
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    // CSI sequences: keep SGR (ends in 'm'), drop all others (cursor moves, etc.)
    .replace(/\x1b\[[0-9;?<>=!]*([@-~])/g, (seq, fin) => (fin === 'm' ? seq : ''))
    // strip bare/leftover ESC, but never an ESC that begins a kept SGR code
    .replace(/\x1b(?!\[[0-9;?<>=!]*m)/g, '')
    // tabs → spaces, then drop remaining control characters (ESC 0x1b excepted)
    .replace(/\t/g, '  ')
    .replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/g, '');
}

class MinecraftServer extends EventEmitter {
  constructor(record) {
    super();
    this.record = record;             // { name, dir, jar, type, version, ram, java }
    this.dir = record.dir;
    this.child = null;
    this.status = STATUS.STOPPED;
    this.startedAt = 0;
    this.console = [];                // ring buffer of { text, level, t }
    this.maxConsole = 2000;
    this.players = new Map();         // name -> { joinedAt }
    this.maxPlayers = record.maxPlayers || null;
    this._partial = '';               // incomplete stdout line
    this._stopTimer = null;
    this._exitWanted = false;

    // Flavor traits (set by the launcher/index; sensible defaults for imports).
    this.category = record.category || 'servers';
    this.kind = record.kind || 'plugins';     // plugins | mods | none
    this.usesEula = record.eula !== false && record.category !== 'proxy';
    this.usesNogui = record.nogui !== false && record.category !== 'proxy';

    // Live telemetry, refreshed by an unobtrusive (suppressed) poller.
    this.metrics = { tps: null, tps5: null, tps15: null, mspt: null, worldMB: null, content: null };
    this.tpsSupported = this.category !== 'proxy' && this.type() !== 'vanilla';
    this._metricSentAt = 0;
    this._metricKind = null;
    this._mFlip = false;
    this._metricTimer = null;
    this._diskTimer = null;
  }

  type() { return this.record.type; }
  isPaperFamily() { return ['paper', 'folia', 'purpur'].includes(this.record.type); }

  // Work out how to launch this flavor: a runnable jar, a Forge/NeoForge
  // @args file produced by its installer, with or without `nogui`.
  resolveLaunch() {
    const ram = this.record.ram || 2048;
    const xmx = `-Xmx${ram}M`, xms = `-Xms${Math.max(512, Math.floor(ram / 2))}M`;
    const enc = '-Dfile.encoding=UTF-8';
    const nogui = this.usesNogui ? ['nogui'] : [];
    if (this.record.launch && this.record.launch.loaderName) {
      const af = this.findForgeArgfile();
      if (af) return { args: [xmx, xms, enc, '@' + af, ...nogui] };
      // else fall through and try a runnable jar (legacy Forge ships one)
    }
    const jar = this.record.jar;
    if (!jar || !fs.existsSync(path.join(this.dir, jar))) {
      return { error: `launch jar not found: ${jar || '(none)'} in ${this.dir}` };
    }
    return { args: [xms, xmx, enc, '-jar', jar, ...nogui] };
  }

  findForgeArgfile() {
    const L = this.record.launch || {};
    const plat = process.platform === 'win32' ? 'win_args.txt' : 'unix_args.txt';
    const candidates = [];
    if (L.loaderName === 'neoforge' && L.loader)
      candidates.push(path.join('libraries', 'net', 'neoforged', 'neoforge', L.loader, plat));
    if (L.loaderName === 'forge' && L.mc && L.loader)
      candidates.push(path.join('libraries', 'net', 'minecraftforge', 'forge', `${L.mc}-${L.loader}`, plat));
    for (const c of candidates) if (fs.existsSync(path.join(this.dir, c))) return c;
    try {
      const found = scanFor(path.join(this.dir, 'libraries'), plat, 6);
      if (found) return path.relative(this.dir, found);
    } catch {}
    return null;
  }

  // ---- lifecycle ---------------------------------------------------------

  start() {
    if (this.child) return;
    const launch = this.resolveLaunch();
    if (launch.error) { this.pushLine('! ' + launch.error, 'error'); return; }
    if (this.usesEula && !this.eulaAccepted()) {
      this.emit('eula');
      this.pushLine('! Mojang EULA not accepted — start blocked.', 'warn');
      return;
    }

    const args = launch.args;
    const bin = this.record.java || 'java';
    log.event('server start', { dir: this.dir, bin, args });
    this.setStatus(STATUS.STARTING);
    this.players.clear();
    this.emit('players');
    this._exitWanted = false;

    let child;
    try {
      child = spawn(bin, args, { cwd: this.dir, windowsHide: true });
    } catch (e) {
      this.pushLine('! failed to launch java: ' + (e.message || e), 'error');
      this.setStatus(STATUS.CRASHED);
      log.error('spawn failed', e);
      return;
    }
    this.child = child;
    this.startedAt = Date.now();
    this.pushLine(`· launching ${bin} ${args.join(' ')}`, 'sys');

    child.stdout.on('data', (d) => this.onData(d));
    child.stderr.on('data', (d) => this.onData(d));
    child.on('error', (e) => {
      this.pushLine('! process error: ' + (e.message || e), 'error');
      log.error('child error', e);
    });
    child.on('exit', (code, signal) => this.onExit(code, signal));
  }

  // Graceful stop: ask the server to shut down, then force-kill if it hangs.
  stop({ force = false } = {}) {
    if (!this.child) return;
    this._exitWanted = true;
    this.stopMetrics();
    if (force) {
      this.pushLine('· force killing server…', 'sys');
      try { this.child.kill('SIGKILL'); } catch {}
      return;
    }
    this.setStatus(STATUS.STOPPING);
    this.pushLine('· stopping server…', 'sys');
    // Game servers use `stop`; BungeeCord/Waterfall use `end`; Velocity has no
    // stdin stop, so we signal it.
    const cmd = this.category === 'proxy'
      ? (this.record.type === 'velocity' ? null : 'end')
      : 'stop';
    if (cmd) this.sendRaw(cmd); else { try { this.child.kill(); } catch {} }
    clearTimeout(this._stopTimer);
    this._stopTimer = setTimeout(() => {
      if (this.child) {
        this.pushLine('· server did not stop in 20s — killing.', 'warn');
        try { this.child.kill('SIGKILL'); } catch {}
      }
    }, 20000);
  }

  restart() {
    if (!this.child) { this.start(); return; }
    this._restartAfterExit = true;
    this.stop();
  }

  onExit(code, signal) {
    clearTimeout(this._stopTimer);
    this.stopMetrics();
    this.stopDiskSampling();
    this.metrics.tps = this.metrics.tps5 = this.metrics.tps15 = this.metrics.mspt = null;
    const wasRunning = this.status === STATUS.RUNNING || this.status === STATUS.STARTING;
    this.child = null;
    this.players.clear();
    this.emit('players');
    log.event('server exit', { code, signal });

    if (!this.eulaAccepted() && wasRunning && Date.now() - this.startedAt < 8000) {
      // Vanilla writes eula.txt=false and quits on first run.
      this.pushLine('· server stopped to wait for EULA acceptance.', 'sys');
      this.setStatus(STATUS.STOPPED);
      this.emit('eula');
    } else if (this._exitWanted || signal === 'SIGTERM' || code === 0) {
      this.pushLine(`· server stopped (code ${code ?? 'signal ' + signal}).`, 'sys');
      this.setStatus(STATUS.STOPPED);
    } else {
      this.pushLine(`! server crashed (code ${code}${signal ? ', ' + signal : ''}).`, 'error');
      this.setStatus(STATUS.CRASHED);
    }
    this.emit('exit', { code, signal });

    if (this._restartAfterExit) {
      this._restartAfterExit = false;
      setTimeout(() => this.start(), 1200);
    }
  }

  // ---- console I/O -------------------------------------------------------

  onData(buf) {
    this._partial += buf.toString('utf8');
    let nl;
    while ((nl = this._partial.indexOf('\n')) >= 0) {
      let line = this._partial.slice(0, nl);
      this._partial = this._partial.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.ingest(line);
    }
  }

  ingest(line) {
    if (this.consumeMetric(line)) return; // suppress our own /tps /mspt polls
    const level = classify(line);
    this.pushLine(sanitizeConsole(mcToAnsi(line)), level);
    this.parse(line);
  }

  pushLine(text, level = 'info') {
    const entry = { text, level, t: Date.now() };
    this.console.push(entry);
    if (this.console.length > this.maxConsole) this.console.shift();
    this.emit('line', entry);
  }

  // Send a command the way a console operator would (no leading slash).
  command(cmd) {
    const c = String(cmd).replace(/^\//, '').trim();
    if (!c) return;
    if (!this.child) { this.pushLine('! server not running.', 'warn'); return; }
    this.pushLine('> ' + c, 'cmd');
    this.sendRaw(c);
    // `list` is how we reconcile the roster; nudge it after mutating commands.
    if (/^(op|deop|kick|ban|pardon|whitelist)\b/i.test(c)) {
      setTimeout(() => this.sendRaw('list'), 400);
    }
  }

  sendRaw(cmd) {
    try { this.child.stdin.write(cmd + '\n'); }
    catch (e) { this.pushLine('! could not write to server: ' + e.message, 'error'); }
  }

  // ---- log parsing -------------------------------------------------------

  parse(line) {
    // Strip the "[HH:MM:SS] [Server thread/INFO]:" prefix to get the message.
    const msg = line.replace(/^\[[^\]]*\]\s*\[[^\]]*\]:?\s*/, '')
      .replace(/^\[[^\]]*\]:?\s*/, '');

    // Game servers print "Done (Xs)!"; BungeeCord/Waterfall print "Listening on".
    if (this.status === STATUS.STARTING &&
        (/\bDone\b\s*\([\d.]+s\)!/.test(line) || /Listening on /i.test(line))) {
      this.setStatus(STATUS.RUNNING);
      if (this.category !== 'proxy') this.sendRaw('list'); // seed the roster
      this.startMetrics();
      this.startDiskSampling();
      return;
    }
    let m;
    if ((m = msg.match(/^([A-Za-z0-9_]{1,16}) joined the game/))) {
      this.players.set(m[1], { joinedAt: Date.now() });
      this.emit('players');
      return;
    }
    if ((m = msg.match(/^([A-Za-z0-9_]{1,16}) left the game/))) {
      this.players.delete(m[1]);
      this.emit('players');
      return;
    }
    // `list` reply: "There are 2 of a max of 20 players online: Alex, Steve"
    if ((m = msg.match(/There are (\d+) of a max of (\d+) players online:?\s*(.*)$/))) {
      this.maxPlayers = parseInt(m[2], 10);
      const names = m[3].split(/,\s*/).map((s) => s.trim()).filter(Boolean);
      const next = new Map();
      for (const n of names) next.set(n, this.players.get(n) || { joinedAt: Date.now() });
      this.players = next;
      this.emit('players');
      return;
    }
  }

  // ---- telemetry ---------------------------------------------------------

  // Poll TPS (and MSPT on Paper-family) by quietly issuing the command and
  // swallowing its echo + reply, so the figures update without spamming console.
  startMetrics() {
    this.stopMetrics();
    if (!this.tpsSupported) return;
    this._metricTimer = setInterval(() => this.pollMetric(), 6000);
    setTimeout(() => this.pollMetric(), 1500);
  }
  stopMetrics() { if (this._metricTimer) { clearInterval(this._metricTimer); this._metricTimer = null; } }

  pollMetric() {
    if (this.status !== STATUS.RUNNING || !this.child) return;
    this._mFlip = !this._mFlip;
    const cmd = (this.isPaperFamily() && this._mFlip) ? 'mspt'
      : (this.record.type === 'forge' || this.record.type === 'neoforge') ? 'forge tps' : 'tps';
    this._metricKind = cmd.includes('mspt') ? 'mspt' : 'tps';
    this._metricSentAt = Date.now();
    this.sendRaw(cmd);
  }

  // Returns true if the line was a reply to our metric poll (and is suppressed).
  consumeMetric(line) {
    if (!this._metricSentAt || Date.now() - this._metricSentAt > 2500) return false;
    const t = decolor(line);
    let m;
    if ((m = t.match(/TPS from last[^:]*:\s*\*?\s*([\d.]+),\s*\*?\s*([\d.]+),\s*\*?\s*([\d.]+)/i))) {
      this.metrics.tps = +m[1]; this.metrics.tps5 = +m[2]; this.metrics.tps15 = +m[3];
      this.emit('metrics'); return true;
    }
    if ((m = t.match(/Mean TPS:\s*([\d.]+)/i))) { this.metrics.tps = +m[1]; this.emit('metrics'); return true; }
    if (/Mean tick time:\s*([\d.]+)/i.test(t)) {
      this.metrics.mspt = +RegExp.$1; this.emit('metrics'); return true;
    }
    if (/tick times|Server tick/i.test(t)) return true; // mspt header line
    if (this._metricKind === 'mspt' && (m = t.match(/([\d.]+)\s*\/\s*[\d.]+\s*\/\s*[\d.]+/))) {
      this.metrics.mspt = +m[1]; this.emit('metrics'); return true;
    }
    if (/Unknown(\s+or\s+incomplete)?\s+command/i.test(t)) {
      // This flavor has no such command — stop polling so we don't loop.
      this.tpsSupported = false; this.stopMetrics(); return true;
    }
    return false;
  }

  // World size on disk (best-effort, infrequent) + content (plugin/mod) count.
  startDiskSampling() {
    this.stopDiskSampling();
    const tick = () => { this.sampleDisk(); };
    this._diskTimer = setInterval(tick, 60000);
    setTimeout(tick, 2000);
  }
  stopDiskSampling() { if (this._diskTimer) { clearInterval(this._diskTimer); this._diskTimer = null; } }

  sampleDisk() {
    try {
      let bytes = 0;
      for (const name of fs.readdirSync(this.dir)) {
        const p = path.join(this.dir, name);
        let st; try { st = fs.statSync(p); } catch { continue; }
        if (st.isDirectory() && /^world|^DIM|world$/i.test(name) || (st.isDirectory() && fs.existsSync(path.join(p, 'level.dat')))) {
          bytes += dirSize(p, 25000);
        }
      }
      this.metrics.worldMB = bytes / 1048576;
    } catch {}
    try {
      const cdir = path.join(this.dir, this.kind === 'mods' ? 'mods' : 'plugins');
      this.metrics.content = fs.readdirSync(cdir).filter((f) => /\.jar$/i.test(f)).length;
    } catch { this.metrics.content = null; }
    this.emit('metrics');
  }

  // ---- helpers -----------------------------------------------------------

  setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.emit('state', s);
  }

  uptimeMs() {
    return this.status === STATUS.RUNNING || this.status === STATUS.STARTING
      ? Date.now() - this.startedAt : 0;
  }

  playerList() {
    return [...this.players.keys()].sort((a, b) => a.localeCompare(b));
  }

  eulaPath() { return path.join(this.dir, 'eula.txt'); }

  eulaAccepted() {
    try {
      return /eula\s*=\s*true/i.test(fs.readFileSync(this.eulaPath(), 'utf8'));
    } catch {
      return false;
    }
  }

  acceptEula() {
    try {
      fs.writeFileSync(this.eulaPath(),
        '#Accepted via yasc — https://aka.ms/MinecraftEULA\neula=true\n');
      this.pushLine('· EULA accepted.', 'sys');
      return true;
    } catch (e) {
      this.pushLine('! could not write eula.txt: ' + e.message, 'error');
      return false;
    }
  }
}

// Coarse log-level classification for console coloring.
function classify(line) {
  if (/\/(ERROR|FATAL)\]|\bERROR\b|Exception|caused by:/i.test(line)) return 'error';
  if (/\/WARN\]|\bWARN(ING)?\b/i.test(line)) return 'warn';
  return 'info';
}

// Strip ANSI + Minecraft section codes for plain-text matching.
function decolor(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '').replace(/[§&][0-9a-fk-or]/gi, '');
}

// Find a file by name under dir, up to `depth` levels deep (for Forge args).
function scanFor(dir, name, depth) {
  if (depth < 0) return null;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory()) { const r = scanFor(p, name, depth - 1); if (r) return r; }
  }
  return null;
}

// Recursive directory size in bytes, capped at `budget` entries so a giant
// world can't stall the sampler.
function dirSize(dir, budget) {
  let total = 0;
  const stack = [dir];
  let seen = 0;
  while (stack.length && seen < budget) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (seen++ >= budget) break;
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else { try { total += fs.statSync(p).size; } catch {} }
    }
  }
  return total;
}

module.exports = { MinecraftServer, STATUS, mcToAnsi, decolor };
