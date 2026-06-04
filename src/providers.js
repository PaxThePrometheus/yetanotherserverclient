'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const { URL } = require('url');

/*
 * providers.js — fetch server-jar download URLs for the common server flavors,
 * using nothing but Node's built-in https. Each provider can list versions
 * (newest first) and resolve a chosen version to a concrete { url, filename }.
 *
 *   vanilla — Mojang version manifest
 *   paper   — PaperMC v3 "fill" API (the v2 API lags badly — it never sees the
 *             newest Minecraft releases, which is why it must not be used)
 *   purpur  — PurpurMC v2 API (latest build per version)
 *   fabric  — FabricMC meta (server launcher jar)
 *
 * Whatever order an API hands us, we sort versions ourselves so the genuine
 * latest is always first. All network calls are best-effort with a timeout.
 */

const UA = 'yasc/1.0 (Minecraft server panel)';

function fetchJson(url, { timeout = 15000 } = {}) {
  return fetchBuffer(url, { timeout }).then((buf) => JSON.parse(buf.toString('utf8')));
}

function fetchBuffer(url, { timeout = 15000, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.get(u, { headers: { 'User-Agent': UA, Accept: 'application/json' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(fetchBuffer(next, { timeout, redirects: redirects - 1 }));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('request timed out')));
  });
}

// Stream a download to disk, reporting progress. Resolves with the dest path.
function download(url, dest, onProgress, { redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.get(u, { headers: { 'User-Agent': UA } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(download(next, dest, onProgress, { redirects: redirects - 1 }));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let got = 0;
      const file = fs.createWriteStream(dest);
      res.on('data', (c) => {
        got += c.length;
        if (onProgress) onProgress(got, total);
      });
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
      file.on('error', (e) => { try { fs.unlinkSync(dest); } catch {} reject(e); });
    });
    req.on('error', reject);
    req.setTimeout(180000, () => req.destroy(new Error('download timed out')));
  });
}

// ---- version sorting -------------------------------------------------------

// Compare two dotted numeric versions; returns <0 if a is NEWER (for desc sort).
// Handles both classic (1.21.11) and calendar (26.1.2) version schemes.
function cmpDesc(a, b) {
  const A = a.split('.').map(Number);
  const B = b.split('.').map(Number);
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const x = A[i] || 0, y = B[i] || 0;
    if (x !== y) return y - x;
  }
  return 0;
}

// Keep only clean release versions (drop snapshots / -pre / -rc / betas) and
// sort newest-first. If filtering would empty the list, fall back to the raw
// list sorted as-is so we never show nothing.
function sortReleases(list) {
  const clean = list.filter((v) => /^\d+(\.\d+)*$/.test(v));
  const base = clean.length ? clean : list.slice();
  return base.sort(cmpDesc);
}

// ---- Vanilla (Mojang) -----------------------------------------------------

const vanilla = {
  id: 'vanilla',
  name: 'Vanilla',
  async _manifest() {
    if (!this.__m) {
      this.__m = await fetchJson('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
    }
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
    return { url: server.url, filename: `minecraft_server.${version}.jar`, sha1: server.sha1 };
  },
};

// ---- Paper (v3 "fill" API) -------------------------------------------------

const PAPER_BASE = 'https://fill.papermc.io/v3/projects/paper';

const paper = {
  id: 'paper',
  name: 'Paper',
  async listVersions() {
    const d = await fetchJson(PAPER_BASE);
    // d.versions is grouped by minor: { "26.1": ["26.1.2", ...], "1.21": [...] }
    const all = [];
    for (const k of Object.keys(d.versions || {})) {
      for (const v of d.versions[k]) all.push(v);
    }
    return sortReleases(all);
  },
  async resolve(version) {
    const builds = await fetchJson(`${PAPER_BASE}/versions/${version}/builds`);
    const arr = Array.isArray(builds) ? builds : (builds.builds || []);
    if (!arr.length) throw new Error(`No Paper builds for ${version}`);
    const b = arr.find((x) => x.channel === 'STABLE') || arr[0];
    const dl = (b.downloads && (b.downloads['server:default'] || Object.values(b.downloads)[0]));
    if (!dl || !dl.url) throw new Error(`Paper ${version} build has no download`);
    return { url: dl.url, filename: dl.name || `paper-${version}-${b.id}.jar` };
  },
};

// ---- Purpur ---------------------------------------------------------------

const purpur = {
  id: 'purpur',
  name: 'Purpur',
  async listVersions() {
    const d = await fetchJson('https://api.purpurmc.org/v2/purpur');
    return sortReleases(d.versions);
  },
  async resolve(version) {
    const d = await fetchJson(`https://api.purpurmc.org/v2/purpur/${version}`);
    const build = d.builds.latest;
    return {
      url: `https://api.purpurmc.org/v2/purpur/${version}/${build}/download`,
      filename: `purpur-${version}-${build}.jar`,
    };
  },
};

// ---- Fabric ---------------------------------------------------------------

const fabric = {
  id: 'fabric',
  name: 'Fabric',
  async listVersions() {
    const d = await fetchJson('https://meta.fabricmc.net/v2/versions/game');
    return sortReleases(d.filter((v) => v.stable).map((v) => v.version));
  },
  async resolve(version) {
    const [loaders, installers] = await Promise.all([
      fetchJson('https://meta.fabricmc.net/v2/versions/loader'),
      fetchJson('https://meta.fabricmc.net/v2/versions/installer'),
    ]);
    const loader = loaders[0].version;       // newest stable loader
    const installer = installers[0].version; // newest installer
    return {
      url: `https://meta.fabricmc.net/v2/versions/loader/${version}/${loader}/${installer}/server/jar`,
      filename: `fabric-server-mc.${version}-loader.${loader}-launcher.${installer}.jar`,
    };
  },
};

const providers = { vanilla, paper, purpur, fabric };
const PROVIDER_LIST = [vanilla, paper, purpur, fabric];

module.exports = { providers, PROVIDER_LIST, fetchJson, fetchBuffer, download, sortReleases, cmpDesc };
