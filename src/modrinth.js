'use strict';

const { fetchJson } = require('./providers');

/*
 * modrinth.js — search and install plugins/mods from Modrinth (modrinth.com).
 *
 * Modrinth's facet search lets us constrain results to exactly what a given
 * server can actually load: the right project type (plugin vs mod), a loader
 * the flavor understands, and the server's Minecraft version. So the list the
 * panel shows is already filtered to "compatible with this server".
 */

// Map a server flavor to what Modrinth should look for.
//   type    — 'plugin' for Bukkit-family servers, 'mod' for Fabric
//   loaders — loader categories the server can load, in preference order
function compatFor(flavor) {
  switch (flavor) {
    case 'paper':
    case 'folia': return { type: 'plugin', loaders: ['paper', 'spigot', 'bukkit', 'folia'] };
    case 'purpur': return { type: 'plugin', loaders: ['purpur', 'paper', 'spigot', 'bukkit'] };
    case 'spigot': return { type: 'plugin', loaders: ['spigot', 'bukkit'] };
    case 'craftbukkit': return { type: 'plugin', loaders: ['bukkit'] };
    case 'velocity': return { type: 'plugin', loaders: ['velocity'] };
    case 'waterfall':
    case 'bungeecord': return { type: 'plugin', loaders: ['waterfall', 'bungeecord'] };
    case 'fabric': return { type: 'mod', loaders: ['fabric'] };
    case 'quilt': return { type: 'mod', loaders: ['quilt', 'fabric'] };
    case 'forge': return { type: 'mod', loaders: ['forge'] };
    case 'neoforge': return { type: 'mod', loaders: ['neoforge'] };
    default: return null; // vanilla — no Modrinth install
  }
}

function cleanVersion(v) {
  return /^\d+(\.\d+)*$/.test(String(v || '')) ? v : null;
}

const BASE = 'https://api.modrinth.com/v2';

// Search compatible projects. Returns [{ slug, title, author, description,
// downloads, categories }].
async function search({ flavor, gameVersion, query = '', limit = 30 }) {
  const compat = compatFor(flavor);
  if (!compat) {
    const err = new Error('This flavor cannot load Modrinth plugins or mods.');
    err.code = 'INCOMPATIBLE';
    throw err;
  }
  const facets = [[`project_type:${compat.type}`]];
  facets.push(compat.loaders.map((l) => `categories:${l}`)); // OR across loaders
  const gv = cleanVersion(gameVersion);
  if (gv) facets.push([`versions:${gv}`]);

  const params = new URLSearchParams({
    limit: String(limit),
    index: 'relevance',
    facets: JSON.stringify(facets),
  });
  if (query.trim()) params.set('query', query.trim());

  const res = await fetchJson(`${BASE}/search?${params.toString()}`);
  return {
    versionFiltered: !!gv,
    hits: (res.hits || []).map((h) => ({
      slug: h.slug || h.project_id,
      title: h.title,
      author: h.author,
      description: h.description,
      downloads: h.downloads,
      categories: h.categories || [],
    })),
  };
}

// Resolve the newest compatible file for a project. Returns { url, filename }.
async function resolveFile({ slug, flavor, gameVersion }) {
  const compat = compatFor(flavor);
  if (!compat) throw new Error('incompatible flavor');
  const params = new URLSearchParams({ loaders: JSON.stringify(compat.loaders) });
  const gv = cleanVersion(gameVersion);
  if (gv) params.set('game_versions', JSON.stringify([gv]));

  const versions = await fetchJson(`${BASE}/project/${encodeURIComponent(slug)}/version?${params.toString()}`);
  if (!Array.isArray(versions) || !versions.length) {
    throw new Error('no compatible version for this server');
  }
  const v = versions[0]; // Modrinth returns newest first
  const file = (v.files || []).find((f) => f.primary) || (v.files || [])[0];
  if (!file || !file.url) throw new Error('no downloadable file');
  return { url: file.url, filename: file.filename, versionName: v.version_number };
}

module.exports = { search, resolveFile, compatFor };
