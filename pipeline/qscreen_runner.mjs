import fs from 'node:fs';
import { calcIndicators } from './qscreen_indicators.mjs';
import { evaluateHardFailures, computeScore, gradeRisk, isLiquidityGuardrailFail } from './qscreen_eval.mjs';
import { fetchDailyKline, fetchDailyKlineTencent, fetchDailyKlineSina, readKlineCsv, resolveKlinePath } from './qscreen_data.mjs';
import { loadSecurityMasterInfo } from './security_master.mjs';

function ensureFinite(n, fallback = null) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function boardKey(code) {
  return String(code).startsWith('688') ? 'star688' : 'mainboard';
}

function buildMetricsFromIndicators(ind, val, idxRet5d) {
  return {
    ADV5_amount: ind.ADV5_amount,
    ADV5_vol: ind.ADV5_vol,
    ADV20_vol: ind.ADV20_vol,
    pct_1d: ind.pct_1d,
    pct_5d: ind.pct_5d,
    ret_5d: ind.ret_5d,
    idx_ret_5d: idxRet5d,
    MA20: ind.MA20,
    close: ind.close,
    UpDays_10d: ind.UpDays_10d,
    VolUpDays_10d: ind.VolUpDays_10d,
    MDD_252d: ind.MDD_252d,
    limit_down_days_60d: ind.limit_down_days_60d,
    max_volume_1d_over_ADV20: ind.max_volume_1d_over_ADV20,
    PE_ttm: val.pe_ttm ?? null,
    PB: val.pb ?? null,
    industry_l1: val.industry_l1 ?? '',
    industry_l2: val.industry_l2 ?? '',
    PE_industry_ttm: val.pe_industry_median ?? null,
    pe_discount_flag: val.pe_discount_flag ?? 0,
    ROE_avg_3y: val.roe_avg_3y ?? null,
  };
}

function buildRuleContext({ code, name, metrics, val, amount, volume, idxRet5d }) {
  return {
    code,
    name,
    ...metrics,
    close: ensureFinite(metrics?.close, null),
    volume: ensureFinite(volume, null),
    amount: ensureFinite(amount, null),
    idx_ret_5d: idxRet5d,
    close_gt_MA20: Number.isFinite(Number(metrics?.close)) && Number.isFinite(Number(metrics?.MA20))
      ? Number(metrics.close) > Number(metrics.MA20)
      : false,
    PE_ttm: val.pe_ttm ?? null,
    PB: val.pb ?? null,
    PE_industry_ttm: val.pe_industry_median ?? null,
    pe_discount_flag: val.pe_discount_flag ?? 0,
    ROE_avg_3y: val.roe_avg_3y ?? null,
    is_loss: val.is_loss ?? 0,
    industry_l1: val.industry_l1 ?? '',
    industry_l2: val.industry_l2 ?? '',
  };
}

export function buildScreeningResultFromMetrics({
  code,
  name,
  metrics,
  rules,
  valuationMap,
  idxRet5d,
  optionalIfMissingRuleIds,
  amount = null,
  volume = null,
  baseTags = [],
}) {
  const val = valuationMap.get(String(code).padStart(6, '0')) ?? {};
  const mergedMetrics = {
    ...(metrics ?? {}),
    idx_ret_5d: idxRet5d,
    PE_ttm: val.pe_ttm ?? null,
    PB: val.pb ?? null,
    industry_l1: val.industry_l1 ?? '',
    industry_l2: val.industry_l2 ?? '',
    PE_industry_ttm: val.pe_industry_median ?? null,
    pe_discount_flag: val.pe_discount_flag ?? 0,
    ROE_avg_3y: val.roe_avg_3y ?? null,
  };
  const ctx = buildRuleContext({
    code,
    name,
    metrics: mergedMetrics,
    val,
    amount,
    volume,
    idxRet5d,
  });
  const ind = {
    max_volume_1d_over_ADV20: ensureFinite(metrics?.max_volume_1d_over_ADV20, null),
  };

  const hardFail = evaluateHardFailures({
    rules,
    ctx,
    ind,
    optionalIfMissingRuleIds,
  });
  const score = computeScore(rules, ctx);
  const grade = gradeRisk(rules, ctx);
  const liquidityRisk = isLiquidityGuardrailFail(rules, ctx);

  return {
    code,
    name,
    board: boardKey(code),
    ok: hardFail.length === 0 && grade !== 'C',
    grade,
    score,
    tags: liquidityRisk
      ? [...new Set([...(Array.isArray(baseTags) ? baseTags : []), 'high_slippage_risk'])]
      : (Array.isArray(baseTags) ? [...new Set(baseTags)] : []),
    hardFail,
    metrics: mergedMetrics,
  };
}

export function reuseFastPoolResults({
  fastPool,
  rules,
  valuationMap,
  idxRet5d,
  optionalIfMissingRuleIds,
}) {
  return (Array.isArray(fastPool) ? fastPool : []).map((item) =>
    buildScreeningResultFromMetrics({
      code: String(item?.code ?? '').trim(),
      name: String(item?.name ?? ''),
      metrics: item?.metrics ?? {},
      rules,
      valuationMap,
      idxRet5d,
      optionalIfMissingRuleIds,
      amount: item?.metrics?.ADV5_amount ?? null,
      volume: item?.metrics?.ADV5_vol ?? null,
      baseTags: item?.tags ?? [],
    })
  );
}

