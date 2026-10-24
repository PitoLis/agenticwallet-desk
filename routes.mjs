#!/usr/bin/env node
// routes.mjs — platform detection + direct-contract trade adapters for BSC
// launchpads that the baw aggregator can't route (inner bonding curves).
//
//   node routes.mjs detect <ca>
//   node routes.mjs quote  <ca> <buy|sell> <amount>   (BNB for buy, token units for sell; "all" for sell)
//   node routes.mjs trade  <ca> <buy|sell> <amount> <slippagePct>   → preview + execute via baw
//
// Signing never happens here: every tx goes through `baw contract-call
// preview` (simulated by the wallet backend) and only then `execute`.
// Approvals are separate baw contract-calls, scoped to the exact sell amount.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {keccak_256} from '@noble/hashes/sha3.js';
const run = promisify(execFile);

const RPC = process.env.ROUTES_RPC || 'https://bsc-dataseed.binance.org';
const env = () => ({...process.env, NODE_USE_ENV_PROXY: '1'});
const ZERO = '0x0000000000000000000000000000000000000000';

// ---- platform registry (BSC mainnet, verified on a fork 2026-10) ----
export const PLATFORMS = {
  agentpad: {name: 'AgentPad', site: 'agentpad.trade',
    factories: ['0xb31e99882d23377a9Ea360f1C065AD7b53Fb8Ec5', '0x3c4123f41b3F1160C42572C9e24608FBC96F984f', '0xFD200cf3A075CaDe6166a708481F881aA34424AD']},
  gang: {name: 'Gang', site: 'gang.fun', pad: '0x315Ba2e8952D06094CC636b2B84229FA32fb23A7'},
  gangpair: {name: 'Gang Pair', site: 'gang.fun', pad: '0x1B8F3f69DFa0a7F63d308C7EB0Fd38D8b099966E'},
  moat: {name: 'MOAT', site: 'moat.fun', pad: '0xa954c7cf3aac9b31138cc2137a86ec2b28ab4729', fairSlot: '0x873e8ff7eba0863b2c4fc615b3c0cb33752f472e'},
  flapagent: {name: 'Flap Agent 曲线', site: 'flap.sh', factory: '0xC55820f24015bE7c4f18949D9e1363A3609B300e', portal: '0x49387D2E6cbF8FefE856e3FBc3E98a01aC3af062'},
  cycpad: {name: 'Cycpad', site: 'cycpad.fun', factory: '0x0ff93d38e6975800A42B0693b58009DFAE061f26'},
  units: {name: 'UNITS', site: 'units-agentic.fun', token: '0xcD5F5cc018cE0650Bb4957A2853d24b4b4072A1D', curve: '0xd254D781363ba9e96A7B1dc39BabC5f735762682'},
};

// ---- low-level helpers ----
const sel = sig => '0x' + Buffer.from(keccak_256(new TextEncoder().encode(sig))).toString('hex').slice(0, 8);
const word = x => BigInt(x).toString(16).padStart(64, '0');
const addrWord = a => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const enc = (sig, ...args) => sel(sig) + args.map(a => (typeof a === 'string' && a.startsWith('0x') && a.length === 42) ? addrWord(a) : word(a)).join('');
const words = hex => (hex || '0x').slice(2).match(/.{64}/g) || [];
const toAddr = w => '0x' + w.slice(24);

async function rpc(method, params) {
  const r = await fetch(RPC, {method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params}), signal: AbortSignal.timeout(12000)});
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const call = (to, data, from) => rpc('eth_call', [{to, data, ...(from ? {from} : {})}, 'latest']);
async function tryCall(to, data, from) { try { return await call(to, data, from); } catch { return null; } }

