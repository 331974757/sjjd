/**
 * ============================================================
 * 【第9轮】统一权限/状态/归档中间件
 * server/utils/auth.js
 *
 * 使用方式（在 server/index.js 中）：
 *   const auth = require('./utils/auth');
 *   // 初始化：传入 pool
 *   auth.init(pool);
 *
 * 中间件使用示例：
 *   app.post('/api/events',        auth.requireAdmin, handler);
 *   app.delete('/api/events/:id',  auth.requireSuperAdmin, handler);
 *   app.post('/api/events/:id/signups', auth.requireSignupOpen, handler);
 *   app.post('/api/events/:id/teams/batch', auth.requireTeamEditable, handler);
 *
 * 手动调用示例：
 *   const result = await auth.validateNotArchived(eventId);
 *   if (result.blocked) return res.status(403).json(...)
 * ============================================================
 */

let pool = null;
let getCallerRoleFn = null;

/**
 * 初始化模块（必须在 app.listen 之前调用）
 * @param {Object} mysqlPool  - mysql2/promise 连接池
 * @param {Function} roleFn  - 获取调用者角色的函数 getCallerRole(openid)
 */
function init(mysqlPool, roleFn) {
  pool = mysqlPool;
  getCallerRoleFn = roleFn;
}

// ════════════════════════════════════════════════════════════
// 一、角色常量
// ════════════════════════════════════════════════════════════

const ROLES = {
  SUPER_ADMIN: 'super_admin',
  ADMIN: 'admin',
  USER: 'user',
};

// ════════════════════════════════════════════════════════════
// 二、赛事状态常量
// ════════════════════════════════════════════════════════════

const STATUS = {
  CREATING: 0,          // 创建中
  SIGNUP_OPEN: 1,       // 报名中
  SIGNUP_CLOSED: 2,     // 报名截止
  TEAMS_LOCKED: 3,      // 分组锁定
  BATTLE_ACTIVE: 4,     // 对战中
  FINISHED: 5,          // 已归档(event_status层面)
};

const STATUS_NAMES = {
  0: '创建中',
  1: '报名中',
  2: '报名截止',
  3: '分组锁定',
  4: '对战中',
  5: '已归档',
};

// ════════════════════════════════════════════════════════════
// 三、状态流转规则（严格正向顺序 0→1→2→3→4→5）
// ════════════════════════════════════════════════════════════

/**
 * 【状态机核心】校验状态流转合法性
 * @returns {{ valid: boolean, error: string }}
 */
function validateStatusTransition(currentStatus, targetStatus) {
  if (currentStatus === targetStatus) {
    return { valid: false, error: '赛事已是该状态，无需重复操作' };
  }
  if (targetStatus === currentStatus + 1) {
    return { valid: true, error: '' };
  }
  return {
    valid: false,
    error: `状态流转不合法：当前「${STATUS_NAMES[currentStatus]}」→「${STATUS_NAMES[targetStatus]}」不是合法跳转。仅允许按顺序依次推进：创建中→报名中→报名截止→分组锁定→对战中→已归档`
  };
}

/**
 * 【状态机】获取某状态下允许的操作清单
 * @returns {string[]} 允许的操作类型列表
 */
function getAllowedActions(eventStatus, isArchived) {
  // 已正式归档 → 全部只读
  if (isArchived === 1) {
    return ['view']; // 仅查看
  }

  const actions = ['view'];
  switch (eventStatus) {
    case STATUS.CREATING:
      actions.push('edit_event', 'delete_event'); // 编辑/删除赛事基本信息
      break;
    case STATUS.SIGNUP_OPEN:
      actions.push('signup', 'cancel_signup', 'manage_signups', 'edit_event');
      break;
    case STATUS.SIGNUP_CLOSED:
      actions.push('manage_teams', 'edit_event', 'manage_signups');
      break;
    case STATUS.TEAMS_LOCKED:
      actions.push('manage_teams', 'lock_teams', 'edit_event');
      break;
    case STATUS.BATTLE_ACTIVE:
      actions.push('manage_matches', 'judge', 'next_round', 'end_battle');
      break;
    case STATUS.FINISHED:
      actions.push('manage_ranks', 'archive_event');
      break;
  }
  return actions;
}

// ════════════════════════════════════════════════════════════
// 四、底层工具函数
// ════════════════════════════════════════════════════════════

/**
 * 从请求中提取 openid
 */
