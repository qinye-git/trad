# A股量化筛选系统 — 部署指南（DEPLOY.md）

> 本文档面向**另一台设备上的部署智能体**：按本文步骤即可在全新 Windows 环境完成本项目的
> 环境准备、依赖安装、数据初始化、应用启动与验证。所有命令均可在 PowerShell 中直接执行。

---

## 1. 项目简介

Electron 桌面应用 + Node.js/Python 混合架构的 A 股量化筛选系统：

- **桌面端**（`app/`）：Electron 渲染 A 股筛选结果表格，右侧详情面板展示概览、决策摘要、
  入选原因，以及**分时 / 日 / 周 / 月 K 线**（支持滚轮缩放、拖动、分时鼠标十字线追踪）。
- **数据管道**（`pipeline/` + `qscreen_all_a.mjs`）：抓取全 A 股行情与估值数据，
  按 `config/量化筛选限制.txt` 规则筛选、排序、打分，结果写入 `data/output/`。
- **Python 辅助**（`scripts/`、`valuation/`、`security_master/`）：估值数据抓取（akshare）、
  证券池构建等。

运行链路：先由 Node 管道生成筛选结果 → Electron 应用读取 `data/output` 结果表 → 点击某只股票，
主进程通过 `https.get` 直连新浪等财经接口拉取分时/K 线数据 → 前端 canvas 绘制图表。

---

## 2. 环境要求

| 依赖 | 版本要求 | 说明 |
| --- | --- | --- |
| 操作系统 | Windows 10/11 64 位 | Electron 桌面应用，必须 Windows |
| Node.js | >= 20（推荐 22.x，与 Electron 41 内置一致） | npm 随 Node 一起安装 |
| Python | 3.11（3.10~3.12 均可） | 用于 akshare 估值抓取 |
| 网络 | 可访问中国大陆财经接口 | 见 2.1 网络要求 |

### 2.1 网络要求

- 需能直连（HTTPS）以下域名：
  - `money.finance.sina.com.cn` / `quotes.sina.cn`（新浪：报价、日线、5 分钟分时 — **主数据源，必须通**）
  - `push2his.eastmoney.com`、`push2.eastmoney.com`（东财：K 线兜底）
  - `web.ifzq.gtimg.cn`（腾讯：K 线兜底）
- 代码已规避 Electron 主进程全局 `fetch` 跟随系统代理被 WAF 拦截的问题，改用 `https.get`
  直连 + zlib 解压（见 `app/main.js` 的 `httpGetJson`）。若部署机器开了全局代理/VPN，
  可能影响直连，建议直连或放行上述域名。
- 提示：腾讯/东财接口可能被 WAF 拦截或 socket 断开，属正常现象，系统会自动降级到新浪。

---

## 3. 依赖清单

### 3.1 Node.js 依赖（由 `package.json` 管理）

| 包 | 类型 | 用途 |
| --- | --- | --- |
| electron ^41.0.3 | devDependencies | 桌面应用运行时 |
| yaml ^2.8.2 | dependencies | 解析 `量化筛选限制.txt` 规则（YAML） |
| postject ^1.0.0-alpha.6 | devDependencies | 可选：SEA 单文件 exe 打包 |

安装方式：项目根目录执行 `npm install`。

### 3.2 Python 依赖（无 requirements.txt，需手动安装）

| 包 | 用途 | 备注 |
| --- | --- | --- |
| akshare | 行情/估值数据抓取 | 必须 |
| pandas | 数据处理 | 必须 |
| requests | HTTP 请求 | 必须 |
| matplotlib | 仅 `scripts/compare_strategies.py` 画图用 | 可选 |

安装方式：

```powershell
pip install akshare pandas requests
# 可选：
pip install matplotlib
```

> 运行时探测 Python 的顺序（见 `common/runtime.js`）：环境变量 `TRAD_PYTHON` → `python` → `py` → `python3`。
> 若 Python 在非标准位置，可设置 `TRAD_PYTHON` 指向解释器完整路径后启动。

---

## 4. 部署步骤（智能体可按序执行）

### Step 1：安装 Node.js 与 npm

```powershell
# 下载 Node.js 22.x LTS 安装包（https://nodejs.org/）并安装，或使用包管理器
winget install OpenJS.NodeJS.LTS
node --version   # 验证：v22.x.x
npm --version    # 验证：10.x.x
```

### Step 2：安装 Python 3.11

```powershell
winget install Python.Python.3.11
py --version     # 验证：Python 3.11.x
```

### Step 3：安装 Python 依赖

```powershell
py -m pip install akshare pandas requests
```

### Step 4：安装 Node 依赖

```powershell
cd <项目根目录>          # 例如 d:\trad
npm install
```

### Step 5：初始化配置

首次运行需从模板创建筛选规则文件（若已存在则跳过）：

