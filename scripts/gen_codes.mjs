#!/usr/bin/env node
/**
 * gen_codes.mjs
 * 通过新浪行情快照批量验证，生成全A股（主板+创业板+科创板）有效代码列表
 * 排除北交所（43/83开头）
 * 输出到 all_a_codes.txt
 * 候选生成/验活/过滤逻辑统一在 pipeline/stock_pool.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { genCandidates, sinaScan } from '../pipeline/stock_pool.mjs';

// 兼容旧引用：isTradableAName 已统一到 pipeline/stock_pool.mjs
export { isTradableAName } from '../pipeline/stock_pool.mjs';

const OUT = path.resolve('data', 'input', 'all_a_codes.txt');
const BATCH = 100; // 每次请求几个代码

async function main() {
  const candidates = genCandidates();
  console.log(`候选代码共 ${candidates.length} 个，开始批量验证...`);

  const { valid: filtered, totalRaw, totalFiltered } = await sinaScan(candidates, {
    batch: BATCH,
    label: '验证批次',
  });

  fs.writeFileSync(OUT, filtered.join('\n') + '\n', 'utf8');

  console.log(`\n\n========== 过滤统计 ==========`);
  console.log(`原始命中总数:           ${totalRaw}`);
  console.log(`ST/*ST/退市 过滤数量:   ${totalFiltered}`);
  console.log(`最终写入数量:           ${filtered.length}`);
  console.log(`==============================`);
  console.log(`已写入: ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