function parseJsonLoose(s) {
  s = s.trim();
  const a = ['{', '['].map(c => s.indexOf(c)).filter(i => i >= 0);
  const e = ['}', ']'].map(c => s.lastIndexOf(c)).filter(i => i >= 0);
  if (!a.length) throw new Error('no JSON');
  return JSON.parse(s.slice(Math.min(...a), Math.max(...e) + 1));
}
async function baw(args) {
  try {
    const {stdout} = await run('baw', [...args, '--json'], {timeout: 60000, maxBuffer: 4e6, env: env()});
    return parseJsonLoose(stdout);
  } catch (e) {
    try { return parseJsonLoose(e.stdout || ''); } catch { return {success: false, error: {message: e.message}}; }
  }
}
let WALLET = null;
async function wallet() {
  if (WALLET) return WALLET;
  const w = await baw(['wallet', 'address']);
  WALLET = w.data.addresses.find(x => x.binanceChainId === '56').address;
  return WALLET;
}
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 600);
const toWei = (v, d = 18) => { const [a, b = ''] = String(v).split('.'); return BigInt(a || '0') * 10n ** BigInt(d) + BigInt((b + '0'.repeat(d)).slice(0, d) || '0'); };
const fromWei = (v, d = 18) => { const s = BigInt(v).toString().padStart(d + 1, '0'); return (s.slice(0, -d) + '.' + s.slice(-d)).replace(/\.?0+$/, '') || '0'; };
const balanceOf = async (token, who) => BigInt((await tryCall(token, enc('balanceOf(address)', who))) || '0x0');

// ---- detection ----
// Returns {platform, venue:'baw'|'direct', ...route-specific fields}.
export async function detect(ca) {
  ca = ca.toLowerCase();
  const P = PLATFORMS;
  if (ca === P.units.token.toLowerCase()) return {platform: 'units', venue: 'direct', ...P.units};

  // Cycpad: token is its own curve; factory.isToken(ca). Graduated → PancakeSwap via baw.
  if (ca.endsWith('cccc')) {
    const it = await tryCall(P.cycpad.factory, enc('isToken(address)', ca));
    if (it && BigInt(it) === 1n) {
      const g = await tryCall(ca, sel('graduated()'));
      const q = await tryCall(ca, sel('quoteToken()'));
      const quote = q ? toAddr(words(q)[0]) : ZERO;
      const graduated = !!(g && BigInt(g) === 1n);
      return {platform: 'cycpad', venue: graduated ? 'baw' : 'direct', graduated, quote, bnbQuote: quote === ZERO};
    }
  }

  // Gang Soft: curves(ca).creator != 0
  const gs = words(await tryCall(P.gang.pad, enc('curves(address)', ca)));
  if (gs.length && BigInt('0x' + gs[0]) !== 0n) return {platform: 'gang', venue: 'direct', pad: P.gang.pad, graduated: gs[3] && BigInt('0x' + gs[3]) !== 0n};

  // Gang V2 / Pair: curves(ca) = (creator, quote, ...)
  const gv = words(await tryCall(P.gangpair.pad, enc('curves(address)', ca)));
  if (gv.length && BigInt('0x' + gv[0]) !== 0n) {
    const quote = toAddr(gv[1]);
    return {platform: 'gangpair', venue: 'direct', pad: P.gangpair.pad, quote, quoteIsWbnb: quote.toLowerCase() === '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c'};
  }

  // MOAT curve
  const mc = words(await tryCall(P.moat.pad, enc('curves(address)', ca)));
  if (mc.length && BigInt('0x' + mc[0]) !== 0n) return {platform: 'moat', venue: 'direct', pad: P.moat.pad};

  // AgentPad: any factory isToken(ca)
  for (const f of P.agentpad.factories) {
    const r = await tryCall(f, enc('isToken(address)', ca));
    if (r && BigInt(r) === 1n) {
      const grad = await tryCall(ca, sel('graduated()'));
      return {platform: 'agentpad', venue: grad && BigInt(grad) === 1n ? 'baw' : 'direct', factory: f};
    }
  }

  // Flap Agent: factory.marketOfToken(predicted CA)
  const mk = await tryCall(P.flapagent.factory, enc('marketOfToken(address)', ca));
  if (mk && toAddr(words(mk)[0] || '0'.repeat(64)) !== ZERO) {
    const market = toAddr(words(mk)[0]);
    const q = await tryCall(market, sel('quoteToken()'));
    const quote = q ? toAddr(words(q)[0]) : ZERO;
    return {platform: 'flapagent', venue: 'direct', portal: P.flapagent.portal, market, quote, bnbQuote: quote === ZERO};
  }

  // Name-based heuristics for platforms the baw aggregator already routes.
  const tail = ca.slice(-4);
  if (tail === '7777' || tail === '8888') return {platform: 'flap', venue: 'baw'};
  if (tail === '4444' || tail === 'ffff') return {platform: 'fourmeme', venue: 'baw'};
  return {platform: 'pancake', venue: 'baw'}; // generic: aggregator / PancakeSwap
}

