'use strict';

/*
 * terminal.js — a tiny, zero-dependency ANSI screen renderer.
 *
 * It keeps an in-memory cell buffer and only emits the cells that actually
 * changed between frames (diff rendering). That keeps CPU + bandwidth low,
 * which is exactly what we want for a panel that sits open for hours next to a
 * running server.
 */

const ESC = '\x1b[';

// ---- Color helpers (truecolor SGR) ---------------------------------------

function fg(r, g, b) {
  return `${ESC}38;2;${r};${g};${b}m`;
}
function bg(r, g, b) {
  return `${ESC}48;2;${r};${g};${b}m`;
}

// A small, cohesive palette so the UI looks intentional.
const C = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  // Greens (Minecraft-y)
  grass: fg(106, 190, 48),
  grassDim: fg(70, 130, 40),
  // UI chrome
  border: fg(78, 110, 86),
  borderHot: fg(120, 200, 140),
  title: fg(150, 230, 170),
  text: fg(205, 214, 210),
  muted: fg(120, 132, 128),
  faint: fg(80, 90, 86),
  // Accents
  gold: fg(240, 200, 90),
  cyan: fg(110, 200, 220),
  red: fg(230, 100, 100),
  green: fg(120, 210, 120),
  blue: fg(120, 160, 240),
  white: fg(235, 240, 238),
  purple: fg(190, 140, 240),
  orange: fg(240, 160, 90),
  // Selection highlight (subtle dark-green plate)
  selBg: bg(40, 66, 48),
  selFg: fg(225, 245, 230),
};

// Rounded box-drawing glyphs.
const GLYPH = {
  tl: '╭', tr: '╮', bl: '╰', br: '╯',
  h: '─', v: '│',
  // T-junctions for shared walls
  tDown: '┬', tUp: '┴', tRight: '├', tLeft: '┤', cross: '┼',
};

class Screen {
  constructor() {
    this.out = process.stdout;
    this.width = this.out.columns || 80;
    this.height = this.out.rows || 24;
    this.buf = [];       // current frame: array of { ch, style }
    this.prev = [];      // last rendered frame
    this._alloc();
  }

  _alloc() {
    const n = this.width * this.height;
    this.buf = new Array(n);
    this.prev = new Array(n);
    for (let i = 0; i < n; i++) {
      this.buf[i] = { ch: ' ', style: '' };
      this.prev[i] = { ch: '\0', style: '\0' }; // force first full paint
    }
  }

  resize() {
    const w = this.out.columns || 80;
    const h = this.out.rows || 24;
    if (w === this.width && h === this.height) return false;
    this.width = w;
    this.height = h;
    this._alloc();
    this.out.write(`${ESC}2J`); // hard clear on resize
    return true;
  }

  clear() {
    for (let i = 0; i < this.buf.length; i++) {
      this.buf[i].ch = ' ';
      this.buf[i].style = '';
    }
  }

  // Place a single styled character.
  put(x, y, ch, style = '') {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const cell = this.buf[y * this.width + x];
    cell.ch = ch;
    cell.style = style;
  }

  // Write a string, clipped to a max width. Returns end x.
  text(x, y, str, style = '', maxWidth = Infinity) {
    let cx = x;
    const limit = x + maxWidth;
    for (const ch of String(str)) {
      if (cx >= limit || cx >= this.width) break;
      if (ch === '\n') break;
      this.put(cx, y, ch, style);
      cx++;
    }
    return cx;
  }

