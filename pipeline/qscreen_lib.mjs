// qscreen_lib.mjs - qscreen 筛选核心库
// 规则解析、数据源探测、基准K线、行情快照、估值加载与筛选在一次调用内完成。
// qscreen.mjs 仅做 CLI 包装；qscreen_all_a.mjs 直接 import 调用，
// 避免子进程中转导致的重复初始化与中间文件读写。
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { OPTIONAL_IF_MISSING_RULE_IDS, normalizeRulesDoc } from './qscreen_rules.mjs';
import { rankBreakdown, pass1FastFilter } from './qscreen_indicators.mjs';
import {
  fetchQuoteSnapshot,
  fetchDailyKlineTencent,
  fetchDailyKlineSina,
  fetchDailyKlineBySecid,
  probeEastmoneyKlineAccess,
  readKlineCsv,
  resolveKlinePath,
  writeKlineCsv,
  loadValuationSnapshot,
} from './qscreen_data.mjs';
import { fillSnapshotNamesFromSecurityMaster, reuseFastPoolResults, runScreeningLoop } from './qscreen_runner.mjs';

function uniq(arr) {
  return [...new Set(arr)];
}

function ensureFinite(n, fallback = null) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

// 中证全指（CSI All Share）常用代码：000985（上证指数代码段，Eastmoney 用 SH 市场）
const BENCHMARK_CODE = '000985';
const BENCHMARK_SECID = '1.000985';

async function fetchBenchmarkKline({ klineProvider, klineDir, defaultKlineDir }) {
  const benchmarkCachePath = resolveKlinePath(defaultKlineDir, BENCHMARK_CODE);
  let idxK = null;
  const benchmarkFetchErrors = [];
  if (klineProvider === 'eastmoney') {
    try {
      idxK = await fetchDailyKlineBySecid(BENCHMARK_SECID, { days: 40 });
    } catch (e) {
      benchmarkFetchErrors.push(`eastmoney:${String(e?.message ?? e)}`);
    }
  }
  if ((!idxK || idxK.length < 8) && klineProvider === 'tencent') {
    try {
      idxK = await fetchDailyKlineTencent(`sh${BENCHMARK_CODE}`, { days: 60 });
    } catch (e) {
      benchmarkFetchErrors.push(`tencent:${String(e?.message ?? e)}`);
    }
  }
  if (!idxK || idxK.length < 8) {
    try {
      const sinaK = await fetchDailyKlineSina(`sh${BENCHMARK_CODE}`, { days: 60 });
      const lastDate = Array.isArray(sinaK) && sinaK.length ? String(sinaK[sinaK.length - 1].date ?? '') : '';
      if (lastDate >= '2025-01-01') idxK = sinaK;
      else benchmarkFetchErrors.push(`sina:stale_data:${lastDate || 'unknown'}`);
    } catch (e) {
      benchmarkFetchErrors.push(`sina:${String(e?.message ?? e)}`);
    }
  }
  // 探测可能出现误判；当首选源失败时，再补尝试一次东方财富。
  if ((!idxK || idxK.length < 8) && klineProvider !== 'eastmoney') {
    try {
      idxK = await fetchDailyKlineBySecid(BENCHMARK_SECID, { days: 40 });
    } catch (e) {
      benchmarkFetchErrors.push(`eastmoney-fallback:${String(e?.message ?? e)}`);
    }
  }
  if ((!idxK || idxK.length < 8) && klineDir) {
    const p = resolveKlinePath(klineDir, BENCHMARK_CODE);
    if (!fs.existsSync(p)) {
      throw new Error(`无法获取基准指数K线，且本地缺少：${p}（请在该目录放置 000985.csv；默认离线目录为 data/input/kline）`);
    }
    idxK = readKlineCsv(p);
  }
  if (!idxK || idxK.length < 8) {
    const detail = benchmarkFetchErrors.length ? `；抓取详情: ${benchmarkFetchErrors.join(' | ')}` : '';
    throw new Error(`无法获取中证全指(000985)日K数据，请稍后重试（或将 000985.csv 放到 data/input/kline，或使用 --klineDir 指定本地目录）${detail}`);
  }
  if (Array.isArray(idxK) && idxK.length >= 8) {
    try {
      writeKlineCsv(benchmarkCachePath, idxK);
    } catch {
      // cache write failure should not block screening
    }
  }
  const idxClose = idxK.map((r) => r.close).filter((x) => Number.isFinite(x));
  const idx_ret_5d = idxClose.length >= 6 ? idxClose[idxClose.length - 1] / idxClose[idxClose.length - 6] - 1 : 0;
  return idx_ret_5d;
}

