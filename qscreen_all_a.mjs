import { parseArgs } from './pipeline/io.mjs';
import { buildRunContext } from './pipeline/context.mjs';
import { prepareUniverse } from './pipeline/universe.mjs';
import { runPass1, runValuationStep, runPass3 } from './pipeline/stages.mjs';
import { buildPipelineMeta, writeResultWithMeta, writeResultMeta, writeSummary, appendBacktestLog } from './pipeline/reporting.mjs';

async function main() {
  const args = parseArgs(process.argv);
  const cwd = process.cwd();
  const ctx = buildRunContext({ args, cwd });

  const runStartedAt = Date.now();
  const universeStartedAt = Date.now();

  const { codes, securityMasterCacheHit } = await prepareUniverse({
    cwd,
    codesOut: ctx.codesOut,
    skip: ctx.skip,
    forceRefresh: ctx.forceRefresh,
    today: ctx.today,
  });
  const timingUniverseMs = Date.now() - universeStartedAt;

  const pass1Result = await runPass1({
    rulesPath: ctx.rulesPath,
    codes,
    fastPoolPath: ctx.fastPoolPath,
    candidatesPath: ctx.candidatesPath,
    cwd,
  });

  const valuationResult = runValuationStep({
    pyScript: ctx.pyScript,
    candidatesPath: ctx.candidatesPath,
    candidateCodes: pass1Result.candidateCodes,
    valSnapshotPath: ctx.valSnapshotPath,
    existingValPath: ctx.existingValPath,
    today: ctx.today,
  });

  const step3Result = await runPass3({
    rulesPath: ctx.rulesPath,
    codes: pass1Result.candidateCodes,
    fastPool: pass1Result.fastPool,
    finalValPath: valuationResult.finalValPath,
    cwd,
  });

  const totalElapsedMs = Date.now() - runStartedAt;
  const pipelineMeta = buildPipelineMeta({
    isPhase2: ctx.isPhase2,
    totalElapsedMs,
    timingUniverseMs,
    timingPass1Ms: pass1Result.elapsedMs,
    timingValuationMs: valuationResult.elapsedMs,
    timingStep3Ms: step3Result.elapsedMs,
    securityMasterCacheHit,
    valuationCacheHitRate: valuationResult.valuationCacheHitRate,
  });

  writeResultWithMeta({ outPath: ctx.outPath, js: step3Result.js, pipelineMeta });
  writeResultMeta({ metaPath: ctx.metaPath, js: step3Result.js });

  writeSummary({
    summaryPath: ctx.summaryPath,
    js: step3Result.js,
    isPhase2: ctx.isPhase2,
    codesCount: codes.length,
    fastCount: step3Result.fastCount,
    rankedCount: step3Result.rankedCount,
    topCount: step3Result.topCount,
    llmCount: step3Result.llmCount,
    picked: step3Result.picked,
  });

  const tradeDate = new Date().toISOString().slice(0, 10);
  appendBacktestLog({
    btLogPath: ctx.btLogPath,
    tradeDate,
    isPhase2: ctx.isPhase2,
    js: step3Result.js,
    codesCount: codes.length,
    fastCount: step3Result.fastCount,
    rankedCount: step3Result.rankedCount,
    topCount: step3Result.topCount,
    picked: step3Result.picked,
    pipelineMeta,
  });

  console.log('回测日志: ' + ctx.btLogPath);
  console.log('\n全市场扫描完成！');
  console.log('代码列表: ' + ctx.codesOut);
  console.log('完整结果: ' + ctx.outPath);
  console.log('摘要说明: ' + ctx.summaryPath);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
