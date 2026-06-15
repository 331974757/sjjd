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

// 判断图标是否为图片路径
function isRankIconImage(icon) {
  return icon && icon.indexOf(RANK_ICON_IMAGE_PREFIX) === 0
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
  getRankTier,
  getRankIcon,
  isRankIconImage
}
