# 复刻 Prompt — Agent Desk（BSC 本地交易台 + Four.meme 抢购监控）

把下面整段交给一个有编码能力的 AI 助手（Claude Code / Codex / Cursor 等），它就能从零复刻出一个功能完备、同款的本地面板。已按"可直接执行"的粒度写清目标、架构、每个文件职责、链上事实和验收标准。

---

## 一、总体目标

做一个**本地运行**的 BSC（BNB Chain，chainId 56）交易面板，精致白 + 香槟金奢华风格（商业 product UI，不是炫技落地页），具备：

1. **聚合兑换**：任意代币互换、USDT⇄BNB 快捷对、方向反转、滑点/Gas 设置、实时报价、价格影响、25%/50%/75%/最大 百分比快捷填入、订单历史。
2. **代币信息展示**：输入合约地址即展示该币的 logo、名称、价格、市值、流动性、持有人、买卖税、貔貅/rug 风险徽章。代币选择器里"搜到即展示内容"，不是裸导入。
3. **Four.meme 新币抢购监控 + 自动买入**：事件驱动监听指定模板的新币，命中后自动用固定 BNB 预算买入；买不进（白名单/revert）自动跳过下一个；买到后桌面弹窗 + 面板事件；持仓到 10 倍弹窗提醒（只提醒不自动卖）。
4. **三视图面板**：兑换 / 抢购监控 / 记录；钱包 blockies 几何 logo；监控状态仪表盘（live/armed、模板、预算、最新区块、已买/已跳/WSS/心跳）。

**硬约束**：面板不持有私钥。所有签名、授权、风控、广播都委托本机已登录的钱包 CLI（见下）。面板只做只读查询 + 发起交易请求。

---

## 二、运行环境与外部依赖

- **操作系统**：macOS（桌面通知用 `osascript`；换 Linux 改用 `notify-send`）。
- **语言**：后端 Python 3（仅标准库，`http.server`）；脚本 Node.js（ESM，需 `ws` 包做 WebSocket）。无前端框架、无构建步骤，纯 HTML + 原生 JS。
- **钱包 CLI**：Binance Agentic Wallet CLI，命令名 `baw`，须已登录、已开启 Developer Mode。用到：
  - `baw wallet address --json` → 取当前钱包地址（取 binanceChainId==='56' 那条）。
  - `baw market-order quote --binanceChainId 56 --fromTokenQty <qty> --fromToken <addr> --toToken <addr> --slippage <auto|0-100> --json` → 聚合报价，返回 `{fromCoinSymbol,fromCoinAmount,toCoinSymbol,toCoinAmount,slippage}`。
  - `baw market-order swap ...（同上）--mev true --gasLevel <LOW|MEDIUM|HIGH> --json` → 下单，返回 `{orderId}`。
  - `baw market-order list --orderId <id> --json` / `--binanceChainId 56 --pageSize 15 --json` → 查单/历史，单条含 `status(FINISHED|PENDING|FAILED)`、`toTokenActualQty`、`txHash`、`bookTime`。
  - `baw contract-call preview --binanceChainId 56 --from <wallet> --to <contract> --value <wei> --inputData <hex> --json` → 自定义调用的只读模拟，成功返回 `{requestId}`，失败 `success:false`。
  - `baw contract-call execute --requestId <id> --json` → 执行上一步预览。
  - 所有 `baw` 调用都带环境变量 `NODE_USE_ENV_PROXY=1`（本机 Node fetch 需走本地代理）。baw 输出是美化多行 JSON，解析时从第一个 `{`/`[` 切到最后一个 `}`/`]`。
- **行情 CLI**（可选但推荐）：GMGN OpenAPI CLI，命令 `gmgn-cli`，API key 放 `~/.config/gmgn/.env` 的 `GMGN_API_KEY=...`。用到 `gmgn-cli token info --chain bsc --address <addr> --raw` → 返回 `{name,symbol,logo,launchpad(_platform),price|price.price,market_cap,liquidity,holder_count,buy_tax,sell_tax,is_honeypot,owner_renounced,rug_ratio,twitter,telegram,website}`。
- **RPC**：免费 BSC 公共节点。WebSocket newHeads 用 `wss://bsc-rpc.publicnode.com` 和 `wss://bsc.publicnode.com`（双路热备）。`eth_getLogs` 用支持小范围查询的节点轮换（publicnode HTTP + 一个 nodereal 免费端点）；公共 dataseed 不支持 getLogs 范围查询。
- **常量**（BSC 主网）：
  - BNB 占位：`0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE`
  - USDT：`0x55d398326f99059fF775485246999027B3197955`

