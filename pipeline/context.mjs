import fs from 'node:fs';
import path from 'node:path';
import { todayCN } from '../common/date.js';

export function buildRunContext({ args, cwd }) {
  const dataInputDir = path.resolve(path.join(cwd, 'data', 'input'));
  const dataOutputDir = path.resolve(path.join(cwd, 'data', 'output'));
  const dataLogDir = path.resolve(path.join(cwd, 'data', 'logs'));

  fs.mkdirSync(dataInputDir, { recursive: true });
  fs.mkdirSync(dataOutputDir, { recursive: true });
  fs.mkdirSync(dataLogDir, { recursive: true });

  const rulesPath = args.rules
    ? path.resolve(String(args.rules))
    : path.resolve(path.join(cwd, 'config', '量化筛选限制.txt'));
  const codesOut = args.codesOut
    ? path.resolve(String(args.codesOut))
    : path.resolve(path.join(dataInputDir, 'all_a_codes.txt'));
  const outPath = args.out
    ? path.resolve(String(args.out))
    : path.resolve(path.join(dataOutputDir, 'qscreen_all_a.json'));
  const summaryPath = args.summary
    ? path.resolve(String(args.summary))
    : path.resolve(path.join(dataOutputDir, 'qscreen_all_a_summary.txt'));
  const metaPath = args.meta
    ? path.resolve(String(args.meta))
    : path.resolve(path.join(dataOutputDir, 'qscreen_all_a_meta.json'));

  if (!fs.existsSync(rulesPath)) throw new Error('未找到规则文件:' + rulesPath);

  const phaseRaw = String(args.phase ?? 'phase1').trim().toLowerCase();
  const isPhase2 = phaseRaw === '2' || phaseRaw === 'phase2';
  const skip = String(args.skipFetch || 'false') === 'true';
  const forceRefresh = String(args.forceRefresh || 'false') === 'true';
  const today = todayCN();

  return {
    rulesPath,
    codesOut,
    outPath,
    summaryPath,
    metaPath,
    candidatesPath: outPath.replace(/\.json$/, '_candidates.txt'),
    fastPoolPath: outPath.replace(/\.json$/, '_fast_pool.json'),
    valSnapshotPath: outPath.replace(/\.json$/, '_val_candidates.csv'),
    existingValPath: path.join(cwd, 'data', 'cache', 'valuation_snapshot_daily.csv'),
    pyScript: path.join(cwd, 'scripts', 'fetch_valuation_for_codes.py'),
    btLogPath: path.resolve(path.join(dataLogDir, 'backtest_daily_log.jsonl')),
    isPhase2,
    skip,
    forceRefresh,
    today,
  };
}
