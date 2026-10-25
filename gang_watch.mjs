#!/usr/bin/env node
// gang_watch.mjs — Gang market monitor bridge for the panel.
// Spawns `gang watch` (market mode, NDJSON), records events + heartbeat to
// ~/.config/gang-watch-{status,events}.json — same shape as four_watch's files,
// so ptah_panel.py /status & /events can merge both sources.
//
// Dry-run by default: records events only. GANG_ARM=1 is reserved for live
// buying (quote → preview → execute) and is NOT implemented yet — the process
// refuses to start with GANG_ARM=1 rather than silently doing nothing live.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import readline from 'node:readline';

const CFG = {
  bin: process.env.GANG_BIN || 'gang',
  interval: Number(process.env.GANG_INTERVAL || 5),   // market min is 10s; CLI clamps
  minPct: Number(process.env.GANG_MIN_PCT || 50),
  eventsMax: 100,
  armed: process.env.GANG_ARM === '1',
};
const STATUS_PATH = process.env.GANG_STATUS || (homedir() + '/.config/gang-watch-status.json');
const EVENTS_PATH = process.env.GANG_EVENTS || (homedir() + '/.config/gang-watch-events.json');

if (CFG.armed) {
  console.error('gang_watch: GANG_ARM=1 live buying is not implemented yet — running dry only. Unset GANG_ARM.');
  process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

let evCount = 0, watching = null;
function writeStatus(extra = {}) {
  const rec = {
    ts: Date.now(), pid: process.pid, source: 'gang', armed: false,
    mode: watching?.mode || 'market', tokens: watching?.tokens ?? 0,
    intervalSec: watching?.intervalSec ?? null, events: evCount,
    lastEventAt: extra.lastEventAt || null, ...extra,
  };
  try { writeFileSync(STATUS_PATH, JSON.stringify(rec, null, 2)); } catch {}
}
function pushEvent(ev) {
  let arr = [];
  try { arr = JSON.parse(readFileSync(EVENTS_PATH, 'utf8')); } catch {}
  arr.unshift({ ts: Date.now(), source: 'gang', ...ev });
  try { writeFileSync(EVENTS_PATH, JSON.stringify(arr.slice(0, CFG.eventsMax), null, 2)); } catch {}
  evCount++;
}
function notify(title, body) {
  // best-effort desktop notification, never blocks; strip anything that
  // could break the AppleScript string (on-chain names are untrusted input).
  const clean = s => String(s).replace(/["\\\n\r]/g, ' ').slice(0, 120);
  const s = `display notification "${clean(body)}" with title "${clean(title)}"`;
  spawn('osascript', ['-e', s], { stdio: 'ignore' }).on('error', () => {});
}

const LABEL = {
  new_token: '新币上线', near_grad: '临近毕业', graduated: '已毕业',
  trade: '成交', progress: '进度',
};

function handleLine(line) {
  line = line.trim();
  if (!line.startsWith('{')) return;
  let d; try { d = JSON.parse(line); } catch { return; }
  const ev = d.event;
  if (ev === 'watching') {
    watching = d;
    writeStatus();
    return;
  }
  if (ev === 'timeout') return;                 // heartbeat already covers liveness
  if (ev === 'error') { log('[gang] watcher error:', d.error || d); writeStatus({ lastError: String(d.error || '') }); return; }
  // business events: keep the raw record; extract common fields defensively.
  const token = d.token || d.address || '';
  pushEvent({
    type: ev, token,
    symbol: d.symbol || '',
    label: LABEL[ev] || ev,
    pct: d.progressPct ?? d.pct ?? null,
    track: d.track || null,
    quote: d.quote || null,
    raw: d,
  });
  writeStatus({ lastEventAt: Date.now() });
  if (ev === 'new_token') notify('Gang 新币', `${d.symbol || token} 上线(${d.track || '?'})`);
  if (ev === 'graduated') notify('Gang 毕业', `${d.symbol || token} 已毕业上 PancakeSwap`);
  log('[gang]', ev, d.symbol || token, d.progressPct != null ? d.progressPct.toFixed(1) + '%' : '');
}

function start() {
  const args = ['watch', '--interval', String(CFG.interval), '--min-pct', String(CFG.minPct)];
  const child = spawn(CFG.bin, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  log('gang_watch start · pid', process.pid, '· mode 模拟 ·', CFG.bin, args.join(' '));
  writeStatus();
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', handleLine);
  child.stderr.on('data', b => { const t = String(b).trim(); if (t && !t.includes('Warning')) log('[gang:stderr]', t.slice(0, 200)); });
  child.on('exit', (code) => {
    log('[gang] watcher exited (code ' + code + ') — restarting in 3s');
    writeStatus({ lastError: 'watcher exit ' + code });
    setTimeout(start, 3000);
  });
}
start();
// heartbeat even if `gang watch` is quiet between events
setInterval(() => writeStatus(), 10000);