---

## 三、文件清单与职责

### 1. `ptah_panel.py` — 本地 HTTP 服务器（stdlib，端口 127.0.0.1:8787）
ThreadingHTTPServer + 一个 Handler。安全：POST 校验 Origin 为 127.0.0.1:8787/localhost:8787，Content-Type 必须 application/json，所有 token 参数用 `^0x[a-fA-F0-9]{40}$` 校验。端点：

- `GET /` → 返回 panel.html；`GET /panel.js` → 返回 panel.js。
- `GET /health` → `{success:true}`。
- `GET /meta?tokens=a,b` → 调 token_meta.mjs，返回钱包 BNB/USDT 余额 + 每个 token 的链上 name/symbol/decimals/balance。
- `GET /tokeninfo?token=` → 调 gmgn-cli token info，归一化返回 logo/价格/税/风险等（见上字段）。
- `GET /order?id=` → `baw market-order list --orderId`。
- `GET /orders` → `baw market-order list --pageSize 15`。
- `GET /status` → 读 `~/.config/four-watch-status.json`，附 `live`（心跳 20 秒内算在线）。
- `GET /events` → 读 `~/.config/four-watch-events.json`（买入/10倍事件数组）。
- `POST /quote`、`POST /swap` → 解析 `{fromToken,toToken,qty,slippage,gasLevel}`，token 支持 "BNB"/"USDT" 别名解析为地址，校验正数数量和 0–100 或 auto 滑点，调对应 baw market-order。
- `POST /four/preflight` → 调 openfour_check.mjs 只读核查某代币。

超时统一兜底返回 `{success:false,error:{message}}`，不抛栈。

### 2. `token_meta.mjs` — 任意代币元数据 + 钱包余额
入参逗号分隔的 token 列表。用 `baw wallet address` 取钱包；对每个 token 走公共 RPC eth_call 读 `name()/symbol()/decimals()/balanceOf(wallet)`，BNB/USDT 余额单独读。输出 `{success,data:{wallet,BNB,USDT,tokens:{<addr>:{address,name,symbol,decimals,balance}}}}`。字符串解码兼容 bytes32 和 ABI string 两种。

### 3. `openfour_check.mjs` — Four.meme V12 模板只读核查
读官方地址表 `https://four.meme/meme-api/v1/public/address`（取 BSC 的 OpenFourCore/OpenFourTools/OpenFourRegistry），核查某 token 是否注册、presetId、交易模块、Agent ID NFT 识别、授权额度，做一次只读买入模拟判断能否买。输出结论和 blocker 文案。

### 4. `four_watch.mjs` — 抢购监控 + 自动买入（核心）
见第四节的链上机制。要点：
- 启动缓存钱包地址（省每次查询）。
- 双 WSS 订阅 `eth_subscribe newHeads`；每到新块，节流（默认 1.2s 合并）对 OpenFourCore 发 `eth_getLogs`，topic 过滤 `[TokenCreated, presetId]` 精确命中目标模板新币。
- HTTP 轮询兜底（断线扫漏块）+ 写心跳状态文件。
- 命中新币 → 预构 `buyByBudget` calldata → `baw contract-call preview`；
  - preview 成功且 armed → `execute` 真买；成功记 `bought`，桌面通知 + 写事件。
  - preview 失败（白名单 revert 等）→ 记 `skipped`，**跳下一个，不重试**。
