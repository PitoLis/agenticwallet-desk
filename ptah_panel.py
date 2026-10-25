#!/usr/bin/env python3
"""Local Binance Agentic Wallet swap desk for BSC.

Delegates every quote, swap, approval, policy check and broadcast to the
installed `baw` CLI. No keys or transaction drafts are stored. Arbitrary
token pairs are supported; BNB and USDT are first-class quick-pick assets.

Endpoints
  GET  /                 panel UI
  GET  /health           liveness
  GET  /meta?tokens=..   wallet balances + on-chain metadata for a token list
  GET  /order?id=..      poll a single market order
  GET  /orders           recent market-order history
  POST /quote            {fromToken,toToken,qty,slippage}
  POST /swap             {fromToken,toToken,qty,slippage,gasLevel}
  POST /four/preflight   {token}  read-only template & whitelist check
"""
import json, os, re, subprocess, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse
from pathlib import Path
from decimal import Decimal, InvalidOperation

CHAIN = "56"
USDT = "0x55d398326f99059fF775485246999027B3197955"
BNB = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"
ADDR = re.compile(r"0x[a-fA-F0-9]{40}")


def _env():
    return dict(os.environ, NODE_USE_ENV_PROXY="1")


def run_baw(args, timeout=45):
    try:
        p = subprocess.run(["baw", *args, "--json"], text=True, capture_output=True, timeout=timeout, env=_env())
    except subprocess.TimeoutExpired:
        return {"success": False, "error": {"message": "钱包请求超时；交易结果可能未知，请在订单历史里核查后再操作，不要重复提交。"}}
    except OSError as e:
        return {"success": False, "error": {"message": str(e)}}
    raw = p.stdout.strip() or p.stderr.strip()
    try:
        return json.loads(raw)
    except Exception:
        return {"success": False, "error": {"message": raw or "钱包无响应"}}


def _gmgn_key():
    p = Path.home() / '.config/gmgn/.env'
    if p.exists():
        for line in p.read_text().splitlines():
            if line.startswith('GMGN_API_KEY='):
                return line.split('=', 1)[1].strip()
    return os.environ.get('GMGN_API_KEY', '')


def _gmgn(args, key):
    """Run one gmgn-cli call and return its parsed `data` dict, or None."""
    env = dict(os.environ, NODE_USE_ENV_PROXY='1', GMGN_API_KEY=key)
    try:
        p = subprocess.run(['gmgn-cli', *args, '--raw'], text=True, capture_output=True, timeout=25, env=env)
    except (subprocess.TimeoutExpired, OSError):
        return None
    txt = p.stdout.strip()
    try:
        d = json.loads(txt[min(x for x in (txt.find('{'), txt.find('[')) if x >= 0):])
    except Exception:
        return None
    d = d.get('data', d) if isinstance(d, dict) else d
    return d if isinstance(d, dict) else None


def _num(v):
    try:
        f = float(v)
        return f if f == f else None
    except (TypeError, ValueError):
        return None


def _tri(v):
    """GMGN flags: True/False, or None/-1 meaning 'not checked yet'."""
    if v is True or v == 1:
        return 'yes'
    if v is False or v == 0:
        return 'no'
    return None


def gmgn_token_info(token):
    """Logo, price, market cap, liquidity, taxes and risk flags for a token.

    `token info` carries identity/price/supply; taxes and honeypot/renounce flags
    only exist in `token security`, so both are fetched in parallel. GMGN has no
    market-cap field: it's price x circulating supply."""
    key = _gmgn_key()
    if not key:
        return {'success': False, 'error': {'message': 'GMGN API key 未配置'}}
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(2) as ex:
        fi = ex.submit(_gmgn, ['token', 'info', '--chain', 'bsc', '--address', token], key)
        fs = ex.submit(_gmgn, ['token', 'security', '--chain', 'bsc', '--address', token], key)
        info, sec = fi.result() or {}, fs.result() or {}
    if not info and not sec:
        return {'success': False, 'error': {'message': 'GMGN 未收录或请求失败'}}
    pr = info.get('price')
    price = _num(pr.get('price') if isinstance(pr, dict) else pr)
    supply = _num(info.get('circulating_supply')) or _num(info.get('total_supply'))
    mcap = _num(info.get('market_cap')) or _num(info.get('usd_market_cap'))
    if mcap is None and price is not None and supply:
        mcap = price * supply
    stat = info.get('stat') if isinstance(info.get('stat'), dict) else {}
    out = {
        'address': token,
        'name': info.get('name'),
        'symbol': info.get('symbol'),
        'logo': info.get('logo'),
        'launchpad': info.get('launchpad') or info.get('launchpad_platform'),
        'price': price,
        'market_cap': mcap,
        'liquidity': _num(info.get('liquidity')),
        'holder_count': info.get('holder_count') or stat.get('holder_count'),
        'buy_tax': _num(sec.get('buy_tax')),
        'sell_tax': _num(sec.get('sell_tax')),
        'is_honeypot': _tri(sec.get('is_honeypot')),
        'renounced': _tri(sec.get('is_renounced')),
        'open_source': _tri(sec.get('is_open_source')),
        'top10_rate': _num(sec.get('top_10_holder_rate')) or _num(stat.get('top_10_holder_rate')),
        'rug_ratio': _num(info.get('rug_ratio')),
        'social': {'twitter': info.get('twitter'), 'telegram': info.get('telegram'), 'website': info.get('website')},
    }
    return {'success': True, 'data': out}


