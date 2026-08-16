const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const zlib = require('zlib');
const { spawn, execFileSync } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { getNodeRuntime } = require('../common/runtime.js');
const { todayCN } = require('../common/date.js');

let mainWindow;
const ROOT_DIR = path.join(__dirname, '..');
const CONFIG_DIR = path.join(ROOT_DIR, 'config');
const INPUT_DIR = path.join(ROOT_DIR, 'data', 'input');
const OUTPUT_DIR = path.join(ROOT_DIR, 'data', 'output');
const SCRIPTS_DIR = path.join(ROOT_DIR, 'scripts');
const RULES_FILE = path.join(CONFIG_DIR, '量化筛选限制.txt');
const RULES_OVERRIDE_FILE = path.join(CONFIG_DIR, '_rules_override.json');

fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.mkdirSync(INPUT_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 860, minWidth: 1000, minHeight: 640,
    title: 'A股量化筛选系统',
    backgroundColor: '#0f1117',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.setMenuBarVisibility(false);
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

const PRESETS = {
  strict: { label:'严格模式', beat_benchmark_threshold:0.015, up_days_10d_min:6, adv5_vol_ratio_min:1.10, adv5_vol_ratio_max:1.80, above_ma20:true, min_score:4, min_grade:'A' },
  normal: { label:'标准模式', beat_benchmark_threshold:0.0,   up_days_10d_min:5, adv5_vol_ratio_min:0.90, adv5_vol_ratio_max:2.50, above_ma20:true, min_score:2, min_grade:'A' },
  loose:  { label:'宽松模式', beat_benchmark_threshold:-0.01, up_days_10d_min:4, adv5_vol_ratio_min:0.80, adv5_vol_ratio_max:3.00, above_ma20:false,min_score:1, min_grade:'B' },
};

function loadOverride() {
  try {
    if (fs.existsSync(RULES_OVERRIDE_FILE))
      return JSON.parse(fs.readFileSync(RULES_OVERRIDE_FILE, 'utf8'));
  } catch(e) {}
  return null;
}

function saveOverride(params) {
  fs.writeFileSync(RULES_OVERRIDE_FILE, JSON.stringify(params, null, 2), 'utf8');
}

// save-params 服务端白名单校验：未知字段丢弃，已知字段做类型/范围钳制，
// 防止通过 IPC 注入任意字符串（YAML 注入 → 规则 eval 任意代码）。
const PARAM_SCHEMA = {
  beat_benchmark_threshold: { type: 'number', min: -0.2, max: 0.2 },
  up_days_10d_min:         { type: 'integer', min: 0, max: 20 },
  adv5_vol_ratio_min:      { type: 'number', min: 0.1, max: 10 },
  adv5_vol_ratio_max:      { type: 'number', min: 0.1, max: 10 },
  above_ma20:              { type: 'boolean' },
  min_grade:               { type: 'enum', values: ['A', 'B', 'C'] },
  min_score:               { type: 'integer', min: 1, max: 5 },
};

function sanitizeParams(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, spec] of Object.entries(PARAM_SCHEMA)) {
    const v = raw[key];
    if (v === undefined || v === null) continue;
    switch (spec.type) {
      case 'number': {
        const n = Number(v);
        if (Number.isFinite(n)) out[key] = Math.min(spec.max, Math.max(spec.min, n));
        break;
      }
      case 'integer': {
        const n = Math.round(Number(v));
        if (Number.isFinite(n)) out[key] = Math.min(spec.max, Math.max(spec.min, n));
        break;
      }
      case 'boolean':
        out[key] = v === true || v === 'true';
        break;
      case 'enum':
        if (spec.values.includes(v)) out[key] = v;
        break;
    }
  }
  return out;
}

