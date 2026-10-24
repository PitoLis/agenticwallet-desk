'use strict';
const BNB = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const USDT = '0x55d398326f99059fF775485246999027B3197955';
const $ = id => document.getElementById(id);

const KNOWN = {
  [BNB.toLowerCase()]: {address: BNB, symbol: 'BNB', name: 'BNB', decimals: 18, cls: 'bnb'},
  [USDT.toLowerCase()]: {address: USDT, symbol: 'Tether USD', name: 'Tether USD', decimals: 18, cls: 'usdt', symbolShort: 'USDT'},
};
const PAIRS = [['USDT', 'BNB', 'USDT → BNB'], ['BNB', 'USDT', 'BNB → USDT']];

const state = {
  from: BNB, to: USDT, slippage: 'auto', gas: 'HIGH',
  wallet: null, balances: {}, tokens: {}, quote: null, quoteSeq: 0,
  busy: false, picker: null, pickerSeq: 0,
};

const resolve = s => s === 'BNB' ? BNB : s === 'USDT' ? USDT : s;
const short = a => a ? a.slice(0, 6) + '…' + a.slice(-4) : '—';
function sym(info) { return info.symbolShort || info.symbol || short(info.address); }
function tokenInfo(addr) { const k = (addr || '').toLowerCase(); return state.tokens[k] || KNOWN[k] || {address: addr, symbol: short(addr), name: '未知代币', decimals: 18}; }

function iconHTML(info, cls = 'tok-ico') {
  const a = info.address.toLowerCase();
  const kind = info.cls || (a === BNB.toLowerCase() ? 'bnb' : a === USDT.toLowerCase() ? 'usdt' : '');
  const inner = info.logo ? `<img src="${info.logo}" referrerpolicy="no-referrer" alt="">` : (sym(info) || '?').slice(0, 2).toUpperCase();
  return `<span class="${cls} ${kind}">${inner}</span>`;
}
function trim(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!isFinite(n)) return String(v);
  if (n === 0) return '0';
  if (n >= 1) return n.toLocaleString('en-US', {maximumFractionDigits: 6});
  return n.toPrecision(6).replace(/\.?0+$/, '');
}

function renderTokButtons() {
  for (const [side, addr] of [['from', state.from], ['to', state.to]]) {
    const info = tokenInfo(addr);
    $(side + 'Tok').innerHTML = iconHTML(info) + `<span>${sym(info)}</span><span class="car">▾</span>`;
  }
  $('fromBal').textContent = '余额：' + (state.balances[state.from.toLowerCase()] ?? '—');
  $('toBal').textContent = '余额：' + (state.balances[state.to.toLowerCase()] ?? '—');
}
function renderPairs() {
  $('pairs').innerHTML = '';
  for (const [f, t, label] of PAIRS) {
    const b = document.createElement('button');
    b.className = 'pair'; b.textContent = label;
    b.onclick = () => { state.from = resolve(f); state.to = resolve(t); afterPairChange(); };
    $('pairs').appendChild(b);
  }
}
function afterPairChange() { renderTokButtons(); ensureMeta([state.from, state.to]); scheduleQuote(); refreshTokenCard(); }

// ---------- views ----------
function showView(v) {
  for (const el of document.querySelectorAll('.view')) el.hidden = el.id !== 'view-' + v;
  for (const b of document.querySelectorAll('.nav-item')) b.classList.toggle('active', b.dataset.view === v);
  if (v === 'monitor') { loadStatus(); loadAlerts(); }
  if (v === 'activity') { loadHistory(); loadAlerts(); }
}
window.showView = showView;