def token_info(token):
    """GMGN data, back-filled from the bonding curve for tokens GMGN hasn't priced
    yet (fresh inner-curve launches report price/market cap as 0)."""
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(2) as ex:
        fg = ex.submit(gmgn_token_info, token)
        fc = ex.submit(lambda: run_node('routes.mjs', 'curveinfo', token, timeout=40))
        g, c = fg.result(), None
        try:
            c = fc.result()
        except Exception:
            c = None
    d = (g.get('data') if g and g.get('success') else None) or {'address': token}
    ci = c.get('data') if c and c.get('success') else None
    if ci and ci.get('route', {}).get('venue') == 'direct':
        bnb = bnb_usdt_price()
        if bnb and ci.get('priceBnb'):
            if not d.get('price'):
                d['price'] = ci['priceBnb'] * bnb
            if not d.get('market_cap') and ci.get('mcapBnb'):
                d['market_cap'] = ci['mcapBnb'] * bnb
        if d.get('buy_tax') in (None, 0, 0.0) and ci.get('buyTax') is not None:
            d['buy_tax'] = ci['buyTax']
        # GMGN reports 0 for unchecked curve tokens; trust the curve when it knows, else unknown.
        d['sell_tax'] = ci['sellTax'] if ci.get('sellTax') is not None else (d.get('sell_tax') or None)
        if not d.get('liquidity'):
            d['liquidity'] = None  # curve reserves aren't AMM liquidity; don't show $0
        d['progress'] = ci.get('progress')
        d['curve'] = True
        d['launchpad'] = d.get('launchpad') or ci['route'].get('platform')
    if not g or not g.get('success'):
        if not ci:
            return g or {'success': False, 'error': {'message': '代币信息不可用'}}
    return {'success': True, 'data': d}


_bnb_px = {'v': None, 't': 0.0}


def bnb_usdt_price():
    """BNB price in USDT from a 1 BNB baw quote, cached 30s."""
    import time
    if _bnb_px['v'] and time.time() - _bnb_px['t'] < 30:
        return _bnb_px['v']
    q = run_baw(['market-order', 'quote', '--binanceChainId', CHAIN, '--fromTokenQty', '1',
                 '--fromToken', BNB, '--toToken', USDT, '--slippage', 'auto'], timeout=20)
    try:
        v = float(q['data']['toCoinAmount'])
        _bnb_px.update(v=v, t=time.time())
        return v
    except Exception:
        return _bnb_px['v']


def _float_safe_qty(qty):
    """Short amounts pass through unchanged. Amounts with more than 15 significant
    digits (exact on-chain balances) are cut down to 15 digits, so the float the
    order service reads can't land above the wallet balance."""
    from decimal import Decimal, ROUND_DOWN
    d = Decimal(qty)
    if d <= 0 or len(d.normalize().as_tuple().digits) <= 15:
        return qty
    step = Decimal(1).scaleb(d.adjusted() - 14)
    q = d.quantize(step, rounding=ROUND_DOWN)
    while Decimal(float(q)) > d:
        q -= step
    return format(q.normalize(), 'f')


def _bg_preapprove(token):
    """Fire-and-forget: approve the post-buy holding to the platform's sell spender."""
    try:
        log = open('/tmp/preapprove.log', 'a')
        subprocess.Popen(['node', str(Path(__file__).with_name('routes.mjs')), 'preapprove', token],
                         stdout=log, stderr=log, env=_env(), start_new_session=True)
    except OSError:
        pass


