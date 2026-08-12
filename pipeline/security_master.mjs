// security_master.mjs - security_master.csv 解析结果缓存化
// 失效键：mtimeMs + 文件大小，避免同一进程内对同一 CSV 多次整表读取解析。
import fs from 'node:fs';
import path from 'node:path';

let _cacheKey = null;
let _cacheData = null;

export function loadSecurityMasterInfo(cwd) {
  const p = path.resolve(path.join(cwd, 'data', 'input', 'security_master.csv'));
  if (!fs.existsSync(p)) return { codes: [], nameMap: new Map(), updated: '' };

  const st = fs.statSync(p);
  const key = `${st.mtimeMs}:${st.size}`;
  if (_cacheKey === key && _cacheData) return _cacheData;

  const lines = fs.readFileSync(p, 'utf8').split('\n');
  const header = (lines[0] ?? '').split(',').map((s) => s.trim().replace(/^\uFEFF/, ''));
  const codeIdx = header.findIndex((h) => h === 'code');
  const nameIdx = header.findIndex((h) => h === 'name');
  const updIdx = header.findIndex((h) => h === 'updated');

  const codes = [];
  const nameMap = new Map();
  if (codeIdx !== -1 && nameIdx !== -1) {
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      const code = parts[codeIdx]?.trim();
      const name = parts[nameIdx]?.trim();
      if (!code) continue;
      if (name) nameMap.set(code, name);
      if (/^[036]\d{5}$/.test(code)) codes.push(code);
    }
  }
  const updated = updIdx !== -1 ? lines[1]?.split(',')?.[updIdx]?.trim() : '';

  _cacheKey = key;
  _cacheData = { codes, nameMap, updated };
  return _cacheData;
}
