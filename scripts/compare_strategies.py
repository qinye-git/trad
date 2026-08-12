#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import argparse, json, math, random, sys, time
from pathlib import Path

DEFAULT_TOP_N = 30
DEFAULT_COST_BUY_BPS = 3.0
DEFAULT_COST_SELL_BPS = 13.0
DEFAULT_BOOTSTRAP = 2000
REBALANCE_PER_YEAR = 50
SMALL_SAMPLE_WARN = 60

FACTOR_MAP = {
    "industry_avg_pe_proxy": "PE_industry_ttm",
    "amount": "ADV5_amount",
    "roe_past4q_avg": "ROE_avg_3y",
    "float_market_cap": "ADV5_amount",
    "price_to_ma20": "derived_price_to_ma20",
    "close": "close",
    "volume_ratio": "derived_volume_ratio",
    "roe": "ROE_avg_3y",
    "relative_strength": "ret_5d",
    "market_return_20d": "idx_ret_5d",
}


def load_json(path: Path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def safe_float(v, fallback=None):
    try:
        x = float(v)
        return x if math.isfinite(x) else fallback
    except Exception:
        return fallback


def pct(x, d=2):
    return "N/A" if x is None else f"{x * 100:.{d}f}%"


def derived_metrics(m):
    close = safe_float(m.get("close"))
    ma20 = safe_float(m.get("MA20"))
    adv5 = safe_float(m.get("ADV5_vol"))
    adv20 = safe_float(m.get("ADV20_vol"))
    return {
        "derived_price_to_ma20": (close / ma20) if (close and ma20 and ma20 > 0) else None,
        "derived_volume_ratio": (adv5 / adv20) if (adv5 and adv20 and adv20 > 0) else None,
    }


def compute_lgbm_score(metrics, weights):
    d = derived_metrics(metrics)
    total_abs = sum(abs(float(w)) for w in weights.values())
    if total_abs <= 1e-12:
        return 0.0, 0.0
    score = 0.0
    used_abs = 0.0
    for factor, w in weights.items():
        w = float(w)
        if abs(w) <= 1e-12:
            continue
        key = FACTOR_MAP.get(factor)
        if not key:
            continue
        val = d.get(key) if key.startswith("derived_") else safe_float(metrics.get(key))
        if val is None:
            continue
        score += w * val
        used_abs += abs(w)
    return score, used_abs / total_abs


def portfolio_excess_5d(metrics_list, idx_ret_5d, cost_rate):
    if not metrics_list:
        return None
    rs = [safe_float(m.get("ret_5d")) for m in metrics_list]
    rs = [x for x in rs if x is not None]
    if not rs:
        return None
    return sum(rs) / len(rs) - idx_ret_5d - cost_rate


def bootstrap_ci(data, stat_fn, n_boot=2000, ci=0.95, seed=42):
    n = len(data)
    if n == 0:
        return None, None
    rng = random.Random(seed)
    vals = [stat_fn([data[rng.randint(0, n - 1)] for _ in range(n)]) for _ in range(n_boot)]
    vals.sort()
    lo = vals[int((1 - ci) / 2 * n_boot)]
    hi = vals[int((1 + ci) / 2 * n_boot)]
    return lo, hi


def calc_summary(excess_series):
    xs = [x for x in excess_series if x is not None]
    n = len(xs)
    if n == 0:
        return {}
    mean_x = sum(xs) / n
    win_rate = sum(1 for x in xs if x > 0) / n
    annual_excess = mean_x * REBALANCE_PER_YEAR
    var = sum((x - mean_x) ** 2 for x in xs) / max(1, n - 1)
    std = math.sqrt(var)
    sharpe = (mean_x / std * math.sqrt(REBALANCE_PER_YEAR)) if std > 1e-12 else None
    nav = peak = 1.0
    max_dd = 0.0
    for x in xs:
        nav *= (1 + x)
        peak = max(peak, nav)
        max_dd = max(max_dd, (peak - nav) / peak)
    calmar = (annual_excess / max_dd) if max_dd > 1e-12 else None
    wr_ci = bootstrap_ci(xs, lambda s: sum(1 for v in s if v > 0) / len(s), DEFAULT_BOOTSTRAP)
    ex_ci = bootstrap_ci(xs, lambda s: sum(s) / len(s), DEFAULT_BOOTSTRAP)
    return {
        "n": n, "win_rate": win_rate, "mean_excess": mean_x, "annual_excess": annual_excess,
        "std_excess": std, "sharpe": sharpe, "max_dd": max_dd, "calmar": calmar,
        "win_rate_ci95": wr_ci, "mean_excess_ci95": ex_ci,
    }


def print_summary(name, m):
    print(f"\n{name}\n" + "-" * 58)
    if not m:
        print("无有效数据")
        return
    print(f"调仓次数: {m['n']}")
    if m["n"] < SMALL_SAMPLE_WARN:
        print(f"⚠ 样本偏少（<{SMALL_SAMPLE_WARN}）")
    wr_lo, wr_hi = m["win_rate_ci95"]
    ex_lo, ex_hi = m["mean_excess_ci95"]
    print(f"胜率: {pct(m['win_rate'])}  CI95=[{pct(wr_lo)}, {pct(wr_hi)}]")
    print(f"单期平均超额: {pct(m['mean_excess'])}  CI95=[{pct(ex_lo)}, {pct(ex_hi)}]")
    print(f"年化超额(估算): {pct(m['annual_excess'])}")
    print(f"超额波动: {pct(m['std_excess'])}")
    print(f"Sharpe: {m['sharpe']:.3f}" if m['sharpe'] is not None else "Sharpe: N/A")
    print(f"最大超额回撤: {pct(m['max_dd'])}")
    print(f"Calmar: {m['calmar']:.3f}" if m['calmar'] is not None else "Calmar: N/A")


def comb(n, k):
    if k < 0 or k > n:
        return 0
    k = min(k, n - k)
    c = 1
    for i in range(1, k + 1):
        c = c * (n - k + i) // i
    return c


def binom_two_sided_pvalue(n, k):
    if n <= 0:
        return None
    p_obs = comb(n, k) / (2 ** n)
    s = 0.0
    for i in range(n + 1):
        p = comb(n, i) / (2 ** n)
        if p <= p_obs + 1e-18:
            s += p
    return min(1.0, s)


def compare_significance(rules_xs, lgbm_xs):
    diffs = [r - l for r, l in zip(rules_xs, lgbm_xs) if r is not None and l is not None]
    if not diffs:
        return {"n": 0, "mean_diff": None, "mean_diff_ci95": (None, None), "rules_better_ratio": None, "sign_test_p": None}
    n = len(diffs)
    mean_diff = sum(diffs) / n
    ci = bootstrap_ci(diffs, lambda s: sum(s) / len(s), DEFAULT_BOOTSTRAP)
    pos = sum(1 for d in diffs if d > 0)
    neg = sum(1 for d in diffs if d < 0)
    eff = pos + neg
    ratio = (pos / eff) if eff > 0 else None
    pval = binom_two_sided_pvalue(eff, pos) if eff > 0 else None
    return {"n": n, "mean_diff": mean_diff, "mean_diff_ci95": ci, "rules_better_ratio": ratio, "sign_test_p": pval}


def print_significance(sig):
    print("\n跨期显著性检验（规则超额 - LightGBM超额）\n" + "-" * 58)
    if not sig or sig.get("n", 0) == 0:
        print("无可用配对样本")
        return
    lo, hi = sig["mean_diff_ci95"]
    print(f"配对期数: {sig['n']}")
    print(f"平均差值: {pct(sig['mean_diff'])}  CI95=[{pct(lo)}, {pct(hi)}]")
    print(f"规则更优占比: {pct(sig['rules_better_ratio'])}")
    p = sig.get("sign_test_p")
    print(f"Sign test p-value: {p:.4f}" if p is not None else "Sign test p-value: N/A")


def final_verdict_multi(sig, min_periods=20):
    n = sig.get("n", 0)
    md = sig.get("mean_diff")
    lo, hi = sig.get("mean_diff_ci95", (None, None))
    p = sig.get("sign_test_p")
    if n < min_periods:
        return f"样本仅 {n} 期，暂不做强结论（建议≥{min_periods}期）"
    if md is None or lo is None or hi is None or p is None:
        return "数据不足，无法判定"
    if lo > 0 and p < 0.05:
        return "规则策略显著更优（跨期统计显著）"
    if hi < 0 and p < 0.05:
        return "LightGBM策略显著更优（跨期统计显著）"
    return "两者差异不显著（当前样本下无法判定明显优劣）"


def single_snapshot_eval(result, weights, top_n, cost_buy_bps, cost_sell_bps):
    universe = result.get("all", [])
    picked = result.get("picked", [])
    picked_codes = {x.get("code") for x in picked}
    idx_ret_5d = safe_float(result.get("benchmark", {}).get("idx_ret_5d"), 0.0)
    cost_rate = (cost_buy_bps + cost_sell_bps) / 10000.0

    rules_metrics = [x["metrics"] for x in universe if x.get("code") in picked_codes and x.get("metrics")]
    rules_excess = portfolio_excess_5d(rules_metrics, idx_ret_5d, cost_rate)

    scored, covs = [], []
    for x in universe:
        m = x.get("metrics")
        if not m:
            continue
        s, c = compute_lgbm_score(m, weights)
        scored.append((s, m))
        covs.append(c)
    scored.sort(key=lambda t: t[0], reverse=True)
    top_metrics = [m for _, m in scored[:top_n]]
    avg_cov = sum(covs) / len(covs) if covs else 0.0
    lgbm_excess = portfolio_excess_5d(top_metrics, idx_ret_5d, cost_rate)

    return {
        "asof": result.get("asof"), "n_universe": len(universe), "idx_ret_5d": idx_ret_5d,
        "cost_rate": cost_rate, "factor_coverage": avg_cov, "rules_excess": rules_excess,
        "lgbm_excess": lgbm_excess, "rules_n": len(rules_metrics), "lgbm_n": len(top_metrics),
    }


def append_history(path: Path, rec):
    payload = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "asof": rec["asof"],
        "n_universe": rec["n_universe"], "idx_ret_5d": rec["idx_ret_5d"],
        "cost_rate": rec["cost_rate"], "factor_coverage": rec["factor_coverage"],
        "rules": {"excess": rec["rules_excess"], "n_picked": rec["rules_n"]},
        "lgbm": {"excess": rec["lgbm_excess"], "n_picked": rec["lgbm_n"]},
    }
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(payload, ensure_ascii=False) + "\n")


