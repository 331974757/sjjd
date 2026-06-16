/**
 * ============================================================
 * 赛事业务模块 - 完整 Express 路由
 * 包含：赛事管理 / 报名管理 / 队伍管理 / 对战管理 / 名次管理 / 赛事章程
 *
 * 【整合方式】在 server/index.js 末尾 app.listen 之前添加一行：
 *   require('./event-routes')(app, { pool, assertAdmin, getCallerRole });
 *
 * 与现有 server/index.js 共享：pool 连接池 / assertAdmin / getCallerRole
 * ============================================================
 */

/**
 * 生成与现有项目一致的唯一ID
 * 格式：十六进制时间戳 + 8位随机十六进制
 */
function genId() {
  return Date.now().toString(16) + Math.random().toString(16).slice(2, 10);
}

// ============================================================
// 选手档案对接工具函数
// ============================================================

/**
 * 通过 wx_nickname 模糊搜索选手
 * @param {string} keyword - 搜索关键词
 * @param {number} limit  - 返回数量上限，默认 20
 * @returns {Array} 选手列表（snake_case 字段，与数据库一致）
 */
async function searchPlayers(pool, keyword, limit = 20) {
  if (!keyword) return [];
  const [rows] = await pool.query(
    'SELECT id, wx_nickname, calibrate_rank_name, calibrate_rank_star, avatar_url FROM dota2_players WHERE wx_nickname LIKE ? LIMIT ?',
    ['%' + keyword + '%', limit]
  );
  return rows;
}

/**
 * 通过 player_id 数组批量查询选手信息
 * @param {Array<string>} ids - 选手ID数组
 * @returns {Array} 选手列表
 */
async function getPlayersByIds(pool, ids) {
  if (!ids || !ids.length) return [];
  const [rows] = await pool.query(
    'SELECT id, wx_nickname, calibrate_rank_name, calibrate_rank_star, avatar_url, game_id FROM dota2_players WHERE id IN (?)',
    [ids]
  );
  return rows;
}

/**
 * 校验赛事是否存在（数据隔离前提）
 * @returns {Object|null} 赛事行数据，不存在返回 null
 */
async function validateEvent(pool, eventId) {
  const [rows] = await pool.query('SELECT * FROM dota2_events WHERE event_id = ?', [eventId]);
  return rows.length ? rows[0] : null;
}

// ============================================================
// 超管权限校验（复用现有 getCallerRole）
// ============================================================
async function assertSuperAdmin(req, res, getCallerRole) {
  const openid = req.query.openid || '';
  const role = await getCallerRole(openid);
  if (role !== 'super_admin') {
    res.status(403).json({ success: false, error: '仅超级管理员可操作' });
    return false;
  }
  return true;
}

