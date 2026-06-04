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

  const app = new App(makeScreen(w, h), input, server, { java: { version: '25.0.3', bin: 'java' } });
  app.perf = { rssMB: 1340, cpu: 42, memUsed: 9200, memTotal: 16000, load: 1.23 };
  app.refreshFiles();
  app.refreshPlugins();
  app.loadProps();
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
  }
  // overlays + sub-states on the default size
  tryDraw(`${w}x${h} overlay:eula`, () => { const a = makeApp(w, h); a.overlay = { type: 'eula' }; a._draw(); });
  tryDraw(`${w}x${h} overlay:quit`, () => { const a = makeApp(w, h); a.overlay = { type: 'quit' }; a._draw(); });
  tryDraw(`${w}x${h} overlay:stopped`, () => { const a = makeApp(w, h); a.overlay = { type: 'stopped', crashed: false }; a._draw(); });
  tryDraw(`${w}x${h} overlay:crashed`, () => { const a = makeApp(w, h); a.overlay = { type: 'stopped', crashed: true }; a._draw(); });
  tryDraw(`${w}x${h} overlay:stopping`, () => { const a = makeApp(w, h); a.overlay = { type: 'stopping', next: 'back' }; a._draw(); });
  tryDraw(`${w}x${h} modrinth:loading`, () => { const a = makeApp(w, h); a.overlay = { type: 'modrinth', query: 'world', focus: 'query', loading: true, error: '', results: [], sel: 0, scroll: 0, installing: false, msg: '', versionFiltered: true }; a._draw(); });
  tryDraw(`${w}x${h} modrinth:results`, () => {
    const a = makeApp(w, h);
    a.overlay = { type: 'modrinth', query: 'world', focus: 'results', loading: false, error: '', sel: 1, scroll: 0, installing: false, msg: '', versionFiltered: true,
      results: [
        { slug: 'worldedit', title: 'WorldEdit', author: 'sk89q', downloads: 7818388, description: 'In-game map editor' },
        { slug: 'essentialsx', title: 'EssentialsX', author: 'EssentialsX', downloads: 12500000, description: 'The essential commands plugin' },
      ] };
    a._draw();
  });
  tryDraw(`${w}x${h} modrinth:installing`, () => { const a = makeApp(w, h); a.overlay = { type: 'modrinth', query: '', focus: 'results', loading: false, error: '', results: [{ slug: 'x', title: 'X', downloads: 5, description: 'd' }], sel: 0, scroll: 0, installing: true, msg: 'Downloading X.jar…', versionFiltered: false }; a._draw(); });
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
}

console.log(`\nrender-test: ${count - fail}/${count} draws ok` + (fail ? `, ${fail} FAILED` : ' ✓'));
process.exit(fail ? 1 : 0);