function applyOverrideToRules(params) {
  const TEMPLATE_FILE = path.join(CONFIG_DIR, '量化筛选限制_template.txt');
  let tmpl = fs.readFileSync(TEMPLATE_FILE, 'utf8');

  const ma20Enabled = [
    '      - id: above_ma20',
    '        rule: "close > MA20"',
    '        intent: "趋势确认，减少下跌趋势里抄底"',
  ].join('\n');
  const ma20Disabled = [
    '      # above_ma20 已禁用（宽松模式）',
    '      # - id: above_ma20',
    '      #   rule: "close > MA20"',
  ].join('\n');

  const result = tmpl
    .replace('{{beat_benchmark_threshold}}', String(params.beat_benchmark_threshold))
    .replace('{{adv5_vol_ratio_min}}', String(params.adv5_vol_ratio_min))
    .replace('{{adv5_vol_ratio_max}}', String(params.adv5_vol_ratio_max))
    .replace('{{up_days_10d_min}}', String(params.up_days_10d_min))
    .replace('{{above_ma20_block}}', params.above_ma20 ? ma20Enabled : ma20Disabled)
    .replace('{{min_grade}}', String(params.min_grade))
    .replace('{{min_score}}', String(params.min_score));

  fs.writeFileSync(RULES_FILE, result, 'utf8');
}
ipcMain.handle('get-status', () => {
  const codesFile = path.join(INPUT_DIR, 'all_a_codes.txt');
  const summaryFile = path.join(OUTPUT_DIR, 'qscreen_all_a_summary.txt');
  const resultFile = path.join(OUTPUT_DIR, 'qscreen_all_a.json');
  const metaFile = path.join(OUTPUT_DIR, 'qscreen_all_a_meta.json');
  let codesCount = 0, codesMtime = null, codesDate = null;
  if (fs.existsSync(codesFile)) {
    const stat = fs.statSync(codesFile);
    codesMtime = stat.mtime.toLocaleString('zh-CN');
    codesDate = stat.mtime.toISOString().slice(0, 10);
    codesCount = fs.readFileSync(codesFile, 'utf8').split('\n').filter(s => /^\d{6}$/.test(s.trim())).length;
  }
  const today = todayCN();
  const codesStale = codesDate && codesDate !== today;
  let summary = null;
  if (fs.existsSync(summaryFile)) summary = fs.readFileSync(summaryFile, 'utf8');

  let picked = [];
  let pipelineMeta = null;

  // 优先读轻量 meta 文件（pipeline 侧双写，几 KB），避免每次解析数 MB 的完整结果 JSON
  if (fs.existsSync(metaFile)) {
    try {
      const m = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      picked = Array.isArray(m?.picked) ? m.picked : [];
      pipelineMeta = {
        asof: m?.asof ?? null,
        stage: m?.pipeline_meta?.stage ?? null,
        elapsed_ms: m?.pipeline_meta?.elapsed_ms ?? null,
        timing_ms: m?.pipeline_meta?.timing_ms ?? null,
        cache_hit: m?.pipeline_meta?.cache_hit ?? null,
        input_codes_count: m?.input?.codesCount ?? null,
        fast_pool_count: m?.fast_pool_count ?? null,
        ranked_candidates_count: m?.ranked_candidates_count ?? null,
        top_candidates_count: m?.top_candidates_count ?? null,
        llm_advice_count: m?.llm_advice_count ?? null,
        picked_count: m?.picked_count ?? null,
      };
    } catch(e) {
      pipelineMeta = null;
    }
  }

  // 回退：meta 文件缺失（旧版本输出）时，从完整结果 JSON 抽取
  if (pipelineMeta === null && fs.existsSync(resultFile)) {
    try {
      const js = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
      picked = Array.isArray(js?.picked) ? js.picked : [];
      pipelineMeta = {
        asof: js?.asof ?? null,
        stage: js?.pipeline_meta?.stage ?? null,
        elapsed_ms: js?.pipeline_meta?.elapsed_ms ?? null,
        timing_ms: js?.pipeline_meta?.timing_ms ?? null,
        cache_hit: js?.pipeline_meta?.cache_hit ?? null,
        input_codes_count: js?.input?.codesCount ?? null,
        fast_pool_count: Array.isArray(js?.fast_pool) ? js.fast_pool.length : null,
        ranked_candidates_count: Array.isArray(js?.ranked_candidates) ? js.ranked_candidates.length : null,
        top_candidates_count: Array.isArray(js?.top_candidates) ? js.top_candidates.length : null,
        llm_advice_count: Array.isArray(js?.llm_advice) ? js.llm_advice.length : null,
        picked_count: Array.isArray(js?.picked) ? js.picked.length : null,
      };
    } catch(e) {
      pipelineMeta = null;
    }
  }

  return {
    codesCount,
    codesMtime,
    codesDate,
    codesStale,
    summary,
    picked,
    pipelineMeta,
    params: loadOverride(),
    presets: PRESETS,
  };
});

