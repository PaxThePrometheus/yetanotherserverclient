'use strict';

const { fetchJson } = require('./providers');
const modrinth = require('./modrinth');

/*
 * libraries.js — plugin/mod catalogs, unified behind one interface so the panel
 * can offer a *choice* of source per flavor. Each library exposes:
 *
 *   appliesTo(flavor)                      -> bool
 *   search({ flavor, gameVersion, query }) -> { hits:[…], versionFiltered }
 *   resolveFile({ hit, flavor, gameVersion }) -> { url, filename } | { browseUrl }
 *
 * A hit is { id, title, author, description, downloads, … }. resolveFile may
 * return a direct download, or a browseUrl when a project is hosted off-site /
 * is premium and can't be fetched automatically.
 *
 *   Modrinth  — plugins (Bukkit family, proxies) + mods (Fabric/Forge/NeoForge)
 *   Hangar    — PaperMC's official catalog (Paper/Velocity/Waterfall)
 *   SpigotMC  — via the Spiget mirror (Bukkit/Spigot/Bungee plugins)
 */

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'file';

// ---- Modrinth (wraps modrinth.js) -----------------------------------------

const modrinthLib = {
  id: 'modrinth', name: 'Modrinth',
  appliesTo: (flavor) => !!modrinth.compatFor(flavor),
  search: (opts) => modrinth.search(opts).then((r) => ({
    versionFiltered: r.versionFiltered,
    hits: r.hits.map((h) => ({ id: h.slug, title: h.title, author: h.author, description: h.description, downloads: h.downloads })),
  })),
  resolveFile: ({ hit, flavor, gameVersion }) => modrinth.resolveFile({ slug: hit.id, flavor, gameVersion }),
};

// ---- Hangar (hangar.papermc.io) -------------------------------------------

const HG = 'https://hangar.papermc.io/api/v1';
const hangarPlatform = (flavor) => ({ paper: 'PAPER', folia: 'PAPER', purpur: 'PAPER', velocity: 'VELOCITY', waterfall: 'WATERFALL' }[flavor] || null);

const hangarLib = {
  id: 'hangar', name: 'Hangar',
  appliesTo: (flavor) => !!hangarPlatform(flavor),
  async search({ flavor, query }) {
    const platform = hangarPlatform(flavor);
    const params = new URLSearchParams({ limit: '25', offset: '0', sort: '-downloads' });
    if (query && query.trim()) params.set('query', query.trim());
    if (platform) params.set('platform', platform);
    const d = await fetchJson(`${HG}/projects?${params.toString()}`);
    return {
      versionFiltered: false,
      hits: (d.result || []).map((p) => ({
        id: `${p.namespace.owner}/${p.namespace.slug}`,
        owner: p.namespace.owner, slug: p.namespace.slug,
        title: p.name, author: p.namespace.owner,
        description: p.description, downloads: (p.stats && p.stats.downloads) || 0,
      })),
    };
  },
  async resolveFile({ hit, flavor }) {
    const platform = hangarPlatform(flavor);
    const d = await fetchJson(`${HG}/projects/${hit.owner}/${hit.slug}/versions?limit=1&platform=${platform}`);
    const v = d.result && d.result[0];
    if (!v) throw new Error('no Hangar version for this platform');
    const dl = v.downloads && v.downloads[platform];
    if (dl && dl.downloadUrl) return { url: dl.downloadUrl, filename: (dl.fileInfo && dl.fileInfo.name) || `${hit.slug}-${v.name}.jar` };
    if (dl && dl.externalUrl) return { browseUrl: dl.externalUrl, note: 'hosted off-site' };
    return { url: `${HG}/projects/${hit.owner}/${hit.slug}/versions/${encodeURIComponent(v.name)}/${platform}/download`, filename: `${hit.slug}-${v.name}.jar` };
  },
};

// ---- SpigotMC (via the Spiget API) ----------------------------------------

const SP = 'https://api.spiget.org/v2';
const spigetApplies = (flavor) => ['paper', 'folia', 'purpur', 'spigot', 'craftbukkit', 'bukkit', 'bungeecord', 'waterfall'].includes(flavor);

const spigetLib = {
  id: 'spiget', name: 'SpigotMC',
  appliesTo: spigetApplies,
  async search({ query }) {
    const q = (query && query.trim()) || 'bukkit';
    const fields = 'id,name,tag,downloads,premium,external';
    const arr = await fetchJson(`${SP}/search/resources/${encodeURIComponent(q)}?size=25&sort=-downloads&fields=${fields}`).catch(() => []);
    return {
      versionFiltered: false,
      hits: (Array.isArray(arr) ? arr : []).map((r) => ({
        id: String(r.id), title: r.name, author: '', description: r.tag,
        downloads: r.downloads || 0, premium: r.premium, external: r.external,
      })),
    };
  },
  async resolveFile({ hit }) {
    const page = `https://www.spigotmc.org/resources/${hit.id}`;
    if (hit.premium) return { browseUrl: page, note: 'premium resource' };
    if (hit.external) return { browseUrl: page, note: 'externally hosted' };
    // Best-effort: SpigotMC sometimes blocks programmatic downloads — the caller
    // verifies the result is really a jar and falls back to the page if not.
    return { url: `${SP}/resources/${hit.id}/download`, filename: `${slug(hit.title)}.jar`, fragile: true, browseUrl: page };
  },
};

const ALL = [modrinthLib, hangarLib, spigetLib];

// Libraries that apply to a flavor, in preference order.
function librariesFor(flavor) {
  return ALL.filter((lib) => lib.appliesTo(flavor));
}

module.exports = { librariesFor, ALL };