// ---- quotes (read-only) ----
export async function quote(ca, side, amount) {
  const r = await detect(ca);
  const me = await wallet();
  if (r.venue === 'baw') return {route: r, venue: 'baw'};
  let out = 0n, inAmt = 0n, note = '';
  if (side === 'buy') {
    inAmt = toWei(amount);
    if (r.platform === 'agentpad') out = BigInt('0x' + words(await call(ca, enc('quoteBuy(uint256)', inAmt)))[0]);
    else if (r.platform === 'gang' || r.platform === 'moat') out = BigInt('0x' + words(await call(r.pad, enc('quoteBuy(address,address,uint256)', ca, me, inAmt)))[0]);
    else if (r.platform === 'units') out = BigInt('0x' + words(await call(r.curve, enc('quoteBuy(address,uint256)', me, inAmt)))[0]);
    else if (r.platform === 'cycpad') {
      if (!r.bnbQuote) throw new Error('该 Cycpad 代币以 USDT 计价，暂只支持 BNB 计价的内盘');
      const can = await tryCall(ca, enc('canBuy(address)', me));
      if (!can || BigInt(can) !== 1n) throw new Error('当前钱包不能买这个 Cycpad 代币（需要 Agent ID 或在该币的买家白名单里）');
      const w = words(await call(ca, enc('quoteBuyFor(address,uint256)', me, inAmt)));
      out = BigInt('0x' + w[0]);
      const refund = BigInt('0x' + (w[2] || '0'));
      if (refund > 0n) note = '曲线剩余额度不足，多出的 ' + fromWei(refund) + ' BNB 会退回';
    }
    else if (r.platform === 'flapagent') {
      if (!r.bnbQuote) throw new Error('该 Flap Agent 市场用非 BNB 计价（' + r.quote + '），暂不支持直接 BNB 买入');
      const w = words(await call(r.portal, enc('quoteBuy(address,address,uint256)', r.market, me, inAmt)));
      out = BigInt('0x' + (w[3] || '0')); note = '买到的是曲线份额（非 ERC20），上线后需 claim';
    } else if (r.platform === 'gangpair') throw new Error('Gang Pair/V2 以 ERC20 计价（需先换出报价代币并授权，且无报价接口无法做滑点保护），暂不支持自动买入');
  } else {
    const bal = r.platform === 'flapagent'
      ? BigInt((await tryCall(r.market, enc('sharesOf(address)', me))) || '0x0')
      : await balanceOf(r.platform === 'units' ? r.token : ca, me);
    inAmt = amount === 'all' ? bal : toWei(amount);
    if (inAmt > bal) throw new Error('卖出数量超过持仓');
    if (r.platform === 'agentpad' || r.platform === 'cycpad') out = BigInt('0x' + (words(await call(ca, enc('quoteSell(uint256)', inAmt), me))[0] || '0'));
    else if (r.platform === 'gang' || r.platform === 'moat') {
      const q = await tryCall(r.pad, enc('quoteSell(address,address,uint256)', ca, me, inAmt));
      out = q ? BigInt('0x' + words(q)[0]) : 0n;
      if (!q) note = '平台无卖出报价接口，按 0 最小到账成交（滑点不受保护）';
    } else note = '无卖出报价接口';
    r.holding = bal.toString();
  }
  let symbol = null;
  try { const h = await call(r.platform === 'units' ? r.token : ca, sel('symbol()')); const b = Buffer.from(h.slice(2), 'hex');
    symbol = b.length === 32 ? b.toString('utf8').replace(/\0+$/, '') : b.subarray(64, 64 + Number(BigInt('0x' + h.slice(66, 130)))).toString('utf8'); } catch {}
  return {route: r, venue: 'direct', side, symbol, in: inAmt.toString(), out: out.toString(), outHuman: fromWei(out), note};
}

