/**
 * 赛事系统公共工具函数
 * 供所有子路由模块共享使用
 */
const crypto = require('crypto');

// ———— 纯工具函数 ————

/** 安全随机 ID 生成器 */
function genId() {
  return crypto.randomBytes(16).toString('hex');
}

/** 安全回滚辅助 */
async function safeRollback(conn, ctx) {
  try { await conn.rollback(); }
  catch (e) { console.error(`[tx:rollback:${ctx}]`, e.message); }
}

/** 根据是否归档返回对应表名 */
function tableFor(baseName, isArchived) {
  return isArchived ? baseName + '_his' : baseName;
}

/** 生成 INSERT IGNORE INTO ... SELECT 归档迁移语句 */
function migrateSql(baseName) {
  return `INSERT IGNORE INTO ${baseName}_his SELECT * FROM ${baseName} WHERE event_id = ?`;
}

/** 生成 DELETE 清理语句 */
function cleanSql(baseName) {
  return `DELETE FROM ${baseName} WHERE event_id = ?`;
}

// 需要归档迁移的业务表列表
const ARCHIVE_TABLES = [
  'dota2_event_signup',
  'dota2_event_teams',
  'dota2_event_matches',
  'dota2_event_ranks'
];

// 每队最低人数
const MIN_TEAM_PLAYERS = 5;

/** 选手跨队唯一性校验 */
function validatePlayerUniqueness(teams) {
  const playerTeamMap = {};
  const duplicates = [];
  for (const team of teams) {
    const tid = team.teamId || team.teamName || 'unknown';
    for (const pid of (team.playerIds || [])) {
      if (playerTeamMap[pid] && playerTeamMap[pid] !== tid) { duplicates.push(pid); }
      playerTeamMap[pid] = tid;
    }
  }
  if (duplicates.length > 0) {
    return { valid: false, duplicates, error: `选手 ${duplicates.join(', ')} 同时存在于多支队伍中` };
  }
  return { valid: true, duplicates: [], error: '' };
}

/** 分数配对算法 — 按胜场从近到远两两配对 */
function autoPairTeams(teams) {
  if (teams.length < 2) return [];
  const sorted = [...teams].sort((a, b) => {
    const scoreA = a.wins || 0;
    const scoreB = b.wins || 0;
    if (scoreB !== scoreA) return scoreB - scoreA;
    const mmrA = a.avg_mmr || 0;
    const mmrB = b.avg_mmr || 0;
    if (mmrA !== mmrB) return mmrB - mmrA;
    return (a.captainName || '').localeCompare(b.captainName || '', 'zh');
  });
  const pairs = [];
  for (let i = 0; i < sorted.length - 1; i += 2) {
    pairs.push({ teamA: sorted[i], teamB: sorted[i + 1] });
  }
  return pairs;
}

// ———— 需要 pool 的函数（通过工厂创建） ————

