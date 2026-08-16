// common/date.js
// 统一中国时区（Asia/Shanghai）日期格式化。
// 不能用 new Date().toISOString().slice(0,10)：那是 UTC 日期，每天 0:00~8:00（本地）会跨日偏差一天，
// 导致股票池/估值缓存"今日"判定、回测日志 trade_date 与 Python 端 datetime.now()（本地时间）不一致。

function todayCN(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

module.exports = { todayCN };
