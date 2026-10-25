#!/usr/bin/env node
'use strict';
// stock_snipe.mjs — snipe the first N four.meme Binance Agent ID Exclusive tokens
// (preset 1778027615735) whose bonding curve is quoted in a stock token
// (BNC4 / NVDAB / BNCB / SPCXB / SKHYB).
//
// Flow per hit:  BNB --baw market-order--> stock token --approve exact--> OpenFourCore.buyByBudget
// Every on-chain step goes through baw (preview -> execute); keys never leave the wallet.
//
// Env:
//   SNIPE_ARM=1            real trades (default: simulate, no orders placed)
//   SNIPE_BUDGET_BNB=0.02  BNB spent per token
//   SNIPE_MAX=10           stop after this many successful buys
//   SNIPE_SLIPPAGE=10      % slippage on the curve buy (stock swap uses baw auto)

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
// Only the Binance Agent ID Exclusive template (needs an Agent ID NFT to trade).
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
  budgetBnb: process.env.SNIPE_BUDGET_BNB || '0.02',
  max: Number(process.env.SNIPE_MAX || 10),
  slippage: Number(process.env.SNIPE_SLIPPAGE || 10),
  wss: (process.env.SNIPE_WSS || 'wss://bsc-rpc.publicnode.com,wss://bsc.publicnode.com').split(','),
  rpcs: (process.env.SNIPE_RPC || 'https://bsc.publicnode.com,https://bsc-dataseed.binance.org').split(','),
  statePath: homedir() + '/.config/stock-snipe-state.json',
  statusPath: homedir() + '/.config/stock-snipe-status.json',
  eventsPath: homedir() + '/.config/four-watch-events.json', // shared with the panel's event feed
};

const log = (...a) => console.log(new Date().toISOString(), ...a);
const env = () => ({...process.env, NODE_USE_ENV_PROXY: '1'});
const sel = s => '0x' + Buffer.from(keccak_256(new TextEncoder().encode(s))).toString('hex').slice(0, 8);
const word = x => BigInt(x).toString(16).padStart(64, '0');
const addrWord = a => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const enc = (sig, ...args) => sel(sig) + args.map(a => (typeof a === 'string' && a.length === 42) ? addrWord(a) : word(a)).join('');
const words = hex => (hex || '0x').slice(2).match(/.{64}/g) || [];
const toWei = v => { const [a, b = ''] = String(v).split('.'); return BigInt(a || '0') * 10n ** 18n + BigInt((b + '0'.repeat(18)).slice(0, 18)); };
const fromWei = v => { const s = BigInt(v).toString().padStart(19, '0'); return (s.slice(0, -18) + '.' + s.slice(-18)).replace(/\.?0+$/, '') || '0'; };

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
        body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params}), signal: AbortSignal.timeout(10000)});
      const j = await r.json(); if (j.error) throw new Error(j.error.message);
      rpcIdx = (rpcIdx + i) % CFG.rpcs.length; return j.result;
    } catch (e) { last = e; }
  }
  throw last;
}
const call = (to, data) => rpc('eth_call', [{to, data}, 'latest']);
const balanceOf = async (t, w) => BigInt(await call(t, enc('balanceOf(address)', w)) || '0x0');

let WALLET = null;
let busy = false;
const status = {startedAt: Date.now(), hits: 0, bought: 0, skipped: 0, lastHit: null, head: 0, wss: 0};
function writeStatus() {
  const s = loadState();
  try { writeFileSync(CFG.statusPath, JSON.stringify({...status, ts: Date.now(), pid: process.pid, armed: CFG.armed, budgetBnb: CFG.budgetBnb, max: CFG.max,
    bought: Object.keys(s.bought).length, skipped: Object.keys(s.skipped).length}, null, 2)); } catch {}
}

// Wait until a baw market order settles, returning the order row.
async function waitOrder(id) {
  for (let i = 0; i < 40; i++) {
    const o = await baw(['market-order', 'list', '--orderId', String(id)]);
    const row = o?.data?.list?.[0];
    if (row?.status === 'FINISHED' || row?.status === 'FAILED') return row;
    await new Promise(r => setTimeout(r, 1500));
  }
  return null;
}
async function contractCall(to, data, valueWei = 0n) {
  const pv = await baw(['contract-call', 'preview', '--binanceChainId', '56', '--from', WALLET, '--to', to, '--value', String(valueWei), '--inputData', data]);
  if (!pv.success) return {ok: false, stage: 'preview', error: pv.error?.message};
  const ex = await baw(['contract-call', 'execute', '--requestId', pv.data.requestId]);
  return {ok: !!ex.success, stage: 'execute', data: ex.data, error: ex.error?.message};
}

