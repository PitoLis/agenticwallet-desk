#!/usr/bin/env node
'use strict';
// stock_snipe.mjs — snipe the first N four.meme Binance Agent ID Exclusive tokens
// (preset 1778027615735) whose bonding curve is quoted in a stock token
// (BNC4 / NVDAB / BNCB / SPCXB / SKHYB).
//
// Per hit:
//   1. Buy exactly SNIPE_TARGET tokens (default 10,000,000 = 1% of supply, the
//      per-wallet cap) via OpenFourCore.buy(token, amount, maxQuotePay, 0, 0x).
//   2. Pay with stock tokens already in the wallet; if short, swap BNB → that
//      stock token for the shortfall first (baw market-order).
//   3. Once the token leaves the bonding curve (tokenPhase != 1, transfers
//      unlocked), send the whole position to SNIPE_FORWARD_TO.
// Every on-chain step goes through baw (preview → execute); keys never leave the wallet.
//
// Env:
//   SNIPE_ARM=1                real trades (default: simulate, no orders placed)
//   SNIPE_MAX=6                stop buying after this many tokens
//   SNIPE_TARGET=10000000      tokens to buy per hit (whole tokens)
//   SNIPE_POLL_MS=500          head polling interval
//   SNIPE_SLIPPAGE=10          % headroom on the stock spend for curve movement
//   SNIPE_FORWARD_TO=0x…       where to send tokens once transferable

import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFileSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import WebSocket from 'ws';
import {keccak_256} from '@noble/hashes/sha3.js';
const run = promisify(execFile);

const CORE = '0xebe7b6c1089d9f72ad07f34e36d898e44e5e27f3';
const TOOLS = '0x97da82f56fef1a0b974587a48135fa9da2a4e905';
const BNB = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const TC_TOPIC = '0x7dae4dcd1b20eb0445e7cc1d02b3e2e7f32fa63081a0e764732c269f2b8f228f';
const PRESET = BigInt(process.env.SNIPE_PRESET || '1778027615735');
const PRESET_TOPIC = '0x' + PRESET.toString(16).padStart(64, '0');
const STOCKS = {
  '0x7c8d5502b544ddaf8852fc46d1174e34876d545c': 'BNC4',
  '0x02fca66c1d1afb4e2a7884261eb00f63598a7436': 'NVDAB',
  '0x4902c5ebc598265ed2212b559b042de8a5eeec3f': 'BNCB',
  '0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1': 'SPCXB',
  '0xca750ef65f295bbecd685abf54e82caf297bdb61': 'SKHYB',
};
const CFG = {
  armed: process.env.SNIPE_ARM === '1',
  max: Number(process.env.SNIPE_MAX || 6),
  target: BigInt(process.env.SNIPE_TARGET || '10000000') * 10n ** 18n,
  pollMs: Number(process.env.SNIPE_POLL_MS || 500),
  slippage: Number(process.env.SNIPE_SLIPPAGE || 10),
  forwardTo: (process.env.SNIPE_FORWARD_TO || '0x4127a425021408c260ff6b31b1c419ae3d4e6216').toLowerCase(),
  wss: (process.env.SNIPE_WSS || 'wss://bsc-rpc.publicnode.com,wss://bsc.publicnode.com').split(','),
  rpcs: (process.env.SNIPE_RPC || 'https://bsc-dataseed.binance.org,https://bsc.publicnode.com').split(','),
  statePath: homedir() + '/.config/stock-snipe-state.json',
  statusPath: homedir() + '/.config/stock-snipe-status.json',
  eventsPath: homedir() + '/.config/four-watch-events.json', // shared with the panel's event feed
};
if (!/^0x[0-9a-f]{40}$/.test(CFG.forwardTo)) throw new Error('SNIPE_FORWARD_TO 不是有效地址');

