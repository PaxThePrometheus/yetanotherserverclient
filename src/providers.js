'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const { URL } = require('url');

/*
 * providers.js — server-jar sources for every flavor we support, using only
 * Node's built-in http(s). Each provider carries metadata the rest of the app
 * needs (category, plugin/mod folder, whether it uses the EULA / `nogui`, and
 * whether it ships an installer rather than a runnable jar), plus:
 *
 *   listVersions()      newest-first list of versions
 *   resolve(version)    -> { url, filename, installer? }
 *
 * Flavors grouped by category:
 *   vanilla  — Vanilla (Mojang)
 *   servers  — Paper, Folia, Purpur          (Bukkit/Spigot plugins)
 *   modded   — Fabric, Forge, NeoForge       (mods)
 *   proxy    — Velocity, Waterfall, BungeeCord
 *
 * Spigot/CraftBukkit aren't here: they can't be redistributed (you build them
 * with BuildTools), so the launcher offers them as an import-only path.
 */

const UA = 'yasc/1.1 (Minecraft server panel)';

function fetchJson(url, opts = {}) {
  return fetchBuffer(url, opts).then((buf) => JSON.parse(buf.toString('utf8')));
}
function fetchText(url, opts = {}) {
  return fetchBuffer(url, opts).then((buf) => buf.toString('utf8'));
}

function fetchBuffer(url, { timeout = 15000, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.get(u, { headers: { 'User-Agent': UA, Accept: 'application/json' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(fetchBuffer(new URL(res.headers.location, url).toString(), { timeout, redirects: redirects - 1 }));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('request timed out')));
  });
}

// Stream a download to disk, reporting progress. Resolves with the dest path.
function download(url, dest, onProgress, { redirects = 6 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.get(u, { headers: { 'User-Agent': UA } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).toString(), dest, onProgress, { redirects: redirects - 1 }));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} downloading ${url}`)); }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let got = 0;
      const file = fs.createWriteStream(dest);
      res.on('data', (c) => { got += c.length; if (onProgress) onProgress(got, total); });
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
      file.on('error', (e) => { try { fs.unlinkSync(dest); } catch {} reject(e); });
    });
    req.on('error', reject);
    req.setTimeout(300000, () => req.destroy(new Error('download timed out')));
  });
}

// ---- version sorting -------------------------------------------------------

function cmpDesc(a, b) {
  const A = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const B = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i++) { const x = A[i] || 0, y = B[i] || 0; if (x !== y) return y - x; }
  return 0;
}
// Releases only (drop snapshots / pre / rc), newest first.
function sortReleases(list) {
  const clean = list.filter((v) => /^\d+(\.\d+)*$/.test(v));
  return (clean.length ? clean : list.slice()).sort(cmpDesc);
}
// Keep every version (proxies ship -SNAPSHOT builds), newest first.
function sortAll(list) {
  return list.slice().sort(cmpDesc);
}

const defaults = { category: 'servers', kind: 'plugins', eula: true, nogui: true, install: false };

// ---- Vanilla (Mojang) -----------------------------------------------------

const vanilla = {
  ...defaults, id: 'vanilla', name: 'Vanilla', category: 'vanilla', kind: 'none',
  blurb: 'official Mojang server',
  async _manifest() {
    if (!this.__m) this.__m = await fetchJson('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
    return this.__m;
  },
  async listVersions() {
    const m = await this._manifest();
    return sortReleases(m.versions.filter((v) => v.type === 'release').map((v) => v.id));
  },
  async resolve(version) {
    const m = await this._manifest();
    const entry = m.versions.find((v) => v.id === version);
    if (!entry) throw new Error(`Unknown vanilla version ${version}`);
    const meta = await fetchJson(entry.url);
    const server = meta.downloads && meta.downloads.server;
    if (!server) throw new Error(`Vanilla ${version} has no server download (too old?)`);
    return { url: server.url, filename: `minecraft_server.${version}.jar` };
  },
};

// ---- PaperMC "fill" family (Paper, Folia, Velocity, Waterfall) -------------

function fillProvider(meta) {
  const BASE = `https://fill.papermc.io/v3/projects/${meta.id}`;
  const releasesOnly = meta.category !== 'proxy';
  return {
    ...defaults, ...meta,
    async listVersions() {
      const d = await fetchJson(BASE);
      const all = [];
      for (const k of Object.keys(d.versions || {})) for (const v of d.versions[k]) all.push(v);
      return releasesOnly ? sortReleases(all) : sortAll(all);
    },
    async resolve(version) {
      const builds = await fetchJson(`${BASE}/versions/${version}/builds`);
      const arr = Array.isArray(builds) ? builds : (builds.builds || []);
      if (!arr.length) throw new Error(`No ${meta.name} builds for ${version}`);
      const b = arr.find((x) => x.channel === 'STABLE') || arr[0];
      const dl = b.downloads && (b.downloads['server:default'] || Object.values(b.downloads)[0]);
      if (!dl || !dl.url) throw new Error(`${meta.name} ${version} build has no download`);
      return { url: dl.url, filename: dl.name || `${meta.id}-${version}-${b.id}.jar` };
    },
  };
}