// ---- on-chain curve info (for tokens GMGN hasn't indexed yet) ----
// Spot price = BNB in / tokens out for a tiny buy, which already includes the
// platform's buy fee. Market cap = price x totalSupply (all these launchpads
// mint the full supply up front).
const FEE_BPS = {cycpad: ['TRADE_FEE_BPS()', 'TRADE_FEE_BPS()']};
export async function curveInfo(ca) {
  const r = await detect(ca);
  if (r.venue !== 'direct') return {route: r};
  const probe = '0.0001';
  let priceBnb = null;
  try {
    const q = await quote(ca, 'buy', probe);
    const out = BigInt(q.out);
    if (out > 0n) priceBnb = Number(probe) / (Number(out) / 1e18);
  } catch {}
  const supplyHex = await tryCall(r.platform === 'units' ? r.token : ca, sel('totalSupply()'));
  // Flap Agent tokens aren't deployed until graduation; their supply is a fixed 1B.
  const supply = supplyHex && supplyHex !== '0x' ? Number(BigInt(supplyHex)) / 1e18 : (r.platform === 'flapagent' ? 1e9 : null);
  let buyTax = null, sellTax = null;
  if (FEE_BPS[r.platform]) {
    const b = await tryCall(ca, sel(FEE_BPS[r.platform][0]));
    if (b) buyTax = sellTax = Number(BigInt(b)) / 10000;
  } else {
    // Buy-quote structs expose the fee split; fee / (net + fee) is the buy fee rate.
    const me = await wallet(), amt = 10n ** 15n;
    let w = null, net = null, fee = null;
    if (r.platform === 'gang' || r.platform === 'moat') { w = words(await tryCall(r.pad, enc('quoteBuy(address,address,uint256)', ca, me, amt))); net = w[1]; fee = w[2]; }
    else if (r.platform === 'agentpad') { w = words(await tryCall(ca, enc('quoteBuy(uint256)', amt))); net = w[1]; fee = w[2]; }
    else if (r.platform === 'units') { w = words(await tryCall(r.curve, enc('quoteBuy(address,uint256)', me, amt))); net = w[1]; fee = w[2]; }
    else if (r.platform === 'flapagent') { w = words(await tryCall(r.portal, enc('quoteBuy(address,address,uint256)', r.market, me, amt))); net = w[0]; fee = w[1]; }
    if (net && fee) {
      const n = Number(BigInt('0x' + net)), f = Number(BigInt('0x' + fee));
      if (n + f > 0) buyTax = f / (r.platform === 'flapagent' ? n : n + f);
      // Fork-measured round trips (Gang/MOAT/AgentPad) show the sell fee equals the buy fee.
      sellTax = buyTax;
    }
  }
  // bonding-curve progress, where the platform exposes it
  let progress = null;
  if (r.platform === 'cycpad') {
    const st = words(await tryCall(ca, sel('getState()')) || '0x');
    const thr = await tryCall(ca, sel('GRADUATION_THRESHOLD()'));
    const qr = await tryCall(ca, sel('quoteReserve()'));
    if (thr && qr && BigInt(thr) > 0n) progress = Number(BigInt(qr)) / Number(BigInt(thr));
  }
  return {route: r, priceBnb, supply, mcapBnb: priceBnb && supply ? priceBnb * supply : null, buyTax, sellTax, progress};
}

// ---- trade (preview → execute via baw) ----
async function bawCall(to, data, valueWei) {
  const me = await wallet();
  const pv = await baw(['contract-call', 'preview', '--binanceChainId', '56', '--from', me, '--to', to, '--value', String(valueWei || 0), '--inputData', data]);
  if (!pv.success) return {ok: false, stage: 'preview', error: pv.error?.message || 'preview failed', raw: pv};
  const ex = await baw(['contract-call', 'execute', '--requestId', pv.data.requestId]);
  return {ok: !!ex.success, stage: 'execute', preview: pv.data, result: ex.data || ex.error, raw: ex};
}
async function ensureAllowance(token, spender, amount) {
  const me = await wallet();
  const cur = BigInt((await tryCall(token, enc('allowance(address,address)', me, spender))) || '0x0');
  if (cur >= amount) return {ok: true, skipped: true};
  // exact-amount approval, never unlimited
  return bawCall(token, enc('approve(address,uint256)', spender, amount), 0);
}