const log = (...a) => console.log(new Date().toISOString(), ...a);
const env = () => ({...process.env, NODE_USE_ENV_PROXY: '1'});
const sel = s => '0x' + Buffer.from(keccak_256(new TextEncoder().encode(s))).toString('hex').slice(0, 8);
const word = x => BigInt(x).toString(16).padStart(64, '0');
const addrWord = a => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const enc = (sig, ...args) => sel(sig) + args.map(a => (typeof a === 'string' && a.length === 42) ? addrWord(a) : word(a)).join('');
const words = hex => (hex || '0x').slice(2).match(/.{64}/g) || [];
const fromWei = v => { const s = BigInt(v).toString().padStart(19, '0'); return (s.slice(0, -18) + '.' + s.slice(-18)).replace(/\.?0+$/, '') || '0'; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadState() { let s; try { s = JSON.parse(readFileSync(CFG.statePath, 'utf8')); } catch { s = {}; } s.bought ||= {}; s.skipped ||= {}; return s; }
const saveState = s => writeFileSync(CFG.statePath, JSON.stringify(s, null, 2));
function pushEvent(ev) {
  let arr = []; try { arr = JSON.parse(readFileSync(CFG.eventsPath, 'utf8')); } catch {}
  arr.unshift({ts: Date.now(), ...ev}); try { writeFileSync(CFG.eventsPath, JSON.stringify(arr.slice(0, 100), null, 2)); } catch {}
}
function notify(title, msg) {
  const e = s => String(s).replace(/["\\]/g, '\\$&');
  run('osascript', ['-e', `display notification "${e(msg)}" with title "${e(title)}" sound name "Hero"`], {timeout: 5000}).catch(() => {});
}

function parseJsonLoose(s) {
  s = s.trim(); const a = ['{', '['].map(c => s.indexOf(c)).filter(i => i >= 0), e = ['}', ']'].map(c => s.lastIndexOf(c)).filter(i => i >= 0);
  if (!a.length) throw new Error('no JSON'); return JSON.parse(s.slice(Math.min(...a), Math.max(...e) + 1));
}
async function baw(args, timeout = 60000) {
  try { const {stdout} = await run('baw', [...args, '--json'], {timeout, maxBuffer: 4e6, env: env()}); return parseJsonLoose(stdout); }
  catch (e) { try { return parseJsonLoose(e.stdout || ''); } catch { return {success: false, error: {message: e.message.split('\n')[0]}}; } }
}
let rpcIdx = 0;
async function rpc(method, params) {
  let last;
  for (let i = 0; i < CFG.rpcs.length; i++) {
    const url = CFG.rpcs[(rpcIdx + i) % CFG.rpcs.length];
    try {
      const r = await fetch(url, {method: 'POST', headers: {'content-type': 'application/json', 'user-agent': 'agent-desk'},
        body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params}), signal: AbortSignal.timeout(8000)});
      const j = await r.json(); if (j.error) throw new Error(j.error.message);
      rpcIdx = (rpcIdx + i) % CFG.rpcs.length; return j.result;
    } catch (e) { last = e; }
  }
  throw last;
}
const call = (to, data) => rpc('eth_call', [{to, data}, 'latest']);
const balanceOf = async (t, w) => BigInt(await call(t, enc('balanceOf(address)', w)) || '0x0');
const allowance = async (t, o, s) => BigInt(await call(t, enc('allowance(address,address)', o, s)) || '0x0');
const tokenPhase = async t => Number(BigInt(await call(t, sel('tokenPhase()')) || '0x0'));

let WALLET = null;
let busy = false;
const status = {startedAt: Date.now(), hits: 0, lastHit: null, head: 0, wss: 0};
function writeStatus() {
  const s = loadState();
  try { writeFileSync(CFG.statusPath, JSON.stringify({...status, ts: Date.now(), pid: process.pid, armed: CFG.armed, max: CFG.max,
    target: fromWei(CFG.target), forwardTo: CFG.forwardTo, pollMs: CFG.pollMs,
    bought: Object.keys(s.bought).length, forwarded: Object.values(s.bought).filter(b => b.forwarded).length,
    skipped: Object.keys(s.skipped).length}, null, 2)); } catch {}
}

async function waitFor(fn, ms = 45000, step = 1000) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await fn()) return true; await sleep(step); }
  return false;
}
async function waitOrder(id) {
  for (let i = 0; i < 40; i++) {
    const row = (await baw(['market-order', 'list', '--orderId', String(id)]))?.data?.list?.[0];
    if (row?.status === 'FINISHED' || row?.status === 'FAILED') return row;
    await sleep(1500);
  }
  return null;
}
async function contractCall(to, data, valueWei = 0n) {
  const pv = await baw(['contract-call', 'preview', '--binanceChainId', '56', '--from', WALLET, '--to', to, '--value', String(valueWei), '--inputData', data]);
  if (!pv.success) return {ok: false, stage: 'preview', error: pv.error?.message};
  const ex = await baw(['contract-call', 'execute', '--requestId', pv.data.requestId]);
  if (!ex.success) return {ok: false, stage: 'execute', error: ex.error?.message};
  if (ex.data?.status === 'PENDING_CONFIRMATION') return {ok: false, stage: 'confirm', pending: true, error: ex.data.message || '需要在 App 里确认', data: ex.data};
  return {ok: true, data: ex.data};
}

