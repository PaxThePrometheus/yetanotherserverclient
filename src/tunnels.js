'use strict';

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { spawn } = require('child_process');
const log = require('./logger');

/*
 * tunnels.js — expose a server through a tunneling service without touching the
 * router. Each provider is just a small declaration (which binary to run, what
 * args, and regexes to pull the public address / login URL / errors out of its
 * output), so adding "a bunch of others" is a few lines.
 *
 * yasc runs the provider's own agent as a child process and surfaces what it
 * prints; it does not reimplement anyone's protocol. If the agent isn't
 * installed we show how to get it instead of failing silently.
 */

const TUNNELS = [
  {
    id: 'playit',
    name: 'playit.gg',
    bins: ['playit', 'playit.exe', 'playit-agent', 'playit-cli'],
    account: 'free account (link in browser)',
    install: {
      url: 'https://playit.gg/download',
      steps: [
        'Download & run the playit agent (link above).',
        'It prints a claim URL — open it to link your account.',
        'On playit.gg, add a Minecraft tunnel pointing at this server port.',
      ],
    },
    args: () => [],
    matchers: [
      { kind: 'auth', re: /(https?:\/\/playit\.gg\/[^\s'"]+)/i },
      { kind: 'address', re: /\b([a-z0-9.-]+\.(?:craft\.ply\.gg|ply\.gg|playit\.gg)(?::\d+)?)\b/i },
    ],
  },
  {
    id: 'ngrok',
    name: 'ngrok',
    bins: ['ngrok', 'ngrok.exe'],
    account: 'free account + authtoken',
    install: {
      url: 'https://ngrok.com/download',
      steps: [
        'Install ngrok and create a free account.',
        'Run once: ngrok config add-authtoken <your token>.',
        'yasc runs: ngrok tcp <port> and reads back the public address.',
      ],
    },
    args: (port) => ['tcp', String(port), '--log', 'stdout', '--log-format', 'logfmt'],
    matchers: [
      { kind: 'address', re: /url=tcp:\/\/([^\s"]+)/i },
      { kind: 'error', re: /(ERR_NGROK_\d+|err_ngrok|authtoken|command failed)/i },
    ],
  },
  {
    id: 'bore',
    name: 'bore.pub',
    bins: ['bore', 'bore.exe'],
    account: 'no account needed',
    install: {
      url: 'https://github.com/ekzhang/bore',
      steps: [
        'Install bore (e.g. cargo install bore-cli) — no signup.',
        'yasc runs: bore local <port> --to bore.pub.',
        'Share the bore.pub:<port> address it prints.',
      ],
    },
    args: (port) => ['local', String(port), '--to', 'bore.pub'],
    matchers: [
      { kind: 'address', re: /listening at\s+(bore\.pub:\d+)/i },
      { kind: 'address', re: /remote_port[=:]\s*(\d+)/i, map: (m) => 'bore.pub:' + m },
      { kind: 'error', re: /error|failed to connect/i },
    ],
  },
];

// Look for an executable by name across PATH (and the right extensions on Win).
function findBinary(names) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const n of names) {
    for (const d of dirs) {
      for (const e of exts) {
        const file = n.includes('.') ? n : n + e;
        const p = path.join(d, file);
        try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch {}
      }
    }
  }
  return null;
}

function detect() {
  const out = {};
  for (const t of TUNNELS) out[t.id] = findBinary(t.bins);
  return out;
}

class TunnelManager extends EventEmitter {
  constructor() { super(); this.reset(); }

  reset() {
    this.status = 'off';      // off | starting | online | stopping | error
    this.providerId = null;
    this.provider = null;
    this.address = null;      // public host:port to give players
    this.authUrl = null;      // claim / login URL if the agent needs one
    this.error = null;
    this.lines = [];
    this.child = null;
    this._partial = '';
  }

  isActive() { return this.status === 'starting' || this.status === 'online'; }

  start(providerId, { port, bin } = {}) {
    if (this.child) this.stop();
    const provider = TUNNELS.find((t) => t.id === providerId);
    if (!provider) { this.status = 'error'; this.error = 'unknown tunnel'; return this.emit('update'); }

    const exe = bin || findBinary(provider.bins);
    this.reset();
    this.providerId = providerId;
    this.provider = provider;

    if (!exe) {
      this.status = 'error';
      this.error = 'not installed';
      return this.emit('update');
    }

    this.status = 'starting';
    this.push(`· starting ${provider.name}…`);
    log.event('tunnel start', { provider: providerId, exe, port });

    let child;
    try { child = spawn(exe, provider.args(port), { windowsHide: true }); }
    catch (e) { this.status = 'error'; this.error = e.message; return this.emit('update'); }

    this.child = child;
    const onData = (d) => this.onData(d);
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => {
      this.push('! ' + (e.code === 'ENOENT' ? 'agent not found' : e.message));
      this.status = 'error'; this.error = e.message; this.emit('update');
    });
    child.on('exit', (code) => {
      this.child = null;
      if (this.status === 'stopping') { this.status = 'off'; }
      else {
        this.push(`· ${provider.name} exited (code ${code}).`);
        this.status = this.address ? 'off' : 'error';
        if (!this.address && !this.error) this.error = 'exited before connecting';
      }
      this.emit('update');
    });
    this.emit('update');
  }

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
    if (line.trim()) this.push(line);
    for (const m of this.provider.matchers) {
      const mm = line.match(m.re);
      if (!mm) continue;
      const val = m.map ? m.map(mm[1]) : mm[1];
      if (m.kind === 'address') { this.address = String(val).replace(/^tcp:\/\//, ''); this.status = 'online'; this.error = null; }
      else if (m.kind === 'auth') { this.authUrl = val; }
      else if (m.kind === 'error' && !this.address) { this.error = val; }
    }
    this.emit('update');
  }

  push(text) {
    this.lines.push(text);
    if (this.lines.length > 200) this.lines.shift();
  }

  stop() {
    if (!this.child) { if (this.isActive()) this.status = 'off'; return this.emit('update'); }
    this.status = 'stopping';
    this.push('· stopping tunnel…');
    try { this.child.kill(); } catch {}
    const c = this.child;
    setTimeout(() => { try { if (c && !c.killed) c.kill('SIGKILL'); } catch {} }, 4000);
    this.emit('update');
  }
}

module.exports = { TUNNELS, detect, findBinary, TunnelManager };