ipcMain.handle('save-params', (event, params) => {
  try {
    const clean = sanitizeParams(params);
    saveOverride(clean);
    applyOverrideToRules(clean);
    return { ok: true, params: clean };
  } catch(e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('get-presets', () => PRESETS);

function runScript(scriptName, extraArgs, replyChannel) {
  const candidateInScripts = path.join(SCRIPTS_DIR, scriptName);
  const candidateInRoot = path.join(ROOT_DIR, scriptName);
  const scriptPath = fs.existsSync(candidateInScripts) ? candidateInScripts : candidateInRoot;
  const runtime = getNodeRuntime();
  const child = spawn(runtime.command, [scriptPath, ...extraArgs], {
    cwd: ROOT_DIR,
    env: runtime.env,
    // 非 Windows 下创建新进程组，取消任务时可整组终止（负 pid SIGKILL）
    detached: process.platform !== 'win32',
  });
  let stdoutBuf = '';
  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');
  child.stdout.on('data', d => {
    stdoutBuf += stdoutDecoder.write(d);
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop(); // 保留最后不完整的行
    for (const line of lines) {
      mainWindow.webContents.send(replyChannel + '-log', line);
    }
  });
  child.stdout.on('end', () => {
    stdoutBuf += stdoutDecoder.end();
    if (stdoutBuf) mainWindow.webContents.send(replyChannel + '-log', stdoutBuf);
  });
  let stderrBuf = '';
  child.stderr.on('data', d => {
    stderrBuf += stderrDecoder.write(d);
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop();
    for (const line of lines) {
      mainWindow.webContents.send(replyChannel + '-log', '[stderr] ' + line);
    }
  });
  child.stderr.on('end', () => {
    stderrBuf += stderrDecoder.end();
    if (stderrBuf) mainWindow.webContents.send(replyChannel + '-log', '[stderr] ' + stderrBuf);
  });
  child.on('close', code => {
    mainWindow.webContents.send(replyChannel + '-done', { code });
  });
  child.on('error', err => {
    mainWindow.webContents.send(replyChannel + '-done', { code: -1, error: err.message });
  });
  return child;
}

let currentChild = null;

// 取消任务时连带终止子进程树。qscreen_all_a.mjs 内部通过 execFileSync 再起的
// Python 孙进程（Step2 估值、build_security_master）不会因父进程 kill 而退出，
// 需按进程树清理，避免孤儿进程继续占网络/CPU。
function killProcessTree(child) {
  if (!child || typeof child.pid !== 'number') return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {}
  } else {
    // 非 Windows：spawn 时 detached 创建了新进程组，负 pid 杀整组
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
  try { child.kill(); } catch {}
}

ipcMain.on('update-codes', () => {
  if (currentChild) { killProcessTree(currentChild); currentChild = null; }
  currentChild = runScript('gen_codes.mjs', [], 'update-codes');
  currentChild.on('close', () => { currentChild = null; });
});

ipcMain.on('run-screen', () => {
  if (currentChild) { killProcessTree(currentChild); currentChild = null; }
  currentChild = runScript('qscreen_all_a.mjs', ['--skipFetch', 'true'], 'run-screen');
  currentChild.on('close', () => { currentChild = null; });
});

ipcMain.on('run-screen-full', () => {
  if (currentChild) { killProcessTree(currentChild); currentChild = null; }
  currentChild = runScript('qscreen_all_a.mjs', ['--forceRefresh', 'true'], 'run-screen-full');
  currentChild.on('close', () => { currentChild = null; });
});

ipcMain.on('cancel-task', () => {
  if (currentChild) { killProcessTree(currentChild); currentChild = null; }
});

ipcMain.handle('fetch-index-quote', () => {
  return new Promise((resolve) => {
    const url = 'https://hq.sinajs.cn/list=s_sh000001,s_sz399001';
    const req = https.get(url, {
      headers: {
        'Referer': 'https://finance.sina.com.cn',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      }
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve({ ok: true, data }));
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.setTimeout(5000, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
  });
});

function fetchSinaQuotes(codes) {
  return new Promise((resolve) => {
    if (!codes || !codes.length) return resolve({ ok: true, quotes: {} });
    const toSina = c => (c.startsWith('6') || c.startsWith('9')) ? 'sh' + c : 'sz' + c;
    const list = codes.map(toSina).join(',');
    const url = 'https://hq.sinajs.cn/rn=' + Date.now() + '&list=' + list;
    const req = https.get(url, {
      headers: { 'Referer': 'https://finance.sina.com.cn', 'User-Agent': 'Mozilla/5.0' }
    }, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          const quotes = {};
          const re = /hq_str_s[hz](\d{6})="([^"]*)"/g;
          let m;
          while ((m = re.exec(text)) !== null) {
            const parts = m[2].split(',');
            if (parts.length > 4) {
              quotes[m[1]] = {
                name: parts[0],
                open: parseFloat(parts[1]) || 0,
                close_prev: parseFloat(parts[2]) || 0,
                price: parseFloat(parts[3]) || 0,
                high: parseFloat(parts[4]) || 0,
                low: parseFloat(parts[5]) || 0,
                pct: 0,
              };
              if (quotes[m[1]].close_prev > 0)
                quotes[m[1]].pct = (quotes[m[1]].price - quotes[m[1]].close_prev) / quotes[m[1]].close_prev;
            }
          }
          resolve({ ok: true, quotes });
        } catch(e) { resolve({ ok: false, error: e.message }); }
      });
    });
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
  });
}