const paper = fillProvider({ id: 'paper', name: 'Paper', category: 'servers', kind: 'plugins', blurb: 'fast, plugin-ready (Bukkit/Spigot)' });
const folia = fillProvider({ id: 'folia', name: 'Folia', category: 'servers', kind: 'plugins', blurb: 'regionised multithreaded Paper' });
const velocity = fillProvider({ id: 'velocity', name: 'Velocity', category: 'proxy', kind: 'plugins', eula: false, nogui: false, blurb: 'modern high-perf proxy' });
const waterfall = fillProvider({ id: 'waterfall', name: 'Waterfall', category: 'proxy', kind: 'plugins', eula: false, nogui: false, blurb: 'BungeeCord-based proxy (legacy)' });

// ---- Purpur ---------------------------------------------------------------

const purpur = {
  ...defaults, id: 'purpur', name: 'Purpur', category: 'servers', kind: 'plugins',
  blurb: 'Paper fork, extra config',
  async listVersions() {
    const d = await fetchJson('https://api.purpurmc.org/v2/purpur');
    return sortReleases(d.versions);
  },
  async resolve(version) {
    const d = await fetchJson(`https://api.purpurmc.org/v2/purpur/${version}`);
    const build = d.builds.latest;
    return { url: `https://api.purpurmc.org/v2/purpur/${version}/${build}/download`, filename: `purpur-${version}-${build}.jar` };
  },
};

// ---- Fabric ---------------------------------------------------------------

const fabric = {
  ...defaults, id: 'fabric', name: 'Fabric', category: 'modded', kind: 'mods',
  blurb: 'lightweight mod loader',
  async listVersions() {
    const d = await fetchJson('https://meta.fabricmc.net/v2/versions/game');
    return sortReleases(d.filter((v) => v.stable).map((v) => v.version));
  },
  async resolve(version) {
    const [loaders, installers] = await Promise.all([
      fetchJson('https://meta.fabricmc.net/v2/versions/loader'),
      fetchJson('https://meta.fabricmc.net/v2/versions/installer'),
    ]);
    const loader = loaders[0].version, installer = installers[0].version;
    return {
      url: `https://meta.fabricmc.net/v2/versions/loader/${version}/${loader}/${installer}/server/jar`,
      filename: `fabric-server-mc.${version}-loader.${loader}-launcher.${installer}.jar`,
    };
  },
};

// ---- BungeeCord (Jenkins, latest only) ------------------------------------

const bungeecord = {
  ...defaults, id: 'bungeecord', name: 'BungeeCord', category: 'proxy', kind: 'plugins',
  eula: false, nogui: false, blurb: 'classic SpigotMC proxy',
  async listVersions() { return ['latest']; },
  async resolve() {
    return {
      url: 'https://ci.md-5.net/job/BungeeCord/lastSuccessfulBuild/artifact/bootstrap/target/BungeeCord.jar',
      filename: 'BungeeCord.jar',
    };
  },
};

