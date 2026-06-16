// utils/rank-utils.js - 段位计算公共方法

const RANK_OPTIONS = ['先锋', '卫士', '中军', '统帅', '传奇', '万古流芳', '超凡入圣', '冠绝一世']
const RANK_ORDER = ['immortal', 'divine', 'ancient', 'legend', 'archon', 'crusader', 'guardian', 'herald']
const RANK_ICONS = {
  'immortal': '/assets/ranks/immortal.png', 'divine': '/assets/ranks/divine.png',
  'ancient': '/assets/ranks/ancient.png', 'legend': '/assets/ranks/legend.png',
  'archon': '/assets/ranks/archon.png', 'crusader': '/assets/ranks/crusader.png',
  'guardian': '/assets/ranks/guardian.png', 'herald': '/assets/ranks/herald.png'
}
const RANK_ICON_IMAGE_PREFIX = '/assets/'
const RANK_LABELS = {
  'immortal': '冠绝一世', 'divine': '超凡入圣', 'ancient': '万古流芳', 'legend': '传奇',
  'archon': '统帅', 'crusader': '中军', 'guardian': '卫士', 'herald': '先锋'
}
const RANK_COLORS = ['#ff6b6b', '#feca57', '#48dbfb', '#ff9ff3', '#54a0ff', '#5f27cd', '#01a3a4', '#f368e0']

// 计算段位显示标签：传奇2, 万古流芳1, 冠绝一世
function calcRankLabel(rankName, star) {
  if (!rankName) return ''
  return star > 0 ? rankName + star : rankName
}

// 计算段位排序值：idx * 10 + 10 + star（先锋1★=11 ... 冠绝一世=80）
function calcRankSort(rankName, star) {
  const idx = RANK_OPTIONS.indexOf(rankName)
  return idx < 0 ? 0 : idx * 10 + 10 + star
}

// 根据段位名称返回段位层级 key
function getRankTier(title) {
  if (!title) return ''
  if (title.indexOf('冠绝一世') !== -1) return 'immortal'
  if (title.indexOf('超凡入圣') !== -1) return 'divine'
  if (title.indexOf('万古流芳') !== -1) return 'ancient'
  if (title.indexOf('传奇') !== -1) return 'legend'
  if (title.indexOf('统帅') !== -1) return 'archon'
  if (title.indexOf('中军') !== -1) return 'crusader'
  if (title.indexOf('卫士') !== -1) return 'guardian'
  if (title.indexOf('先锋') !== -1) return 'herald'
  return ''
}

// 根据段位名称返回图标
function getRankIcon(title) {
  if (!title) return ''
  const tier = getRankTier(title)
  return RANK_ICONS[tier] || ''
}

// ====== 等效 MMR 计算（对齐服务端 rank-score.js） ======
const EQUIVALENT_MMR = {
  '先锋':     { base: 0,    step: 180 },
  '卫士':     { base: 900,  step: 170 },
  '中军':     { base: 1750, step: 180 },
  '统帅':     { base: 2650, step: 140 },
  '传奇':     { base: 3350, step: 180 },
  '万古流芳': { base: 4250, step: 170 },
  '超凡入圣': { base: 5100, step: 180 },
  '冠绝一世': { base: 6000, step: 0 }
}

/**
 * 根据段位中文名 + 星级 推算等效 MMR
 * @param {string} rankName - 段位中文名，如'超凡入圣'
 * @param {number} star - 星级 1-5
 * @param {number|null} actualMmr - 实际 MMR（优先使用）
 * @returns {number}
 */
function calcEquivalentMmr(rankName, star, actualMmr) {
  // 有实际 MMR 直接用
  if (actualMmr != null && actualMmr > 0) return Number(actualMmr)
  // 未定段/无段位 → 0 分
  if (!rankName) return 0
  const cfg = EQUIVALENT_MMR[rankName]
  if (!cfg) return 0
  // 冠绝一世没有星级
  if (rankName === '冠绝一世') return cfg.base
  const s = Math.max(1, Math.min(5, star || 1))
  const score = cfg.base + (s - 1) * cfg.step
  return Math.max(score, 100)
}

// 判断图标是否为图片路径
function isRankIconImage(icon) {
  return icon && icon.indexOf(RANK_ICON_IMAGE_PREFIX) === 0
}

// ====== 段位名标准化（处理拼音/英文存储为中文显示） ======
const RANK_NORMALIZE_MAP = {
  'xianfeng': '先锋', 'weishi': '卫士', 'zhongjun': '中军', 'tongshuai': '统帅',
  'chuanqi': '传奇', 'wanguliufang': '万古流芳', 'wangugu': '万古流芳',
  'chaofanrusheng': '超凡入圣', 'chaofan': '超凡入圣',
  'guanjueyishi': '冠绝一世', 'guanjue': '冠绝一世',
  'herald': '先锋', 'guardian': '卫士', 'crusader': '中军',
  'archon': '统帅', 'legend': '传奇',
  'ancient': '万古流芳', 'divine': '超凡入圣', 'immortal': '冠绝一世'
}
function normalizeRankName(name) {
  if (!name) return ''
  if (RANK_OPTIONS.includes(name)) return name
  const base = name.replace(/\d+$/, '')
  if (RANK_NORMALIZE_MAP[base.toLowerCase()]) return RANK_NORMALIZE_MAP[base.toLowerCase()]
  if (RANK_NORMALIZE_MAP[name.toLowerCase()]) return RANK_NORMALIZE_MAP[name.toLowerCase()]
  return name
}

module.exports = {
  RANK_OPTIONS,
  RANK_ORDER,
  RANK_ICONS,
  RANK_ICON_IMAGE_PREFIX,
  RANK_LABELS,
  RANK_COLORS,
  calcRankLabel,
  calcRankSort,
  calcEquivalentMmr,
  getRankTier,
  getRankIcon,
  isRankIconImage,
  normalizeRankName
}