// ---------- wallet ----------
async function loadWallet() {
  const extra = Object.values(state.tokens).map(t => t.address);
  await ensureMeta([state.from, state.to, ...extra], true);
  renderBalances();
}
async function ensureMeta(addrs, force) {
  const want = [...new Set(addrs.map(a => a.toLowerCase()).filter(a => a !== BNB.toLowerCase()))];
  const need = force ? want : want.filter(a => !(a in state.balances));
  try {
    const url = '/meta' + (need.length ? '?tokens=' + encodeURIComponent(need.join(',')) : '');
    const x = await (await fetch(url)).json();
    if (!x.success) throw Error(x.error?.message || '读取失败');
    state.wallet = x.data.wallet;
    state.balances[BNB.toLowerCase()] = x.data.BNB;
    state.balances[USDT.toLowerCase()] = x.data.USDT;
    for (const [k, v] of Object.entries(x.data.tokens || {})) {
      if (v.error) continue;
      state.tokens[k] = {...(state.tokens[k] || {}), ...v, cls: ''};
      state.balances[k] = v.balance;
      KNOWN[k] = KNOWN[k] || state.tokens[k];
    }
    $('walletAddr').textContent = state.wallet;
    drawBlockies(state.wallet);
    renderTokButtons();
  } catch (e) { $('walletAddr').textContent = '余额读取失败：' + e.message; }
}
function renderBalances() {
  const list = $('balList'); list.innerHTML = '';
  const shown = [BNB.toLowerCase(), USDT.toLowerCase(), ...Object.keys(state.tokens)].filter((v, i, a) => a.indexOf(v) === i);
  for (const k of shown) {
    const info = tokenInfo(k), bal = state.balances[k] ?? '—';
    const el = document.createElement('div');
    el.className = 'li';
    el.innerHTML = `<div class="l">${iconHTML(info)}<div><div style="font-weight:650">${sym(info)}</div>`
      + `<div class="addr mono">${info.address.toLowerCase() === BNB.toLowerCase() ? '原生代币' : short(info.address)}</div></div></div>`
      + `<div class="v">${bal}</div>`;
    list.appendChild(el);
  }
}
function usePct(frac) {
  const k = state.from.toLowerCase(), raw = state.balances[k];
  if (raw == null) return;
  let avail = parseFloat(raw);
  if (!isFinite(avail) || avail <= 0) return;
  // On native BNB reserve 0.001 for gas from the spendable base, then take the fraction.
  if (k === BNB.toLowerCase()) avail = Math.max(0, avail - 0.001);
  const amt = avail * frac;
  if (amt <= 0) return;
  // trim float noise; keep enough precision for small-decimal tokens
  $('fromAmt').value = Number(amt.toPrecision(12)).toString();
  scheduleQuote();
}

// ---------- blockies wallet logo ----------
function drawBlockies(addr) {
  const cv = $('brandIcon'); if (!cv || !addr) return;
  const ctx = cv.getContext('2d'); const S = 32, N = 8, px = S / N;
  // seedable PRNG from address
  let seed = 0; for (let i = 0; i < addr.length; i++) seed = (seed * 31 + addr.charCodeAt(i)) >>> 0;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
  // gold-family palette so it matches brand
  const h = 60 + Math.floor(rnd() * 40);
  const fg = `hsl(${h} 60% 45%)`, bg = 'hsl(45 30% 96%)', sp = `hsl(${h} 70% 62%)`;
  ctx.fillStyle = bg; ctx.fillRect(0, 0, S, S);
  for (let y = 0; y < N; y++) for (let x = 0; x < N / 2; x++) {
    const v = rnd(); if (v < 0.5) continue;
    ctx.fillStyle = v > 0.82 ? sp : fg;
    ctx.fillRect(x * px, y * px, px, px);
    ctx.fillRect((N - 1 - x) * px, y * px, px, px);
  }
}

// ---------- quote ----------
let quoteTimer = null;
function scheduleQuote() {
  clearTimeout(quoteTimer);
  const amt = $('fromAmt').value.trim();
  state.quote = null; $('quoteBox').classList.remove('show');
  if (!amt || !(parseFloat(amt) > 0)) { $('toAmt').value = ''; setCta(); return; }
  setCta('quoting'); quoteTimer = setTimeout(getQuote, 380);
}
async function getQuote() {
  const seq = ++state.quoteSeq, amt = $('fromAmt').value.trim();
  setStatus('获取报价…', true);
  try {
    const x = await (await fetch('/quote', {method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({fromToken: state.from, toToken: state.to, qty: amt, slippage: state.slippage})})).json();
    if (seq !== state.quoteSeq) return;
    if (!x.success) throw Error(x.error?.message || '报价失败');
    state.quote = x.data; $('toAmt').value = trim(x.data.toCoinAmount);
    renderQuote(x.data, amt); setStatus('报价完成', false);
  } catch (e) { if (seq === state.quoteSeq) { $('toAmt').value = ''; setStatus('报价失败：' + e.message, false); } }
  setCta();
}
function renderQuote(d, payAmt) {
  const got = parseFloat(d.toCoinAmount), pay = parseFloat(payAmt);
  $('qRate').textContent = `1 ${d.fromCoinSymbol} ≈ ${trim(got / pay)} ${d.toCoinSymbol}`;
  const slip = typeof d.slippage === 'number' ? d.slippage : parseFloat(d.slippage || 0);
  $('qMin').textContent = `${trim(got * (1 - slip))} ${d.toCoinSymbol}`;
  const pct = slip * 100, el = $('qImpact');
  el.textContent = pct ? pct.toFixed(2) + '%（滑点上限）' : '自动';
  el.className = 'impact ' + (pct <= 1 ? 'lo' : pct <= 5 ? 'mid' : 'hi');
  $('quoteBox').classList.add('show');
}

