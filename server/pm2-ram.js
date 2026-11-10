#!/usr/bin/env node
/**
 * AnucVC — pm2 RAM raporu
 *
 * `pm2 list` sadece MB gosterir; bu script her pm2 surecinin kullandigi RAM'i
 * MB olarak VE telefonun toplam RAM'inin yuzde kacini tukettigini birlikte
 * yazar. Cihazin genel RAM durumunu da ozetler.
 *
 * Kullanim (telefonda, sunucu klasorunde):
 *   npm run ram          -> tek seferlik rapor
 *   npm run ram:watch    -> 2 saniyede bir yenilenen canli rapor
 *
 * pm2 kurulu degilse yalnizca bu Node surecinin ve cihazin RAM ozetini basar.
 */

import { exec } from 'child_process';
import os from 'os';

const WATCH = process.argv.includes('--watch') || process.argv.includes('-w');
const INTERVAL_MS = Number(process.env.RAM_WATCH_INTERVAL || 2000);

const MB = 1024 * 1024;
const toMB = (bytes) => bytes / MB;
const pct = (part, whole) => (whole > 0 ? (part / whole) * 100 : 0);

const C = process.stdout.isTTY
  ? {
      reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
      green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m'
    }
  : { reset: '', dim: '', bold: '', green: '', yellow: '', red: '', cyan: '' };

function colorForPercent(p) {
  if (p >= 80) return C.red;
  if (p >= 50) return C.yellow;
  return C.green;
}

function bar(percent, width = 24) {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return `${colorForPercent(percent)}${'█'.repeat(filled)}${C.dim}${'░'.repeat(width - filled)}${C.reset}`;
}

function fmtMB(mb) {
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

function fmtUptime(ms) {
  if (!ms || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}g ${h}sa`;
  if (h > 0) return `${h}sa ${m}dk`;
  return `${m}dk`;
}

function pm2JList() {
  return new Promise((resolve) => {
    // pm2 can print upgrade banners on stdout; take the last JSON array found.
    // exec (not execFile) so this resolves pm2.cmd on Windows too.
    exec('pm2 jlist', { maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const start = stdout.indexOf('[');
      const end = stdout.lastIndexOf(']');
      if (start === -1 || end === -1) return resolve(null);
      try {
        resolve(JSON.parse(stdout.slice(start, end + 1)));
      } catch (e) {
        resolve(null);
      }
    });
  });
}

function pad(str, width, right = false) {
  const s = String(str);
  // Rough width: ANSI codes are stripped before measuring.
  const visible = s.replace(/\x1b\[[0-9;]*m/g, '');
  const padding = ' '.repeat(Math.max(0, width - visible.length));
  return right ? padding + s : s + padding;
}

async function render() {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = totalBytes - freeBytes;
  const totalMB = toMB(totalBytes);

  const lines = [];
  lines.push('');
  lines.push(`${C.bold}${C.cyan}  AnucVC · RAM Raporu${C.reset}  ${C.dim}${new Date().toLocaleString('tr-TR')}${C.reset}`);
  lines.push(`${C.dim}  ${os.type()} ${os.release()} · ${os.cpus().length} çekirdek · cihaz açık: ${fmtUptime(os.uptime() * 1000)}${C.reset}`);
  lines.push('');

  const procs = await pm2JList();

  if (procs && procs.length > 0) {
    lines.push(`${C.bold}  PM2 SÜREÇLERİ${C.reset}`);
    lines.push(`${C.dim}  ${pad('ad', 18)}${pad('durum', 10)}${pad('RAM', 12)}${pad('RAM %', 9)}${pad('CPU %', 8)}${pad('yeniden', 9)}çalışma${C.reset}`);
    lines.push(`${C.dim}  ${'─'.repeat(74)}${C.reset}`);

    let totalProcMB = 0;
    for (const p of procs) {
      const env = p.pm2_env || {};
      const mon = p.monit || {};
      const memMB = toMB(mon.memory || 0);
      const memPct = pct(mon.memory || 0, totalBytes);
      totalProcMB += memMB;

      const statusColor = env.status === 'online' ? C.green : C.red;
      lines.push(
        '  ' +
        pad(p.name || `id:${p.pm_id}`, 18) +
        pad(`${statusColor}${env.status || '?'}${C.reset}`, 10) +
        pad(fmtMB(memMB), 12) +
        pad(`${colorForPercent(memPct)}${memPct.toFixed(1)}%${C.reset}`, 9) +
        pad(`${(mon.cpu || 0).toFixed(1)}%`, 8) +
        pad(String(env.restart_time ?? 0), 9) +
        fmtUptime(env.pm_uptime ? Date.now() - env.pm_uptime : 0)
      );
    }

    const totalPct = pct(totalProcMB * MB, totalBytes);
    lines.push(`${C.dim}  ${'─'.repeat(74)}${C.reset}`);
    lines.push(
      `  ${C.bold}${pad('TOPLAM', 28)}${pad(fmtMB(totalProcMB), 12)}${colorForPercent(totalPct)}${totalPct.toFixed(1)}%${C.reset}`
    );
    lines.push(`  ${bar(totalPct)}  ${C.dim}pm2 süreçleri / cihaz RAM${C.reset}`);
  } else {
    const self = process.memoryUsage().rss;
    lines.push(`${C.yellow}  pm2 bulunamadı veya çalışan süreç yok.${C.reset}`);
    lines.push(`  Bu Node süreci: ${fmtMB(toMB(self))} (${pct(self, totalBytes).toFixed(1)}%)`);
  }

  const sysPct = pct(usedBytes, totalBytes);
  lines.push('');
  lines.push(`${C.bold}  CİHAZ RAM${C.reset}`);
  lines.push(
    `  Kullanılan ${C.bold}${fmtMB(toMB(usedBytes))}${C.reset} / ${fmtMB(totalMB)}  ` +
    `${colorForPercent(sysPct)}${sysPct.toFixed(1)}%${C.reset}   ${C.dim}boşta ${fmtMB(toMB(freeBytes))}${C.reset}`
  );
  lines.push(`  ${bar(sysPct)}`);
  lines.push('');

  const out = lines.join('\n');
  if (WATCH) {
    process.stdout.write('\x1b[2J\x1b[H' + out + `${C.dim}  (çıkmak için Ctrl+C)${C.reset}\n`);
  } else {
    process.stdout.write(out);
  }
}

if (WATCH) {
  await render();
  setInterval(render, INTERVAL_MS);
} else {
  await render();
}
