'use strict';

const dgram = require('dgram');
const http = require('http');
const { URL } = require('url');

/*
 * upnp.js — automatic port forwarding via UPnP IGD (the same mechanism the
 * vanilla "Open to LAN" and many games use). Zero dependencies: SSDP discovery
 * over UDP multicast, then SOAP calls over HTTP to the gateway.
 *
 * This only works if the router has UPnP enabled. Everything is best-effort and
 * fails with a readable message the panel can show.
 */

// SSDP M-SEARCH for Internet Gateway Devices; collect their description URLs.
function discover({ timeout = 3000 } = {}) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const found = new Set();
    const targets = [
      'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
      'urn:schemas-upnp-org:service:WANIPConnection:1',
      'upnp:rootdevice',
    ];
    sock.on('message', (buf) => {
      const m = buf.toString().match(/LOCATION:\s*(\S+)/i);
      if (m) found.add(m[1].trim());
    });
    sock.on('error', () => {});
    sock.bind(() => {
      try { sock.setBroadcast(true); } catch {}
      for (const st of targets) {
        const msg = Buffer.from([
          'M-SEARCH * HTTP/1.1',
          'HOST: 239.255.255.250:1900',
          'MAN: "ssdp:discover"',
          'MX: 2',
          `ST: ${st}`, '', '',
        ].join('\r\n'));
        try { sock.send(msg, 0, msg.length, 1900, '239.255.255.250'); } catch {}
      }
    });
    setTimeout(() => { try { sock.close(); } catch {} resolve([...found]); }, timeout);
  });
}

function httpGet(url, { timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.get(u, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => resolve({ status: r.statusCode, body: d }));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('gateway timed out')));
  });
}

// Pull the WAN connection service (and its control URL) out of a device's XML.
function pickService(xml, type) {
  const re = new RegExp(`<service>([\\s\\S]*?${type}[\\s\\S]*?)</service>`, 'i');
  const m = xml.match(re);
  if (!m) return null;
  const block = m[1];
  const st = (block.match(/<serviceType>([^<]+)<\/serviceType>/i) || [])[1];
  const cu = (block.match(/<controlURL>([^<]+)<\/controlURL>/i) || [])[1];
  if (!st || !cu) return null;
  return { serviceType: st.trim(), controlURL: cu.trim() };
}

async function resolveService(location) {
  const { body } = await httpGet(location);
  const svc = pickService(body, 'WANIPConnection') || pickService(body, 'WANPPPConnection');
  if (!svc) throw new Error('gateway has no WAN connection service');
  svc.controlURL = new URL(svc.controlURL, location).toString();
  return svc;
}

function soap(svc, action, args) {
  const body = '<?xml version="1.0"?>'
    + '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
    + 's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>'
    + `<u:${action} xmlns:u="${svc.serviceType}">`
    + Object.entries(args).map(([k, v]) => `<${k}>${v}</${k}>`).join('')
    + `</u:${action}></s:Body></s:Envelope>`;
  return new Promise((resolve, reject) => {
    const u = new URL(svc.controlURL);
    const data = Buffer.from(body, 'utf8');
    const req = http.request({
      hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        'Content-Length': data.length,
        SOAPAction: `"${svc.serviceType}#${action}"`,
      },
    }, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => {
        if (r.statusCode !== 200) {
          const err = (d.match(/<errorDescription>([^<]+)</i) || [])[1];
          reject(new Error(err || `router refused the request (HTTP ${r.statusCode})`));
        } else resolve(d);
      });
    });
    req.on('error', reject);
    req.setTimeout(6000, () => req.destroy(new Error('router timed out')));
    req.write(data);
    req.end();
  });
}

async function firstService() {
  const locs = await discover();
  if (!locs.length) throw new Error('no UPnP gateway found (is UPnP enabled on your router?)');
  let last;
  for (const loc of locs) {
    try { return await resolveService(loc); } catch (e) { last = e; }
  }
  throw last || new Error('no usable UPnP gateway');
}

// Open a port on the router, pointing it at this machine. Returns the public IP
// if the gateway will tell us.
async function forward({ port, internalIP, protocol = 'TCP', desc = 'yasc Minecraft' }) {
  const svc = await firstService();
  await soap(svc, 'AddPortMapping', {
    NewRemoteHost: '', NewExternalPort: port, NewProtocol: protocol,
    NewInternalPort: port, NewInternalClient: internalIP, NewEnabled: 1,
    NewPortMappingDescription: desc, NewLeaseDuration: 0,
  });
  let externalIP = null;
  try {
    const r = await soap(svc, 'GetExternalIPAddress', {});
    externalIP = (r.match(/<NewExternalIPAddress>([^<]*)</i) || [])[1] || null;
  } catch {}
  return { ok: true, externalIP, serviceType: svc.serviceType };
}

async function unforward({ port, protocol = 'TCP' }) {
  const svc = await firstService();
  await soap(svc, 'DeletePortMapping', {
    NewRemoteHost: '', NewExternalPort: port, NewProtocol: protocol,
  });
  return { ok: true };
}

module.exports = { discover, forward, unforward };