function extractOpenid(req) {
  return req.query.openid || (req.body && req.body.openid) || '';
}

/**
 * 获取调用者角色
 */
async function getCallerRole(req) {
  if (getCallerRoleFn) {
    return await getCallerRoleFn(extractOpenid(req));
  }
  const openid = extractOpenid(req);
  if (!openid) return ROLES.USER;
  try {
    const [rows] = await pool.query('SELECT role FROM dota2_users WHERE openid = ?', [openid]);
    return rows.length ? rows[0].role : ROLES.USER;
  } catch (e) {
    return ROLES.USER;
  }
}

/**
 * 获取赛事信息（按 event_id）
 */
async function getEvent(eventId) {
  const [rows] = await pool.query('SELECT * FROM dota2_events WHERE event_id = ?', [eventId]);
  return rows.length ? rows[0] : null;
}

// ════════════════════════════════════════════════════════════
// 五、Express 中间件（可直接 app.use / 路由级别挂载）
// ════════════════════════════════════════════════════════════

/**
 * 【中间件】断言管理员（admin 或 super_admin）
 * 适用模块：选手档案/赛事章程/历史赛事 的所有管理操作
 */
async function requireAdmin(req, res, next) {
  const role = await getCallerRole(req);
  if (role !== ROLES.ADMIN && role !== ROLES.SUPER_ADMIN) {
    return res.status(403).json({ success: false, error: '仅管理员可操作' });
  }
  next();
}

/**
 * 【中间件】断言超级管理员（仅 super_admin）
 * 适用：管理员账号管理、删除未归档赛事、全局配置修改
 */
async function requireSuperAdmin(req, res, next) {
  const role = await getCallerRole(req);
  if (role !== ROLES.SUPER_ADMIN) {
    return res.status(403).json({ success: false, error: '仅超级管理员可操作' });
  }
  next();
}

/**
 * 【中间件】断言赛事在「报名中」状态（status=1）
 * 适用：用户自主报名、取消报名
 */
async function requireSignupOpen(req, res, next) {
  const eventId = req.params.eventId;
  const event = await getEvent(eventId);
  if (!event) {
    return res.status(404).json({ success: false, error: '赛事不存在' });
  }
  if (event.is_archived === 1) {
    return res.status(400).json({ success: false, error: '赛事已归档，不可进行报名操作' });
  }
  if (event.event_status !== STATUS.SIGNUP_OPEN) {
    const msg = STATUS_NAMES[event.event_status]
      ? `赛事当前状态为「${STATUS_NAMES[event.event_status]}」，非报名阶段不可操作`
      : '当前赛事不在报名阶段';
    return res.status(400).json({ success: false, error: msg });
  }
  req._event = event; // 挂载到 request，减少重复查询
  next();
}

/**
 * 【中间件】断言赛事队伍可编辑（status=2 或 3）
 * 适用：队伍编组、自动分队、删除队伍
 */
async function requireTeamEditable(req, res, next) {
  const eventId = req.params.eventId;
  const event = await getEvent(eventId);
  if (!event) {
    return res.status(404).json({ success: false, error: '赛事不存在' });
  }
  if (event.is_archived === 1) {
    return res.status(400).json({ success: false, error: '赛事已归档，队伍数据不可修改' });
  }
  if (event.event_status < STATUS.SIGNUP_CLOSED) {
    return res.status(400).json({ success: false, error: '赛事尚未截止报名，无法进行队伍编排' });
  }
  if (event.event_status >= STATUS.BATTLE_ACTIVE) {
    return res.status(400).json({ success: false, error: '比赛已开始，队伍数据已永久锁定，不可修改' });
  }
  req._event = event;
  next();
}

/**
 * 【中间件】断言赛事在「对战中」状态（status=4）
 * 适用：生成对战、胜负判定、进入下一轮、结束比赛
 */
async function requireBattleActive(req, res, next) {
  const eventId = req.params.eventId;
  const event = await getEvent(eventId);
  if (!event) {
    return res.status(404).json({ success: false, error: '赛事不存在' });
  }
  if (event.is_archived === 1) {
    return res.status(400).json({ success: false, error: '赛事已归档，所有对战数据不可修改' });
  }
  if (event.event_status !== STATUS.BATTLE_ACTIVE) {
    const map = { 0: '创建中', 1: '报名中', 2: '报名截止', 3: '分组锁定', 5: '已归档' };
    return res.status(400).json({
      success: false,
      error: `赛事当前状态为「${map[event.event_status] || '未知'}」，非对战阶段不可操作`
    });
  }
  req._event = event;
  next();
}