ipcMain.handle('fetch-stock-quotes', (event, codes) => fetchSinaQuotes(codes));

// —— 详情面板：fetch-stock-detail / fetch-stock-kline ——
const DETAIL_CACHE_MS = 15 * 1000;   // detail 轻量缓存 15 秒
const KLINE_CACHE_MS = 5 * 60 * 1000; // 日K 缓存 5 分钟
const ADV5_VOLUME_MIN = 5e7;         // 量能下限：ADV5 成交额 ≥ 5000 万
const ADV5_VOLUME_STRONG = 1e8;      // 量能强：ADV5 成交额 ≥ 1 亿
const PRICE_HIGH_PCT = 0.10;         // 偏离 MA20 超过 10% 视为位置偏高
const EX_WEAK = 0.05;                // 5日超额 < 5% 视为动能偏弱
const detailCache = new Map();       // code -> { at, data }
const klineDayCache = new Map();     // code -> { at, rows }

// 轻量 JSON 抓取：Node https 直连（不跟随系统代理），自动解压 gzip/deflate/br，失败重试 1 次
// 说明：主进程全局 fetch 走 Chromium 网络栈（跟随系统代理），国内接口可能被代理出口的 WAF 拦截；
//       与 sina 报价一致改用 https.get 直连，规避代理问题。
async function httpGetJson(url, timeoutMs = 20000, extraHeaders = {}) {
  let last = { ok: false, error: 'unknown' };
  for (let i = 0; i < 2; i++) {
    last = await new Promise((resolve) => {
      const req = https.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', ...extraHeaders }
      }, (res) => {
        const chunks = [];
        res.on('data', d => chunks.push(d));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const enc = (res.headers['content-encoding'] || '').toLowerCase();
          try {
            if (enc === 'gzip') buf = zlib.gunzipSync(buf);
            else if (enc === 'deflate') buf = zlib.inflateSync(buf);
            else if (enc === 'br') buf = zlib.brotliDecompressSync(buf);
          } catch (e) {
            return resolve({ ok: false, error: '解压失败:' + e.message });
          }
          try {
            resolve({ ok: true, js: JSON.parse(buf.toString('utf8')) });
          } catch (e) {
            resolve({ ok: false, error: 'JSON解析失败', head: buf.toString('utf8').slice(0, 120).replace(/\s+/g, ' ') });
          }
        });
      });
      req.on('error', e => resolve({ ok: false, error: e.message }));
      req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    });
    if (last.ok) return last;
  }
  return last;
}

// 解析腾讯 fqkline 行：[date, open, close, high, low, volHand, ...]
function parseTencentKlineRows(arr) {
  const rows = [];
  for (const it of arr) {
    if (!Array.isArray(it) || it.length < 6) continue;
    const [date, open, close, high, low, volHand] = it;
    const o = Number(open), c = Number(close), h = Number(high), l = Number(low), v = Number(volHand);
    if (!date || ![o, c, h, l, v].every(Number.isFinite) || [o, c, h, l].some(x => x <= 0)) continue;
    rows.push({ date: String(date), open: o, close: c, high: h, low: l, volume: v, amount: c * v * 100 });
  }
  return rows;
}