export async function trade(ca, side, amount, slippagePct = 10) {
  const q = await quote(ca, side, amount);
  if (q.venue === 'baw') return {ok: false, venue: 'baw', route: q.route, error: 'use baw market-order for this token'};
  const r = q.route, inAmt = BigInt(q.in), out = BigInt(q.out);
  const minOut = out * BigInt(Math.max(0, Math.round((100 - Number(slippagePct)) * 100))) / 10000n;
  if (r.platform === 'cycpad' && minOut === 0n) return {ok: false, route: r, error: '报价为 0，无法设置最小到账（可能已毕业或卖出数量过小）'};
  if (side === 'buy') {
    if (r.platform === 'agentpad') return {route: r, ...(await bawCall(ca, enc('buyWithBNBMinOut(uint256)', minOut), inAmt))};
    if (r.platform === 'gang' || r.platform === 'moat') return {route: r, ...(await bawCall(r.pad, enc('buy(address,uint256)', ca, minOut), inAmt))};
    if (r.platform === 'units') return {route: r, ...(await bawCall(r.curve, enc('buy(uint256)', minOut), inAmt))};
    if (r.platform === 'cycpad') return {route: r, ...(await bawCall(ca, enc('buyWithQuote(uint256,uint256,uint256)', inAmt, minOut, deadline()), inAmt))};
    if (r.platform === 'flapagent') return {route: r, ...(await bawCall(r.portal, enc('buy(address,uint256)', r.market, minOut), inAmt))};
  } else {
    if (r.platform === 'agentpad') return {route: r, ...(await bawCall(ca, enc('sellWithMin(uint256,uint256)', inAmt, minOut), 0))};
    if (r.platform === 'cycpad') return {route: r, ...(await bawCall(ca, enc('sell(uint256,uint256,uint256)', inAmt, minOut, deadline()), 0))}; // no approval needed
    if (r.platform === 'flapagent') {
      const all = inAmt.toString() === r.holding;
      return {route: r, ...(await bawCall(r.portal, all ? enc('sellAll(address,uint256)', r.market, minOut) : enc('sellBps(address,uint256,uint256)', r.market, inAmt * 10000n / BigInt(r.holding || 1), minOut), 0))};
    }
    const token = r.platform === 'units' ? r.token : ca;
    const spender = r.platform === 'units' ? r.curve : r.pad;
    const ap = await ensureAllowance(token, spender, inAmt);
    if (!ap.ok) return {route: r, ok: false, stage: 'approve', error: ap.error};
    if (r.platform === 'units') return {route: r, ...(await bawCall(r.curve, enc('sell(uint256,uint256)', inAmt, minOut), 0))};
    return {route: r, ...(await bawCall(r.pad, enc('sell(address,uint256,uint256)', ca, inAmt, minOut), 0))};
  }
  return {ok: false, route: r, error: '该平台暂不支持此方向'};
}

// ---- CLI ----
if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ca, side, amount, slip] = process.argv.slice(2);
  const out = o => console.log(JSON.stringify(o));
  (async () => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(ca || '')) throw new Error('Invalid token address');
    if (cmd === 'detect') return out({success: true, data: await detect(ca)});
    if (cmd === 'quote') return out({success: true, data: await quote(ca, side, amount)});
    if (cmd === 'curveinfo') return out({success: true, data: await curveInfo(ca)});
    if (cmd === 'trade') { const r = await trade(ca, side, amount, slip); return out({success: !!r.ok, data: r, error: r.ok ? undefined : {message: r.error || ('失败于 ' + r.stage)}}); }
    throw new Error('usage: detect|quote|trade <ca> ...');
  })().catch(e => out({success: false, error: {message: e.message}}));
}
