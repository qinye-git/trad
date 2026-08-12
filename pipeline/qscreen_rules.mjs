export const OPTIONAL_IF_MISSING_RULE_IDS = new Set([
  'earnings_cashflow_double_negative',
  'cashflow_quality_3y',
  'leverage_interest_cover',
  'roe_floor',
]);

export function normalizeRulesDoc(doc) {
  if (!doc || typeof doc !== 'object') throw new Error('rules YAML 解析失败：不是对象');
  return doc;
}

export function readCodesFromFile(filePath, fsModule) {
  const text = fsModule.readFileSync(filePath, 'utf8');
  return text
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .flatMap((line) => line.split(/[\s,，]+/))
    .map((x) => x.trim())
    .filter((c) => /^\d{6}$/.test(c));
}