def run_node(script, *args, timeout=35):
    p = subprocess.run(["node", str(Path(__file__).with_name(script)), *args],
                       capture_output=True, text=True, timeout=timeout, env=_env())
    if p.returncode != 0 and not p.stdout.strip():
        raise RuntimeError(p.stderr.strip() or "脚本执行失败")
    return json.loads(p.stdout)


def resolve_token(tok):
    """Map a UI token selector to a chain address. Accepts BNB/USDT aliases."""
    t = (tok or "").strip()
    if t.upper() == "BNB":
        return BNB
    if t.upper() == "USDT":
        return USDT
    return t


def valid_token(t):
    return bool(ADDR.fullmatch(t))


_GP_CACHE = {'ts': 0.0, 'data': None}  # /gang-progress subprocess cache


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, obj, code=200):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('content-type', 'application/json; charset=utf-8')
        self.send_header('content-length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    # ---- GET ----
    def do_GET(self):
        path = urlparse(self.path).path
        query = parse_qs(urlparse(self.path).query)
        if path == '/health':
            return self.send({'success': True})
        if path == '/meta':
            tokens = query.get('tokens', [''])[0]
            parts = [p for p in tokens.split(',') if p]
            for p in parts:
                if not valid_token(p):
                    return self.send({'success': False, 'error': {'message': 'Invalid token address'}}, 400)
            try:
                return self.send(run_node('token_meta.mjs', ','.join(parts)))
            except Exception:
                return self.send({'success': False, 'error': {'message': '余额查询未完成，请重试'}}, 502)
        if path == '/order':
            oid = query.get('id', [''])[0]
            if not re.fullmatch(r'[0-9]+', oid):
                return self.send({'success': False}, 400)
            return self.send(run_baw(['market-order', 'list', '--orderId', oid]))
        if path == '/orders':
            return self.send(run_baw(['market-order', 'list', '--binanceChainId', CHAIN, '--pageSize', '15']))
        if path == '/bnbprice':
            v = bnb_usdt_price()
            return self.send({'success': v is not None, 'data': {'usdt': v}})
        if path == '/route':
            token = query.get('token', [''])[0]
            if not valid_token(token):
                return self.send({'success': False, 'error': {'message': 'Invalid token address'}}, 400)
            try:
                return self.send(run_node('routes.mjs', 'detect', token, timeout=30))
            except Exception as e:
                return self.send({'success': False, 'error': {'message': str(e)}}, 502)
        if path == '/status':
            # Multi-source monitors: four_watch, gang_watch, and the stock-pool
            # sniper (which may run on a separate wallet). Live = heartbeat < 20s.
            now_ms = __import__('time').time() * 1000
            def _read(name):
                fp = Path.home() / '.config' / name
                try:
                    return json.loads(fp.read_text()) if fp.exists() else None
                except Exception:
                    return None
            out = {}
            for key, fname, kind in (('four', 'four-watch-status.json', 'four_watch'),
                                     ('gang', 'gang-watch-status.json', 'gang_watch'),
                                     ('snipe', 'stock-snipe-status.json', 'stock_snipe')):
                st = _read(fname)
                live = bool(st and now_ms - st.get('ts', 0) < 20000)
                out[key] = {'live': live, 'kind': kind, 'status': st}
            return self.send({'success': True, 'data': out})
        if path == '/events':
            merged = []
            for src in ('four-watch-events.json', 'gang-watch-events.json'):
                ep = Path.home() / '.config' / src
                try:
                    data = json.loads(ep.read_text()) if ep.exists() else []
                except Exception:
                    data = []
                for e in data:
                    e.setdefault('source', 'four' if src.startswith('four') else 'gang')
                merged.extend(data)
            merged.sort(key=lambda e: e.get('ts', 0), reverse=True)
            return self.send({'success': True, 'data': merged[:120]})
        if path == '/gang-progress':
            # Live graduation progress via `gang near-grad` (subprocess, cached
            # ~30s so several browser tabs / phone + desktop don't re-spawn it).
            global _GP_CACHE
            now = time.time()
            if _GP_CACHE['data'] is None or now - _GP_CACHE['ts'] > 30:
                try:
                    p = subprocess.run(['gang', 'near-grad', '--min-pct', '3', '--limit', '10'],
                                       capture_output=True, text=True, timeout=30, env=_env())
                    txt = p.stdout.strip()
                    d = json.loads(txt[txt.find('{'):txt.rfind('}') + 1])
                    _GP_CACHE = {'ts': now, 'data': d.get('tokens') or []}
                except Exception as e:
                    if _GP_CACHE['data'] is None:
                        return self.send({'success': False, 'error': {'message': f'near-grad failed: {e}'}}, 502)
            return self.send({'success': True, 'data': {'tokens': _GP_CACHE['data'], 'age': _GP_CACHE['ts']}})
        if path == '/tokeninfo':
            token = query.get('token', [''])[0]
            if not valid_token(token):
                return self.send({'success': False, 'error': {'message': 'Invalid token address'}}, 400)
            return self.send(token_info(token))
        if path in ('/panel.js', '/qrcode.js'):
            b = Path(__file__).with_name(path.lstrip('/')).read_bytes()
            self.send_response(200)
            self.send_header('content-type', 'text/javascript; charset=utf-8')
            self.send_header('content-length', str(len(b)))
            self.end_headers()
            self.wfile.write(b)
            return
        if path != '/':
            self.send_response(404)
            self.end_headers()
            return
        b = Path(__file__).with_name('panel.html').read_bytes()
        self.send_response(200)
        self.send_header('content-type', 'text/html; charset=utf-8')
        self.send_header('content-length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    # ---- POST ----
    def do_POST(self):
        # CSRF guard: allow no-origin tools (curl) and same-origin browsers
        # (origin host must equal the request Host — covers LAN access like
        # http://192.168.x.x:8787 when the panel binds 0.0.0.0 via PANEL_HOST).
        origin = self.headers.get('Origin')
        if origin is not None:
            ok = origin in ('http://127.0.0.1:8787', 'http://localhost:8787')
            if not ok:
                try:
                    ok = urlparse(origin).netloc == (self.headers.get('Host') or '')
                except Exception:
                    ok = False
            if not ok:
                return self.send({'success': False, 'error': {'message': 'Origin rejected'}}, 403)
        if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            return self.send({'success': False}, 415)
        n = int(self.headers.get('content-length', '0'))
        try:
            d = json.loads(self.rfile.read(n) or '{}')
        except Exception:
            return self.send({'success': False, 'error': {'message': '请求格式错误'}}, 400)

        if self.path == '/four/preflight':
            token = (d.get('token') or '').strip()
            if not valid_token(token):
                return self.send({'success': False, 'error': {'message': 'Invalid token contract address'}}, 400)
            try:
                return self.send(run_node('openfour_check.mjs', token))
            except Exception as e:
                return self.send({'success': False, 'error': {'message': str(e)}}, 502)

        if self.path in ('/quote', '/swap'):
            source = resolve_token(d.get('fromToken'))
            target = resolve_token(d.get('toToken'))
            if not valid_token(source) or not valid_token(target):
                return self.send({'success': False, 'error': {'message': '请提供有效的源代币和目标代币地址'}}, 400)
            if source.lower() == target.lower():
                return self.send({'success': False, 'error': {'message': '源代币和目标代币不能相同'}}, 400)
            qty = (d.get('qty') or '').strip()
            sl = d.get('slippage', 'auto')
            try:
                amount = Decimal(qty)
                if not amount.is_finite() or amount <= 0:
                    raise ValueError()
            except (InvalidOperation, ValueError, TypeError):
                return self.send({'success': False, 'error': {'message': '请输入正数数量'}}, 400)
            if sl != 'auto':
                try:
                    s = Decimal(str(sl))
                    if not s.is_finite() or not 0 < s <= 100:
                        raise ValueError()
                except (InvalidOperation, ValueError, TypeError):
                    return self.send({'success': False, 'error': {'message': '滑点需为 auto 或 0–100'}}, 400)
            # Direct-contract launchpads (AgentPad/Gang/MOAT/Flap Agent/UNITS) that the
            # baw aggregator can't route: one side must be BNB, the other the curve token.
            side = 'buy' if source.lower() == BNB.lower() else ('sell' if target.lower() == BNB.lower() else None)
            curve_token = target if side == 'buy' else source if side == 'sell' else None
            if curve_token:
                try:
                    rt = run_node('routes.mjs', 'detect', curve_token, timeout=30)
                except Exception:
                    rt = None
                if rt and rt.get('success') and rt['data'].get('venue') == 'direct':
                    slip = '10' if sl == 'auto' else str(sl)
                    amt = 'all' if (side == 'sell' and d.get('all')) else qty
                    platform = (rt['data'] or {}).get('platform')
                    if self.path == '/quote':
                        q = run_node('routes.mjs', 'quote', curve_token, side, amt, timeout=40)
                        msg = str((q.get('error') or {}).get('message') or '') if not q.get('success') else ''
                        # AlreadyGraduated(): the token left the curve after detect() ran —
                        # it now trades on DEX, so fall through to the aggregator below.
                        # flapagent excluded: graduation there means claim, not DEX liquidity.
                        grad_now = 'AlreadyGraduated' in msg or '0xe6a0d45f' in msg.lower()
                        if not q.get('success') and not (grad_now and platform != 'flapagent'):
                            return self.send(q)
                        if q.get('success'):
                            x = q['data']
                            sym_in = 'BNB' if side == 'buy' else (x.get('symbol') or d.get('fromSymbol') or 'TOKEN')
                            sym_out = (x.get('symbol') or d.get('toSymbol') or 'TOKEN') if side == 'buy' else 'BNB'
                            return self.send({'success': True, 'data': {
                                'fromCoinSymbol': sym_in, 'fromCoinAmount': qty,
                                'toCoinSymbol': sym_out, 'toCoinAmount': x.get('outHuman', '0'),
                                'slippage': float(slip) / 100, 'route': x.get('route'), 'note': x.get('note', ''), 'venue': 'direct'}})
                    t = run_node('routes.mjs', 'trade', curve_token, side, amt, slip, timeout=150)
                    if t.get('success') and side == 'buy':
                        # Approve the new holding for selling now, so the sell later is one tx.
                        _bg_preapprove(curve_token)
                    if t.get('success'):
                        res = t['data'].get('result') or {}
                        t['data']['txHash'] = res.get('txHash') if isinstance(res, dict) else None
                        t['data']['venue'] = 'direct'
                    return self.send(t)
            # Binance's order service parses the amount as a binary float. 18-digit
            # balances like 0.994356859689711303 round *up* (to …711325), which it
            # then rejects as more than the wallet holds. Send the largest 15-digit
            # value that doesn't exceed what the user typed.
            qty_api = _float_safe_qty(qty)
            args = ['market-order', 'quote' if self.path == '/quote' else 'swap',
                    '--binanceChainId', CHAIN, '--fromTokenQty', qty_api,
                    '--fromToken', source, '--toToken', target, '--slippage', str(sl)]
            if self.path == '/swap':
                gas = d.get('gasLevel', 'HIGH')
                if gas not in ('LOW', 'MEDIUM', 'HIGH'):
                    gas = 'HIGH'
                args += ['--mev', 'true', '--gasLevel', gas]
            return self.send(run_baw(args))

        if self.path == '/transfer':
            token = resolve_token(d.get('token'))
            recipient = (d.get('recipient') or '').strip()
            if not valid_token(token):
                return self.send({'success': False, 'error': {'message': '请提供有效的代币地址'}}, 400)
            if not re.fullmatch(r'0x[0-9a-fA-F]{40}', recipient):
                return self.send({'success': False, 'error': {'message': '请提供有效的接收地址(0x + 40 位十六进制)'}}, 400)
            use_max = bool(d.get('max'))
            amt = (d.get('amount') or '').strip()
            args = ['wallet', 'send', '--recipient', recipient,
                    '--binanceChainId', CHAIN, '--tokenAddress', token]
            if use_max:
                args.append('--max')
            else:
                try:
                    a = Decimal(amt)
                    if not a.is_finite() or a <= 0:
                        raise ValueError()
                except (InvalidOperation, ValueError, TypeError):
                    return self.send({'success': False, 'error': {'message': '请输入正数数量'}}, 400)
                args += ['--amount', amt]
            r = run_baw(args, timeout=120)
            if r.get('success'):
                tx = ((r.get('data') or {}).get('txHash'))
                r.setdefault('data', {})['explorer'] = f'https://bscscan.com/tx/{tx}' if tx else None
                # broadcast != confirmed: caller must poll tx-history.
                r['data']['pending'] = True
            return self.send(r)

        self.send({'success': False, 'error': {'message': 'Unknown endpoint'}}, 404)


if __name__ == '__main__':
    # PANEL_HOST=0.0.0.0 opens the panel to the LAN (e.g. phones on the same
    # Wi-Fi). Default stays loopback-only.
    host = os.environ.get('PANEL_HOST', '127.0.0.1')
    print(f'Open http://127.0.0.1:8787' + ('  (LAN: 0.0.0.0 — reachable from your phone on the same network)' if host == '0.0.0.0' else ''))
    ThreadingHTTPServer((host, 8787), Handler).serve_forever()
