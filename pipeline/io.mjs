import fs from 'node:fs';

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      args[k] = v;
    } else {
      args._.push(a);
    }
  }
  return args;
}

export function loadCodeList(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .map(s => s.trim())
    .filter(s => /^\d{6}$/.test(s));
}

export function writeCodeList(filePath, codes) {
  fs.writeFileSync(filePath, codes.join('\n') + '\n', 'utf8');
}
