#!/usr/bin/env node
'use strict';
// four_watch.mjs — latency-optimized watcher for the four.meme V12 Agent ID
// Exclusive preset (1778027615735). Event-driven: subscribe to BSC newHeads over
// WebSocket, and the instant a block arrives, pull that block's OpenFourCore
// TokenCreated logs filtered to our preset. On a hit, immediately preview→execute
// a fixed-BNB buy through baw (keys stay in baw). If a token can't be bought
// (whitelist/revert), it's marked skipped and we move to the next token.
//
// Speed choices (all within the baw trust boundary):
//   - WSS newHeads push instead of interval polling (discovery ≈ block time).
//   - Wallet address cached at startup (saves ~0.34s per buy).
//   - Calldata prebuilt per token with zero extra encoding round-trips.
//   - Buys are serialized with a lock; each token is attempted once.
// Hard floor: baw preview+execute ≈ 1.2s total — that is the real-trade latency.

import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {homedir} from 'node:os';
import WebSocket from 'ws';
import {keccak_256} from '@noble/hashes/sha3.js';
const run = promisify(execFile);

const CFG = {
  core: '0xebe7b6c1089d9f72ad07f34e36d898e44e5e27f3',
  presetId: BigInt(process.env.FOUR_PRESET || '1778027615735'),
  budgetBnb: process.env.FOUR_BUDGET_BNB || '0.01',
  wss: (process.env.FOUR_WSS || 'wss://bsc-rpc.publicnode.com,wss://bsc.publicnode.com').split(','),
  // getLogs endpoints (comma-separated, rotated on error). publicnode works
  // without a key; add your own keyed endpoint (e.g. nodereal/alchemy) via
  // FOUR_LOGS_RPC for higher throughput. Never commit a keyed URL here.
  logsRpcs: (process.env.FOUR_LOGS_RPC ||
    'https://bsc.publicnode.com').split(','),
  fallbackPollMs: Number(process.env.FOUR_FALLBACK_MS || 2000),
  excludeTokens: new Set(['0x3bdf234051a86166f00a5b72c3ddd7fd1b9fffff']),
  statePath: process.env.FOUR_STATE || (homedir() + '/.config/four-watch-state.json'),
  armed: process.env.FOUR_ARM === '1',
};
const TC_TOPIC = '0x7dae4dcd1b20eb0445e7cc1d02b3e2e7f32fa63081a0e764732c269f2b8f228f';
const PRESET_TOPIC = '0x' + CFG.presetId.toString(16).padStart(64, '0');
const BUY_SEL = '0x' + Buffer.from(keccak_256(new TextEncoder().encode('buyByBudget(address,uint256,uint256,uint256,bytes)'))).toString('hex').slice(0, 8);

const log = (...a) => console.log(new Date().toISOString(), ...a);
const env = () => ({...process.env, NODE_USE_ENV_PROXY: '1'});
const pad = x => BigInt(x).toString(16).padStart(64, '0');

