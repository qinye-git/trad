import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { loadCodeList, writeCodeList } from './io.mjs';
import { genCandidates, sinaScan } from './stock_pool.mjs';
import { loadSecurityMasterInfo } from './security_master.mjs';

// 统一运行时定位：与 stages.mjs 共用 common/runtime.js
const require = createRequire(import.meta.url);
const { getPythonRuntime } = require('../common/runtime.js');

async function sinaVerify(codes) {
  console.log('  新浪验活校验 ' + codes.length + ' 只...');
  const { valid: result, totalFiltered } = await sinaScan(codes, { label: '校验批次' });
  console.log('\n========== 股票池过滤统计（新浪校验）==========');
  console.log('输入数量:             ' + codes.length);
  console.log('ST/*ST/退市 过滤数:   ' + totalFiltered);
  console.log('最终保留数量:         ' + result.length);
  console.log('===============================================');
  return result;
}

async function sinaFullScan() {
  const cands = genCandidates();
  console.log('  候选代码 ' + cands.length + ' 个，批量验证中...');
  const { valid: result, totalRaw, totalFiltered } = await sinaScan(cands, { label: '批次' });
  console.log('\n========== 股票池过滤统计（新浪穷举）==========');
  console.log('原始命中总数:           ' + totalRaw);
  console.log('ST/*ST/退市 过滤数量:   ' + totalFiltered);
  console.log('最终保留数量:           ' + result.length);
  console.log('===============================================');
  return result;
}

async function fetchAllACodes(cwd) {
  const master = loadSecurityMasterInfo(cwd);

  if (master.codes.length > 100) {
    const today = new Date().toISOString().slice(0, 10);
    const isToday = master.updated === today;
    console.log('\n========== 股票池来源 ==========');
    console.log('来源:         security_master.csv');
    console.log('更新日期:     ' + (master.updated || '未知'));
    console.log('是否今日:     ' + (isToday ? '是' : '否（将用新浪补充校验）'));
    console.log('证券数量:     ' + master.codes.length);
    console.log('================================');

    if (isToday) return master.codes.sort();
    console.log('  security_master 非今日，启动新浪轻量校验...');
    return await sinaVerify(master.codes);
  }

  console.log('  未找到 security_master.csv，回退新浪穷举验活...');
  console.log('  建议运行: python build_security_master.py');
  return await sinaFullScan();
}

function needsMasterUpdate(cwd, today) {
  // 复用 security_master 解析缓存；文件变更（mtime/size）会自动失效
  const { updated } = loadSecurityMasterInfo(cwd);
  return updated !== today;
}

function codesFileIsToday(codesOut, today) {
  if (!fs.existsSync(codesOut)) return false;
  const mtime = fs.statSync(codesOut).mtime;
  return mtime.toISOString().slice(0, 10) === today;
}

export async function prepareUniverse({ cwd, codesOut, skip, forceRefresh, today }) {
  const dataInputDir = path.resolve(path.join(cwd, 'data', 'input'));
  fs.mkdirSync(dataInputDir, { recursive: true });
  let securityMasterCacheHit = null;
  let codes = [];

  if (!forceRefresh && (skip || codesFileIsToday(codesOut, today)) && fs.existsSync(codesOut)) {
    codes = loadCodeList(codesOut);
    const reason = skip ? '--skipFetch' : '今日已生成';
    console.log(`股票池 [${reason}] 直接使用，共 ${codes.length} 只（${today}）`);
    securityMasterCacheHit = true;
    return { codes, securityMasterCacheHit };
  }

  const masterScript = path.resolve(path.join(cwd, 'scripts', 'build_security_master.py'));
  const masterNeedsUpdate = forceRefresh ? true : needsMasterUpdate(cwd, today);

  if (forceRefresh) console.log('\n强制刷新模式：重新拉取全量证券主数据...');
  if (masterNeedsUpdate && fs.existsSync(masterScript)) {
    console.log('\n自动更新证券主数据（build_security_master.py）...');
    try {
      const pythonRuntime = getPythonRuntime();
      execFileSync(pythonRuntime.command, [masterScript], {
        encoding: 'utf8',
        timeout: 60000,
        maxBuffer: 8 * 1024 * 1024,
        env: pythonRuntime.env,
      });
      console.log('证券主数据更新完成');
    } catch (e) {
      console.warn('证券主数据更新失败（将用旧数据或新浪兜底）:', e.message);
    }
  } else if (!masterNeedsUpdate) {
    console.log('证券主数据今日已是最新，跳过重建');
  }

  console.log('\n正在获取全A股代码...');
  codes = await fetchAllACodes(cwd);
  if (!codes.length) throw new Error('未能获取代码');

  writeCodeList(codesOut, codes);
  console.log('已生成代码列表 共 ' + codes.length + ' 只（' + today + '）');
  securityMasterCacheHit = false;
  return { codes, securityMasterCacheHit };
}
