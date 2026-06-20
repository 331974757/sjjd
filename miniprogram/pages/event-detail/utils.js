// ============================================================
// pages/event-detail/utils.js
// 赛事详情页 - 选手/队伍规范化工具函数
// 从 event-detail.js 中提取，保持视图逻辑与数据加工分离
// ============================================================

// 位置格式化：优先 signup_position（报名位置），其次 good_at_positions → "1,2号位"
function formatPosition(p) {
  let pos = p.signup_position || p.signupPosition || p.good_at_positions || ''
  if (!pos) return ''
  if (Array.isArray(pos)) pos = pos.join(',')
  if (typeof pos !== 'string') return ''
  pos = pos.trim()
  if (!pos) return ''
  return pos + '号位'
}

/** 统一选手数据规范化：填充中文段位名 + 等效MMR + 位置文本 */
function normalizePlayer(p) {
  const R = require('../../utils/rank-utils.js')
  const rankName = R.normalizeRankName(p.calibrate_rank_name)
  return {
    ...p,
    calibrate_rank_name: rankName,
    _posText: formatPosition(p),
    calibrate_mmr: R.calcEquivalentMmr(rankName, p.calibrate_rank_star, p.calibrate_mmr)
  }
}

/** 统一自由选手规范化：填充ID */
function normalizeFreeAgent(p) {
  const R = require('../../utils/rank-utils.js')
  const np = normalizePlayer(p)
  return { ...np, id: p.id || p.player_id || p._id || '' }
}

/** 统一队伍数据规范化：展开members、解析队长、计算统计 */
function normalizeTeamItem(t, calcStatsFn, canEditNameFn) {
  const rawMembers = (t.members || t.players || []).map(normalizePlayer)
  const cid = t.captain_id || t.captainId || ''
  let cname = t.captain_name || (t.captain ? t.captain.wx_nickname : '') || ''
  if (!cname && cid && rawMembers.length > 0) {
    const found = rawMembers.find(m => String(m.id || m.player_id || m._id) === String(cid))
    cname = found ? (found.wx_nickname || found.nickName || '') : ''
  }
  const stats = calcStatsFn(rawMembers)
  const teamObj = {
    team_id: t.team_id || t.teamId || '',
    team_name: t.team_name || t.teamName || '未命名',
    captain_id: cid,
    captain_name: cname,
    members: rawMembers,
    players: rawMembers,
    ...stats
  }
  teamObj._canEditName = canEditNameFn(teamObj)
  return teamObj
}

module.exports = {
  formatPosition,
  normalizePlayer,
  normalizeFreeAgent,
  normalizeTeamItem
}
