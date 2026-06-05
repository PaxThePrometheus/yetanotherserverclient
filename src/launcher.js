'use strict';

const fs = require('fs');
const path = require('path');
const { C } = require('./terminal');
const { PROVIDER_LIST, metaFor } = require('./providers');
const { SERVERS_DIR } = require('./config');
const { fmtRam, parseRam } = require('./java');

/*
 * launcher.js — the startup wizard.
 *
 * Home screen lists your known servers and two actions: create a new one
 * (pick a flavor + version, downloaded for you) or import an existing folder
 * that already contains a server jar. Resolves with one of:
 *
 *   { action: 'open',   record }     open a known/imported server
 *   { action: 'import', record }     import a folder, then open it
 *   { action: 'new',    plan }       create + download, then open it
 *   null                             user quit
 */

const LOGO = [
  '╦ ╦╔═╗╔═╗╔═╗',
  '╚╦╝╠═╣╚═╗║  ',
  ' ╩ ╩ ╩╚═╝╚═╝',
];

function launcher(screen, input, ctx = {}) {
  return new Promise((resolve) => {
    const cfg = ctx.cfg || { servers: [] };
    const state = {
      view: 'home',           // home | import | new
      error: '',
      info: '',
      // home
      homeSel: 0,
      // import
      importStep: 'path',     // path | details
      pathStr: process.cwd(),
      pathSug: [],            // spotlight folder suggestions
      sugSel: -1,             // -1 = editing the field; >=0 = a suggestion
      jars: [],
      jarSel: 0,
      impName: '',
      impRam: '2G',
      impField: 'name',       // name | ram
      // new
      newStep: 'type',        // type | version | details | eula
      typeSel: 0,
      typeScroll: 0,
      verCache: {},           // providerId -> { loading, list, error }
      verSel: 0,
      verScroll: 0,
      verFilter: '',
      newName: '',
      newRam: '2G',
      detailField: 'name',    // name | ram
      eulaAccept: false,
    };

    // ---- home items --------------------------------------------------------
    function homeItems() {
      const items = cfg.servers.map((s) => ({ kind: 'server', record: s }));
      items.push({ kind: 'new' });
      items.push({ kind: 'import' });
      return items;
    }

    // ---- drawing -----------------------------------------------------------
    function draw() {
      screen.clear();
      let caret = null;
      const W = screen.width, H = screen.height;
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++)
          if ((x % 4 === 0) && (y % 2 === 0)) screen.put(x, y, '·', C.faint);

      const pw = Math.min(70, W - 4);
      const ph = Math.min(26, H - 2);
      const px = Math.floor((W - pw) / 2);
      const py = Math.max(0, Math.floor((H - ph) / 2));
      screen.fillRect(px, py, pw, ph, ' ', '');
      screen.box(px, py, pw, ph, {
        style: C.borderHot, title: 'Yet Another Server Client', titleStyle: C.title + C.bold,
      });
      LOGO.forEach((line, i) => {
        const lx = px + Math.floor((pw - 12) / 2);
        screen.text(lx, py + 1 + i, line, C.grass + C.bold);
      });

      const bodyX = px + 3, bodyY = py + 5, bodyW = pw - 6;
      if (state.view === 'home') caret = drawHome(bodyX, bodyY, bodyW, py + ph);
      else if (state.view === 'import') caret = drawImport(bodyX, bodyY, bodyW, py + ph);
      else if (state.view === 'new') caret = drawNew(bodyX, bodyY, bodyW, py + ph);

      const footerY = py + ph - 2;
      const msg = state.error || state.info || footerHint();
      const msgStyle = state.error ? C.red : state.info ? C.cyan : C.faint;
      screen.text(px + 2, footerY, ' ' + msg + ' ', msgStyle);

      if (caret) { screen.showCursor(); screen.render(); screen.placeCursor(caret.x, caret.y); }
      else { screen.hideCursor(); screen.render(); }
    }

    function footerHint() {
      if (state.view === 'home') return '↑↓ select · Enter open · Ctrl+C quit';
      if (state.view === 'import') return 'Enter next · Esc back · Ctrl+C quit';
      return '↑↓/←→ choose · Enter next · Esc back · Ctrl+C quit';
    }

    function drawHome(x, y, w, bottom) {
      screen.text(x, y, 'Choose a server, or set one up:', C.text);
      const items = homeItems();
      const rows = bottom - (y + 2) - 2;
      let yy = y + 2;
      for (let i = 0; i < items.length && i < rows; i++) {
        const it = items[i];
        const sel = i === state.homeSel;
        const style = sel ? C.selFg + C.bold : C.text;
        if (sel) screen.fillRect(x - 1, yy, w + 2, 1, ' ', C.selBg);
        if (it.kind === 'server') {
          const r = it.record;
          const tag = `${r.type || '?'} ${r.version || ''}`.trim();
          screen.text(x + 1, yy, (sel ? '▸ ' : '  ') + r.name, style);
          screen.text(x + w - tag.length - 1, yy, tag, sel ? C.selFg : C.muted);
        } else if (it.kind === 'new') {
          screen.text(x + 1, yy, (sel ? '▸ ' : '  ') + '＋ Create a new server', sel ? C.selFg + C.bold : C.green);
        } else {
          screen.text(x + 1, yy, (sel ? '▸ ' : '  ') + '⮈ Import an existing folder', sel ? C.selFg + C.bold : C.cyan);
        }
        yy++;
      }
      if (!cfg.servers.length) {
        screen.text(x + 1, yy + 1, 'No saved servers yet — create or import one to begin.', C.faint);
      }
      return null;
    }

    function drawImport(x, y, w, bottom) {
      screen.text(x, y, 'Import an existing server', C.title + C.bold);
      let caret = null;
      if (state.importStep === 'path') {
        const editing = state.sugSel < 0;
        const c = field(x, y + 2, w, 'Folder', state.pathStr, editing,
          'start typing a path — folders with a server jar are flagged');
        if (editing) caret = c;
        // spotlight suggestions
        const listY = y + 6;
        const rows = Math.max(3, bottom - listY - 2);
        if (!state.pathSug.length) {
          screen.text(x, listY, 'No matching folders here.', C.faint);
        } else {
          for (let i = 0; i < rows && i < state.pathSug.length; i++) {
            const sug = state.pathSug[i];
            const sel = i === state.sugSel;
            const yy = listY + i;
            if (sel) screen.fillRect(x, yy, w, 1, ' ', C.selBg);
            const m = sug.mark; // 'server' | 'jar' | 'none'
            const icon = m === 'server' ? '●' : m === 'jar' ? '◆' : '·';
            const iconStyle = m === 'server' ? C.green : m === 'jar' ? C.cyan : C.faint;
            const tag = m === 'server' ? 'server' : m === 'jar' ? 'has .jar' : '';
            screen.text(x + 1, yy, icon, sel ? C.selFg : iconStyle);
            screen.text(x + 3, yy, sug.name, sel ? C.selFg + C.bold : (m === 'none' ? C.muted : C.text), w - 14);
            if (tag) screen.text(x + w - tag.length - 1, yy, tag, sel ? C.selFg : iconStyle);
          }
        }
        screen.text(x, bottom - 1, '↑↓ pick · Tab open folder · Enter import · Esc back', C.faint, w);
      } else {
        screen.text(x, y + 2, 'Server jar', C.muted);
        const listH = Math.min(6, state.jars.length);
        for (let i = 0; i < listH; i++) {
          const sel = i === state.jarSel;
          if (sel) screen.fillRect(x, y + 3 + i, w, 1, ' ', C.selBg);
          screen.text(x + 1, y + 3 + i, (sel ? '▸ ' : '  ') + state.jars[i],
            sel ? C.selFg + C.bold : C.text, w - 2);
        }
        const fY = y + 4 + listH;
        const nameC = field(x, fY, Math.floor(w / 2) - 1, 'Name', state.impName,
          state.impField === 'name', 'display name');
        const ramC = field(x + Math.floor(w / 2) + 1, fY, Math.floor(w / 2) - 1, 'RAM',
          state.impRam, state.impField === 'ram', 'e.g. 2G');
        caret = state.impField === 'name' ? nameC : ramC;
        screen.text(x, fY + 4, 'Tab switches jar/name/RAM · Enter imports.', C.faint);
      }
      return caret;
    }

    function drawNew(x, y, w, bottom) {
      screen.text(x, y, 'Create a new server', C.title + C.bold);
      // Step rail
      const steps = ['Flavor', 'Version', 'Details', 'EULA'];
      const curIdx = ['type', 'version', 'details', 'eula'].indexOf(state.newStep);
      let rx = x;
      steps.forEach((s, i) => {
        const on = i === curIdx, done = i < curIdx;
        const st = on ? C.borderHot + C.bold : done ? C.green : C.faint;
        screen.text(rx, y + 1, (done ? '✓ ' : (i + 1) + '·') + s, st);
        rx += s.length + 4;
      });

      let caret = null;
      const cy = y + 3;
      if (state.newStep === 'type') {
        screen.text(x, cy, 'Server flavor', C.muted);
        const rows = Math.max(4, bottom - (cy + 1) - 2);
        if (state.typeSel < state.typeScroll) state.typeScroll = state.typeSel;
        if (state.typeSel >= state.typeScroll + rows) state.typeScroll = state.typeSel - rows + 1;
        for (let i = 0; i < rows && i + state.typeScroll < PROVIDER_LIST.length; i++) {
          const idx = i + state.typeScroll;
          const p = PROVIDER_LIST[idx];
          const sel = idx === state.typeSel;
          const yy = cy + 1 + i;
          if (sel) screen.fillRect(x, yy, w, 1, ' ', C.selBg);
          screen.text(x + 1, yy, (sel ? '▸ ' : '  ') + p.name, sel ? C.selFg + C.bold : C.text, 11);
          screen.text(x + 13, yy, p.blurb || '', sel ? C.selFg : C.faint, w - 26);
          const tag = catTag(p.category);
          screen.text(x + w - tag.length - 1, yy, tag, sel ? C.selFg : C.faint);
        }
        screen.text(x, bottom - 2, `${PROVIDER_LIST.length} flavors · ↑↓ select · ${PROVIDER_LIST[state.typeSel].name}`, C.faint, w);
      } else if (state.newStep === 'version') {
        const prov = PROVIDER_LIST[state.typeSel];
        const cache = state.verCache[prov.id] || { loading: true };
        // a visible search field (always — type to filter the version list live)
        const sw = Math.min(40, w);
        const sc = field(x, cy, sw, `Search ${prov.name} version`, state.verFilter, true,
          'type to filter, e.g. 1.21  ·  blank = newest');
        caret = sc;
        const listY = cy + 4;
        if (cache.loading) {
          screen.text(x + 1, listY, '◠ fetching available versions…', C.gold);
        } else if (cache.error) {
          screen.text(x + 1, listY, 'Could not fetch versions: ' + cache.error, C.red, w - 2);
          screen.text(x + 1, listY + 1, 'Type a version above and press Enter to use it anyway.', C.faint, w - 2);
        } else {
          const list = filteredVersions(cache.list);
          const rows = Math.max(3, Math.min(bottom - listY - 2, 12));
          if (state.verSel >= list.length) state.verSel = Math.max(0, list.length - 1);
          if (state.verSel < state.verScroll) state.verScroll = state.verSel;
          if (state.verSel >= state.verScroll + rows) state.verScroll = state.verSel - rows + 1;
          if (!list.length) {
            screen.text(x + 1, listY, `No version matches “${state.verFilter}”.`, C.faint, w - 2);
          }
          for (let i = 0; i < rows && i + state.verScroll < list.length; i++) {
            const idx = i + state.verScroll;
            const sel = idx === state.verSel;
            if (sel) screen.fillRect(x, listY + i, 28, 1, ' ', C.selBg);
            const latest = idx === 0 && !state.verFilter ? '  (latest)' : '';
            screen.text(x + 1, listY + i, (sel ? '▸ ' : '  ') + list[idx] + latest,
              sel ? C.selFg + C.bold : C.text, 28);
          }
          screen.text(x, bottom - 1, `${list.length}/${cache.list.length} versions · ↑↓ select · Enter to choose`, C.faint, w);
        }
      } else if (state.newStep === 'details') {
        const nameC = field(x, cy, w, 'Server name', state.newName,
          state.detailField === 'name', 'folder will be created under ~/.yasc/servers');
        const ramC = field(x, cy + 4, Math.floor(w / 2), 'Memory (RAM)', state.newRam,
          state.detailField === 'ram', 'e.g. 2G or 4096M');
        caret = state.detailField === 'name' ? nameC : ramC;
        const dir = path.join(SERVERS_DIR, sanitize(state.newName) || 'server');
        screen.text(x, cy + 8, 'Location: ' + dir, C.faint, w);
      } else if (state.newStep === 'eula') {
        const prov = PROVIDER_LIST[state.typeSel];
        screen.text(x, cy, 'Review', C.muted);
        screen.text(x + 1, cy + 1, `${prov.name} ${chosenVersion()}  ·  ${state.newName}  ·  ${fmtRam(parseRam(state.newRam))}`, C.text);
        if (prov.install) screen.text(x + 1, cy + 2, '⚠ uses an installer — first launch sets up after download', C.gold, w - 2);
        if (prov.eula === false) {
          screen.text(x, cy + 4, 'Ready', C.muted);
          screen.text(x + 1, cy + 5, 'This flavor needs no Minecraft EULA.', C.text);
          screen.text(x + 1, cy + 7, 'Enter to create & download.', C.faint);
        } else {
          screen.text(x, cy + 4, 'Minecraft EULA', C.muted);
          screen.text(x + 1, cy + 5, 'You must accept the Mojang EULA to run a server:', C.text);
          screen.text(x + 1, cy + 6, 'https://aka.ms/MinecraftEULA', C.cyan);
          const on = state.eulaAccept;
          screen.text(x + 1, cy + 8, `[${on ? '✓' : ' '}] I accept the Minecraft EULA`, on ? C.green + C.bold : C.gold);
          screen.text(x + 1, cy + 9, 'Space/←→ toggle · Enter to create & download.', C.faint);
        }
      }
      return caret;
    }

    // ---- helpers -----------------------------------------------------------
    function field(x, y, w, label, value, active, hint) {
      const labelStyle = active ? C.borderHot + C.bold : C.muted;
      screen.text(x, y, label, labelStyle);
      screen.box(x, y + 1, w, 3, { style: active ? C.borderHot : C.border });
      if (value) screen.text(x + 2, y + 2, value, C.white, w - 4);
      else if (hint) screen.text(x + 2, y + 2, hint, C.faint, w - 4);
      return active ? { x: x + 2 + value.length, y: y + 2 } : null;
    }

    function filteredVersions(list) {
      if (!state.verFilter) return list;
      const f = state.verFilter.toLowerCase();
      return list.filter((v) => v.toLowerCase().includes(f));
    }

    function chosenVersion() {
      const prov = PROVIDER_LIST[state.typeSel];
      const cache = state.verCache[prov.id];
      if (cache && cache.list && !cache.error) {
        const list = filteredVersions(cache.list);
        return list[state.verSel] || state.verFilter || '?';
      }
      return state.verFilter || '?';
    }

    function loadVersions(prov) {
      if (state.verCache[prov.id]) return;
      state.verCache[prov.id] = { loading: true };
      prov.listVersions().then((list) => {
        state.verCache[prov.id] = { loading: false, list };
        if (state.view === 'new' && state.newStep === 'version') draw();
      }).catch((e) => {
        state.verCache[prov.id] = { loading: false, error: e.message || String(e) };
        if (state.view === 'new' && state.newStep === 'version') draw();
      });
    }

    // ---- input -------------------------------------------------------------
    function onKey(key) {
      state.error = '';
      if (key.name === 'C-c') return finish(null);
      if (state.view === 'home') return onHome(key);
      if (state.view === 'import') return onImport(key);
      if (state.view === 'new') return onNew(key);
    }

    function onHome(key) {
      const items = homeItems();
      if (key.name === 'up') { state.homeSel = (state.homeSel - 1 + items.length) % items.length; return draw(); }
      if (key.name === 'down') { state.homeSel = (state.homeSel + 1) % items.length; return draw(); }
      if (key.name === 'enter') {
        const it = items[state.homeSel];
        if (it.kind === 'server') return finish({ action: 'open', record: it.record });
        if (it.kind === 'new') { state.view = 'new'; state.newStep = 'type'; return draw(); }
        if (it.kind === 'import') { state.view = 'import'; state.importStep = 'path'; computeSuggestions(); return draw(); }
      }
    }

    function onImport(key) {
      if (key.name === 'escape') { state.view = 'home'; return draw(); }
      if (state.importStep === 'path') {
        const n = state.pathSug.length;
        if (key.name === 'down') { if (n) state.sugSel = state.sugSel < 0 ? 0 : (state.sugSel + 1) % n; return draw(); }
        if (key.name === 'up') { if (n) state.sugSel = state.sugSel <= 0 ? n - 1 : state.sugSel - 1; return draw(); }
        if (key.name === 'tab' || key.name === 'right') {
          const pick = state.sugSel >= 0 ? state.pathSug[state.sugSel] : state.pathSug[0];
          if (pick) { state.pathStr = pick.full + path.sep; computeSuggestions(); }
          return draw();
        }
        if (key.name === 'enter') {
          if (state.sugSel >= 0 && state.pathSug[state.sugSel]) state.pathStr = state.pathSug[state.sugSel].full;
          return scanFolder();
        }
        // typing edits the field and refreshes suggestions live
        if (editText(state, 'pathStr', key)) { state.sugSel = -1; computeSuggestions(); return draw(); }
        return;
      }
      // details step
      if (key.name === 'tab') {
        // jar is picked with up/down; Tab toggles the name / RAM fields.
        state.impField = state.impField === 'name' ? 'ram' : 'name';
        return draw();
      }
      if (key.name === 'up') { state.jarSel = (state.jarSel - 1 + state.jars.length) % state.jars.length; return draw(); }
      if (key.name === 'down') { state.jarSel = (state.jarSel + 1) % state.jars.length; return draw(); }
      if (key.name === 'enter') return doImport();
      const k = state.impField === 'name' ? 'impName' : 'impRam';
      return editText(state, k, key) && draw();
    }

    // Spotlight: list directories under the typed path and flag the ones that
    // look like a Minecraft server (contain a .jar, ideally with server files).
    function computeSuggestions() {
      const raw = state.pathStr;
      let base, partial;
      const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
      if (raw && (isDir(raw) || /[\\/]$/.test(raw))) {
        base = raw; partial = '';               // a complete folder → list its children
      } else if (raw) {
        base = path.dirname(raw); partial = path.basename(raw); // mid-typing → filter siblings
      } else {
        base = process.cwd(); partial = '';
      }
      let names = [];
      try {
        names = fs.readdirSync(base, { withFileTypes: true })
          .filter((d) => { try { return d.isDirectory(); } catch { return false; } })
          .map((d) => d.name);
      } catch { names = []; }
      const pl = partial.toLowerCase();
      const cand = names.filter((n) => n.toLowerCase().startsWith(pl)).sort((a, b) => a.localeCompare(b)).slice(0, 24);
      const sug = cand.map((name) => {
        const full = path.join(base, name);
        return { name, full, mark: folderMark(full) };
      });
      sug.sort((a, b) => (markRank(b.mark) - markRank(a.mark)) || a.name.localeCompare(b.name));
      state.pathSug = sug.slice(0, 12);
      if (state.sugSel >= state.pathSug.length) state.sugSel = -1;
    }

    function scanFolder() {
      const dir = state.pathStr.trim();
      let jars = [];
      try {
        jars = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.jar'));
      } catch (e) {
        state.error = 'Cannot read folder: ' + (e.code || e.message);
        return draw();
      }
      if (!jars.length) { state.error = 'No .jar files found in that folder.'; return draw(); }
      // Put a likely server jar first.
      jars.sort((a, b) => score(b) - score(a));
      state.jars = jars;
      state.jarSel = 0;
      state.impName = path.basename(path.resolve(dir));
      state.importStep = 'details';
      state.impField = 'name';
      draw();
    }

    function doImport() {
      const dir = path.resolve(state.pathStr.trim());
      const jar = state.jars[state.jarSel];
      const name = state.impName.trim() || path.basename(dir);
      const type = detectType(jar);
      const meta = metaFor(type);
      const record = {
        name, dir, jar, type, version: detectVersion(dir, jar),
        ram: parseRam(state.impRam),
        category: meta.category, kind: meta.kind, eula: meta.eula, nogui: meta.nogui,
      };
      finish({ action: 'import', record });
    }

    function onNew(key) {
      if (key.name === 'escape') {
        if (state.newStep === 'type') { state.view = 'home'; return draw(); }
        const back = { version: 'type', details: 'version', eula: 'details' };
        state.newStep = back[state.newStep] || 'type';
        return draw();
      }
      if (state.newStep === 'type') return onNewType(key);
      if (state.newStep === 'version') return onNewVersion(key);
      if (state.newStep === 'details') return onNewDetails(key);
      if (state.newStep === 'eula') return onNewEula(key);
    }

    function onNewType(key) {
      const n = PROVIDER_LIST.length;
      if (key.name === 'up' || key.name === 'left') { state.typeSel = (state.typeSel - 1 + n) % n; return draw(); }
      if (key.name === 'down' || key.name === 'right') { state.typeSel = (state.typeSel + 1) % n; return draw(); }
      if (key.name === 'enter') {
        const prov = PROVIDER_LIST[state.typeSel];
        loadVersions(prov);
        state.newStep = 'version';
        state.verSel = 0; state.verScroll = 0; state.verFilter = '';
        return draw();
      }
    }

    function onNewVersion(key) {
      const prov = PROVIDER_LIST[state.typeSel];
      const cache = state.verCache[prov.id] || {};
      if (key.name === 'up') { state.verSel = Math.max(0, state.verSel - 1); return draw(); }
      if (key.name === 'down') { state.verSel++; return draw(); }
      if (key.name === 'pageup') { state.verSel = Math.max(0, state.verSel - 8); return draw(); }
      if (key.name === 'pagedown') { state.verSel += 8; return draw(); }
      if (key.name === 'backspace') { state.verFilter = state.verFilter.slice(0, -1); state.verSel = 0; return draw(); }
      if (key.name === 'char') { state.verFilter += key.ch; state.verSel = 0; return draw(); }
      if (key.name === 'enter') {
        const v = chosenVersion();
        if (!v || v === '?') { state.error = 'Pick or type a version.'; return draw(); }
        if (!state.newName) state.newName = defaultName(prov, v);
        state.newStep = 'details';
        state.detailField = 'name';
        return draw();
      }
    }

    function onNewDetails(key) {
      if (key.name === 'tab' || key.name === 'down' || key.name === 'up') {
        state.detailField = state.detailField === 'name' ? 'ram' : 'name';
        return draw();
      }
      if (key.name === 'enter') {
        if (!state.newName.trim()) { state.error = 'Enter a server name.'; return draw(); }
        if (parseRam(state.newRam) < 512) { state.error = 'RAM must be at least 512M.'; return draw(); }
        state.newStep = 'eula';
        return draw();
      }
      const k = state.detailField === 'name' ? 'newName' : 'newRam';
      return editText(state, k, key) && draw();
    }

    function onNewEula(key) {
      const prov = PROVIDER_LIST[state.typeSel];
      const needsEula = prov.eula !== false;
      if (needsEula && (key.name === 'char' && key.ch === ' ' || key.name === 'left' || key.name === 'right')) {
        state.eulaAccept = !state.eulaAccept;
        return draw();
      }
      if (key.name === 'enter') {
        if (needsEula && !state.eulaAccept) { state.error = 'You must accept the EULA to create a server.'; return draw(); }
        const version = chosenVersion();
        const name = state.newName.trim();
        const plan = {
          provider: prov.id, type: prov.id, version, name,
          dir: path.join(SERVERS_DIR, sanitize(name)),
          ram: parseRam(state.newRam),
          category: prov.category, kind: prov.kind,
          eula: needsEula, nogui: prov.nogui !== false, install: !!prov.install,
        };
        finish({ action: 'new', plan });
      }
    }

    function finish(result) {
      input.removeListener('key', onKey);
      screen.hideCursor();
      resolve(result);
    }

    input.on('key', onKey);
    draw();
  });
}

