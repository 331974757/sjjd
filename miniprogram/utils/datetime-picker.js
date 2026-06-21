/**
 * ============================================================
 * 日期时间多列选择器工具
 * miniprogram/utils/datetime-picker.js
 *
 * 提供纯函数：构建选择器列范围、计算默认索引、处理列滚动、
 * 从索引还原时间戳、生成显示文本。不依赖 Page 上下文，
 * 返回值由调用方自行 setData。
 * ============================================================
 */

/**
 * 构建 multiSelector 的列范围数组
 * [年[], 月[], 日[], 时[], 分[]]
 * @param {Object} opts
 * @param {number} [opts.refYear]  - 起始年份，默认当前年
 * @param {number} [opts.yearSpan] - 年份跨度，默认 3
 * @param {number} [opts.selYear]  - 当前选中年（用于计算日数）
 * @param {number} [opts.selMonth] - 当前选中月 1-12（用于计算日数）
 * @returns {string[][]}
 */
function buildRange({ refYear, yearSpan = 3, selYear, selMonth } = {}) {
  const now = new Date()
  const startYear = refYear || now.getFullYear()
  const years = []
  for (let y = startYear; y <= startYear + yearSpan; y++) years.push(y + '年')

  const months = []
  for (let m = 1; m <= 12; m++) months.push(m + '月')

  const maxDay = new Date(selYear || now.getFullYear(), selMonth || (now.getMonth() + 1), 0).getDate()
  const days = []
  for (let d = 1; d <= maxDay; d++) days.push(d + '日')

  const hours = []
  for (let h = 0; h < 24; h++) hours.push(('0' + h).slice(-2) + '时')

  const minutes = []
  for (let mi = 0; mi < 60; mi += 5) minutes.push(String(mi).padStart(2, '0') + '分')
  return [years, months, days, hours, minutes]
}

/**
 * 从时间戳计算选择器的默认索引（现在时刻）
 * @param {number} [ts] - 毫秒时间戳，不传则用当前时间
 * @param {number} [refYear] - 参考年份（range 第一列起始年）
 * @returns {number[]} [年索引, 月索引, 日索引, 时索引, 分索引]
 */
function buildIndex(ts, refYear) {
  const now = new Date()
  const d = ts ? new Date(ts) : new Date()
  return [
    d.getFullYear() - (refYear || now.getFullYear()),
    d.getMonth(),
    d.getDate() - 1,
    d.getHours(),
    Math.round(d.getMinutes() / 5)
  ]
}

/**
 * 处理列滚动事件 — 当年/月变化时重新计算日数组
 * @param {string[][]} range    - 当前 range
 * @param {number[]}   idx      - 当前索引
 * @param {number}     column   - 变动的列
 * @param {number}     value    - 新列值
 * @returns {{ range: string[][], idx: number[] }}
 */
function onColumnChange(range, idx, column, value) {
  const newIdx = idx.slice()
  newIdx[column] = value

  if (column === 0 || column === 1) {
    const yr = parseInt(range[0][newIdx[0]])
    const mo = parseInt(range[1][newIdx[1]])
    const maxDay = new Date(yr, mo, 0).getDate()
    const days = []
    for (let d = 1; d <= maxDay; d++) days.push(d + '日')
    const newRange = range.slice()
    newRange[2] = days
    if (newIdx[2] >= maxDay) newIdx[2] = maxDay - 1
    return { range: newRange, idx: newIdx }
  }

  return { range, idx: newIdx }
}

/**
 * 从索引转换为毫秒时间戳
 * @param {string[][]} range
 * @param {number[]}   idx
 * @returns {number|null}
 */
function toTimestamp(range, idx) {
  if (!range) return null
  const year = parseInt(range[0][idx[0]])
  const month = parseInt(range[1][idx[1]])
  const day = parseInt(range[2][idx[2]])
  const hour = parseInt(range[3][idx[3]])
  const minute = parseInt(range[4][idx[4]])
  if (isNaN(year) || isNaN(month) || isNaN(day) || isNaN(hour) || isNaN(minute)) return null
  return new Date(year, month - 1, day, hour, minute, 0).getTime()
}

/**
 * 从索引生成显示文本（如 "2026年6月17日 14时30分"）
 * @param {string[][]} range
 * @param {number[]}   idx
 * @returns {string}
 */
function toDisplayText(range, idx) {
  if (!range) return ''
  return range[0][idx[0]] + range[1][idx[1]] + range[2][idx[2]] + ' ' + range[3][idx[3]] + range[4][idx[4]]
}

module.exports = {
  buildRange,
  buildIndex,
  onColumnChange,
  toTimestamp,
  toDisplayText
}
