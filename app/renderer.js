let isRunning=false;
let paramsInitialized=false;
window._progressCurrent=0;
window._progressTotal=0;
window._progressPassed=0;
window._progressRafId=null;
function _updateProgressBar(){
  const pbWrap=document.getElementById('progress-bar-wrap');
  const pbFill=document.getElementById('progress-fill');
  const pbLabel=document.getElementById('progress-label');
  const pbPct=document.getElementById('progress-pct');
  const pbSub=document.getElementById('progress-sub');
  if(!pbWrap||window._progressTotal===0)return;
  pbWrap.style.display='block';
  const pct=Math.round(window._progressCurrent/window._progressTotal*100);
  pbFill.style.width=pct+'%';
  pbPct.textContent=pct+'%';
  pbLabel.textContent='筛选进度 '+window._progressCurrent+'/'+window._progressTotal;
  pbSub.textContent='已通过筛选: '+window._progressPassed+' 只';
  setDotState('running',window._progressCurrent+'/'+window._progressTotal+' ('+pct+'%)');
}
const PRESETS={
  strict:{beat_benchmark_threshold:0.015,up_days_10d_min:6,adv5_vol_ratio_min:1.10,adv5_vol_ratio_max:1.80,above_ma20:true,min_score:4,min_grade:'A'},
  normal:{beat_benchmark_threshold:0.0,up_days_10d_min:5,adv5_vol_ratio_min:0.90,adv5_vol_ratio_max:2.50,above_ma20:true,min_score:2,min_grade:'A'},
  loose:{beat_benchmark_threshold:-0.01,up_days_10d_min:4,adv5_vol_ratio_min:0.80,adv5_vol_ratio_max:3.00,above_ma20:false,min_score:1,min_grade:'B'},
};
function fmtAmt(v){const n=Number(v);if(!isFinite(n)||!v)return'--';if(n>=1e8)return(n/1e8).toFixed(2)+'亿';if(n>=1e4)return(n/1e4).toFixed(0)+'万';return n.toFixed(0);}
// HTML 转义：所有外部数据（股票名/行业/代码等）在拼入 innerHTML 前必须经过此函数
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
function switchTab(name){
  ['results','log','summary'].forEach(t=>{
    const btn=document.getElementById('tab-btn-'+t);
    const cont=document.getElementById('tab-'+t);
    if(btn)btn.classList.toggle('active',t===name);
    if(cont)cont.classList.toggle('active',t===name);
  });
  // 切到结果页且窗口可见时，立即刷新一次实时报价（避免在低频哨兵期等待）
  if(name==='results'&&document.visibilityState!=='hidden'&&window._pickedCodes&&window._pickedCodes.length){
    fetchLiveQuotes();
  }
}
function syncUI(){
  const bm=parseFloat(document.getElementById('r-benchmark').value);
  const ud=parseInt(document.getElementById('r-updays').value);
  const vm=parseFloat(document.getElementById('r-volmin').value);
  const vx=parseFloat(document.getElementById('r-volmax').value);
  const sc=parseInt(document.getElementById('r-score').value);
  document.getElementById('v-benchmark').textContent=(bm>=0?'+':'')+bm+'%';
  document.getElementById('v-updays').textContent=ud+'天';
  document.getElementById('v-volmin').textContent=vm.toFixed(2);
  document.getElementById('v-volmax').textContent=vx.toFixed(2);
  document.getElementById('v-score').textContent=sc+'分';
  ['strict','normal','loose'].forEach(k=>{
    const p=PRESETS[k];
    const match=Math.abs(p.beat_benchmark_threshold-(bm/100))<0.001&&p.up_days_10d_min===ud&&Math.abs(p.adv5_vol_ratio_min-vm)<0.01&&Math.abs(p.adv5_vol_ratio_max-vx)<0.01&&p.min_score===sc;
    document.getElementById('mode-'+k).classList.toggle('active',match);
  });
}
function applyPreset(key){
  const p=PRESETS[key];
  document.getElementById('r-benchmark').value=p.beat_benchmark_threshold*100;
  document.getElementById('r-updays').value=p.up_days_10d_min;
  document.getElementById('r-volmin').value=p.adv5_vol_ratio_min;
  document.getElementById('r-volmax').value=p.adv5_vol_ratio_max;
  document.getElementById('r-score').value=p.min_score;
  document.getElementById('t-ma20').checked=p.above_ma20;
  document.getElementById('s-grade').value=p.min_grade;
  ['strict','normal','loose'].forEach(k=>document.getElementById('mode-'+k).classList.toggle('active',k===key));
  syncUI();
}
function loadParams(p){
  document.getElementById('r-benchmark').value=(p.beat_benchmark_threshold||0)*100;
  document.getElementById('r-updays').value=p.up_days_10d_min||4;
  document.getElementById('r-volmin').value=p.adv5_vol_ratio_min||0.8;
  document.getElementById('r-volmax').value=p.adv5_vol_ratio_max||3.0;
  document.getElementById('r-score').value=p.min_score||1;
  document.getElementById('t-ma20').checked=!!p.above_ma20;
  document.getElementById('s-grade').value=p.min_grade||'B';
  syncUI();
}