// Stock cost (quote asset, incl. fee) to buy exactly `amount` tokens on the curve.
async function costFor(token, amount) {
  const w = words(await call(TOOLS, enc('estimateBuy(address,address,uint256,uint256,bytes)', token, WALLET, amount, 0n, 160n, 0n)));
  return {pay: BigInt('0x' + (w[2] || '0')), got: BigInt('0x' + (w[4] || '0'))};
}

// Swap BNB → stock for at least `need` units. baw takes a BNB input, so size it
// from a 1-BNB quote and pad 3% for price drift; whatever lands extra stays as stock.
async function topUpStock(stock, sym, need) {
  const q = await baw(['market-order', 'quote', '--binanceChainId', '56', '--fromTokenQty', '1', '--fromToken', BNB, '--toToken', stock, '--slippage', 'auto']);
  if (!q.success) return {ok: false, reason: 'BNB→' + sym + ' 报价失败: ' + q.error?.message};
  const perBnb = Number(q.data.toCoinAmount);
  if (!(perBnb > 0)) return {ok: false, reason: 'BNB→' + sym + ' 报价为 0'};
  const bnbIn = (Number(fromWei(need)) / perBnb * 1.03).toFixed(8).replace(/\.?0+$/, '');
  log(`  换 ${sym}：需要 ${fromWei(need)}，用 ${bnbIn} BNB 去换`);
  const sw = await baw(['market-order', 'swap', '--binanceChainId', '56', '--fromTokenQty', bnbIn, '--fromToken', BNB, '--toToken', stock,
    '--slippage', 'auto', '--mev', 'true', '--gasLevel', 'HIGH']);
  if (!sw.success) return {ok: false, reason: '换 ' + sym + ' 失败: ' + sw.error?.message};
  const row = await waitOrder(sw.data.orderId);
  if (row?.status !== 'FINISHED') return {ok: false, reason: '换 ' + sym + ' 未成交（订单 ' + sw.data.orderId + '）'};
  return {ok: true, bnbIn};
}

async function snipe(token, stock, sym) {
  const t0 = Date.now();
  const {pay, got} = await costFor(token, CFG.target);
  if (pay === 0n || got === 0n) return {ok: false, reason: '曲线报价为 0（不可买、已毕业或钱包已达上限）'};
  const maxPay = pay + pay * BigInt(CFG.slippage) / 100n;
  const have = await balanceOf(stock, WALLET);
  log(`  买 ${fromWei(got)} 个 需要 ${fromWei(pay)} ${sym}（上限 ${fromWei(maxPay)}），钱包有 ${fromWei(have)} ${sym}`);
  if (!CFG.armed) return {ok: true, sim: true, pay, maxPay, have};

  if (have < maxPay) {
    const tu = await topUpStock(stock, sym, maxPay - have);
    if (!tu.ok) return {ok: false, reason: tu.reason};
    if (!(await waitFor(async () => await balanceOf(stock, WALLET) >= maxPay))) {
      const now = await balanceOf(stock, WALLET);
      if (now < pay) return {ok: false, reason: `${sym} 到账不足（${fromWei(now)} < ${fromWei(pay)}）`};
    }
  }
  const spendCap = (await balanceOf(stock, WALLET)) < maxPay ? await balanceOf(stock, WALLET) : maxPay;
  if (await allowance(stock, WALLET, CORE) < spendCap) {
    const ap = await contractCall(stock, enc('approve(address,uint256)', CORE, spendCap));
    if (!ap.ok) return {ok: false, reason: '授权失败: ' + ap.error};
    await waitFor(async () => await allowance(stock, WALLET, CORE) >= spendCap, 30000);
  }
  const by = await contractCall(CORE, enc('buy(address,uint256,uint256,uint256,bytes)', token, CFG.target, spendCap, 0n, 160n, 0n));
  if (!by.ok) return {ok: false, reason: (by.pending ? '等待 App 确认: ' : '曲线买入失败: ') + by.error, pending: by.pending, order: by.data?.orderId};
  return {ok: true, tx: by.data?.txHash || by.data?.orderId, ms: Date.now() - t0};
}

