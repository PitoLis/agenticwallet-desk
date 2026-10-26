import {keccak_256} from '@noble/hashes/sha3.js';
import {execFileSync} from 'node:child_process';

// Resolve wallet balances plus on-chain metadata for an arbitrary token list.
// Usage: node token_meta.mjs 0xtoken1,0xtoken2
const BNB = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const USDT = '0x55d398326f99059fF775485246999027B3197955';
const raw = (process.argv[2] || '').split(',').map(s => s.trim()).filter(Boolean);
for (const t of raw) if (!/^0x[0-9a-fA-F]{40}$/.test(t)) throw Error('Invalid token ' + t);

const wallet = JSON.parse(execFileSync('baw', ['wallet', 'address', '--json'], {encoding: 'utf8', timeout: 15000}))
  .data.addresses.find(x => x.binanceChainId === '56').address;

const pad = x => x.replace(/^0x/, '').padStart(64, '0');
// Public BSC RPCs, rotated on failure. dataseed is first (official) but can be
// unreachable from some networks; publicnode is the resilient fallback.
const RPCS = ['https://bsc-dataseed.binance.org', 'https://bsc-dataseed1.binance.org',
              'https://bsc.publicnode.com', 'https://bsc-rpc.publicnode.com'];
let rpcIdx = 0;
async function rpc(method, params) {
  let lastErr = null;
  for (let i = 0; i < RPCS.length; i++) {
    const url = RPCS[(rpcIdx + i) % RPCS.length];
    try {
      const x = await (await fetch(url, {
        method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params}), signal: AbortSignal.timeout(8000)
      })).json();
      if (x.error) throw Error(x.error.message);
      rpcIdx = (rpcIdx + i) % RPCS.length;   // stick with the endpoint that works
      return x.result;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || Error('all RPCs failed');
}
async function c(to, sig, args = '') {
  return rpc('eth_call', [{to, data: '0x' + Buffer.from(keccak_256(new TextEncoder().encode(sig))).toString('hex').slice(0, 8) + args}, 'latest']);
}
function fmt(x, d) {
  let v = BigInt(x).toString().padStart(d + 1, '0');
  return d ? (v.slice(0, -d) + '.' + v.slice(-d)).replace(/\.?0+$/, '') : v;
}
function str(x) {
  const b = Buffer.from(x.slice(2), 'hex');
  if (b.length === 32) return b.toString('utf8').replace(/\0+$/, '');
  const off = Number(BigInt('0x' + x.slice(2, 66)));
  if (off + 32 > b.length) throw Error('Invalid metadata');
  const len = Number(BigInt('0x' + b.subarray(off, off + 32).toString('hex')));
  if (len > 512 || off + 32 + len > b.length) throw Error('Invalid metadata');
  return b.subarray(off + 32, off + 32 + len).toString('utf8');
}

try {
  const [bnbWei, usdtBal] = await Promise.all([
    rpc('eth_getBalance', [wallet, 'latest']),
    c(USDT, 'balanceOf(address)', pad(wallet))
  ]);
  const tokens = {};
  await Promise.all(raw.map(async token => {
    if (token.toLowerCase() === BNB.toLowerCase()) return;
    try {
      const [name, symbol, decimals, balance] = await Promise.all([
        c(token, 'name()'), c(token, 'symbol()'), c(token, 'decimals()'), c(token, 'balanceOf(address)', pad(wallet))
      ]);
      let d = Number(BigInt(decimals));
      if (d > 36) throw Error('Unsupported decimals');
      tokens[token.toLowerCase()] = {address: token, name: str(name), symbol: str(symbol), decimals: d, balance: fmt(balance, d)};
    } catch (e) {
      tokens[token.toLowerCase()] = {address: token, error: e.message};
    }
  }));
  console.log(JSON.stringify({success: true, data: {wallet, BNB: fmt(bnbWei, 18), USDT: fmt(usdtBal, 18), tokens}}));
} catch (e) {
  console.log(JSON.stringify({success: false, error: {message: e.message}}));
}
