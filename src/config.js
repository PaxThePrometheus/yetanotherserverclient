'use strict';

const path = require('path');
const fs = require('fs');

/*
 * config.js — yasc's own state, kept right next to the project so everything is
 * easy to find and the whole thing stays portable (move the folder, keep your
 * servers). Everything lives under <project>/servers:
 *
 *   <project>/servers/             home for servers created by the wizard
 *   <project>/servers/servers.json the registry of known servers + last-used
 *   <project>/servers/.cache/      downloaded jars are streamed here first
 *
 * A "server" record is just a pointer at a directory plus how to launch it:
 *   { name, dir, jar, type, version, ram, java }
 */

const ROOT = path.join(__dirname, '..');
const SERVERS_DIR = path.join(ROOT, 'servers');
const CACHE_DIR = path.join(SERVERS_DIR, '.cache');
const CONFIG_PATH = path.join(SERVERS_DIR, 'servers.json');
const HOME = SERVERS_DIR;

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const cfg = JSON.parse(raw);
    if (!Array.isArray(cfg.servers)) cfg.servers = [];
    return cfg;
  } catch {
    return { servers: [], lastName: '' };
  }
}

function saveConfig(data) {
  try {
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2));
  } catch {
    /* non-fatal */
  }
}

// Insert or update a server record (keyed by its directory) and remember it as
// the most-recently-used one.
function rememberServer(server) {
  const cfg = loadConfig();
  const i = cfg.servers.findIndex((s) => samePath(s.dir, server.dir));
  if (i >= 0) cfg.servers[i] = { ...cfg.servers[i], ...server };
  else cfg.servers.push(server);
  cfg.lastName = server.name;
  saveConfig(cfg);
  return cfg;
}

function forgetServer(dir) {
  const cfg = loadConfig();
  cfg.servers = cfg.servers.filter((s) => !samePath(s.dir, dir));
  saveConfig(cfg);
  return cfg;
}

function samePath(a, b) {
  if (!a || !b) return false;
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

module.exports = {
  HOME, CONFIG_PATH, SERVERS_DIR, CACHE_DIR,
  loadConfig, saveConfig, rememberServer, forgetServer, samePath,
};
