把日K线数据按 “每个代码一个CSV” 放到这个文件夹，就可以离线跑筛选：

- 文件名：<6位代码>.csv
- 编码：UTF-8
- 每行格式（逗号分隔）：
  date,open,close,high,low,volume,amount
，
示例：
2026-03-18,10.00,10.30,10.50,9.90,1234567,987654321

至少需要：
- 000985.csv（中证全指基准）
- 以及你要筛选的每只股票的 CSV

运行示例：
node ..\qscreen.mjs --rules "..\量化筛选限制.txt" --codesFile "..\codes.sample.txt" --klineDir "."
 