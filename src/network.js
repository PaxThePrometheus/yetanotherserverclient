'use strict';

const os = require('os');
const { fetchJson } = require('./providers');

/*
 * network.js — figure out how reachable the server is.
 *
 *   localAddresses() — this machine's LAN IPv4s (for "friends on your wifi")
 *   publicIP()       — your router's public IP (api.ipify.org)
 *   checkPort()      — ask an external node to actually connect to host:port,
 *                      so we can tell the user whether their port forward works
 *                      (check-host.net's free TCP-check API)
 *
 * Everything is best-effort with timeouts and never throws synchronously.
 */

function localAddresses() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ iface: name, address: a.address });
    }
  }
  return out;
}

// The address you'd hand a friend on the same network: prefer a private-range
// LAN address over anything exotic (VPNs, virtual adapters).
function primaryLocal() {
  const list = localAddresses();
  const priv = list.find((a) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address));
  return priv || list[0] || { iface: 'lo', address: '127.0.0.1' };
}

function publicIP() {
  return fetchJson('https://api.ipify.org?format=json', { timeout: 8000 }).then((r) => r.ip);
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Returns { reachable, detail }. Uses check-host.net: kick off a check, then
// poll for results from its distributed nodes.
async function checkPort(host, port) {
  const target = encodeURIComponent(`${host}:${port}`);
  const start = await fetchJson(`https://check-host.net/check-tcp?host=${target}&max_nodes=3`, { timeout: 10000 });
  const id = start && start.request_id;
  if (!id) throw new Error('the port checker did not accept the request');

  for (let i = 0; i < 8; i++) {
    await delay(1500);
    let res;
    try { res = await fetchJson(`https://check-host.net/check-result/${id}`, { timeout: 8000 }); }
    catch { continue; }
    const vals = Object.values(res || {});
    if (!vals.length) continue;
    const open = vals.some((v) => Array.isArray(v) && v[0] && !v[0].error && (v[0].address || v[0].time != null));
    if (open) return { reachable: true, detail: 'an external node connected successfully' };
    const settled = vals.every((v) => v !== null);
    if (settled) {
      const err = (vals.find((v) => Array.isArray(v) && v[0] && v[0].error) || [{}])[0].error;
      return { reachable: false, detail: err || 'no external node could connect' };
    }
  }
  return { reachable: false, detail: 'timed out waiting for the port check' };
}

module.exports = { localAddresses, primaryLocal, publicIP, checkPort };
