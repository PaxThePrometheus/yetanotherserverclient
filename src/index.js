#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Screen, Input, C } = require('./terminal');
const { launcher } = require('./launcher');
const { App } = require('./app');
const { MinecraftServer } = require('./server');
const { detectJava } = require('./java');
const { providers, download } = require('./providers');
const props = require('./properties');
const { loadConfig, rememberServer, SERVERS_DIR, CACHE_DIR } = require('./config');
const log = require('./logger');

async function main() {
  const logPath = log.init();
  log.info('=== yasc session start ===');
  log.info('runtime', { node: process.version, platform: `${os.platform()} ${os.release()}` });
  const stopCapture = log.captureConsole();

  if (!process.stdout.isTTY) {
    stopCapture();
    console.error('yasc needs an interactive terminal (TTY).');
    process.exit(1);
  }

  const screen = new Screen();
  const input = new Input();
  screen.enterAlt();
  screen.hideCursor();
  input.start();

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    try { input.stop(); } catch {}
    try { screen.showCursor(); } catch {}
    try { screen.leaveAlt(); } catch {}
    try { stopCapture(); } catch {}
  };
  process.on('exit', () => { log.info('=== yasc session end ==='); restore(); });
  process.on('uncaughtException', (e) => {
    log.error('uncaughtException', e);
    restore();
    console.error('\n' + C.red + 'yasc crashed:' + C.reset + ' ' + (e && e.message));
    console.error(C.faint + 'A full log was written to:' + C.reset + ' ' + logPath);
    process.exit(1);
  });
  process.on('unhandledRejection', (r) => log.error('unhandledRejection', r instanceof Error ? r : String(r)));

  const java = await detectJava();
  if (!java.ok) {
    log.warn('java not found on PATH', java.raw);
  } else {
    log.info('java detected', { version: java.version, major: java.major });
  }

  // Outer loop: pick/create a server, run the panel, and come back here when the
  // user chooses "Back to server list" — only a real quit breaks out.
  while (true) {
    let record = null;
    while (!record) {
      const cfg = loadConfig();
      const result = await launcher(screen, input, { cfg, java });
      if (!result) return shutdown(restore);

      if (result.action === 'open' || result.action === 'import') {
        record = result.record;
        if (!record.java && java.ok) record.java = java.bin;
        if (!fs.existsSync(path.join(record.dir, record.jar))) {
          await showError(screen, input, 'Jar not found',
            `${record.jar} is missing in\n${record.dir}\n\nThe folder may have moved. Re-import it.`);
          record = null;
          continue;
        }
        rememberServer(record);
      } else if (result.action === 'new') {
        try {
          record = await createServer(result.plan, screen, input, java);
          rememberServer(record);
        } catch (e) {
          log.error('create server failed', e);
          await showError(screen, input, 'Setup failed', (e.message || String(e)) +
            '\n\nCheck your internet connection and try again.');
          record = null;
        }
      }
    }

    log.event('opening server', { name: record.name, dir: record.dir, type: record.type, version: record.version });

    const server = new MinecraftServer(record);
    const app = new App(screen, input, server, { java });
    const outcome = await app.start();
    if (!outcome || outcome.next === 'quit') return shutdown(restore);
    // outcome.next === 'back' → loop back to the launcher
  }
}

function shutdown(restore) {
  restore();
  process.stdout.write('\n' + C.grass + 'yasc · panel closed' + C.reset + '\n');
  const lp = log.getPath();
  if (lp) process.stdout.write(C.faint + 'panel log: ' + lp + C.reset + '\n');
  process.exit(0);
}

// Create a brand-new server: make the dir, download the chosen jar with a
// progress bar, accept the EULA, and lay down a default server.properties.
async function createServer(plan, screen, input, java) {
  fs.mkdirSync(plan.dir, { recursive: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const provider = providers[plan.provider];
  if (!provider) throw new Error('unknown server flavor: ' + plan.provider);

  drawProgress(screen, plan, 'Resolving download…', 0, 0);
  const { url, filename } = await provider.resolve(plan.version);
  log.event('download', { url, filename });

  const dest = path.join(plan.dir, filename);
  await download(url, dest, (got, total) => drawProgress(screen, plan, 'Downloading ' + filename, got, total));
  drawProgress(screen, plan, 'Finishing up…', 1, 1);

  // EULA + default properties so the very first start actually runs.
  if (plan.eula) fs.writeFileSync(path.join(plan.dir, 'eula.txt'),
    '#Accepted via yasc — https://aka.ms/MinecraftEULA\neula=true\n');
  const propPath = path.join(plan.dir, 'server.properties');
  if (!fs.existsSync(propPath)) {
    fs.writeFileSync(propPath, props.defaults({ motd: plan.name }));
  }

  return {
    name: plan.name, dir: plan.dir, jar: filename,
    type: plan.type, version: plan.version, ram: plan.ram,
    java: java.ok ? java.bin : 'java',
  };
}

// A centered progress box drawn straight to the screen buffer.
function drawProgress(screen, plan, label, got, total) {
  screen.clear();
  const W = screen.width, H = screen.height;
  const w = Math.min(64, W - 4), h = 9;
  const x = Math.floor((W - w) / 2), y = Math.floor((H - h) / 2);
  screen.box(x, y, w, h, { style: C.borderHot, title: 'Creating server', titleStyle: C.title + C.bold });
  screen.text(x + 2, y + 2, `${cap(plan.provider)} ${plan.version}  ·  ${plan.name}`, C.cyan, w - 4);
  screen.text(x + 2, y + 4, label, C.text, w - 4);

  const barW = w - 6;
  const pct = total > 0 ? Math.min(1, got / total) : (got > 0 ? 1 : 0);
  const fill = Math.round(barW * pct);
  let bar = '';
  for (let i = 0; i < barW; i++) bar += i < fill ? '█' : '░';
  screen.text(x + 3, y + 6, bar, C.grass);
  const right = total > 0 ? `${fmtMB(got)} / ${fmtMB(total)}  ${Math.round(pct * 100)}%`
    : (got > 0 ? `${fmtMB(got)}` : '');
  if (right) screen.text(x + w - right.length - 2, y + 7, right, C.faint);
  screen.hideCursor();
  screen.render();
}

function showError(screen, input, title, body) {
  return new Promise((resolve) => {
    function draw() {
      screen.clear();
      const W = screen.width, H = screen.height;
      const lines = String(body).split('\n');
      const w = Math.min(66, W - 4), h = lines.length + 6;
      const x = Math.floor((W - w) / 2), y = Math.floor((H - h) / 2);
      screen.box(x, y, w, h, { style: C.red, title, titleStyle: C.red + C.bold });
      lines.forEach((l, i) => screen.text(x + 2, y + 2 + i, l, C.text, w - 4));
      screen.text(x + 2, y + h - 2, 'Press Enter to continue…', C.faint);
      screen.hideCursor();
      screen.render();
    }
    function onKey(k) {
      if (k.name === 'enter' || k.name === 'escape') { input.removeListener('key', onKey); resolve(); }
      if (k.name === 'C-c') { input.removeListener('key', onKey); resolve(); }
    }
    input.on('key', onKey);
    draw();
  });
}

function fmtMB(b) {
  if (!b) return '0';
  if (b >= 1048576) return (b / 1048576).toFixed(1) + 'MB';
  if (b >= 1024) return (b / 1024).toFixed(0) + 'KB';
  return b + 'B';
}
function cap(s) { return String(s).charAt(0).toUpperCase() + String(s).slice(1); }

main();
