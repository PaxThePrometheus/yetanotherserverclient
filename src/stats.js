'use strict';

const fs = require('fs');
const { execFile } = require('child_process');

/*
 * stats.js — best-effort resource sampling for a child process (the Java
 * server) across platforms. Returns { rssMB, cpu } where cpu is a percentage of
 * a single core since the last sample. Everything degrades gracefully: if we
 * can't read a metric on a given OS we just report 0 rather than throwing.
 */

const _last = new Map(); // pid -> { cpuJiffies, at }

function sample(pid) {
  if (!pid) return Promise.resolve({ rssMB: 0, cpu: 0 });
  if (process.platform === 'linux') return sampleLinux(pid);
  if (process.platform === 'win32') return sampleWin(pid);
  return sampleUnix(pid);
}

function sampleLinux(pid) {
  return new Promise((resolve) => {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const statm = fs.readFileSync(`/proc/${pid}/statm`, 'utf8');
      // utime (14) + stime (15) are after the (comm) field which may contain spaces.
      const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const utime = parseInt(after[11], 10);
      const stime = parseInt(after[12], 10);
      const jiffies = utime + stime;
      const rssPages = parseInt(statm.split(' ')[1], 10);
      const rssMB = (rssPages * 4096) / 1048576;
      resolve({ rssMB, cpu: cpuDelta(pid, jiffies, 100) });
    } catch {
      resolve({ rssMB: 0, cpu: 0 });
    }
  });
}

function sampleUnix(pid) {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'rss=,%cpu=', '-p', String(pid)], { timeout: 4000 }, (err, out) => {
      if (err) return resolve({ rssMB: 0, cpu: 0 });
      const m = String(out).trim().split(/\s+/);
      resolve({ rssMB: (parseInt(m[0], 10) || 0) / 1024, cpu: parseFloat(m[1]) || 0 });
    });
  });
}

function sampleWin(pid) {
  return new Promise((resolve) => {
    // tasklist gives memory; CPU via wmic kernel+user time for a delta.
    execFile('tasklist', ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'],
      { timeout: 5000, windowsHide: true }, (err, out) => {
        let rssMB = 0;
        if (!err) {
          const m = String(out).match(/"([\d.,]+)\s*K"/);
          if (m) rssMB = parseInt(m[1].replace(/[.,]/g, ''), 10) / 1024;
        }
        execFile('wmic', ['path', 'Win32_PerfFormattedData_PerfProc_Process',
          'where', `IDProcess=${pid}`, 'get', 'PercentProcessorTime', '/value'],
          { timeout: 5000, windowsHide: true }, (e2, out2) => {
            let cpu = 0;
            if (!e2) {
              const m = String(out2).match(/PercentProcessorTime=(\d+)/);
              if (m) cpu = parseInt(m[1], 10);
            }
            resolve({ rssMB, cpu });
          });
      });
  });
}

// Convert a monotonically increasing CPU-time counter into a percentage of one
// core, using the elapsed wall time since the previous sample for this pid.
function cpuDelta(pid, jiffies, hz) {
  const now = Date.now();
  const prev = _last.get(pid);
  _last.set(pid, { cpuJiffies: jiffies, at: now });
  if (!prev) return 0;
  const dt = (now - prev.at) / 1000;
  if (dt <= 0) return 0;
  const usedSec = (jiffies - prev.cpuJiffies) / hz;
  return Math.max(0, (usedSec / dt) * 100);
}

module.exports = { sample };
