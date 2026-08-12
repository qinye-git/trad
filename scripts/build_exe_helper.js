// build_exe_helper.js - SEA打包入口（CJS格式，供SEA使用）
// 这是打包进exe的主程序，启动时直接跑 qscreen_all_a 的核心逻辑
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { getNodeRuntime } = require('../common/runtime.js');

// exe所在目录
const exeDir = path.dirname(process.execPath);
const scriptDir = path.join(exeDir);

console.log('=== A股量化筛选工具 ===');
console.log('exe目录:', exeDir);
console.log('');

// 统一运行时定位：SEA 场景下自动查找独立 node（exe自身不能复用来执行脚本）
const runtime = getNodeRuntime();
const nodeExe = runtime.command;

const args = process.argv.slice(2);
const skipFetch = args.includes('--skipFetch') || args.includes('--skip');

const scriptPath = path.join(scriptDir, 'qscreen_all_a.mjs');
if (!fs.existsSync(scriptPath)) {
  console.error('未找到 qscreen_all_a.mjs，请确保exe与脚本在同一目录！');
  process.exit(1);
}

const nodeArgs = [scriptPath];
if (skipFetch) nodeArgs.push('--skipFetch');
if (args.includes('--rules')) {
  const idx = args.indexOf('--rules');
  nodeArgs.push('--rules', args[idx+1]);
}

console.log('正在启动筛选...');
console.log(skipFetch ? '（跳过代码拉取，使用已有 all_a_codes.txt）' : '（将重新拉取全A股代码）');
console.log('');

try {
  execFileSync(nodeExe, nodeArgs, { stdio: 'inherit', timeout: 0 });
} catch(e) {
  console.error('执行失败:', e.message);
  process.exit(1);
}
