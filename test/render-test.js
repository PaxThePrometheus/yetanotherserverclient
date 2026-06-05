'use strict';

/*
 * render-test.js — offline smoke test for the panel's layout.
 *
 * No server, no Java, no TTY required. It builds a fake-but-populated server
 * directory, drives the App renderer through every view + overlay at a few
 * terminal sizes, and fails loudly if any draw throws. Run with:
 *
 *   node test/render-test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Screen } = require('../src/terminal');
const { MinecraftServer, STATUS } = require('../src/server');
const { App } = require('../src/app');
const props = require('../src/properties');

// ---- a fake server directory ----------------------------------------------
const dir = path.join(os.tmpdir(), 'yasc-render-test');
fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
fs.writeFileSync(path.join(dir, 'server.properties'), props.defaults({ motd: 'Render test' }));
fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
fs.writeFileSync(path.join(dir, 'config.yml'), 'settings:\n  enabled: true\n  name: test\n');
fs.writeFileSync(path.join(dir, 'plugins', 'EssentialsX.jar'), 'x'.repeat(2048));
fs.writeFileSync(path.join(dir, 'plugins', 'WorldEdit.jar.disabled'), 'x'.repeat(4096));

const record = {
  name: 'Render Test', dir, jar: 'paper-1.21.11-69.jar',
  type: 'paper', version: '1.21.11', ram: 2048, java: 'java',
};

// ---- offscreen screen + stub input ----------------------------------------
function makeScreen(w, h) {
  const s = new Screen();
  s.out = { columns: w, rows: h, write() {} };
  s.width = w; s.height = h;
  s._alloc();
  return s;
}
const input = { on() {}, removeListener() {}, emit() {} };

// ---- build a populated app -------------------------------------------------
function makeApp(w, h) {
  const server = new MinecraftServer(record);
  server.status = STATUS.RUNNING;
  server.startedAt = Date.now() - 3725 * 1000;
  server.maxPlayers = 20;
  server.players.set('Notch', { joinedAt: Date.now() - 600000 });
  server.players.set('jeb_', { joinedAt: Date.now() - 60000 });
  server.pushLine('[12:00:00] [Server thread/INFO]: Done (5.231s)! For help, type "help"', 'info');
  server.pushLine('[12:00:05] [Server thread/INFO]: Notch joined the game', 'info');
  server.pushLine('> say hello everyone', 'cmd');
  server.pushLine('[12:00:10] [Server thread/WARN]: Can\'t keep up! Is the server overloaded?', 'warn');
  server.pushLine('[12:00:11] [Server thread/ERROR]: java.lang.NullPointerException', 'error');

  server.metrics = { tps: 19.8, tps5: 20, tps15: 20, mspt: 6.4, worldMB: 184.2, content: 4 };
  const app = new App(makeScreen(w, h), input, server, { java: { version: '25.0.3', bin: 'java' } });
  app.perf = { rssMB: 1340, cpu: 42, memUsed: 9200, memTotal: 16000, load: 1.23 };
  app.refreshFiles();
  app.refreshPlugins();
  app.loadProps();
  return app;
}

// A proxy-flavor app to exercise the no-EULA / no-TPS / proxy code paths.
function makeProxyApp(w, h) {
  const prec = { name: 'Hub Proxy', dir, jar: 'velocity.jar', type: 'velocity', version: '3.4.0', ram: 1024, java: 'java', category: 'proxy', kind: 'plugins', eula: false, nogui: false };
  const server = new MinecraftServer(prec);
  server.status = STATUS.RUNNING; server.startedAt = Date.now() - 90000;
  const app = new App(makeScreen(w, h), input, server, { java: { version: '25.0.3', bin: 'java' } });
  app.perf = { rssMB: 220, cpu: 3, memUsed: 9200, memTotal: 16000, load: 0.4 };
  app.refreshPlugins();
  return app;
}

// ---- exercise everything ---------------------------------------------------
const sizes = [[120, 40], [90, 30], [80, 24], [70, 20]];
const views = ['console', 'players', 'properties', 'files', 'plugins', 'network', 'server'];
let count = 0, fail = 0;

function tryDraw(label, fn) {
  count++;
  try { fn(); }
  catch (e) { fail++; console.error('FAIL', label, '\n ', e.stack || e.message); }
}

for (const [w, h] of sizes) {
  for (const v of views) {
    tryDraw(`${w}x${h} ${v}`, () => { const a = makeApp(w, h); a.view = v; a._draw(); });
    tryDraw(`${w}x${h} proxy ${v}`, () => { const a = makeProxyApp(w, h); a.view = v; a._draw(); });
  }
  // console scrolled up (scrollbar + stable-scroll path)
  tryDraw(`${w}x${h} console-scrolled`, () => {
    const a = makeApp(w, h);
    for (let i = 0; i < 60; i++) a.server.pushLine(`[12:0${i % 6}:00] [INFO]: log line number ${i} with some length to wrap nicely`, 'info');
    a.view = 'console'; a.cScroll = 8; a._draw();
  });
  // overlays + sub-states on the default size
  tryDraw(`${w}x${h} overlay:eula`, () => { const a = makeApp(w, h); a.overlay = { type: 'eula' }; a._draw(); });
  tryDraw(`${w}x${h} overlay:quit`, () => { const a = makeApp(w, h); a.overlay = { type: 'quit' }; a._draw(); });
  tryDraw(`${w}x${h} overlay:stopped`, () => { const a = makeApp(w, h); a.overlay = { type: 'stopped', crashed: false }; a._draw(); });
  tryDraw(`${w}x${h} overlay:crashed`, () => { const a = makeApp(w, h); a.overlay = { type: 'stopped', crashed: true }; a._draw(); });
  tryDraw(`${w}x${h} overlay:stopping`, () => { const a = makeApp(w, h); a.overlay = { type: 'stopping', next: 'back' }; a._draw(); });
  const libs = require('../src/libraries').librariesFor('paper');
  const libBase = { type: 'library', libs, libIdx: 0, query: 'world', focus: 'query', loading: false, error: '', results: [], sel: 0, scroll: 0, installing: false, msg: '', versionFiltered: true };
  tryDraw(`${w}x${h} library:loading`, () => { const a = makeApp(w, h); a.overlay = { ...libBase, loading: true }; a._draw(); });
  tryDraw(`${w}x${h} library:results`, () => {
    const a = makeApp(w, h);
    a.overlay = { ...libBase, focus: 'results', sel: 1,
      results: [
        { id: 'worldedit', title: 'WorldEdit', author: 'sk89q', downloads: 7818388, description: 'In-game map editor' },
        { id: 'essentialsx', title: 'EssentialsX', author: 'EssentialsX', downloads: 12500000, description: 'The essential commands plugin' },
      ] };
    a._draw();
  });
  tryDraw(`${w}x${h} library:installing`, () => { const a = makeApp(w, h); a.overlay = { ...libBase, libIdx: 1, focus: 'results', results: [{ id: 'x', title: 'X', downloads: 5, description: 'd' }], installing: true, msg: 'Downloading X.jar…', versionFiltered: false }; a._draw(); });
  // network view states
  for (const sel of [0, 1, 2, 3]) {
    tryDraw(`${w}x${h} network:sel${sel}`, () => {
      const a = makeApp(w, h); a.view = 'network';
      a.net.sel = sel; a.net.publicIP = '203.0.113.7'; a.net.publicIPState = 'ok';
      a.net.localIPs = [{ iface: 'eth0', address: '192.168.1.42' }];
      a._draw();
    });
  }
  tryDraw(`${w}x${h} network:tunnel-online`, () => {
    const a = makeApp(w, h); a.view = 'network'; a.net.sel = 3;
    a.tunnel.providerId = 'playit'; a.tunnel.provider = require('../src/tunnels').TUNNELS[0];
    a.tunnel.status = 'online'; a.tunnel.address = 'something.craft.ply.gg:25565';
    a.tunnel.authUrl = 'https://playit.gg/claim/abc123';
    a.tunnel.lines = ['· starting playit.gg…', 'tunnel ready', 'something.craft.ply.gg'];
    a._draw();
  });
  tryDraw(`${w}x${h} network:upnp-ok`, () => {
    const a = makeApp(w, h); a.view = 'network'; a.net.sel = 2;
    a.net.upnp = { state: 'ok', msg: 'forwarded TCP 25565 → 192.168.1.42', externalIP: '203.0.113.7' };
    a._draw();
  });
  tryDraw(`${w}x${h} overlay:player`, () => { const a = makeApp(w, h); a.view = 'players'; a.overlay = { type: 'player', player: 'Notch', sel: 1 }; a._draw(); });
  tryDraw(`${w}x${h} props-edit`, () => { const a = makeApp(w, h); a.view = 'properties'; a.prop.editing = { key: 'motd', buf: 'edited' }; a._draw(); });
  tryDraw(`${w}x${h} file-viewer`, () => {
    const a = makeApp(w, h); a.view = 'files';
    a.openEntry({ name: 'config.yml', dir: false });
    a.files.viewer.editing = { idx: 1, buf: '  enabled: false' };
    a._draw();
  });

  // Hostile console output (carriage returns, cursor-move escapes, OSC, bare
  // ESC, tabs, long stack-trace lines) must never leave a control character in
  // a cell or a non-SGR escape in a style — that's what corrupts real terminals.
  tryDraw(`${w}x${h} dirty-console`, () => {
    const a = makeApp(w, h);
    const nasty = [
      '[06:46:33 INFO]: \x1b[0;32;1mDone (8.458s)!\x1b[m For help, type "help"',
      '[06:46:33 INFO]: at a.b.C.d(MinecraftServer.java:378) \x1b[0;30;22m~[paper-1.21.8.jar:?]\x1b[m',
      'progress\rOVERWRITE\x1b[2K mid-line erase \x1b[10;5H cursor move',
      '\x1b]0;title\x07 osc then text',
      'tabs\there\tand\tthere',
      'bare ESC \x1b alone and \x1b[?25l hide-cursor',
    ];
    for (const l of nasty) a.server.ingest(l);
    a.view = 'console'; a._draw();
    assertCleanBuffer(a, `${w}x${h} dirty-console`);
  });

  // Files view tooltip must not leak a literal SGR code (e.g. "[38;2;80;90;86m").
  tryDraw(`${w}x${h} files-tooltip`, () => {
    const a = makeApp(w, h); a.view = 'files'; a._draw();
    assertNoLiteralSGR(a.screen, `${w}x${h} files-tooltip`);
  });
}

// Launcher home/footer tooltips must not leak literal color codes either.
tryDraw('launcher-home tooltip', () => {
  const { launcher } = require('../src/launcher');
  const sc = makeScreen(100, 30);
  const input = new (require('events').EventEmitter)();
  input.stop = () => {};
  launcher(sc, input, { cfg: { servers: [{ name: 'S', dir: 'x', jar: 'j', type: 'paper', version: '1.21.8', ram: 2048 }] }, java: { ok: true } });
  assertNoLiteralSGR(sc, 'launcher-home'); // first draw is synchronous
  input.emit('key', { name: 'C-c' });      // resolve + detach the wizard
});

function assertCleanBuffer(a, label) {
  for (let i = 0; i < a.screen.buf.length; i++) {
    const cp = a.screen.buf[i].ch.codePointAt(0);
    if (cp < 32 || cp === 127) { fail++; console.error('FAIL', label, 'control char in cell', i, 'cp=' + cp); return; }
    const st = a.screen.buf[i].style;
    if (st && /\x1b(?!\[[0-9;]*m)/.test(st)) { fail++; console.error('FAIL', label, 'non-SGR escape in style at', i); return; }
  }
}

// Scan rendered rows for a literal SGR sequence body (what shows when an ESC was
// baked into a string and then blanked) — e.g. "[38;2;80;90;86m" or "[0m".
function assertNoLiteralSGR(scr, label) {
  const w = scr.width;
  for (let y = 0; y < scr.height; y++) {
    let row = '';
    for (let x = 0; x < w; x++) row += scr.buf[y * w + x].ch;
    if (/\[\d{1,3}(;\d{1,3})*m/.test(row)) {
      fail++; console.error('FAIL', label, 'literal SGR in row', y + ':', row.trim().slice(0, 70));
      return;
    }
  }
}

console.log(`\nrender-test: ${count - fail}/${count} draws ok` + (fail ? `, ${fail} FAILED` : ' ✓'));
process.exit(fail ? 1 : 0);