// Forward bought tokens once the curve ends and transfers unlock.
async function forwardTick() {
  const s = loadState();
  for (const [token, b] of Object.entries(s.bought)) {
    if (b.forwarded || b.forwarding) continue;
    let phase; try { phase = await tokenPhase(token); } catch { continue; }
    if (phase === 1) continue; // still on the bonding curve: non-transferable
    const bal = await balanceOf(token, WALLET);
    if (bal === 0n) { s.bought[token].forwarded = {at: Date.now(), amount: '0', note: '持仓为 0'}; saveState(s); continue; }
    log('[forward]', token, 'phase', phase, '→ 转', fromWei(bal), '到', CFG.forwardTo);
    s.bought[token].forwarding = true; saveState(s);
    const r = await baw(['wallet', 'send', '--binanceChainId', '56', '--tokenAddress', token, '--amount', fromWei(bal),
      '--recipient', CFG.forwardTo, '--gasLevel', 'HIGH']);
    const s2 = loadState();
    delete s2.bought[token].forwarding;
    if (r.success) {
      s2.bought[token].forwarded = {at: Date.now(), amount: fromWei(bal), tx: r.data?.txHash || null};
      log('  已转出', r.data?.txHash || '');
      notify('股票底池代币已转出', `${token}\n${fromWei(bal)} → ${CFG.forwardTo}`);
      pushEvent({type: 'forwarded', token, amount: fromWei(bal), to: CFG.forwardTo, tx: r.data?.txHash || null});
    } else {
      log('  转出失败:', r.error?.message);
    }
    saveState(s2);
  }
}

async function handle(logs) {
  for (const l of logs) {
    const w = (l.data || '0x').slice(2).match(/.{64}/g) || [];
    const quote = ('0x' + (w[7] || '').slice(24)).toLowerCase();
    const sym = STOCKS[quote];
    if (!sym) continue;
    const token = ('0x' + l.topics[3].slice(26)).toLowerCase();
    const st = loadState();
    if (st.bought[token] || st.skipped[token]) continue;
    if (Object.keys(st.bought).length >= CFG.max) { log('已买满', CFG.max, '个，不再买入', token); continue; }
    status.hits++; status.lastHit = {token, sym, block: parseInt(l.blockNumber, 16)};
    log('[hit]', sym, '底池新币', token, 'block', parseInt(l.blockNumber, 16));
    if (busy) { log('  上一笔还在进行，排队稍后'); continue; }
    busy = true;
    try {
      const r = await snipe(token, quote, sym);
      const s2 = loadState(), now = Math.floor(Date.now() / 1000);
      if (r.ok && r.sim) { log('  模拟：可买入，未下单'); s2.skipped[token] = {at: now, reason: 'simulated'}; }
      else if (r.ok) {
        s2.bought[token] = {at: now, stock: sym, target: fromWei(CFG.target), tx: r.tx};
        log('  BOUGHT', token, r.ms + 'ms', 'tx', r.tx);
        notify('股票底池狙击成交', `${sym} 底池 ${token}\n已买 ${fromWei(CFG.target)} 个`);
        pushEvent({type: 'bought', token, stock: sym, amount: fromWei(CFG.target), tx: r.tx});
      } else {
        s2.skipped[token] = {at: now, reason: r.reason, order: r.order};
        log('  跳过:', r.reason);
        if (r.pending) notify('股票底池狙击待确认', `${token}\n请在币安钱包 App 里确认买入`);
      }
      saveState(s2);
    } finally { busy = false; writeStatus(); }
  }
}

