// build_exe.mjs - 自动完成 Node.js SEA 打包，生成 trad_screen.exe
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const cwd = path.resolve(path.join(path.dirname(new URL(import.meta.url).pathname.slice(process.platform === 'win32' ? 1 : 0)), '..'));
const nodeExe = process.execPath;
const exeOut = path.join(cwd, 'dist', 'trad_screen.exe');
const blob = path.join(cwd, 'dist', 'trad_screen_blob.blob');
const seaCfg = path.join(cwd, 'config', 'sea_config.json');
const postjectPath = path.join(cwd, 'node_modules', '.bin', 'postject.cmd');

console.log('Node.js SEA 打包工具');
console.log('Node:', nodeExe);
console.log('');

// Step 1: 安装 postject
if (!fs.existsSync(postjectPath)) {
  console.log('Step 1: 安装 postject...');
  try {
    execSync('npm install postject --save-dev', { cwd, stdio: 'inherit', timeout: 120000 });
  } catch(e) {
    console.error('postject 安装失败，请检查网络或手动运行: npm install postject --save-dev');
    process.exit(1);
  }
} else {
  console.log('Step 1: postject 已安装，跳过');
}

// Step 2: 生成 blob
console.log('Step 2: 生成 SEA blob...');
try {
  execFileSync(nodeExe, ['--experimental-sea-config', seaCfg], { cwd, stdio: 'inherit' });
} catch(e) {
  console.error('生成 blob 失败:', e.message);
  process.exit(1);
}

// Step 3: 复制 node.exe 为目标 exe
console.log('Step 3: 复制 node.exe -> trad_screen.exe...');
fs.copyFileSync(nodeExe, exeOut);

// Step 4: 去掉签名（Windows）
console.log('Step 4: 移除签名...');
try {
  execSync(`signtool remove /s "${exeOut}"`, { stdio: 'pipe' });
  console.log('  签名已移除');
} catch(e) {
  console.log('  signtool 不可用（跳过，通常不影响运行）');
}

// Step 5: 注入 blob
console.log('Step 5: 注入 blob...');
try {
  execSync(
    `"${postjectPath}" "${exeOut}" NODE_SEA_BLOB "${blob}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`,
    { cwd, stdio: 'inherit' }
  );
} catch(e) {
  console.error('注入失败:', e.message);
  process.exit(1);
}

console.log('');
console.log('打包完成！生成文件: ' + exeOut);
console.log('');
console.log('使用方式（把exe和所有.mjs/.txt放在同一目录）:');
console.log('  trad_screen.exe              # 重新拉取全A股代码再筛选');
console.log('  trad_screen.exe --skipFetch  # 跳过拉取，直接用已有 all_a_codes.txt 筛选');