```powershell
cd <项目根目录>
if (-not (Test-Path "config\量化筛选限制.txt")) {
  Copy-Item "config\量化筛选限制_template.txt" "config\量化筛选限制.txt"
}
```

`config/_rules_override.json` 由应用运行时自动生成，无需手动创建。

### Step 6：生成筛选数据（首次必须）

```powershell
npm run phase1:refresh
```

该命令执行 `node qscreen_all_a.mjs --forceRefresh true`：
- 自动生成股票池 `data/input/all_a_codes.txt` 与 K 线缓存 `data/input/kline/`
- 抓取估值数据并跑完筛选，结果写入 `data/output/`（`qscreen_all_a.json`、
  `qscreen_all_a_summary.txt`、`qscreen_all_a_candidates.txt` 等）

> 耗时会较长（全市场抓取）。日常增量运行可改用 `npm run phase1`
> （`--skipFetch true`，复用本地缓存）。
> 若部署环境无法联网抓取，可将旧环境 `data/` 目录整体拷贝过来直接复用。

### Step 7：启动桌面应用

```powershell
npm start
```

窗口标题：`A股量化筛选系统`。应用读取 `data/output` 结果并展示表格。

### Step 8：创建桌面快捷方式（推荐）

在桌面生成「A股量化筛选系统」快捷方式，双击即可启动（等效 `npm start`）：

```powershell
cd <项目根目录>
$exe = Join-Path (Get-Location).Path 'node_modules\electron\dist\electron.exe'
$ws = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = $ws.CreateShortcut((Join-Path $desktop 'A股量化筛选系统.lnk'))
$lnk.TargetPath = $exe
$lnk.Arguments = '.'
$lnk.WorkingDirectory = (Get-Location).Path
$lnk.IconLocation = "$exe,0"
$lnk.Description = 'A股量化筛选系统'
$lnk.Save()
Write-Output ("已创建: " + $lnk.FullPath)
```

> 快捷方式直接指向 `electron.exe`（参数 `.` + 工作目录为项目根），与 `npm start` 等效，
> 且带 Electron 图标。若项目路径变化，重新执行本段命令即可刷新。

---

## 5. 验证清单

1. `npm start` 后窗口正常打开，左侧表格有筛选结果数据（非空）。
2. 点击某行股票，右侧详情面板展开，显示：概览（最新价/涨跌幅等）、决策摘要、入选原因。
3. 点击"分时"tab，K 线区显示当日分时走势；鼠标移动出现十字线与
   「时间/价格/涨跌/均价/量」信息框。
4. 点击"日K"，显示蜡烛图 + MA5/10/20；滚轮可缩放（下限 20 根、上限 120 根）；
   左键按住可拖动查看历史，MA 随窗口同步移动。
5. 无控制台红色报错；若 K 线报"获取失败"，界面会显示具体原因（如 `新浪(socket hang up)`），
   属网络问题，参见 6。

---

## 6. 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| `npm install` 报 electron 下载失败 | 网络问题，可设镜像：`npm config set electron_mirror https://npmmirror.com/mirrors/electron/` 后重试 |
| 启动报找不到 `python`/`py` | 安装 Python 后重开终端；或设置 `$env:TRAD_PYTHON="C:\...\python.exe"` |
| 筛选时报 akshare 相关 ImportError | 检查 `py -m pip list` 是否含 akshare/pandas/requests |
| K 线显示"获取失败：腾讯(...)；东财(...)；新浪(...)" | 新浪也不通时多为网络问题，检查能否 ping 通 `money.finance.sina.com.cn`；确认无代理/VPN 干扰 |
| 表格为空 | 未跑 Step 6，`data/output` 无结果；执行 `npm run phase1:refresh` |
| 规则文件解析失败 | 检查 `config\量化筛选限制.txt` 存在且为有效 YAML |

---

## 7. 可选：打包为单文件 exe（SEA）

```powershell
node scripts/build_exe.mjs
```

产物：`dist/trad_screen.exe`（自包含 Node 运行时）。运行该 exe 时若找不到 Python，
需设置 `TRAD_PYTHON` 环境变量指向系统 Python。

---

## 8. 常用命令速查

| 命令 | 作用 |
| --- | --- |
| `npm start` | 启动桌面应用 |
| `npm run phase1` | 用本地缓存跑筛选（跳过抓取） |
| `npm run phase1:refresh` | 强制刷新数据后跑筛选 |
| `npm run phase2` / `phase2:refresh` | Phase 2（带估值增强）筛选 |
| `npm run phase4:replay` | 回放回测日志（Python） |
| `node scripts/build_exe.mjs` | SEA 打包 exe |
| `node scripts/kline_import.mjs` | 导入离线 K 线 CSV（格式见 `kline.sample/README.txt`） |