// ---- shared text-field editing -------------------------------------------
function editText(state, key, ev) {
  if (ev.name === 'backspace') state[key] = state[key].slice(0, -1);
  else if (ev.name === 'C-u') state[key] = '';
  else if (ev.name === 'char') state[key] += ev.ch;
  else return false;
  return true;
}

// ---- misc helpers ----------------------------------------------------------
// Classify a folder for the import spotlight: does it hold a server jar, and
// does it look like an actual server (eula/properties/world/plugins/mods)?
function folderMark(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return 'none'; }
  const hasJar = names.some((n) => /\.jar$/i.test(n));
  const serverish = names.some((n) => /^(eula\.txt|server\.properties|server\.toml|config\.yml|bukkit\.yml|world|libraries|mods|plugins|versions)$/i.test(n));
  if (hasJar) return serverish ? 'server' : 'jar';
  return serverish ? 'server' : 'none';
}
function markRank(m) { return m === 'server' ? 2 : m === 'jar' ? 1 : 0; }

function catTag(category) {
  return { vanilla: 'vanilla', servers: 'plugins', modded: 'modded', proxy: 'proxy' }[category] || category;
}

function score(jar) {
  const j = jar.toLowerCase();
  if (/paper|purpur|folia|spigot|fabric|forge|neoforge|velocity|waterfall|bungee|server\.jar|minecraft_server/.test(j)) return 2;
  if (/server/.test(j)) return 1;
  return 0;
}

