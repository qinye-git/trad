import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 项目根固定由模块位置推导（pipeline/ 上一级），不依赖运行时 cwd，
// 保证从任意目录启动也能正确定位 data/cache 等资源。
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function ensureFinite(n, fallback = null) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

// 支持引号包裹字段的 CSV 行解析（兼容 pandas to_csv 默认 QUOTE_MINIMAL 输出：
// 字段含逗号/引号时被 "..." 包裹，内部引号以 "" 转义）。字段内不换行。
export function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function uniq(arr) {
  return [...new Set(arr)];
}

function secidFromCode(code) {
  const c = String(code).trim();
  if (!/^\d{6}$/.test(c)) return null;
  const mkt = c.startsWith('6') || c.startsWith('9') ? '1' : '0';
  return `${mkt}.${c}`;
}

async function fetchJsonWithTimeout(url, { timeoutMs = 20000, retries = 1, headers = {} } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...headers }, signal: ctrl.signal });
      if (!res.ok) throw new Error(`http ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (i === retries) throw lastErr;
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

export async function fetchQuoteSnapshot(codes, { concurrency = 5 } = {}) {
  const uniqCodes = uniq(codes.map(String)).filter((c) => /^\d{6}$/.test(c));
  if (!uniqCodes.length) return new Map();

  const fields = ['f12', 'f14', 'f2', 'f3', 'f18', 'f5', 'f6'].join(',');
  const out = new Map();
  const chunkSize = 200;
  const chunks = [];
  for (let i = 0; i < uniqCodes.length; i += chunkSize) {
    chunks.push(uniqCodes.slice(i, i + chunkSize));
  }

  // 固定并发上限的任务池：串行 20+ 个批量请求改为少量并发，摊薄单接口延迟。
  // 单个批次失败仍向上抛出（与旧行为一致，由调用方兜底为空的 Map）。
  const limit = Math.max(1, Math.min(Number(concurrency) || 5, chunks.length));
  let cursor = 0;
  const runners = Array.from({ length: limit }, async () => {
    while (cursor < chunks.length) {
      const chunk = chunks[cursor++];
      const secids = chunk.map(secidFromCode).filter(Boolean).join(',');
      const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=${encodeURIComponent(fields)}&secids=${encodeURIComponent(secids)}`;
      const js = await fetchJsonWithTimeout(url, { timeoutMs: 20000, retries: 1 });
      const diff = js?.data?.diff ?? [];
      for (const it of diff) {
        out.set(String(it.f12), {
          code: String(it.f12),
          name: String(it.f14 ?? ''),
          last: ensureFinite(it.f2, null),
          pct: ensureFinite(it.f3, null),
          preclose: ensureFinite(it.f18, null),
          volume: ensureFinite(it.f5, null),
          amount: ensureFinite(it.f6, null),
        });
      }
    }
  });
  await Promise.all(runners);
  return out;
}

export async function fetchDailyKlineTencent(codeOrSymbol, { days = 320 } = {}) {
  const raw = String(codeOrSymbol ?? '').trim();
  const symbol =
    /^\w{2}\d{6}$/.test(raw)
      ? raw.toLowerCase()
      : /^\d{6}$/.test(raw)
        ? (raw.startsWith('6') || raw.startsWith('9') ? `sh${raw}` : `sz${raw}`)
        : null;
  if (!symbol) return null;

  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${encodeURIComponent(symbol)},day,,,${encodeURIComponent(String(days))},qfq`;
  const js = await fetchJsonWithTimeout(url, { timeoutMs: 20000, retries: 1 });
  if (js?.code !== 0) return null;
  const node = js?.data?.[symbol];
  const arr = node?.qfqday ?? node?.day ?? null;
  if (!Array.isArray(arr) || !arr.length) return null;

  const rows = [];
  for (const it of arr) {
    if (!Array.isArray(it) || it.length < 6) continue;
    const [date, open, close, high, low, volHand] = it;
    const o = ensureFinite(open, null);
    const c = ensureFinite(close, null);
    const h = ensureFinite(high, null);
    const l = ensureFinite(low, null);
    const vHand = ensureFinite(volHand, null);
    if (!date || !Number.isFinite(o) || !Number.isFinite(c) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(vHand)) continue;
    rows.push({
      date: String(date),
      open: o,
      close: c,
      high: h,
      low: l,
      volume: vHand,
      amount: c * vHand * 100,
      amp: null,
      pct: null,
      chg: null,
    });
  }
  return rows;
}

export async function fetchDailyKlineSina(codeOrSymbol, { days = 320 } = {}) {
  const raw = String(codeOrSymbol ?? '').trim();
  const symbol =
    /^\w{2}\d{6}$/.test(raw)
      ? raw.toLowerCase()
      : /^\d{6}$/.test(raw)
        ? (raw.startsWith('6') || raw.startsWith('9') ? `sh${raw}` : `sz${raw}`)
        : null;
  if (!symbol) return null;

  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${encodeURIComponent(symbol)}&scale=240&ma=5&datalen=${encodeURIComponent(String(days))}`;
  const js = await fetchJsonWithTimeout(url, {
    timeoutMs: 20000,
    retries: 1,
    headers: { Referer: 'https://finance.sina.com.cn/' },
  });
  if (!Array.isArray(js) || !js.length) return null;

  const rows = [];
  for (const it of js) {
    const date = String(it?.day ?? '').trim();
    const o = ensureFinite(it?.open, null);
    const c = ensureFinite(it?.close, null);
    const h = ensureFinite(it?.high, null);
    const l = ensureFinite(it?.low, null);
    const v = ensureFinite(it?.volume, null);
    if (!date || !Number.isFinite(o) || !Number.isFinite(c) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(v)) continue;
    rows.push({
      date,
      open: o,
      close: c,
      high: h,
      low: l,
      volume: v,
      amount: c * v,
      amp: null,
      pct: null,
      chg: null,
    });
  }
  return rows;
}