// macOS desktop notification (best-effort; never throws into the hot path).
function notify(title, message, sound = 'Glass') {
  const esc = s => String(s).replace(/["\\]/g, '\\$&');
  run('osascript', ['-e', `display notification "${esc(message)}" with title "${esc(title)}" sound name "${sound}"`],
      {timeout: 5000}).catch(() => {});
}
// Append an event the panel can read (/events endpoint).
const EVENTS_PATH = process.env.FOUR_EVENTS || (homedir() + '/.config/four-watch-events.json');
const STATUS_PATH = process.env.FOUR_STATUS || (homedir() + '/.config/four-watch-status.json');
function writeStatus(extra = {}) {
  const st = loadState();
  const rec = {
    ts: Date.now(), pid: process.pid, armed: CFG.armed,
    budgetBnb: CFG.budgetBnb, preset: CFG.presetId.toString(),
    presetName: 'Binance Agent ID Exclusive',
    head: lastScanned, lastScanAt,
    bought: Object.keys(loadState().bought).length,
    skipped: Object.keys(loadState().skipped).length,
    wss: wssUp, ...extra,
  };
  try { writeFileSync(STATUS_PATH, JSON.stringify(rec, null, 2)); } catch {}
}
let wssUp = 0;
function pushEvent(ev) {
  let arr = [];
  try { arr = JSON.parse(readFileSync(EVENTS_PATH, 'utf8')); } catch {}
  arr.unshift({ts: Date.now(), ...ev});
  try { writeFileSync(EVENTS_PATH, JSON.stringify(arr.slice(0, 100), null, 2)); } catch {}
}

function loadState() {
  let s; try { s = JSON.parse(readFileSync(CFG.statePath, 'utf8')); } catch { s = {}; }
  s.seen ||= {}; s.bought ||= {}; s.skipped ||= {};
  return s;
}
const saveState = s => writeFileSync(CFG.statePath, JSON.stringify(s, null, 2));

function parseJsonLoose(stdout) {
  const s = stdout.trim();
  const starts = ['{', '['].map(c => s.indexOf(c)).filter(i => i >= 0);
  if (!starts.length) throw new Error('no JSON in output');
  const ends = ['}', ']'].map(c => s.lastIndexOf(c)).filter(i => i >= 0);
  return JSON.parse(s.slice(Math.min(...starts), Math.max(...ends) + 1));
}
async function baw(args, timeout = 45000) {
  const {stdout} = await run('baw', [...args, '--json'], {timeout, maxBuffer: 4 * 1024 * 1024, env: env()});
  return parseJsonLoose(stdout);
}
let rpcIdx = 0;
async function rpc(method, params) {
  // Rotate across RPCs; on rate-limit/error, advance and try the next one.
  let lastErr;
  for (let i = 0; i < CFG.logsRpcs.length; i++) {
    const url = CFG.logsRpcs[(rpcIdx + i) % CFG.logsRpcs.length];
    try {
      const r = await fetch(url, {
        method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params}), signal: AbortSignal.timeout(10000)
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      rpcIdx = (rpcIdx + i) % CFG.logsRpcs.length; // stick to the one that worked
      return j.result;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('all RPCs failed');
}

function toWei(bnb) { const [a, b = ''] = String(bnb).split('.'); return BigInt(a + (b + '0'.repeat(18)).slice(0, 18)).toString(); }
const BUDGET_WEI = toWei(CFG.budgetBnb);
function buyCalldata(token) {
  return BUY_SEL + pad(token) + pad(BUDGET_WEI) + pad(0) + pad(0) + pad(160) + pad(0);
}

let WALLET = null;
let buyLock = false;
const TOOLS = '0x97da82f56fef1a0b974587a48135fa9da2a4e905'; // OpenFourTools (estimate)

// Current token price via GMGN (USD price per token). Returns a JS number or null.
// GMGN tracks four.meme/openfour tokens and returns a live price even on the
// bonding curve, which the on-chain estimate can report as 0 at low liquidity.
function gmgnKey() {
  const p = homedir() + '/.config/gmgn/.env';
  const m = existsSync(p) && readFileSync(p, 'utf8').match(/^GMGN_API_KEY=(.+)$/m);
  return m ? m[1].trim() : (process.env.GMGN_API_KEY || '');
}
async function entryPrice(token) {
  const {stdout} = await run('gmgn-cli', ['token', 'info', '--chain', 'bsc', '--address', token, '--raw'],
    {timeout: 25000, maxBuffer: 8 * 1024 * 1024, env: {...env(), GMGN_API_KEY: gmgnKey()}});
  const d = parseJsonLoose(stdout);
  const data = d.data || d;
  const p = (data.price && typeof data.price === 'object') ? data.price.price : data.price;
  const n = Number(p);
  return isFinite(n) && n > 0 ? n : null;
}

// Poll bought tokens; alert once when price reaches 10x entry. Alert only (no sell).
async function priceWatchTick() {
  const state = loadState();
  const toks = Object.entries(state.bought).filter(([, v]) => v && v.entryPrice && !v.tenxAlerted);
  for (const [token, v] of toks) {
    let cur = null;
    try { cur = await entryPrice(token); } catch { continue; }
    if (!cur) continue;
    const mult = cur / v.entryPrice;
    if (mult >= 10) {
      state.bought[token].tenxAlerted = true;
      state.bought[token].tenxAt = Math.floor(Date.now() / 1000);
      state.bought[token].tenxMult = Number(mult.toFixed(2));
      saveState(state);
      log('[10x]', token, 'reached', mult.toFixed(2) + 'x');
      notify('🚀 到 10 倍了', `${token}\n当前约 ${mult.toFixed(1)}x · 考虑出本（卖出不自动，税约2%）`, 'Glass');
      pushEvent({type: 'tenx', token, mult: Number(mult.toFixed(2)), entryPrice: v.entryPrice, price: cur});
    }
  }
}

async function tryBuy(token) {
  if (buyLock) return {ok: false, reason: 'locked'};
  if (loadState().bought[token]) return {ok: false, reason: 'bought'};
  buyLock = true;
  const t0 = Date.now();
  try {
    const data = buyCalldata(token);
    const pv = await baw(['contract-call', 'preview', '--binanceChainId', '56',
      '--from', WALLET, '--to', CFG.core, '--value', BUDGET_WEI, '--inputData', data]);
    if (!pv.success) return {ok: false, reason: pv.error?.message || 'preview failed'};
    if (!CFG.armed) { log('  BUYABLE (dry-run) req', pv.data.requestId, (Date.now() - t0) + 'ms'); return {ok: true, dryRun: true}; }
    const ex = await baw(['contract-call', 'execute', '--requestId', pv.data.requestId]);
    log('  execute', (Date.now() - t0) + 'ms', JSON.stringify(ex).slice(0, 200));
    return {ok: !!ex.success, result: ex};
  } catch (e) {
    return {ok: false, reason: e.message};
  } finally { buyLock = false; }
}

async function handleTokens(tokens, srcTag) {
  if (!tokens.length) return;
  const state = loadState();
  for (const tRaw of tokens) {
    const token = tRaw.toLowerCase();
    if (CFG.excludeTokens.has(token) || state.bought[token] || state.skipped[token]) continue;
    log(srcTag, 'AGENT-ID token', token);
    const r = await tryBuy(token);
    const now = Math.floor(Date.now() / 1000);
    if (r.ok && !r.dryRun) {
      const entry = await entryPrice(token).catch(() => null);
      state.bought[token] = {at: now, budgetBnb: CFG.budgetBnb, entryPrice: entry, tenxAlerted: false, result: r.result?.data || null};
      saveState(state);
      log(srcTag, 'BOUGHT', token, 'entryPrice', entry);
      notify('已买入 Agent ID 新币', `${token}\n${CFG.budgetBnb} BNB 已成交`, 'Hero');
      pushEvent({type: 'bought', token, budgetBnb: CFG.budgetBnb, entryPrice: entry, tx: r.result?.data?.txHash || r.result?.data?.orderId || null});
      return true;
    }
    if (r.ok && r.dryRun) { state.seen[token] = now; saveState(state); return true; }
    if (r.reason === 'locked' || r.reason === 'bought') continue;
    state.skipped[token] = {at: now, reason: (r.reason || '').slice(0, 120)};
    saveState(state);
    log(srcTag, 'not buyable, skip →', token, '·', (r.reason || '').slice(0, 60));
  }
  return false;
}

// Pull TokenCreated(preset) for a specific block (fast: 1-block range).
async function scanBlock(blockHex, srcTag) {
  let logs;
  try {
    logs = await rpc('eth_getLogs', [{address: CFG.core, topics: [TC_TOPIC, PRESET_TOPIC], fromBlock: blockHex, toBlock: blockHex}]);
  } catch (e) { log('[getLogs]', e.message.slice(0, 70)); return; }
  if (!logs.length) return;
  logs.sort((a, b) => parseInt(a.logIndex, 16) - parseInt(b.logIndex, 16));
  const tokens = logs.map(l => '0x' + l.topics[3].slice(26));
  log(srcTag, 'block', parseInt(blockHex, 16), 'TokenCreated', tokens.length);
  await handleTokens(tokens, srcTag);
}

// Throttled scan: WSS heads set a pending target; we getLogs at most once per
// SCAN_MIN_MS over the accumulated range. This keeps latency low (sub-second
// after a head) without hammering the public getLogs endpoint every block.
let pendingHead = 0, scanTimer = null, lastScanAt = 0;
const SCAN_MIN_MS = Number(process.env.FOUR_SCAN_MIN_MS || 1200);
function kickScan() {
  if (scanTimer) return;
  const wait = Math.max(0, SCAN_MIN_MS - (Date.now() - lastScanAt));
  scanTimer = setTimeout(async () => {
    scanTimer = null; lastScanAt = Date.now();
    const target = pendingHead;
    if (target > lastScanned) { try { await scanRange(target, '[wss]'); } catch (e) { log('[wss scan]', e.message.slice(0, 60)); } }
  }, wait);
}

// Catch-up range scan (startup + fallback), bounded.
let lastScanned = 0;
async function scanRange(toBlock, srcTag) {
  if (!lastScanned) lastScanned = toBlock - 1;
  if (toBlock <= lastScanned) return;
  const from = lastScanned + 1;
  let logs;
  try {
    logs = await rpc('eth_getLogs', [{address: CFG.core, topics: [TC_TOPIC, PRESET_TOPIC],
      fromBlock: '0x' + from.toString(16), toBlock: '0x' + toBlock.toString(16)}]);
  } catch (e) { log('[range]', e.message.slice(0, 70)); return; }
  lastScanned = toBlock;
  if (!logs.length) return;
  logs.sort((a, b) => parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16) || parseInt(a.logIndex, 16) - parseInt(b.logIndex, 16));
  await handleTokens(logs.map(l => '0x' + l.topics[3].slice(26)), srcTag);
}

function startWss(url) {
  let alive = false, hb;
  const ws = new WebSocket(url, {handshakeTimeout: 8000});
  ws.on('open', () => { ws.send(JSON.stringify({jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads']})); });
  ws.on('message', m => {
    let d; try { d = JSON.parse(m); } catch { return; }
    if (d.id === 1 && d.result) { alive = true; wssUp++; log('[wss] subscribed', url); writeStatus(); return; }
    if (d.method === 'eth_subscription' && d.params?.result?.number) {
      pendingHead = Math.max(pendingHead, parseInt(d.params.result.number, 16));
      kickScan();   // throttled: coalesces bursts into one ranged getLogs
    }
  });
  ws.on('error', e => log('[wss] error', url, e.message.slice(0, 50)));
  ws.on('close', () => { clearInterval(hb); if (alive) wssUp = Math.max(0, wssUp - 1); log('[wss] closed', url, '· reconnecting in 2s'); writeStatus(); setTimeout(() => startWss(url), 2000); });
  hb = setInterval(() => { try { ws.ping(); } catch {} }, 15000);
  return ws;
}

async function main() {
  const w = await baw(['wallet', 'address']);
  WALLET = w.data.addresses.find(x => x.binanceChainId === '56').address;
  let head = 0;
  for (let i = 0; i < 10 && !head; i++) {
    try { head = parseInt(await rpc('eth_blockNumber', []), 16); }
    catch (e) { log('startup head retry', i, e.message.slice(0, 50)); await new Promise(r => setTimeout(r, 2000)); }
  }
  lastScanned = head || 0;
  log('four_watch start · wallet', WALLET, '· budget', CFG.budgetBnb, 'BNB · armed', CFG.armed,
      '· preset', CFG.presetId.toString(), '· head', head, '· sources: wss+fallback');
  for (const u of CFG.wss) startWss(u.trim());
  // 10x price-watch for bought tokens (alert only).
  const pwMs = Number(process.env.FOUR_PRICEWATCH_MS || 15000);
  (async function pwloop() { for (;;) { try { await priceWatchTick(); } catch (e) { log('[10x]', e.message.slice(0, 60)); } await new Promise(r => setTimeout(r, pwMs)); } })();
  writeStatus();
  // HTTP fallback: if WSS misses blocks (reconnects), sweep the gap + heartbeat.
  for (;;) {
    await new Promise(r => setTimeout(r, CFG.fallbackPollMs));
    try { const h = parseInt(await rpc('eth_blockNumber', []), 16); await scanRange(h, '[poll]'); }
    catch (e) { log('[poll]', e.message.slice(0, 60)); }
    writeStatus();
  }
}

if (process.argv[2] === 'once') {
  (async () => {
    const w = await baw(['wallet', 'address']); WALLET = w.data.addresses.find(x => x.binanceChainId === '56').address;
    const head = parseInt(await rpc('eth_blockNumber', []), 16); lastScanned = head - 3;
    await scanRange(head, '[once]'); process.exit(0);
  })().catch(e => { log('fatal', e.message); process.exit(1); });
} else {
  main().catch(e => { log('fatal', e.message); process.exit(1); });
}