async function snipe(token, stock, stockSym) {
  const t0 = Date.now();
  // 1) Simulate the curve buy with the stock amount we'd get, before spending anything.
  const q = await baw(['market-order', 'quote', '--binanceChainId', '56', '--fromTokenQty', CFG.budgetBnb, '--fromToken', BNB, '--toToken', stock, '--slippage', 'auto']);
  if (!q.success) return {ok: false, reason: 'BNB→' + stockSym + ' 报价失败: ' + q.error?.message};
  const stockEst = toWei(q.data.toCoinAmount);
  const est = words(await call(TOOLS, enc('estimateBuyByBudget(address,address,uint256,uint256,bytes)', token, WALLET, stockEst, 0n, 160n, 0n)));
  const outEst = BigInt('0x' + (est[4] || '0'));
  if (outEst === 0n) return {ok: false, reason: '曲线报价为 0（不可买或已毕业）'};
  log(`  quote: ${CFG.budgetBnb} BNB → ${fromWei(stockEst)} ${stockSym} → ~${fromWei(outEst)} tokens`);
  if (!CFG.armed) return {ok: true, sim: true, stockEst, outEst};

  // 2) BNB → stock token through the baw aggregator.
  const before = await balanceOf(stock, WALLET);
  const sw = await baw(['market-order', 'swap', '--binanceChainId', '56', '--fromTokenQty', CFG.budgetBnb, '--fromToken', BNB, '--toToken', stock,
    '--slippage', 'auto', '--mev', 'true', '--gasLevel', 'HIGH']);
  if (!sw.success) return {ok: false, reason: '换 ' + stockSym + ' 失败: ' + sw.error?.message};
  const row = await waitOrder(sw.data.orderId);
  if (row?.status !== 'FINISHED') return {ok: false, reason: '换 ' + stockSym + ' 未成交', order: sw.data.orderId};
  const got = (await balanceOf(stock, WALLET)) - before;
  if (got <= 0n) return {ok: false, reason: stockSym + ' 未到账'};
  log(`  swapped → ${fromWei(got)} ${stockSym} (${Date.now() - t0}ms)`);

  // 3) Approve exactly what we're spending, then buy on the curve.
  const ap = await contractCall(stock, enc('approve(address,uint256)', CORE, got));
  if (!ap.ok) return {ok: false, reason: '授权失败: ' + ap.error, stockHeld: got};
  const est2 = words(await call(TOOLS, enc('estimateBuyByBudget(address,address,uint256,uint256,bytes)', token, WALLET, got, 0n, 160n, 0n)));
  const out2 = BigInt('0x' + (est2[4] || '0'));
  const minOut = out2 * BigInt(Math.round((100 - CFG.slippage) * 100)) / 10000n;
  const by = await contractCall(CORE, enc('buyByBudget(address,uint256,uint256,uint256,bytes)', token, got, minOut, 0n, 160n, 0n));
  if (!by.ok) return {ok: false, reason: '曲线买入失败: ' + by.error, stockHeld: got};
  return {ok: true, stockSpent: got, outEst: out2, tx: by.data?.txHash || by.data?.orderId, ms: Date.now() - t0};
}