// 解析东财 klines 行："date,open,close,high,low,vol,amount,amplitude,pct,chg,change"
function parseEastmoneyKlines(klines) {
  const rows = [];
  for (const line of klines) {
    const p = String(line).split(',');
    if (p.length < 6) continue;
    const date = String(p[0]).trim();
    const o = Number(p[1]), c = Number(p[2]), h = Number(p[3]), l = Number(p[4]), v = Number(p[5]);
    if (!date || ![o, c, h, l, v].every(Number.isFinite) || [o, c, h, l].some(x => x <= 0)) continue;
    const amount = Number(p[6]);
    rows.push({ date, open: o, close: c, high: h, low: l, volume: v, amount: Number.isFinite(amount) ? amount : c * v * 100 });
  }
  return rows;
}

// 日K 主接口：腾讯 fqkline，返回 { rows, err }
async function fetchDayKlinesTencent(symbol) {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${encodeURIComponent(symbol)},day,,,320,qfq`;
  const res = await httpGetJson(url);
  if (!res.ok) return { rows: null, err: res.error + (res.head ? ':' + res.head : '') };
  if (res.js?.code !== 0) return { rows: null, err: 'code=' + res.js.code };
  const node = res.js?.data?.[symbol];
  const arr = node?.qfqday ?? node?.day ?? null;
  if (!Array.isArray(arr) || !arr.length) return { rows: null, err: 'data为空' };
  const rows = parseTencentKlineRows(arr);
  return rows.length ? { rows, err: '' } : { rows: null, err: 'rows为空' };
}

// 日K 备选接口：东财 push2his（腾讯被 WAF/异常时的兜底），返回 { rows, err }
async function fetchDayKlinesEastmoney(secid) {
  const params = new URLSearchParams({
    secid, klt: '101', fqt: '1', beg: '0', end: '20500101', lmt: '320',
    fields1: 'f1,f2,f3,f4,f5,f6',
    fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
  });
  const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?' + params.toString();
  const res = await httpGetJson(url);
  if (!res.ok) return { rows: null, err: res.error + (res.head ? ':' + res.head : '') };
  const kl = res.js?.data?.klines;
  if (!Array.isArray(kl) || !kl.length) return { rows: null, err: 'data为空' };
  const rows = parseEastmoneyKlines(kl);
  return rows.length ? { rows, err: '' } : { rows: null, err: 'rows为空' };
}

// 日K 第三备选：新浪日线（与新浪报价同域，直连通常可达），返回 { rows, err }
async function fetchDayKlinesSina(symbol) {
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${encodeURIComponent(symbol)}&scale=240&ma=5&datalen=320`;
  const res = await httpGetJson(url, 20000, { Referer: 'https://finance.sina.com.cn/' });
  if (!res.ok) return { rows: null, err: res.error + (res.head ? ':' + res.head : '') };
  if (!Array.isArray(res.js) || !res.js.length) return { rows: null, err: 'data为空' };
  const rows = [];
  for (const it of res.js) {
    const date = String(it?.day ?? '').trim();
    const o = Number(it?.open), c = Number(it?.close), h = Number(it?.high), l = Number(it?.low), v = Number(it?.volume);
    if (!date || ![o, c, h, l, v].every(Number.isFinite) || [o, c, h, l].some(x => x <= 0)) continue;
    rows.push({ date, open: o, close: c, high: h, low: l, volume: v, amount: c * v });
  }
  return rows.length ? { rows, err: '' } : { rows: null, err: 'rows为空' };
}

