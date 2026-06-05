'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { C } = require('./terminal');
const { STATUS } = require('./server');
const props = require('./properties');
const stats = require('./stats');
const { fmtRam, parseRam } = require('./java');
const { forgetServer, rememberServer } = require('./config');
const { download } = require('./providers');
const { librariesFor } = require('./libraries');
const network = require('./network');
const upnp = require('./upnp');
const tunnels = require('./tunnels');
const log = require('./logger');

/*
 * app.js — the server control panel.
 *
 * A header + tab bar + a body that swaps between views (Console, Players,
 * Properties, Files, Plugins, Server), with a live Status sidebar pinned on the
 * right. The bottom bar is a console command line in the Console view and a
 * contextual editor/hint elsewhere. All drawing goes through the diff renderer,
 * so an idle panel barely touches the CPU.
 */

const VIEWS = ['console', 'players', 'properties', 'files', 'plugins', 'network', 'server'];
const VIEW_LABEL = {
  console: 'Console', players: 'Players', properties: 'Properties',
  files: 'Files', plugins: 'Plugins', network: 'Network', server: 'Server',
};

class App {
  constructor(screen, input, server, ctx = {}) {
    this.screen = screen;
    this.input = input;
    this.server = server;
    this.record = server.record;
    this.ctx = ctx;                  // { java }

    this.view = 'console';
    this.overlay = null;             // { type, ... }
    this._spinIdx = 0;
    this._quitting = false;

    // console
    this.cScroll = 0;                // lines from bottom
    this.cmd = '';
    this.history = [];
    this.histIdx = -1;

    // players
    this.pSel = 0;

    // properties
    this.prop = null;                // { file, model, sel, scroll, editing }

    // files
    this.files = { cwd: server.dir, entries: [], sel: 0, scroll: 0, viewer: null };

    // plugins
    this.plug = { dir: null, kind: '', entries: [], sel: 0 };

    // server view
    this.srvSel = 0;

    // network view + tunnel manager
    this.net = {
      sel: 0,
      localIPs: network.localAddresses(),
      publicIP: null, publicIPState: 'idle', publicIPMsg: '',
      detected: tunnels.detect(),
      reach: { state: 'idle', detail: '' },
      upnp: { state: 'idle', msg: '', externalIP: null },
      msg: '',
    };
    this.tunnel = new tunnels.TunnelManager();

    // perf
    this.perf = { rssMB: 0, cpu: 0, memUsed: 0, memTotal: 0, load: 0 };

    this._onResize = () => { this.screen.resize(); this.draw(); };
  }

  // ---- lifecycle ---------------------------------------------------------

  // Resolves with { next: 'quit' } or { next: 'back' } so the caller can either
  // exit the process or return to the launcher without tearing the screen down.
  start() {
    return new Promise((resolve) => {
      this._resolve = resolve;

      this._keyHandler = (k) => this.onKey(k);
      this._mouseHandler = (m) => this.onMouse(m);
      this._redraw = () => this.draw();
      this._onLine = () => this.onConsoleLine();
      this._onExit = () => this.onServerExit();
      this._onEula = () => { if (!this._leaving) { this.overlay = { type: 'eula' }; this.draw(); } };

      this.input.on('key', this._keyHandler);
      this.input.on('mouse', this._mouseHandler);
      try { this.screen.enableMouse(); } catch {}
      process.stdout.on('resize', this._onResize);
      this.server.on('line', this._onLine);
      this.server.on('state', this._redraw);
      this.server.on('players', this._redraw);
      this.server.on('metrics', this._redraw);
      this.server.on('exit', this._onExit);
      this.server.on('eula', this._onEula);
      this.tunnel.on('update', this._redraw);

      this.refreshFiles();
      this.refreshPlugins();

      this._timer = setInterval(() => this.draw(), 250);
      this._perfTimer = setInterval(() => this.samplePerf(), 1000);
      this.samplePerf();

      // Auto-start the server unless the user asked otherwise.
      if (this.ctx.autostart !== false) {
        if (!this.server.eulaAccepted()) this.overlay = { type: 'eula' };
        else this.server.start();
      }
      this.draw();
    });
  }

  // Server process ended on its own (stop command, crash, Stop action). Offer a
  // choice rather than silently sitting on a dead console.
  onServerExit() {
    this.draw();
    if (this._leaving) return;                 // we're already quitting / going back
    if (this.server._restartAfterExit) return; // a restart is in flight
    const crashed = this.server.status === STATUS.CRASHED;
    this.overlay = { type: 'stopped', crashed };
    this.draw();
  }

  // Remove every listener/timer this app installed so the shared screen + input
  // can be handed back to the launcher (or the next App) cleanly.
  detach() {
    clearInterval(this._timer);
    clearInterval(this._perfTimer);
    try { this.input.removeListener('key', this._keyHandler); } catch {}
    try { this.input.removeListener('mouse', this._mouseHandler); } catch {}
    try { this.screen.disableMouse(); } catch {}
    try { process.stdout.removeListener('resize', this._onResize); } catch {}
    try { this.server.removeListener('line', this._onLine); } catch {}
    for (const ev of ['state', 'players', 'metrics']) {
      try { this.server.removeListener(ev, this._redraw); } catch {}
    }
    try { this.server.removeListener('exit', this._onExit); } catch {}
    try { this.server.removeListener('eula', this._onEula); } catch {}
    try { this.tunnel.removeListener('update', this._redraw); } catch {}
    try { this.tunnel.stop(); } catch {}
  }

  // Keep the scroll position stable when new console lines arrive while the
  // user has scrolled up; otherwise stay pinned to the bottom.
  onConsoleLine() {
    if (this.view === 'console' && this.cScroll > 0) this.cScroll += 1;
    this.draw();
  }

  onMouse(m) {
    if (m.name !== 'click' || this.overlay) return;
    // Click a tab in the tab bar (row 3) to switch views.
    if (m.y === 3) {
      let cx = 1;
      for (const v of VIEWS) {
        const label = ` ${VIEWS.indexOf(v) + 1}·${VIEW_LABEL[v]} `;
        if (m.x >= cx && m.x < cx + label.length) { this.gotoView(v); return; }
        cx += label.length + 1;
      }
    }
  }

  samplePerf() {
    const mem = os.totalmem();
    this.perf.memTotal = mem / 1048576;
    this.perf.memUsed = (mem - os.freemem()) / 1048576;
    this.perf.load = os.loadavg()[0];
    const pid = this.server.child && this.server.child.pid;
    if (pid) {
      stats.sample(pid).then((s) => { this.perf.rssMB = s.rssMB; this.perf.cpu = s.cpu; })
        .catch(() => {});
    } else {
      this.perf.rssMB = 0; this.perf.cpu = 0;
    }
  }

  // ---- input -------------------------------------------------------------

  onKey(k) {
    if (this.overlay) return this.onOverlayKey(k);
    if (k.name === 'wheelup' || k.name === 'wheeldown') return this.onWheel(k);

    if (k.name === 'C-c') return this.requestQuit();
    if (k.name === 'C-l') { this.screen.resize(); return this.draw(); }
    if (k.name === 'tab') return this.cycleView(1);
    if (k.name === 'shift-tab') return this.cycleView(-1);
    if (/^f[1-7]$/.test(k.name || '')) return this.gotoView(VIEWS[parseInt(k.name[1], 10) - 1]);
    if (k.name === 'C-r') return this.toggleRun();

    this.dispatchViewKey(k);
  }

  dispatchViewKey(k) {
    switch (this.view) {
      case 'console': return this.onConsoleKey(k);
      case 'players': return this.onPlayersKey(k);
      case 'properties': return this.onPropsKey(k);
      case 'files': return this.onFilesKey(k);
      case 'plugins': return this.onPluginsKey(k);
      case 'network': return this.onNetworkKey(k);
      case 'server': return this.onServerKey(k);
    }
  }

  // Mouse wheel: scroll the console; elsewhere nudge the list selection.
  onWheel(k) {
    const up = k.name === 'wheelup';
    if (this.view === 'console') {
      this.cScroll = Math.max(0, this.cScroll + (up ? 3 : -3));
      return this.draw();
    }
    const dir = up ? 'up' : 'down';
    for (let i = 0; i < 3; i++) this.dispatchViewKey({ name: dir });
  }

  cycleView(dir) {
    const i = VIEWS.indexOf(this.view);
    this.gotoView(VIEWS[(i + dir + VIEWS.length) % VIEWS.length]);
  }
  gotoView(v) {
    if (!v) return;
    this.view = v;
    if (v === 'properties') this.loadProps();
    if (v === 'files') this.refreshFiles();
    if (v === 'plugins') this.refreshPlugins();
    if (v === 'network') this.initNetwork();
    this.draw();
  }

  toggleRun() {
    const s = this.server.status;
    if (s === STATUS.RUNNING || s === STATUS.STARTING) this.server.restart();
    else this.server.start();
    this.draw();
  }

  // ---- console -----------------------------------------------------------

  onConsoleKey(k) {
    if (k.name === 'pageup') { this.cScroll += 5; return this.draw(); }
    if (k.name === 'pagedown') { this.cScroll = Math.max(0, this.cScroll - 5); return this.draw(); }
    if (k.name === 'up') return this.recallHistory(1);
    if (k.name === 'down') return this.recallHistory(-1);
    if (k.name === 'enter') return this.sendCommand();
    if (k.name === 'escape') { this.cmd = ''; this.cScroll = 0; this.histIdx = -1; return this.draw(); }
    if (k.name === 'backspace') { this.cmd = this.cmd.slice(0, -1); return this.draw(); }
    if (k.name === 'C-u') { this.cmd = ''; return this.draw(); }
    if (k.name === 'C-w') { this.cmd = this.cmd.replace(/\s*\S+\s*$/, ''); return this.draw(); }
    if (k.name === 'char') { this.cmd += k.ch; return this.draw(); }
  }