/**
 * 【中间件】断言赛事未归档（通用只读拦截）
 * 适用：名次设定、其他需检查 archives 的操作
 */
async function requireNotArchived(req, res, next) {
  const eventId = req.params.eventId;
  const [[{ archived }]] = await pool.query(
    'SELECT is_archived as archived FROM dota2_events WHERE event_id = ?',
    [eventId]
  );
  if (archived === 1) {
    return res.status(403).json({ success: false, error: '赛事已归档，所有数据为只读状态，不可修改' });
  }
  next();
}

/**
 * 【组合中间件】管理员 + 未归档
 * 适用：赛事编辑、状态变更等需要管理员权限且未被归档的操作
 */
async function requireAdminNotArchived(req, res, next) {
  const role = await getCallerRole(req);
  if (role !== ROLES.ADMIN && role !== ROLES.SUPER_ADMIN) {
    return res.status(403).json({ success: false, error: '仅管理员可操作' });
  }
  const eventId = req.params.eventId;
  const event = await getEvent(eventId);
  if (!event) {
    return res.status(404).json({ success: false, error: '赛事不存在' });
  }
  if (event.is_archived === 1) {
    return res.status(403).json({ success: false, error: '赛事已归档，不可编辑' });
  }
  req._event = event;
  next();
}

/**
 * 【组合中间件】管理员 + 可报名阶段
 * 适用：管理员添加报名（可在报名中/报名截止状态操作）
 */
async function requireAdminSignupManage(req, res, next) {
  const role = await getCallerRole(req);
  if (role !== ROLES.ADMIN && role !== ROLES.SUPER_ADMIN) {
    return res.status(403).json({ success: false, error: '仅管理员可操作' });
  }
  const eventId = req.params.eventId;
  const event = await getEvent(eventId);
  if (!event) {
    return res.status(404).json({ success: false, error: '赛事不存在' });
  }
  if (event.is_archived === 1) {
    return res.status(400).json({ success: false, error: '赛事已归档，不可操作报名' });
  }
  req._event = event;
  next();
}

/**
 * 【组合中间件】管理员 + 可设名次（status=5 且未归档）
 * 适用：名次设置
 */
async function requireAdminCanSetRank(req, res, next) {
  const role = await getCallerRole(req);
  if (role !== ROLES.ADMIN && role !== ROLES.SUPER_ADMIN) {
    return res.status(403).json({ success: false, error: '仅管理员可操作' });
  }
  const eventId = req.params.eventId;
  const event = await getEvent(eventId);
  if (!event) {
    return res.status(404).json({ success: false, error: '赛事不存在' });
  }
  if (event.is_archived === 1) {
    return res.status(403).json({ success: false, error: '赛事已归档，名次数据不可修改' });
  }
  req._event = event;
  next();
}

// ════════════════════════════════════════════════════════════
// 六、手动调用版工具函数（用于需要自定义错误处理的场景）
// ════════════════════════════════════════════════════════════

/**
 * 检查是否管理员（返回布尔，不发送响应）
 */
async function isAdmin(openid) {
  const [rows] = await pool.query('SELECT role FROM dota2_users WHERE openid = ?', [openid]);
  if (!rows.length) return false;
  return rows[0].role === ROLES.ADMIN || rows[0].role === ROLES.SUPER_ADMIN;
}

/**
 * 检查是否超级管理员（返回布尔，不发送响应）
 */
async function isSuperAdmin(openid) {
  const [rows] = await pool.query('SELECT role FROM dota2_users WHERE openid = ?', [openid]);
  if (!rows.length) return false;
  return rows[0].role === ROLES.SUPER_ADMIN;
}

/**
 * 检查赛事是否已归档（返回 { blocked, error }）
 */
async function validateNotArchived(eventId) {
  const [[{ archived }]] = await pool.query(
    'SELECT is_archived as archived FROM dota2_events WHERE event_id = ?',
    [eventId]
  );
  if (archived === 1) {
    return { blocked: true, error: '赛事已归档，所有数据为只读状态，不可修改' };
  }
  return { blocked: false, error: '' };
}

/**
 * 校验赛事是否存在
 */