def load_history(path: Path):
    if not path.exists():
        return []
    rows = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            s = line.strip()
            if not s:
                continue
            try:
                rows.append(json.loads(s))
            except Exception:
                pass
    dedup = {}
    for r in rows:
        key = r.get("asof") or r.get("ts")
        if key:
            dedup[key] = r
    return [dedup[k] for k in sorted(dedup.keys())]


def extract_series_from_history(rows):
    rules_xs, lgbm_xs = [], []
    for r in rows:
        rv = safe_float((r.get("rules") or {}).get("excess"))
        lv = safe_float((r.get("lgbm") or {}).get("excess"))
        if rv is None or lv is None:
            continue
        rules_xs.append(rv)
        lgbm_xs.append(lv)
    return rules_xs, lgbm_xs


def main():
    p = argparse.ArgumentParser(description="规则 vs LightGBM 对照评估（含多期历史）")
    p.add_argument("--result_json", default="qscreen_all_a.json")
    p.add_argument("--weights_json", default="策略/final_robust_factor_weights_for_backtest.json")
    p.add_argument("--history_jsonl", default="compare_history.jsonl")
    p.add_argument("--top_n", type=int, default=DEFAULT_TOP_N)
    p.add_argument("--cost_buy_bps", type=float, default=DEFAULT_COST_BUY_BPS)
    p.add_argument("--cost_sell_bps", type=float, default=DEFAULT_COST_SELL_BPS)
    p.add_argument("--append_history", action="store_true", help="追加本次截面到历史")
    p.add_argument("--history_only", action="store_true", help="仅历史评估，不重算当前截面")
    args = p.parse_args()

    base = Path(__file__).parent
    result_path = base / args.result_json
    weights_path = base / args.weights_json
    history_path = base / args.history_jsonl

    if not args.history_only:
        if not result_path.exists():
            sys.exit(f"找不到结果文件: {result_path}")
        if not weights_path.exists():
            sys.exit(f"找不到权重文件: {weights_path}")
        rec = single_snapshot_eval(load_json(result_path), load_json(weights_path), args.top_n, args.cost_buy_bps, args.cost_sell_bps)
        print(f"当前截面: {rec['asof']}")
        print(f"股票池: {rec['n_universe']} | 成本: {rec['cost_rate']*10000:.1f} bps")
        print(f"规则超额: {pct(rec['rules_excess'])} (入选{rec['rules_n']}只)")
        print(f"LGBM超额: {pct(rec['lgbm_excess'])} (top{args.top_n}, 覆盖{rec['factor_coverage']:.1%})")
        if args.append_history:
            append_history(history_path, rec)
            print(f"已追加到历史: {history_path}")

    rows = load_history(history_path)
    if not rows:
        print("\n未找到历史文件或历史为空。")
        print(f"请先运行: python compare_strategies.py --append_history --history_jsonl {args.history_jsonl}")
        return

    rules_xs, lgbm_xs = extract_series_from_history(rows)
    if not rules_xs:
        print("\n历史存在但无可用配对超额数据。")
        return

    print(f"\n历史样本期数: {len(rules_xs)}  （文件: {history_path.name}）")
    rules_sum = calc_summary(rules_xs)
    lgbm_sum  = calc_summary(lgbm_xs)
    print_summary("规则策略（跨期）", rules_sum)
    print_summary("LightGBM策略（跨期）", lgbm_sum)
    sig = compare_significance(rules_xs, lgbm_xs)
    print_significance(sig)
    verdict = final_verdict_multi(sig, min_periods=20)
    print("\n最终判定:", verdict)

    if not args.history_only and len(rules_xs) >= 1:
        chart_path = base / "compare_chart.png"
        plot_comparison(rules_xs, lgbm_xs, chart_path)
        print(f"图表已保存: {chart_path}")