function fmtMs(v){
  const n=Number(v);
  if(!Number.isFinite(n)||n<0)return'--';
  if(n<1000)return n.toFixed(0)+'ms';
  return (n/1000).toFixed(2)+'s';
}
function fmtPct01(v){
  const n=Number(v);
  if(!Number.isFinite(n))return'--';
  return (n*100).toFixed(1)+'%';
}
function renderPipelineMeta(pm){
  const stageEl=document.getElementById('pm-stage');
  const elapsedEl=document.getElementById('pm-elapsed');
  const countsEl=document.getElementById('pm-counts');
  const cacheEl=document.getElementById('pm-cache');
  const timingEl=document.getElementById('pm-timing');
  if(!stageEl||!elapsedEl||!countsEl||!cacheEl||!timingEl)return;
  if(!pm){
    stageEl.textContent='--';
    elapsedEl.textContent='--';
    countsEl.textContent='--';
    cacheEl.textContent='--';
    timingEl.textContent='--';
    return;
  }
  stageEl.textContent=pm.stage||'--';
  elapsedEl.textContent=fmtMs(pm.elapsed_ms);
  countsEl.textContent=''+
    (pm.fast_pool_count??'--')+'/'+
    (pm.ranked_candidates_count??'--')+'/'+
    (pm.top_candidates_count??'--')+'/'+
    (pm.llm_advice_count??'--')+'/'+
    (pm.picked_count??'--');

  const ch=pm.cache_hit||{};
  cacheEl.textContent=''+fmtPct01(ch.kline)+' / '+fmtPct01(ch.valuation)+' / '+fmtPct01(ch.roe);

  const tm=pm.timing_ms||{};
  timingEl.textContent=''+
    fmtMs(tm.universe)+' / '+
    fmtMs(tm.pass1_fast)+' / '+
    fmtMs(tm.valuation_enrich)+' / '+
    fmtMs(tm.pass2_rank)+' / '+
    fmtMs(tm.llm_arbitration)+' / '+
    fmtMs(tm.portfolio_action);
}
async function saveParams(){
  const params={beat_benchmark_threshold:parseFloat(document.getElementById('r-benchmark').value)/100,up_days_10d_min:parseInt(document.getElementById('r-updays').value),adv5_vol_ratio_min:parseFloat(document.getElementById('r-volmin').value),adv5_vol_ratio_max:parseFloat(document.getElementById('r-volmax').value),above_ma20:document.getElementById('t-ma20').checked,min_score:parseInt(document.getElementById('r-score').value),min_grade:document.getElementById('s-grade').value};
  const hint=document.getElementById('save-hint');
  hint.textContent='';
  setDotState('saving','写入参数...');
  // 黄灯至少显示 800ms
  const [res] = await Promise.all([
    window.api.saveParams(params),
    new Promise(r=>setTimeout(r,800))
  ]);
  if(res.ok){
    hint.textContent='✓ 参数已写入规则文件，可开始筛选';
    hint.style.color='var(--green)';
    setDotState('done','参数已保存');
    setTimeout(()=>setDotState('idle','空闲'),3000);
  } else {
    hint.textContent='✗ 保存失败: '+res.error;
    hint.style.color='var(--red)';
    setDotState('idle','空闲');
  }
  setTimeout(()=>{hint.textContent='';},4000);
}
async function refreshStatus(){
  const s=await window.api.getStatus();
  document.getElementById('s-count').textContent=s.codesCount?s.codesCount+' 只':'--';
  document.getElementById('s-mtime').textContent=s.codesMtime||'--';
  document.getElementById('s-picked').textContent=s.picked.length?s.picked.length+' 只':'--';
  document.getElementById('header-meta').textContent='股票池 '+(s.codesCount||'--')+' 只';
  document.getElementById('badge-results').textContent=s.picked.length||0;
  renderPipelineMeta(s.pipelineMeta||null);
  if(s.picked.length>0)(window.renderResults||renderResults)(s.picked,s.summary);
  // 参数由 initParams() 单独处理，refreshStatus 不再覆盖
  document.getElementById('bottom-time').textContent=new Date().toLocaleString('zh-CN');
}
function renderResults(picked,summary){
  document.getElementById('results-empty').style.display='none';
  document.getElementById('results-content').style.display='block';
  const asof=summary?(summary.match(/时间: (.+)/)||['',''])[1]:'';
  const bench=summary?(summary.match(/基准: (.+)/)||['',''])[1]:'';
  document.getElementById('result-meta').innerHTML='<div class=chip>入选 <b>'+esc(picked.length)+'</b> 只</div>'+(asof?'<div class=chip>'+esc(asof)+'</div>':'')+(bench?'<div class="chip green"><b>'+esc(bench)+'</b></div>':'');
  document.getElementById('results-tbody').innerHTML=picked.map((x,i)=>{
    const score=Number(x.score)||0;
    const ex=((Number(x.metrics&&x.metrics.ret_5d||0)-Number(x.metrics&&x.metrics.idx_ret_5d||0))*100);
    const exStr=ex>=0?'<span class=up style="color:var(--red)">+'+ex.toFixed(2)+'%</span>':'<span class=dn style="color:var(--green)">'+ex.toFixed(2)+'%</span>';
    const industry=(x.metrics&&x.metrics.industry_l2)||(x.metrics&&x.metrics.industry_l1)||'--';
    const industryL1=(x.metrics&&x.metrics.industry_l1)||'';
    const industryTitle=industryL1&&industryL1!==industry?industryL1+' > '+industry:industry;
    // 外部字段统一转义（名称/行业/代码/评级），防 XSS
    const code=esc(x.code);
    const name=esc(x.name||'--');
    const grade=esc(x.grade||'');
    const industryE=esc(industry);
    const industryTitleE=esc(industryTitle);
    const priceRaw=window._liveQuotes&&window._liveQuotes[x.code];
    const price=priceRaw?priceRaw.price:(x.metrics&&x.metrics.close)||0;
    const pct=priceRaw?priceRaw.pct:Number((x.metrics&&x.metrics.pct_1d) ?? NaN);
    const priceStr=price>0?price.toFixed(2):'--';
    const isFlat=Number.isFinite(pct)&&Math.abs(pct)<1e-8;
    const pctStr=Number.isFinite(pct)
      ? (isFlat
          ? '<span style="color:var(--text2)">0.00%</span>'
          : (pct>0
              ? '<span class=up style="color:var(--red)">▲'+Math.abs(pct*100).toFixed(2)+'%</span>'
              : '<span class=dn style="color:var(--green)">▼'+Math.abs(pct*100).toFixed(2)+'%</span>'))
      : '--';
    const priceCell='<span class="price-cell"'+( Number.isFinite(pct)?(isFlat?' style="color:var(--text2)"':(pct>0?' style="color:var(--red)"':' style="color:var(--green)"')):'' )+' data-code="'+code+'">'+priceStr+'</span> <span class="'+(Number.isFinite(pct)?(isFlat?'':(pct>0?'up':'dn')):'')+'">'+pctStr+'</span>';
    const cl=x.metrics&&x.metrics.close;const ma=x.metrics&&x.metrics.MA20;
    const maStr=(!cl||!ma)?'--':(cl>ma?'<span class=up>✓</span>':'<span class=dn>✗</span>');
    const adv=x.metrics&&x.metrics.ADV5_amount;const n=Number(adv);let amtStr='--';
    if(isFinite(n)&&n){if(n>=1e8)amtStr=(n/1e8).toFixed(2)+'亿';else if(n>=1e4)amtStr=(n/1e4).toFixed(0)+'万';else amtStr=n.toFixed(0);}
    return '<tr><td style="color:var(--text3);font-size:11px">'+(i+1)+'</td><td><span class=code-cell>'+code+'</span></td><td>'+name+'</td><td><span class="grade-badge '+grade+'">'+grade+'</span></td><td><div class=score-wrap>'+score.toFixed(1)+'<div class=score-track><div class=score-fill style="width:'+Math.min(100,score/8*100)+'%"></div></div></div></td><td>'+priceCell+'</td><td>'+exStr+'</td><td>'+amtStr+'</td><td>'+maStr+'</td><td><span class=industry-tag title="'+industryTitleE+'">'+industryE+'</span></td></tr>';
  }).join('');
}
function appendLog(text){
  const wrap=document.getElementById('log-wrap');
  const t=(text||'').toLowerCase();let cls='info';
  if(t.includes('完成')||t.includes('success')||t.includes('✅'))cls='success';
  else if(t.includes('失败')||t.includes('error')||t.includes('[stderr]'))cls='error';
  else if(t.includes('warn')||t.includes('警告'))cls='warn';
  else if(t.startsWith('  ')||t.includes('...'))cls='dim';
  const line=document.createElement('div');line.className='log-line '+cls;line.textContent=String(text).trimEnd();wrap.appendChild(line);wrap.scrollTop=wrap.scrollHeight;
}
function setDotState(state, label){
  const dot=document.getElementById('dot');
  const ts=document.getElementById('task-status');
  dot.className='dot'+(state?' '+state:'');
  const labels={saving:'写入参数...',running:label||'筛选运行中',done:'筛选完成',idle:'空闲'};
  ts.textContent=labels[state]||label||state;
}
function setRunning(running,label){
  isRunning=running;
  ['btn-screen','btn-screen-full','btn-update'].forEach(id=>document.getElementById(id).classList.toggle('disabled',running));
  document.getElementById('btn-cancel').classList.toggle('disabled',!running);
  if(running){
    setDotState('running',label);
    // 超时保护：30分钟后强制重置
    if(window._runningTimeout)clearTimeout(window._runningTimeout);
    window._runningTimeout=setTimeout(()=>{if(isRunning){isRunning=false;setRunning(false);}},30*60*1000);
  } else {
    if(window._runningTimeout){clearTimeout(window._runningTimeout);window._runningTimeout=null;}
    setDotState('done','筛选完成');
    setTimeout(()=>setDotState('idle','空闲'),4000);
  }
}
function bindTask(logCh,doneCh,label){
  ['update-codes','run-screen','run-screen-full'].forEach(ch=>{window.api.removeAllListeners(ch+'-log');window.api.removeAllListeners(ch+'-done');});
  // 重置进度
  window._progressCurrent=0;window._progressTotal=0;window._progressPassed=0;
  const pbWrap=document.getElementById('progress-bar-wrap');
  const pbFill=document.getElementById('progress-fill');
  const pbPct=document.getElementById('progress-pct');
  const pbSub=document.getElementById('progress-sub');
  if(pbWrap){pbWrap.style.display='block';}
  if(pbFill){pbFill.style.width='0%';pbFill.style.background='var(--red)';}
  if(pbPct)pbPct.textContent='0%';
  if(pbSub)pbSub.textContent='准备中...';
  setRunning(true,label);switchTab('log');appendLog('▶ '+label);appendLog('─'.repeat(48));
  // 启动定时刷新进度条（每300ms）
  if(window._progressRafId)clearInterval(window._progressRafId);
  window._progressRafId=setInterval(_updateProgressBar,300);
  window.api.onLog(logCh,d=>{
    const s=String(d).trim();
    // 过滤进度行，不加入日志显示
    const m=s.match(/筛选进度:\s*(\d+)\/(\d+)\s*\((\d+)%\)\s*已通过:\s*(\d+)/);
    if(m){
      window._progressCurrent=parseInt(m[1]);
      window._progressTotal=parseInt(m[2]);
      window._progressPassed=parseInt(m[4]);
    } else {
      appendLog(d);
      if(s.includes('批次')){
        const m2=s.match(/批次\s*(\d+)\/(\d+)/);
        if(m2)setDotState('running','获取K线 '+m2[1]+'/'+m2[2]);
      }
    }
  });
  window.api.onDone(doneCh,async data=>{
    clearInterval(window._progressRafId);window._progressRafId=null;
    appendLog('─'.repeat(48));
    if(data&&data.error) appendLog('[stderr] '+data.error);
    appendLog(data.code===0?'✅ 完成':'✗ 异常 code='+data.code);
    if(pbFill&&data.code===0){pbFill.style.width='100%';pbFill.style.background='var(--green)';if(pbPct)pbPct.textContent='100%';}
    setTimeout(()=>{if(pbWrap)pbWrap.style.display='none';if(pbFill)pbFill.style.background='var(--red)';},4000);
    setRunning(false);
    if(data.code===0){await refreshStatus();setTimeout(()=>switchTab('results'),600);}
  });
}
function runScreen(){if(isRunning)return;bindTask('run-screen-log','run-screen-done','全市场筛选');window.api.runScreen();}
function runScreenFull(){if(isRunning)return;bindTask('run-screen-full-log','run-screen-full-done','更新股票池+筛选');window.api.runScreenFull();}
function updateCodes(){if(isRunning)return;bindTask('update-codes-log','update-codes-done','更新全A股股票池');window.api.updateCodes();}
function cancelTask(){window.api.cancelTask();appendLog('■ 用户取消');setRunning(false);}
async function openResultFile(){const res=await window.api.openResult();if(!res.ok){appendLog('✗ '+res.error);switchTab('log');}}
async function viewSummaryInApp(){
  const res=await window.api.readSummary();
  const empty=document.getElementById('summary-empty');
  const content=document.getElementById('summary-content');
  if(!res.ok||!res.content){empty.style.display='flex';content.style.display='none';}else{empty.style.display='none';content.style.display='block';content.textContent=res.content;}
  switchTab('summary');
}
async function initParams(){
  // 只在启动时调用一次，从后端读取上次保存的参数
  const s = await window.api.getStatus();
  if(s.params) loadParams(s.params);
  // 无论如何都要调用一次syncUI确保显示正确
  syncUI();
}
// 实时指数行情
async function fetchIndexQuote(){
  const indices=[
    {id:'sh',code:'s_sh000001'},
    {id:'sz',code:'s_sz399001'},
  ];
  try{
    const res=await window.api.fetchIndexQuote();
    if(!res.ok)return;
    const txt=res.data;
    for(const idx of indices){
      const m=txt.match(new RegExp('hq_str_'+idx.code+'="([^"]+)"'));
      if(!m)continue;
      const parts=m[1].split(',');
      const price=parseFloat(parts[1]);
      const chg=parseFloat(parts[2]);
      const pct=parseFloat(parts[3]);
      if(!Number.isFinite(price))continue;
      const up=chg>0;
      const flat=Math.abs(chg)<1e-8;
      const cls=flat?'':(up?'up':'down');
      const sign=up?'+':'';
      const priceEl=document.getElementById('idx-'+idx.id+'-price');
      const pctEl=document.getElementById('idx-'+idx.id+'-pct');
      const chgEl=document.getElementById('idx-'+idx.id+'-chg');
      const card=document.getElementById('idx-'+idx.id);
      if(priceEl){priceEl.textContent=price.toFixed(2);priceEl.className='idx-price '+cls;priceEl.style.color=flat?'var(--text2)':(up?'var(--red)':'var(--green)');}
      if(pctEl){pctEl.textContent=(flat?'0.00%':(sign+pct.toFixed(2)+'%'));pctEl.className='idx-pct '+cls;pctEl.style.color=flat?'var(--text2)':(up?'var(--red)':'var(--green)');}
      if(chgEl){chgEl.textContent=(flat?'0.00':(sign+chg.toFixed(2)));chgEl.className='idx-chg '+cls;chgEl.style.color=flat?'var(--text2)':(up?'var(--red)':'var(--green)');}
      if(card)card.className='index-item '+(up?'up':'down');
    }
    const t=document.getElementById('idx-update-time');
    if(t){const now=new Date();t.textContent='更新 '+now.getHours().toString().padStart(2,'0')+':'+now.getMinutes().toString().padStart(2,'0')+':'+now.getSeconds().toString().padStart(2,'0');}
  }catch(e){}
}
// 交易时间内每6秒刷新，非交易时间每5分钟刷新；窗口隐藏时完全暂停，恢复可见时立即刷新
let _idxTimer=null;
function scheduleIndexFetch(){
  fetchIndexQuote();
  const now=new Date();
  const h=now.getHours(),mi=now.getMinutes();
  const inTrade=(h===9&&mi>=25)||(h>=10&&h<14)||(h===14&&mi<=59)||(h===15&&mi===0);
  _idxTimer=setTimeout(scheduleIndexFetch,inTrade?6000:300000);
}

