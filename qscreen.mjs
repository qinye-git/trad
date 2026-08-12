#!/usr/bin/env node
/**
 * qscreen.mjs
 * 读取 YAML 规则 + 拉取东方财富日K线/快照，计算指标并筛选候选股。
 * 本文件仅做 CLI 包装，筛选核心逻辑在 pipeline/qscreen_lib.mjs 的 runQscreen()。
 *
 * 用法示例：
 *   node qscreen.mjs --rules "量化筛选限制.txt" --codes 600519,000858
 *   node qscreen.mjs --rules "量化筛选限制.txt" --codesFile codes.txt
 *   node qscreen.mjs --rules "量化筛选限制.txt" --codesFile codes.txt --out out.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { readCodesFromFile } from './pipeline/qscreen_rules.mjs';
import { runQscreen } from './pipeline/qscreen_lib.mjs';

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

function uniq(arr) {
  return [...new Set(arr)];
}

const ANSI = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
};

// 仅在交互终端下输出 ANSI 颜色，避免 Electron/日志面板出现乱码控制字符
const USE_COLOR = process.stdout.isTTY === true;

// 按显示宽度补齐（中文/全角算2宽，ASCII算1宽）
function displayWidth(str) {
  let w = 0;
  for (const ch of String(str)) {
    const cp = ch.codePointAt(0);
    // 去除 ANSI 转义序列不计宽度
    w += (cp > 0x2E7F || (cp >= 0x1100 && cp <= 0x115F) ||
          (cp >= 0x2E80 && cp <= 0x303E) ||
          (cp >= 0x3040 && cp <= 0xA4CF) ||
          (cp >= 0xAC00 && cp <= 0xD7AF) ||
          (cp >= 0xF900 && cp <= 0xFAFF) ||
          (cp >= 0xFE10 && cp <= 0xFE1F) ||
          (cp >= 0xFE30 && cp <= 0xFE6F) ||
          (cp >= 0xFF00 && cp <= 0xFF60) ||
          (cp >= 0xFFE0 && cp <= 0xFFE6)) ? 2 : 1;
  }
  return w;
}
function padRight(str, width) {
  // 剥离 ANSI 转义计算可见宽度
  const visible = String(str).replace(/\x1b\[[\d;]*m/g, '');
  const dw = displayWidth(visible);
  const pad = Math.max(0, width - dw);
  return String(str) + ' '.repeat(pad);
}

// A股习惯：上涨=红色，下跌=绿色
function colorBySign(text, value) {
  if (!USE_COLOR) return String(text);
  const v = Number(value);
  if (!Number.isFinite(v) || v === 0) return String(text);
  const color = v > 0 ? ANSI.red : ANSI.green;
  return `${color}${text}${ANSI.reset}`;
}

function fmtPctColored(value, digits = 2) {
  const v = Number(value);
  if (!Number.isFinite(v)) return '-';
  const txt = `${v.toFixed(digits)}%`;
  if (!USE_COLOR) return txt;
  return colorBySign(txt, v);
}

function loadFastPoolFromFile(filePath) {
  const p = path.resolve(String(filePath));
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  return Array.isArray(raw?.fast_pool) ? raw.fast_pool : [];
}

async function main() {
  const args = parseArgs(process.argv);
  const rulesPath = args.rules ? path.resolve(String(args.rules)) : path.resolve(path.join(process.cwd(), 'config', '量化筛选限制.txt'));
  if (!rulesPath) throw new Error('缺少 --rules <YAML文件路径>');

  // 兼容旧参数：--pass1 true 等价于 --stage pass1_fast
  const stageArgRaw = String(args.stage ?? '').trim();
  const legacyPass1 = String(args.pass1 ?? 'false') === 'true';
  const stage = legacyPass1 ? 'pass1_fast' : (stageArgRaw || 'full');
  const validStages = new Set(['pass1_fast', 'pass2_rank', 'full']);
  if (!validStages.has(stage)) {
    throw new Error(`无效 --stage=${stage}，允许值: pass1_fast|pass2_rank|full`);
  }

  let codes = [];
  if (args.codes) {
    codes = String(args.codes)
      .split(/[\s,，]+/)
      .map((x) => x.trim())
      .filter((c) => /^\d{6}$/.test(c));
  }
  if (args.codesFile) {
    codes.push(...readCodesFromFile(path.resolve(String(args.codesFile)), fs));
  }
  let reusePool = null;
  const reuseFastPoolFile = String(args.reuseFastPool ?? '').trim();
  if (reuseFastPoolFile) {
    reusePool = loadFastPoolFromFile(reuseFastPoolFile);
    codes.push(...reusePool.map((x) => String(x?.code ?? '').trim()));
  }
  codes = uniq(codes);
  if (!codes.length) throw new Error('缺少股票代码：用 --codes 或 --codesFile 提供至少1个6位代码');

  const defaultKlineDir = path.resolve(path.join(process.cwd(), 'data', 'input', 'kline'));
  const klineDir = args.klineDir
    ? path.resolve(String(args.klineDir))
    : (fs.existsSync(defaultKlineDir) ? defaultKlineDir : null);
  const forceOffline = String(args.offline ?? 'false') === 'true';

  const lib = await runQscreen({
    rulesPath,
    codes,
    reuseFastPool: reusePool,
    valuationFile: args.valuationFile ? String(args.valuationFile) : undefined,
    klineDir,
    forceOffline,
    concurrency: Number(args.concurrency ?? 0) || undefined,
    topN: Number(args.topN ?? 20),
    cwd: process.cwd(),
  });

  const { rules, snap, klineProvider, idx_ret_5d, fastPool, rankedCandidates, topCandidates, picked, outObj } = lib;

  // Select policy from YAML（供各 stage 输出使用）
  const minScore = outObj.output.minScore;
  const minGrade = outObj.output.minGrade;
  const topN = outObj.output.topN;

  // pass1_fast：低成本粗筛，输出候选代码或结构化 fast_pool
  if (stage === 'pass1_fast') {
    if (args.outFastJson === 'true' || String(args.outputMode ?? '') === 'json') {
      const pass1Obj = {
        asof: new Date().toISOString(),
        stage: 'pass1_fast',
        provider: { kline: klineProvider, quoteSnapshot: snap.size ? 'eastmoney' : 'n/a' },
        input: { codesCount: codes.length },
        output: { fastPoolCount: fastPool.length },
        fast_pool: fastPool,
      };
      const outPath = args.out ? path.resolve(String(args.out)) : null;
      if (outPath) fs.writeFileSync(outPath, JSON.stringify(pass1Obj, null, 2), 'utf8');
      else process.stdout.write(JSON.stringify(pass1Obj, null, 2) + '\n');
      process.exit(0);
    }

    const outStr = fastPool.map((x) => x.code).join('\n') + '\n';
    if (args.out) fs.writeFileSync(args.out, outStr);
    else process.stdout.write(outStr);
    process.stderr.write('[pass1_fast] 候选股: ' + fastPool.length + '只\n');
    process.exit(0);
  }

  // pass2_rank：输出排序候选，不做最终规则通过过滤
  if (stage === 'pass2_rank') {
    const rankObj = {
      asof: new Date().toISOString(),
      stage: 'pass2_rank',
      provider: { kline: klineProvider, quoteSnapshot: snap.size ? 'eastmoney' : 'n/a' },
      input: { codesCount: codes.length },
      output: { rankedCount: rankedCandidates.length, topN },
      ranked_candidates: rankedCandidates,
      top_candidates: topCandidates,
    };
    const outPath = args.out ? path.resolve(String(args.out)) : null;
    if (outPath) fs.writeFileSync(outPath, JSON.stringify(rankObj, null, 2), 'utf8');
    else process.stdout.write(JSON.stringify(rankObj, null, 2) + '\n');
    process.exit(0);
  }

  const outPath = args.out ? path.resolve(String(args.out)) : null;
  if (outPath) {
    fs.writeFileSync(outPath, JSON.stringify(outObj, null, 2), 'utf8');
    console.log(`已写入：${outPath}`);
  }

  // Print a compact table
  const lines = [];
  lines.push(`筛选完成：输入${codes.length}只，入选${picked.length}只（minGrade=${minGrade}, minScore=${minScore}, stage=${stage}）`);
  lines.push(`基准：中证全指(000985) 近5日=${fmtPctColored(idx_ret_5d * 100, 2)}`);
  lines.push('');
  lines.push(['code', 'name', 'grade', 'score', 'ADV5金额(万)', '5日超额(%)', 'MDD252(%)', 'tags'].join('\t'));
  for (const r of picked) {
    const ex = (Number(r.metrics?.ret_5d ?? 0) - Number(r.metrics?.idx_ret_5d ?? 0)) * 100;
    const adv5Wan = Number(r.metrics?.ADV5_amount ?? 0) / 10000;
    const mddPct = Number(r.metrics?.MDD_252d ?? 0) * 100;
    const tagsStr = (r.tags ?? []).length ? (r.tags ?? []).join(',') : '--';
    lines.push(
      [
        r.code,
        r.name || '--',
        r.grade,
        Number(r.score ?? 0).toFixed(1),
        Number.isFinite(adv5Wan) ? adv5Wan.toFixed(2) : '--',
        fmtPctColored(ex, 2),
        fmtPctColored(mddPct, 1),
        tagsStr,
      ].join('\t')
    );
  }
  // 将制表符行转为固定宽度文本，避免不同终端列错位
  const preface = lines.slice(0, 3);
  const rawRows = lines.slice(3).map((x) => String(x).split('\t'));
  const widths = [8, 14, 6, 7, 14, 11, 10, 16];
  const fixedRows = rawRows.map((cols) => {
    const cells = [];
    for (let i = 0; i < widths.length; i++) {
      cells.push(padRight(cols[i] ?? '--', widths[i]));
    }
    return cells.join('  ');
  });
  console.log([...preface, ...fixedRows].join('\n'));
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  process.exitCode = 1;
});