// ---------- swap ----------
function setCta(stateName) {
  const cta = $('cta'), amt = $('fromAmt').value.trim();
  if (state.busy) { cta.disabled = true; return; }
  if (stateName === 'quoting') { cta.disabled = true; cta.textContent = '获取报价中…'; return; }
  if (!amt || !(parseFloat(amt) > 0)) { cta.disabled = true; cta.textContent = '输入数量'; return; }
  cta.disabled = !state.quote;
  cta.textContent = state.quote ? `兑换 ${sym(tokenInfo(state.from))} → ${sym(tokenInfo(state.to))}` : '等待报价';
}
async function doSwap() {
  if (state.busy || !state.quote) return;
  const amt = $('fromAmt').value.trim();
  state.busy = true; document.querySelectorAll('button,input').forEach(e => e.disabled = true);
  setCta(); setStatus('提交钱包…', true);
  const t0 = performance.now();
  try {
    const x = await (await fetch('/swap', {method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({fromToken: state.from, toToken: state.to, qty: amt, slippage: state.slippage, gasLevel: state.gas})})).json();
    if (!x.success) throw Error(x.error?.message || '提交失败');
    const id = x.data.orderId;
    setStatus('已提交订单 ' + id + '，等待确认…', true);
    for (let i = 0; i < 24; i++) {
      await sleep(1500);
      const o = await (await fetch('/order?id=' + encodeURIComponent(id))).json();
      const order = o.data?.list?.[0];
      if (order?.status === 'FINISHED') { setStatus(`成交：收到 ${trim(order.toTokenActualQty)} ${order.toTokenName} · ${sec(t0)}`, false); break; }
      if (order?.status === 'FAILED') throw Error('订单失败（见记录）');
    }
  } catch (e) { setStatus('未完成：' + e.message, false); }
  finally {
    state.busy = false; document.querySelectorAll('button,input').forEach(e => e.disabled = false);
    $('fromAmt').value = ''; $('toAmt').value = ''; state.quote = null; $('quoteBox').classList.remove('show'); setCta();
    loadWallet(); loadHistory();
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sec = t0 => ((performance.now() - t0) / 1000).toFixed(1) + 's';
function setStatus(m, b) { $('statusText').textContent = m; $('status').classList.toggle('busy', !!b); }

function flip() { [state.from, state.to] = [state.to, state.from]; $('fromAmt').value = ''; $('toAmt').value = ''; renderTokButtons(); scheduleQuote(); refreshTokenCard(); }

// ---------- settings ----------
function toggleSettings() { $('settings').classList.toggle('show'); }
function setSlip(v) { state.slippage = v; $('slipCustom').value = ''; [...$('slipSeg').children].forEach(b => b.classList.toggle('on', b.dataset.v === v)); $('slipLabel').textContent = v === 'auto' ? '自动' : v + '%'; scheduleQuote(); }
function setGas(v) { state.gas = v; [...$('gasSeg').children].forEach(b => b.classList.toggle('on', b.dataset.v === v)); }

// ---------- token info card (swap view) ----------
let tiSeq = 0;
function activeCustomToken() {
  const base = [BNB.toLowerCase(), USDT.toLowerCase()];
  for (const a of [state.to, state.from]) if (!base.includes(a.toLowerCase())) return a;
  return null;
}
function tokenInfoCells(d, token) {
  return [
    ['价格', d.price != null ? '$' + trim(d.price) : '—'],
    ['市值', d.market_cap != null ? '$' + trim(d.market_cap) : '—'],
    ['流动性', d.liquidity != null ? '$' + trim(d.liquidity) : '—'],
    ['持有人', d.holder_count ?? '—'],
    ['买入税', d.buy_tax != null ? (d.buy_tax * 100).toFixed(1) + '%' : '—'],
    ['卖出税', d.sell_tax != null ? (d.sell_tax * 100).toFixed(1) + '%' : '—'],
  ];
}
function riskBadges(d) {
  const b = [];
  if (d.is_honeypot === 'yes') b.push(['貔貅风险', 'bad']); else if (d.is_honeypot === 'no') b.push(['非貔貅', 'ok']);
  if (d.renounced === 'yes') b.push(['已弃权', 'ok']);
  if (d.rug_ratio != null) b.push(['rug ' + (d.rug_ratio * 100).toFixed(0) + '%', d.rug_ratio > 0.3 ? 'bad' : d.rug_ratio > 0.1 ? 'warn' : 'ok']);
  return b;
}
async function refreshTokenCard() {
  const card = $('tokCard'), token = activeCustomToken();
  if (!token) { card.classList.remove('show'); return; }
  const seq = ++tiSeq;
  try {
    const x = await (await fetch('/tokeninfo?token=' + encodeURIComponent(token))).json();
    if (seq !== tiSeq) return;
    if (!x.success) { card.classList.remove('show'); return; }
    const d = x.data;
    $('tiIc').innerHTML = d.logo ? `<img src="${d.logo}" referrerpolicy="no-referrer" alt="">` : (d.symbol || '?').slice(0, 2).toUpperCase();
    $('tiName').textContent = d.name || '未知'; $('tiSym').textContent = d.symbol ? '· ' + d.symbol : '';
    $('tiAddr').textContent = token;
    $('tiLp').textContent = d.launchpad || ''; $('tiLp').style.display = d.launchpad ? '' : 'none';
    $('tiGrid').innerHTML = tokenInfoCells(d, token).map(([k, v]) => `<div class="c"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');
    $('tiBadges').innerHTML = riskBadges(d).map(([t, c]) => `<span class="badge ${c}">${t}</span>`).join('');
    card.classList.add('show');
  } catch { if (seq === tiSeq) card.classList.remove('show'); }
}

// ---------- token picker: search SHOWS live content ----------
function openPicker(side) {
  state.picker = side;
  $('pickerTitle').textContent = side === 'from' ? '选择支付代币' : '选择收到代币';
  $('pickerInput').value = ''; renderPickerList(''); $('picker').showModal();
  setTimeout(() => $('pickerInput').focus(), 30);
}
function renderPickerList(q) {
  const list = $('pickerList'); list.innerHTML = '';
  const ql = q.toLowerCase().trim();
  // If a full address is typed, fetch and SHOW its live content as a rich card.
  if (/^0x[0-9a-fA-F]{40}$/.test(ql)) { renderSearchCard(ql); return; }
  const entries = Object.values(KNOWN);
  for (const k of Object.keys(state.tokens)) if (!(k in KNOWN)) entries.push(state.tokens[k]);
  const filtered = entries.filter(t => !ql || sym(t).toLowerCase().includes(ql) || (t.name || '').toLowerCase().includes(ql) || t.address.toLowerCase().includes(ql));
  for (const info of filtered) {
    const bal = state.balances[info.address.toLowerCase()] ?? '—';
    const el = document.createElement('div');
    el.className = 'opt';
    el.innerHTML = iconHTML(info) + `<div><div class="name">${sym(info)}</div><div class="sub">${info.name}</div></div>`
      + `<div class="r"><div>${bal}</div><div class="sub mono">${short(info.address)}</div></div>`;
    el.onclick = () => pick(info.address);
    list.appendChild(el);
  }
  if (!list.children.length) list.innerHTML = '<div class="empty">无匹配。粘贴完整合约地址以查看代币详情。</div>';
}
async function renderSearchCard(token) {
  const list = $('pickerList'), seq = ++state.pickerSeq;
  list.innerHTML = '<div class="srch-loading">正在读取代币链上与行情信息…</div>';
  // fetch metadata (name/decimals/balance) and GMGN info (logo/price/tax/risk) in parallel
  let meta = null, info = null;
  try {
    const [m, g] = await Promise.all([
      fetch('/meta?tokens=' + encodeURIComponent(token)).then(r => r.json()).catch(() => null),
      fetch('/tokeninfo?token=' + encodeURIComponent(token)).then(r => r.json()).catch(() => null),
    ]);
    if (seq !== state.pickerSeq) return;
    meta = m?.data?.tokens?.[token] || null;
    info = g?.success ? g.data : null;
  } catch {}
  if (seq !== state.pickerSeq) return;
  const name = info?.name || meta?.name || '未知代币';
  const symbol = info?.symbol || meta?.symbol || short(token);
  const bal = meta?.balance ?? state.balances[token] ?? '—';
  const logo = info?.logo || '';
  const d = info || {};
  const cells = [['价格', d.price != null ? '$' + trim(d.price) : '—'], ['流动性', d.liquidity != null ? '$' + trim(d.liquidity) : '—'], ['余额', bal]];
  const extraCells = [['市值', d.market_cap != null ? '$' + trim(d.market_cap) : '—'], ['买入税', d.buy_tax != null ? (d.buy_tax * 100).toFixed(1) + '%' : '—'], ['卖出税', d.sell_tax != null ? (d.sell_tax * 100).toFixed(1) + '%' : '—']];
  const card = document.createElement('div');
  card.className = 'srch-card';
  card.innerHTML =
    `<div class="srch-head"><span class="ic">${logo ? `<img src="${logo}" referrerpolicy="no-referrer" alt="">` : symbol.slice(0, 2).toUpperCase()}</span>`
    + `<div><div class="srch-name">${name} <span style="color:var(--muted);font-weight:500">· ${symbol}</span></div>`
    + `<div class="srch-sub mono">${token}${d.launchpad ? ' · ' + d.launchpad : ''}</div></div></div>`
    + `<div class="srch-grid">${[...cells, ...extraCells].map(([k, v]) => `<div class="c"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('')}</div>`
    + (riskBadges(d).length ? `<div class="srch-badges">${riskBadges(d).map(([t, c]) => `<span class="badge ${c}">${t}</span>`).join('')}</div>` : '')
    + `<button class="srch-pick">选择 ${symbol}</button>`;
  // cache into known list so it appears next time and renders in balances
  state.tokens[token] = {address: token, name, symbol, symbolShort: symbol, decimals: meta?.decimals ?? 18, logo, cls: ''};
  KNOWN[token] = state.tokens[token];
  if (bal !== '—') state.balances[token] = bal;
  card.querySelector('.srch-pick').onclick = () => pick(token);
  list.innerHTML = ''; list.appendChild(card);
}
function pick(addr) {
  const other = state.picker === 'from' ? state.to : state.from;
  if (addr.toLowerCase() === other.toLowerCase()) { if (state.picker === 'from') state.to = state.from; else state.from = state.to; }
  if (state.picker === 'from') state.from = addr; else state.to = addr;
  $('picker').close(); afterPairChange();
}

// ---------- history / alerts (shared across views) ----------
function renderHistory(list, boxId) {
  const box = $(boxId); if (!box) return;
  if (!list.length) { box.innerHTML = '<div class="empty">暂无兑换记录</div>'; return; }
  box.innerHTML = '';
  for (const o of list) {
    const got = o.status === 'FINISHED' ? trim(o.toTokenActualQty) : '…';
    const el = document.createElement('div'); el.className = 'li';
    el.innerHTML = `<div><div class="pair-l">${trim(o.fromTokenQty)} ${o.fromTokenName} → ${got} ${o.toTokenName}</div>`
      + `<div class="meta">${(o.bookTime || '').replace('T', ' ').slice(0, 19)}`
      + (o.txHash ? ` · <a href="https://bscscan.com/tx/${o.txHash}" target="_blank" rel="noopener">链上</a>` : '') + `</div></div>`
      + `<span class="st st-${o.status}">${o.status}</span>`;
    box.appendChild(el);
  }
}
async function loadHistory() {
  try {
    const x = await (await fetch('/orders')).json();
    if (!x.success) throw Error(x.error?.message || '读取失败');
    renderHistory(x.data?.list || [], 'hist'); renderHistory(x.data?.list || [], 'hist2');
  } catch (e) { const m = '<div class="empty">历史读取失败：' + e.message + '</div>'; if ($('hist')) $('hist').innerHTML = m; if ($('hist2')) $('hist2').innerHTML = m; }
}
function renderAlerts(list, boxId) {
  const box = $(boxId); if (!box) return;
  if (!list.length) { box.innerHTML = '<div class="empty">尚无买入/提醒事件</div>'; return; }
  box.innerHTML = '';
  for (const e of list.slice(0, 15)) {
    const t = new Date(e.ts).toLocaleString(), el = document.createElement('div'); el.className = 'li';
    if (e.type === 'bought')
      el.innerHTML = `<div><div class="pair-l">✅ 已买入 ${e.budgetBnb} BNB</div><div class="meta mono">${e.token}`
        + (e.tx ? ` · <a href="https://bscscan.com/tx/${e.tx}" target="_blank" rel="noopener">链上</a>` : '') + `</div><div class="meta">${t}</div></div><span class="st st-BOUGHT">BOUGHT</span>`;
    else if (e.type === 'tenx')
      el.innerHTML = `<div><div class="pair-l">🚀 到 ${e.mult}x</div><div class="meta mono">${e.token}</div><div class="meta">${t} · 可出本（卖出不自动）</div></div><span class="st st-10x">10x</span>`;
    else el.innerHTML = `<div><div class="pair-l">${e.type}</div><div class="meta mono">${e.token || ''}</div></div>`;
    box.appendChild(el);
  }
}
async function loadAlerts() {
  try {
    const x = await (await fetch('/events')).json();
    renderAlerts(x.data || [], 'alerts'); renderAlerts(x.data || [], 'alerts2');
  } catch {}
}

// ---------- monitor status ----------
async function loadStatus() {
  try {
    const x = await (await fetch('/status')).json();
    const live = x.data?.live, st = x.data?.status || {};
    const chip = $('monChip');
    chip.className = 'chip' + (live ? (st.armed ? ' armed' : ' live') : ' off');
    $('monChipText').textContent = live ? (st.armed ? '监控·武装' : '监控·演练') : '监控离线';
    // dashboard
    const ring = $('monRing'); ring.className = 'mon-ring' + (live ? ' live' : '');
    $('monSub').textContent = live
      ? `${st.presetName || '模板'} · preset ${st.preset}`
      : '监控进程未运行（命令行启动 four_watch.mjs）';
    $('monPills').innerHTML = live
      ? `<span class="pill ${st.armed ? 'arm' : 'dry'}">${st.armed ? '武装买入' : '演练模式'}</span><span class="pill on">运行中</span>`
      : `<span class="pill off">离线</span>`;
    const stats = [
      ['买入预算', (st.budgetBnb ?? '—') + ' BNB', 'gold'],
      ['最新区块', st.head ? st.head.toLocaleString() : '—', ''],
      ['已买入', st.bought ?? 0, ''],
      ['已跳过', st.skipped ?? 0, ''],
      ['WSS 连接', (st.wss ?? 0) + ' 路', ''],
      ['心跳', st.ts ? new Date(st.ts).toLocaleTimeString() : '—', ''],
    ];
    $('monStats').innerHTML = stats.map(([k, v, c]) => `<div class="c"><div class="k">${k}</div><div class="v ${c}">${v}</div></div>`).join('');
  } catch {
    $('monChip').className = 'chip off'; $('monChipText').textContent = '监控离线';
  }
}

// ---------- four preflight ----------
async function preflight() {
  const token = $('fourToken').value.trim(), out = $('fourOut');
  out.style.display = 'block';
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) { out.textContent = '请输入有效的合约地址'; return; }
  out.textContent = '正在只读核查模板、Agent ID NFT 与白名单…';
  try {
    const x = await (await fetch('/four/preflight', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({token})})).json();
    if (!x.success) throw Error(x.error?.message || '检查失败');
    const d = x.data;
    out.textContent = ['模板：' + (d.template || d.protocol || '未知'), '钱包：' + d.wallet,
      'Agent ID NFT 识别：' + (d.agentRecognized ? '是' : '否'), '交易入口：' + (d.core || d.manager || '未识别'), d.blocker || ''].filter(Boolean).join('\n');
  } catch (e) { out.textContent = '检查失败：' + e.message; }
}

// ---------- boot ----------
function bootstrap() {
  drawBlockies('0x0000000000000000000000000000000000000000');
  renderTokButtons(); renderPairs();
  $('fromAmt').addEventListener('input', scheduleQuote);
  $('slipCustom').addEventListener('input', () => {
    const v = $('slipCustom').value.trim();
    if (v && parseFloat(v) > 0 && parseFloat(v) <= 100) { state.slippage = v; [...$('slipSeg').children].forEach(b => b.classList.remove('on')); $('slipLabel').textContent = v + '%'; scheduleQuote(); }
  });
  $('pickerInput').addEventListener('input', e => renderPickerList(e.target.value.trim()));
  $('picker').addEventListener('click', e => { if (e.target === $('picker')) $('picker').close(); });
  loadWallet(); loadHistory(); loadStatus(); loadAlerts();
  setInterval(loadStatus, 6000);
  setInterval(loadAlerts, 8000);
}
window.bootstrap = bootstrap;
Object.assign(window, {toggleSettings, setSlip, setGas, openPicker, flip, usePct, doSwap, loadWallet, loadHistory, loadAlerts, preflight});
