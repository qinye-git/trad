# 项目风险点扫描清单

> 生成时间：2026-08-14
> 状态说明：全项目风险扫描结果，按优先级分类。高优先级建议尽快处理，中优先级按需处理，低优先级可延后。

## 高优先级

### 1. Step2 估值子进程无超时保护

- **位置**：[stages.mjs:61-66](file:///d:/trad/pipeline/stages.mjs#L61-L66)
- **现状**：`execFileSync(..., { timeout: 0 })` 无限等待 Python 子进程。上次 ROE 卡死虽已用 `os._exit(0)` 兜底，但这是"堵住一个口"——只要 Python 端再出现新的非 daemon 阻塞（新接口无超时、新后台线程），Node 侧仍会无限卡住。
- **建议**：给合理 timeout（如 300~600s），超时走估值降级逻辑（复用旧估值文件/跳过估值规则）。

### 2. 取消任务不杀 Python 孙进程

- **位置**：[main.js:298-300](file:///d:/trad/app/main.js#L298-L300)
- **现状**：`currentChild.kill()` 只杀 Node 子进程（qscreen_all_a.mjs），Node 内部通过 `execFileSync` 再起的 Python 子进程（Step2 估值、build_security_master）不会连带终止。Windows 上 `kill` 不传播进程树，会留下孤儿进程继续占网络/CPU。
- **建议**：用 `taskkill /pid <pid> /T /F`（Windows）或 spawn 时设置 `detached: false` + 进程树终止；取消时记录并清理全部子进程。

### 3. 规则 eval 执行 + 参数注入面

- **位置**：[qscreen_eval.mjs:1-10](file:///d:/trad/pipeline/qscreen_eval.mjs#L1-L10) 配合 [main.js:81-110](file:///d:/trad/app/main.js#L81-L110)
- **现状**：规则用 `new Function('ctx', 'with(ctx){...}')` 执行表达式，`applyOverrideToRules` 把 `save-params` 传来的参数值直接字符串拼进规则文件。正常 UI 只传数字/预设，风险低；但 `save-params` IPC 服务端未做类型/范围校验，若被构造恶意字符串（YAML 注入 → 规则里塞进任意 JS），可被 eval 执行。
- **建议**：对 params 做白名单 + 数值范围校验；将 `with` + `new Function` 换成受限表达式求值器（白名单字段 + 运算符）。

### 4. 时区用 UTC 导致跨日判断偏差

- **位置**：[context.mjs:35](file:///d:/trad/pipeline/context.mjs#L35)、[universe.mjs:59-69](file:///d:/trad/pipeline/universe.mjs#L59-L69)、[qscreen_all_a.mjs:76](file:///d:/trad/qscreen_all_a.mjs#L76)
- **现状**：多处用 `new Date().toISOString().slice(0,10)` 取 UTC 日期，而用户是 Asia/Shanghai（UTC+8）。每天 0:00~8:00 之间，"今日"判定会比本地晚一天，可能导致股票池/估值缓存被误判过期或未过期、回测日志 `trade_date` 偏差一天。Python 端 `datetime.now()` 用本地时间，两端不一致。
- **建议**：Node 侧改用 `Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai' })` 或统一封装 `todayCN()` 工具函数。

## 中优先级

### 5. XSS：外部数据未转义直接 innerHTML

- **位置**：[renderer.js:161-192](file:///d:/trad/app/renderer.js#L161-L192) + [index.html:5](file:///d:/trad/app/index.html#L5)
- **现状**：`renderResults` 把 `x.name`（股票名，来自新浪/东财/security_master 外部数据）、`industry` 等直接拼进 `innerHTML`，未做 HTML 转义；CSP 允许 `script-src 'unsafe-inline'`。一旦某名称含 `<img onerror=...>` 即可执行任意 JS，且能调 `window.api` 的 IPC。
- **建议**：对 name/industry/code 做 HTML 转义，或改用 `textContent` 构建 DOM；收紧 CSP（去掉 `unsafe-inline`，改用外部脚本）。

### 6. 遗留调试上报代码

- **位置**：[main.js:23-44](file:///d:/trad/app/main.js#L23-L44)
- **现状**：`reportDebugEvent` 在每次 spawn/close/error 时向 `http://127.0.0.1:7777/event` POST 调试信息。虽 catch 了错误，但属遗留代码，且若本地 7777 端口被其他进程监听会泄露脚本路径/sessionId。
- **建议**：清理该函数及其调用点（spawn-start/close/error 三处）。

### 7. save-params 无服务端校验

- **位置**：[main.js:190-198](file:///d:/trad/app/main.js#L190-L198)
- **现状**：`saveOverride` 直接 `JSON.parse` 后写盘，未校验字段类型/范围（如 `min_grade` 只应 A/B，`min_score` 应为 1~8，`adv5_vol_ratio_*` 应为数值且 min≤max）。
- **建议**：与风险 3 一并处理：服务端白名单校验 + 数值范围钳制。

## 低优先级

### 8. CSV 用 `split(',')` 解析

- **位置**：[qscreen_data.mjs:371-396](file:///d:/trad/pipeline/qscreen_data.mjs#L371-L396)、[security_master.mjs:17-35](file:///d:/trad/pipeline/security_master.mjs#L17-L35)
- **现状**：手写 `split(',')` 解析 CSV，字段内含逗号会错位（当前 A 股名称不含逗号，暂未触发）。
- **建议**：换用 csv-parse 或按列序固定解析。

### 9. probe 缓存用 `process.cwd()`

- **位置**：[qscreen_data.mjs:246](file:///d:/trad/pipeline/qscreen_data.mjs#L246)
- **现状**：`PROBE_CACHE_FILE` 依赖调用时 cwd 为项目根，非根目录运行会定位错误路径。
- **建议**：基于 `import.meta.url` 定位项目根。

### 10. 非原子写盘

- **位置**：[reporting.mjs:30-50](file:///d:/trad/pipeline/reporting.mjs#L30-L50)
- **现状**：直接 `writeFileSync` 覆盖写结果 JSON/meta，进程崩溃可能留半截文件。
- **建议**：先写临时文件再 rename（write → tmp → rename 原子替换）。

---

## 建议处理顺序

1. 风险 1（防再次卡死）
2. 风险 4（数据正确性）
3. 风险 3 + 7（参数注入）
4. 风险 5（XSS）
5. 其余按需