// 分时：新浪当日 5 分钟线（48 点）绘制分时走势，返回 { rows, err }
// rows 每项 { date:'HH:MM', open, close, high, low, volume, amount, avg }，
// avg 为当日累计均价（接口无成交额字段，用段均价(开高低收均值)*量累计近似）
async function fetchMinuteSina(symbol) {
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${encodeURIComponent(symbol)}&scale=5&ma=no&datalen=48`;
  const res = await httpGetJson(url, 20000, { Referer: 'https://finance.sina.com.cn/' });
  if (!res.ok) return { rows: null, err: res.error + (res.head ? ':' + res.head : '') };
  if (!Array.isArray(res.js) || !res.js.length) return { rows: null, err: 'data为空' };
  const rows = [];
  let sumAmt = 0, sumVol = 0;
  for (const it of res.js) {
    const day = String(it?.day ?? '');
    const o = Number(it?.open), c = Number(it?.close), h = Number(it?.high), l = Number(it?.low), v = Number(it?.volume);
    if (!day || ![o, c, h, l, v].every(Number.isFinite) || [o, c, h, l].some(x => x <= 0)) continue;
    const date = day.length >= 16 ? day.slice(11, 16) : day; // 'YYYY-MM-DD HH:MM:SS' -> 'HH:MM'
    sumAmt += ((o + h + l + c) / 4) * v;
    sumVol += v;
    rows.push({ date, open: o, close: c, high: h, low: l, volume: v, amount: c * v, avg: sumVol > 0 ? sumAmt / sumVol : c });
  }
  return rows.length ? { rows, err: '' } : { rows: null, err: 'rows为空' };
}

// 拉取日K：腾讯优先、东财次之、新浪兜底，返回 { rows, reason }
async function fetchDayKlines(code) {
  const key = String(code);
  const cached = klineDayCache.get(key);
  if (cached && Date.now() - cached.at < KLINE_CACHE_MS) return { rows: cached.rows, reason: '' };
  const symbol = /^\d{6}$/.test(key)
    ? ((key.startsWith('6') || key.startsWith('9')) ? 'sh' + key : 'sz' + key)
    : null;
  if (!symbol) return { rows: null, reason: '无效代码' };
  const secid = (symbol.startsWith('sh') ? '1.' : '0.') + key;
  const reasons = [];
  const t = await fetchDayKlinesTencent(symbol);
  if (t.rows && t.rows.length) {
    klineDayCache.set(key, { at: Date.now(), rows: t.rows });
    return { rows: t.rows, reason: '' };
  }
  reasons.push('腾讯(' + (t.err || '无数据') + ')');
  const e = await fetchDayKlinesEastmoney(secid);
  if (e.rows && e.rows.length) {
    klineDayCache.set(key, { at: Date.now(), rows: e.rows });
    return { rows: e.rows, reason: '' };
  }
  reasons.push('东财(' + (e.err || '无数据') + ')');
  const s = await fetchDayKlinesSina(symbol);
  if (s.rows && s.rows.length) {
    klineDayCache.set(key, { at: Date.now(), rows: s.rows });
    return { rows: s.rows, reason: '' };
  }
  reasons.push('新浪(' + (s.err || '无数据') + ')');
  return { rows: null, reason: reasons.join('；') };
}

// 从 meta（轻量）或完整结果 JSON 中按代码查找入选股
function findPickedByCode(code) {
  const key = String(code);
  const candidates = [path.join(OUTPUT_DIR, 'qscreen_all_a_meta.json'), path.join(OUTPUT_DIR, 'qscreen_all_a.json')];
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    try {
      const js = JSON.parse(fs.readFileSync(f, 'utf8'));
      const picked = Array.isArray(js?.picked) ? js.picked : [];
      const hit = picked.find(x => String(x.code) === key);
      if (hit) return hit;
    } catch {}
  }
  return null;
}

// 拼装一句轻量 decision，主进程统一判断，前端只做展示
// 三档结论：继续关注 / 等回踩 / 暂不关注，另附 reason 说明判定依据
function buildDecision(metrics) {
  const close = Number(metrics?.close) || 0;
  const ma20 = Number(metrics?.MA20) || 0;
  const ret5 = Number(metrics?.ret_5d) || 0;
  const idx5 = Number(metrics?.idx_ret_5d) || 0;
  const adv5 = Number(metrics?.ADV5_amount) || 0;
  const aboveMA20 = close > 0 && ma20 > 0 && close > ma20;
  const beatsBenchmark = ret5 - idx5 > 0;
  const volEnough = adv5 >= ADV5_VOLUME_MIN;
  const volStrong = adv5 >= ADV5_VOLUME_STRONG;
  const aboveMa20Pct = ma20 > 0 ? (close - ma20) / ma20 : 0;
  const priceHigh = aboveMa20Pct > PRICE_HIGH_PCT;
  const ex = ret5 - idx5;
  const exWeak = ex < EX_WEAK;

  let conclusion = '继续关注';
  let reason = '';
  if (!aboveMA20) { conclusion = '暂不关注'; reason = '未站上MA20'; }
  else if (!beatsBenchmark) { conclusion = '暂不关注'; reason = '5日未跑赢基准'; }
  else if (!volEnough) { conclusion = '暂不关注'; reason = '量能不足'; }
  else if (priceHigh) { conclusion = '等回踩'; reason = '位置偏高'; }
  else if (exWeak && !volStrong) { conclusion = '等回踩'; reason = '动能偏弱'; }
  return { aboveMA20, beatsBenchmark, volEnough, volStrong, priceHigh, aboveMa20Pct, ex, conclusion, reason };
}

ipcMain.handle('fetch-stock-detail', async (event, code) => {
  const key = String(code ?? '').trim();
  if (!/^\d{6}$/.test(key)) return { ok: false, error: '无效股票代码' };
  const cached = detailCache.get(key);
  if (cached && Date.now() - cached.at < DETAIL_CACHE_MS) return cached.data;
  try {
    const stock = findPickedByCode(key);
    if (!stock) return { ok: false, error: '未找到该股票（可能不在最近入选结果中）', code: key };
    const q = await fetchSinaQuotes([key]);
    const decision = buildDecision(stock.metrics || {});
    const data = { ok: true, data: { stock, quote: q?.quotes?.[key] || null, decision } };
    detailCache.set(key, { at: Date.now(), data });
    return data;
  } catch(e) {
    return { ok: false, error: e.message, code: key };
  }
});

// 由日线聚合出周K / 月K（周按周一为一周起点）
function aggKline(rows, mode) {
  const groups = new Map();
  for (const r of rows) {
    const d = new Date(r.date + 'T00:00:00');
    if (Number.isNaN(d.getTime())) continue;
    let key;
    if (mode === 'week') {
      const mon = new Date(d);
      mon.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      key = mon.toISOString().slice(0, 10);
    } else {
      key = r.date.slice(0, 7);
    }
    let g = groups.get(key);
    if (!g) {
      g = { date: r.date, open: r.open, close: r.close, high: r.high, low: r.low, volume: 0, amount: 0 };
      groups.set(key, g);
    }
    g.date = r.date;
    g.close = r.close;
    g.high = Math.max(g.high, r.high);
    g.low = Math.min(g.low, r.low);
    g.volume += r.volume;
    g.amount += r.amount;
  }
  return [...groups.values()];
}

ipcMain.handle('fetch-stock-kline', async (event, payload) => {
  const code = String(payload?.code ?? '').trim();
  const period = ['min', 'day', 'week', 'month'].includes(payload?.period) ? payload.period : 'day';
  if (!/^\d{6}$/.test(code)) return { ok: false, error: '无效股票代码' };
  try {
    if (period === 'min') {
      const cacheKey = code + ':min';
      const cached = klineDayCache.get(cacheKey);
      // 分时轮询(force)时跳过主进程缓存，保证拉到最新走势
      if (!payload?.force && cached && Date.now() - cached.at < KLINE_CACHE_MS) {
        return { ok: true, data: { code, period, rows: cached.rows } };
      }
      const symbol = (code.startsWith('6') || code.startsWith('9')) ? 'sh' + code : 'sz' + code;
      const m = await fetchMinuteSina(symbol);
      if (m.rows && m.rows.length) {
        klineDayCache.set(cacheKey, { at: Date.now(), rows: m.rows });
        return { ok: true, data: { code, period, rows: m.rows } };
      }
      return { ok: false, error: '分时获取失败：' + (m.err || '数据为空'), code, period };
    }
    const got = await fetchDayKlines(code);
    if (!got || !got.rows || !got.rows.length) {
      return { ok: false, error: 'K线获取失败：' + (got?.reason || '数据为空'), code, period };
    }
    const rows = period === 'day' ? got.rows : aggKline(got.rows, period);
    if (!rows.length) return { ok: false, error: 'K线聚合结果为空', code, period };
    return { ok: true, data: { code, period, rows } };
  } catch(e) {
    return { ok: false, error: e.message, code, period };
  }
});

ipcMain.handle('open-result', () => {
  const f = path.join(OUTPUT_DIR, 'qscreen_all_a_summary.txt');
  if (!fs.existsSync(f)) return { ok: false, error: '摘要文件不存在，请先运行筛选' };
  shell.openPath(f);
  return { ok: true };
});

ipcMain.handle('read-summary', () => {
  const f = path.join(OUTPUT_DIR, 'qscreen_all_a_summary.txt');
  if (!fs.existsSync(f)) return { ok: false, content: null };
  return { ok: true, content: fs.readFileSync(f, 'utf8') };
});