async function validateEvent(eventId) {
  const event = await getEvent(eventId);
  if (!event) return { valid: false, error: '赛事不存在', event: null };
  return { valid: true, error: '', event };
}

/**
 * 校验报名操作合法性
 */
async function validateSignupEvent(eventId) {
  const event = await getEvent(eventId);
  if (!event) return { valid: false, error: '赛事不存在', event: null };
  if (event.is_archived === 1) {
    return { valid: false, error: '赛事已归档，不可进行报名操作', event };
  }
  if (event.event_status !== STATUS.SIGNUP_OPEN) {
    const map = { 0: '赛事尚未开启报名', 2: '报名已截止', 3: '赛事已进入分组阶段', 4: '赛事对战中', 5: '赛事已归档' };
    return { valid: false, error: map[event.event_status] || '当前赛事不在报名阶段', event };
  }
  return { valid: true, error: '', event };
}

/**
 * 校验队伍编辑合法性
 */
async function validateTeamEditable(eventId) {
  const event = await getEvent(eventId);
  if (!event) return { locked: true, error: '赛事不存在' };
  if (event.is_archived === 1) {
    return { locked: true, error: '赛事已归档，队伍数据不可修改' };
  }
  if (event.event_status < STATUS.SIGNUP_CLOSED) {
    return { locked: true, error: '赛事尚未截止报名，无法进行队伍编排' };
  }
  if (event.event_status >= STATUS.BATTLE_ACTIVE) {
    return { locked: true, error: '比赛已开始，队伍数据已永久锁定，不可修改' };
  }
  return { locked: false, error: '', event };
}

/**
 * 校验对战操作合法性
 */
async function validateBattleEvent(eventId) {
  const event = await getEvent(eventId);
  if (!event) return { valid: false, error: '赛事不存在', event: null };
  if (event.is_archived === 1) {
    return { valid: false, error: '赛事已归档，所有对战数据不可修改', event };
  }
  if (event.event_status !== STATUS.BATTLE_ACTIVE) {
    const map = { 0: '创建中', 1: '报名中', 2: '报名截止', 3: '分组锁定', 5: '已归档' };
    return { valid: false, error: `赛事当前状态为「${map[event.event_status] || '未知'}」，非对战阶段不可操作`, event };
  }
  return { valid: true, error: '', event };
}

// ════════════════════════════════════════════════════════════
// 七、接口权限对照表（文档用途）
// ════════════════════════════════════════════════════════════

/**
 * 完整接口权限矩阵
 * 格式：{ method, path, roles: ['user'|'admin'|'super_admin'], statusRequired, archiveCheck }
 */