function detectType(jar) {
  const j = (jar || '').toLowerCase();
  if (j.includes('folia')) return 'folia';
  if (j.includes('paper')) return 'paper';
  if (j.includes('purpur')) return 'purpur';
  if (j.includes('neoforge')) return 'neoforge';
  if (j.includes('forge')) return 'forge';
  if (j.includes('fabric')) return 'fabric';
  if (j.includes('quilt')) return 'quilt';
  if (j.includes('velocity')) return 'velocity';
  if (j.includes('waterfall')) return 'waterfall';
  if (j.includes('bungee')) return 'bungeecord';
  if (j.includes('spigot')) return 'spigot';
  if (j.includes('bukkit')) return 'craftbukkit';
  return 'vanilla';
}

function detectVersion(dir, jar) {
  // Paper/Purpur ship a version_history.json; vanilla jars carry the version
  // in their filename.
  try {
    const vh = JSON.parse(fs.readFileSync(path.join(dir, 'version_history.json'), 'utf8'));
    const m = String(vh.currentVersion || '').match(/MC:\s*([\d.]+)/);
    if (m) return m[1];
  } catch {}
  const m = (jar || '').match(/(\d+\.\d+(?:\.\d+)?)/);
  return m ? m[1] : '?';
}

function defaultName(prov, version) {
  return `${prov.name} ${version}`;
}

function sanitize(name) {
  return String(name).trim().replace(/[^A-Za-z0-9._ -]/g, '').replace(/\s+/g, '-') || 'server';
}

module.exports = { launcher, folderMark, detectType };
