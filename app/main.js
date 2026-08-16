const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
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
  min_score:               { type: 'integer', min: 1, max: 8 },
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

ipcMain.handle('fetch-stock-quotes', (event, codes) => {
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