const PERMISSION_MATRIX = [
  // ─── 赛事管理 ───
  { method: 'GET',    path: '/api/events',                      roles: ['user','admin','super_admin'], status: null,      note: '赛事列表' },
  { method: 'GET',    path: '/api/events/archived',             roles: ['user','admin','super_admin'], status: null,      note: '【R8】已归档赛事列表' },
  { method: 'GET',    path: '/api/events/:eventId',             roles: ['user','admin','super_admin'], status: null,      note: '赛事详情' },
  { method: 'GET',    path: '/api/events/:eventId/full',        roles: ['user','admin','super_admin'], status: null,      note: '【R8】全量数据' },
  { method: 'POST',   path: '/api/events',                      roles: ['admin','super_admin'],          status: null,      note: '创建赛事' },
  { method: 'PUT',    path: '/api/events/:eventId',             roles: ['admin','super_admin'],          status: 'any',     note: '编辑赛事（归档拦截）' },
  { method: 'PUT',    path: '/api/events/:eventId/status',      roles: ['admin','super_admin'],          status: 'sequential', note: '状态变更（严格顺序）' },
  { method: 'DELETE', path: '/api/events/:eventId',             roles: ['super_admin'],                  status: 'any',     note: '删除赛事（仅超管+未归档）' },

  // ─── 报名管理 ───
  { method: 'GET',    path: '/api/events/:eventId/signups',     roles: ['user','admin','super_admin'],   status: null,      note: '报名列表（用户仅看有效）' },
  { method: 'GET',    path: '/api/events/:eventId/my-signup',   roles: ['user','admin','super_admin'],   status: null,      note: '我的报名状态' },
  { method: 'POST',   path: '/api/events/:eventId/signups',     roles: ['user','admin','super_admin'],   status: 1,         note: '自主报名（status=1）' },
  { method: 'POST',   path: '/api/events/:eventId/signups/admin', roles: ['admin','super_admin'],       status: 'any',     note: '管理员添加报名' },
  { method: 'POST',   path: '/api/events/:eventId/signups/batch', roles: ['admin','super_admin'],       status: 'any',     note: '批量添加报名' },
  { method: 'DELETE', path: '/api/events/:eventId/signups/:signupId', roles: ['user','admin','super_admin'], status: '0,1,2',  note: '取消报名（管理员赛事未分组前均可删除，普通用户仅报名中）' },
  { method: 'GET',    path: '/api/search/players',              roles: ['user','admin','super_admin'],   status: null,      note: '选手搜索' },

  // ─── 队伍管理 ───
  { method: 'GET',    path: '/api/events/:eventId/teams',       roles: ['user','admin','super_admin'],   status: null,      note: '队伍列表+自由选手' },
  { method: 'POST',   path: '/api/events/:eventId/teams/batch', roles: ['admin','super_admin'],          status: '2,3',     note: '批量保存编组' },
  { method: 'POST',   path: '/api/events/:eventId/allocate-teams', roles: ['admin','super_admin'],       status: '2,3',     note: '自动分队' },
  { method: 'POST',   path: '/api/events/:eventId/lock-teams',  roles: ['admin','super_admin'],          status: 3,         note: '开赛锁定（3→4）' },
  { method: 'DELETE', path: '/api/events/:eventId/teams/:teamId', roles: ['admin','super_admin'],        status: '2,3',     note: '删除队伍' },

  // ─── 对战管理 ───
  { method: 'GET',    path: '/api/events/:eventId/matches',     roles: ['user','admin','super_admin'],   status: null,      note: '对战列表' },
  { method: 'GET',    path: '/api/events/:eventId/matches/rounds', roles: ['user','admin','super_admin'], status: null,   note: '轮次汇总' },
  { method: 'POST',   path: '/api/events/:eventId/matches/generate', roles: ['admin','super_admin'],     status: 4,         note: '生成对战' },
  { method: 'PUT',    path: '/api/events/:eventId/matches/:matchId/judge', roles: ['admin','super_admin'], status: 4,    note: '判定胜负' },
  { method: 'DELETE', path: '/api/events/:eventId/matches/:matchId', roles: ['admin','super_admin'],     status: null,      note: '删除对战（未判定）' },
  { method: 'POST',   path: '/api/events/:eventId/next-round',  roles: ['admin','super_admin'],          status: 4,         note: '进入下一轮' },
  { method: 'POST',   path: '/api/events/:eventId/end-battle',  roles: ['admin','super_admin'],          status: 4,         note: '结束比赛（4→5）' },

  // ─── 名次管理 ───
  { method: 'GET',    path: '/api/events/:eventId/ranks',       roles: ['user','admin','super_admin'],   status: null,      note: '查看名次' },
  { method: 'POST',   path: '/api/events/:eventId/ranks/batch', roles: ['admin','super_admin'],          status: 'any',     note: '批量保存名次（归档拦截）' },
  { method: 'POST',   path: '/api/events/:eventId/ranks',       roles: ['admin','super_admin'],          status: 'any',     note: '设置单个名次（归档拦截）' },
  { method: 'PUT',    path: '/api/events/:eventId/ranks/:rankId', roles: ['admin','super_admin'],        status: 'any',     note: '更新名次（归档拦截）' },
  { method: 'DELETE', path: '/api/events/:eventId/ranks/:rankId', roles: ['admin','super_admin'],        status: 'any',     note: '删除名次（归档拦截）' },

  // ─── 归档管理 ───
  { method: 'POST',   path: '/api/events/:eventId/archive',     roles: ['admin','super_admin'],          status: 5,         note: '正式归档（未归档时）' },

  // ─── 赛事章程 ───
  { method: 'GET',    path: '/api/rules',                       roles: ['user','admin','super_admin'],   status: null,      note: '章程列表（用户仅看已发布）' },
  { method: 'GET',    path: '/api/rules/:ruleId',               roles: ['user','admin','super_admin'],   status: null,      note: '章程详情' },
  { method: 'GET',    path: '/api/events/:eventId/rules',       roles: ['user','admin','super_admin'],   status: null,      note: '赛事绑定章程' },
  { method: 'POST',   path: '/api/rules',                       roles: ['admin','super_admin'],          status: null,      note: '创建章程' },
  { method: 'PUT',    path: '/api/rules/:ruleId',               roles: ['admin','super_admin'],          status: null,      note: '编辑章程' },
  { method: 'DELETE', path: '/api/rules/:ruleId',               roles: ['admin','super_admin'],          status: null,      note: '删除章程' },

  // ─── 选手档案 ───
  { method: 'GET',    path: '/api/players',                     roles: ['user','admin','super_admin'],   status: null,      note: '选手列表' },
  { method: 'GET',    path: '/api/players/:id',                 roles: ['user','admin','super_admin'],   status: null,      note: '选手详情' },
  { method: 'POST',   path: '/api/players',                     roles: ['admin','super_admin'],          status: null,      note: '新增选手' },
  { method: 'PUT',    path: '/api/players/:id',                 roles: ['user','admin','super_admin'],   status: null,      note: '编辑选手（用户仅限本人）' },
  { method: 'DELETE', path: '/api/players/:id',                 roles: ['admin','super_admin'],          status: null,      note: '删除选手' },
  { method: 'POST',   path: '/api/players/batch-delete',        roles: ['admin','super_admin'],          status: null,      note: '批量删除' },
  { method: 'POST',   path: '/api/players/import',              roles: ['admin','super_admin'],          status: null,      note: 'JSON批量导入' },
  { method: 'POST',   path: '/api/players/import/xlsx',         roles: ['admin','super_admin'],          status: null,      note: 'XLSX导入' },
  { method: 'GET',    path: '/api/players/export/all',          roles: ['admin','super_admin'],          status: null,      note: '导出全部' },
  { method: 'POST',   path: '/api/upload',                      roles: ['admin','super_admin'],          status: null,      note: '头像上传' },

  // ─── 用户管理 ───
  { method: 'GET',    path: '/api/users/me',                    roles: ['user','admin','super_admin'],   status: null,      note: '当前用户信息' },
  { method: 'GET',    path: '/api/users/admins/list',           roles: ['admin','super_admin'],          status: null,      note: '管理员列表' },
  { method: 'PUT',    path: '/api/users/:openid/role',          roles: ['super_admin'],                  status: null,      note: '修改角色（仅超管）' },
  { method: 'PUT',    path: '/api/users/me/nickname',           roles: ['user','admin','super_admin'],   status: null,      note: '修改昵称' },
  { method: 'PUT',    path: '/api/users/:openid/reset-nickcount', roles: ['super_admin'],                status: null,      note: '重置改名次数（仅超管）' },
];