  recallHistory(dir) {
    if (!this.history.length) return;
    this.histIdx = Math.min(this.history.length - 1, Math.max(-1, this.histIdx + dir));
    this.cmd = this.histIdx < 0 ? '' : this.history[this.history.length - 1 - this.histIdx];
    this.draw();
  }

  sendCommand() {
    const line = this.cmd.trim();
    this.cmd = '';
    this.histIdx = -1;
    this.cScroll = 0;
    if (!line) return this.draw();
    this.history.push(line);
    if (this.history.length > 200) this.history.shift();
    if (line === '.quit' || line === '.exit') return this.requestQuit();
    // Lines starting with '.' are yasc client commands, not server commands.
    if (line[0] === '.') return this.clientCommand(line.slice(1));
    this.server.command(line);
    this.draw();
  }

  // Panel-side commands (don't go to the server). Mainly: change RAM allocation.
  clientCommand(cmd) {
    const parts = cmd.split(/\s+/);
    const name = (parts[0] || '').toLowerCase();
    const arg = parts.slice(1).join(' ').trim();
    const say = (t, lvl = 'sys') => this.server.pushLine('· ' + t, lvl);
    switch (name) {
      case 'ram': case 'mem': case 'memory': {
        if (!arg) { say(`allocated RAM is ${fmtRam(this.record.ram || 0)}. Change it with “.ram 4G”.`); break; }
        const mb = parseRam(arg, 0);
        if (mb < 512) { say('RAM must be at least 512M, e.g. “.ram 2G” or “.ram 4096M”.', 'warn'); break; }
        if (mb > 1024 * 64) { say('that is over 64G — refusing as a likely typo.', 'warn'); break; }
        this.record.ram = mb;
        this.server.record.ram = mb;
        try { rememberServer(this.record); } catch {}
        const running = this.server.status === STATUS.RUNNING || this.server.status === STATUS.STARTING;
        say(`RAM set to ${fmtRam(mb)}${running ? ' — restart the server to apply (Ctrl+R).' : '.'}`);
        break;
      }
      case 'help': case '?':
        say('client commands: .ram <size> (e.g. .ram 4G) · .help · .quit  — anything else goes to the server.');
        break;
      default:
        say(`unknown client command “.${name}”. Try .help (server commands don’t need a dot).`, 'warn');
    }
    this.draw();
  }

  // ---- players -----------------------------------------------------------

  onPlayersKey(k) {
    const list = this.server.playerList();
    if (k.name === 'up') { this.pSel = Math.max(0, this.pSel - 1); return this.draw(); }
    if (k.name === 'down') { this.pSel = Math.min(list.length - 1, this.pSel + 1); return this.draw(); }
    if (k.name === 'enter' && list[this.pSel]) {
      this.overlay = { type: 'player', player: list[this.pSel], sel: 0 };
      return this.draw();
    }
  }

  // ---- properties --------------------------------------------------------

  loadProps() {
    if (this.prop && this.prop.loaded) return;
    const { file, model } = props.load(this.server.dir);
    this.prop = { file, model, sel: 0, scroll: 0, editing: null, loaded: true, msg: '' };
  }

  onPropsKey(k) {
    const p = this.prop;
    if (!p) return;
    if (p.editing) {
      if (k.name === 'enter') {
        props.set(p.model, p.editing.key, p.editing.buf);
        try { props.save(p.file, p.model); p.msg = `saved ${p.editing.key} (restart to apply)`; }
        catch (e) { p.msg = 'save failed: ' + e.message; }
        p.editing = null;
        return this.draw();
      }
      if (k.name === 'escape') { p.editing = null; p.msg = 'edit cancelled'; return this.draw(); }
      if (k.name === 'backspace') { p.editing.buf = p.editing.buf.slice(0, -1); return this.draw(); }
      if (k.name === 'C-u') { p.editing.buf = ''; return this.draw(); }
      if (k.name === 'char') { p.editing.buf += k.ch; return this.draw(); }
      return;
    }
    const keys = p.model.keys;
    if (k.name === 'up') { p.sel = Math.max(0, p.sel - 1); return this.draw(); }
    if (k.name === 'down') { p.sel = Math.min(keys.length - 1, p.sel + 1); return this.draw(); }
    if (k.name === 'pageup') { p.sel = Math.max(0, p.sel - 10); return this.draw(); }
    if (k.name === 'pagedown') { p.sel = Math.min(keys.length - 1, p.sel + 10); return this.draw(); }
    if (k.name === 'enter' && keys[p.sel]) {
      const key = keys[p.sel];
      p.editing = { key, buf: p.model.values[key] || '' };
      p.msg = '';
      return this.draw();
    }
  }

  // ---- files -------------------------------------------------------------

