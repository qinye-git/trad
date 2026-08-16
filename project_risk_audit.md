# 项目风险点扫描清单

> 生成时间：2026-08-14
> 状态说明：全项目风险扫描结果，按优先级分类。高优先级建议尽快处理，中优先级按需处理，低优先级可延后。

## 高优先级

### 1. Step2 估值子进程无超时保护

- **位置**：[stages.mjs:61-66](file:///d:/trad/pipeline/stages.mjs#L61-L66)
- **现状**：`execFileSync(..., { timeout: 0 })` 无限等待 Python 子进程。上次 ROE 卡死虽已用 `os._exit(0)` 兜底，但这是"堵住一个口"——只要 Python 端再出现新的非 daemon 阻塞（新接口无超时、新后台线程），Node 侧仍会无限卡住。
- **建议**：给合理 timeout（如 300~600s），超时走估值降级逻辑（复用旧估值文件/跳过估值规则）。

### 2. 取消任务不杀 Python 孙进程 ✅ 已修复（2026-08-14）

- **位置**：[main.js:282-296](file:///d:/trad/app/main.js#L282-L296)
- **现状（修复前）**：`currentChild.kill()` 只杀 Node 子进程（qscreen_all_a.mjs），Node 内部通过 `execFileSync` 再起的 Python 子进程（Step2 估值、build_security_master）不会连带终止。Windows 上 `kill` 不传播进程树，会留下孤儿进程继续占网络/CPU。
- **修复**：新增 `killProcessTree`——Windows 用 `taskkill /pid <pid> /T /F` 杀整棵进程树；非 Windows 用负 pid `SIGKILL` 杀进程组（spawn 加 `detached: true`）。替换 update-codes / run-screen / run-screen-full / cancel-task 全部 4 处 `currentChild.kill()`。

### 3. 规则 eval 执行 + 参数注入面 ✅ 已修复（2026-08-14）

- **位置**：[qscreen_eval.mjs:1-66](file:///d:/trad/pipeline/qscreen_eval.mjs#L1-L66) 配合 [main.js:86-122](file:///d:/trad/app/main.js#L86-L122)
- **现状（修复前）**：规则用 `new Function('ctx', 'with(ctx){...}')` 执行表达式，`applyOverrideToRules` 把 `save-params` 传来的参数值直接字符串拼进规则文件。正常 UI 只传数字/预设，风险低；但 `save-params` IPC 服务端未做类型/范围校验，若被构造恶意字符串（YAML 注入 → 规则里塞进任意 JS），可被 eval 执行。
- **修复**（双层防御）：
  - `qscreen_eval.mjs`：新增 `assertSafeExpr`（标识符黑名单拦截 constructor/prototype/process/require/eval 等 + 字符白名单 + 禁箭头函数），ctx 用 `makeCtxProxy` 包裹（仅暴露自有数据字段，阻断原型链）；`new Function` 仅执行通过校验的表达式。
  - `main.js`：新增 `PARAM_SCHEMA` + `sanitizeParams`，`save-params` 服务端白名单校验（未知字段丢弃，数值/枚举钳制），非法参数无法注入规则文件。
  - 验证：8 条真实规则表达式全部正常求值；8 类恶意载荷（constructor 链、process、require、分号注入、箭头函数、模板串、globalThis、Math.constructor）全部被拦截。

### 4. 时区用 UTC 导致跨日判断偏差 ✅ 已修复（2026-08-14）

- **位置**：[context.mjs:35](file:///d:/trad/pipeline/context.mjs#L35)、[universe.mjs:40](file:///d:/trad/pipeline/universe.mjs#L40)、[universe.mjs:68](file:///d:/trad/pipeline/universe.mjs#L68)、[qscreen_all_a.mjs:76](file:///d:/trad/qscreen_all_a.mjs#L76)、[stages.mjs:96](file:///d:/trad/pipeline/stages.mjs#L96)、[main.js:159-162](file:///d:/trad/app/main.js#L159-L162)
- **现状（修复前）**：多处用 `new Date().toISOString().slice(0,10)` 取 UTC 日期，而用户是 Asia/Shanghai（UTC+8）。每天 0:00~8:00 之间，"今日"判定会比本地晚一天，可能导致股票池/估值缓存被误判过期或未过期、回测日志 `trade_date` 偏差一天。Python 端 `datetime.now()` 用本地时间，两端不一致。
- **修复**：新增 [common/date.js](file:///d:/trad/common/date.js) 统一 `todayCN()`（`Intl.DateTimeFormat` Asia/Shanghai 时区，输出 YYYY-MM-DD），替换全部 7 处 UTC 日期取法（context/universe×2/qscreen_all_a/stages/main.js×2）。验证：UTC 22:00（北京次日 06:00）正确解析为次日，旧实现确实跨日偏差；ESM/CJS 双侧导入均正常。

## 中优先级

### 5. XSS：外部数据未转义直接 innerHTML ✅ 已修复（2026-08-14）

- **位置**：[renderer.js:161-192](file:///d:/trad/app/renderer.js#L161-L192) + [index.html:5](file:///d:/trad/app/index.html#L5)
- **现状（修复前）**：`renderResults` 把 `x.name`（股票名，来自新浪/东财/security_master 外部数据）、`industry` 等直接拼进 `innerHTML`，未做 HTML 转义；CSP 允许 `script-src 'unsafe-inline'`。一旦某名称含 `<img onerror=...>` 即可执行任意 JS，且能调 `window.api` 的 IPC。
- **修复**（双层防御）：
  - `renderer.js`：新增 `esc()` 转义函数（`& < > " '` → 实体），`renderResults` 中对全部外部字段（`x.code`/`x.name`/`x.grade`/`industry`/`industryTitle`/`asof`/`bench`）统一转义后再拼入 `innerHTML`；`data-code` 属性同样转义，`fetchLiveQuotes` 改用 `getAttribute` 取解码后的原始 code 匹配（避免 CSS 属性选择器被注入值破坏）。日志/摘要/进度等其余输出点本就使用 `textContent`，无注入面。
  - `index.html`：CSP 收紧为 `script-src 'self'`（去掉 `unsafe-inline`）；13 处内联 `onclick`/`oninput`/`onchange` 全部迁移到 renderer.js 的 `addEventListener`（新增 `bindUI()`），按钮补 `id`。`style-src 'unsafe-inline'` 保留（HTML 有大量静态内联 style，无外部数据进入）。
  - 验证：`electron.exe --check` 语法通过；esc 对 `<img onerror=...>`、引号属性注入、`'-alert(1)-'` 等载荷均正确转义为实体（PASS=true），正常中文/数字不受影响。

### 6. 遗留调试上报代码 ✅ 已修复（2026-08-14）

- **位置**：[main.js:23-44](file:///d:/trad/app/main.js#L23-L44)
- **现状（修复前）**：`reportDebugEvent` 在每次 spawn/close/error 时向 `http://127.0.0.1:7777/event` POST 调试信息。虽 catch 了错误，但属遗留代码，且若本地 7777 端口被其他进程监听会泄露脚本路径/sessionId。
- **修复**：删除 `reportDebugEvent` 函数、`DEBUG_ENV_FILE` 常量及 spawn-start/close/error 三处调用点（含 `#region debug-point` 标记）。`fetch` 无其他使用点，`https`/`fs` 保留（行情请求与参数读写仍在用）。验证：`electron.exe --check` 语法通过；全项目 grep `reportDebugEvent|DEBUG_ENV_FILE|debug-point|127.0.0.1:7777` 无残留。

### 7. save-params 无服务端校验 ✅ 已修复（2026-08-14，随第 3 项一并处理）

- **位置**：[main.js:86-122](file:///d:/trad/app/main.js#L86-L122)
- **现状（修复前）**：`saveOverride` 直接 `JSON.parse` 后写盘，未校验字段类型/范围（如 `min_grade` 只应 A/B，`min_score` 应为 1~8，`adv5_vol_ratio_*` 应为数值且 min≤max）。
- **修复**：`sanitizeParams` 白名单校验——未知字段丢弃，number/integer/enum/boolean 按 schema 钳制。

## 低优先级

### 8. CSV 用 `split(',')` 解析 ✅ 已修复（2026-08-14）

- **位置**：[qscreen_data.mjs:371-396](file:///d:/trad/pipeline/qscreen_data.mjs#L371-L396)、[security_master.mjs:17-35](file:///d:/trad/pipeline/security_master.mjs#L17-L35)
- **现状（修复前）**：手写 `split(',')` 解析 CSV，字段内含逗号会错位（当前 A 股名称不含逗号，暂未触发）。两个 CSV（`valuation_snapshot_daily.csv`、`security_master.csv`）均由 pandas `to_csv` 生成（默认 QUOTE_MINIMAL），一旦名称/行业字段含逗号或引号，会被 `"..."` 包裹、内部引号 `""` 转义，`split(',')` 必然错位。
- **修复**：[qscreen_data.mjs](file:///d:/trad/pipeline/qscreen_data.mjs) 新增导出 `parseCsvLine`（支持引号包裹字段与 `""` 引号转义，兼容 pandas QUOTE_MINIMAL 输出），`loadValuationSnapshot` 与 [security_master.mjs](file:///d:/trad/pipeline/security_master.mjs)（headers/每行/updated 共 3 处）全部改用。其余 `split(',')` 点为纯数字字段（东财 kline 数组、本地 K线 CSV、新浪行情名取首个字段），无逗号风险，保持不动。验证：`electron.exe --check` 语法通过；parseCsvLine 对含逗号字段（`"平安,银行"`）、含引号字段（`"万科""A"""`）均解析正确（PASS=true），普通行不受影响。

### 9. probe 缓存用 `process.cwd()` ✅ 已修复（2026-08-14）

- **位置**：[qscreen_data.mjs:246](file:///d:/trad/pipeline/qscreen_data.mjs#L246)
- **现状（修复前）**：`PROBE_CACHE_FILE` 依赖调用时 cwd 为项目根，非根目录运行会定位错误路径（eastmoney probe 缓存落不到/读不到正确文件）。
- **修复**：[qscreen_data.mjs](file:///d:/trad/pipeline/qscreen_data.mjs) 新增 `PROJECT_ROOT` 常量——用 `fileURLToPath(import.meta.url)` 从模块自身位置（pipeline/ 上一级）推导项目根，`PROBE_CACHE_FILE` 改基于它拼接。模块内其余路径均经函数入参传入，无其他 cwd 依赖。验证：从 `D:\trad\scripts` 目录运行，模块加载正常、`PROJECT_ROOT=d:\trad`、probe 文件定位 `d:\trad\data\cache\eastmoney_probe.json`（PASS=true）。

### 10. 非原子写盘 ✅ 已修复（2026-08-14）

- **位置**：[reporting.mjs:30-50](file:///d:/trad/pipeline/reporting.mjs#L30-L50)
- **现状（修复前）**：直接 `writeFileSync` 覆盖写结果 JSON/meta，进程崩溃可能留半截文件。
- **修复**：[reporting.mjs](file:///d:/trad/pipeline/reporting.mjs) 新增 `writeFileAtomic`（写同目录 `.name.pid.tmp` 临时文件 → `rename` 原子替换；rename 失败极端情况回退直接写保证任务不失败）。`writeResultWithMeta`（结果 JSON）、`writeResultMeta`（轻量 meta）、`writeSummary`（摘要 txt）3 处覆盖写全部改用。`appendBacktestLog` 为追加写（行级，崩溃最多丢一行），不属覆盖写风险，保持不动。验证：`electron.exe --check` 语法通过；从非根目录运行，meta/summary 写入正确、二次覆盖生效、无 `.tmp` 残留（PASS=true）。

---

## 建议处理顺序

1. 风险 1（防再次卡死）
2. 风险 4（数据正确性）
3. 风险 3 + 7（参数注入）
4. 风险 5（XSS）
5. 其余按需