export function fillSnapshotNamesFromSecurityMaster({ snap, cwd, logger = console.log }) {
  // 复用 security_master 解析缓存，避免同一进程内对同一 CSV 重复整表读取
  const { nameMap } = loadSecurityMasterInfo(cwd);
  if (!nameMap.size) return;

  let filled = 0;
  for (const [code, name] of nameMap) {
    if (!snap.has(code)) {
      snap.set(code, { code, name });
      filled++;
    } else if (!snap.get(code).name) {
      snap.get(code).name = name;
      filled++;
    }
  }

  if (filled > 0) logger('[snap] security_master 补充名称: ' + filled + ' 只');
}

// 受控并发的默认并发上限：网络请求本身是异步的，这里同时发起多个抓取即可显著摊薄单次延迟
const DEFAULT_CONCURRENCY = 8;

// 单只股票：按 腾讯 -> 东财 -> 新浪 -> 本地CSV 的顺序尝试拿 K 线，返回原始K线数组或 null
async function fetchKlineForCode({ code, klineProvider, klineDir }) {
  let k = null;
  if (klineProvider === 'eastmoney') {
    try {
      k = await fetchDailyKline(code, { days: 320 });
    } catch {
      // fallback later
    }
  }
  if ((!k || k.length < 60) && klineProvider === 'tencent') {
    try {
      k = await fetchDailyKlineTencent(code, { days: 360 });
    } catch {
      // fallback later
    }
  }
  if (!k || k.length < 60) {
    try {
      k = await fetchDailyKlineSina(code, { days: 360 });
    } catch {
      // fallback later
    }
  }
  if ((!k || k.length < 60) && klineProvider !== 'eastmoney') {
    try {
      k = await fetchDailyKline(code, { days: 320 });
    } catch {
      // fallback later
    }
  }
  if ((!k || k.length < 60) && klineDir) {
    const p = resolveKlinePath(klineDir, code);
    if (fs.existsSync(p)) k = readKlineCsv(p);
  }
  return k;
}

// 单只股票：基于已有 K 线计算指标并按规则产出最终结果
function screeningResultFromKline({ code, name, k, rules, valuationMap, idxRet5d, optionalIfMissingRuleIds, snap }) {
  const ind = calcIndicators({ code, name, k });
  const val = valuationMap.get(String(code).padStart(6, '0')) ?? {};
  const metrics = buildMetricsFromIndicators(ind, val, idxRet5d);
  const ctx = buildRuleContext({
    code,
    name,
    metrics,
    val,
    amount: ensureFinite(k[k.length - 1]?.amount, null) ?? snap.get(code)?.amount ?? null,
    volume: ensureFinite(k[k.length - 1]?.volume, null) ?? snap.get(code)?.volume ?? null,
    idxRet5d,
  });

  const hardFail = evaluateHardFailures({
    rules,
    ctx,
    ind,
    optionalIfMissingRuleIds,
  });
  const score = computeScore(rules, ctx);
  const grade = gradeRisk(rules, ctx);
  const liquidityRisk = isLiquidityGuardrailFail(rules, ctx);

  return {
    code,
    name,
    board: boardKey(code),
    ok: hardFail.length === 0 && grade !== 'C',
    grade,
    score,
    tags: liquidityRisk ? ['high_slippage_risk'] : [],
    hardFail,
    metrics,
  };
}

export async function runScreeningLoop({
  codes,
  rules,
  snap,
  valuationMap,
  klineProvider,
  klineDir,
  idxRet5d,
  optionalIfMissingRuleIds,
  concurrency = DEFAULT_CONCURRENCY,
}) {
  const total = codes.length;
  if (!total) return [];
  const limit = Math.max(1, Math.min(Number(concurrency) || DEFAULT_CONCURRENCY, total));

  // 用下标占位保持结果顺序，避免并发完成顺序打乱输出
  const results = new Array(total);
  let doneCount = 0;
  let passedCount = 0;

  const reportProgress = () => {
    if (doneCount === 1 || doneCount % 100 === 0 || doneCount === total) {
      process.stdout.write('筛选进度: ' + doneCount + '/' + total + ' (' + Math.round(doneCount / total * 100) + '%) 已通过: ' + passedCount + '只\n');
    }
  };

  const processOne = async (code, idx) => {
    const s = snap.get(code) ?? { code, name: '' };
    const name = String(s.name ?? '');

    const k = await fetchKlineForCode({ code, klineProvider, klineDir });
    if (!k || k.length < 60) {
      const p = klineDir ? resolveKlinePath(klineDir, code) : null;
      const reason = (p && !fs.existsSync(p)) ? `缺少本地K线：${p}` : 'kline数据不足（<60天）';
      return { code, name, ok: false, reason };
    }

    return screeningResultFromKline({
      code,
      name,
      k,
      rules,
      valuationMap,
      idxRet5d,
      optionalIfMissingRuleIds,
      snap,
    });
  };

  // 固定并发上限的任务池：同步递增游标，结果按原顺序回填
  let cursor = 0;
  const runners = Array.from({ length: limit }, async () => {
    while (cursor < total) {
      const idx = cursor++;
      results[idx] = await processOne(codes[idx], idx);
      doneCount++;
      if (results[idx]?.ok) passedCount++;
      reportProgress();
    }
  });
  await Promise.all(runners);

  return results;
}
