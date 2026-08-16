// 右侧详情面板：状态管理、渲染与请求防串（requestId / 缓存）
(function () {
  'use strict';
  const DETAIL_TTL = 15 * 1000;  // 与主进程 detail 缓存一致
  const KLINE_TTL = 5 * 60 * 1000;

  const state = {
    selectedCode: null,
    visible: false,
    activeTab: 'day',
    loading: false,
    requestId: 0,
    detailCache: new Map(),   // code -> { at, res }
    klineCache: new Map(),    // code+period -> { at, res }
  };

  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

  function fmtAmt(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || !n) return '--';
    if (n >= 1e8) return (n / 1e8).toFixed(2) + '亿';
    if (n >= 1e4) return (n / 1e4).toFixed(1) + '万';
    return n.toFixed(0);
  }

  function showState(kind, msg) {
    $('dp-loading').style.display = kind === 'loading' ? 'flex' : 'none';
    $('dp-error').style.display = kind === 'error' ? 'flex' : 'none';
    $('dp-content').style.display = kind === 'content' ? 'flex' : 'none';
    if (kind === 'error' && msg) $('dp-error-msg').textContent = msg;
  }

  function init() {
    $('dp-close').addEventListener('click', close);
    $('dp-error-msg').parentElement.addEventListener('click', () => {
      if (state.selectedCode) open(state.selectedCode);
    });
    document.querySelectorAll('.dp-tab').forEach(btn => {
      btn.addEventListener('click', () => setTab(btn.dataset.period));
    });
    // 面板宽度有 transition，展开动画结束后按最终宽度重绘图表
    $('detail-panel').addEventListener('transitionend', () => {
      if (state.visible) drawChart();
    });
    // 图表空态点击重试
    $('dp-chart-empty').addEventListener('click', () => {
      if (state.selectedCode) loadKline(state.selectedCode, state.activeTab);
    });
    // 面板宽度有 transition，resize 时延后重绘，避免拿到过渡中的宽度
    let rT = null;
    window.addEventListener('resize', () => {
      if (!state.visible) return;
      clearTimeout(rT);
      rT = setTimeout(() => drawChart(), 260);
    });
  }

  function open(code) {
    if (!code) return;
    state.selectedCode = code;
    state.visible = true;
    const panel = $('detail-panel');
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    showState('loading');
    loadDetail(code);
  }

  function close() {
    state.visible = false;
    state.selectedCode = null;
    state.requestId++; // 作废进行中的请求
    const panel = $('detail-panel');
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
    document.querySelectorAll('#results-tbody tr.selected').forEach(tr => tr.classList.remove('selected'));
  }

  function getSelectedCode() {
    return state.selectedCode;
  }

  function setTab(period) {
    if (state.activeTab === period) return;
    state.activeTab = period;
    document.querySelectorAll('.dp-tab').forEach(btn => {
      const on = btn.dataset.period === period;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (state.visible && state.selectedCode) loadKline(state.selectedCode, period);
  }

  // —— 详情数据 ——
  async function loadDetail(code) {
    const rid = ++state.requestId;
    const cached = state.detailCache.get(code);
    if (cached && Date.now() - cached.at < DETAIL_TTL) {
      renderDetail(cached.res);
      return;
    }
    showState('loading');
    let res;
    try {
      res = await window.api.fetchStockDetail(code);
    } catch (e) {
      res = { ok: false, error: e.message };
    }
    if (rid !== state.requestId || !state.visible) return; // 旧请求或已关闭
    if (!res.ok) {
      showState('error', res.error || '加载失败');
      return;
    }
    state.detailCache.set(code, { at: Date.now(), res });
    renderDetail(res);
  }

  function renderDetail(res) {
    const { stock, quote, decision } = res.data;
    const metrics = stock.metrics || {};
    $('dp-title').textContent = (stock.name || '--') + '  ' + (stock.code || '');
    renderSummary(stock, quote, metrics);
    renderDecision(stock, metrics, decision);
    renderReasons(stock, metrics);
    showState('content');
    loadKline(stock.code, state.activeTab);
  }

  function renderSummary(stock, quote, metrics) {
    const priceRaw = quote && quote.price > 0 ? quote.price : (Number(metrics.close) || 0);
    const pctRaw = quote && quote.price > 0
      ? quote.pct
      : (Number.isFinite(Number(metrics.pct_1d)) ? Number(metrics.pct_1d) : null);
    const isFlat = pctRaw != null && Math.abs(pctRaw) < 1e-8;
    const dir = pctRaw == null ? 'flat' : (isFlat ? 'flat' : (pctRaw > 0 ? 'up' : 'dn'));
    const sign = pctRaw != null && pctRaw > 0 ? '+' : '';
    const pctStr = pctRaw == null ? '--' : (isFlat ? '0.00%' : sign + (pctRaw * 100).toFixed(2) + '%');
    const industry = metrics.industry_l2 || metrics.industry_l1 || '--';
    const gradeCls = stock.grade === 'B' ? ' grade-B' : '';
    const score = Number(stock.score) || 0;
    $('dp-summary').innerHTML =
      '<h3 class="dp-sec-title">概览</h3>' +
      '<div class="dp-summary-main">' +
        '<span class="dp-name">' + esc(stock.name || '--') + '</span>' +
        '<span class="dp-code">' + esc(stock.code || '--') + '</span>' +
      '</div>' +
      '<div class="dp-summary-main" style="margin-top:6px">' +
        '<span class="dp-price ' + dir + '">' + (priceRaw > 0 ? priceRaw.toFixed(2) : '--') + '</span>' +
        '<span class="dp-pct ' + dir + '">' + pctStr + '</span>' +
      '</div>' +
      '<div class="dp-sub">' +
        '<span class="dp-grade' + gradeCls + '">' + esc(stock.grade || '--') + '</span>' +
        '<span class="dp-score">得分 <b>' + score.toFixed(1) + '</b></span>' +
        '<span class="dp-industry">' + esc(industry) + '</span>' +
      '</div>';
  }

  function renderDecision(stock, metrics, decision) {
    const d = decision || {};
    const close = Number(metrics.close) || 0;
    const ma20 = Number(metrics.MA20) || 0;
    const ret5 = Number(metrics.ret_5d) || 0;
    const idx5 = Number(metrics.idx_ret_5d) || 0;
    const adv5 = Number(metrics.ADV5_amount) || 0;

    const okBadge = '<span class="dp-v ok">✓</span>';
    const noBadge = '<span class="dp-v bad">✗</span>';

    const ma20Item = ma20 > 0
      ? (d.aboveMA20 ? okBadge + '<span class="dp-v ok">站上</span>' : noBadge + '<span class="dp-v bad">未站上</span>')
      : '<span class="dp-v sub">--</span>';

    const ex = (Number.isFinite(d.ex) ? d.ex : (ret5 - idx5)) * 100;
    const exItem = Number.isFinite(ex)
      ? (ex > 0
          ? '<span class="dp-v ok">+' + ex.toFixed(2) + '%</span>'
          : '<span class="dp-v bad">' + ex.toFixed(2) + '%</span>')
      : '<span class="dp-v sub">--</span>';

    const volItem = d.volEnough
      ? '<span class="dp-v ok">' + fmtAmt(adv5) + '</span>'
      : '<span class="dp-v warn">' + fmtAmt(adv5) + '</span>';

    const posPct = (d.aboveMa20Pct ?? 0) * 100;
    const posItem = d.priceHigh
      ? '<span class="dp-v warn">+高' + posPct.toFixed(0) + '%</span>'
      : '<span class="dp-v ok">' + (Number.isFinite(posPct) ? (posPct >= 0 ? '+' : '') + posPct.toFixed(1) + '%' : '--') + '</span>';

    const cls = d.conclusion === '继续关注' ? 'green' : (d.conclusion === '等回踩' ? 'yellow' : 'gray');
    $('dp-decision').innerHTML =
      '<h3 class="dp-sec-title">决策摘要</h3>' +
      '<div class="dp-verdict ' + cls + '">' +
        '<span class="dp-v-label">结论</span>' +
        '<span class="dp-v-text">' + esc(d.conclusion || '--') + '</span>' +
        (d.reason ? '<span class="dp-v-reason">' + esc(d.reason) + '</span>' : '') +
      '</div>' +
      '<div class="dp-decision-grid">' +
        '<div class="dp-item"><span class="dp-k">站上MA20</span>' + ma20Item + '</div>' +
        '<div class="dp-item"><span class="dp-k">5日超额</span>' + exItem + '</div>' +
        '<div class="dp-item"><span class="dp-k">量能ADV5</span>' + volItem + '</div>' +
        '<div class="dp-item"><span class="dp-k">价格位置</span>' + posItem + '</div>' +
      '</div>';
  }

  function renderReasons(stock, metrics) {
    const close = Number(metrics.close) || 0;
    const ma20 = Number(metrics.MA20) || 0;
    const ret5 = Number(metrics.ret_5d) || 0;
    const idx5 = Number(metrics.idx_ret_5d) || 0;
    const upDays = Number(metrics.UpDays_10d);
    const adv5 = Number(metrics.ADV5_amount) || 0;
    const pe = Number(metrics.PE_ttm);
    const pb = Number(metrics.PB);
    const peInd = Number(metrics.PE_industry_ttm);

    const ex = (ret5 - idx5) * 100;
    const exCell = Number.isFinite(ex)
      ? (ex > 0 ? '<span class="dp-rv ok">+' + ex.toFixed(2) + '%</span>' : '<span class="dp-rv bad">' + ex.toFixed(2) + '%</span>')
      : '<span class="dp-rv sub">--</span>';

    const maCell = ma20 > 0 && close > 0
      ? (close > ma20 ? '<span class="dp-rv ok">✓ 站上 ' + ma20.toFixed(2) + '</span>' : '<span class="dp-rv bad">✗ 未站上</span>')
      : '<span class="dp-rv sub">--</span>';

    const upCell = Number.isFinite(upDays) ? '<span class="dp-rv ok">' + upDays + ' / 10</span>' : '<span class="dp-rv sub">--</span>';

    const advCell = '<span class="dp-rv sub">' + fmtAmt(adv5) + '</span>';

    let peCell = '<span class="dp-rv sub">--</span>';
    if (Number.isFinite(pe)) {
      if (Number.isFinite(peInd) && peInd > 0) {
        const ratio = pe / peInd;
        const tag = ratio < 0.8 ? '低于行业' : (ratio <= 1.2 ? '接近行业' : '高于行业');
        const cls = ratio < 0.8 ? 'ok' : (ratio > 1.2 ? 'warn' : 'sub');
        peCell = '<span class="dp-rv sub">' + pe.toFixed(1) + '</span><span class="dp-rv ' + cls + '">' + tag + '</span>';
      } else {
        peCell = '<span class="dp-rv sub">' + pe.toFixed(1) + '</span>';
      }
    }

    const pbCell = Number.isFinite(pb) && pb > 0 ? '<span class="dp-rv sub">' + pb.toFixed(2) + '</span>' : '<span class="dp-rv sub">--</span>';

    $('dp-reasons').innerHTML =
      '<h3 class="dp-sec-title">入选原因</h3>' +
      '<div class="dp-reason-grid">' +
        '<div class="dp-reason"><span class="dp-rk">5日超额收益</span>' + exCell + '</div>' +
        '<div class="dp-reason"><span class="dp-rk">MA20 状态</span>' + maCell + '</div>' +
        '<div class="dp-reason"><span class="dp-rk">10日上涨天数</span>' + upCell + '</div>' +
        '<div class="dp-reason"><span class="dp-rk">ADV5 成交额</span>' + advCell + '</div>' +
        '<div class="dp-reason"><span class="dp-rk">PE (TTM)</span>' + peCell + '</div>' +
        '<div class="dp-reason"><span class="dp-rk">PB</span>' + pbCell + '</div>' +
      '</div>';
  }

  // —— K线 ——
  async function loadKline(code, period) {
    const cacheKey = code + ':' + period;
    const cached = state.klineCache.get(cacheKey);
    const rid = ++state.requestId;
    const show = res => {
      if (rid !== state.requestId || !state.visible || state.selectedCode !== code) return;
      if (res.ok && res.data && res.data.rows && res.data.rows.length) {
        state.klineCache.set(cacheKey, { at: Date.now(), res });
        $('dp-chart-empty').style.display = 'none';
        window.DetailChart.render($('dp-chart'), res.data.rows, res.data.period || period);
      } else {
        $('dp-chart-empty').textContent = res?.error || '暂无图表数据，点击重试';
        $('dp-chart-empty').style.display = 'flex';
      }
    };
    if (cached && Date.now() - cached.at < KLINE_TTL) {
      show(cached.res);
      return;
    }
    try {
      const res = await window.api.fetchStockKline({ code, period });
      show(res);
    } catch (e) {
      show({ ok: false, error: e.message });
    }
  }

  function drawChart() {
    if (!state.visible || !state.selectedCode) return;
    const cached = state.klineCache.get(state.selectedCode + ':' + state.activeTab);
    if (cached) window.DetailChart.render($('dp-chart'), cached.res.data.rows, cached.res.data.period || state.activeTab);
  }

  window.DetailPanel = { init, open, close, getSelectedCode, setTab };
})();
