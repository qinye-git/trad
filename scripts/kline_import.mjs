#!/usr/bin/env node
/**
 * kline_import.mjs
 *
 * 目的：把“任意来源导出的日K数据”整理为 qscreen.mjs 可读的统一CSV格式：
 *   <klineDir>/<6位代码>.csv
 *
 * 统一输出格式（UTF-8，无表头）：
 *   date,open,close,high,low,volume,amount
 *
 * 支持输入：
 * - 通用CSV（带表头或不带）：会自动识别常见列名
 * - 东方财富导出的历史行情（常见列名：日期/开盘/收盘/最高/最低/成交量/成交额）
 *
 * 用法：
 *   node kline_import.mjs --in "原始CSV目录" --out "kline" [--codeCol code] [--pattern "*.csv"]
 *
 * 说明：
 * - 你可以把东方财富客户端/网页导出的“历史行情CSV”丢进 --in 目录
 * - 该脚本会按 code 分组，清洗并输出为每个代码一个CSV
 */

import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      args[k] = v;
    } else {
      args._.push(a);
    }
  }
  return args;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function listCsvFiles(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) continue;
    if (ent.isFile() && ent.name.toLowerCase().endsWith('.csv')) out.push(p);
  }
  return out;
}

function detectDelimiter(line) {
  if (line.includes('\t')) return '\t';
  return ',';
}

function normKey(k) {
  return String(k || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[%()]/g, '');
}

const COL_ALIASES = {
  date: ['date', '日期', '交易日期', '时间'],
  open: ['open', '开盘', '开盘价'],
  close: ['close', '收盘', '收盘价', '最新价'],
  high: ['high', '最高', '最高价'],
  low: ['low', '最低', '最低价'],
  volume: ['volume', 'vol', '成交量', '成交量股', '成交量手'],
  amount: ['amount', '成交额', '成交金额', 'turnover', '成交额元'],
  code: ['code', '股票代码', '代码', '证券代码'],
};

function buildHeaderMap(headers) {
  const idxByNorm = new Map();
  headers.forEach((h, i) => idxByNorm.set(normKey(h), i));

  const pick = (names) => {
    for (const n of names) {
      const idx = idxByNorm.get(normKey(n));
      if (idx !== undefined) return idx;
    }
    return null;
  };

  return {
    date: pick(COL_ALIASES.date),
    open: pick(COL_ALIASES.open),
    close: pick(COL_ALIASES.close),
    high: pick(COL_ALIASES.high),
    low: pick(COL_ALIASES.low),
    volume: pick(COL_ALIASES.volume),
    amount: pick(COL_ALIASES.amount),
    code: pick(COL_ALIASES.code),
  };
}

function toNum(x) {
  const s = String(x ?? '').trim();
  if (!s) return null;
  // remove commas
  const v = Number(s.replace(/,/g, ''));
  return Number.isFinite(v) ? v : null;
}

function normalizeDate(x) {
  const s = String(x ?? '').trim();
  if (!s) return null;
  // accept YYYY-MM-DD or YYYY/MM/DD
  const m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (!m) return null;
  const y = m[1];
  const mo = String(m[2]).padStart(2, '0');
  const d = String(m[3]).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

function parseCsv(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (!lines.length) return { headers: null, rows: [] };

  const delim = detectDelimiter(lines[0]);
  const first = lines[0].split(delim).map((x) => x.trim());

  // Heuristic: if first row contains any non-numeric tokens, treat as header
  const looksHeader = first.some((x) => /[a-zA-Z\u4e00-\u9fa5]/.test(x));
  const headers = looksHeader ? first : null;

  const start = headers ? 1 : 0;
  const rows = [];
  for (let i = start; i < lines.length; i++) {
    const cols = lines[i].split(delim).map((x) => x.trim());
    if (cols.length < 5) continue;
    rows.push(cols);
  }
  return { headers, rows };
}

function guessCodeFromFilename(filePath) {
  const base = path.basename(filePath);
  const m = base.match(/(\d{6})/);
  return m ? m[1] : null;
}

function main() {
  const args = parseArgs(process.argv);
  const inDir = args.in ? path.resolve(String(args.in)) : null;
  const outDir = args.out ? path.resolve(String(args.out)) : null;
  if (!inDir || !outDir) {
    console.error('用法：node kline_import.mjs --in "原始CSV目录" --out "kline输出目录"');
    process.exit(1);
  }
  ensureDir(outDir);

  const files = listCsvFiles(inDir);
  if (!files.length) {
    console.error(`未找到CSV文件：${inDir}`);
    process.exit(1);
  }

  const grouped = new Map(); // code -> rows

  for (const fp of files) {
    const text = fs.readFileSync(fp, 'utf8');
    const { headers, rows } = parseCsv(text);
    const map = headers ? buildHeaderMap(headers) : null;

    const fallbackCode = guessCodeFromFilename(fp);
    const codeIdx = map?.code ?? null;

    for (const r of rows) {
      const code = codeIdx !== null ? String(r[codeIdx] ?? '').trim() : fallbackCode;
      if (!/^\d{6}$/.test(String(code))) continue;

      const dateRaw = map?.date !== null ? r[map.date] : r[0];
      const date = normalizeDate(dateRaw);
      if (!date) continue;

      const open = toNum(map?.open !== null ? r[map.open] : r[1]);
      const close = toNum(map?.close !== null ? r[map.close] : r[2]);
      const high = toNum(map?.high !== null ? r[map.high] : r[3]);
      const low = toNum(map?.low !== null ? r[map.low] : r[4]);
      const volume = toNum(map?.volume !== null ? r[map.volume] : r[5]);
      const amount = toNum(map?.amount !== null ? r[map.amount] : r[6]);

      if (!(open && close && high && low)) continue;
      if (!Number.isFinite(volume) || !Number.isFinite(amount)) continue;

      const row = { date, open, close, high, low, volume, amount };
      if (!grouped.has(code)) grouped.set(code, []);
      grouped.get(code).push(row);
    }
  }

  // write per code
  let written = 0;
  for (const [code, rows] of grouped.entries()) {
    rows.sort((a, b) => a.date.localeCompare(b.date));
    // de-dup by date
    const byDate = new Map();
    for (const r of rows) byDate.set(r.date, r);
    const uniqRows = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

    const outPath = path.join(outDir, `${code}.csv`);
    const body = uniqRows
      .map((r) => [r.date, r.open, r.close, r.high, r.low, r.volume, r.amount].join(','))
      .join('\n');
    fs.writeFileSync(outPath, body + '\n', 'utf8');
    written++;
  }

  console.log(`导入完成：输入文件${files.length}个，输出${written}个代码CSV -> ${outDir}`);
  console.log('提示：请确保同时导入/准备 000985.csv（中证全指基准），否则 qscreen 会报缺失。');
}

main();