# ═══════════════════════════════════════════════════════
# 图表输出
# ═══════════════════════════════════════════════════════

def plot_comparison(rules_xs, lgbm_xs, out_path: Path):
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        import matplotlib.gridspec as gridspec
    except ImportError:
        print("[图表] matplotlib 未安装，跳过图表输出（pip install matplotlib）")
        return

    for _fn in ["SimHei", "Microsoft YaHei", "SimSun"]:
        try:
            plt.rcParams["font.family"] = [_fn]
            plt.rcParams["axes.unicode_minus"] = False
            break
        except Exception:
            continue

    xs = list(range(1, len(rules_xs) + 1))

    # ── 计算累计净值 ──────────────────────────────────────
    def nav_series(excess_list):
        nav, navs = 1.0, []
        for x in excess_list:
            nav *= (1 + x)
            navs.append(nav)
        return navs

    def dd_series(navs):
        peak, dds = navs[0], []
        for v in navs:
            peak = max(peak, v)
            dds.append((peak - v) / peak if peak > 0 else 0)
        return dds

    r_nav = nav_series(rules_xs)
    l_nav = nav_series(lgbm_xs)
    r_dd  = dd_series(r_nav)
    l_dd  = dd_series(l_nav)
    diffs = [r - l for r, l in zip(rules_xs, lgbm_xs)]

    # ── 绘图 ─────────────────────────────────────────────
    fig = plt.figure(figsize=(12, 10), facecolor="#0d1117")
    gs  = gridspec.GridSpec(3, 1, hspace=0.45, figure=fig)

    COLORS = {"rules": "#58a6ff", "lgbm": "#f78166", "diff_pos": "#3fb950", "diff_neg": "#f85149"}
    STYLE  = {"axes.facecolor": "#161b22", "axes.edgecolor": "#30363d",
               "axes.labelcolor": "#8b949e", "xtick.color": "#8b949e", "ytick.color": "#8b949e",
               "text.color": "#e6edf3", "grid.color": "#30363d", "grid.linestyle": "--",
               "grid.alpha": 0.5}
    plt.rcParams.update(STYLE)

    # 1) 累计净值曲线
    ax1 = fig.add_subplot(gs[0])
    ax1.plot(xs, r_nav, color=COLORS["rules"], linewidth=2, label="规则策略")
    ax1.plot(xs, l_nav, color=COLORS["lgbm"],  linewidth=2, label="LightGBM策略", linestyle="--")
    ax1.axhline(1.0, color="#30363d", linewidth=1)
    ax1.set_title("累计超额净值曲线", fontsize=12, pad=8)
    ax1.set_ylabel("净值")
    ax1.legend(loc="upper left", framealpha=0.3)
    ax1.grid(True)

    # 2) 回撤曲线
    ax2 = fig.add_subplot(gs[1])
    ax2.fill_between(xs, [-d for d in r_dd], 0, color=COLORS["rules"], alpha=0.4, label="规则策略回撤")
    ax2.fill_between(xs, [-d for d in l_dd], 0, color=COLORS["lgbm"],  alpha=0.3, label="LightGBM回撤")
    ax2.plot(xs, [-d for d in r_dd], color=COLORS["rules"], linewidth=1.5)
    ax2.plot(xs, [-d for d in l_dd], color=COLORS["lgbm"],  linewidth=1.5, linestyle="--")
    ax2.set_title("超额净值回撤", fontsize=12, pad=8)
    ax2.set_ylabel("回撤")
    ax2.yaxis.set_major_formatter(plt.FuncFormatter(lambda y, _: f"{abs(y)*100:.1f}%"))
    ax2.legend(loc="lower left", framealpha=0.3)
    ax2.grid(True)

    # 3) 单期差值分布（规则 - LightGBM）
    ax3 = fig.add_subplot(gs[2])
    colors = [COLORS["diff_pos"] if d >= 0 else COLORS["diff_neg"] for d in diffs]
    ax3.bar(xs, [d * 100 for d in diffs], color=colors, alpha=0.85, width=0.7)
    ax3.axhline(0, color="#30363d", linewidth=1)
    mean_diff = sum(diffs) / len(diffs)
    ax3.axhline(mean_diff * 100, color="#e3b341", linewidth=1.5, linestyle=":",
                label=f"均值 {mean_diff*100:.2f}%")
    ax3.set_title("单期超额差值（规则 - LightGBM）", fontsize=12, pad=8)
    ax3.set_ylabel("差值 (%)")
    ax3.set_xlabel("调仓期")
    ax3.legend(loc="upper right", framealpha=0.3)
    ax3.grid(True)

    fig.suptitle("策略对照评估报告", fontsize=14, y=0.98, color="#e6edf3")
    plt.savefig(out_path, dpi=150, bbox_inches="tight", facecolor=fig.get_facecolor())
    plt.close(fig)


if __name__ == "__main__":
    main()
