function ensureFinite(n, fallback = null) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function mean(arr) {
  const xs = arr.filter((x) => Number.isFinite(x));
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function max(arr) {
  const xs = arr.filter((x) => Number.isFinite(x));
  if (!xs.length) return null;
  return Math.max(...xs);
}

function isStar688(code) {
  return String(code).startsWith('688');
}

function limitPctFor(code, name = '') {
  const n = String(name || '').toUpperCase();
  if (n.includes('ST') || n.includes('*ST')) return 0.05;
  if (String(code).startsWith('688')) return 0.2;
  return 0.1;
}

function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

export function calcIndicators({ code, name, k }) {
  const close = k.map((r) => r.close);
  const volume = k.map((r) => r.volume);
  const amount = k.map((r) => r.amount);

  const n = k.length;
  const last = k[n - 1];
  const prev = k[n - 2];
  const c1 = ensureFinite(last?.close, null);
  const c2 = ensureFinite(prev?.close, null);

  const pct_1d = c1 && c2 ? c1 / c2 - 1 : null;
  const c5 = ensureFinite(k[n - 6]?.close, null);
  const pct_5d = c1 && c5 ? c1 / c5 - 1 : null;

  const ADV5_vol = mean(volume.slice(-5));
  const ADV20_vol = mean(volume.slice(-20));
  const ADV5_amount = mean(amount.slice(-5));
  const MA20 = mean(close.slice(-20));

  const UpDays_10d = close.slice(-10).reduce((acc, c, i, arr) => {
    if (i === 0) return acc;
    const p = arr[i - 1];
    if (Number.isFinite(c) && Number.isFinite(p) && c > p) return acc + 1;
    return acc;
  }, 0);

  const VolUpDays_10d = k.slice(-10).reduce((acc, r, idx, arr) => {
    if (idx === 0) return acc;
    const prevR = arr[idx - 1];
    const isUp = Number.isFinite(r.close) && Number.isFinite(prevR.close) && r.close > prevR.close;
    const isVolUp = Number.isFinite(r.volume) && Number.isFinite(ADV20_vol) && r.volume >= ADV20_vol * 1.1;
    return isUp && isVolUp ? acc + 1 : acc;
  }, 0);

  const closes252 = close.slice(-252).filter((x) => Number.isFinite(x) && x > 0);
  let MDD_252d = null;
  if (closes252.length >= 30) {
    let peak = closes252[0];
    let mdd = 0;
    for (const c of closes252) {
      if (c > peak) peak = c;
      const dd = peak > 0 ? (peak - c) / peak : 0;
      if (dd > mdd) mdd = dd;
    }
    MDD_252d = mdd;
  }

  const tail60 = k.slice(-60);
  const lpct = limitPctFor(code, name);
  const limit_down_days_60d = tail60.reduce((acc, r, idx) => {
    if (idx === 0) return acc;
    const pre = ensureFinite(tail60[idx - 1]?.close, null);
    const c = ensureFinite(r?.close, null);
    if (!pre || !c) return acc;
    const dn = Number((pre * (1 - lpct)).toFixed(2));
    if (c <= dn + 0.01) return acc + 1;
    return acc;
  }, 0);

  const c10 = close.length >= 11 ? ensureFinite(close[close.length - 11], null) : null;
  const ret_10d = (c1 && c10) ? c1 / c10 - 1 : null;

  const tail15 = k.slice(-15);
  const limit_up_days_15d = tail15.reduce((acc, r, idx) => {
    if (idx === 0) return acc;
    const pre = ensureFinite(tail15[idx - 1]?.close, null);
    const c = ensureFinite(r?.close, null);
    if (!pre || !c) return acc;
    const up = Number((pre * (1 + lpct)).toFixed(2));
    if (c >= up - 0.01) return acc + 1;
    return acc;
  }, 0);

  const max_volume_1d_over_ADV20 = (() => {
    const w = k.slice(-10);
    if (!Number.isFinite(ADV20_vol) || !ADV20_vol) return null;
    return max(w.map((r) => (Number.isFinite(r.volume) ? r.volume / ADV20_vol : null)));
  })();

  return {
    close: c1,
    pct_1d,
    pct_5d,
    ret_5d: pct_5d,
    ADV5_vol,
    ADV20_vol,
    ADV5_amount,
    MA20,
    UpDays_10d,
    VolUpDays_10d,
    MDD_252d,
    limit_down_days_60d,
    max_volume_1d_over_ADV20,
    ret_10d,
    limit_up_days_15d,
  };
}

export function rankBreakdown(metrics) {
  const ret5 = Number(metrics?.ret_5d ?? NaN);
  const close = Number(metrics?.close ?? NaN);
  const ma20 = Number(metrics?.MA20 ?? NaN);
  const adv5v = Number(metrics?.ADV5_vol ?? NaN);
  const adv20v = Number(metrics?.ADV20_vol ?? NaN);
  const up10 = Number(metrics?.UpDays_10d ?? NaN);
  const volUp10 = Number(metrics?.VolUpDays_10d ?? NaN);
  const mdd252 = Number(metrics?.MDD_252d ?? NaN);
  const limitDn60 = Number(metrics?.limit_down_days_60d ?? NaN);
  const peDisc = Number(metrics?.pe_discount_flag ?? 0);
  const roe = Number(metrics?.ROE_avg_3y ?? NaN);

  const trend = clamp01(((Number.isFinite(ret5) ? ret5 : 0) + 0.03) / 0.08) * 70 + clamp01((Number.isFinite(close) && Number.isFinite(ma20) && ma20 > 0 ? close / ma20 - 0.95 : 0) / 0.15) * 30;
  const volume = clamp01((Number.isFinite(adv5v) && Number.isFinite(adv20v) && adv20v > 0 ? adv5v / adv20v : 0) / 2) * 40 + clamp01((Number.isFinite(up10) ? up10 : 0) / 10) * 30 + clamp01((Number.isFinite(volUp10) ? volUp10 : 0) / 6) * 30;
  const risk = clamp01((0.50 - (Number.isFinite(mdd252) ? mdd252 : 0.5)) / 0.50) * 80 + clamp01((1 - (Number.isFinite(limitDn60) ? limitDn60 : 1))) * 20;
  const valuation = clamp01(peDisc) * 60 + clamp01((Number.isFinite(roe) ? roe : 0) / 0.15) * 40;

  const rank_score = trend * 0.35 + volume * 0.30 + risk * 0.20 + valuation * 0.15;
  return {
    trend: Number(trend.toFixed(2)),
    volume: Number(volume.toFixed(2)),
    risk: Number(risk.toFixed(2)),
    valuation: Number(valuation.toFixed(2)),
    rank_score: Number(rank_score.toFixed(2)),
  };
}

export function pass1FastFilter(item) {
  const m = item?.metrics ?? {};
  const adv5 = Number(m.ADV5_amount ?? NaN);
  const close = Number(m.close ?? NaN);
  const ma20 = Number(m.MA20 ?? NaN);
  const mdd = Number(m.MDD_252d ?? NaN);
  const ret5 = Number(m.ret_5d ?? NaN);
  const ld60 = Number(m.limit_down_days_60d ?? NaN);
  if (!Number.isFinite(adv5) || adv5 < 10000) return false;
  if (!Number.isFinite(close) || !Number.isFinite(ma20) || ma20 <= 0 || close <= ma20) return false;
  if (!Number.isFinite(mdd) || mdd > 0.45) return false;
  if (!Number.isFinite(ret5) || Math.abs(ret5) > 0.25) return false;
  if (!Number.isFinite(ld60) || ld60 > 0) return false;
  return true;
}