/**
 * 获取 admin 与 super_admin 权限完全一致的接口列表
 * （用于验证第8轮权限规则：三个模块两类管理员权限一致）
 */
function getAdminEqualInterfaces() {
  return PERMISSION_MATRIX
    .filter(item => {
      const r = item.roles;
      return r.includes('admin') && r.includes('super_admin') && !(
        r.length === 1 || (r.length === 2 && r.includes('admin') && r.includes('super_admin'))
      );
    })
    .filter(item => {
      // 排除仅 super_admin 的接口
      const r = item.roles;
      return !(r.length === 1 && r[0] === 'super_admin');
    });
}

/**
 * 获取仅 super_admin 独有权限的接口列表
 */
function getSuperAdminOnlyInterfaces() {
  return PERMISSION_MATRIX.filter(item =>
    item.roles.length === 1 && item.roles[0] === 'super_admin'
  );
}

// ════════════════════════════════════════════════════════════
// 八、导出
// ════════════════════════════════════════════════════════════

module.exports = {
  // 初始化
  init,

  // 常量
  ROLES,
  STATUS,
  STATUS_NAMES,

  // Express 中间件
  requireAdmin,
  requireSuperAdmin,
  requireSignupOpen,
  requireTeamEditable,
  requireBattleActive,
  requireNotArchived,
  requireAdminNotArchived,
  requireAdminSignupManage,
  requireAdminCanSetRank,

  // 手动调用版工具函数
  isAdmin,
  isSuperAdmin,
  validateNotArchived,
  validateEvent,
  validateSignupEvent,
  validateTeamEditable,
  validateBattleEvent,
  validateStatusTransition,
  getAllowedActions,
  getEvent,
  getCallerRole,

  // 文档数据
  PERMISSION_MATRIX,
  getAdminEqualInterfaces,
  getSuperAdminOnlyInterfaces,
};