  refreshFiles() {
    const dir = this.files.cwd;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).map((d) => ({
        name: d.name, dir: d.isDirectory(),
      }));
    } catch (e) {
      this.files.error = e.message;
    }
    entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
    if (path.resolve(dir) !== path.resolve(this.server.dir)) {
      entries.unshift({ name: '..', dir: true, up: true });
    }
    this.files.entries = entries;
    if (this.files.sel >= entries.length) this.files.sel = 0;
  }

  onFilesKey(k) {
    if (this.files.viewer) return this.onViewerKey(k);
    const e = this.files.entries;
    if (k.name === 'up') { this.files.sel = Math.max(0, this.files.sel - 1); return this.draw(); }
    if (k.name === 'down') { this.files.sel = Math.min(e.length - 1, this.files.sel + 1); return this.draw(); }
    if (k.name === 'pageup') { this.files.sel = Math.max(0, this.files.sel - 10); return this.draw(); }
    if (k.name === 'pagedown') { this.files.sel = Math.min(e.length - 1, this.files.sel + 10); return this.draw(); }
    if (k.name === 'enter' && e[this.files.sel]) return this.openEntry(e[this.files.sel]);
  }

  openEntry(entry) {
    const target = entry.up
      ? path.dirname(this.files.cwd)
      : path.join(this.files.cwd, entry.name);
    if (entry.dir) {
      this.files.cwd = target;
      this.files.sel = 0; this.files.scroll = 0;
      this.refreshFiles();
      return this.draw();
    }
    // Open a text file in the viewer (guard against huge/binary files).
    try {
      const st = fs.statSync(target);
      if (st.size > 2 * 1024 * 1024) { this.files.error = 'file too large to view (>2MB)'; return this.draw(); }
      const raw = fs.readFileSync(target);
      if (isBinary(raw)) { this.files.error = 'binary file — not shown'; return this.draw(); }
      this.files.viewer = {
        file: target, name: entry.name,
        lines: raw.toString('utf8').split(/\r?\n/),
        sel: 0, scroll: 0, editing: null, dirty: false, msg: '',
      };
      this.files.error = '';
    } catch (e) {
      this.files.error = e.message;
    }
    this.draw();
  }

  onViewerKey(k) {
    const v = this.files.viewer;
    if (v.editing) {
      if (k.name === 'enter') { v.lines[v.editing.idx] = v.editing.buf; v.dirty = true; v.editing = null; v.msg = 'line changed — Ctrl+S to save'; return this.draw(); }
      if (k.name === 'escape') { v.editing = null; return this.draw(); }
      if (k.name === 'backspace') { v.editing.buf = v.editing.buf.slice(0, -1); return this.draw(); }
      if (k.name === 'C-u') { v.editing.buf = ''; return this.draw(); }
      if (k.name === 'char') { v.editing.buf += k.ch; return this.draw(); }
      return;
    }
    if (k.name === 'escape') { this.files.viewer = null; return this.draw(); }
    if (k.name === 'up') { v.sel = Math.max(0, v.sel - 1); return this.draw(); }
    if (k.name === 'down') { v.sel = Math.min(v.lines.length - 1, v.sel + 1); return this.draw(); }
    if (k.name === 'pageup') { v.sel = Math.max(0, v.sel - 15); return this.draw(); }
    if (k.name === 'pagedown') { v.sel = Math.min(v.lines.length - 1, v.sel + 15); return this.draw(); }
    if (k.name === 'enter') { v.editing = { idx: v.sel, buf: v.lines[v.sel] }; return this.draw(); }
    if (k.name === 'C-s') {
      try { fs.writeFileSync(v.file, v.lines.join('\n')); v.dirty = false; v.msg = 'saved ' + v.name; }
      catch (e) { v.msg = 'save failed: ' + e.message; }
      return this.draw();
    }
  }

  // ---- plugins -----------------------------------------------------------

  refreshPlugins() {
    const pluginsDir = path.join(this.server.dir, 'plugins');
    const modsDir = path.join(this.server.dir, 'mods');
    // Modded flavors (Fabric/Forge/NeoForge/Quilt) use mods/; everything else
    // uses plugins/. Honor whichever folder already exists, else the flavor's.
    const wantsMods = this.server.kind === 'mods';
    let dir = null, kind = '';
    if (fs.existsSync(pluginsDir) && !wantsMods) { dir = pluginsDir; kind = 'plugins'; }
    else if (fs.existsSync(modsDir) && wantsMods) { dir = modsDir; kind = 'mods'; }
    else if (fs.existsSync(pluginsDir)) { dir = pluginsDir; kind = 'plugins'; }
    else if (fs.existsSync(modsDir)) { dir = modsDir; kind = 'mods'; }
    else if (wantsMods) { dir = modsDir; kind = 'mods'; }
    else { dir = pluginsDir; kind = 'plugins'; }

    let entries = [];
    try {
      entries = fs.readdirSync(dir).filter((f) => /\.jar(\.disabled)?$/i.test(f)).map((f) => {
        let size = 0; try { size = fs.statSync(path.join(dir, f)).size; } catch {}
        return { file: f, enabled: !/\.disabled$/i.test(f), size };
      });
    } catch { /* dir may not exist yet */ }
    entries.sort((a, b) => a.file.localeCompare(b.file));
    this.plug = { dir, kind, entries, sel: Math.min(this.plug.sel, Math.max(0, entries.length - 1)) };
  }

  // Row 0 is the "Add a plugin/mod" action; rows 1..n are the installed jars.
  onPluginsKey(k) {
    const n = this.plug.entries.length + 1;
    if (k.name === 'up') { this.plug.sel = Math.max(0, this.plug.sel - 1); return this.draw(); }
    if (k.name === 'down') { this.plug.sel = Math.min(n - 1, this.plug.sel + 1); return this.draw(); }
    if (k.name === 'enter') {
      if (this.plug.sel === 0) return this.openLibrary();
      const p = this.plug.entries[this.plug.sel - 1];
      if (p) return this.togglePlugin(p);
    }
  }

  // ---- plugin/mod library browser (Modrinth / Hangar / SpigotMC) ----------

  openLibrary() {
    const libs = librariesFor(this.record.type);
    if (!libs.length) {
      this.plug.msg = `${this.record.type} has no compatible plugin/mod library.`;
      return this.draw();
    }
    this.overlay = {
      type: 'library', libs, libIdx: 0, query: '', focus: 'query',
      loading: false, error: '', results: [], sel: 0, scroll: 0,
      installing: false, msg: '', versionFiltered: true,
    };
    this.runLibrarySearch();
    this.draw();
  }

  onLibraryKey(k) {
    const o = this.overlay;
    if (k.name === 'C-c' || k.name === 'escape') { this.overlay = null; return this.draw(); }
    if (o.installing) return;
    if (k.name === 'tab' || k.name === 'shift-tab') {       // switch library source
      const d = k.name === 'tab' ? 1 : -1;
      o.libIdx = (o.libIdx + d + o.libs.length) % o.libs.length;
      return this.runLibrarySearch();
    }
    if (k.name === 'up' || k.name === 'wheelup') { o.focus = 'results'; o.sel = Math.max(0, o.sel - 1); return this.draw(); }
    if (k.name === 'down' || k.name === 'wheeldown') { o.focus = 'results'; o.sel = Math.min(o.results.length - 1, o.sel + 1); return this.draw(); }
    if (k.name === 'pageup') { o.focus = 'results'; o.sel = Math.max(0, o.sel - 8); return this.draw(); }
    if (k.name === 'pagedown') { o.focus = 'results'; o.sel = Math.min(o.results.length - 1, o.sel + 8); return this.draw(); }
    if (k.name === 'enter') {
      clearTimeout(o._searchTimer);
      if (o.focus === 'results' && o.results[o.sel]) return this.installLibrary(o.results[o.sel]);
      return this.runLibrarySearch();
    }
    // Typing searches live (debounced), so results update without pressing Enter.
    if (k.name === 'backspace') { o.query = o.query.slice(0, -1); o.focus = 'query'; this.scheduleLibrarySearch(); return this.draw(); }
    if (k.name === 'C-u') { o.query = ''; o.focus = 'query'; this.scheduleLibrarySearch(); return this.draw(); }
    if (k.name === 'char') { o.query += k.ch; o.focus = 'query'; this.scheduleLibrarySearch(); return this.draw(); }
  }

  // Debounce keystrokes into a search so the results panel stays responsive.
  scheduleLibrarySearch() {
    const o = this.overlay;
    if (!o || o.type !== 'library') return;
    clearTimeout(o._searchTimer);
    o._searchTimer = setTimeout(() => { if (this.overlay === o) this.runLibrarySearch(); }, 300);
  }

  runLibrarySearch() {
    const o = this.overlay;
    if (!o || o.type !== 'library') return;
    clearTimeout(o._searchTimer);
    const lib = o.libs[o.libIdx];
    o.loading = true; o.error = ''; o.msg = '';
    this.draw();
    lib.search({ flavor: this.record.type, gameVersion: this.record.version, query: o.query })
      .then((res) => {
        if (this.overlay !== o) return;
        o.loading = false; o.results = res.hits; o.versionFiltered = res.versionFiltered;
        o.sel = 0; o.scroll = 0;
        // Keep focus in the search field while typing; only no-results forces it.
        if (!res.hits.length) { o.focus = 'query'; o.msg = 'No results.'; }
        this.draw();
      })
      .catch((e) => {
        if (this.overlay !== o) return;
        o.loading = false; o.error = e.message || String(e);
        this.draw();
      });
  }

  installLibrary(hit) {
    const o = this.overlay;
    const lib = o.libs[o.libIdx];
    o.installing = true; o.msg = 'Resolving ' + hit.title + '…'; o.error = '';
    this.draw();
    Promise.resolve(lib.resolveFile({ hit, flavor: this.record.type, gameVersion: this.record.version }))
      .then((file) => {
        if (this.overlay !== o) return;
        if (!file.url && file.browseUrl) {     // can't auto-install (external/premium)
          o.installing = false;
          o.msg = `Hosted externally${file.note ? ' (' + file.note + ')' : ''} — download at: ${file.browseUrl}`;
          return this.draw();
        }
        try { fs.mkdirSync(this.plug.dir, { recursive: true }); } catch {}
        const dest = path.join(this.plug.dir, file.filename);
        o.msg = 'Downloading ' + file.filename + '…';
        this.draw();
        return download(file.url, dest, () => {}).then(() => {
          if (this.overlay !== o) return;
          // Some mirrors return an HTML page instead of a jar — verify the magic.
          if (file.fragile && !looksLikeJar(dest)) {
            try { fs.unlinkSync(dest); } catch {}
            o.installing = false;
            o.msg = `Couldn't fetch directly — open: ${file.browseUrl || '(source page)'}`;
            return this.draw();
          }
          o.installing = false;
          o.msg = `Installed ${file.filename} — restart to load.`;
          this.refreshPlugins();
          this.draw();
        });
      })
      .catch((e) => {
        if (this.overlay !== o) return;
        o.installing = false; o.error = 'Install failed: ' + (e.message || String(e));
        this.draw();
      });
  }

  togglePlugin(p) {
    const from = path.join(this.plug.dir, p.file);
    const to = p.enabled
      ? from + '.disabled'
      : path.join(this.plug.dir, p.file.replace(/\.disabled$/i, ''));
    try {
      fs.renameSync(from, to);
      this.plug.msg = `${p.enabled ? 'disabled' : 'enabled'} ${p.file} (restart to apply)`;
      this.refreshPlugins();
    } catch (e) {
      this.plug.msg = 'rename failed: ' + e.message;
    }
    this.draw();
  }

  // ---- server view (controls) -------------------------------------------

  serverActions() {
    const running = this.server.status === STATUS.RUNNING || this.server.status === STATUS.STARTING;
    return [
      running
        ? { label: 'Stop server', run: () => this.server.stop() }
        : { label: 'Start server', run: () => this.server.start() },
      { label: 'Restart server', run: () => this.server.restart(), dim: !running },
      { label: 'Force kill', run: () => this.server.stop({ force: true }), dim: !running },
      { label: this.server.eulaAccepted() ? 'EULA accepted ✓' : 'Accept Minecraft EULA',
        run: () => { this.server.acceptEula(); } },
      { label: '⮈ Back to server list', run: () => this.backToLauncher() },
      { label: 'Forget this server (keeps files)', run: () => this.confirmForget() },
    ];
  }

  onServerKey(k) {
    const acts = this.serverActions();
    if (k.name === 'up') { this.srvSel = Math.max(0, this.srvSel - 1); return this.draw(); }
    if (k.name === 'down') { this.srvSel = Math.min(acts.length - 1, this.srvSel + 1); return this.draw(); }
    if (k.name === 'enter' && acts[this.srvSel]) { acts[this.srvSel].run(); return this.draw(); }
  }

  // ---- network view (make the server public) ----------------------------

  initNetwork() {
    this.net.localIPs = network.localAddresses();
    this.net.detected = tunnels.detect();
    if (this.net.publicIPState === 'idle') this.refreshPublicIP();
  }

  refreshPublicIP() {
    this.net.publicIPState = 'loading';
    this.draw();
    network.publicIP()
      .then((ip) => { this.net.publicIP = ip; this.net.publicIPState = 'ok'; this.draw(); })
      .catch((e) => { this.net.publicIPState = 'error'; this.net.publicIPMsg = e.message || String(e); this.draw(); });
  }

  // The ordered list of access methods shown on the left of the Network view.
  netMethods() {
    const m = [
      { id: 'lan', name: 'Direct connection (LAN)' },
      { id: 'forward', name: 'Port forward (manual)' },
      { id: 'upnp', name: 'Auto port-forward (UPnP)' },
    ];
    for (const t of tunnels.TUNNELS) m.push({ id: 'tunnel:' + t.id, name: t.name + ' tunnel', provider: t });
    return m;
  }

  onNetworkKey(k) {
    const m = this.netMethods();
    if (k.name === 'up') { this.net.sel = Math.max(0, this.net.sel - 1); return this.draw(); }
    if (k.name === 'down') { this.net.sel = Math.min(m.length - 1, this.net.sel + 1); return this.draw(); }
    if (k.name === 'char' && /[rR]/.test(k.ch)) return this.refreshPublicIP();
    if (k.name === 'enter') return this.netActivate(m[this.net.sel]);
  }

  netActivate(method) {
    if (!method) return;
    if (method.id === 'forward') return this.netCheckReach();
    if (method.id === 'upnp') return this.netUpnp();
    if (method.id.startsWith('tunnel:')) return this.netTunnel(method.provider);
    this.draw(); // 'lan' is informational
  }

  netCheckReach() {
    const port = this.serverPort();
    const ip = this.net.publicIP;
    if (!ip) { this.net.reach = { state: 'error', detail: 'public IP not known yet — press R' }; return this.draw(); }
    this.net.reach = { state: 'checking', detail: 'asking an external node to connect…' };
    this.draw();
    network.checkPort(ip, port)
      .then((r) => { this.net.reach = { state: r.reachable ? 'open' : 'closed', detail: r.detail }; this.draw(); })
      .catch((e) => { this.net.reach = { state: 'error', detail: e.message || String(e) }; this.draw(); });
  }

  netUpnp() {
    const port = this.serverPort();
    const local = network.primaryLocal().address;
    if (this.net.upnp.state === 'ok') {
      this.net.upnp = { state: 'working', msg: 'removing port mapping…' };
      this.draw();
      upnp.unforward({ port })
        .then(() => { this.net.upnp = { state: 'idle', msg: 'port mapping removed' }; this.draw(); })
        .catch((e) => { this.net.upnp = { state: 'error', msg: e.message || String(e) }; this.draw(); });
      return;
    }
    this.net.upnp = { state: 'working', msg: 'asking your router via UPnP…' };
    this.draw();
    upnp.forward({ port, internalIP: local, desc: 'yasc ' + this.record.name })
      .then((r) => {
        this.net.upnp = { state: 'ok', msg: `forwarded TCP ${port} → ${local}`, externalIP: r.externalIP };
        if (r.externalIP && !this.net.publicIP) { this.net.publicIP = r.externalIP; this.net.publicIPState = 'ok'; }
        this.draw();
      })
      .catch((e) => { this.net.upnp = { state: 'error', msg: e.message || String(e) }; this.draw(); });
  }

  netTunnel(provider) {
    const id = provider.id;
    if (this.tunnel.providerId === id && this.tunnel.isActive()) { this.tunnel.stop(); return this.draw(); }
    this.tunnel.start(id, { port: this.serverPort(), bin: this.net.detected[id] });
    this.draw();
  }

  // Best public address to hand a friend, given what's currently set up.
  joinAddress() {
    if (this.tunnel.status === 'online' && this.tunnel.address) return this.tunnel.address;
    const port = this.serverPort();
    if ((this.net.upnp.state === 'ok' || this.net.reach.state === 'open') && this.net.publicIP) {
      return this.net.publicIP + ':' + port;
    }
    const l = this.net.localIPs[0];
    return l ? l.address + ':' + port : null;
  }

  confirmForget() {
    this.overlay = {
      type: 'confirm',
      text: 'Remove this server from yasc? Files on disk are kept.',
      ok: () => { forgetServer(this.server.dir); this.backToLauncher(); },
    };
  }

  // ---- overlays ----------------------------------------------------------

  onOverlayKey(k) {
    const o = this.overlay;
    if (o.type === 'stopping') return; // busy, ignore input
    if (o.type === 'library') return this.onLibraryKey(k);
    if (o.type === 'stopped') {
      if (k.name === 'char' && /[rR]/.test(k.ch)) { this.overlay = null; this.server.start(); return this.draw(); }
      if (k.name === 'char' && /[bB]/.test(k.ch)) { this.overlay = null; return this.backToLauncher(); }
      if (k.name === 'char' && /[qQ]/.test(k.ch)) { this.overlay = null; return this.leave('quit'); }
      if (k.name === 'escape' || k.name === 'enter' || (k.name === 'char' && /[sS]/.test(k.ch))) { this.overlay = null; return this.draw(); }
      if (k.name === 'C-c') { this.overlay = null; return this.leave('quit'); }
      return;
    }
    if (o.type === 'quit') {
      if (k.name === 'enter' || (k.name === 'char' && /[yY]/.test(k.ch))) { this.overlay = null; return this.leave('quit'); }
      if (k.name === 'escape' || k.name === 'C-c' || (k.name === 'char' && /[nN]/.test(k.ch))) { this.overlay = null; return this.draw(); }
      return;
    }
    if (k.name === 'C-c') return this.requestQuit();
    if (o.type === 'eula') {
      if (k.name === 'enter' || (k.name === 'char' && /[yY]/.test(k.ch))) {
        if (this.server.acceptEula()) { this.overlay = null; this.server.start(); }
        return this.draw();
      }
      if (k.name === 'escape' || (k.name === 'char' && /[nN]/.test(k.ch))) { this.overlay = null; return this.draw(); }
      return;
    }
    if (o.type === 'confirm') {
      if (k.name === 'enter' || (k.name === 'char' && /[yY]/.test(k.ch))) { const f = o.ok; this.overlay = null; f && f(); return this.draw(); }
      if (k.name === 'escape' || (k.name === 'char' && /[nN]/.test(k.ch))) { this.overlay = null; return this.draw(); }
      return;
    }
    if (o.type === 'player') {
      const acts = PLAYER_ACTIONS;
      if (k.name === 'up') { o.sel = Math.max(0, o.sel - 1); return this.draw(); }
      if (k.name === 'down') { o.sel = Math.min(acts.length - 1, o.sel + 1); return this.draw(); }
      if (k.name === 'escape') { this.overlay = null; return this.draw(); }
      if (k.name === 'enter') {
        const a = acts[o.sel];
        if (a.cmd) this.server.command(a.cmd.replace('%p', o.player));
        this.overlay = null;
        return this.draw();
      }
      return;
    }
  }

  // ---- quit --------------------------------------------------------------

  requestQuit(skipStop = false) {
    if (this._leaving) return;
    const running = this.server.status === STATUS.RUNNING || this.server.status === STATUS.STARTING;
    if (running && !skipStop && !(this.overlay && this.overlay.type === 'quit')) {
      this.overlay = { type: 'quit' };
      return this.draw();
    }
    this.leave('quit');
  }

  // Return to the server selection / creation screen without exiting yasc.
  backToLauncher() {
    if (this._leaving) return;
    this.leave('back');
  }

  // Shared teardown for both quitting and going back: stop the server (if any),
  // wait for it to actually exit so we never orphan it, then resolve.
  leave(next) {
    if (this._leaving) return;
    this._leaving = true;
    log.event('panel leave', { next });
    this.overlay = { type: 'stopping', next };

    const finish = () => {
      if (this._finished) return;
      this._finished = true;
      this.detach();
      this._resolve({ next });
    };

    if (this.server.child) {
      this.draw();
      this.server.once('exit', finish);
      this.server.stop();
      setTimeout(finish, 22000); // safety net if it hangs
    } else {
      finish();
    }
  }

  // ---- drawing -----------------------------------------------------------

  draw() {
    try { this._draw(); }
    catch (e) {
      const sig = (e && e.message) || String(e);
      if (sig !== this._lastErr) { this._lastErr = sig; log.error('draw error', e instanceof Error ? e : String(e)); }
      try {
        this.screen.placeCursor(0, this.screen.height - 1);
        this.screen.out.write(C.reset + C.red + ' render error (logged): ' + sig.slice(0, 70) + ' ' + C.reset);
      } catch {}
    }
  }

  _draw() {
    const s = this.screen;
    const W = s.width, H = s.height;
    s.clear();

    const headerH = 3, tabH = 1, footH = 3;
    const bodyY = headerH + tabH;
    const bodyH = H - headerH - tabH - footH;
    const sideW = W >= 86 ? 30 : 0;
    const mainW = W - sideW;

    this.drawHeader(W);
    this.drawTabs(0, headerH, W);

    const main = { x: 0, y: bodyY, w: mainW, h: bodyH };
    switch (this.view) {
      case 'console': this.drawConsole(main); break;
      case 'players': this.drawPlayers(main); break;
      case 'properties': this.drawProps(main); break;
      case 'files': this.drawFiles(main); break;
      case 'plugins': this.drawPlugins(main); break;
      case 'network': this.drawNetwork(main); break;
      case 'server': this.drawServer(main); break;
    }
    if (sideW) this.drawSidebar({ x: mainW, y: bodyY, w: sideW, h: bodyH });

    const caret = this.drawFooter({ x: 0, y: H - footH, w: W, h: footH });

    if (this.overlay) this.drawOverlay(W, H);

    const showCaret = caret && !this.overlay;
    if (showCaret) { s.showCursor(); s.render(); s.placeCursor(caret.x, caret.y); }
    else { s.hideCursor(); s.render(); }
  }

  drawHeader(W) {
    const s = this.screen;
    s.box(0, 0, W, 3, { style: C.border });
    s.text(2, 1, '▘ yasc', C.grass + C.bold);
    const dot = this.statusDot();
    s.text(11, 1, dot.ch + ' ' + dot.label, dot.style);
    const r = this.record;
    const mid = `${r.name}  ·  ${r.type} ${r.version || ''}`.trim();
    s.text(Math.floor((W - mid.length) / 2), 1, mid, C.cyan);
    const up = this.uptime();
    const right = (up !== '—' ? 'up ' + up + '   ' : '') + new Date().toLocaleTimeString();
    s.text(W - right.length - 2, 1, right, C.muted);
  }

  statusDot() {
    switch (this.server.status) {
      case STATUS.RUNNING: return { ch: '●', label: 'running', style: C.green };
      case STATUS.STARTING: return { ch: this.spinner(), label: 'starting', style: C.gold };
      case STATUS.STOPPING: return { ch: this.spinner(), label: 'stopping', style: C.gold };
      case STATUS.CRASHED: return { ch: '●', label: 'crashed', style: C.red };
      default: return { ch: '○', label: 'stopped', style: C.muted };
    }
  }
  spinner() { return ['◜', '◠', '◝', '◞', '◡', '◟'][(this._spinIdx++) % 6]; }

  drawTabs(x, y, W) {
    const s = this.screen;
    let cx = x + 1;
    VIEWS.forEach((v, i) => {
      const on = v === this.view;
      const label = ` ${i + 1}·${VIEW_LABEL[v]} `;
      if (on) s.fillRect(cx, y, label.length, 1, ' ', C.selBg);
      s.text(cx, y, label, on ? C.selFg + C.bold : C.muted);
      cx += label.length + 1;
    });
    const hint = 'Tab/F1-7 switch';
    s.text(W - hint.length - 1, y, hint, C.faint);
  }

  // ---- console view ----
  drawConsole(r) {
    const s = this.screen;
    const lines = this.server.console;
    const title = `Console · ${lines.length} lines` + (this.cScroll > 0 ? `  ⤒ scrolled +${this.cScroll}` : '');
    s.box(r.x, r.y, r.w, r.h, { style: C.borderHot, title, titleStyle: C.title });
    const rows = r.h - 2;
    const sbX = r.x + r.w - 2;        // scrollbar column, just inside the border
    const innerW = r.w - 5;           // leave room for the scrollbar
    const wrapped = [];
    const start = Math.max(0, lines.length - rows - this.cScroll - 60);
    for (let i = start; i < lines.length; i++) {
      const e = lines[i];
      for (const seg of wrap(e.text, innerW)) wrapped.push({ text: seg, level: e.level });
    }
    const maxScroll = Math.max(0, wrapped.length - rows);
    if (this.cScroll > maxScroll) this.cScroll = maxScroll;
    const end = wrapped.length - this.cScroll;
    const from = Math.max(0, end - rows);
    let yy = r.y + 1;
    for (let i = from; i < end; i++) {
      s.ansiText(r.x + 2, yy, wrapped[i].text, levelStyle(wrapped[i].level), innerW);
      yy++;
    }
    // scrollbar (thumb position: bottom = newest)
    if (wrapped.length > rows) {
      const frac = maxScroll > 0 ? this.cScroll / maxScroll : 0;
      const thumb = Math.max(1, Math.round((rows * rows) / wrapped.length));
      const top = Math.round((1 - frac) * (rows - thumb));
      for (let i = 0; i < rows; i++) {
        const on = i >= top && i < top + thumb;
        s.put(sbX, r.y + 1 + i, on ? '█' : '│', on ? C.borderHot : C.faint);
      }
    }
  }

  // ---- players view ----
  drawPlayers(r) {
    const s = this.screen;
    const list = this.server.playerList();
    const max = this.server.maxPlayers || this.record.maxPlayers || '?';
    s.box(r.x, r.y, r.w, r.h, { style: C.borderHot, title: `Players ${list.length}/${max}`, titleStyle: C.title });
    if (this.pSel >= list.length) this.pSel = Math.max(0, list.length - 1);
    if (!list.length) {
      s.text(r.x + 2, r.y + 1, this.server.status === STATUS.RUNNING ? 'No players online.' : 'Server not running.', C.faint);
      return;
    }
    const rows = r.h - 2;
    for (let i = 0; i < list.length && i < rows; i++) {
      const name = list[i];
      const sel = i === this.pSel;
      if (sel) s.fillRect(r.x + 1, r.y + 1 + i, r.w - 2, 1, ' ', C.selBg);
      const info = this.server.players.get(name);
      const t = info ? since(info.joinedAt) : '';
      s.text(r.x + 2, r.y + 1 + i, (sel ? '▸ ' : '  ') + name, sel ? C.selFg + C.bold : C.text);
      s.text(r.x + r.w - t.length - 2, r.y + 1 + i, t, sel ? C.selFg : C.muted);
    }
    s.text(r.x + 2, r.y + r.h - 1, 'Enter: actions (op/kick/ban…)', C.faint, r.w - 4);
  }

  // ---- properties view ----
  drawProps(r) {
    const s = this.screen;
    const p = this.prop;
    s.box(r.x, r.y, r.w, r.h, { style: C.border, title: 'server.properties', titleStyle: C.title });
    if (!p) return;
    const keys = p.model.keys;
    const rows = r.h - 2;
    if (p.sel < p.scroll) p.scroll = p.sel;
    if (p.sel >= p.scroll + rows) p.scroll = p.sel - rows + 1;
    const keyW = Math.min(28, Math.floor(r.w * 0.45));
    for (let i = 0; i < rows && i + p.scroll < keys.length; i++) {
      const idx = i + p.scroll;
      const key = keys[idx];
      const sel = idx === p.sel;
      const y = r.y + 1 + i;
      if (sel) s.fillRect(r.x + 1, y, r.w - 2, 1, ' ', C.selBg);
      s.text(r.x + 2, y, key, sel ? C.selFg + C.bold : C.text, keyW);
      if (p.editing && sel) {
        s.text(r.x + 2 + keyW, y, p.editing.buf + '▏', C.gold, r.w - keyW - 4);
      } else {
        s.text(r.x + 2 + keyW, y, p.model.values[key], sel ? C.selFg : C.green, r.w - keyW - 4);
      }
    }
    const note = p.editing ? 'Enter save · Esc cancel'
      : (p.msg || 'Enter to edit a value · changes need a server restart');
    s.text(r.x + 2, r.y + r.h - 1, note, p.editing ? C.gold : C.faint, r.w - 4);
  }

  // ---- files view ----
  drawFiles(r) {
    const s = this.screen;
    if (this.files.viewer) return this.drawViewer(r);
    const rel = path.relative(this.server.dir, this.files.cwd) || '.';
    s.box(r.x, r.y, r.w, r.h, { style: C.border, title: 'Files  ·  ' + rel, titleStyle: C.title });
    const e = this.files.entries;
    const rows = r.h - 2;
    if (this.files.sel < this.files.scroll) this.files.scroll = this.files.sel;
    if (this.files.sel >= this.files.scroll + rows) this.files.scroll = this.files.sel - rows + 1;
    for (let i = 0; i < rows && i + this.files.scroll < e.length; i++) {
      const idx = i + this.files.scroll;
      const it = e[idx];
      const sel = idx === this.files.sel;
      const y = r.y + 1 + i;
      if (sel) s.fillRect(r.x + 1, y, r.w - 2, 1, ' ', C.selBg);
      const icon = it.up ? '⮈' : it.dir ? '▸' : ' ';
      const style = sel ? C.selFg + C.bold : it.dir ? C.cyan : C.text;
      s.text(r.x + 2, y, `${icon} ${it.name}`, style, r.w - 4);
    }
    const note = this.files.error || 'Enter: open folder / view file';
    s.text(r.x + 2, r.y + r.h - 1, note, this.files.error ? C.red : C.faint, r.w - 4);
  }

  drawViewer(r) {
    const s = this.screen;
    const v = this.files.viewer;
    s.box(r.x, r.y, r.w, r.h, { style: C.borderHot, title: 'View  ·  ' + v.name + (v.dirty ? ' *' : ''), titleStyle: C.title });
    const rows = r.h - 2, innerW = r.w - 6;
    if (v.sel < v.scroll) v.scroll = v.sel;
    if (v.sel >= v.scroll + rows) v.scroll = v.sel - rows + 1;
    for (let i = 0; i < rows && i + v.scroll < v.lines.length; i++) {
      const idx = i + v.scroll;
      const sel = idx === v.sel;
      const y = r.y + 1 + i;
      if (sel) s.fillRect(r.x + 1, y, r.w - 2, 1, ' ', C.selBg);
      s.text(r.x + 1, y, String(idx + 1).padStart(4), C.faint);
      const content = (v.editing && v.editing.idx === idx) ? v.editing.buf + '▏' : v.lines[idx];
      s.text(r.x + 6, y, content, sel ? C.selFg : C.text, innerW);
    }
    const note = v.editing ? 'Enter save line · Esc cancel'
      : (v.msg || 'Enter edit line · Ctrl+S save file · Esc back');
    s.text(r.x + 2, r.y + r.h - 1, note, v.editing ? C.gold : C.faint, r.w - 4);
  }

  // ---- plugins view ----
  drawPlugins(r) {
    const s = this.screen;
    const e = this.plug.entries;
    const enabled = e.filter((p) => p.enabled).length;
    const kindLabel = this.plug.kind === 'mods' ? 'Mods' : 'Plugins';
    s.box(r.x, r.y, r.w, r.h, {
      style: C.border,
      title: `${kindLabel}  ${enabled}/${e.length} on`,
      titleStyle: C.title,
    });
    // Combined list: index 0 = "Add from Modrinth", 1..n = jars.
    const total = e.length + 1;
    if (this.plug.sel >= total) this.plug.sel = total - 1;
    const rows = r.h - 2;
    const top = Math.max(0, Math.min(this.plug.sel - rows + 2, total - rows));
    for (let i = 0; i < rows && i + top < total; i++) {
      const idx = i + top;
      const sel = idx === this.plug.sel;
      const y = r.y + 1 + i;
      if (sel) s.fillRect(r.x + 1, y, r.w - 2, 1, ' ', C.selBg);
      if (idx === 0) {
        const libs = librariesFor(this.record.type);
        const label = libs.length ? `+ Add (${libs.map((l) => l.name).join('/')})…` : '+ Add (no library for this flavor)';
        s.text(r.x + 2, y, label, sel ? C.selFg + C.bold : libs.length ? C.cyan : C.faint, r.w - 4);
      } else {
        const p = e[idx - 1];
        const name = p.file.replace(/\.disabled$/i, '');
        s.text(r.x + 2, y, p.enabled ? '●' : '○', p.enabled ? C.green : C.faint);
        s.text(r.x + 4, y, name, sel ? C.selFg + C.bold : p.enabled ? C.text : C.muted, r.w - 16);
        const sz = fmtSize(p.size);
        s.text(r.x + r.w - sz.length - 2, y, sz, sel ? C.selFg : C.faint);
      }
    }
    if (!e.length) {
      const ly = r.y + Math.min(rows, 3);
      s.text(r.x + 2, ly, `No ${this.plug.kind} installed yet.`, C.faint, r.w - 4);
    }
    s.text(r.x + 2, r.y + r.h - 1,
      this.plug.msg || 'Enter: add from Modrinth / toggle selected', C.faint, r.w - 4);
  }

  // ---- server view ----
  drawServer(r) {
    const s = this.screen;
    s.box(r.x, r.y, r.w, r.h, { style: C.border, title: 'Server', titleStyle: C.title });
    const r2 = this.record;
    const port = this.serverPort();
    const lines = [
      ['Name', r2.name, C.white],
      ['Flavor', r2.type, C.cyan],
      ['Version', r2.version || '?', C.cyan],
      ['Jar', r2.jar, C.text],
      ['Directory', r2.dir, C.faint],
      ['Java', this.ctx.java ? `${this.ctx.java.version}` : (r2.java || 'java'), C.text],
      ['Memory', fmtRam(r2.ram || 0), C.gold],
      ['Port', String(port), C.gold],
      ['EULA', this.server.eulaAccepted() ? 'accepted' : 'NOT accepted',
        this.server.eulaAccepted() ? C.green : C.red],
    ];
    let y = r.y + 1;
    for (const [k, val, st] of lines) {
      this.kv(r.x + 2, y, k, val, st, r.x + r.w - 2);
      y++;
    }
    y++;
    s.text(r.x + 2, y++, 'Controls', C.muted);
    const acts = this.serverActions();
    for (let i = 0; i < acts.length; i++) {
      const sel = i === this.srvSel;
      const a = acts[i];
      const yy = y + i;
      if (sel) s.fillRect(r.x + 1, yy, r.w - 2, 1, ' ', C.selBg);
      const style = sel ? C.selFg + C.bold : a.dim ? C.faint : C.text;
      s.text(r.x + 2, yy, (sel ? '▸ ' : '  ') + a.label, style, r.w - 4);
    }
    s.text(r.x + 2, r.y + r.h - 1, '↑↓ select · Enter run · Ctrl+R start/restart', C.faint, r.w - 4);
  }

  // Cached so we don't re-read server.properties on every frame (the sidebar
  // and Network view ask for it several times per draw).
  serverPort() {
    const now = Date.now();
    if (this._portCache && now - this._portCache.at < 2000) return this._portCache.val;
    let val = 25565;
    try { val = props.load(this.server.dir).model.values['server-port'] || 25565; } catch {}
    this._portCache = { val, at: now };
    return val;
  }

  // ---- network view ----
  drawNetwork(r) {
    const s = this.screen;
    s.box(r.x, r.y, r.w, r.h, { style: C.borderHot, title: 'Network · make your server reachable', titleStyle: C.title });
    const x = r.x + 2, endX = r.x + r.w - 2;
    const port = this.serverPort();
    const local = this.net.localIPs[0] ? this.net.localIPs[0].address : '—';
    const pub = this.net.publicIPState === 'loading' ? '…fetching'
      : this.net.publicIPState === 'error' ? 'unknown' : (this.net.publicIP || '— press R');
    this.kv(x, r.y + 1, 'Public', pub, this.net.publicIP ? C.gold : C.faint, x + 30);
    this.kv(x + 34, r.y + 1, 'LAN', local, C.cyan, endX - 10);
    this.kv(endX - 9, r.y + 1, 'Port', String(port), C.gold, endX + 1);

    const join = this.joinAddress();
    const online = this.tunnel.status === 'online';
    s.text(x, r.y + 2, 'Join ▸ ', C.muted);
    s.text(x + 7, r.y + 2, join || 'not exposed yet', join ? (online ? C.green + C.bold : C.cyan + C.bold) : C.faint, endX - (x + 7));

    // list (left) / detail (right)
    const listW = Math.min(30, Math.floor(r.w * 0.42));
    const ly = r.y + 4;
    const methods = this.netMethods();
    for (let i = 0; i < methods.length; i++) {
      const yy = ly + i;
      if (yy >= r.y + r.h - 1) break;
      const mth = methods[i], sel = i === this.net.sel;
      if (sel) s.fillRect(r.x + 1, yy, listW, 1, ' ', C.selBg);
      let dot = '○', dotStyle = C.muted;
      if (mth.provider) {
        const active = this.tunnel.providerId === mth.provider.id && this.tunnel.status === 'online';
        const installed = !!this.net.detected[mth.provider.id];
        dot = active ? '●' : installed ? '○' : '·';
        dotStyle = active ? C.green : installed ? C.cyan : C.faint;
      } else if (mth.id === 'upnp') {
        dot = this.net.upnp.state === 'ok' ? '●' : '○';
        dotStyle = this.net.upnp.state === 'ok' ? C.green : C.muted;
      } else if (mth.id === 'forward') {
        dot = this.net.reach.state === 'open' ? '●' : '○';
        dotStyle = this.net.reach.state === 'open' ? C.green : C.muted;
      }
      s.text(r.x + 2, yy, dot, dotStyle);
      s.text(r.x + 4, yy, mth.name, sel ? C.selFg + C.bold : C.text, listW - 3);
    }
    const dx = r.x + listW + 1;
    for (let yy = ly; yy < r.y + r.h - 1; yy++) s.put(dx, yy, '│', C.faint);
    this.drawNetDetail(methods[this.net.sel], dx + 2, ly, r.x + r.w - 2 - (dx + 2), r.y + r.h - 1);

    s.text(r.x + 2, r.y + r.h - 1, '↑↓ method · Enter activate · R refresh public IP · Tab next view', C.faint, r.w - 4);
  }

  drawNetDetail(method, x, y, w, bottom) {
    const s = this.screen;
    let cy = y;
    const line = (str, style = C.text) => { if (cy < bottom) { s.text(x, cy, str, style, w); cy++; } };
    const wrapLine = (str, style) => { for (const seg of wrap(String(str), w)) line(seg, style); };
    if (!method) return;
    const port = this.serverPort();

    if (method.id === 'lan') {
      line('Direct connection (same network)', C.title + C.bold); line('');
      line('Anyone on your wifi/LAN can join right now at:', C.muted);
      const l = this.net.localIPs[0];
      line(l ? `${l.address}:${port}` : `localhost:${port}`, C.green + C.bold);
      line('');
      if (this.net.localIPs.length > 1) {
        line('All local addresses:', C.muted);
        this.net.localIPs.forEach((a) => line(`  ${a.address}  (${a.iface})`, C.faint));
      }
      line('');
      line('For players outside your network, use port', C.muted);
      line('forwarding, UPnP, or a tunnel (below).', C.muted);
    } else if (method.id === 'forward') {
      line('Manual port forward', C.title + C.bold); line('');
      const l = this.net.localIPs[0];
      line('On your router admin page, forward:', C.muted);
      line(`  TCP port ${port}  →  ${l ? l.address : 'this PC'}`, C.gold);
      line('Then friends join at:', C.muted);
      line(`  ${this.net.publicIP || '<your public IP>'}:${port}`, C.green + C.bold);
      line('');
      const rs = this.net.reach;
      const rcolor = rs.state === 'open' ? C.green : rs.state === 'closed' ? C.red
        : rs.state === 'checking' ? C.gold : C.faint;
      const rlabel = rs.state === 'open' ? '● reachable from the internet'
        : rs.state === 'closed' ? '● not reachable yet'
          : rs.state === 'checking' ? this.spinner() + ' checking…'
            : rs.state === 'error' ? '! ' + rs.detail : 'reachability unknown';
      line(rlabel, rcolor);
      if (rs.detail && rs.state !== 'error') wrapLine(rs.detail, C.faint);
      line('');
      line('Enter: test if the port is reachable', C.faint);
    } else if (method.id === 'upnp') {
      line('Automatic port forward (UPnP)', C.title + C.bold); line('');
      line('Asks your router to open the port for you —', C.muted);
      line('works only if UPnP is enabled on the router.', C.muted);
      line('');
      const u = this.net.upnp;
      const us = u.state === 'ok' ? C.green : u.state === 'error' ? C.red : u.state === 'working' ? C.gold : C.faint;
      const ulabel = u.state === 'ok' ? '● ' + u.msg
        : u.state === 'working' ? this.spinner() + ' ' + u.msg
          : u.state === 'error' ? '! ' + u.msg : 'not mapped';
      wrapLine(ulabel, us);
      if (u.externalIP) line(`public IP: ${u.externalIP}`, C.gold);
      line('');
      line(u.state === 'ok' ? 'Enter: remove the port mapping' : 'Enter: open the port via UPnP', C.faint);
    } else if (method.provider) {
      const t = method.provider;
      const installed = !!this.net.detected[t.id];
      const isThis = this.tunnel.providerId === t.id;
      line(t.name + ' tunnel', C.title + C.bold);
      line(t.account, C.faint); line('');
      if (!installed) {
        line('Agent not found on PATH.', C.red);
        line('Get it: ' + t.install.url, C.cyan);
        line('');
        t.install.steps.forEach((stp) => wrapLine('• ' + stp, C.muted));
      } else if (isThis && this.tunnel.status === 'online') {
        line('● online', C.green + C.bold);
        line('Players join at:', C.muted);
        line(this.tunnel.address, C.green + C.bold);
        if (this.tunnel.authUrl) { line('Link account:', C.muted); wrapLine(this.tunnel.authUrl, C.cyan); }
        line('');
        line('Enter: stop this tunnel', C.faint);
      } else if (isThis && this.tunnel.status === 'starting') {
        line(this.spinner() + ' starting…', C.gold);
        if (this.tunnel.authUrl) { line('Open to link your account:', C.muted); wrapLine(this.tunnel.authUrl, C.cyan); }
        line(''); line('Enter: stop', C.faint);
      } else if (isThis && this.tunnel.status === 'error') {
        line('! ' + (this.tunnel.error || 'error'), C.red);
        line('Enter: try again', C.faint);
      } else {
        line('Installed ✓  ' + (this.tunnel.isActive() ? '(another tunnel is active)' : 'ready'),
          this.tunnel.isActive() ? C.gold : C.green);
        line('');
        line('Enter: start the tunnel', C.faint);
      }
      // recent agent output for the active provider
      if (isThis && this.tunnel.lines.length) {
        line('');
        line('output', C.muted);
        const tail = this.tunnel.lines.slice(-Math.max(0, bottom - cy));
        tail.forEach((ln) => line(truncate(ln, w), C.faint));
      }
    }
  }

  // ---- sidebar ----
  drawSidebar(r) {
    const s = this.screen;
    s.box(r.x, r.y, r.w, r.h, { style: C.border, title: 'Status', titleStyle: C.title });
    const x = r.x + 2, endX = r.x + r.w - 2;
    const bottom = r.y + r.h - 1;
    let y = r.y + 1;
    const M = this.server.metrics;
    const running = this.server.status === STATUS.RUNNING;
    // height-aware writers: stop cleanly instead of bleeding past the box
    const head = (t) => { if (y < bottom) s.text(x, y++, t, C.muted); };
    const kv = (k, v, st) => { if (y < bottom) this.kv(x, y++, k, v, st, endX); };
    const gap = () => { if (y < bottom - 1) y++; };

    const dot = this.statusDot();
    kv('State', dot.label, dot.style);
    kv('Uptime', this.uptime(), C.white);
    if (this.server.category !== 'proxy') {
      const max = this.server.maxPlayers || this.record.maxPlayers || '?';
      kv('Players', `${this.server.playerList().length}/${max}`, C.green);
    }
    gap();
    head('Performance');
    if (this.server.tpsSupported) {
      kv('TPS', running && M.tps != null ? M.tps.toFixed(1) : '—', tpsColor(M.tps, running));
      if (this.server.isPaperFamily()) kv('MSPT', running && M.mspt != null ? M.mspt.toFixed(1) : '—', msptColor(M.mspt, running));
    }
    kv('RAM', this.perf.rssMB ? fmtMB(this.perf.rssMB) : '—', memColor(this.perf.rssMB));
    kv('Alloc', fmtRam(this.record.ram || 0), C.faint);
    kv('CPU', this.server.child ? this.perf.cpu.toFixed(0) + '%' : '—', cpuColor(this.perf.cpu));
    if (this.server.kind !== 'none') kv(this.server.kind === 'mods' ? 'Mods' : 'Plugins', M.content == null ? '—' : String(M.content), C.white);
    kv('World', M.worldMB == null ? '—' : fmtMB(M.worldMB), C.faint);
    gap();
    head('Host');
    const memPct = this.perf.memTotal ? (this.perf.memUsed / this.perf.memTotal * 100) : 0;
    kv('Mem', `${fmtMB(this.perf.memUsed)}/${fmtMB(this.perf.memTotal)}`, memColor2(memPct));
    kv('Load', this.perf.load.toFixed(2), C.white);
    kv('Port', String(this.serverPort()), C.gold);
    gap();
    const online = this.tunnel.status === 'online';
    head('Access');
    if (online) kv('Tunnel', this.tunnel.provider ? this.tunnel.provider.name : 'on', C.green);
    const join = this.joinAddress();
    if (y < bottom) s.text(x, y++, 'Join', C.muted);
    if (y < bottom) s.text(x, y++, join || '—', online ? C.green + C.bold : join ? C.cyan : C.faint, r.w - 3);
  }

  kv(x, y, label, val, vstyle, endX) {
    const s = this.screen;
    s.text(x, y, label, C.muted);
    const vx = x + 8;
    s.text(vx, y, String(val), vstyle || C.white, Math.max(0, endX - vx));
  }

  // ---- footer / input ----
  drawFooter(r) {
    const s = this.screen;
    if (this.view === 'console') {
      const hot = this.server.status === STATUS.RUNNING;
      s.box(r.x, r.y, r.w, 3, { style: hot ? C.borderHot : C.border });
      s.text(r.x + 2, r.y + 1, '>', hot ? C.grass + C.bold : C.muted);
      const maxLen = r.w - 6;
      let shown = this.cmd, off = 0;
      if (shown.length > maxLen) { off = shown.length - maxLen; shown = shown.slice(off); }
      if (this.cmd) {
        const style = this.cmd[0] === '.' ? C.purple : C.white;
        s.text(r.x + 4, r.y + 1, shown, style, maxLen);
      } else s.text(r.x + 4, r.y + 1, hot ? 'server command (say hi · op <name>) · .ram 4G to set memory · .help'
        : 'server stopped — Ctrl+R to start · .ram <size> to set memory · Server tab', C.faint, maxLen);
      return { x: r.x + 4 + (this.cmd.length - off), y: r.y + 1 };
    }
    // contextual hint bar for non-console views
    s.box(r.x, r.y, r.w, 3, { style: C.border });
    s.text(r.x + 2, r.y + 1, this.footerHint(), C.faint, r.w - 4);
    return null;
  }

  footerHint() {
    switch (this.view) {
      case 'players': return '↑↓ select player · Enter actions · Tab next view · Ctrl+C quit';
      case 'properties': return '↑↓ select · Enter edit · saves to server.properties · Tab next view';
      case 'files': return '↑↓ navigate · Enter open · Esc up · Tab next view';
      case 'plugins': return '↑↓ select · Enter add-from-Modrinth / toggle · Tab next view';
      case 'network': return '↑↓ method · Enter activate · R refresh public IP · Tab next view';
      case 'server': return '↑↓ select action · Enter run · Ctrl+R start/restart · Ctrl+C quit';
      default: return 'Tab switches views · Ctrl+C quit';
    }
  }

  // ---- overlays ----
  drawOverlay(W, H) {
    const s = this.screen;
    const o = this.overlay;
    if (o.type === 'player') return this.drawPlayerMenu(W, H);
    if (o.type === 'library') return this.drawLibrary(W, H);
    const w = Math.min(60, W - 6);
    const h = o.type === 'eula' ? 11 : o.type === 'stopped' ? 11 : 9;
    const x = Math.floor((W - w) / 2), y = Math.floor((H - h) / 2);
    s.fillRect(x, y, w, h, ' ', '');
    const accent = o.type === 'quit' || o.type === 'stopping' ? C.gold
      : o.type === 'stopped' && o.crashed ? C.red : C.borderHot;
    s.box(x, y, w, h, { style: accent, title: this.overlayTitle(o), titleStyle: accent + C.bold });
    if (o.type === 'eula') {
      center(s, x, w, y + 2, 'This server has not accepted the Minecraft EULA.', C.text);
      center(s, x, w, y + 4, 'https://aka.ms/MinecraftEULA', C.cyan);
      center(s, x, w, y + 6, 'Accept it to start the server?', C.text);
      center(s, x, w, y + 8, 'Enter / Y = accept & start    ·    Esc / N = not now', C.faint);
    } else if (o.type === 'quit') {
      center(s, x, w, y + 2, 'The server is still running.', C.text);
      center(s, x, w, y + 4, 'Stop it and close the panel?', C.text);
      center(s, x, w, y + 6, 'Enter / Y = stop & quit   ·   Esc / N = keep running', C.faint);
    } else if (o.type === 'stopping') {
      center(s, x, w, y + 3, this.spinner() + '  Stopping server…', C.gold);
      center(s, x, w, y + 5, o.next === 'back' ? 'returning to the server list' : 'closing the panel', C.faint);
    } else if (o.type === 'stopped') {
      center(s, x, w, y + 2, o.crashed ? 'The server crashed.' : 'The server has stopped.',
        o.crashed ? C.red : C.text);
      center(s, x, w, y + 4, 'What next?', C.text);
      center(s, x, w, y + 6, '[R] Restart    [B] Back to server list', C.cyan);
      center(s, x, w, y + 8, '[S] Stay here    [Q] Quit yasc', C.faint);
    } else if (o.type === 'confirm') {
      center(s, x, w, y + 3, o.text, C.text);
      center(s, x, w, y + 5, 'Enter / Y = yes   ·   Esc / N = no', C.faint);
    }
  }
  overlayTitle(o) {
    return {
      eula: 'Minecraft EULA', quit: 'Server running', confirm: 'Confirm',
      stopping: 'Please wait', stopped: o.crashed ? 'Server crashed' : 'Server stopped',
    }[o.type] || '';
  }

  drawLibrary(W, H) {
    const s = this.screen;
    const o = this.overlay;
    const w = Math.min(86, W - 4), h = Math.min(27, H - 2);
    const x = Math.floor((W - w) / 2), y = Math.floor((H - h) / 2);
    s.fillRect(x, y, w, h, ' ', '');
    const kind = this.server.kind === 'mods' ? 'mods' : 'plugins';
    s.box(x, y, w, h, {
      style: C.borderHot,
      title: `Add ${kind} · ${this.record.type} ${this.record.version}`,
      titleStyle: C.title + C.bold,
    });
    // library source switcher (Tab to cycle)
    let cx = x + 2;
    o.libs.forEach((lib, i) => {
      const on = i === o.libIdx;
      const lbl = ` ${lib.name} `;
      if (on) s.fillRect(cx, y + 1, lbl.length, 1, ' ', C.selBg);
      s.text(cx, y + 1, lbl, on ? C.selFg + C.bold : C.muted);
      cx += lbl.length + 1;
    });
    s.text(x + w - 14, y + 1, 'Tab ▸ source', C.faint);
    // search field
    const qActive = o.focus === 'query';
    s.text(x + 2, y + 2, 'Search', qActive ? C.borderHot + C.bold : C.muted);
    s.box(x + 2, y + 3, w - 4, 3, { style: qActive ? C.borderHot : C.border });
    s.text(x + 4, y + 4, o.query || (qActive ? '' : 'type to search…'), o.query ? C.white : C.faint, w - 8);

    const listY = y + 7, listH = h - 9;
    if (o.loading) {
      s.text(x + 3, listY, this.spinner() + `  searching ${o.libs[o.libIdx].name}…`, C.gold);
    } else if (o.error) {
      s.text(x + 3, listY, o.error, C.red, w - 6);
    } else if (!o.results.length) {
      s.text(x + 3, listY, o.msg || 'No results.', C.faint);
    } else {
      if (o.sel < o.scroll) o.scroll = o.sel;
      if (o.sel >= o.scroll + Math.floor(listH / 2)) o.scroll = o.sel - Math.floor(listH / 2) + 1;
      let row = 0;
      for (let i = o.scroll; i < o.results.length && row + 1 < listH; i++) {
        const r = o.results[i];
        const sel = i === o.sel;
        const yy = listY + row;
        if (sel) s.fillRect(x + 1, yy, w - 2, 2, ' ', C.selBg);
        const dl = fmtDownloads(r.downloads);
        s.text(x + 3, yy, (sel ? '▸ ' : '  ') + r.title, sel ? C.selFg + C.bold : C.text, w - 18);
        s.text(x + w - dl.length - 3, yy, dl, sel ? C.selFg : C.gold);
        s.text(x + 5, yy + 1, truncate(r.description || '', w - 10), sel ? C.selFg : C.muted, w - 10);
        row += 2;
      }
    }
    // footer
    let note;
    if (o.installing) note = this.spinner() + '  ' + o.msg;
    else if (o.msg) note = o.msg;
    else note = 'type to search (live) · ↑↓ pick · Enter install · Tab source · Esc close';
    if (!o.versionFiltered && !o.loading && o.results.length && !o.msg) {
      note = '⚠ not version-filtered by this source · ' + note;
    }
    s.text(x + 2, y + h - 1, ' ' + note + ' ', o.installing ? C.gold : (o.error ? C.red : C.faint), w - 4);
  }

  drawPlayerMenu(W, H) {
    const s = this.screen;
    const o = this.overlay;
    const w = 34, h = PLAYER_ACTIONS.length + 4;
    const x = Math.floor((W - w) / 2), y = Math.floor((H - h) / 2);
    s.fillRect(x, y, w, h, ' ', '');
    s.box(x, y, w, h, { style: C.borderHot, title: 'Player · ' + o.player, titleStyle: C.title + C.bold });
    PLAYER_ACTIONS.forEach((a, i) => {
      const sel = i === o.sel;
      const yy = y + 1 + i;
      if (sel) s.fillRect(x + 1, yy, w - 2, 1, ' ', C.selBg);
      s.text(x + 2, yy, (sel ? '▸ ' : '  ') + a.label, sel ? C.selFg + C.bold : C.text);
    });
    s.text(x + 2, y + h - 1, 'Enter run · Esc cancel', C.faint);
  }

  uptime() {
    const ms = this.server.uptimeMs();
    if (!ms) return '—';
    let sec = Math.floor(ms / 1000);
    const h = Math.floor(sec / 3600); sec -= h * 3600;
    const m = Math.floor(sec / 60); sec -= m * 60;
    return (h ? h + 'h' : '') + String(m).padStart(h ? 2 : 1, '0') + 'm' + String(sec).padStart(2, '0') + 's';
  }
}