let lastScanned = 0;
async function scanTo(head) {
  if (!lastScanned) lastScanned = head - 1;
  if (head <= lastScanned) return;
  const from = lastScanned + 1;
  try {
    const logs = await rpc('eth_getLogs', [{address: CORE, topics: [TC_TOPIC, PRESET_TOPIC], fromBlock: '0x' + from.toString(16), toBlock: '0x' + head.toString(16)}]);
    lastScanned = head; status.head = head;
    logs.sort((a, b) => parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16) || parseInt(a.logIndex, 16) - parseInt(b.logIndex, 16));
    await handle(logs);
  } catch (e) { log('[scan]', e.message.slice(0, 70)); }
}
function startWss(url) {
  const ws = new WebSocket(url, {handshakeTimeout: 8000}); let up = false;
  ws.on('open', () => ws.send(JSON.stringify({jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads']})));
  ws.on('message', m => { let d; try { d = JSON.parse(m); } catch { return; }
    if (d.id === 1 && d.result) { up = true; status.wss++; log('[wss] subscribed', url); return; }
    const n = d.params?.result?.number; if (n) scanTo(parseInt(n, 16)); });
  ws.on('error', e => log('[wss] error', e.message.slice(0, 50)));
  ws.on('close', () => { if (up) status.wss = Math.max(0, status.wss - 1); setTimeout(() => startWss(url), 2000); });
  setInterval(() => { try { ws.ping(); } catch {} }, 15000);
}

async function main() {
  const w = await baw(['wallet', 'address']);
  WALLET = w?.data?.addresses?.find(x => x.binanceChainId === '56')?.address;
  if (!WALLET) throw new Error('baw 钱包未登录');
  const head = parseInt(await rpc('eth_blockNumber', []), 16); lastScanned = head;
  log(`stock_snipe start · ${CFG.armed ? '实盘' : '模拟'} · 钱包 ${WALLET} · 模板 ${PRESET} · 每个买 ${fromWei(CFG.target)} 个 · 最多 ${CFG.max} 个 · ${CFG.pollMs}ms 轮询 · 可转移后转到 ${CFG.forwardTo} · head ${head}`);
  for (const u of CFG.wss) startWss(u.trim());
  writeStatus();
  (async function fwd() { for (;;) { try { await forwardTick(); } catch (e) { log('[forward]', e.message.slice(0, 60)); } await sleep(5000); } })();
  for (;;) {
    await sleep(CFG.pollMs);
    try { await scanTo(parseInt(await rpc('eth_blockNumber', []), 16)); } catch (e) { log('[poll]', e.message.slice(0, 60)); }
    if (Date.now() % 5000 < CFG.pollMs) writeStatus();
  }
}

if (process.argv[2] === 'replay') {
  // node stock_snipe.mjs replay <fromBlock> <toBlock> [presetOverride] — simulate classification + quote on past blocks
  (async () => {
    const w = await baw(['wallet', 'address']); WALLET = w.data.addresses.find(x => x.binanceChainId === '56').address;
    CFG.armed = false; CFG.statePath = '/tmp/stock-snipe-replay.json';
    const [f, t] = process.argv.slice(3, 5).map(Number);
    const topics = process.argv[5] ? [TC_TOPIC, '0x' + BigInt(process.argv[5]).toString(16).padStart(64, '0')] : [TC_TOPIC, PRESET_TOPIC];
    for (let b = f; b <= t; b += 5000) {
      const logs = await rpc('eth_getLogs', [{address: CORE, topics, fromBlock: '0x' + b.toString(16), toBlock: '0x' + Math.min(b + 4999, t).toString(16)}]);
      await handle(logs);
    }
    process.exit(0);
  })().catch(e => { log('fatal', e.message); process.exit(1); });
} else {
  main().catch(e => { log('fatal', e.message); process.exit(1); });
}