// ---- Forge (installer) ----------------------------------------------------

const forge = {
  ...defaults, id: 'forge', name: 'Forge', category: 'modded', kind: 'mods', install: true,
  blurb: 'the classic mod loader (installer)',
  async listVersions() {
    const d = await fetchJson('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
    const mc = new Set();
    for (const k of Object.keys(d.promos || {})) mc.add(k.replace(/-(latest|recommended)$/, ''));
    this.__promos = d.promos;
    return sortReleases([...mc]);
  },
  async resolve(version) {
    if (!this.__promos) await this.listVersions();
    const fv = this.__promos[`${version}-recommended`] || this.__promos[`${version}-latest`];
    if (!fv) throw new Error(`No Forge build for ${version}`);
    const full = `${version}-${fv}`;
    return {
      url: `https://maven.minecraftforge.net/net/minecraftforge/forge/${full}/forge-${full}-installer.jar`,
      filename: `forge-${full}-installer.jar`, installer: true, mc: version, loader: fv,
    };
  },
};

// ---- NeoForge (installer) -------------------------------------------------

// NeoForge versions like 21.1.95 map to Minecraft 1.21.1 (1.<major>.<minor>).
function neoToMc(v) {
  const m = String(v).match(/^(\d+)\.(\d+)\./);
  return m ? `1.${m[1]}.${m[2]}`.replace(/\.0$/, '') : '?';
}

const neoforge = {
  ...defaults, id: 'neoforge', name: 'NeoForge', category: 'modded', kind: 'mods', install: true,
  blurb: 'modern Forge successor (installer)',
  async listVersions() {
    const xml = await fetchText('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml');
    const versions = (xml.match(/<version>([^<]+)<\/version>/g) || [])
      .map((s) => s.replace(/<\/?version>/g, ''))
      .filter((v) => !/beta|alpha/i.test(v));
    return versions.sort(cmpDesc);
  },
  async resolve(version) {
    return {
      url: `https://maven.neoforged.net/releases/net/neoforged/neoforge/${version}/neoforge-${version}-installer.jar`,
      filename: `neoforge-${version}-installer.jar`, installer: true, mc: neoToMc(version), loader: version,
    };
  },
};

const providers = { vanilla, paper, folia, purpur, fabric, forge, neoforge, velocity, waterfall, bungeecord };
const PROVIDER_LIST = [vanilla, paper, folia, purpur, fabric, forge, neoforge, velocity, waterfall, bungeecord];

// Grouped for the launcher.
const CATEGORIES = [
  { id: 'vanilla', label: 'Vanilla' },
  { id: 'servers', label: 'Plugin servers (Bukkit)' },
  { id: 'modded', label: 'Modded' },
  { id: 'proxy', label: 'Proxies' },
];

// Flavor traits for a given type id (works for imported types we don't host).
function metaFor(type) {
  const p = providers[type];
  if (p) return { category: p.category, kind: p.kind, eula: p.eula !== false, nogui: p.nogui !== false, install: !!p.install };
  const known = {
    spigot: { category: 'servers', kind: 'plugins' },
    craftbukkit: { category: 'servers', kind: 'plugins' },
    bukkit: { category: 'servers', kind: 'plugins' },
    quilt: { category: 'modded', kind: 'mods' },
    sponge: { category: 'servers', kind: 'plugins' },
  };
  const m = known[type] || { category: 'servers', kind: 'plugins' };
  return { category: m.category, kind: m.kind, eula: m.category !== 'proxy', nogui: m.category !== 'proxy', install: false };
}

module.exports = {
  providers, PROVIDER_LIST, CATEGORIES, metaFor,
  fetchJson, fetchText, fetchBuffer, download, sortReleases, sortAll, cmpDesc, neoToMc,
};