// ---- player action menu ----
const PLAYER_ACTIONS = [
  { label: 'Make operator (op)', cmd: 'op %p' },
  { label: 'Remove operator (deop)', cmd: 'deop %p' },
  { label: 'Kick', cmd: 'kick %p' },
  { label: 'Ban', cmd: 'ban %p' },
  { label: 'Whitelist add', cmd: 'whitelist add %p' },
  { label: 'Teleport to spawn', cmd: 'spawnpoint %p' },
  { label: 'Cancel', cmd: null },
];

// ---- formatting helpers ----------------------------------------------------
function levelStyle(level) {
  switch (level) {
    case 'error': return C.red;
    case 'warn': return C.gold;
    case 'cmd': return C.cyan + C.bold;
    case 'sys': return C.purple;
    default: return C.text;
  }
}
function fmtMB(mb) { return mb >= 1024 ? (mb / 1024).toFixed(1) + 'G' : Math.round(mb) + 'M'; }
function fmtSize(b) {
  if (b >= 1048576) return (b / 1048576).toFixed(1) + 'M';
  if (b >= 1024) return Math.round(b / 1024) + 'K';
  return b + 'B';
}
function memColor(mb) { return !mb ? C.faint : mb < 1024 ? C.green : mb < 3072 ? C.gold : C.red; }
function memColor2(pct) { return pct < 70 ? C.green : pct < 88 ? C.gold : C.red; }
function cpuColor(p) { return p < 50 ? C.green : p < 85 ? C.gold : C.red; }
function tpsColor(t, running) { return !running || t == null ? C.faint : t >= 19 ? C.green : t >= 15 ? C.gold : C.red; }
function msptColor(m, running) { return !running || m == null ? C.faint : m <= 30 ? C.green : m <= 45 ? C.gold : C.red; }