// 实时股价刷新
window._liveQuotes = {};
window._pickedCodes = [];
function isTradingTime(){
  const now=new Date();
  const h=now.getHours(),mi=now.getMinutes(),d=now.getDay();
  if(d===0||d===6)return false;
  return (h===9&&mi>=30)||(h>=10&&h<11)||(h===11&&mi<=30)||(h>=13&&h<14)||(h===14)||(h===15&&mi===0);
}
async function fetchLiveQuotes(){
  if(!window._pickedCodes.length)return;
  try{
    const res=await window.api.fetchStockQuotes(window._pickedCodes);
    if(!res.ok||!res.quotes)return;
    window._liveQuotes=res.quotes;
    // 更新已渲染的行（用 getAttribute 取解码后的原始 code 匹配，兼容转义后的 data-code 属性）
    for(const [code,q] of Object.entries(res.quotes)){
      let el=null;
      const cells=document.querySelectorAll('.price-cell');
      for(let i=0;i<cells.length;i++){
        if(cells[i].getAttribute('data-code')===code){el=cells[i];break;}
      }
      if(!el)continue;
      el.textContent=q.price>0?q.price.toFixed(2):'--';
      const isFlat=Math.abs(q.pct)<1e-8;
      el.style.color=isFlat?'var(--text2)':(q.pct>0?'var(--red)':'var(--green)');
      const pctEl=el.nextElementSibling;
      if(pctEl){
        pctEl.textContent=isFlat?'0.00%':((q.pct>0?'▲':'▼')+Math.abs(q.pct*100).toFixed(2)+'%');
        pctEl.className=isFlat?'':(q.pct>0?'up':'dn');
        pctEl.style.color=isFlat?'var(--text2)':'';
      }
    }
    const t=document.getElementById('idx-update-time');
    if(t){const now=new Date();t.textContent='更新 '+now.getHours().toString().padStart(2,'0')+':'+now.getMinutes().toString().padStart(2,'0')+':'+now.getSeconds().toString().padStart(2,'0');}
  }catch(e){}
}
function isResultsTabActive(){
  const cont=document.getElementById('tab-results');
  return !!cont&&cont.classList.contains('active');
}
let _liveTimer=null;
function scheduleLiveQuotes(){
  fetchLiveQuotes();
  // 结果页未激活或无候选时降频到5分钟哨兵（报价只显示在结果表格，避免无效请求）
  const fast=isResultsTabActive()&&isTradingTime()&&window._pickedCodes.length>0;
  _liveTimer=setTimeout(scheduleLiveQuotes,fast?30000:300000);
}
function pauseTimers(){
  if(_idxTimer){clearTimeout(_idxTimer);_idxTimer=null;}
  if(_liveTimer){clearTimeout(_liveTimer);_liveTimer=null;}
}
function resumeTimers(){
  pauseTimers();
  scheduleIndexFetch();
  scheduleLiveQuotes();
}
// 窗口隐藏时完全暂停定时请求（减少无效请求与主进程 IPC 压力），恢复可见时立即刷新并重新排程
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='hidden')pauseTimers();
  else resumeTimers();
});
scheduleIndexFetch();
scheduleLiveQuotes();