  // Write a string that already contains embedded ANSI SGR codes (e.g. server
  // console colors), tracking style spans so the diff renderer stays correct.
  ansiText(x, y, str, baseStyle = '', maxWidth = Infinity) {
    let cx = x;
    const limit = Math.min(x + maxWidth, this.width);
    let style = baseStyle;
    let i = 0;
    const s = String(str);
    while (i < s.length && cx < limit) {
      if (s[i] === '\x1b' && s[i + 1] === '[') {
        let j = i + 2;
        while (j < s.length && s[j] !== 'm') j++;
        const code = s.slice(i, j + 1);
        if (/\x1b\[0?m/.test(code)) style = baseStyle;
        else style = style + code;
        i = j + 1;
        continue;
      }
      if (s[i] === '\n') break;
      this.put(cx, y, s[i], style);
      cx++;
      i++;
    }
    return cx;
  }

  fillRect(x, y, w, h, ch = ' ', style = '') {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) this.put(xx, yy, ch, style);
    }
  }

  // Draw a rounded box. Optional title sits in the top border.
  box(x, y, w, h, { style = C.border, title = '', titleStyle = C.title } = {}) {
    if (w < 2 || h < 2) return;
    const r = x + w - 1;
    const b = y + h - 1;
    this.put(x, y, GLYPH.tl, style);
    this.put(r, y, GLYPH.tr, style);
    this.put(x, b, GLYPH.bl, style);
    this.put(r, b, GLYPH.br, style);
    for (let xx = x + 1; xx < r; xx++) {
      this.put(xx, y, GLYPH.h, style);
      this.put(xx, b, GLYPH.h, style);
    }
    for (let yy = y + 1; yy < b; yy++) {
      this.put(x, yy, GLYPH.v, style);
      this.put(r, yy, GLYPH.v, style);
    }
    if (title) {
      const t = ` ${title} `;
      const tx = x + 2;
      this.text(tx, y, t, titleStyle, w - 4);
    }
  }

  // Diff the current buffer against the last frame and emit minimal output.
  render() {
    let out = '';
    let lastStyle = null;
    let cursorX = -1;
    let cursorY = -1;
    const w = this.width;
    for (let i = 0; i < this.buf.length; i++) {
      const cur = this.buf[i];
      const old = this.prev[i];
      if (cur.ch === old.ch && cur.style === old.style) continue;
      const y = (i / w) | 0;
      const x = i - y * w;
      if (x !== cursorX || y !== cursorY) {
        out += `${ESC}${y + 1};${x + 1}H`;
      }
      if (cur.style !== lastStyle) {
        out += C.reset + cur.style;
        lastStyle = cur.style;
      }
      out += cur.ch;
      cursorX = x + 1;
      cursorY = y;
      // copy into prev
      old.ch = cur.ch;
      old.style = cur.style;
    }
    if (out) {
      // Wrap in a synchronized-update sequence where supported to avoid tearing.
      this.out.write(`${ESC}?2026h` + out + C.reset + `${ESC}?2026l`);
    }
  }

  hideCursor() { this.out.write(`${ESC}?25l`); }
  showCursor() { this.out.write(`${ESC}?25h`); }
  enterAlt() { this.out.write(`${ESC}?1049h`); }
  leaveAlt() { this.out.write(`${ESC}?1049l`); }

  // Move the *real* terminal cursor (used to show the input caret).
  placeCursor(x, y) {
    this.out.write(`${ESC}${y + 1};${x + 1}H`);
  }
}

// ---- Keyboard input -------------------------------------------------------

const EventEmitter = require('events');

class Input extends EventEmitter {
  constructor() {
    super();
    this.stdin = process.stdin;
  }

  start() {
    if (this.stdin.isTTY) this.stdin.setRawMode(true);
    this.stdin.resume();
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (d) => this._onData(d));
  }

  stop() {
    if (this.stdin.isTTY) this.stdin.setRawMode(false);
    this.stdin.pause();
  }

  _onData(d) {
    // Multi-byte escape sequences (arrows, navigation, function keys).
    switch (d) {
      case '\x1b[A': return this.emit('key', { name: 'up' });
      case '\x1b[B': return this.emit('key', { name: 'down' });
      case '\x1b[C': return this.emit('key', { name: 'right' });
      case '\x1b[D': return this.emit('key', { name: 'left' });
      case '\x1b[H': case '\x1b[1~': case '\x1bOH': return this.emit('key', { name: 'home' });
      case '\x1b[F': case '\x1b[4~': case '\x1bOF': return this.emit('key', { name: 'end' });
      case '\x1b[3~': return this.emit('key', { name: 'delete' });
      case '\x1b[5~': return this.emit('key', { name: 'pageup' });
      case '\x1b[6~': return this.emit('key', { name: 'pagedown' });
      case '\x1b[Z': return this.emit('key', { name: 'shift-tab' });
      case '\x1bOP': case '\x1b[11~': return this.emit('key', { name: 'f1' });
      case '\x1bOQ': case '\x1b[12~': return this.emit('key', { name: 'f2' });
      case '\x1bOR': case '\x1b[13~': return this.emit('key', { name: 'f3' });
      case '\x1bOS': case '\x1b[14~': return this.emit('key', { name: 'f4' });
      case '\x1b[15~': return this.emit('key', { name: 'f5' });
      case '\x1b[17~': return this.emit('key', { name: 'f6' });
      case '\x1b[18~': return this.emit('key', { name: 'f7' });
      case '\x1b': return this.emit('key', { name: 'escape' });
    }

    for (const ch of d) {
      const code = ch.codePointAt(0);
      if (code === 3) this.emit('key', { name: 'C-c', ctrl: true }); // Ctrl+C
      else if (code === 13 || code === 10) this.emit('key', { name: 'enter' });
      else if (code === 127 || code === 8) this.emit('key', { name: 'backspace' });
      else if (code === 9) this.emit('key', { name: 'tab' });
      else if (code === 19) this.emit('key', { name: 'C-s', ctrl: true }); // save
      else if (code === 23) this.emit('key', { name: 'C-w', ctrl: true }); // delete word
      else if (code === 21) this.emit('key', { name: 'C-u', ctrl: true }); // clear line
      else if (code === 18) this.emit('key', { name: 'C-r', ctrl: true }); // restart/refresh
      else if (code === 12) this.emit('key', { name: 'C-l', ctrl: true }); // redraw
      else if (code >= 32) this.emit('key', { name: 'char', ch });
    }
  }
}

module.exports = { Screen, Input, C, GLYPH, fg, bg };
