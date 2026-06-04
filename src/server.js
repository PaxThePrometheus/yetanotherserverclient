'use strict';

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { spawn } = require('child_process');
const { buildArgs } = require('./java');
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
  return String(s).replace(/[§§&]([0-9a-fk-or])/gi, (_, c) =>
    MC_ANSI[c.toLowerCase()] || '');
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
  }

  // ---- lifecycle ---------------------------------------------------------

  start() {
    if (this.child) return;
    const jarPath = path.join(this.dir, this.record.jar);
    if (!fs.existsSync(jarPath)) {
      this.pushLine(`! jar not found: ${this.record.jar}`, 'error');
      return;
    }
    if (!this.eulaAccepted()) {
      this.emit('eula');
      this.pushLine('! Mojang EULA not accepted — start blocked.', 'warn');
      return;
    }

    const args = buildArgs({ jar: this.record.jar, ramMB: this.record.ram });
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

  // Graceful stop: ask the server to `stop`, then force-kill if it hangs.
  stop({ force = false } = {}) {
    if (!this.child) return;
    this._exitWanted = true;
    if (force) {
      this.pushLine('· force killing server…', 'sys');
      try { this.child.kill('SIGKILL'); } catch {}
      return;
    }
    this.setStatus(STATUS.STOPPING);
    this.pushLine('· stopping server…', 'sys');
    this.sendRaw('stop');
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
    const level = classify(line);
    this.pushLine(mcToAnsi(line), level);
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

    if (this.status === STATUS.STARTING && /\bDone\b\s*\([\d.]+s\)!/.test(line)) {
      this.setStatus(STATUS.RUNNING);
      this.sendRaw('list'); // seed the roster
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

module.exports = { MinecraftServer, STATUS, mcToAnsi };