/**
 * 执行一次完整筛选（含初始化），返回筛选结果及派生结构。
 * @param {object} opts
 * @param {string} opts.rulesPath 规则 YAML 路径
 * @param {string[]} opts.codes 6位股票代码数组
 * @param {Array|null} opts.reuseFastPool 复用的 pass1_fast 中间结果（内存态），传 null 则走全量 K 线筛选
 * @param {string|null} opts.valuationFile 估值快照 CSV 路径（缺省用 cwd/data/cache）
 * @param {string|null} opts.klineDir 本地K线目录（缺省自动识别 cwd/data/input/kline）
 * @param {boolean} opts.forceOffline 强制离线（跳过数据源探测）
 * @param {number} opts.concurrency K线筛选并发数（0 用默认 8）
 * @param {number} opts.topN top_candidates 数量
 * @param {string} opts.cwd 工作目录
 * @param {(msg?: string)=>void} opts.logger 日志输出函数
 */
export async function runQscreen({
  rulesPath,
  codes = [],
  reuseFastPool = null,
  valuationFile = null,
  klineDir = null,
  forceOffline = false,
  concurrency = 0,
  topN = 20,
  cwd = process.cwd(),
  logger = console.log,
}) {
  const rules = normalizeRulesDoc(YAML.parse(fs.readFileSync(rulesPath, 'utf8')));

  let allCodes = Array.isArray(codes) ? codes : [];
  if (Array.isArray(reuseFastPool) && reuseFastPool.length) {
    allCodes = allCodes.concat(reuseFastPool.map((x) => String(x?.code ?? '').trim()));
  }
  allCodes = uniq(allCodes).filter((c) => /^\d{6}$/.test(c));
  if (!allCodes.length) throw new Error('缺少股票代码：用 --codes 或 --codesFile 提供至少1个6位代码');

  const defaultKlineDir = path.resolve(path.join(cwd, 'data', 'input', 'kline'));
  const kDir = klineDir ? path.resolve(String(klineDir)) : (fs.existsSync(defaultKlineDir) ? defaultKlineDir : null);
  const probe = forceOffline ? { ok: false, forced: true } : await probeEastmoneyKlineAccess();
  const klineProvider = probe.ok ? 'eastmoney' : 'tencent';

  const idx_ret_5d = await fetchBenchmarkKline({ klineProvider, klineDir: kDir, defaultKlineDir });

  // 复用 fast_pool 时名称已随中间结果携带，跳过行情快照网络抓取，仅用本地 security_master 兜底补名。
  let snap = new Map();
  if (!Array.isArray(reuseFastPool) || !reuseFastPool.length) {
    try {
      snap = await fetchQuoteSnapshot([...allCodes, BENCHMARK_CODE]);
    } catch {
      snap = new Map();
    }
  }
  fillSnapshotNamesFromSecurityMaster({ snap, cwd, logger });

  const _valFile = valuationFile ? String(valuationFile) : path.join(cwd, 'data', 'cache');
  const valuationMap = loadValuationSnapshot(_valFile);
  if (valuationMap.size > 0) logger('[valuation] 已加载 ' + valuationMap.size + ' 只估值数据');

  const startedAt = Date.now();
  let results;
  if (Array.isArray(reuseFastPool) && reuseFastPool.length) {
    results = reuseFastPoolResults({
      fastPool: reuseFastPool,
      rules,
      valuationMap,
      idxRet5d: idx_ret_5d,
      optionalIfMissingRuleIds: OPTIONAL_IF_MISSING_RULE_IDS,
    });
    logger('[reuse] 复用 pass1_fast 中间结果: ' + results.length + '只');
  } else {
    results = await runScreeningLoop({
      codes: allCodes,
      rules,
      snap,
      valuationMap,
      klineProvider,
      klineDir: kDir,
      idxRet5d: idx_ret_5d,
      optionalIfMissingRuleIds: OPTIONAL_IF_MISSING_RULE_IDS,
      concurrency: Number(concurrency) || undefined,
    });
  }

  // ---- full 阶段派生结构（CLI 各 stage 按需取用）----
  const minScore = ensureFinite(rules?.output?.select_policy?.min_score, 0) ?? 0;
  const maxNames = Math.max(1, Math.min(500, Math.floor(ensureFinite(rules?.output?.select_policy?.max_names, 20) ?? 20)));
  const minGrade = String(rules?.output?.select_policy?.min_grade ?? 'B').toUpperCase();
  const gradeRank = { A: 3, B: 2, C: 1 };
  const minGradeRank = gradeRank[minGrade] ?? 2;

  const fastPool = results.filter(pass1FastFilter).map((r) => ({
    code: r.code,
    name: r.name,
    grade: r.grade,
    score: r.score,
    metrics: r.metrics,
    tags: r.tags ?? [],
  }));

  const rankedCandidates = results
    .filter((r) => r.grade !== 'C')
    .map((r) => {
      const breakdown = rankBreakdown(r.metrics ?? {});
      return {
        ...r,
        factor_breakdown: breakdown,
        rank_score: breakdown.rank_score,
      };
    })
    .sort((a, b) => (b.rank_score ?? 0) - (a.rank_score ?? 0) || (b.score ?? 0) - (a.score ?? 0));

  const topNCount = Math.max(1, Math.min(50, Number(topN) || 20));
  const topCandidates = rankedCandidates.slice(0, topNCount);

  const picked = results
    .filter((r) => (r.ok ?? false) && (gradeRank[r.grade] ?? 0) >= minGradeRank && (r.score ?? 0) >= minScore)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (gradeRank[b.grade] ?? 0) - (gradeRank[a.grade] ?? 0))
    .slice(0, maxNames);

  const llmAdvice = topCandidates.map((x, i) => {
    const rs = Number(x.metrics?.ret_5d ?? 0) - Number(x.metrics?.idx_ret_5d ?? 0);
    const mdd = Number(x.metrics?.MDD_252d ?? 1);
    const rank = Number(x.rank_score ?? 0);
    let decision = 'review';
    if (rank >= 65 && rs > 0 && mdd <= 0.35) decision = 'approve';
    else if (rank < 45 || mdd > 0.45) decision = 'reject';
    const risk_tags = [];
    if (mdd > 0.4) risk_tags.push('high_drawdown');
    if (Number(x.metrics?.ADV5_amount ?? 0) < 5000000) risk_tags.push('low_liquidity');
    return {
      rank: i + 1,
      code: x.code,
      name: x.name,
      decision,
      risk_tags,
      weight_suggestion: decision === 'approve' ? 0.08 : (decision === 'review' ? 0.04 : 0),
      reason: `rank=${rank.toFixed(1)}, excess5d=${(rs * 100).toFixed(2)}%, mdd252=${(mdd * 100).toFixed(1)}%`,
    };
  });

  const approved = llmAdvice.filter((x) => x.decision === 'approve');
  const review = llmAdvice.filter((x) => x.decision === 'review');
  const selectedForPortfolio = [...approved, ...review].slice(0, 12);
  const totalSuggestWeight = selectedForPortfolio.reduce((s, x) => s + Number(x.weight_suggestion || 0), 0);
  const normalizeDiv = totalSuggestWeight > 0 ? totalSuggestWeight : 1;
  const positions = selectedForPortfolio.map((x) => ({
    code: x.code,
    target_weight: Number((Math.min(0.12, Number(x.weight_suggestion || 0) / normalizeDiv)).toFixed(4)),
    decision: x.decision,
  }));

  const portfolioActionDraft = {
    constraints: {
      max_position_weight: 0.12,
      max_industry_exposure: 0.35,
      daily_turnover_limit: 0.30,
      max_positions: 12,
    },
    actions: positions,
    cash_target: Number(Math.max(0, 1 - positions.reduce((s, x) => s + x.target_weight, 0)).toFixed(4)),
  };

  const outObj = {
    asof: new Date().toISOString(),
    pipeline_meta: {
      stage: 'full',
      elapsed_ms: Date.now() - startedAt,
    },
    benchmark: { name: rules?.universe?.benchmark_index ?? '中证全指', code: BENCHMARK_CODE, idx_ret_5d },
    provider: { kline: klineProvider, quoteSnapshot: snap.size ? 'eastmoney' : 'n/a' },
    rules: { name: rules?.name ?? '', version: rules?.version ?? null },
    input: { codesCount: allCodes.length },
    output: { pickedCount: picked.length, minScore, minGrade, topN: topNCount },
    fast_pool: fastPool,
    ranked_candidates: rankedCandidates,
    top_candidates: topCandidates,
    llm_advice: llmAdvice,
    portfolio_action_draft: portfolioActionDraft,
    picked,
    all: results,
  };

  return {
    rules,
    snap,
    klineProvider,
    idx_ret_5d,
    benchmarkCode: BENCHMARK_CODE,
    results,
    fastPool,
    rankedCandidates,
    topCandidates,
    picked,
    llmAdvice,
    portfolioActionDraft,
    outObj,
    valuationMap,
    elapsedMs: Date.now() - startedAt,
  };
}