export async function fetchDailyKline(code, { klt = 101, fqt = 1, days = 260 } = {}) {
  const secid = secidFromCode(code);
  if (!secid) return null;

  const fields1 = 'f1,f2,f3,f4,f5,f6';
  const fields2 = 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61';
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?` +
    `secid=${encodeURIComponent(secid)}&klt=${encodeURIComponent(String(klt))}&fqt=${encodeURIComponent(String(fqt))}` +
    `&lmt=${encodeURIComponent(String(days))}&fields1=${encodeURIComponent(fields1)}&fields2=${encodeURIComponent(fields2)}`;

  const js = await fetchJsonWithTimeout(url, { timeoutMs: 20000, retries: 1 });
  if (js?.rc === 102) {
    throw new Error('Eastmoney kline 被拒绝（rc=102）。该环境可能无法直连历史K线接口，请改用 --klineDir 提供本地CSV数据。');
  }
  const kl = js?.data?.klines;
  if (!Array.isArray(kl) || !kl.length) return null;

  const rows = [];
  for (const line of kl) {
    const parts = String(line).split(',');
    if (parts.length < 7) continue;
    const [date, open, close, high, low, volume, amount, amp, pct, chg] = parts;
    rows.push({
      date,
      open: ensureFinite(open, null),
      close: ensureFinite(close, null),
      high: ensureFinite(high, null),
      low: ensureFinite(low, null),
      volume: ensureFinite(volume, null),
      amount: ensureFinite(amount, null),
      amp: ensureFinite(amp, null),
      pct: ensureFinite(pct, null),
      chg: ensureFinite(chg, null),
    });
  }
  return rows;
}

export async function fetchDailyKlineBySecid(secid, { klt = 101, fqt = 1, days = 260 } = {}) {
  const s = String(secid ?? '').trim();
  if (!/^[01]\.\d{6}$/.test(s)) return null;

  const fields1 = 'f1,f2,f3,f4,f5,f6';
  const fields2 = 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61';
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?` +
    `secid=${encodeURIComponent(s)}&klt=${encodeURIComponent(String(klt))}&fqt=${encodeURIComponent(String(fqt))}` +
    `&lmt=${encodeURIComponent(String(days))}&fields1=${encodeURIComponent(fields1)}&fields2=${encodeURIComponent(fields2)}`;

  const js = await fetchJsonWithTimeout(url, { timeoutMs: 20000, retries: 1 });
  if (js?.rc === 102) {
    throw new Error('Eastmoney kline 被拒绝（rc=102）。该环境可能无法直连历史K线接口，请改用 --klineDir 提供本地CSV数据。');
  }
  const kl = js?.data?.klines;
  if (!Array.isArray(kl) || !kl.length) return null;

  const rows = [];
  for (const line of kl) {
    const parts = String(line).split(',');
    if (parts.length < 7) continue;
    const [date, open, close, high, low, volume, amount, amp, pct, chg] = parts;
    rows.push({
      date,
      open: ensureFinite(open, null),
      close: ensureFinite(close, null),
      high: ensureFinite(high, null),
      low: ensureFinite(low, null),
      volume: ensureFinite(volume, null),
      amount: ensureFinite(amount, null),
      amp: ensureFinite(amp, null),
      pct: ensureFinite(pct, null),
      chg: ensureFinite(chg, null),
    });
  }
  return rows;
}

// 数据源可用性探测的记忆化：进程内缓存 + 短 TTL 落盘，避免每轮都发起探测请求。
// 仅缓存成功结论；失败结论不缓存（失败会立即重探测，避免长时间沿用过期判断）。
const PROBE_CACHE_TTL_MS = 10 * 60 * 1000;
const PROBE_CACHE_FILE = path.join(PROJECT_ROOT, 'data', 'cache', 'eastmoney_probe.json');
let _probeMem = null; // { at, result }
let _probeDiskLoaded = false;

function probeFromDisk(now) {
  if (_probeDiskLoaded) return null;
  _probeDiskLoaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(PROBE_CACHE_FILE, 'utf8'));
    if (raw && raw.ok && raw.at && now - raw.at < PROBE_CACHE_TTL_MS) {
      return { at: raw.at, result: { ok: true } };
    }
  } catch {
    // 文件缺失或损坏，视为无缓存
  }
  return null;
}

