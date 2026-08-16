// 规则表达式只允许「数据字段 + 数学/比较/逻辑运算符」，禁止任何可触及运行时的标识符。
// 阻断原型链（constructor/prototype/__proto__）与全局对象（process/require/eval/...），
// 防止参数注入或规则内容被当成任意 JS 执行。
const FORBIDDEN_IDENTS = new Set([
  'constructor', 'prototype', '__proto__', '__defineGetter__', '__defineSetter__',
  'Function', 'eval', 'globalThis', 'window', 'global', 'process', 'require', 'import',
  'module', 'exports', 'this', 'arguments', 'Symbol', 'Reflect', 'Proxy',
]);
const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;

function assertSafeExpr(expr) {
  const text = String(expr ?? '');
  // 1) 标识符黑名单
  for (const m of text.matchAll(IDENT_RE)) {
    if (FORBIDDEN_IDENTS.has(m[0])) {
      throw new Error(`rule 表达式包含禁止标识符: ${m[0]}`);
    }
  }
  // 2) 字符白名单：数字/字符串/布尔/null/标识符/运算符/括号/逗号/点/引号
  const clean = text.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
  if (!/^[\s\d+\-*/%<>=!&|(),.:'"A-Za-z_$]+$/.test(clean)) {
    throw new Error('rule 表达式包含非法字符');
  }
  if (text.includes('=>')) {
    throw new Error('rule 表达式不允许箭头函数');
  }
  return true;
}

// ctx 只暴露自有数据字段：阻断原型链属性（constructor 等）与 undefined 兜底
function makeCtxProxy(ctx) {
  return new Proxy(ctx, {
    has(t, k) {
      return typeof k === 'string' && Object.prototype.hasOwnProperty.call(t, k);
    },
    get(t, k) {
      if (typeof k !== 'string' || !Object.prototype.hasOwnProperty.call(t, k)) return undefined;
      const v = Reflect.get(t, k, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

function evalRule(expr, ctx) {
  const safe = String(expr)
    .replace(/\bAND\b/g, '&&')
    .replace(/\bOR\b/g, '||')
    .replace(/\bNOT\b/g, '!')
    .replace(/\babs\s*\(/g, 'Math.abs(');

  assertSafeExpr(safe);

  const fn = new Function('ctx', `with (ctx) { return (${safe}); }`);
  return !!fn(makeCtxProxy(ctx));
}

export function evalRuleSafe(expr, ctx) {
  try {
    let safe = String(expr ?? '');
    safe = safe.replace(/([a-zA-Z_][a-zA-Z0-9_]*)\s+contains\s+'([^']*)'/g, "String($1).includes('$2')");
    safe = safe.replace(/([a-zA-Z_][a-zA-Z0-9_]*)\s+contains\s+\"([^\"]*)\"/g, 'String($1).includes("$2")');
    safe = safe.replace(/\bIF\s*\(/g, 'IF(');
    const IF = (cond, a, b) => (cond ? a : b);

    const value = evalRule(
      safe.replace(/\bIF\s*\(([\s\S]*)\)/g, 'IF($1)'),
      { ...ctx, IF }
    );
    return { value, missing: false };
  } catch (e) {
    const msg = String(e?.message ?? e ?? '');
    const missing = msg.includes('is not defined') || msg.includes('Cannot read properties of undefined');
    return { value: null, missing };
  }
}

function boardKey(code) {
  return String(code).startsWith('688') ? 'star688' : 'mainboard';
}

export function isLiquidityGuardrailFail(rules, ctx) {
  const guard = rules?.filters_hard?.liquidity?.find?.((x) => x.id === 'liquidity_guardrail_recommended');
  if (!guard) return false;
  try {
    const res = evalRuleSafe(guard.rule, ctx);
    if (res.value === null) return false;
    return !res.value;
  } catch {
    return false;
  }
}

export function computeScore(rules, ctx) {
  let score = 0;

  const scoreBlocks = [
    ...(rules?.signals?.fund_flow_proxy?.score ?? []),
    ...(rules?.signals?.valuation_quality?.score ?? []),
  ];
  for (const it of scoreBlocks) {
    if (!it?.rule || !Number.isFinite(Number(it.points))) continue;
    const res = evalRuleSafe(it.rule, ctx);
    if (res.value === true) score += Number(it.points);
  }

  for (const it of rules?.scoring?.rules ?? []) {
    if (it?.from_signal) continue;
    if (!it?.rule || !Number.isFinite(Number(it.points))) continue;
    const res = evalRuleSafe(it.rule, ctx);
    if (res.value === true) score += Number(it.points);
  }

  return score;
}

export function gradeRisk(rules, ctx) {
  const g = rules?.risk_grading?.grade_rules ?? {};

  const okAll = (arr) => {
    for (const expr of arr ?? []) {
      const res = evalRuleSafe(expr, ctx);
      if (res.value !== true) return false;
    }
    return true;
  };

  if (g.A?.require && okAll(g.A.require)) return 'A';
  if (g.B?.require && okAll(g.B.require)) return 'B';
  return 'C';
}

export function evaluateHardFailures({ rules, ctx, ind, optionalIfMissingRuleIds }) {
  const hardFail = [];

  const hardBlocks = [
    ...(rules?.filters_hard?.trading_status ?? []),
    ...(rules?.filters_hard?.liquidity ?? []),
    ...(rules?.filters_hard?.tail_risk ?? []),
    ...(rules?.filters_hard?.risk_limits ?? []),
  ];

  for (const it of hardBlocks) {
    if (!it?.rule) continue;
    if (it.severity === 'recommended') continue;
    const res = evalRuleSafe(it.rule, ctx);
    if (res.value === null && res.missing && optionalIfMissingRuleIds.has(it.id)) continue;
    if (res.value !== true) hardFail.push(it.id ?? it.rule);
  }

  const pv = rules?.signals?.price_volume?.hard ?? [];
  const rs = rules?.signals?.relative_strength?.hard ?? [];
  const ff = rules?.signals?.fund_flow_proxy?.hard ?? [];
  const vhard = rules?.signals?.valuation_quality?.hard ?? [];
  const fred = rules?.signals?.financial_redlines?.hard ?? [];

  const board = boardKey(ctx.code);
  for (const it of [...pv, ...rs, ...ff, ...vhard, ...fred]) {
    if (it?.rule_by_board) {
      const expr = it.rule_by_board?.[board];
      if (!expr) continue;
      const res = evalRuleSafe(expr, ctx);
      if (res.value === null && res.missing && optionalIfMissingRuleIds.has(it.id)) continue;
      if (res.value !== true) hardFail.push(it.id ?? expr);
      continue;
    }

    if (it?.id === 'avoid_single_day_extreme_volume') {
      const v = ind.max_volume_1d_over_ADV20;
      // 值缺失时跳过该规则（无法评估就不强判失败），避免旧格式数据/成交量不足时整批误杀
      if (!Number.isFinite(v)) continue;
      if (v > 3.0) hardFail.push(it.id);
      continue;
    }

    if (!it?.rule) continue;
    const res = evalRuleSafe(it.rule, ctx);
    if (res.value === null && res.missing && optionalIfMissingRuleIds.has(it.id)) continue;
    if (res.value !== true) hardFail.push(it.id ?? it.rule);
  }

  return hardFail;
}
