// pipeline/stock_pool.mjs
// 股票池公共逻辑：候选代码生成、Sina symbol 转换、名称过滤、批量验活、批次扫描
// 供 gen_codes.mjs 与 universe.mjs 共用，避免两边实现漂移

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 生成候选代码范围（不含北交所 4/8 开头）
export function genCandidates() {
  const codes = [];
  // 沪市主板 600xxx 601xxx 603xxx 605xxx
  for (const prefix of [600, 601, 603, 605]) {
    for (let i = 0; i < 1000; i++) {
      codes.push(String(prefix * 1000 + i).padStart(6, '0'));
    }
  }
  // 科创板 688xxx
  for (let i = 0; i < 1000; i++) {
    codes.push(String(688000 + i).padStart(6, '0'));
  }
  // 深市主板 000xxx 001xxx
  for (let i = 0; i < 2000; i++) {
    codes.push(String(i).padStart(6, '0'));
  }
  // 创业板 300xxx 301xxx
  for (let i = 0; i < 2000; i++) {
    codes.push(String(300000 + i).padStart(6, '0'));
  }
  return [...new Set(codes)].sort();
}

// 6位代码 -> 新浪 symbol（sh/sz 前缀）
export function toSinaSymbol(code) {
  const c = String(code);
  return c.startsWith('6') || c.startsWith('9') ? `sh${c}` : `sz${c}`;
}

// 判断股票名称是否为可交易的正常A股：排除空名、'-'、纯数字、ST/*ST、退市
export function isTradableAName(name) {
  if (!name || name === '-' || /^[\d.]+$/.test(name)) return false;
  if (name.includes('ST')) return false; // 覆盖 ST 和 *ST
  if (name.includes('退')) return false;
  return true;
}

// 批量验活一批代码（默认100个/批），解析新浪行情快照（GBK），返回有效代码与过滤数
export async function batchCheck(codes) {
  const symbols = codes.map(toSinaSymbol).join(',');
  const url = `https://hq.sinajs.cn/rn=${Date.now()}&list=${symbols}`;
  let text;
  for (let i = 0; i < 3; i++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20000);
      const res = await fetch(url, {
        headers: {
          'Referer': 'https://finance.sina.com.cn/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      // 新浪返回 GBK，Node fetch 拿到 buffer 再解码
      const buf = await res.arrayBuffer();
      text = new TextDecoder('gbk').decode(buf);
      break;
    } catch (e) {
      if (i === 2) throw e;
      await sleep(500 * (i + 1));
    }
  }

  const valid = [];
  let filteredCount = 0;
  // 格式: var hq_str_sh600000="浦发银行,...";
  const re = /hq_str_(s[hz])(\d{6})="([^"]*)"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[3].split(',')[0]?.trim();
    if (!name || name === '-' || /^[\d.]+$/.test(name)) continue;
    if (!isTradableAName(name)) {
      filteredCount++;
      continue; // 排除 ST/*ST/退市
    }
    valid.push(m[2]); // 6位代码
  }
  return { valid, filteredCount };
}

// 批次扫描：按 batch 分批调用 batchCheck，返回按 [036] 过滤并排序的有效代码与统计
// 调用方负责输出各自的统计/落盘
export async function sinaScan(codes, { batch = 100, delayMs = 300, label = '批次' } = {}) {
  const valid = [];
  let totalRaw = 0;
  let totalFiltered = 0;
  const total = Math.ceil(codes.length / batch);

  for (let i = 0; i < codes.length; i += batch) {
    const batchNo = Math.floor(i / batch) + 1;
    process.stdout.write(`\r  ${label} ${batchNo}/${total} 已确认 ${valid.length} 只...`);
    try {
      const { valid: found, filteredCount } = await batchCheck(codes.slice(i, i + batch));
      totalRaw += found.length + filteredCount;
      totalFiltered += filteredCount;
      valid.push(...found);
    } catch (e) {
      console.warn(`\n批次 ${batchNo} 失败: ${e.message}，跳过`);
    }
    if (i + batch < codes.length) await sleep(delayMs);
  }
  process.stdout.write('\n');

  // 过滤掉北交所（4/8开头，虽然候选里没有，双重保险）
  const result = valid.filter((c) => /^[036]\d{5}$/.test(c)).sort();
  return { valid: result, totalRaw, totalFiltered };
}
