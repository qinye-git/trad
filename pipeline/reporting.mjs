import fs from 'node:fs';

export function buildPipelineMeta({ isPhase2, totalElapsedMs, timingUniverseMs, timingPass1Ms, timingValuationMs, timingStep3Ms, securityMasterCacheHit, valuationCacheHitRate }) {
  return {
    stage: isPhase2 ? 'phase2' : 'phase1',
    elapsed_ms: totalElapsedMs,
    timing_ms: {
      universe: timingUniverseMs,
      pass1_fast: timingPass1Ms,
      valuation_enrich: timingValuationMs,
      pass2_rank: timingStep3Ms,
      llm_arbitration: 0,
      portfolio_action: 0,
      total: totalElapsedMs,
    },
    cache_hit: {
      security_master: securityMasterCacheHit,
      kline: null,
      valuation: valuationCacheHitRate,
      roe: null,
    },
  };
}

export function writeResultWithMeta({ outPath, js, pipelineMeta }) {
  js.pipeline_meta = {
    ...(js.pipeline_meta ?? {}),
    ...pipelineMeta,
  };
  fs.writeFileSync(outPath, JSON.stringify(js, null, 2), 'utf8');
}

export function writeResultMeta({ metaPath, js }) {
  // 轻量状态文件：只保留 UI 所需字段（pipeline_meta + counts + picked），
  // 供 get-status 直接读取，避免每次解析数 MB 的完整结果 JSON。
  // 注意：必须在 writeResultWithMeta 之后调用（此时 js.pipeline_meta 已合并完整）。
  const meta = {
    asof: js?.asof ?? null,
    benchmark: js?.benchmark ?? null,
    provider: js?.provider ?? null,
    pipeline_meta: js?.pipeline_meta ?? null,
    input: js?.input ?? null,
    fast_pool_count: Array.isArray(js?.fast_pool) ? js.fast_pool.length : null,
    ranked_candidates_count: Array.isArray(js?.ranked_candidates) ? js.ranked_candidates.length : null,
    top_candidates_count: Array.isArray(js?.top_candidates) ? js.top_candidates.length : null,
    llm_advice_count: Array.isArray(js?.llm_advice) ? js.llm_advice.length : null,
    picked_count: Array.isArray(js?.picked) ? js.picked.length : null,
    picked: Array.isArray(js?.picked) ? js.picked : [],
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta), 'utf8');
}

export function writeSummary({ summaryPath, js, isPhase2, codesCount, fastCount, rankedCount, topCount, llmCount, picked }) {
  const lines = [];
  lines.push('时间: ' + ((js && js.asof) || new Date().toISOString()));
  lines.push('阶段: ' + (isPhase2 ? 'phase2' : 'phase1'));
  lines.push('基准: ' + ((js && js.benchmark && js.benchmark.name) || '中证全指') + ' 近5日收益率约' + (((js && js.benchmark && js.benchmark.idx_ret_5d) || 0) * 100).toFixed(2) + '%');
  lines.push('K线来源: ' + ((js && js.provider && js.provider.kline) || 'unknown'));
  lines.push('');
  lines.push('输入标的数: ' + codesCount);
  lines.push('Fast Pool: ' + fastCount);
  lines.push('Ranked Candidates: ' + rankedCount);
  lines.push('Top Candidates: ' + topCount);
  lines.push('LLM Advice: ' + llmCount);
  lines.push('入选标的数: ' + picked.length);
  lines.push('');

  if (picked.length > 0) {
    lines.push('入选标的（按得分排序）:');
    lines.push('排名\tcode\tname\tgrade\tscore');
    picked.forEach((x, i) => lines.push((i + 1) + '\t' + x.code + '\t' + x.name + '\t' + x.grade + '\t' + x.score));
  } else {
    lines.push('当前规则下无标的通过筛选，建议降低minScore或放宽硬过滤条件。');
  }

  fs.writeFileSync(summaryPath, lines.join('\n') + '\n', 'utf8');
}

export function appendBacktestLog({ btLogPath, tradeDate, isPhase2, js, codesCount, fastCount, rankedCount, topCount, picked, pipelineMeta }) {
  const row = {
    trade_date: tradeDate,
    asof: js?.asof ?? null,
    run_mode: isPhase2 ? 'phase2' : 'phase1',
    input_count: codesCount,
    fast_pool_count: fastCount,
    ranked_count: rankedCount,
    top_count: topCount,
    picked_count: picked.length,
    timing_ms: pipelineMeta.timing_ms,
    cache_hit: pipelineMeta.cache_hit,
    top_candidates: Array.isArray(js?.top_candidates) ? js.top_candidates.slice(0, 20).map(x => ({
      code: x.code,
      name: x.name,
      rank_score: x.rank_score,
      score: x.score,
    })) : [],
    picked: picked.map(x => ({ code: x.code, name: x.name, grade: x.grade, score: x.score })),
    benchmark: js?.benchmark ?? {},
  };

  fs.appendFileSync(btLogPath, JSON.stringify(row) + '\n', 'utf8');
}