// ============================================================
// 主入口：导出路由注册函数
// ============================================================
module.exports = function (app, { pool, assertAdmin, getCallerRole }) {

  // ════════════════════════════════════════════════════════════
  // 1. 赛事管理模块（dota2_events）
  // ════════════════════════════════════════════════════════════

  /**
   * 获取赛事列表
   * GET /api/events?status=1&archived=0&page=1&pageSize=10
   * - 普通用户可查看，按创建时间倒序
   */
  app.get('/api/events', async (req, res) => {
    try {
      const { status, archived, page, pageSize } = req.query;
      let where = ' WHERE 1=1';
      const params = [];

      // 按状态筛选（0创建中/1报名中/2报名截止/3分组锁定/4对战中/5已归档）
      if (status !== undefined && status !== '') {
        where += ' AND event_status = ?';
        params.push(parseInt(status));
      }
      // 按归档标记筛选
      if (archived !== undefined && archived !== '') {
        where += ' AND is_archived = ?';
        params.push(parseInt(archived));
      }

      const p = parseInt(page) || 1;
      const ps = parseInt(pageSize) || 20;
      const sql = 'SELECT * FROM dota2_events' + where + ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
      const countSql = 'SELECT COUNT(*) as total FROM dota2_events' + where;

      const [rows] = await pool.query(sql, [...params, ps, (p - 1) * ps]);
      const [[{ total }]] = await pool.query(countSql, params);

      res.json({ success: true, data: rows, total, page: p, pageSize: ps });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 获取单场赛事详情
   * GET /api/events/:eventId
   */
  app.get('/api/events/:eventId', async (req, res) => {
    try {
      const { eventId } = req.params;
      const [rows] = await pool.query('SELECT * FROM dota2_events WHERE event_id = ?', [eventId]);
      if (!rows.length) return res.status(404).json({ success: false, error: '赛事不存在' });
      res.json({ success: true, data: rows[0] });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 创建赛事（admin/super_admin）
   * POST /api/events
   * Body: { eventName, startTime }
   * - 默认状态为0(创建中)，未归档
   */
  app.post('/api/events', async (req, res) => {
    try {
      if (!await assertAdmin(req, res)) return;
      const { eventName, startTime } = req.body;
      if (!eventName) return res.status(400).json({ success: false, error: '赛事名称不能为空' });

      const eventId = genId();
      const now = Date.now();
      await pool.query(
        'INSERT INTO dota2_events (event_id, event_name, creator_id, event_status, start_time, is_archived, created_at, updated_at) VALUES (?, ?, ?, 0, ?, 0, ?, ?)',
        [eventId, eventName, req.query.openid || '', startTime || null, now, now]
      );

      res.json({ success: true, data: { eventId } });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 编辑赛事信息（admin/super_admin）
   * PUT /api/events/:eventId
   * Body: { eventName, startTime }
   */
  app.put('/api/events/:eventId', async (req, res) => {
    try {
      if (!await assertAdmin(req, res)) return;
      const { eventId } = req.params;
      const event = await validateEvent(pool, eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });

      const { eventName, startTime } = req.body;
      const sets = [];
      const values = [];
      if (eventName !== undefined) { sets.push('event_name = ?'); values.push(eventName); }
      if (startTime !== undefined) { sets.push('start_time = ?'); values.push(startTime); }

      if (sets.length > 0) {
        sets.push('updated_at = ?');
        values.push(Date.now(), eventId);
        await pool.query('UPDATE dota2_events SET ' + sets.join(', ') + ' WHERE event_id = ?', values);
      }
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 【状态流转校验工具】校验赛事状态流转合法性
   * 合法流向：0(创建中)→1(报名中)→2(报名截止)→3(分组锁定)→4(对战中)→5(已归档)
   * 仅允许正向顺序流转（不允许跳跃或回退）
   * @param {number} currentStatus - 当前状态
   * @param {number} targetStatus  - 目标状态
   * @returns {{ valid: boolean, error: string }}
   */
  function validateStatusTransition(currentStatus, targetStatus) {
    if (currentStatus === targetStatus) {
      return { valid: false, error: '赛事已是该状态，无需重复操作' };
    }
    // 仅允许向后流转到下一个状态（严格顺序：0→1→2→3→4→5）
    if (targetStatus === currentStatus + 1) {
      return { valid: true, error: '' };
    }
    return { valid: false, error: '赛事状态流转不合法，仅允许按顺序依次推进（创建中→报名中→报名截止→分组锁定→对战中→已归档）' };
  }

  /**
   * 获取赛事状态中文名称（用于提示信息）
   */
  function getStatusName(status) {
    const map = { 0: '创建中', 1: '报名中', 2: '报名截止', 3: '分组锁定', 4: '对战中', 5: '已归档' };
    return map[status] || '未知';
  }

  /**
   * 更新赛事状态（admin/super_admin）
   * PUT /api/events/:eventId/status
   * Body: { eventStatus }  - 0创建中/1报名中/2报名截止/3分组锁定/4对战中/5已归档
   * - 增加状态流转合法性校验：仅允许正向顺序流转
   */
  app.put('/api/events/:eventId/status', async (req, res) => {
    try {
      if (!await assertAdmin(req, res)) return;
      const { eventId } = req.params;
      const event = await validateEvent(pool, eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });

      const { eventStatus } = req.body;
      if (eventStatus === undefined || eventStatus < 0 || eventStatus > 5) {
        return res.status(400).json({ success: false, error: '无效的赛事状态，有效值0-5' });
      }

      // 【状态流转校验】校验从当前状态流转到目标状态是否合法
      const transition = validateStatusTransition(event.event_status, eventStatus);
      if (!transition.valid) {
        return res.status(400).json({ success: false, error: transition.error });
      }

      await pool.query(
        'UPDATE dota2_events SET event_status = ?, updated_at = ? WHERE event_id = ?',
        [eventStatus, Date.now(), eventId]
      );
      res.json({
        success: true,
        data: {
          fromStatus: event.event_status,
          fromStatusName: getStatusName(event.event_status),
          toStatus: eventStatus,
          toStatusName: getStatusName(eventStatus)
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 删除赛事（仅 super_admin，且只能删除未归档赛事）
   * DELETE /api/events/:eventId
   */
  app.delete('/api/events/:eventId', async (req, res) => {
    try {
      if (!await assertSuperAdmin(req, res, getCallerRole)) return;
      const { eventId } = req.params;
      const event = await validateEvent(pool, eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });
      if (event.is_archived === 1) {
        return res.status(403).json({ success: false, error: '已归档赛事不可删除' });
      }

      await pool.query('DELETE FROM dota2_events WHERE event_id = ?', [eventId]);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ════════════════════════════════════════════════════════════
  // 2. 报名管理模块（dota2_event_signup）
  // ════════════════════════════════════════════════════════════
  //
  // 【核心校验逻辑说明】
  // - 自主报名：通过 openid → nick_name → wx_nickname 精确匹配选手档案
  //   ① 唯一匹配 → 自动关联 player_id 创建报名记录
  //   ② 多条匹配 → 返回错误「昵称匹配到多个选手档案，请联系管理员手动添加报名」
  //   ③ 无匹配 → 返回错误「未找到对应选手档案，请先完善选手信息后再报名」
  // - 管理员添加：无昵称校验，直接通过 player_id 或搜索后批量添加
  // - 所有操作绑定 event_id 做数据隔离，禁止跨赛事操作
  // - 所有管理员操作记录 operator_id，便于操作留痕

  /**
   * 【报名状态前置校验工具】
   * 校验赛事当前状态是否允许报名操作
   * @returns {{ valid: boolean, error: string, event: object|null }}
   */
  async function validateSignupEvent(pool, eventId) {
    const event = await validateEvent(pool, eventId);
    if (!event) return { valid: false, error: '赛事不存在', event: null };
    if (event.event_status !== 1) {
      // 根据不同状态给出具体提示
      const statusMap = { 0: '赛事尚未开启报名', 2: '报名已截止', 3: '赛事已进入分组阶段', 4: '赛事对战中', 5: '赛事已归档' };
      const msg = statusMap[event.event_status] || '当前赛事不在报名阶段';
      return { valid: false, error: msg, event };
    }
    return { valid: true, error: '', event };
  }

  /**
   * 【昵称匹配校验工具】通过用户 nick_name 精确匹配选手档案
   * 用于自主报名时的身份校验
   * @param {string} nickName - 用户设置的微信昵称（来自 dota2_users.nick_name）
   * @returns {{ success: boolean, code: string, playerId: string|null, message: string }}
   */
  async function matchPlayerByNickname(pool, nickName) {
    if (!nickName || !nickName.trim()) {
      return { success: false, code: 'NICKNAME_EMPTY', playerId: null, message: '请先设置您的昵称后再报名' };
    }

    // 精确匹配 wx_nickname（区分大小写，保证身份唯一性）
    const [rows] = await pool.query(
      'SELECT id, wx_nickname, calibrate_rank_name, calibrate_rank_star FROM dota2_players WHERE wx_nickname = ?',
      [nickName.trim()]
    );

    if (rows.length === 0) {
      return {
        success: false, code: 'PLAYER_NOT_FOUND', playerId: null,
        message: '未找到对应选手档案，请先完善选手信息后再报名'
      };
    }

    if (rows.length > 1) {
      return {
        success: false, code: 'MULTIPLE_MATCH', playerId: null,
        message: '昵称匹配到多个选手档案，请联系管理员手动添加报名'
      };
    }

    // 唯一匹配成功
    return {
      success: true, code: 'MATCH_OK', playerId: rows[0].id,
      message: '',
      playerInfo: { wxNickname: rows[0].wx_nickname, rankName: rows[0].calibrate_rank_name, rankStar: rows[0].calibrate_rank_star }
    };
  }

  /**
   * 获取某赛事的报名列表（含选手信息）
   * GET /api/events/:eventId/signups?status=1&page=1&pageSize=20
   * - 普通用户仅可查看有效报名(status=1)
   * - 管理员可查看全部（含已取消）
   */
  app.get('/api/events/:eventId/signups', async (req, res) => {
    try {
      const { eventId } = req.params;
      const event = await validateEvent(pool, eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });

      // 权限判断：普通用户只能看有效报名，管理员看全部
      const openid = req.query.openid || '';
      const role = await getCallerRole(openid);
      const isAdmin = role === 'admin' || role === 'super_admin';

      const { status, page, pageSize } = req.query;
      let where = ' WHERE s.event_id = ?';
      const params = [eventId];

      if (!isAdmin) {
        // 普通用户只看有效报名
        where += ' AND s.signup_status = 1';
      } else if (status !== undefined && status !== '') {
        where += ' AND s.signup_status = ?';
        params.push(parseInt(status));
      }

      const p = parseInt(page) || 1;
      const ps = parseInt(pageSize) || 50;
      const sql = `
        SELECT s.*, p.wx_nickname, p.calibrate_rank_name, p.calibrate_rank_star, p.avatar_url, p.calibrate_mmr
        FROM dota2_event_signup s
        LEFT JOIN dota2_players p ON s.player_id = p.id
        ${where} ORDER BY s.created_at DESC LIMIT ? OFFSET ?
      `;
      const countSql = `SELECT COUNT(*) as total FROM dota2_event_signup s ${where}`;

      const [rows] = await pool.query(sql, [...params, ps, (p - 1) * ps]);
      const [[{ total }]] = await pool.query(countSql, params);

      res.json({ success: true, data: rows, total, page: p, pageSize: ps });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 查询当前用户在指定赛事的报名状态
   * GET /api/events/:eventId/my-signup
   * - 通过 openid → nick_name → wx_nickname 匹配找到选手 → 查询报名记录
   * - 返回：是否已报名、报名详情（已取消也返回历史记录）
   */
  app.get('/api/events/:eventId/my-signup', async (req, res) => {
    try {
      const { eventId } = req.params;
      const event = await validateEvent(pool, eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });

      const openid = req.query.openid || '';
      // 通过 openid 获取用户设置的 nick_name
      const [userRows] = await pool.query('SELECT nick_name FROM dota2_users WHERE openid = ?', [openid]);
      const userNick = (userRows.length && userRows[0].nick_name) ? userRows[0].nick_name : '';

      if (!userNick) {
        return res.json({ success: true, data: { signedUp: false, reason: '未设置昵称' } });
      }

      // 精确匹配选手
      const matchResult = await matchPlayerByNickname(pool, userNick);
      if (!matchResult.success) {
        return res.json({ success: true, data: { signedUp: false, reason: matchResult.message } });
      }

      // 查询报名记录（含已取消，取最新一条）
      const [signups] = await pool.query(
        'SELECT * FROM dota2_event_signup WHERE event_id = ? AND player_id = ? ORDER BY created_at DESC LIMIT 1',
        [eventId, matchResult.playerId]
      );

      if (signups.length === 0) {
        return res.json({ success: true, data: { signedUp: false, playerId: matchResult.playerId, playerInfo: matchResult.playerInfo } });
      }

      const signup = signups[0];
      res.json({
        success: true,
        data: {
          signedUp: signup.signup_status === 1,
          signupId: signup.signup_id,
          playerId: signup.player_id,
          signupType: signup.signup_type === 1 ? 'admin_add' : 'self_signup',
          signupStatus: signup.signup_status,
          signupTime: signup.created_at,
          playerInfo: matchResult.playerInfo,
          // 如果之前取消过，返回提示
          wasCancelled: signup.signup_status === 0
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 【核心接口】选手自主报名（user 可操作，强制昵称匹配校验）
   * POST /api/events/:eventId/signups
   * - 不需要传 playerId，后端通过 openid → nick_name → wx_nickname 自动匹配
   * - 三步校验链：赛事状态检查 → 昵称匹配选手 → 重复报名检查
   * - 错误码对照：
   *   EVENT_NOT_OPEN     赛事不在报名阶段
   *   NICKNAME_EMPTY     用户未设置昵称
   *   PLAYER_NOT_FOUND   未匹配到选手档案
   *   MULTIPLE_MATCH     匹配到多条选手记录
   *   ALREADY_SIGNED     已报名当前赛事
   */
  app.post('/api/events/:eventId/signups', async (req, res) => {
    try {
      const { eventId } = req.params;

      // 【校验1】赛事状态：仅报名中(eventStatus=1)允许操作
      const statusCheck = await validateSignupEvent(pool, eventId);
      if (!statusCheck.valid) {
        return res.status(400).json({ success: false, error: statusCheck.error, code: 'EVENT_NOT_OPEN' });
      }

      const openid = req.query.openid || '';

      // 【校验2】昵称匹配：通过 openid 获取 nick_name，精确匹配选手档案
      const [userRows] = await pool.query('SELECT nick_name FROM dota2_users WHERE openid = ?', [openid]);
      const userNick = (userRows.length && userRows[0].nick_name) ? userRows[0].nick_name : '';
      const matchResult = await matchPlayerByNickname(pool, userNick);

      if (!matchResult.success) {
        return res.status(400).json({
          success: false,
          error: matchResult.message,
          code: matchResult.code
        });
      }

      const playerId = matchResult.playerId;

      // 【校验3】重复报名检查（同一赛事同一选手不可重复报名）
      const [existing] = await pool.query(
        'SELECT signup_id FROM dota2_event_signup WHERE event_id = ? AND player_id = ? AND signup_status = 1',
        [eventId, playerId]
      );
      if (existing.length > 0) {
        return res.status(400).json({
          success: false,
          error: '您已报名当前赛事',
          code: 'ALREADY_SIGNED'
        });
      }

      // 【执行报名】创建报名记录，signup_type=0(自主报名)，记录 operator_id
      const signupId = genId();
      const now = Date.now();
      await pool.query(
        'INSERT INTO dota2_event_signup (signup_id, event_id, player_id, signup_type, signup_status, operator_id, created_at) VALUES (?, ?, ?, 0, 1, ?, ?)',
        [signupId, eventId, playerId, openid, now]
      );

      res.json({
        success: true,
        data: {
          signupId,
          playerId,
          playerInfo: matchResult.playerInfo,
          signupType: 'self_signup',
          message: '报名成功'
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 管理员添加报名（admin/super_admin，无需昵称匹配校验）
   * POST /api/events/:eventId/signups/admin
   * Body: { playerId }
   * - signup_type=1 标记为管理员添加
   * - 记录 operator_id 为当前操作管理员 openid
   */
  app.post('/api/events/:eventId/signups/admin', async (req, res) => {
    try {
      if (!await assertAdmin(req, res)) return;
      const { eventId } = req.params;

      // 校验赛事存在（管理员添加不严格要求报名中状态，可在任意阶段操作）
      const event = await validateEvent(pool, eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });

      const openid = req.query.openid || '';
      const { playerId } = req.body;
      if (!playerId) return res.status(400).json({ success: false, error: '选手ID不能为空' });

      // 校验选手是否存在
      const [players] = await pool.query(
        'SELECT id, wx_nickname, calibrate_rank_name, calibrate_rank_star FROM dota2_players WHERE id = ?',
        [playerId]
      );
      if (!players.length) return res.status(404).json({ success: false, error: '选手不存在' });

      // 检查是否已报名
      const [existing] = await pool.query(
        'SELECT signup_id FROM dota2_event_signup WHERE event_id = ? AND player_id = ? AND signup_status = 1',
        [eventId, playerId]
      );
      if (existing.length > 0) {
        return res.status(400).json({ success: false, error: '该选手已报名本赛事', code: 'ALREADY_SIGNED' });
      }

      try {
        const signupId = genId();
        const now = Date.now();
        await pool.query(
          'INSERT INTO dota2_event_signup (signup_id, event_id, player_id, signup_type, signup_status, operator_id, created_at) VALUES (?, ?, ?, 1, 1, ?, ?)',
          [signupId, eventId, playerId, openid, now]
        );
        res.json({
          success: true,
          data: {
            signupId,
            playerId,
            playerInfo: { wxNickname: players[0].wx_nickname, rankName: players[0].calibrate_rank_name, rankStar: players[0].calibrate_rank_star },
            signupType: 'admin_add'
          }
        });
      } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') {
          return res.status(400).json({ success: false, error: '该选手已报名本赛事', code: 'ALREADY_SIGNED' });
        }
        throw e;
      }
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 管理员批量添加报名（admin/super_admin）
   * POST /api/events/:eventId/signups/batch
   * Body: { playerIds: string[] }
   * - 逐条创建报名记录，返回成功/失败明细
   * - 记录 operator_id 为当前操作管理员 openid
   */
  app.post('/api/events/:eventId/signups/batch', async (req, res) => {
    try {
      if (!await assertAdmin(req, res)) return;
      const { eventId } = req.params;
      const event = await validateEvent(pool, eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });

      const openid = req.query.openid || '';
      const { playerIds } = req.body;
      if (!playerIds || !playerIds.length) {
        return res.status(400).json({ success: false, error: '选手ID列表不能为空' });
      }

      const results = { success: 0, skipped: 0, failed: 0, details: [] };
      const now = Date.now();

      for (const playerId of playerIds) {
        try {
          // 检查是否已报名
          const [existing] = await pool.query(
            'SELECT signup_id FROM dota2_event_signup WHERE event_id = ? AND player_id = ? AND signup_status = 1',
            [eventId, playerId]
          );
          if (existing.length > 0) {
            results.skipped++;
            results.details.push({ playerId, status: 'skipped', reason: '已报名' });
            continue;
          }

          const signupId = genId();
          await pool.query(
            'INSERT INTO dota2_event_signup (signup_id, event_id, player_id, signup_type, signup_status, operator_id, created_at) VALUES (?, ?, ?, 1, 1, ?, ?)',
            [signupId, eventId, playerId, openid, now]
          );
          results.success++;
          results.details.push({ playerId, status: 'success', signupId });
        } catch (e) {
          results.failed++;
          results.details.push({ playerId, status: 'failed', reason: e.code === 'ER_DUP_ENTRY' ? '重复报名' : e.message });
        }
      }

      res.json({ success: true, data: results });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 取消报名（用户取消自己 / 管理员取消任意）
   * DELETE /api/events/:eventId/signups/:signupId
   * - 软删除：signup_status 设为 0，不物理删除记录
   * - 校验赛事状态为「报名中」(eventStatus=1)
   * - 普通用户只能取消自己的报名（通过昵称匹配验证身份）
   * - 管理员可取消任意报名
   * - 记录操作人 operator_id
   */
  app.delete('/api/events/:eventId/signups/:signupId', async (req, res) => {
    try {
      const { eventId, signupId } = req.params;

      // 【校验1】赛事状态：取消报名仅允许在报名中阶段
      const statusCheck = await validateSignupEvent(pool, eventId);
      if (!statusCheck.valid) {
        return res.status(400).json({ success: false, error: statusCheck.error, code: 'EVENT_NOT_OPEN' });
      }

      const openid = req.query.openid || '';
      const role = await getCallerRole(openid);
      const isAdmin = role === 'admin' || role === 'super_admin';

      // 查询报名记录
      const [signups] = await pool.query(
        'SELECT * FROM dota2_event_signup WHERE signup_id = ? AND event_id = ?',
        [signupId, eventId]
      );
      if (!signups.length) return res.status(404).json({ success: false, error: '报名记录不存在' });
      if (signups[0].signup_status === 0) {
        return res.status(400).json({ success: false, error: '该报名记录已取消' });
      }

      // 【校验2】普通用户需验证身份：通过 nick_name 匹配选手的 wx_nickname
      if (!isAdmin) {
        const [userRows] = await pool.query('SELECT nick_name FROM dota2_users WHERE openid = ?', [openid]);
        const userNick = (userRows.length && userRows[0].nick_name) ? userRows[0].nick_name : '';
        const [playerRows] = await pool.query('SELECT wx_nickname FROM dota2_players WHERE id = ?', [signups[0].player_id]);
        if (!playerRows.length || playerRows[0].wx_nickname !== userNick) {
          return res.status(403).json({ success: false, error: '仅可取消自己的报名', code: 'NOT_OWNER' });
        }
      }

      // 【执行取消】软删除：signup_status = 0，记录操作人
      await pool.query(
        'UPDATE dota2_event_signup SET signup_status = 0, operator_id = ? WHERE signup_id = ? AND event_id = ?',
        [openid, signupId, eventId]
      );
      res.json({ success: true, data: { signupId, message: '已取消报名' } });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 选手检索（通过昵称模糊搜索，供报名管理页面使用）
   * GET /api/search/players?keyword=xxx&limit=20
   * - 使用独立路由前缀避免与 /api/players/:id 冲突
   * - 返回字段包含 id, wx_nickname, calibrate_rank_name, calibrate_rank_star, calibrate_mmr, avatar_url
   */
  app.get('/api/search/players', async (req, res) => {
    try {
      const { keyword, limit } = req.query;
      if (!keyword) return res.json({ success: true, data: [] });

      // 模糊搜索 wx_nickname
      const [rows] = await pool.query(
        'SELECT id, wx_nickname, game_id, calibrate_rank_name, calibrate_rank_star, calibrate_mmr, calibrate_rank_sort, avatar_url, good_at_positions FROM dota2_players WHERE wx_nickname LIKE ? ORDER BY calibrate_rank_sort DESC LIMIT ?',
        ['%' + keyword + '%', parseInt(limit) || 20]
      );
      res.json({ success: true, data: rows });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ════════════════════════════════════════════════════════════
  // 3. 队伍管理模块（dota2_event_teams）
  // ════════════════════════════════════════════════════════════

  /**
   * 获取某赛事队伍列表（含队员详情）
   * GET /api/events/:eventId/teams
   * - 所有用户可查看
   */
  app.get('/api/events/:eventId/teams', async (req, res) => {
    try {
      const { eventId } = req.params;
      const event = await validateEvent(pool, eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });

      const [rows] = await pool.query(
        'SELECT * FROM dota2_event_teams WHERE event_id = ? ORDER BY total_mmr DESC',
        [eventId]
      );

      // 为每个队伍展开队员信息
      const teams = [];
      for (const team of rows) {
        let playerIds = [];
        try {
          playerIds = team.player_ids ? JSON.parse(team.player_ids) : [];
        } catch (_) {
          playerIds = [];
        }
        const players = playerIds.length ? await getPlayersByIds(pool, playerIds) : [];
        // 队长信息
        const [captains] = team.captain_id
          ? await pool.query('SELECT id, wx_nickname, avatar_url FROM dota2_players WHERE id = ?', [team.captain_id])
          : [[]];
        teams.push({
          ...team,
          players: players,
          captain: captains.length ? captains[0] : null,
        });
      }

      res.json({ success: true, data: teams });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 创建队伍（admin/super_admin）
   * POST /api/events/:eventId/teams
   * Body: { teamName, captainId, playerIds }
   * - playerIds: 选手ID数组，包含队长
   * - total_mmr 由后端自动累加计算
   */
  app.post('/api/events/:eventId/teams', async (req, res) => {
    try {
      if (!await assertAdmin(req, res)) return;
      const { eventId } = req.params;
      const event = await validateEvent(pool, eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });

      const { teamName, captainId, playerIds } = req.body;
      if (!teamName) return res.status(400).json({ success: false, error: '队伍名称不能为空' });
      if (!playerIds || !playerIds.length) return res.status(400).json({ success: false, error: '队员不能为空' });

      // 后端计算 total_mmr（不信任前端传值）
      let totalMmr = 0;
      try {
        const [mmrRows] = await pool.query(
          'SELECT COALESCE(SUM(calibrate_mmr), 0) as total FROM dota2_players WHERE id IN (?)',
          [playerIds]
        );
        totalMmr = mmrRows[0].total || 0;
      } catch (_) { /* MMR 计算失败不影响建队 */ }

      const teamId = genId();
      await pool.query(
        'INSERT INTO dota2_event_teams (team_id, event_id, team_name, captain_id, player_ids, total_mmr, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [teamId, eventId, teamName, captainId || '', JSON.stringify(playerIds), totalMmr, Date.now(), Date.now()]
      );

      res.json({ success: true, data: { teamId, totalMmr } });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 编辑队伍（admin/super_admin）
   * PUT /api/events/:eventId/teams/:teamId
   * Body: { teamName, captainId, playerIds }
   */
  app.put('/api/events/:eventId/teams/:teamId', async (req, res) => {
    try {
      if (!await assertAdmin(req, res)) return;
      const { eventId, teamId } = req.params;
      const [teams] = await pool.query(
        'SELECT * FROM dota2_event_teams WHERE team_id = ? AND event_id = ?',
        [teamId, eventId]
      );
      if (!teams.length) return res.status(404).json({ success: false, error: '队伍不存在' });

      const { teamName, captainId, playerIds } = req.body;
      const sets = [];
      const values = [];

      if (teamName !== undefined) { sets.push('team_name = ?'); values.push(teamName); }
      if (captainId !== undefined) { sets.push('captain_id = ?'); values.push(captainId); }
      if (playerIds !== undefined) {
        sets.push('player_ids = ?');
        values.push(JSON.stringify(playerIds));

        // 重新计算 total_mmr
        let totalMmr = 0;
        try {
          const [mmrRows] = await pool.query(
            'SELECT COALESCE(SUM(calibrate_mmr), 0) as total FROM dota2_players WHERE id IN (?)',
            [playerIds]
          );
          totalMmr = mmrRows[0].total || 0;
        } catch (_) {}
        sets.push('total_mmr = ?');
        values.push(totalMmr);
      }

      if (sets.length > 0) {
        sets.push('updated_at = ?');
        values.push(Date.now(), teamId, eventId);
        await pool.query(
          'UPDATE dota2_event_teams SET ' + sets.join(', ') + ' WHERE team_id = ? AND event_id = ?',
          values
        );
      }
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 删除队伍（admin/super_admin）
   * DELETE /api/events/:eventId/teams/:teamId
   */
  app.delete('/api/events/:eventId/teams/:teamId', async (req, res) => {
    try {
      if (!await assertAdmin(req, res)) return;
      const { eventId, teamId } = req.params;
      const [teams] = await pool.query(
        'SELECT * FROM dota2_event_teams WHERE team_id = ? AND event_id = ?',
        [teamId, eventId]
      );
      if (!teams.length) return res.status(404).json({ success: false, error: '队伍不存在' });

      await pool.query('DELETE FROM dota2_event_teams WHERE team_id = ? AND event_id = ?', [teamId, eventId]);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ════════════════════════════════════════════════════════════
  // 4. 对战管理模块（dota2_event_matches）
  // ════════════════════════════════════════════════════════════

  /**
   * 获取某赛事对战列表（按轮次分组）
   * GET /api/events/:eventId/matches?round=1
   * - 所有用户可查看
   */
  app.get('/api/events/:eventId/matches', async (req, res) => {
    try {
      const { eventId } = req.params;
      const event = await validateEvent(pool, eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });

      const { round } = req.query;
      let where = ' WHERE m.event_id = ?';
      const params = [eventId];

      if (round !== undefined && round !== '') {
        where += ' AND m.round_num = ?';
        params.push(parseInt(round));
      }

      const sql = `
        SELECT m.*,
               ta.team_name as team_a_name, tb.team_name as team_b_name,
               tw.team_name as winner_name
        FROM dota2_event_matches m
        LEFT JOIN dota2_event_teams ta ON m.team_a_id = ta.team_id
        LEFT JOIN dota2_event_teams tb ON m.team_b_id = tb.team_id
        LEFT JOIN dota2_event_teams tw ON m.winner_id = tw.team_id
        ${where} ORDER BY m.round_num ASC, m.created_at ASC
      `;

      const [rows] = await pool.query(sql, params);
      res.json({ success: true, data: rows });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 创建对战记录（admin/super_admin）
   * POST /api/events/:eventId/matches
   * Body: { roundNum, teamAId, teamBId }
   * - 默认 match_status=0（未开始）
   */
  app.post('/api/events/:eventId/matches', async (req, res) => {
    try {
      if (!await assertAdmin(req, res)) return;
      const { eventId } = req.params;
      const event = await validateEvent(pool, eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });

      const { roundNum, teamAId, teamBId } = req.body;
      if (roundNum === undefined) return res.status(400).json({ success: false, error: '轮次序号不能为空' });
      if (!teamAId || !teamBId) return res.status(400).json({ success: false, error: '双方队伍ID不能为空' });

      const matchId = genId();
      await pool.query(
        'INSERT INTO dota2_event_matches (match_id, event_id, round_num, team_a_id, team_b_id, match_status, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
        [matchId, eventId, roundNum, teamAId, teamBId, Date.now()]
      );

      res.json({ success: true, data: { matchId } });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 判定对战结果（admin/super_admin）
   * PUT /api/events/:eventId/matches/:matchId/judge
   * Body: { winnerId }
   * - 记录判定人和判定时间
   * - match_status 自动设为 2（已结束）
   */
  app.put('/api/events/:eventId/matches/:matchId/judge', async (req, res) => {
    try {
      if (!await assertAdmin(req, res)) return;
      const { eventId, matchId } = req.params;

      const [matches] = await pool.query(
        'SELECT * FROM dota2_event_matches WHERE match_id = ? AND event_id = ?',
        [matchId, eventId]
      );
      if (!matches.length) return res.status(404).json({ success: false, error: '对战记录不存在' });

      const { winnerId } = req.body;
      if (!winnerId) return res.status(400).json({ success: false, error: '胜方队伍ID不能为空' });

      await pool.query(
        'UPDATE dota2_event_matches SET winner_id = ?, match_status = 2, judge_id = ?, judge_time = ? WHERE match_id = ? AND event_id = ?',
        [winnerId, req.query.openid || '', Date.now(), matchId, eventId]
      );
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 删除对战记录（admin/super_admin）
   * DELETE /api/events/:eventId/matches/:matchId
   */
  app.delete('/api/events/:eventId/matches/:matchId', async (req, res) => {
    try {
      if (!await assertAdmin(req, res)) return;
      const { eventId, matchId } = req.params;
      const [matches] = await pool.query(
        'SELECT * FROM dota2_event_matches WHERE match_id = ? AND event_id = ?',
        [matchId, eventId]
      );
      if (!matches.length) return res.status(404).json({ success: false, error: '对战记录不存在' });

      await pool.query('DELETE FROM dota2_event_matches WHERE match_id = ? AND event_id = ?', [matchId, eventId]);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ════════════════════════════════════════════════════════════
  // 5. 名次管理模块（dota2_event_ranks）
  // ════════════════════════════════════════════════════════════

  /**
   * 获取某赛事名次排行
   * GET /api/events/:eventId/ranks
   * - 所有用户可查看，按名次升序
   */
  app.get('/api/events/:eventId/ranks', async (req, res) => {
    try {
      const { eventId } = req.params;
      const event = await validateEvent(pool, eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });

      const [rows] = await pool.query(
        `SELECT r.*, t.team_name, t.total_mmr
         FROM dota2_event_ranks r
         LEFT JOIN dota2_event_teams t ON r.team_id = t.team_id
         WHERE r.event_id = ? ORDER BY r.rank_num ASC`,
        [eventId]
      );

      res.json({ success: true, data: rows });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 设置名次（admin/super_admin）
   * POST /api/events/:eventId/ranks
   * Body: { rankNum, teamId }
   * - 联合唯一索引防止同名次重复
   */
  app.post('/api/events/:eventId/ranks', async (req, res) => {
    try {
      if (!await assertAdmin(req, res)) return;
      const { eventId } = req.params;
      const event = await validateEvent(pool, eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });

      const { rankNum, teamId } = req.body;
      if (rankNum === undefined || rankNum < 1) return res.status(400).json({ success: false, error: '排名序号无效' });
      if (!teamId) return res.status(400).json({ success: false, error: '队伍ID不能为空' });

      try {
        const rankId = genId();
        await pool.query(
          'INSERT INTO dota2_event_ranks (rank_id, event_id, rank_num, team_id, operator_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          [rankId, eventId, rankNum, teamId, req.query.openid || '', Date.now()]
        );
        res.json({ success: true, data: { rankId } });
      } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') {
          return res.status(400).json({ success: false, error: '该名次已被占用，请先删除旧的排名记录' });
        }
        throw e;
      }
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 更新名次（admin/super_admin）
   * PUT /api/events/:eventId/ranks/:rankId
   * Body: { rankNum, teamId }
   */
  app.put('/api/events/:eventId/ranks/:rankId', async (req, res) => {
    try {
      if (!await assertAdmin(req, res)) return;
      const { eventId, rankId } = req.params;

      const [ranks] = await pool.query(
        'SELECT * FROM dota2_event_ranks WHERE rank_id = ? AND event_id = ?',
        [rankId, eventId]
      );
      if (!ranks.length) return res.status(404).json({ success: false, error: '名次记录不存在' });

      const { rankNum, teamId } = req.body;
      const sets = [];
      const values = [];

      if (rankNum !== undefined) { sets.push('rank_num = ?'); values.push(rankNum); }
      if (teamId !== undefined) { sets.push('team_id = ?'); values.push(teamId); }

      if (sets.length > 0) {
        sets.push('operator_id = ?');
        values.push(req.query.openid || '', rankId, eventId);
        await pool.query(
          'UPDATE dota2_event_ranks SET ' + sets.join(', ') + ' WHERE rank_id = ? AND event_id = ?',
          values
        );
      }
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 删除名次记录（admin/super_admin）
   * DELETE /api/events/:eventId/ranks/:rankId
   */
  app.delete('/api/events/:eventId/ranks/:rankId', async (req, res) => {
    try {
      if (!await assertAdmin(req, res)) return;
      const { eventId, rankId } = req.params;
      await pool.query('DELETE FROM dota2_event_ranks WHERE rank_id = ? AND event_id = ?', [rankId, eventId]);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ════════════════════════════════════════════════════════════
  // 6. 赛事章程模块（dota2_event_rules）
  // ════════════════════════════════════════════════════════════

  /**
   * 获取章程列表（公开）
   * GET /api/rules?eventId=&status=1&page=1&pageSize=20
   * - eventId 为空时返回通用章程(event_id IS NULL)
   * - status 筛选：0草稿/1已发布（普通用户只能看已发布）
   */
  app.get('/api/rules', async (req, res) => {
    try {
      const openid = req.query.openid || '';
      const role = await getCallerRole(openid);
      const isAdmin = role === 'admin' || role === 'super_admin';

      const { eventId, status, page, pageSize } = req.query;
      let where = ' WHERE 1=1';
      const params = [];

      // 按赛事筛选：支持通用章程（event_id IS NULL）和特定赛事章程
      if (eventId !== undefined && eventId !== '') {
        where += ' AND event_id = ?';
        params.push(eventId);
      }

      // 普通用户只能看已发布章程
      if (!isAdmin) {
        where += ' AND rule_status = 1';
      } else if (status !== undefined && status !== '') {
        where += ' AND rule_status = ?';
        params.push(parseInt(status));
      }

      const p = parseInt(page) || 1;
      const ps = parseInt(pageSize) || 20;
      const sql = 'SELECT * FROM dota2_event_rules' + where + ' ORDER BY version DESC, created_at DESC LIMIT ? OFFSET ?';
      const countSql = 'SELECT COUNT(*) as total FROM dota2_event_rules' + where;

      const [rows] = await pool.query(sql, [...params, ps, (p - 1) * ps]);
      const [[{ total }]] = await pool.query(countSql, params);

      res.json({ success: true, data: rows, total, page: p, pageSize: ps });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 获取单条章程详情（公开）
   * GET /api/rules/:ruleId
   */
  app.get('/api/rules/:ruleId', async (req, res) => {
    try {
      const { ruleId } = req.params;
      const [rows] = await pool.query('SELECT * FROM dota2_event_rules WHERE rule_id = ?', [ruleId]);
      if (!rows.length) return res.status(404).json({ success: false, error: '章程不存在' });
      res.json({ success: true, data: rows[0] });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 获取某赛事的章程
   * GET /api/events/:eventId/rules
   * - 优先返回绑定该赛事的章程，没有则返回通用章程
   */
  app.get('/api/events/:eventId/rules', async (req, res) => {
    try {
      const { eventId } = req.params;
      const event = await validateEvent(pool, eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });

      // 先查绑定该赛事的已发布章程
      const [rows] = await pool.query(
        'SELECT * FROM dota2_event_rules WHERE event_id = ? AND rule_status = 1 ORDER BY version DESC LIMIT 1',
        [eventId]
      );
      if (rows.length) return res.json({ success: true, data: rows[0] });

      // 查通用章程
      const [general] = await pool.query(
        'SELECT * FROM dota2_event_rules WHERE event_id IS NULL AND rule_status = 1 ORDER BY version DESC LIMIT 1'
      );
      res.json({ success: true, data: general.length ? general[0] : null });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 创建章程（admin/super_admin）
   * POST /api/rules
   * Body: { eventId, ruleTitle, ruleContent, version }
   * - eventId 可选，不传则创建通用章程
   * - 默认 rule_status=0（草稿），需发布后前端才展示
   */
  app.post('/api/rules', async (req, res) => {
    try {
      if (!await assertAdmin(req, res)) return;

      const { eventId, ruleTitle, ruleContent, version } = req.body;
      if (!ruleTitle) return res.status(400).json({ success: false, error: '章程标题不能为空' });
      if (!ruleContent) return res.status(400).json({ success: false, error: '章程内容不能为空' });

      // 如果指定了 eventId，校验赛事存在
      if (eventId) {
        const event = await validateEvent(pool, eventId);
        if (!event) return res.status(404).json({ success: false, error: '关联赛事不存在' });
      }

      const ruleId = genId();
      await pool.query(
        'INSERT INTO dota2_event_rules (rule_id, event_id, rule_title, rule_content, version, rule_status, creator_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)',
        [ruleId, eventId || null, ruleTitle, ruleContent, version || 1, req.query.openid || '', Date.now(), Date.now()]
      );

      res.json({ success: true, data: { ruleId } });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 编辑章程（admin/super_admin）
   * PUT /api/rules/:ruleId
   * Body: { ruleTitle, ruleContent, version, ruleStatus }
   */
  app.put('/api/rules/:ruleId', async (req, res) => {
    try {
      if (!await assertAdmin(req, res)) return;
      const { ruleId } = req.params;
      const [rules] = await pool.query('SELECT * FROM dota2_event_rules WHERE rule_id = ?', [ruleId]);
      if (!rules.length) return res.status(404).json({ success: false, error: '章程不存在' });

      const { ruleTitle, ruleContent, version, ruleStatus } = req.body;
      const sets = [];
      const values = [];

      if (ruleTitle !== undefined) { sets.push('rule_title = ?'); values.push(ruleTitle); }
      if (ruleContent !== undefined) { sets.push('rule_content = ?'); values.push(ruleContent); }
      if (version !== undefined) { sets.push('version = ?'); values.push(version); }
      if (ruleStatus !== undefined) { sets.push('rule_status = ?'); values.push(ruleStatus); }

      if (sets.length > 0) {
        sets.push('updated_at = ?');
        values.push(Date.now(), ruleId);
        await pool.query('UPDATE dota2_event_rules SET ' + sets.join(', ') + ' WHERE rule_id = ?', values);
      }
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 删除章程（admin/super_admin）
   * DELETE /api/rules/:ruleId
   */
  app.delete('/api/rules/:ruleId', async (req, res) => {
    try {
      if (!await assertAdmin(req, res)) return;
      const { ruleId } = req.params;
      await pool.query('DELETE FROM dota2_event_rules WHERE rule_id = ?', [ruleId]);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

};
