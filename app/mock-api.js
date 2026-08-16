// 临时预览用 mock（仅浏览器预览，Electron 内不加载）
window.api = {
  getStatus: async () => ({
    ok: true,
    codesCount: 5234,
    codesMtime: '2026-08-16 09:30:00',
    picked: [
      { code: '600519', name: '贵州茅台', grade: 'A', score: 7.2, metrics: { ret_5d: 0.038, idx_ret_5d: 0.012, close: 1688.00, pct_1d: 0.0186, industry_l1: '食品饮料', industry_l2: '白酒', MA20: 1650.00, ADV5_amount: 6.2e9 } },
      { code: '300750', name: '宁德时代', grade: 'A', score: 6.8, metrics: { ret_5d: 0.051, idx_ret_5d: 0.012, close: 218.40, pct_1d: -0.024, industry_l1: '电力设备', industry_l2: '电池', MA20: 222.10, ADV5_amount: 8.4e9 } },
      { code: '601318', name: '中国平安', grade: 'B', score: 4.5, metrics: { ret_5d: 0.016, idx_ret_5d: 0.012, close: 48.20, pct_1d: 0.0104, industry_l1: '非银金融', industry_l2: '保险', MA20: 47.50, ADV5_amount: 3.1e9 } },
      { code: '002594', name: '比亚迪', grade: 'A', score: 6.1, metrics: { ret_5d: 0.042, idx_ret_5d: 0.012, close: 245.30, pct_1d: 0.0321, industry_l1: '汽车', industry_l2: '整车', MA20: 238.00, ADV5_amount: 5.7e9 } },
      { code: '000858', name: '五粮液', grade: 'B', score: 4.1, metrics: { ret_5d: -0.008, idx_ret_5d: 0.012, close: 142.60, pct_1d: -0.007, industry_l1: '食品饮料', industry_l2: '白酒', MA20: 143.80, ADV5_amount: 2.2e9 } },
      { code: '688981', name: '中芯国际', grade: 'A', score: 5.6, metrics: { ret_5d: 0.064, idx_ret_5d: 0.012, close: 52.10, pct_1d: 0.045, industry_l1: '电子', industry_l2: '半导体', MA20: 49.80, ADV5_amount: 4.9e9 } },
      { code: '601899', name: '紫金矿业', grade: 'B', score: 3.8, metrics: { ret_5d: 0.021, idx_ret_5d: 0.012, close: 17.80, pct_1d: 0.0113, industry_l1: '有色金属', industry_l2: '黄金', MA20: 17.40, ADV5_amount: 1.8e9 } },
      { code: '300059', name: '东方财富', grade: 'B', score: 3.2, metrics: { ret_5d: -0.012, idx_ret_5d: 0.012, close: 15.60, pct_1d: -0.019, industry_l1: '非银金融', industry_l2: '证券', MA20: 15.90, ADV5_amount: 2.6e9 } },
    ],
    summary: '时间: 2026-08-16 15:00\n基准: 沪深300 +0.35%',
    pipelineMeta: { stage: '已完成', elapsed_ms: 184000, fast_pool_count: 5234, ranked_candidates_count: 812, top_candidates_count: 40, llm_advice_count: 12, picked_count: 8, cache_hit: { kline: 0.82, valuation: 0.71, roe: 0.66 }, timing_ms: { universe: 4200, pass1_fast: 82000, valuation_enrich: 36000, pass2_rank: 41000, llm_arbitration: 18000, portfolio_action: 2800 } },
    params: { beat_benchmark_threshold: -0.01, up_days_10d_min: 4, adv5_vol_ratio_min: 0.8, adv5_vol_ratio_max: 3.0, above_ma20: false, min_score: 1, min_grade: 'B' },
  }),
  fetchIndexQuote: async () => ({
    ok: true,
    data: 'hq_str_s_sh000001="上证指数,3512.34,12.34,0.35,432100000,523000000000";\nhq_str_s_sz399001="深证成指,10950.21,-45.67,-0.42,512000000,689000000000";',
  }),
  fetchStockQuotes: async (codes) => {
    const quotes = {};
    const base = { '600519': 1688.00, '300750': 218.40, '601318': 48.20, '002594': 245.30, '000858': 142.60, '688981': 52.10, '601899': 17.80, '300059': 15.60 };
    const pct = { '600519': 0.0186, '300750': -0.024, '601318': 0.0104, '002594': 0.0321, '000858': -0.007, '688981': 0.045, '601899': 0.0113, '300059': -0.019 };
    codes.forEach(c => { quotes[c] = { price: base[c] || 10.00, pct: pct[c] || 0 }; });
    return { ok: true, quotes };
  },
  saveParams: async () => ({ ok: true }),
  removeAllListeners: () => {},
  onLog: () => {},
  onDone: () => {},
  runScreen: () => {}, runScreenFull: () => {}, updateCodes: () => {}, cancelTask: () => {},
  openResult: async () => ({ ok: false, error: '预览模式不可用' }),
  readSummary: async () => ({ ok: true, content: '预览摘要：本界面为设计预览。\n真实数据请在 Electron 中运行 npm start。' }),
};
