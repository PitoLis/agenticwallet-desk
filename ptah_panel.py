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
import json, os, re, subprocess
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


def gmgn_token_info(token):
    """Fetch logo + safety + price for a token via gmgn-cli. Best-effort; returns a
    normalized subset so the UI can render an icon and risk badges."""
    key = _gmgn_key()
    if not key:
        return {'success': False, 'error': {'message': 'GMGN API key 未配置'}}
    try:
        env = dict(os.environ, NODE_USE_ENV_PROXY='1', GMGN_API_KEY=key)
        p = subprocess.run(['gmgn-cli', 'token', 'info', '--chain', 'bsc', '--address', token, '--raw'],
                           text=True, capture_output=True, timeout=25, env=env)
    except subprocess.TimeoutExpired:
        return {'success': False, 'error': {'message': 'GMGN 请求超时'}}
    except OSError as e:
        return {'success': False, 'error': {'message': str(e)}}
    txt = p.stdout.strip()
    try:
        i = min(x for x in (txt.find('{'), txt.find('[')) if x >= 0)
        d = json.loads(txt[i:])
    except Exception:
        return {'success': False, 'error': {'message': (p.stderr or txt or 'GMGN 无响应')[:200]}}
    data = d.get('data', d) if isinstance(d, dict) else d
    price = data.get('price') if isinstance(data.get('price'), dict) else {}
    out = {
        'address': token,
        'name': data.get('name'),
        'symbol': data.get('symbol'),
        'logo': data.get('logo'),
        'launchpad': data.get('launchpad') or data.get('launchpad_platform'),
        'price': price.get('price') or data.get('price') if not isinstance(data.get('price'), dict) else price.get('price'),
        'market_cap': data.get('market_cap'),
        'liquidity': data.get('liquidity'),
        'holder_count': data.get('holder_count'),
        'buy_tax': data.get('buy_tax'),
        'sell_tax': data.get('sell_tax'),
        'is_honeypot': data.get('is_honeypot'),
        'renounced': data.get('owner_renounced'),
        'rug_ratio': data.get('rug_ratio'),
        'social': {'twitter': data.get('twitter'), 'telegram': data.get('telegram'), 'website': data.get('website')},
    }
    return {'success': True, 'data': out}


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
        if path == '/route':
            token = query.get('token', [''])[0]
            if not valid_token(token):
                return self.send({'success': False, 'error': {'message': 'Invalid token address'}}, 400)
            try:
                return self.send(run_node('routes.mjs', 'detect', token, timeout=30))
            except Exception as e:
                return self.send({'success': False, 'error': {'message': str(e)}}, 502)
        if path == '/status':
            sp = Path.home() / '.config/four-watch-status.json'
            try:
                st = json.loads(sp.read_text()) if sp.exists() else None
            except Exception:
                st = None
            # consider the watcher live if it wrote a heartbeat within 20s
            live = bool(st and (__import__('time').time() * 1000 - st.get('ts', 0) < 20000))
            return self.send({'success': True, 'data': {'live': live, 'status': st}})
        if path == '/events':
            ep = Path.home() / '.config/four-watch-events.json'
            try:
                data = json.loads(ep.read_text()) if ep.exists() else []
            except Exception:
                data = []
            return self.send({'success': True, 'data': data})
        if path == '/tokeninfo':
            token = query.get('token', [''])[0]
            if not valid_token(token):
                return self.send({'success': False, 'error': {'message': 'Invalid token address'}}, 400)
            return self.send(gmgn_token_info(token))
        if path == '/panel.js':
            b = Path(__file__).with_name('panel.js').read_bytes()
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
        if self.headers.get('Origin') not in (None, 'http://127.0.0.1:8787', 'http://localhost:8787'):
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
                    if self.path == '/quote':
                        q = run_node('routes.mjs', 'quote', curve_token, side, amt, timeout=40)
                        if not q.get('success'):
                            return self.send(q)
                        x = q['data']
                        sym_in = 'BNB' if side == 'buy' else (x.get('symbol') or d.get('fromSymbol') or 'TOKEN')
                        sym_out = (x.get('symbol') or d.get('toSymbol') or 'TOKEN') if side == 'buy' else 'BNB'
                        return self.send({'success': True, 'data': {
                            'fromCoinSymbol': sym_in, 'fromCoinAmount': qty,
                            'toCoinSymbol': sym_out, 'toCoinAmount': x.get('outHuman', '0'),
                            'slippage': float(slip) / 100, 'route': x.get('route'), 'note': x.get('note', ''), 'venue': 'direct'}})
                    t = run_node('routes.mjs', 'trade', curve_token, side, amt, slip, timeout=150)
                    if t.get('success'):
                        res = t['data'].get('result') or {}
                        t['data']['txHash'] = res.get('txHash') if isinstance(res, dict) else None
                        t['data']['venue'] = 'direct'
                    return self.send(t)
            args = ['market-order', 'quote' if self.path == '/quote' else 'swap',
                    '--binanceChainId', CHAIN, '--fromTokenQty', qty,
                    '--fromToken', source, '--toToken', target, '--slippage', str(sl)]
            if self.path == '/swap':
                gas = d.get('gasLevel', 'HIGH')
                if gas not in ('LOW', 'MEDIUM', 'HIGH'):
                    gas = 'HIGH'
                args += ['--mev', 'true', '--gasLevel', gas]
            return self.send(run_baw(args))

        self.send({'success': False, 'error': {'message': 'Unknown endpoint'}}, 404)


if __name__ == '__main__':
    print('Open http://127.0.0.1:8787')
    ThreadingHTTPServer(('127.0.0.1', 8787), Handler).serve_forever()
