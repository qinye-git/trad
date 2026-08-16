import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { loadCodeList, writeCodeList } from './io.mjs';
import { runQscreen } from './qscreen_lib.mjs';

// 统一运行时定位：Node/Python 解释器解析与 UTF-8 编码环境都走 common/runtime.js
const require = createRequire(import.meta.url);
const { getPythonRuntime } = require('../common/runtime.js');

// Step2 估值子进程硬超时（5 分钟）。Python 端任何非 daemon 阻塞都不会无限拖住筛选主流程，
// 超时后抛错由下方 catch 兜底：回退旧估值文件或跳过估值规则。
const VALUATION_TIMEOUT_MS = 5 * 60 * 1000;

export async function runPass1({ rulesPath, codes, fastPoolPath, candidatesPath, cwd }) {
  console.log('\nStep1: K线量价筛选（pass1_fast json）...');
  const startedAt = Date.now();

  // 直接库调用，跳过 qscreen 子进程中转与整套重复初始化
  const p1 = await runQscreen({ rulesPath, codes, cwd });

  const fastPool = p1.fastPool;

  // 统一输出 fast_pool JSON：供审计/历史比对使用（Step3 直接复用本次运行的内存结果，
  // 避免 phase1 模式下复用历史残留的 fast_pool 文件（数据过期/缺字段））
  const fastObj = {
    asof: new Date().toISOString(),
    stage: 'pass1_fast',
    provider: { kline: p1.klineProvider, quoteSnapshot: p1.snap.size ? 'eastmoney' : 'n/a' },
    input: { codesCount: codes.length },
    output: { fastPoolCount: fastPool.length },
    fast_pool: fastPool,
  };
  fs.writeFileSync(fastPoolPath, JSON.stringify(fastObj, null, 2), 'utf8');

  const fastCodes = fastPool.map((x) => String(x?.code ?? '').trim()).filter((s) => /^\d{6}$/.test(s));
  if (fastCodes.length > 0) writeCodeList(candidatesPath, fastCodes);

  if (!fs.existsSync(candidatesPath)) throw new Error(`未找到候选股:${candidatesPath}`);

  let candidateCodes = loadCodeList(candidatesPath);
  console.log('候选股: ' + candidateCodes.length + '只');
  if (candidateCodes.length === 0) {
    console.warn('pass1无候选股，回退到全量代码...');
    candidateCodes = [...codes];
    writeCodeList(candidatesPath, candidateCodes);
  }

  return {
    fastPool,
    candidateCodes,
    elapsedMs: Date.now() - startedAt,
  };
}

export function runValuationStep({ pyScript, candidatesPath, candidateCodes, valSnapshotPath, existingValPath, today }) {
  console.log('\nStep2: 查询候选股PE/PB（增量缓存策略）...');
  const startedAt = Date.now();
  let valuationPyLog = '';
  const pythonRuntime = getPythonRuntime();

  try {
    console.log('Step2 使用代码文件: ' + candidatesPath + ' (候选股' + candidateCodes.length + '只)');
    const pyArgs = [pyScript, '--codesFile', candidatesPath, '--out', valSnapshotPath];
    const pyOut = execFileSync(pythonRuntime.command, pyArgs, {
      encoding: 'utf8',
      timeout: VALUATION_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      env: pythonRuntime.env,
    });
    valuationPyLog = String(pyOut ?? '');
    if (valuationPyLog.trim()) console.log(valuationPyLog.trim());
  } catch (e) {
    const isTimeout = String(e?.code ?? '').toUpperCase() === 'ETIMEDOUT';
    if (isTimeout) {
      console.warn(`[警告] Step2 PE/PB查询超过 ${VALUATION_TIMEOUT_MS / 1000}s 仍未完成，已终止子进程`);
    } else {
      console.warn('PE/PB查询失败（跳过估值规则）:', e.message);
    }
  }

  let valuationCacheHitRate = null;
  const m = String(valuationPyLog).match(/目标代码:\s*(\d+)\s*只，缓存命中:\s*(\d+)\s*只，需抓取:\s*(\d+)\s*只/);
  if (m) {
    const totalTarget = Number(m[1]);
    const hit = Number(m[2]);
    valuationCacheHitRate = totalTarget > 0 ? hit / totalTarget : null;
  }

  const finalValPath = fs.existsSync(valSnapshotPath)
    ? valSnapshotPath
    : (fs.existsSync(existingValPath) ? existingValPath : '');

  if (!fs.existsSync(valSnapshotPath) && finalValPath) {
    const valStat = fs.statSync(finalValPath);
    const valDate = valStat.mtime.toISOString().slice(0, 10);
    console.warn(`[警告] Step2 PE/PB抓取失败，回退使用旧估值文件: ${finalValPath}`);
    console.warn(`[警告] 旧估值文件日期: ${valDate}，今日: ${today}，估值数据可能已漂移`);
  } else if (!finalValPath) {
    console.warn('[警告] Step2 PE/PB抓取失败且无历史估值文件，本次筛选将跳过所有估值规则');
  }

  return {
    valuationPyLog,
    valuationCacheHitRate,
    finalValPath,
    elapsedMs: Date.now() - startedAt,
  };
}

export async function runPass3({ rulesPath, codes, fastPool, finalValPath, cwd }) {
  console.log('\nStep3: 完整筛选...');
  const startedAt = Date.now();

  // 直接库调用：复用 pass1 内存 fast_pool 与估值文件，不再重复初始化
  const p3 = await runQscreen({
    rulesPath,
    codes,
    reuseFastPool: fastPool,
    valuationFile: finalValPath || undefined,
    cwd,
  });
  const js = p3.outObj;

  const picked = Array.isArray(js?.picked) ? js.picked : [];
  const rankedCount = Array.isArray(js?.ranked_candidates) ? js.ranked_candidates.length : 0;
  const topCount = Array.isArray(js?.top_candidates) ? js.top_candidates.length : 0;
  const fastCount = Array.isArray(js?.fast_pool) ? js.fast_pool.length : 0;
  const llmCount = Array.isArray(js?.llm_advice) ? js.llm_advice.length : 0;

  return {
    js,
    picked,
    rankedCount,
    topCount,
    fastCount,
    llmCount,
    elapsedMs: Date.now() - startedAt,
  };
}