async function handle(logs) {
  for (const l of logs) {
    const d = (l.data || '0x').slice(2), w = d.match(/.{64}/g) || [];
    const quote = '0x' + (w[7] || '').slice(24);
    const sym = STOCKS[quote.toLowerCase()];
    if (!sym) continue;
    const token = ('0x' + l.topics[3].slice(26)).toLowerCase();
    const preset = BigInt(l.topics[1]).toString();
    const st = loadState();
    if (st.bought[token] || st.skipped[token]) continue;
    if (Object.keys(st.bought).length >= CFG.max) { log('已买满', CFG.max, '个，不再买入'); continue; }
    status.hits++; status.lastHit = {token, sym, preset, block: parseInt(l.blockNumber, 16)};
    log('[hit]', sym, '底池新币', token, 'preset', preset, 'block', parseInt(l.blockNumber, 16));
    if (busy) { log('  上一笔还在进行，跳过'); continue; }
    busy = true;
    try {
      const r = await snipe(token, quote, sym);
      const s2 = loadState(), now = Math.floor(Date.now() / 1000);
      if (r.ok && r.sim) { log('  模拟：可买入，未下单'); s2.skipped[token] = {at: now, reason: 'simulated'}; }
      else if (r.ok) {
        s2.bought[token] = {at: now, stock: sym, budgetBnb: CFG.budgetBnb, stockSpent: fromWei(r.stockSpent), tx: r.tx};
        log('  BOUGHT', token, r.ms + 'ms', 'tx', r.tx);
        notify('股票底池狙击成交', `${sym} 底池 ${token}\n${CFG.budgetBnb} BNB 已买入`);
        pushEvent({type: 'bought', token, budgetBnb: CFG.budgetBnb, stock: sym, tx: r.tx});
      } else {
        s2.skipped[token] = {at: now, reason: r.reason};
        log('  跳过:', r.reason);
        if (r.stockHeld) notify('股票底池狙击未完成', `已换到 ${fromWei(r.stockHeld)} ${sym}，但曲线买入失败：${r.reason}`);
      }
      saveState(s2);
    } finally { busy = false; writeStatus(); }
  }
}

let lastScanned = 0, pendingHead = 0, timer = null;
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
function kick() { if (timer) return; timer = setTimeout(async () => { timer = null; await scanTo(pendingHead); }, 800); }
function startWss(url) {
  const ws = new WebSocket(url, {handshakeTimeout: 8000}); let up = false;
  ws.on('open', () => ws.send(JSON.stringify({jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads']})));
  ws.on('message', m => { let d; try { d = JSON.parse(m); } catch { return; }
    if (d.id === 1 && d.result) { up = true; status.wss++; log('[wss] subscribed', url); return; }
    if (d.params?.result?.number) { pendingHead = Math.max(pendingHead, parseInt(d.params.result.number, 16)); kick(); } });
  ws.on('error', e => log('[wss] error', e.message.slice(0, 50)));
  ws.on('close', () => { if (up) status.wss = Math.max(0, status.wss - 1); setTimeout(() => startWss(url), 2000); });
  setInterval(() => { try { ws.ping(); } catch {} }, 15000);
}

async function main() {
  const w = await baw(['wallet', 'address']);
  WALLET = w?.data?.addresses?.find(x => x.binanceChainId === '56')?.address;
  if (!WALLET) throw new Error('baw 钱包未登录');
  const head = parseInt(await rpc('eth_blockNumber', []), 16); lastScanned = head;
  log(`stock_snipe start · ${CFG.armed ? '实盘' : '模拟'} · 模板 ${PRESET} · 每个 ${CFG.budgetBnb} BNB · 最多 ${CFG.max} 个 · 股票: ${Object.values(STOCKS).join('/')} · head ${head}`);
  for (const u of CFG.wss) startWss(u.trim());
  writeStatus();
  for (;;) {
    await new Promise(r => setTimeout(r, 4000));
    try { await scanTo(parseInt(await rpc('eth_blockNumber', []), 16)); } catch (e) { log('[poll]', e.message.slice(0, 60)); }
    writeStatus();
  }
}

if (process.argv[2] === 'replay') {
  // Re-run classification + simulated quote on a past block range: node stock_snipe.mjs replay <fromBlock> <toBlock>
  (async () => {
    const w = await baw(['wallet', 'address']); WALLET = w.data.addresses.find(x => x.binanceChainId === '56').address;
    CFG.armed = false; CFG.statePath = '/tmp/stock-snipe-replay.json';
    const [f, t] = process.argv.slice(3).map(Number);
    for (let b = f; b <= t; b += 5000) {
      const logs = await rpc('eth_getLogs', [{address: CORE, topics: [TC_TOPIC, PRESET_TOPIC], fromBlock: '0x' + b.toString(16), toBlock: '0x' + Math.min(b + 4999, t).toString(16)}]);
      await handle(logs);
    }
    process.exit(0);
  })().catch(e => { log('fatal', e.message); process.exit(1); });
} else {
  main().catch(e => { log('fatal', e.message); process.exit(1); });
}