- 排除已知测试代币；买过的不重买；买卖都用 preview 先验证。
- 买到后记录入场价（走 gmgn-cli 实时价，链上 estimate 在低流动性会返 0 不可靠）；独立循环轮询持仓价，到 10 倍写事件 + 桌面通知（只提醒不卖）。
- 环境变量：`FOUR_ARM=1`（真买，否则演练）、`FOUR_BUDGET_BNB`（默认 0.01）、`FOUR_PRESET`、`FOUR_SCAN_MIN_MS`、`FOUR_FALLBACK_MS`。
- 状态写 `~/.config/four-watch-status.json`：`{ts,pid,armed,budgetBnb,preset,presetName,head,bought,skipped,wss}`。事件写 `~/.config/four-watch-events.json`（数组，最多 100 条，新的在前）。

### 5. `panel.html` + `panel.js` — 前端（见第五节设计）

---

## 四、Four.meme V12「Agent ID Exclusive」链上机制（复刻监控必读）

这些是链上实测事实（用 anvil fork + cast trace + 读字节码得出），直接用：

- **OpenFourCore**：`0xebe7b6c1089d9f72ad07f34e36d898e44e5e27f3`。买入入口是 `buyByBudget(address token, uint256 budgetWei, uint256 minOut, uint256 options, bytes proof)`，选择器 `0x995ee6da`（**不是** `buy`）。calldata 静态布局：`0x995ee6da + pad(token) + pad(budgetWei) + pad(0) + pad(0) + pad(160) + pad(0)`（pad = 左补 0 到 64 hex）。调用时 `value = budgetWei`。
- **模板 preset**：OpenFourRegistry `0x912cef0c3ae9ab6eb3ec87cab69371cfb317ab94`。"Binance Agent ID Exclusive" 模板的 presetId = `1778027615735`。`isPresetActive(presetId)` 为 true 才活跃。一种机制固定一个 preset 号（另有 Tapeout Meme V1 = …734）。
- **TokenCreated 事件**（监听新币用）：topic0 = `0x7dae4dcd1b20eb0445e7cc1d02b3e2e7f32fa63081a0e764732c269f2b8f228f`，topic1 = presetId（indexed），topic3 = token 地址（indexed）。用 `eth_getLogs topics:[TC_TOPIC, pad(presetId)]` 可只收目标模板的新币。
- **OpenFourTools**：`0x97da82f56fef1a0b974587a48135fa9da2a4e905`，`estimateBuyByBudget/estimateSell` 返回 `(curveQuote,totalFee,userPays,userReceives,tokenAmount,executionPrice)`。费率 = totalFee/curveQuote，实测**买入 2% / 卖出 2%**。
- **两道准入（叠加）**：买入模块依次检查 ① 持有 SPACE ID Agent ID NFT（集合 `0x60b9262456de011f7d15a54cdd8c48baaa8b022f`）balanceOf≥1；② 该模板白名单合约 `0x7b377Ad70A20556F4778C4CD878a68A7E7EFaBBc` 的 `371befa6(presetId, wallet)` 返回 1。两者都满足才能买，否则 revert 自定义错误 `0xa2dda494`。白名单由官方运营地址批量 `setWhitelisted` 写入。
- **结论**：某钱包能否买某模板币，不要靠猜，直接用 `baw contract-call preview` 跑一次只读模拟——它会把激活/NFT/白名单全跑完，成功即真能买。监控就以"preview 成功"为唯一买入判据，对变化（换 preset、改白名单）天然健壮。

> 复刻者注意：这些地址与 preset 是 2026-10 的现网值，官方可能更新。稳妥做法是监控不写死太多假设，核心判据永远是 preview 模拟是否通过。

---

## 五、前端设计规范（精致白 + 金色奢华 · product register）