export async function probeEastmoneyKlineAccess() {
  const now = Date.now();

  if (_probeMem && now - _probeMem.at < PROBE_CACHE_TTL_MS) {
    return _probeMem.result;
  }
  const fromDisk = probeFromDisk(now);
  if (fromDisk) {
    _probeMem = fromDisk;
    return fromDisk.result;
  }

  const url =
    'https://push2his.eastmoney.com/api/qt/stock/kline/get?' +
    'secid=1.600519&klt=101&fqt=1&lmt=2&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61';
  try {
    const js = await fetchJsonWithTimeout(url, { timeoutMs: 8000, retries: 0 });
    if (js?.rc === 0 && Array.isArray(js?.data?.klines) && js.data.klines.length >= 2) {
      const hit = { at: now, result: { ok: true } };
      _probeMem = hit;
      try {
        fs.mkdirSync(path.dirname(PROBE_CACHE_FILE), { recursive: true });
        fs.writeFileSync(PROBE_CACHE_FILE, JSON.stringify({ ok: true, at: now }), 'utf8');
      } catch {
        // 落盘失败不影响本次判定
      }
      return hit.result;
    }
    return { ok: false, rc: js?.rc ?? null };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

// 本地 K 线 CSV 读取的进程内缓存：失效键 = 路径 + mtimeMs + 文件大小
// 网络源被限流、大量走本地 CSV 回退时，避免对同一文件反复整表 read+split+解析
const _klineCsvCache = new Map();
const _KLINE_CSV_CACHE_MAX = 2000;

function getKlineCsvCacheKey(filePath) {
  const st = fs.statSync(filePath);
  return { key: `${st.mtimeMs}:${st.size}`, mtimeMs: st.mtimeMs, size: st.size };
}

export function readKlineCsv(filePath) {
  const { key } = getKlineCsvCacheKey(filePath);
  const cached = _klineCsvCache.get(filePath);
  if (cached && cached.key === key) return cached.rows;

  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter((x) => x && !x.startsWith('#'));

  const rows = [];
  for (const line of lines) {
    const parts = line.split(',');
    if (parts.length < 6) continue;
    const [date, open, close, high, low, volume, amount] = parts;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) continue;
    rows.push({
      date: String(date),
      open: ensureFinite(open, null),
      close: ensureFinite(close, null),
      high: ensureFinite(high, null),
      low: ensureFinite(low, null),
      volume: ensureFinite(volume, null),
      amount: ensureFinite(amount, null),
      amp: null,
      pct: null,
      chg: null,
    });
  }

  // FIFO 淘汰控制内存占用（全市场回退场景最多几千个文件）
  if (_klineCsvCache.size >= _KLINE_CSV_CACHE_MAX) {
    const oldestKey = _klineCsvCache.keys().next().value;
    if (oldestKey) _klineCsvCache.delete(oldestKey);
  }
  _klineCsvCache.set(filePath, { key, rows });
  return rows;
}

export function resolveKlinePath(klineDir, code) {
  const base = path.resolve(String(klineDir));
  return path.join(base, `${code}.csv`);
}

export function writeKlineCsv(filePath, rows) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const body = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && r.date)
    .map((r) => [
      String(r.date),
      Number.isFinite(Number(r.open)) ? Number(r.open) : '',
      Number.isFinite(Number(r.close)) ? Number(r.close) : '',
      Number.isFinite(Number(r.high)) ? Number(r.high) : '',
      Number.isFinite(Number(r.low)) ? Number(r.low) : '',
      Number.isFinite(Number(r.volume)) ? Number(r.volume) : '',
      Number.isFinite(Number(r.amount)) ? Number(r.amount) : '',
    ].join(','))
    .join('\n');
  fs.writeFileSync(filePath, body ? body + '\n' : '', 'utf8');
}

export function loadValuationSnapshot(dirOrFile) {
  const p = (dirOrFile && dirOrFile.endsWith('.csv')) ? dirOrFile : path.join(dirOrFile, 'valuation_snapshot_daily.csv');
  if (!fs.existsSync(p)) return new Map();
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  if (lines.length < 2) return new Map();
  const headers = parseCsvLine(lines[0]).map(h => h.trim().replace(/^\uFEFF/, ''));
  const map = new Map();
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (cols.length < 2) continue;
    const row = {};
    headers.forEach((h, j) => { row[h] = cols[j]?.trim() ?? ''; });
    const code = String(row.code ?? '').padStart(6, '0');
    map.set(code, {
      pe_ttm: parseFloat(row.pe_ttm) || null,
      pb: parseFloat(row.pb) || null,
      industry_l1: row.industry_l1 ?? '',
      industry_l2: row.industry_l2 ?? '',
      pe_industry_median: parseFloat(row.pe_industry_median) || null,
      pe_discount_flag: parseInt(row.pe_discount_flag) || 0,
      roe_avg_3y: parseFloat(row.roe_avg_3y) || null,
      is_loss: parseInt(row.is_loss) || 0,
    });
  }
  return map;
}