// Cheap sanity check that a downloaded file is really a jar (ZIP "PK" magic),
// so a mirror that returns an HTML error page doesn't masquerade as a plugin.
function looksLikeJar(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(2);
    fs.readSync(fd, buf, 0, 2, 0);
    fs.closeSync(fd);
    return buf[0] === 0x50 && buf[1] === 0x4b; // 'PK'
  } catch { return false; }
}

function since(t) {
  const sec = Math.floor((Date.now() - t) / 1000);
  if (sec < 60) return sec + 's';
  const m = Math.floor(sec / 60);
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h' + (m % 60) + 'm';
}
function stripTs(line) { return String(line).replace(/^\[[^\]]*\]\s*/, ''); }
function fmtDownloads(n) {
  if (!n) return '0 dl';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M dl';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K dl';
  return n + ' dl';
}
function truncate(str, n) { str = String(str); return str.length > n ? str.slice(0, n - 1) + '…' : str; }

function center(s, x, w, y, str, style) {
  const tx = x + Math.max(0, Math.floor((w - visibleLen(str)) / 2));
  s.ansiText(tx, y, str, style, w);
}
function visibleLen(str) { return String(str).replace(/\x1b\[[0-9;]*m/g, '').length; }

function isBinary(buf) {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// Hard-wrap an ANSI string to a visible width, carrying the active SGR style
// across wrap boundaries so colors don't bleed.
function wrap(str, width) {
  if (width < 1) return [str];
  const out = [];
  let row = '', visible = 0, active = '';
  const s = String(str);
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\x1b') {
      if (s[i + 1] === '[') {
        let j = i + 2;
        while (j < s.length && j < i + 32 && !/[A-Za-z]/.test(s[j])) j++;
        const final = s[j];
        const code = s.slice(i, j + 1);
        if (final === 'm') {
          row += code;
          if (/\x1b\[0?m/.test(code)) active = '';
          else active += code;
        }
        i = j + 1;
      } else {
        i++; // bare ESC — skip
      }
      continue;
    }
    row += s[i]; visible++; i++;
    if (visible >= width) { out.push(row); row = active; visible = 0; }
  }
  if (visible > 0 || out.length === 0) out.push(row);
  return out;
}

module.exports = { App };