- **调色（OKLCH 推理，输出可用 hex/oklch）**：暖象牙白底（非纯白），纯白卡片浮起，极细暖灰半透明描边 + 柔投影；主强调 = 香槟金/古铜金（CTA、选中态、logo、活跃态金边），涨=克制绿、跌=克制红；不用纯 #fff/#000，中性色微偏暖。固定 SVG feTurbulence 颗粒底纹 opacity≈0.03 压扁矢量感。标题负字距、紧行高；所有数字 `font-variant-numeric: tabular-nums`。
- **顶栏**：钱包地址生成的 blockies 几何 logo（canvas，金色系调色板，8×8 对称）；三视图导航「兑换 / 抢购监控 / 记录」带金色下划线高亮；右上监控状态 chip（live→金/绿点，armed→金底，离线→红点）。favicon 用同系金色几何方块 SVG 内嵌进 `<head>`。
- **兑换视图**：金边主卡（支付腿 + 反转按钮 + 收到腿）；支付腿下 25%/50%/75%/最大 四个比例按钮（按余额比例填入，原生 BNB 先扣 0.001 gas 预留再乘比例）；USDT→BNB / BNB→USDT 快捷对；滑点(自动/0.5/1/3/自定义)与 Gas(低/中/高) 折叠设置；输入防抖 380ms 自动报价，显示汇率/最小到账/价格影响；下方代币信息卡（logo/价格/市值/流动性/持有人/买卖税 + 风险徽章）。右列钱包余额 + 最近兑换。
- **监控视图**：仪表盘卡（靶心图标 + 武装/演练 + 运行药丸、模板名+preset、预算金色、最新区块、已买/已跳/WSS/心跳，数据从 /status 每 6 秒刷）；事件流（买入✅/10倍🚀，带 bscscan 链接）；Four.meme 只读核查输入框。
- **记录视图**：兑换历史 + 监控事件两栏。
- **代币选择器 dialog（关键交互）**：输入框粘贴完整 0x 地址 → 立即并行拉 /meta + /tokeninfo → 在弹窗内渲染**富信息卡**（logo、名称·符号、地址+launchpad、价格/流动性/余额/市值/买卖税、风险徽章、金色"选择 XXX"按钮），而不是一行"导入"。非地址输入则按名称/符号过滤已知代币列表。选中后缓存进已知列表。
- 无障碍：焦点态可见、对比度达标、`prefers-reduced-motion` 关动画、移动端单列。

---

## 六、启动与验收

```bash
# 1. 装依赖
npm i ws@8
# 2. 起面板
NODE_USE_ENV_PROXY=1 python3 ptah_panel.py        # http://127.0.0.1:8787
# 3. 起监控（演练先 FOUR_ARM 不设；确认无误再 =1 真买）
GMGN_API_KEY=$(grep GMGN_API_KEY ~/.config/gmgn/.env|cut -d= -f2) \
NODE_USE_ENV_PROXY=1 FOUR_ARM=1 FOUR_BUDGET_BNB=0.01 node four_watch.mjs
```

验收清单：
- [ ] `/health` 返回 success；三视图切换正常；blockies logo 和 favicon 显示金色几何。
- [ ] 兑换：输入数量自动出报价；25/50/75/最大 按余额正确填入（BNB 扣 gas 预留）；下单后轮询到 FINISHED。
- [ ] 代币选择器粘贴合约 → 展示该币 logo/价格/税/风险，而非"导入"。
- [ ] 监控：/status live=true、armed、head 实时；命中目标模板新币会 preview→（能买则 execute）→ 桌面弹窗 + 面板事件；买不进自动跳过不烧 gas。
- [ ] 10 倍持仓触发桌面提醒 + 事件（不自动卖）。
- [ ] 全程无私钥落地，签名都经 baw。

---

## 七、关键坑（复刻者直接避开）

1. baw/gmgn 输出是美化多行 JSON，别按行找 `{` 解析，要切第一个 `{` 到最后一个 `}`。
2. 本机 Node fetch 超时 → 所有子进程带 `NODE_USE_ENV_PROXY=1`。
3. 每块都 getLogs 会瞬间打爆免费 RPC 额度 → 必须节流合并 + 多端点轮换。
4. 公共 dataseed 不支持 getLogs 范围查询，WSS newHeads 要用 publicnode 系。
5. 代币价格别用链上 estimate 的 executionPrice（低流动性返 0），用 gmgn-cli 实时价。
6. 自动买入唯一判据是 `contract-call preview` 成功，别靠写死 preset/白名单假设去猜能不能买。
7. 桌面通知用 `osascript -e 'display notification ... with title ... sound name "Glass"'`，做成 best-effort 不阻塞主流程。
