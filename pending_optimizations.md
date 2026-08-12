# 项目优化任务清单（未完成）

> 生成时间：2026-08-06
> 状态说明：以下均为「功能不变」的内部优化，按收益排序。P1 收益最高，建议优先实施。

## 已完成

- [x] Pass1 / Step3 复用中间结果（`fast_pool` 复用，含过期残留 bug 修复）
- [x] 全市场筛选主循环受控并发（`runScreeningLoop` 并发池 + 增量计数）
- [x] PE/PB 全缓存命中短路（跳过合并/重算/写盘）
- [x] 统一 Node / Python 运行时调用（`common/runtime.js`）
- [x] 收敛股票池生成与新浪验活重复实现（`pipeline/stock_pool.mjs`）

### P1（2026-08-12 完成）

- [x] qscreen 库化：新增 `pipeline/qscreen_lib.mjs` 的 `runQscreen()`，`qscreen.mjs` 改为纯 CLI 包装，`stages.mjs` 的 `runPass1/runPass3` 直接库调用，去掉两次子进程中转与中间文件读回；Step3 直接复用 pass1 的内存 fast_pool 并跳过快照网络抓取。
- [x] 行情快照抓取并发化：`fetchQuoteSnapshot` 改为固定并发上限（默认 5）任务池，保留失败重试与「单批失败整体抛错、调用方兜底空 Map」语义。
- [x] security_master 解析缓存化：新增 `pipeline/security_master.mjs`（mtimeMs+size 失效键），`universe.mjs` 与 `qscreen_runner.mjs` 共用，消除重复整表解析。
- [x] 验证：9 个改动文件语法检查通过；离线冒烟 + pass1/reuse 双路径 CLI 实测 + 编排层（runPass1→runValuationStep→runPass3）全链路跑通，输出 JSON/CSV 格式与旧版一致。

### P2（2026-08-12 完成）

- [x] 估值缓存格式升级：`valuation/pipeline.py` 新增 `PEPB_CACHE_PKL`（pickle 主缓存）+ CSV 副缓存双写；`_read_pepb_cache` 优先 pickle、损坏/缺失时回退 CSV 一次性迁移；`_write_pepb_cache` 双写；全命中短路时对旧 CSV-only 环境做 pickle 一次性初始化。
- [x] 本地 K 线 CSV 读取进程内缓存：`readKlineCsv`（`qscreen_data.mjs`）以 `{path, mtimeMs, size}` 为失效键，FIFO 淘汰上限 2000 条，避免网络源限流走本地回退时的重复整表解析。
- [x] 数据源可用性探测记忆化：`probeEastmoneyKlineAccess`（`qscreen_data.mjs`）进程内缓存 + 10 分钟 TTL 落盘（`data/cache/eastmoney_probe.json`），仅缓存成功结论，失败立即重探测。
- [x] 验证：pipeline.py 单元测试（pickle 优先读取 / 损坏回退 CSV / 双写回读）全部通过；实际运行确认全命中短路与 pickle 读入；Node 侧实测确认 K 线缓存命中、mtime 变更后失效重读、探测缓存磁盘命中/内存命中/过期重探测、失败结论不落盘。

### P3（2026-08-12 完成）

- [x] UI 定时请求降频/暂停：`app/renderer.js` 窗口隐藏（visibilitychange）时完全暂停指数与个股报价刷新，恢复可见立即刷新并重新排程；个股报价在非 results tab 或无候选时降频为 5 分钟哨兵；切回结果页立即刷新一次。
- [x] get-status 轻量化：`pipeline/reporting.mjs` 新增 `writeResultMeta` 双写 `qscreen_all_a_meta.json`（仅 pipeline_meta + counts + picked，约 5KB），`qscreen_all_a.mjs` 输出后生成，`app/main.js` get-status 优先读 meta 文件，缺失时回退读完整 JSON。
- [x] 验证：5 个改动文件语法检查通过；实测 meta 文件 5659B vs 完整 JSON 4.2MB（约 746 倍瘦身），meta 读取构建的 pipelineMeta/picked 与完整 JSON 直接抽取完全一致。

---

## P1（建议优先）

### 1. qscreen 库化：去掉两次子进程中转

