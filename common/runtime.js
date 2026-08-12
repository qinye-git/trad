// common/runtime.js
// 统一 Node / Python 运行时定位逻辑（CommonJS，供 Electron 主进程、CLI、SEA 打包入口共用）
// - Node：优先复用当前进程（Electron 场景需 ELECTRON_RUN_AS_NODE=1）
// - Python：支持 TRAD_PYTHON 显式指定，否则在 PATH 中探测 python -> py -> python3
// - 所有子进程统一注入 UTF-8 相关环境变量，避免中文乱码

'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

// SEA 打包（trad_screen.exe）时，process.execPath 指向 exe 自身；
// 重新执行会再次进入打包入口（build_exe_helper.js），必须找到独立的 node 可执行文件
function isSea() {
  try {
    if (process.isSea === true) return true;
    const sea = require('node:sea');
    if (sea && typeof sea.isSea === 'function' && sea.isSea()) return true;
  } catch {}
  return false;
}

function getNodeRuntime() {
  if (isSea()) {
    const candidates = [
      (process.env.TRAD_NODE || '').trim(),
      path.join(path.dirname(process.execPath), 'node.exe'),
      'node',
    ].filter(Boolean);
    for (const c of candidates) {
      try {
        execFileSync(c, ['--version'], { timeout: 10000, stdio: 'pipe' });
        return { command: c, env: { ...process.env } };
      } catch {}
    }
    return { command: 'node', env: { ...process.env } };
  }

  return {
    command: process.execPath,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
    },
  };
}

let _pythonCommand = null;
function resolvePythonCommand() {
  if (_pythonCommand) return _pythonCommand;

  const envPy = (process.env.TRAD_PYTHON || '').trim();
  if (envPy) {
    try {
      execFileSync(envPy, ['-c', 'pass'], { timeout: 10000, stdio: 'pipe' });
      _pythonCommand = envPy;
      return _pythonCommand;
    } catch {}
  }

  for (const cmd of ['python', 'py', 'python3']) {
    try {
      execFileSync(cmd, ['-c', 'pass'], { timeout: 10000, stdio: 'pipe' });
      _pythonCommand = cmd;
      return _pythonCommand;
    } catch {}
  }

  _pythonCommand = 'python';
  return _pythonCommand;
}

function getPythonRuntime() {
  return {
    command: resolvePythonCommand(),
    env: {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
    },
  };
}

function execNodeSync(args, opts = {}) {
  const rt = getNodeRuntime();
  return execFileSync(rt.command, args, { encoding: 'utf8', env: rt.env, ...opts });
}

function execPythonSync(args, opts = {}) {
  const rt = getPythonRuntime();
  return execFileSync(rt.command, args, { encoding: 'utf8', env: rt.env, ...opts });
}

module.exports = {
  isSea,
  getNodeRuntime,
  resolvePythonCommand,
  getPythonRuntime,
  execNodeSync,
  execPythonSync,
};