module.exports = function (deps) {
  const { pool, getCallerRole, assertAdmin, upload, auth } = deps;
  const { validateStatusTransition, STATUS_NAMES } = require('../utils/auth');

  /** 通过 openid 批量查询 nick_name */
  async function getUserNicknames(openids) {
    const map = new Map();
    if (!openids || !openids.length) return map;
    const [rows] = await pool.query(
      'SELECT openid, nick_name FROM users WHERE openid IN (?)', [openids]
    );
    rows.forEach(r => { map.set(r.openid, r.nick_name || ''); });
    return map;
  }

  /** 将 event 行的 openid 字段替换为昵称 */
  async function resolveCreatorNickname(event) {
    if (!event) return event;
    const openids = [];
    if (event.creator_id) openids.push(event.creator_id);
    if (event.ended_by && event.ended_by.length > 10) openids.push(event.ended_by);
    if (event.archived_by && event.archived_by.length > 10) openids.push(event.archived_by);
    if (!openids.length) return event;
    const nickMap = await getUserNicknames(openids);
    if (event.creator_id) { event.creator_nickname = nickMap.get(event.creator_id) || ''; delete event.creator_id; }
    if (event.ended_by && event.ended_by.length > 10) { event.ended_by_nickname = nickMap.get(event.ended_by) || ''; delete event.ended_by; }
    if (event.archived_by && event.archived_by.length > 10) { event.archived_by_nickname = nickMap.get(event.archived_by) || ''; delete event.archived_by; }
    return event;
  }

  /** 通过 player_id 批量查询选手信息 */
  async function getPlayersByIds(ids) {
    if (!ids || !ids.length) return [];
    const [rows] = await pool.query(
      "SELECT id, wx_nickname, calibrate_rank_name, calibrate_rank_star, calibrate_mmr, calibrate_rank_sort, avatar_url, game_id, good_at_positions, signup_position FROM dota2_players WHERE status = 'active' AND id IN (?)",
      [ids]
    );
    return rows;
  }

  /** 校验赛事是否存在 */
  async function validateEvent(eventId) {
    const [rows] = await pool.query('SELECT * FROM dota2_events WHERE event_id = ?', [eventId]);
    return rows.length ? rows[0] : null;
  }

  /** 报名状态前置校验 */
  async function validateSignupEvent(eventId) {
    const event = await validateEvent(eventId);
    if (!event) return { valid: false, error: '赛事不存在', event: null };
    if (event.is_archived === 1) return { valid: false, error: '赛事已归档，不可进行报名操作', event };
    if (event.event_status !== 1) {
      const statusMap = { 0: '赛事尚未开启报名', 2: '报名已截止', 3: '赛事已进入分组阶段', 4: '赛事对战中', 5: '赛事已归档' };
      const msg = statusMap[event.event_status] || '当前赛事不在报名阶段';
      return { valid: false, error: msg, event };
    }
    return { valid: true, error: '', event };
  }

  /** 校验报名人数是否已达上限 */
  async function checkSignupLimit(eventId) {
    const [eventRows] = await pool.query('SELECT signup_limit FROM dota2_events WHERE event_id = ?', [eventId]);
    if (!eventRows.length) return { full: false, error: '' };
    const limit = eventRows[0].signup_limit;
    if (!limit || limit <= 0) return { full: false, error: '' };
    const [[{ cnt }]] = await pool.query(
      'SELECT COUNT(*) AS cnt FROM dota2_event_signup WHERE event_id = ? AND signup_status = 1', [eventId]
    );
    if (cnt >= limit) return { full: true, error: `报名人数已满（上限${limit}人）` };
    return { full: false, error: '' };
  }

  /** 通过用户 nick_name 精确匹配选手档案 */
  async function matchPlayerByNickname(nickName) {
    if (!nickName || !nickName.trim()) {
      return { success: false, code: 'NICKNAME_EMPTY', playerId: null, message: '请先设置您的昵称后再报名' };
    }
    const [rows] = await pool.query(
      "SELECT id, wx_nickname, calibrate_rank_name, calibrate_rank_star FROM dota2_players WHERE wx_nickname = ? AND status = 'active'",
      [nickName.trim()]
    );
    if (rows.length === 0) {
      return { success: false, code: 'PLAYER_NOT_FOUND', playerId: null, message: '未找到对应选手档案，请先完善选手信息后再报名' };
    }
    if (rows.length > 1) {
      return { success: false, code: 'MULTIPLE_MATCH', playerId: null, message: '昵称匹配到多个选手档案，请联系管理员手动添加报名' };
    }
    return {
      success: true, code: 'MATCH_OK', playerId: rows[0].id, message: '',
      playerInfo: { wxNickname: rows[0].wx_nickname, rankName: rows[0].calibrate_rank_name, rankStar: rows[0].calibrate_rank_star }
    };
  }

  /** 队伍锁定校验 */
  async function validateTeamEditable(eventId) {
    const event = await validateEvent(eventId);
    if (!event) return { locked: true, error: '赛事不存在' };
    if (event.is_archived === 1) return { locked: true, error: '赛事已归档，队伍数据不可修改' };
    if (event.event_status < 2) return { locked: true, error: '赛事尚未截止报名，无法进行队伍编排' };
    if (event.event_status >= 3) return { locked: true, error: '队伍已锁定，不可修改' };
    return { locked: false, error: '', event };
  }

  /** 通过 openid 查找对应的 player_id */
  async function getPlayerIdByOpenid(openid) {
    if (!openid) return null;
    try {
      const [userRows] = await pool.query('SELECT nick_name FROM users WHERE openid = ?', [openid]);
      const userNick = (userRows.length && userRows[0].nick_name) ? userRows[0].nick_name : '';
      if (!userNick) return null;
      const [playerRows] = await pool.query("SELECT id FROM dota2_players WHERE wx_nickname = ? AND status = 'active'", [userNick]);
      if (playerRows.length === 1) return playerRows[0].id;
      return null;
    } catch (_) { return null; }
  }

  /** 对战状态前置校验 */
  async function validateBattleEvent(eventId, allowedStatuses = [4]) {
    const event = await validateEvent(eventId);
    if (!event) return { valid: false, error: '赛事不存在', event: null };
    if (event.is_archived === 1) return { valid: false, error: '赛事已归档，所有对战数据不可修改', event };
    if (!allowedStatuses.includes(event.event_status)) {
      return { valid: false, error: `赛事当前状态为「${STATUS_NAMES[event.event_status] || '未知'}」，非对战阶段不可操作`, event };
    }
    return { valid: true, error: '', event };
  }

  /** 校验赛事未归档（全局只读拦截） */
  async function checkNotArchived(eventId) {
    const [[{ archived, event_status }]] = await pool.query(
      'SELECT is_archived as archived, event_status FROM dota2_events WHERE event_id = ?', [eventId]
    );
    if (archived === 1 || event_status >= 6) {
      return { blocked: true, error: '赛事已归档，所有数据为只读状态，不可修改' };
    }
    return { blocked: false, error: '' };
  }

  return {
    pool, getCallerRole, assertAdmin, upload, auth,
    validateStatusTransition, STATUS_NAMES,
    genId, safeRollback, tableFor, migrateSql, cleanSql,
    ARCHIVE_TABLES, MIN_TEAM_PLAYERS,
    validatePlayerUniqueness, autoPairTeams,
    getUserNicknames, resolveCreatorNickname, getPlayersByIds,
    validateEvent, validateSignupEvent, checkSignupLimit,
    matchPlayerByNickname, validateTeamEditable, getPlayerIdByOpenid,
    validateBattleEvent, checkNotArchived,
  };
};