// renderResults 完成后记录 pickedCodes
const _origRenderResults=renderResults;
window.renderResults=function(picked,summary){
  _origRenderResults(picked,summary);
  window._pickedCodes=(picked||[]).map(x=>x.code).filter(Boolean);
  if(isTradingTime())fetchLiveQuotes();
};

initParams();
refreshStatus();
setInterval(()=>{document.getElementById('bottom-time').textContent=new Date().toLocaleString('zh-CN');},1000);

// 事件绑定：CSP 已收紧（script-src 'self'，无 unsafe-inline），全部改为 addEventListener
function bindUI(){
  const on=(id,ev,fn)=>{const el=document.getElementById(id);if(el)el.addEventListener(ev,fn);};
  on('btn-screen','click',runScreen);
  on('btn-screen-full','click',runScreenFull);
  on('btn-update','click',updateCodes);
  on('btn-cancel','click',cancelTask);
  on('mode-strict','click',()=>applyPreset('strict'));
  on('mode-normal','click',()=>applyPreset('normal'));
  on('mode-loose','click',()=>applyPreset('loose'));
  on('r-benchmark','input',syncUI);
  on('r-updays','input',syncUI);
  on('r-volmin','input',syncUI);
  on('r-volmax','input',syncUI);
  on('r-score','input',syncUI);
  on('t-ma20','change',syncUI);
  on('s-grade','change',syncUI);
  on('apply-btn','click',saveParams);
  on('tab-btn-results','click',()=>switchTab('results'));
  on('tab-btn-log','click',()=>switchTab('log'));
  on('tab-btn-summary','click',()=>switchTab('summary'));
  on('btn-open-result','click',openResultFile);
  on('btn-view-summary','click',viewSummaryInApp);
}
bindUI();