- **现状**：`pipeline/stages.mjs` 的 `runPass1`（[stages.mjs:L10](file:///d:/trad/pipeline/stages.mjs#L10)）和 `runPass3`（[stages.mjs:L108](file:///d:/trad/pipeline/stages.mjs#L108)）都用 `execFileSync` 跑 `qscreen.mjs` 子进程，再读回 JSON/txt。每次子进程都会重复做整套初始化：
  - 读规则 YAML（[qscreen.mjs:L152](file:///d:/trad/qscreen.mjs#L152)）
  - 探测数据源（[qscreen.mjs:L178](file:///d:/trad/qscreen.mjs#L178)）
  - 抓基准指数 K 线、补名称（[qscreen.mjs:L250](file:///d:/trad/qscreen.mjs#L250)）
  - 载入估值快照（[qscreen.mjs:L254](file:///d:/trad/qscreen.mjs#L254)）
- **改法**：把筛选核心抽成 `runQscreen()` 库函数，`qscreen.mjs` 只做 CLI 包装，`qscreen_all_a.mjs` 直接 import 调用，去掉中间文件读写与重复初始化。
- **收益**：消除整轮重复的规则解析、数据源探测、基准抓取、估值加载，全流程耗时显著下降。
- **风险**：低。需保持 CLI 输出格式不变（Electron 日志解析依赖）。

### 2. 行情快照抓取并发化

- **现状**：`fetchQuoteSnapshot`（[qscreen_data.mjs:L39-L60](file:///d:/trad/pipeline/qscreen_data.mjs#L39-L60)）按 200 只一批串行抓取东财 ulist 接口，全市场 4000+ 只时约 20+ 个请求串行执行。
- **改法**：用固定并发上限的小任务池（4-6 并发），保留现有失败重试逻辑。
- **收益**：快照阶段耗时明显缩短（受限于单接口限流，不宜开太高）。
- **风险**：低。需保持返回 `Map` 结构不变。

### 3. security_master.csv 解析结果缓存化

- **现状**：同一 CSV 被多次重复整表读取：
  - `universe.mjs` 的 `loadSecurityMaster`（[universe.mjs:L12-L28](file:///d:/trad/pipeline/universe.mjs#L12-L28)）
  - `universe.mjs` 的 `needsMasterUpdate` 再读头两行（[universe.mjs:L79-L81](file:///d:/trad/pipeline/universe.mjs#L79-L81)）
  - `qscreen_runner.mjs` 的 `fillSnapshotNamesFromSecurityMaster` 每次 qscreen 又整表读一次（[qscreen_runner.mjs:L150](file:///d:/trad/pipeline/qscreen_runner.mjs#L150)）
- **改法**：做 mtime-keyed 内存缓存；或在 `prepareUniverse()` 一次读好，把 `code->name` 映射直接传给下游。
- **收益**：减少多次重复读盘 + 解析；全量跑时至少省 1-2 次 4000+ 行 CSV 解析。
- **风险**：低。注意缓存失效键用 `mtimeMs + 文件大小`。

---

## P2（2026-08-12 已完成，详见上方记录）

### 4. 估值缓存格式升级（内部快格式 + 外部 CSV 双写）✅

- **现状**：`valuation/pipeline.py` 全程以 CSV 为主格式：
  - 读缓存（[pipeline.py:L273](file:///d:/trad/valuation/pipeline.py#L273)）
  - 合并后重算行业中位数再写回（[pipeline.py:L379-L380](file:///d:/trad/valuation/pipeline.py#L379-L380)）
  - 输出估值快照（[pipeline.py:L506](file:///d:/trad/valuation/pipeline.py#L506)）
- **改法**：内部主缓存改用 parquet / pickle（更快、类型稳定），CSV 保留给现有流程与人工查看（双写）。
- **收益**：减少 pandas 反复 `read_csv / merge / to_csv` 的 I/O 与类型推断开销。
- **风险**：中。需保证 CSV 始终同步生成，避免外部依赖（如 `loadValuationSnapshot` 读 CSV）读到旧数据。

### 5. 本地 K 线 CSV 读取进程内缓存 ✅

- **现状**：`readKlineCsv`（[qscreen_data.mjs:L244](file:///d:/trad/pipeline/qscreen_data.mjs#L244)）每次都整文件 `readFileSync + split + 解析`。
- **改法**：加 `{path, mtimeMs, size} -> parsedRows` 的进程级缓存。
- **收益**：网络源被限流、大量走本地 CSV 回退时收益明显。
- **风险**：低。注意内存占用（全市场 K 线最多几千个文件）。

### 6. 数据源可用性探测记忆化 ✅

- **现状**：`probeEastmoneyKlineAccess()`（[qscreen.mjs:L178](file:///d:/trad/qscreen.mjs#L178)）每次运行都做一次探测请求。
- **改法**：进程级缓存 + 短 TTL 落盘（例如 10 分钟）。
- **收益**：省掉每轮额外网络探测，减少首轮等待。
- **风险**：低。TTL 要足够短，避免长时间沿用过期结论。

---

## P3（2026-08-12 已完成，详见上方记录）

### 7. UI 定时请求降频/暂停 ✅

- **现状**：`app/renderer.js` 的指数刷新（[renderer.js:L315-L320](file:///d:/trad/app/renderer.js#L315-L320)）和个股实时报价（[renderer.js:L357-L365](file:///d:/trad/app/renderer.js#L357-L365)）一直定时调度。
- **改法**：窗口隐藏 / 结果 tab 不可见 / 非交易时段时降频或暂停；交易时段再恢复。
- **收益**：减少无效请求与主进程 IPC 压力。
- **风险**：极低。注意恢复时机与竞态。

### 8. get-status 轻量化（未来前瞻）✅

- **现状**：`get-status`（[main.js:L111-L145](file:///d:/trad/app/main.js#L111-L145)）每次读完整 `summary` + 完整 `qscreen_all_a.json`。当前调用频率低，尚未成为瓶颈。
- **改法**：在 `pipeline/reporting.mjs` 额外写一份轻量 `status/meta` 文件供 UI 直接读取。
- **收益**：为未来 UI 自动刷新预留空间，避免届时 `get-status` 变热点。
- **风险**：极低。属于前瞻性改造，非紧急。

---

## 推荐实施顺序

1. qscreen 库化（P1-1）
2. 行情快照并发化（P1-2）
3. security_master 解析缓存化（P1-3）
4. 估值缓存格式升级（P2-4）
5. 本地 K 线读取缓存（P2-5）
6. 数据源探测记忆化（P2-6）
7. UI 定时请求降频（P3-7）
8. get-status 轻量化（P3-8）

## 备注

- 所有项均不改变业务规则与输出格式，属于内部性能/稳定性优化。
- P1 三项对全流程耗时最直接；P2 三项对长期稳定性与大数据量场景更关键。
