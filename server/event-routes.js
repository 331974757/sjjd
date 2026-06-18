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

// 均衡分队引擎
const { allocateTeams } = require('./utils/team-allocation');
// 段位分值计算（用于保存队伍时计算等效 MMR）
const { getScore } = require('./utils/rank-score');
// 统一权限/状态校验工具（共享 validateStatusTransition, STATUS_NAMES 等）
const { validateStatusTransition, STATUS_NAMES } = require('./utils/auth');

const crypto = require('crypto');

/**
 * 安全的随机 ID 生成器
 * 格式：32位十六进制随机字符串
 */
function genId() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * 安全回滚辅助：捕获回滚异常，避免掩盖原始错误
 * @param {Object} conn - 数据库连接对象
 * @param {string} ctx - 上下文标识（用于日志）
 */
async function safeRollback(conn, ctx) {
  try {
    await conn.rollback();
  } catch (rollbackErr) {
    console.error(`[tx:rollback:${ctx}] 回滚失败:`, rollbackErr.message);
  }
}

/**
 * 【归档表辅助】根据是否归档返回对应表名
 * @param {string} baseName - 基础表名（如 'dota2_events'）
 * @param {boolean} isArchived - 是否已归档
 * @returns {string} 归档表名（_his 后缀）或原表名
 */
function tableFor(baseName, isArchived) {
  return isArchived ? baseName + '_his' : baseName;
}

/**
 * 【归档迁移辅助】生成 INSERT IGNORE INTO ... SELECT 语句将数据从主表迁移到归档表
 * 使用 INSERT IGNORE 防止并发归档时的重复键冲突（TOCTOU 防御）
 * @param {string} baseName - 基础表名
 * @returns {string} INSERT IGNORE INTO {baseName}_his SELECT * FROM {baseName} WHERE event_id = ?
 */
function migrateSql(baseName) {
  return `INSERT IGNORE INTO ${baseName}_his SELECT * FROM ${baseName} WHERE event_id = ?`;
}

/**
 * 【归档迁移辅助】生成 DELETE 语句清理主表中的已归档数据
 * @param {string} baseName - 基础表名
 * @returns {string} DELETE FROM {baseName} WHERE event_id = ?
 */
function cleanSql(baseName) {
  return `DELETE FROM ${baseName} WHERE event_id = ?`;
}

/**
 * 需要归档迁移的业务表列表（events 表保留元数据不删除）
 * 注意：dota2_event_rules 不参与归档 — 章程是模板性质的，被多场赛事复用，永久留在主表
 */
const ARCHIVE_TABLES = [
  'dota2_event_signup',
  'dota2_event_teams',
  'dota2_event_matches',
  'dota2_event_ranks'
];

// ════════════════════════════════════════════════════════════
// 赛事系统常量
// ════════════════════════════════════════════════════════════
const MIN_TEAM_PLAYERS = 5;  // 每队最低人数（Dota2标准5人队）

// ============================================================
// 昵称解析工具：将 openid 转换为用户昵称
// ============================================================

/**
 * 通过 openid 数组批量查询用户昵称
 * @returns {Map<string, string>} openid → nickName
 */
async function getUserNicknames(pool, openids) {
  const map = new Map();
  if (!openids || !openids.length) return map;
  const [rows] = await pool.query(
    'SELECT openid, nick_name FROM dota2_users WHERE openid IN (?)',
    [openids]
  );
  rows.forEach(r => { map.set(r.openid, r.nick_name || ''); });
  return map;
}

/**
 * 将 event 行的 openid 字段替换为对应昵称
 * - creator_id  → creator_nickname
 * - ended_by    → ended_by_nickname
 * - archived_by → archived_by_nickname
 */
async function resolveCreatorNickname(pool, event) {
  if (!event) return event;
  const openids = [];
  if (event.creator_id) openids.push(event.creator_id);
  if (event.ended_by && event.ended_by.length > 10) openids.push(event.ended_by);
  if (event.archived_by && event.archived_by.length > 10) openids.push(event.archived_by);
  if (!openids.length) return event;

  const nickMap = await getUserNicknames(pool, openids);

  if (event.creator_id) {
    event.creator_nickname = nickMap.get(event.creator_id) || '';
    delete event.creator_id;
  }
  if (event.ended_by && event.ended_by.length > 10) {
    event.ended_by_nickname = nickMap.get(event.ended_by) || '';
    delete event.ended_by;
  }
  if (event.archived_by && event.archived_by.length > 10) {
    event.archived_by_nickname = nickMap.get(event.archived_by) || '';
    delete event.archived_by;
  }
  return event;
}

// ============================================================
// 选手档案对接工具函数
// ============================================================

/**
 * 通过 player_id 数组批量查询选手信息
 * @param {Array<string>} ids - 选手ID数组
 * @returns {Array} 选手列表
 */
async function getPlayersByIds(pool, ids) {
  if (!ids || !ids.length) return [];
  const [rows] = await pool.query(
    "SELECT id, wx_nickname, calibrate_rank_name, calibrate_rank_star, calibrate_mmr, calibrate_rank_sort, avatar_url, game_id, good_at_positions, signup_position FROM dota2_players WHERE status = 'active' AND id IN (?)",
    [ids]
  );
  return rows;
}

/**
 * 校验赛事是否存在（数据隔离前提）
 * @returns {Object|null} 赛事行数据，不存在返回 null
 */
// 本地赛事查询辅助（返回赛事对象或 null）
// 注意：与 auth.js 的同名函数 validateEvent() 功能不同，
// auth.js 版本用于状态流转校验，返回 {valid, error, event} 封装对象；
// 此版本为简单行查询，直接返回行数据或 null，供路由快速判断赛事存在性。
async function validateEvent(pool, eventId) {
  const [rows] = await pool.query('SELECT * FROM dota2_events WHERE event_id = ?', [eventId]);
  return rows.length ? rows[0] : null;
}

// ============================================================
// 主入口：导出路由注册函数
// ============================================================
module.exports = function (app, { pool, assertAdmin, getCallerRole, upload }) {

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

      // 按状态筛选（0创建比赛/1报名中/2分组编队/3对战预备/4对战中/5名次归档/6已归档）
      if (status !== undefined && status !== '') {
        where += ' AND event_status = ?';
        params.push(parseInt(status));
      }
      // 按归档标记筛选（兼容旧 is_archived 和新 event_status=6）
      if (archived !== undefined && archived !== '') {
        if (parseInt(archived) === 1) {
          where += ' AND (is_archived = 1 OR event_status >= 6)';
        } else {
          where += ' AND is_archived = 0 AND event_status < 6';
        }
      }

      const p = parseInt(page) || 1;
      const ps = parseInt(pageSize) || 20;
      const sql = 'SELECT * FROM dota2_events' + where + ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
      const countSql = 'SELECT COUNT(*) as total FROM dota2_events' + where;

      const [rows] = await pool.query(sql, [...params, ps, (p - 1) * ps]);
      const [[{ total }]] = await pool.query(countSql, params);

      // 将 creator_id 替换为 creator_nickname
      const data = await Promise.all(rows.map(r => resolveCreatorNickname(pool, r)));
      res.json({ success: true, data, total, page: p, pageSize: ps });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 获取已归档赛事列表（含参赛人数 + 前三名）
   * GET /api/events/archived?keyword=&page=1&pageSize=10
   * - 所有登录用户均可访问，无角色限制
   * - 支持按赛事名称模糊搜索
   * - 返回每条赛事的参赛人数和前三名队伍信息
   * - 仅返回 is_archived=1 的赛事，按归档时间倒序
   */
  app.get('/api/events/archived', async (req, res) => {
    try {
      const { keyword, page, pageSize } = req.query;
      const p = parseInt(page) || 1;
      const ps = Math.min(parseInt(pageSize) || 10, 50); // 防止大页面拖垮查询

      // 构建查询条件：仅归档赛事
      let where = ' WHERE e.is_archived = 1';
      const params = [];

      // 按赛事名称模糊搜索
      if (keyword && keyword.trim()) {
        where += ' AND e.event_name LIKE ?';
        params.push('%' + keyword.trim() + '%');
      }

      // 查询赛事列表，同时关联参赛人数（归档数据从 _his 表读取）
      // fix: COLLATE 解决 utf8mb4_0900_ai_ci vs utf8mb4_unicode_ci 冲突
      const sql = `
        SELECT e.*,
          (SELECT COUNT(*) FROM dota2_event_signup_his s WHERE s.event_id COLLATE utf8mb4_unicode_ci = e.event_id COLLATE utf8mb4_unicode_ci AND s.signup_status = 1) as signup_count
        FROM dota2_events e
        ${where}
        ORDER BY e.archived_at DESC, e.created_at DESC
        LIMIT ? OFFSET ?
      `;
      const countSql = `SELECT COUNT(*) as total FROM dota2_events e ${where}`;

      const [rows] = await pool.query(sql, [...params, ps, (p - 1) * ps]);
      const [[{ total }]] = await pool.query(countSql, params);

      // 为每个赛事查询前三名队伍（从 _his 归档表读取）
      const eventIds = rows.map(r => r.event_id);
      let rankMap = {};
      if (eventIds.length > 0) {
        const [allRanks] = await pool.query(
          `SELECT r.event_id, r.rank_num, r.team_id, t.team_name, t.total_mmr, t.player_ids, t.captain_id
           FROM dota2_event_ranks_his r
           LEFT JOIN dota2_event_teams_his t ON r.team_id COLLATE utf8mb4_unicode_ci = t.team_id COLLATE utf8mb4_unicode_ci
           WHERE r.event_id IN (?) AND r.rank_num <= 3
           ORDER BY r.event_id, r.rank_num ASC`,
          [eventIds]
        );

        // 收集队员ID批量查昵称
        const rankAllPlayerIds = new Set();
        allRanks.forEach(r => {
          try { const ids = JSON.parse(r.player_ids || '[]'); ids.forEach(id => rankAllPlayerIds.add(id)); } catch (_) {}
          if (r.captain_id) rankAllPlayerIds.add(r.captain_id);
        });
        const rankPlayerMap = {};
        if (rankAllPlayerIds.size > 0) {
          const rankPlayers = await getPlayersByIds(pool, [...rankAllPlayerIds]);
          rankPlayers.forEach(p => { rankPlayerMap[p.id] = p.wx_nickname || ''; });
        }

        // 统计这些赛事的队伍胜负
        const [arcWinRows] = await pool.query(
          `SELECT winner_id, COUNT(*) as wins
           FROM dota2_event_matches_his
           WHERE event_id IN (?) AND match_status = 2 AND winner_id IS NOT NULL
           GROUP BY winner_id`,
          [eventIds]
        );
        const arcWinMap = {};
        (arcWinRows || []).forEach(r => { arcWinMap[r.winner_id] = r.wins; });

        const [arcPlayRows] = await pool.query(
          `SELECT team_id, COUNT(*) as total
           FROM (
             SELECT team_a_id as team_id FROM dota2_event_matches_his WHERE event_id IN (?) AND match_status = 2
             UNION ALL
             SELECT team_b_id as team_id FROM dota2_event_matches_his WHERE event_id IN (?) AND match_status = 2
           ) t
           GROUP BY team_id`,
          [eventIds, eventIds]
        );
        const arcPlayMap = {};
        (arcPlayRows || []).forEach(r => { arcPlayMap[r.team_id] = r.total; });

        // 按 event_id 分组
        for (const rank of allRanks) {
          if (!rankMap[rank.event_id]) rankMap[rank.event_id] = [];
          let members = [];
          try {
            const ids = JSON.parse(rank.player_ids || '[]');
            members = ids.map(id => ({
              id,
              nickName: rankPlayerMap[id] || '',
              isCaptain: id === rank.captain_id
            }));
            members.sort((a, b) => (b.isCaptain ? 1 : 0) - (a.isCaptain ? 1 : 0));
          } catch (_) {}
          const wins = arcWinMap[rank.team_id] || 0;
          const totalPlayed = arcPlayMap[rank.team_id] || 0;
          rankMap[rank.event_id].push({
            rankNum: rank.rank_num,
            teamId: rank.team_id,
            teamName: rank.team_name || '未知队伍',
            captainName: rankPlayerMap[rank.captain_id] || '',
            members,
            wins,
            losses: Math.max(0, totalPlayed - wins),
            totalMmr: rank.total_mmr || 0
          });
        }
      }

      // 组装返回数据：替换 creator_id → creator_nickname（批量预查优化，避免 N+1）
      const allOpenids = new Set();
      rows.forEach(e => {
        if (e.creator_id) allOpenids.add(e.creator_id);
        if (e.ended_by && e.ended_by.length > 10) allOpenids.add(e.ended_by);
        if (e.archived_by && e.archived_by.length > 10) allOpenids.add(e.archived_by);
      });
      const nickMap = await getUserNicknames(pool, [...allOpenids]);

      const data = rows.map(e => {
        const item = { ...e };
        if (item.creator_id) { item.creator_nickname = nickMap.get(item.creator_id) || ''; delete item.creator_id; }
        if (item.ended_by && item.ended_by.length > 10) { item.ended_by_nickname = nickMap.get(item.ended_by) || ''; delete item.ended_by; }
        if (item.archived_by && item.archived_by.length > 10) { item.archived_by_nickname = nickMap.get(item.archived_by) || ''; delete item.archived_by; }
        return {
          ...item,
          signupCount: e.signup_count || 0,
          topRanks: rankMap[e.event_id] || []
        };
      });

      res.json({ success: true, data, total, page: p, pageSize: ps });
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
      const event = await resolveCreatorNickname(pool, rows[0]);
      res.json({ success: true, data: event });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });



  /**
   * 创建赛事 POST /api/events
   *
   * 权限规则：
   *   - admin / super_admin 均可创建（两个角色权限完全一致）
   *   - user 角色 → 直接返回 403 无权限
   *
   * 请求参数（JSON body）：
   *   - event_name   : 赛事名称（必填，字符串，2-50字）
   *   - start_time   : 赛事开始时间（可选，bigint 毫秒时间戳）
   *   - event_desc   : 赛事简介（可选，字符串）
   *
   * 返回：{ success: true, data: { eventId, eventName, ... } }
   */
  async function handleCreateEvent(req, res) {
    try {
      // 权限校验：仅 admin 或 super_admin 可创建赛事
      if (!await assertAdmin(req, res)) return;

      // 参数提取：兼容新旧字段名
      const eventName = (req.body.event_name || req.body.eventName || '').trim();
      const startTime = req.body.start_time || req.body.startTime || null;
      const eventDesc = (req.body.event_desc || req.body.eventDesc || '').trim();
      // 报名人数上限（可选，0=无限制）
      const signupLimitRaw = req.body.signup_limit || req.body.signupLimit || 0;
      const signupLimitVal = parseInt(signupLimitRaw) || 0;

      // 名称校验：必填 + 长度 2-50 字符
      if (!eventName) {
        return res.status(400).json({ success: false, error: '请输入赛事名称' });
      }
      if (eventName.length < 2) {
        return res.status(400).json({ success: false, error: '赛事名称至少需要2个字符' });
      }
      if (eventName.length > 50) {
        return res.status(400).json({ success: false, error: '赛事名称不能超过50个字符' });
      }

      // 数据入库：初始状态=0(创建中)，is_archived=0(未归档)
      const eventId = genId();
      const now = Date.now();
      const openid = req._openid || '';
      const limitDb = signupLimitVal > 0 ? signupLimitVal : null;

      // 尝试写入含 signup_limit 的完整 SQL
      try {
        const sql = 'INSERT INTO dota2_events (event_id, event_name, event_desc, creator_id, event_status, start_time, signup_limit, is_archived, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, 0, ?, ?)';
        await pool.query(sql, [eventId, eventName, eventDesc || null, openid, startTime, limitDb, now, now]);
      } catch (e1) {
        // signup_limit 列可能不存在（旧版表）
        if (e1.code === 'ER_BAD_FIELD_ERROR' && e1.message.indexOf('signup_limit') !== -1) {
          try {
            const sql2 = 'INSERT INTO dota2_events (event_id, event_name, event_desc, creator_id, event_status, start_time, is_archived, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, 0, ?, ?)';
            await pool.query(sql2, [eventId, eventName, eventDesc || null, openid, startTime, now, now]);
          } catch (e2) {
            if (e2.code === 'ER_BAD_FIELD_ERROR' && e2.message.indexOf('event_desc') !== -1) {
              await pool.query(
                'INSERT INTO dota2_events (event_id, event_name, creator_id, event_status, start_time, is_archived, created_at, updated_at) VALUES (?, ?, ?, 0, ?, 0, ?, ?)',
                [eventId, eventName, openid, startTime, now, now]
              );
            } else {
              throw e2;
            }
          }
        } else {
          // event_desc 可能不存在
          if (e1.code === 'ER_BAD_FIELD_ERROR' && e1.message.indexOf('event_desc') !== -1) {
            try {
              await pool.query(
                'INSERT INTO dota2_events (event_id, event_name, creator_id, event_status, start_time, is_archived, created_at, updated_at) VALUES (?, ?, ?, 0, ?, 0, ?, ?)',
                [eventId, eventName, openid, startTime, now, now]
              );
            } catch (e3) {
              throw e3;
            }
          } else {
            throw e1;
          }
        }
      }

      res.json({
        success: true,
        data: { eventId, eventName, eventDesc: eventDesc || '', startTime, signupLimit: signupLimitVal > 0 ? signupLimitVal : null, eventStatus: 0, isArchived: 0, creatorId: openid, createdAt: now, message: '赛事创建成功' }
      });
    } catch (e) {
      // 所有已知的列缺失兼容已在上述 try 块内处理，
      // 此处仅兜底未预期错误
      console.error('[创建赛事] 未预期错误', e);
      res.status(500).json({ success: false, error: e.message });
    }
  }

  app.post('/api/events', handleCreateEvent);

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

      // 已归档赛事不允许编辑基本信息
      if (event.is_archived === 1) {
        return res.status(403).json({ success: false, error: '赛事已归档，不可修改基本信息', code: 'ARCHIVED' });
      }

      const { eventName, eventDesc, startTime } = req.body;
      const sets = [];
      const values = [];
      if (eventName !== undefined) { sets.push('event_name = ?'); values.push(eventName); }
      if (eventDesc !== undefined) { sets.push('event_desc = ?'); values.push(eventDesc); }
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
   * 更新赛事状态（admin/super_admin）
   * PUT /api/events/:eventId/status
   * Body: { eventStatus }  - 0创建比赛/1报名中/2分组编队/3对战预备/4对战中/5名次归档/6已归档
   * - 增加状态流转合法性校验：仅允许正向顺序流转
   */
  app.put('/api/events/:eventId/status', async (req, res) => {
    try {
      if (!await assertAdmin(req, res)) return;
      const { eventId } = req.params;
      const event = await validateEvent(pool, eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });

      // 已归档赛事不允许修改状态
      if (event.is_archived === 1) {
        return res.status(403).json({ success: false, error: '赛事已归档，不可修改状态', code: 'ARCHIVED' });
      }

      const { eventStatus, signupLimit } = req.body;
      if (eventStatus === undefined || eventStatus < 0 || eventStatus > 6) {
        return res.status(400).json({ success: false, error: '无效的赛事状态，有效值0-6' });
      }

      // 状态流转校验
      const transition = validateStatusTransition(event.event_status, eventStatus);
      if (!transition.valid) {
        return res.status(400).json({ success: false, error: transition.error });
      }

      // signupLimit 校验：仅 0→1 时生效
      const limitVal = (eventStatus === 1 && signupLimit !== undefined) ? signupLimit : null;
      if (limitVal !== null) {
        if (typeof limitVal !== 'number' || limitVal < 0 || (limitVal !== 0 && !Number.isInteger(limitVal))) {
          return res.status(400).json({ success: false, error: '报名人数上限必须为非负整数（0=无限制）' });
        }
      }

      // 更新状态 + 可选报名人数上限（兼容旧表可能未建 signup_limit 列）
      if (limitVal !== null) {
        const setLimit = (limitVal === 0 ? null : limitVal);
        try {
          await pool.query(
            'UPDATE dota2_events SET event_status = ?, signup_limit = ?, updated_at = ? WHERE event_id = ?',
            [eventStatus, setLimit, Date.now(), eventId]
          );
        } catch (e) {
          // signup_limit 列可能不存在（旧版表），降级仅更新状态
          if (e.code === 'ER_BAD_FIELD_ERROR') {
            await pool.query(
              'UPDATE dota2_events SET event_status = ?, updated_at = ? WHERE event_id = ?',
              [eventStatus, Date.now(), eventId]
            );
          } else {
            throw e;
          }
        }
      } else {
        await pool.query(
          'UPDATE dota2_events SET event_status = ?, updated_at = ? WHERE event_id = ?',
          [eventStatus, Date.now(), eventId]
        );
      }
      res.json({
        success: true,
        data: {
          fromStatus: event.event_status,
          fromStatusName: STATUS_NAMES[event.event_status],
          toStatus: eventStatus,
          toStatusName: STATUS_NAMES[eventStatus]
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 修改报名人数上限（admin/super_admin，分组编队前可修改）
   * PUT /api/events/:eventId/signup-limit
   * Body: { signupLimit: number } — 0=无限制, >0=指定人数
   * - 仅允许在状态 0(创建中)/1(报名中)/2(报名截止) 修改，3(分组锁定)后不允许
   */
  app.put('/api/events/:eventId/signup-limit', async (req, res) => {
    try {
      if (!await assertAdmin(req, res)) return;
      const { eventId } = req.params;
      const event = await validateEvent(pool, eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });

      // 已归档赛事不允许修改
      if (event.is_archived === 1) {
        return res.status(403).json({ success: false, error: '赛事已归档，不可修改', code: 'ARCHIVED' });
      }

      // 仅允许在分组编队前修改（状态 0/1/2）
      if (event.event_status >= 3) {
        return res.status(400).json({
          success: false,
          error: `当前为「${STATUS_NAMES[event.event_status] || '未知'}」阶段，不可修改报名人数上限`,
          code: 'EVENT_LOCKED'
        });
      }

      const { signupLimit } = req.body;
      if (signupLimit === undefined || signupLimit === null || signupLimit === '') {
        return res.status(400).json({ success: false, error: '报名人数上限不能为空' });
      }
      const limitVal = parseInt(signupLimit);
      if (isNaN(limitVal) || limitVal < 0 || (limitVal !== 0 && !Number.isInteger(Number(signupLimit)))) {
        return res.status(400).json({ success: false, error: '报名人数上限必须为非负整数（0=无限制）' });
      }

      // 如果当前报名人数已超新上限，给出警告但允许操作
      const [[{ currentCount }]] = await pool.query(
        'SELECT COUNT(*) as currentCount FROM dota2_event_signup WHERE event_id = ? AND signup_status = 1',
        [eventId]
      );

      await pool.query(
        'UPDATE dota2_events SET signup_limit = ?, updated_at = ? WHERE event_id = ?',
        [limitVal === 0 ? null : limitVal, Date.now(), eventId]
      );

      res.json({
        success: true,
        data: {
          signupLimit: limitVal === 0 ? null : limitVal,
          displayText: limitVal === 0 ? '无限制' : (limitVal + '人'),
          currentSignupCount: currentCount,
          warning: currentCount > limitVal && limitVal > 0
            ? '当前报名人数(' + currentCount + ')已超过新上限(' + limitVal + ')，超出部分不受影响'
            : ''
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 删除赛事（仅 super_admin，对阵开始前可删除，即 event_status < 4）
   * DELETE /api/events/:eventId
   */
  app.delete('/api/events/:eventId', async (req, res) => {
    try {
      const openid = req._openid || '';
      const role = await getCallerRole(openid);
      if (role !== 'super_admin') {
        return res.status(403).json({ success: false, error: '仅超级管理员可操作' });
      }
      const { eventId } = req.params;
      const event = await validateEvent(pool, eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });
      if (event.is_archived === 1) {
        return res.status(403).json({ success: false, error: '已归档赛事不可删除' });
      }
      if (event.event_status >= 4) {
        return res.status(403).json({ success: false, error: '对战已开始，赛事不可删除' });
      }

      // 级联清理：事务中删除赛事及其所有关联数据（含 _his 归档表防御性清理）
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        // 在线表清理
        await conn.query('DELETE FROM dota2_event_signup WHERE event_id = ?', [eventId]);
        await conn.query('DELETE FROM dota2_event_ranks WHERE event_id = ?', [eventId]);
        await conn.query('DELETE FROM dota2_event_matches WHERE event_id = ?', [eventId]);
        await conn.query('DELETE FROM dota2_event_teams WHERE event_id = ?', [eventId]);
        await conn.query('DELETE FROM dota2_event_rules WHERE event_id = ?', [eventId]);
        await conn.query('DELETE FROM dota2_events WHERE event_id = ?', [eventId]);
        // 归档表防御性清理（防止边缘情况残留）
        await conn.query('DELETE FROM dota2_event_signup_his WHERE event_id = ?', [eventId]);
        await conn.query('DELETE FROM dota2_event_teams_his WHERE event_id = ?', [eventId]);
        await conn.query('DELETE FROM dota2_event_matches_his WHERE event_id = ?', [eventId]);
        await conn.query('DELETE FROM dota2_event_ranks_his WHERE event_id = ?', [eventId]);
        await conn.query('DELETE FROM dota2_events_his WHERE event_id = ?', [eventId]);
        await conn.commit();
        res.json({ success: true });
      } catch (e) {
        await safeRollback(conn, 'deleteEvent');
        throw e;
      } finally {
        conn.release();
      }
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ════════════════════════════════════════════════════════════
  // 2. 报名管理模块（dota2_event_signup）
  // ════════════════════════════════════════════════════════════
  //
  // 核心校验逻辑说明
  // - 自主报名：通过 openid → nick_name → wx_nickname 精确匹配选手档案
  //   ① 唯一匹配 → 自动关联 player_id 创建报名记录
  //   ② 多条匹配 → 返回错误「昵称匹配到多个选手档案，请联系管理员手动添加报名」
  //   ③ 无匹配 → 返回错误「未找到对应选手档案，请先完善选手信息后再报名」
  // - 管理员添加：无昵称校验，直接通过 player_id 或搜索后批量添加
  // - 所有操作绑定 event_id 做数据隔离，禁止跨赛事操作
  // - 所有管理员操作记录 operator_id，便于操作留痕

  /**
   * 报名状态前置校验工具
   * 校验赛事当前状态是否允许报名操作
   * @returns {{ valid: boolean, error: string, event: object|null }}
   */
  async function validateSignupEvent(pool, eventId) {
    const event = await validateEvent(pool, eventId);
    if (!event) return { valid: false, error: '赛事不存在', event: null };
    // 已归档赛事不允许任何报名操作
    if (event.is_archived === 1) {
      return { valid: false, error: '赛事已归档，不可进行报名操作', event };
    }
    if (event.event_status !== 1) {
      // 根据不同状态给出具体提示
      const statusMap = { 0: '赛事尚未开启报名', 2: '报名已截止', 3: '赛事已进入分组阶段', 4: '赛事对战中', 5: '赛事已归档' };
      const msg = statusMap[event.event_status] || '当前赛事不在报名阶段';
      return { valid: false, error: msg, event };
    }
    return { valid: true, error: '', event };
  }

  /**
   * 校验报名人数是否已达上限（仅自主报名使用）
   * @returns {{ full: boolean, error: string }}
   */
  async function checkSignupLimit(pool, eventId) {
    const [eventRows] = await pool.query('SELECT signup_limit FROM dota2_events WHERE event_id = ?', [eventId]);
    if (!eventRows.length) return { full: false, error: '' };
    const limit = eventRows[0].signup_limit;
    if (!limit || limit <= 0) return { full: false, error: '' }; // 无限制

    const [[{ cnt }]] = await pool.query(
      'SELECT COUNT(*) AS cnt FROM dota2_event_signup WHERE event_id = ? AND signup_status = 1',
      [eventId]
    );
    if (cnt >= limit) {
      return { full: true, error: `报名人数已满（上限${limit}人）` };
    }
    return { full: false, error: '' };
  }

  /**
   * 通过用户 nick_name 精确匹配选手档案
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
      "SELECT id, wx_nickname, calibrate_rank_name, calibrate_rank_star FROM dota2_players WHERE wx_nickname = ? AND status = 'active'",
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

      const isArchived = event.is_archived === 1;
      const signupTable = tableFor('dota2_event_signup', isArchived);

      // 权限判断：普通用户只能看有效报名，管理员看全部
      const openid = req._openid || '';
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
        FROM ${signupTable} s
        LEFT JOIN dota2_players p ON s.player_id COLLATE utf8mb4_unicode_ci = p.id COLLATE utf8mb4_unicode_ci
        ${where} ORDER BY s.created_at DESC LIMIT ? OFFSET ?
      `;
      const countSql = `SELECT COUNT(*) as total FROM ${signupTable} s ${where}`;

      const [rows] = await pool.query(sql, [...params, ps, (p - 1) * ps]);
      const [[{ total }]] = await pool.query(countSql, params);

      // 过滤掉 operator_id
      const data = rows.map(r => { delete r.operator_id; return r; });
      res.json({ success: true, data, total, page: p, pageSize: ps });
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

      const openid = req._openid || '';
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
      // 已归档赛事从 _his 表读取历史报名
      const isArchived = event.is_archived === 1;
      const signupTable = isArchived ? 'dota2_event_signup_his' : 'dota2_event_signup';
      const [signups] = await pool.query(
        `SELECT * FROM ${signupTable} WHERE event_id = ? AND player_id = ? ORDER BY created_at DESC LIMIT 1`,
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
   * 选手自主报名（user 可操作，强制昵称匹配校验）
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

      // 校验1 - 赛事状态：仅报名中(eventStatus=1)允许操作
      const statusCheck = await validateSignupEvent(pool, eventId);
      if (!statusCheck.valid) {
        return res.status(400).json({ success: false, error: statusCheck.error, code: 'EVENT_NOT_OPEN' });
      }

      // 校验2 - 报名人数上限检查（仅自主报名受限，管理员添加不受限）
      const limitCheck = await checkSignupLimit(pool, eventId);
      if (limitCheck.full) {
        return res.status(400).json({
          success: false,
          error: limitCheck.error || '报名已满',
          code: 'SIGNUP_FULL'
        });
      }

      const openid = req._openid || '';

      // 校验2 - 昵称匹配：通过 openid 获取 nick_name，精确匹配选手档案
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

      // 校验4 - 检查是否已有报名记录，处理已取消重新报名场景
      const [existing] = await pool.query(
        'SELECT signup_id, signup_status FROM dota2_event_signup WHERE event_id = ? AND player_id = ?',
        [eventId, playerId]
      );

      const now = Date.now();
      if (existing.length > 0) {
        if (existing[0].signup_status === 1) {
          return res.status(400).json({
            success: false,
            error: '您已报名当前赛事',
            code: 'ALREADY_SIGNED'
          });
        }
        // 之前取消过（status=0），重新激活
        await pool.query(
          'UPDATE dota2_event_signup SET signup_status = 1, signup_type = 0, operator_id = ?, created_at = ? WHERE signup_id = ?',
          [openid, now, existing[0].signup_id]
        );
        return res.json({
          success: true,
          data: {
            signupId: existing[0].signup_id,
            playerId,
            playerInfo: matchResult.playerInfo,
            signupType: 'self_signup',
            message: '报名成功'
          }
        });
      }

      // 执行报名：创建报名记录，signup_type=0(自主报名)，记录 operator_id
      const signupId = genId();
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

      // 归档后禁止添加报名
      if (event.is_archived === 1) {
        return res.status(403).json({ success: false, error: '赛事已归档，不可添加报名', code: 'ARCHIVED' });
      }

      const openid = req._openid || '';
      const { playerId } = req.body;
      if (!playerId) return res.status(400).json({ success: false, error: '选手ID不能为空' });

      // 校验选手是否存在
      const [players] = await pool.query(
        "SELECT id, wx_nickname, calibrate_rank_name, calibrate_rank_star FROM dota2_players WHERE id = ? AND status = 'active'",
        [playerId]
      );
      if (!players.length) return res.status(404).json({ success: false, error: '选手不存在' });

      // 查询任意状态的已有记录，处理已取消重新报名场景
      const [existing] = await pool.query(
        'SELECT signup_id, signup_status FROM dota2_event_signup WHERE event_id = ? AND player_id = ?',
        [eventId, playerId]
      );

      const now = Date.now();
      if (existing.length > 0) {
        const row = existing[0];
        if (row.signup_status === 1) {
          return res.status(400).json({ success: false, error: '该选手已报名本赛事', code: 'ALREADY_SIGNED' });
        }
        // 之前取消过（status=0），重新激活
        await pool.query(
          'UPDATE dota2_event_signup SET signup_status = 1, signup_type = 1, operator_id = ?, created_at = ? WHERE signup_id = ?',
          [openid, now, row.signup_id]
        );
        return res.json({
          success: true,
          data: {
            signupId: row.signup_id,
            playerId,
            playerInfo: { wxNickname: players[0].wx_nickname, rankName: players[0].calibrate_rank_name, rankStar: players[0].calibrate_rank_star },
            signupType: 'admin_add',
            reactivated: true
          }
        });
      }

      // 完全新记录
      const signupId = genId();
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

      // 归档后禁止添加报名
      if (event.is_archived === 1) {
        return res.status(403).json({ success: false, error: '赛事已归档，不可添加报名', code: 'ARCHIVED' });
      }

      const openid = req._openid || '';
      const { playerIds } = req.body;
      if (!playerIds || !playerIds.length) {
        return res.status(400).json({ success: false, error: '选手ID列表不能为空' });
      }

      const results = { success: 0, skipped: 0, failed: 0, details: [] };
      const now = Date.now();

      // 批量验证所有选手是否存在
      if (playerIds.length > 0) {
        const [validPlayers] = await pool.query(
          "SELECT id FROM dota2_players WHERE status = 'active' AND id IN (?)",
          [playerIds]
        );
        const validIds = new Set(validPlayers.map(p => p.id));
        const invalidIds = playerIds.filter(id => !validIds.has(id));
        if (invalidIds.length > 0) {
          return res.status(400).json({
            success: false,
            error: `以下选手不存在: ${invalidIds.join(', ')}`,
            data: { invalidIds }
          });
        }
      }

      // 事务保护：批量操作使用事务，中途失败则全部回滚
      const conn = await pool.getConnection();
      let released = false;
      const releaseOnce = () => { if (!released) { released = true; conn.release(); } };
      try {
        await conn.beginTransaction();

        for (const playerId of playerIds) {
          try {
            const [existing] = await conn.query(
              'SELECT signup_id, signup_status FROM dota2_event_signup WHERE event_id = ? AND player_id = ?',
              [eventId, playerId]
            );
            if (existing.length > 0) {
              const row = existing[0];
              if (row.signup_status === 1) {
                results.skipped++;
                results.details.push({ playerId, status: 'skipped', reason: '已报名' });
              } else {
                await conn.query(
                  'UPDATE dota2_event_signup SET signup_status = 1, signup_type = 1, operator_id = ?, created_at = ? WHERE signup_id = ?',
                  [openid, now, row.signup_id]
                );
                results.success++;
                results.details.push({ playerId, status: 'success', signupId: row.signup_id, reactivated: true });
              }
              continue;
            }

            const signupId = genId();
            await conn.query(
              'INSERT INTO dota2_event_signup (signup_id, event_id, player_id, signup_type, signup_status, operator_id, created_at) VALUES (?, ?, ?, 1, 1, ?, ?)',
              [signupId, eventId, playerId, openid, now]
            );
            results.success++;
            results.details.push({ playerId, status: 'success', signupId });
          } catch (e) {
            // 单条记录失败 → 回滚整个事务
            await safeRollback(conn, 'batchSignupSingle');
            releaseOnce();
            return res.status(500).json({
              success: false,
              error: `批量报名失败（选手 ${playerId}）: ${e.message}`,
              data: results
            });
          }
        }

        await conn.commit();
        res.json({ success: true, data: results });
      } catch (e) {
        await safeRollback(conn, 'batchSignup');
        res.status(500).json({ success: false, error: e.message });
      } finally {
        releaseOnce();
      }
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

      const openid = req._openid || '';
      const role = await getCallerRole(openid);
      const isAdmin = role === 'admin' || role === 'super_admin';

      // 校验1 - 赛事存在 + 未归档
      const event = await validateEvent(pool, eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });
      if (event.is_archived === 1) {
        return res.status(400).json({ success: false, error: '赛事已归档，不可进行报名操作', code: 'ARCHIVED' });
      }

      // 校验2 - 赛事状态
      //   - 管理员：分组编队前（状态 0/1/2）均可删除报名
      //   - 普通用户：仅报名中（状态 1）可取消自己的报名
      if (!isAdmin) {
        if (event.event_status !== 1) {
          const map = { 0: '赛事尚未开启报名', 2: '报名已截止', 3: '赛事已进入分组阶段', 4: '赛事对战中', 5: '赛事已归档' };
          return res.status(400).json({ success: false, error: map[event.event_status] || '当前赛事不在报名阶段', code: 'EVENT_NOT_OPEN' });
        }
      } else {
        if (event.event_status >= 3) {
          const statusMap = { 3: '赛事已进入分组阶段', 4: '赛事对战中', 5: '赛事已归档' };
          return res.status(400).json({ success: false, error: (statusMap[event.event_status] || '当前阶段') + '，不可删除报名', code: 'EVENT_LOCKED' });
        }
      }

      // 查询报名记录
      const [signups] = await pool.query(
        'SELECT * FROM dota2_event_signup WHERE signup_id = ? AND event_id = ?',
        [signupId, eventId]
      );
      if (!signups.length) return res.status(404).json({ success: false, error: '报名记录不存在' });
      if (signups[0].signup_status === 0) {
        return res.status(400).json({ success: false, error: '该报名记录已取消' });
      }

      // 校验3 - 普通用户需验证身份：通过 nick_name 匹配选手的 wx_nickname
      if (!isAdmin) {
        const [userRows] = await pool.query('SELECT nick_name FROM dota2_users WHERE openid = ?', [openid]);
        const userNick = (userRows.length && userRows[0].nick_name) ? userRows[0].nick_name : '';
        const [playerRows] = await pool.query("SELECT wx_nickname FROM dota2_players WHERE id = ? AND status = 'active'", [signups[0].player_id]);
        if (!playerRows.length || playerRows[0].wx_nickname !== userNick) {
          return res.status(403).json({ success: false, error: '仅可取消自己的报名', code: 'NOT_OWNER' });
        }
      }

      // 执行取消：软删除 signup_status = 0，记录操作人
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

      // 【安全】限制搜索关键词长度，防止超长 LIKE 导致慢查询
      if (keyword.length > 100) {
        return res.status(400).json({ success: false, error: '搜索关键词过长（最多100字符）' });
      }

      // 模糊搜索 wx_nickname
      const [rows] = await pool.query(
        "SELECT id, wx_nickname, game_id, calibrate_rank_name, calibrate_rank_star, calibrate_mmr, calibrate_rank_sort, avatar_url, good_at_positions FROM dota2_players WHERE status = 'active' AND wx_nickname LIKE ? ORDER BY calibrate_rank_sort DESC LIMIT ?",
        ['%' + keyword + '%', Math.min(parseInt(limit) || 20, 100)]
      );
      res.json({ success: true, data: rows });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 获取某赛事全部有效报名的选手ID列表（用于搜索时判断是否已报名）
   * GET /api/events/:eventId/signups/ids
   */
  app.get('/api/events/:eventId/signups/ids', async (req, res) => {
    try {
      const { eventId } = req.params;
      const [rows] = await pool.query(
        'SELECT player_id FROM dota2_event_signup WHERE event_id = ? AND signup_status = 1',
        [eventId]
      );
      const ids = rows.map(r => r.player_id);
      res.json({ success: true, data: ids });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ════════════════════════════════════════════════════════════
  // 3. 队伍管理模块（dota2_event_teams）
  // ════════════════════════════════════════════════════════════
  //
  // 核心校验规则
  // - 选手不可重复加入多支队伍（跨队唯一性校验）
  // - 每支队伍必须指定队长，队员列表不能为空
  // - 赛事状态>=4(对战中/已归档)时，所有写操作拦截
  // - 所有操作绑定 event_id 做数据隔离
  // - 仅 admin/super_admin 可编辑队伍，普通用户仅可查询

  /**
   * 【队伍锁定校验工具】校验赛事状态是否允许编辑队伍
   * 队伍编辑仅允许在 分组编队(2) 状态下进行
   * 对战预备(3)及以上时永久锁定
   * @returns {{ locked: boolean, error: string }}
   */
  async function validateTeamEditable(pool, eventId) {
    const event = await validateEvent(pool, eventId);
    if (!event) return { locked: true, error: '赛事不存在' };
    // 已归档赛事不允许任何队伍修改
    if (event.is_archived === 1) {
      return { locked: true, error: '赛事已归档，队伍数据不可修改' };
    }
    // 状态<2(创建比赛/报名中) → 尚未到编组阶段
    if (event.event_status < 2) {
      return { locked: true, error: '赛事尚未截止报名，无法进行队伍编排' };
    }
    // 状态>=3(对战预备及以上) → 队伍已永久锁定
    if (event.event_status >= 3) {
      return { locked: true, error: '队伍已锁定，不可修改' };
    }
    return { locked: false, error: '', event };
  }

  /**
   * 通过 openid 查找对应的选手ID（player_id）
   * 逻辑：openid → dota2_users.nick_name → dota2_players.wx_nickname 精确匹配
   * @returns {string|null} playerId 或 null
   */
  async function getPlayerIdByOpenid(openid) {
    if (!openid) return null;
    try {
      const [userRows] = await pool.query('SELECT nick_name FROM dota2_users WHERE openid = ?', [openid]);
      const userNick = (userRows.length && userRows[0].nick_name) ? userRows[0].nick_name : '';
      if (!userNick) return null;
      const [playerRows] = await pool.query("SELECT id FROM dota2_players WHERE wx_nickname = ? AND status = 'active'", [userNick]);
      if (playerRows.length === 1) return playerRows[0].id;
      return null;
    } catch (_) { return null; }
  }

  /**
   * 【选手跨队唯一性校验】检查所有队伍间是否存在选手重复
   * @param {Array} teams - [{ teamId?, playerIds: [] }]
   * @returns {{ valid: boolean, duplicates: string[], error: string }}
   */
  function validatePlayerUniqueness(teams, existingTeamId) {
    const playerTeamMap = {}; // playerId → team name/index
    const duplicates = [];

    for (const team of teams) {
      const tid = team.teamId || team.teamName || 'unknown';
      for (const pid of (team.playerIds || [])) {
        if (playerTeamMap[pid] && playerTeamMap[pid] !== tid) {
          duplicates.push(pid);
        }
        playerTeamMap[pid] = tid;
      }
    }

    if (duplicates.length > 0) {
      return { valid: false, duplicates, error: `选手 ${duplicates.join(', ')} 同时存在于多支队伍中` };
    }
    return { valid: true, duplicates: [], error: '' };
  }

  /**
   * 获取某赛事队伍列表（含队员详情+未入队选手）
   * GET /api/events/:eventId/teams
   * - 所有用户可查看
   * - 返回 teams 数组 + freePlayers（未入队的已报名选手）
   */
  app.get('/api/events/:eventId/teams', async (req, res) => {
    try {
      const { eventId } = req.params;
      const event = await validateEvent(pool, eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });

      const isArchived = event.is_archived === 1;
      const teamsTable = tableFor('dota2_event_teams', isArchived);
      const signupTable = tableFor('dota2_event_signup', isArchived);

      // 查询所有队伍
      const [rows] = await pool.query(
        `SELECT * FROM ${teamsTable} WHERE event_id = ? ORDER BY total_mmr DESC`,
        [eventId]
      );

      // 为每个队伍展开队员信息
      const teams = [];
      const allAssignedPlayerIds = new Set();
      for (const team of rows) {
        let playerIds = [];
        try {
          playerIds = team.player_ids ? JSON.parse(team.player_ids) : [];
        } catch (_) {
          playerIds = [];
        }
        playerIds.forEach(pid => allAssignedPlayerIds.add(pid));

        const players = playerIds.length
          ? await getPlayersByIds(pool, playerIds)
          : [];
        // 队长信息（从 players 中筛选带 captain 标记）
        const captain = players.find(p => p.id === team.captain_id) || null;

        teams.push({
          ...team,
          players,
          captain,
          playerCount: players.length,
        });
      }

      // 查询赛事全部有效报名选手（用于计算自由选手）
      // fix: COLLATE 解决归档表 utf8mb4_unicode_ci 与 players 表 utf8mb4_0900_ai_ci 冲突
      const [allSignups] = await pool.query(
        `SELECT p.id, p.wx_nickname, p.calibrate_rank_name, p.calibrate_rank_star,
                p.calibrate_mmr, p.calibrate_rank_sort, p.avatar_url, p.good_at_positions, p.signup_position
         FROM ${signupTable} s
         JOIN dota2_players p ON s.player_id COLLATE utf8mb4_unicode_ci = p.id COLLATE utf8mb4_unicode_ci
         WHERE s.event_id = ? AND s.signup_status = 1`,
        [eventId]
      );

      // 过滤出未入队选手
      const freePlayers = allSignups.filter(p => !allAssignedPlayerIds.has(p.id));

      res.json({ success: true, data: { teams, freePlayers, eventStatus: event.event_status } });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 【核心接口】批量保存队伍编排结果（admin/super_admin）
   * POST /api/events/:eventId/teams/batch
   * Body: { teams: [{ teamName, captainId, playerIds }] }
   * - 全量覆盖：先删除该赛事所有旧队伍，再插入新队伍数据
   * - 校验：选手唯一性 + 队长非空 + 队员非空 + 锁定状态
   * - 后端自动计算 total_mmr
   */
  app.post('/api/events/:eventId/teams/batch', async (req, res) => {
    try {
      if (!await assertAdmin(req, res)) return;
      const { eventId } = req.params;

      // 校验1 - 锁定状态检查
      const lockCheck = await validateTeamEditable(pool, eventId);
      if (lockCheck.locked) {
        return res.status(400).json({ success: false, error: lockCheck.error, code: 'TEAMS_LOCKED' });
      }

      const { teams } = req.body;
      if (!teams || !Array.isArray(teams)) {
        return res.status(400).json({ success: false, error: '队伍数据格式错误' });
      }

      // 校验2 - 逐队校验：队名、人数、队长
      for (let i = 0; i < teams.length; i++) {
        const t = teams[i];
        if (!t.teamName || !t.teamName.trim()) {
          return res.status(400).json({ success: false, error: `第${i + 1}支队伍名称不能为空` });
        }
        if (!t.playerIds || t.playerIds.length < 5) {
          return res.status(400).json({ success: false, error: `队伍「${t.teamName}」至少需要5名队员，当前仅${t.playerIds?.length || 0}人` });
        }
        if (!t.captainId) {
          return res.status(400).json({ success: false, error: `队伍「${t.teamName}」未指定队长` });
        }
        // 校验队长必须在队员列表中
        if (!t.playerIds.includes(t.captainId)) {
          return res.status(400).json({ success: false, error: `队伍「${t.teamName}」的队长不在队员列表中` });
        }
      }

      // 校验3 - 选手跨队唯一性检查
      const dupCheck = validatePlayerUniqueness(teams);
      if (!dupCheck.valid) {
        return res.status(400).json({ success: false, error: dupCheck.error, code: 'DUPLICATE_PLAYER' });
      }

      // 执行保存：事务中先删后插
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();

        await conn.query('DELETE FROM dota2_event_teams WHERE event_id = ?', [eventId]);

        const results = [];
        const now = Date.now();
        for (const t of teams) {
          // 使用 rank-score 模块计算等效总分（含段位+星级推算，未定段=0）
          let totalMmr = 0;
          try {
            const [playerRows] = await conn.query(
              'SELECT id, calibrate_mmr, calibrate_rank_sort, calibrate_rank_star FROM dota2_players WHERE id IN (?)',
              [t.playerIds]
            );
            totalMmr = playerRows.reduce((sum, p) => sum + getScore(p).score, 0);
          } catch (e) {
            console.error('[allocate] MMR计算失败, eventId=%s, team=%s:', eventId, t.teamName, e.message);
          }

          const teamId = genId();
          const memberCount = t.playerIds.length;
          const avgMmr = memberCount > 0 ? Math.round(totalMmr / memberCount) : 0;
          await conn.query(
            'INSERT INTO dota2_event_teams (team_id, event_id, team_name, captain_id, player_ids, total_mmr, avg_mmr, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [teamId, eventId, t.teamName.trim(), t.captainId, JSON.stringify(t.playerIds), totalMmr, avgMmr, now, now]
          );
          results.push({ teamId, teamName: t.teamName, totalMmr, avgMmr, playerCount: memberCount });
        }

        await conn.commit();
        res.json({
          success: true,
          data: { teamCount: results.length, teams: results },
          message: `成功保存 ${results.length} 支队伍`
        });
      } catch (e) {
        await safeRollback(conn, 'saveTeams');
        throw e;
      } finally {
        conn.release();
      }
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 【核心接口】自动分队（admin/super_admin，对接第3轮均衡分队算法）
   * POST /api/events/:eventId/allocate-teams
   * Body: { teamCount: 4, teamNamePrefix: '战队' }
   * - 从报名池获取已报名选手，调用 allocateTeams() 生成编组
   * - 返回队伍结果 + 均衡度统计，不写入数据库（前端可微调后再提交 batch）
   */
  app.post('/api/events/:eventId/allocate-teams', async (req, res) => {
    try {
      if (!await assertAdmin(req, res)) return;
      const { eventId } = req.params;

      // 锁定状态检查
      const lockCheck = await validateTeamEditable(pool, eventId);
      if (lockCheck.locked) {
        return res.status(400).json({ success: false, error: lockCheck.error, code: 'TEAMS_LOCKED' });
      }

      // 从报名池获取所有有效报名选手（含段位/MMR/位置信息）
      const [signupPlayers] = await pool.query(
        `SELECT p.id, p.wx_nickname, p.calibrate_mmr, p.calibrate_rank_sort,
                p.calibrate_rank_star, p.calibrate_rank_name, p.good_at_positions, p.signup_position,
                p.avatar_url
         FROM dota2_event_signup s
         JOIN dota2_players p ON s.player_id COLLATE utf8mb4_unicode_ci = p.id COLLATE utf8mb4_unicode_ci
         WHERE s.event_id = ? AND s.signup_status = 1`,
        [eventId]
      );

      if (!signupPlayers || signupPlayers.length === 0) {
        return res.status(400).json({ success: false, error: '当前赛事没有已报名的选手' });
      }

      // 队伍数量：默认按每队5人计算
      const { teamCount, teamNamePrefix } = req.body;
      const count = parseInt(teamCount) || Math.max(1, Math.ceil(signupPlayers.length / 5));
      if (count < 1) {
        return res.status(400).json({ success: false, error: '队伍数量必须>=1' });
      }
      if (count > signupPlayers.length) {
        return res.status(400).json({ success: false, error: '队伍数量不能超过报名选手总数' });
      }

      const prefix = teamNamePrefix || '战队';

      // 【调用均衡分队算法】
      const allocation = allocateTeams(signupPlayers, count);

      // 算法返回了硬错误（如选手不足）
      if (allocation.error) {
        return res.status(400).json({ success: false, error: allocation.error });
      }

      // 转为前端友好格式（对接 batch 接口的 teams 数组格式）
      // buildTeamOutput 返回 playerList 字段
      const teams = allocation.teams.map((t, i) => ({
        index: i + 1,
        teamName: prefix + (i + 1),
        captainId: t.captainId || (t.playerList.length > 0 ? t.playerList[0].id : ''),
        playerIds: t.playerList.map(p => p.id),
        players: t.playerList,
        totalMmr: t.totalScore,
        playerCount: t.memberCount,
        positionStats: t.positionStats,
      }));

      res.json({
        success: true,
        data: {
          teams,
          totalPlayers: signupPlayers.length,
          teamCount: count,
          stats: allocation.balanceInfo, // 均衡度统计（balanceInfo 不是 stats）
          warnings: allocation.warnings || [],
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 【核心接口】开赛锁定（admin/super_admin）
   * POST /api/events/:eventId/lock-teams
   * - 二次校验队伍数据完整性（每队>=1人且有队长）
   * - 将赛事状态从「分组编队」(2) 更新为「分组锁定」(3)
   * - 状态流转：仅允许 2→3，使用统一 validateStatusTransition 校验
   * - 分组锁定后，所有队伍编辑接口永久拦截，对阵对战Tab解锁
   */
  app.post('/api/events/:eventId/lock-teams', async (req, res) => {
    try {
      if (!await assertAdmin(req, res)) return;
      const { eventId } = req.params;

      // 赛事必须存在
      const event = await validateEvent(pool, eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });

      // 归档拦截
      if (event.is_archived === 1) {
        return res.status(403).json({ success: false, error: '赛事已归档，不可操作', code: 'ARCHIVED' });
      }

      // 状态流转校验：仅允许「分组编队(2)」→「分组锁定(3)」
      const transition = validateStatusTransition(event.event_status, 3);
      if (!transition.valid) {
        return res.status(400).json({
          success: false,
          error: transition.error,
          code: 'INVALID_STATUS_TRANSITION'
        });
      }

      // 查询当前队伍
      const [existingTeams] = await pool.query(
        'SELECT team_id, team_name, captain_id, player_ids FROM dota2_event_teams WHERE event_id = ?',
        [eventId]
      );

      if (!existingTeams || existingTeams.length === 0) {
        return res.status(400).json({ success: false, error: '当前赛事无队伍，请先完成编组' });
      }

      // 逐队校验完整性
      for (const t of existingTeams) {
        const playerIds = t.player_ids ? JSON.parse(t.player_ids) : [];
        if (playerIds.length < MIN_TEAM_PLAYERS) {
          return res.status(400).json({ success: false, error: `队伍「${t.team_name}」至少需要${MIN_TEAM_PLAYERS}名队员，当前仅${playerIds.length}人` });
        }
        if (!t.captain_id) {
          return res.status(400).json({ success: false, error: `队伍「${t.team_name}」未指定队长` });
        }
        if (!playerIds.includes(t.captain_id)) {
          return res.status(400).json({ success: false, error: `队伍「${t.team_name}」的队长不在队员列表中` });
        }
      }

      // 执行锁定：状态 2→3（分组编队→分组锁定）
      await pool.query(
        'UPDATE dota2_events SET event_status = 3, updated_at = ? WHERE event_id = ?',
        [Date.now(), eventId]
      );

      res.json({
        success: true,
        data: {
          teamCount: existingTeams.length,
          status: '分组锁定',
          message: '队伍已锁定，对阵对战已开放！'
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 【返回分组编队】从分组锁定退回到分组编队（admin/super_admin）
   * POST /api/events/:eventId/back-to-teams
   * - 仅允许状态3(分组锁定)→2(分组编队)
   * - 已生成对战的赛事不可返回
   */
  app.post('/api/events/:eventId/back-to-teams', async (req, res) => {
    try {
      if (!await assertAdmin(req, res)) return;
      const { eventId } = req.params;

      const event = await validateEvent(pool, eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });
      if (event.is_archived === 1) {
        return res.status(403).json({ success: false, error: '赛事已归档，不可返回', code: 'ARCHIVED' });
      }
      if (event.event_status !== 3) {
        return res.status(400).json({ success: false, error: `当前状态「${STATUS_NAMES[event.event_status]}」，仅对战预备时可返回` });
      }

      // 检查是否已生成对战
      const [[{ cnt }]] = await pool.query('SELECT COUNT(*) as cnt FROM dota2_event_matches WHERE event_id = ?', [eventId]);
      if (cnt > 0) {
        return res.status(400).json({ success: false, error: '已有对战记录，无法返回编队阶段' });
      }

      await pool.query(
        'UPDATE dota2_events SET event_status = 2, updated_at = ? WHERE event_id = ?',
        [Date.now(), eventId]
      );

      res.json({
        success: true,
        data: { fromStatus: 3, toStatus: 2, message: '已返回分组编队阶段' }
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 队长修改战队名（保存分组后可改，归档前）
   * PUT /api/events/:eventId/teams/:teamId/name
   * 权限：队长本人 或 管理员
   */
  app.put('/api/events/:eventId/teams/:teamId/name', async (req, res) => {
    try {
      const { eventId, teamId } = req.params;
      const { teamName } = req.body;
      const openid = req._openid || '';

      if (!teamName || !teamName.trim()) {
        return res.status(400).json({ success: false, error: '战队名不能为空' });
      }
      if (teamName.trim().length > 50) {
        return res.status(400).json({ success: false, error: '战队名不能超过50个字符' });
      }

      // 校验赛事存在
      const event = await validateEvent(pool, eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });
      if (event.is_archived === 1) {
        return res.status(403).json({ success: false, error: '赛事已归档，队伍名称不可修改' });
      }
      // 保存分组后(status>=2)才允许队长改名
      if (event.event_status < 2) {
        return res.status(400).json({ success: false, error: '请先保存分组后再修改战队名' });
      }

      // 校验队伍存在
      const [teams] = await pool.query(
        'SELECT * FROM dota2_event_teams WHERE team_id = ? AND event_id = ?',
        [teamId, eventId]
      );
      if (!teams.length) return res.status(404).json({ success: false, error: '队伍不存在' });

      const team = teams[0];

      // 权限校验：管理员 or 队长本人
      const role = await getCallerRole(openid);
      const isAdminRole = role === 'admin' || role === 'super_admin';

      if (!isAdminRole) {
        // 非管理员：检查是否为队长
        const playerId = await getPlayerIdByOpenid(openid);
        if (!playerId || playerId !== team.captain_id) {
          return res.status(403).json({ success: false, error: '仅队伍队长或管理员可修改战队名' });
        }
      }

      // 执行更新
      await pool.query(
        'UPDATE dota2_event_teams SET team_name = ?, updated_at = ? WHERE team_id = ?',
        [teamName.trim(), Date.now(), teamId]
      );

      res.json({ success: true, data: { teamId, teamName: teamName.trim(), message: '战队名已更新' } });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 删除队伍（admin/super_admin，增加锁定校验）
   * DELETE /api/events/:eventId/teams/:teamId
   */
  app.delete('/api/events/:eventId/teams/:teamId', async (req, res) => {
    try {
      if (!await assertAdmin(req, res)) return;
      const { eventId, teamId } = req.params;

      // 锁定校验
      const lockCheck = await validateTeamEditable(pool, eventId);
      if (lockCheck.locked) {
        return res.status(400).json({ success: false, error: lockCheck.error, code: 'TEAMS_LOCKED' });
      }

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
  // 3.5 队伍积分榜（基于对战历史计算每队输赢分数）
  // ════════════════════════════════════════════════════════════

  /**
   * 获取赛事队伍积分榜（含赢/输/总分，用于对阵页面展示）
   * GET /api/events/:eventId/teams/scoreboard
   * - 统计所有已完成对战的胜场，每赢1场=1分
   * - 按分数降序 → 队长昵称升序排列
   * - 返回每个队伍的：teamId, teamName, captainName, wins, losses, score, totalMmr
   */
  app.get('/api/events/:eventId/teams/scoreboard', async (req, res) => {
    try {
      const { eventId } = req.params;
      const event = await validateEvent(pool, eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });

      const isArchived = event.is_archived === 1;
      const teamsTable = tableFor('dota2_event_teams', isArchived);
      const matchesTable = tableFor('dota2_event_matches', isArchived);

      // 获取所有队伍
      const [teams] = await pool.query(
        `SELECT team_id, team_name, captain_id, player_ids, total_mmr, avg_mmr FROM ${teamsTable} WHERE event_id = ?`,
        [eventId]
      );

      if (!teams || teams.length === 0) {
        return res.json({ success: true, data: [] });
      }

      // 统计每队的胜场（从已完成的match_status=2的对战中）
      const [winRows] = await pool.query(
        `SELECT winner_id, COUNT(*) as wins
         FROM ${matchesTable}
         WHERE event_id = ? AND match_status = 2 AND winner_id IS NOT NULL
         GROUP BY winner_id`,
        [eventId]
      );
      const winMap = {};
      (winRows || []).forEach(r => { winMap[r.winner_id] = r.wins; });

      // 统计每队的总参战场次
      const [playRows] = await pool.query(
        `SELECT team_id, COUNT(*) as total
         FROM (
           SELECT team_a_id as team_id FROM ${matchesTable} WHERE event_id = ? AND match_status = 2
           UNION ALL
           SELECT team_b_id as team_id FROM ${matchesTable} WHERE event_id = ? AND match_status = 2
         ) t
         GROUP BY team_id`,
        [eventId, eventId]
      );
      const playMap = {};
      (playRows || []).forEach(r => { playMap[r.team_id] = r.total; });

      // 获取所有队长的昵称（通过 player_ids 中的 captain_id 对应 wx_nickname）
      const allPlayerIds = new Set();
      teams.forEach(t => {
        if (t.captain_id) allPlayerIds.add(t.captain_id);
        try { const ids = JSON.parse(t.player_ids || '[]'); ids.forEach(id => allPlayerIds.add(id)); } catch (_) {}
      });
      const playerMap = {};
      if (allPlayerIds.size > 0) {
        const [players] = await pool.query(
          'SELECT id, wx_nickname FROM dota2_players WHERE id IN (?)',
          [[...allPlayerIds]]
        );
        (players || []).forEach(p => { playerMap[p.id] = p.wx_nickname || ''; });
      }

      // 组装积分榜
      const scoreboard = teams.map(t => {
        const wins = winMap[t.team_id] || 0;
        const total = playMap[t.team_id] || 0;
        const losses = total - wins;
        const captainName = playerMap[t.captain_id] || '';
        let memberCount = 0;
        try { memberCount = JSON.parse(t.player_ids || '[]').length; } catch (_) {}
        const totalMmr = Number(t.total_mmr) || 0;
        const avgMmr = Number(t.avg_mmr) || 0;
        return {
          teamId: t.team_id,
          teamName: t.team_name || '未命名',
          captainName,
          captainId: t.captain_id || '',
          totalMmr,
          avgMmr,
          memberCount,
          wins,
          losses: Math.max(0, losses),
          score: wins,
          totalMatches: total
        };
      });

      // 排序：胜场降序 → 均分升序(同胜场均分接近的相邻) → 队长昵称升序
      scoreboard.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if ((a.avgMmr || 0) !== (b.avgMmr || 0)) return (b.avgMmr || 0) - (a.avgMmr || 0);
        return (a.captainName || '').localeCompare(b.captainName || '', 'zh');
      });

      res.json({ success: true, data: scoreboard });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ════════════════════════════════════════════════════════════
  // 4. 对战管理模块（dota2_event_matches）- 第6轮完整实现
  // ════════════════════════════════════════════════════════════
  //
  // 核心规则
  // - 对阵编排支持自动匹配（按MMR从近到远配对）和手动编排（管理员勾选队伍两两配对）
  // - 胜负判定需二次确认，判定后不可修改
  // - 所有对战数据严格绑定 event_id 做数据隔离
  // - 仅赛事状态=4(对战中)可操作
  // - 无强制淘汰，所有初始队伍永久留存，每轮管理员自主选队参赛
  // - 操作留痕：记录 judge_id + judge_time

  /**
   * 【对战状态前置校验工具】
   * 校验赛事状态是否允许对战操作
   * @param {Array<number>} allowedStatuses - 允许的状态列表，默认 [4]
   * @returns {{ valid: boolean, error: string, event: object|null }}
   */
  async function validateBattleEvent(pool, eventId, allowedStatuses = [4]) {
    const event = await validateEvent(pool, eventId);
    if (!event) return { valid: false, error: '赛事不存在', event: null };
    // 已归档赛事禁止任何对战操作
    if (event.is_archived === 1) {
      return { valid: false, error: '赛事已归档，所有对战数据不可修改', event };
    }
    if (!allowedStatuses.includes(event.event_status)) {
      return { valid: false, error: `赛事当前状态为「${STATUS_NAMES[event.event_status] || '未知'}」，非对战阶段不可操作`, event };
    }
    return { valid: true, error: '', event };
  }

  // ============================================================
  // 全局归档只读拦截工具
  // ============================================================

  /**
   * 校验赛事是否已归档（全局只读拦截）
   * 原理：查询 is_archived 字段，如果为 1 则拦截所有修改操作
   * @param {string} eventId - 赛事ID
   * @returns {{ blocked: boolean, error: string }}
   */
  async function checkNotArchived(pool, eventId) {
    const [[{ archived, event_status }]] = await pool.query(
      'SELECT is_archived as archived, event_status FROM dota2_events WHERE event_id = ?',
      [eventId]
    );
    if (archived === 1 || event_status >= 6) {
      return { blocked: true, error: '赛事已归档，所有数据为只读状态，不可修改' };
    }
    return { blocked: false, error: '' };
  }

  /**
   * 【分数配对算法】按队伍积分（胜场数）从近到远两两配对
   * 排序规则：胜场降序 → 均分升序（同胜场优先匹配均分最接近的队伍） → 队长昵称升序
   * 排序后相邻队伍配对，保证实力最接近的队伍对战
   * @param {Array} teams - 队伍列表（含 team_id, team_name, wins, avg_mmr, captainName）
   * @returns {Array} [{ teamA, teamB }]
   */
  function autoPairTeams(teams) {
    if (teams.length < 2) return [];
    // 胜场降序 → 均分升序(同胜场内均分接近的相邻) → 队长昵称升序(保序)
    const sorted = [...teams].sort((a, b) => {
      const scoreA = a.wins || 0
      const scoreB = b.wins || 0
      if (scoreB !== scoreA) return scoreB - scoreA
      const mmrA = a.avg_mmr || 0
      const mmrB = b.avg_mmr || 0
      if (mmrA !== mmrB) return mmrB - mmrA
      return (a.captainName || '').localeCompare(b.captainName || '', 'zh')
    });
    const pairs = [];
    for (let i = 0; i < sorted.length - 1; i += 2) {
      pairs.push({ teamA: sorted[i], teamB: sorted[i + 1] });
    }
    // 奇数队伍时，最后一条不配对（轮空），但这里不涉及轮空——轮空是手动模式的概念
    return pairs;
  }

  /**
   * 获取赛事所有对战列表（增强版：含队伍详情 + 轮次汇总）
   * GET /api/events/:eventId/matches?round=1
   * - 所有用户可查看
   * - 可选 round 参数筛选指定轮次
   * - 返回对战详情含双方队伍名称、MMR、胜方信息、判定时间
   */
  app.get('/api/events/:eventId/matches', async (req, res) => {
    try {
      const { eventId } = req.params;
      const event = await validateEvent(pool, eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });

      const isArchived = event.is_archived === 1;
      const matchesTable = tableFor('dota2_event_matches', isArchived);
      const teamsTable = tableFor('dota2_event_teams', isArchived);

      const { round } = req.query;
      let where = ' WHERE m.event_id = ?';
      const params = [eventId];

      if (round !== undefined && round !== '') {
        where += ' AND m.round_num = ?';
        params.push(parseInt(round));
      }

      const sql = `
        SELECT m.*,
               ta.team_name as team_a_name, ta.total_mmr as team_a_mmr,
               ta.avg_mmr as team_a_avg_mmr,
               ta.captain_id as team_a_captain, ta.player_ids as team_a_players,
               tb.team_name as team_b_name, tb.total_mmr as team_b_mmr,
               tb.avg_mmr as team_b_avg_mmr,
               tb.captain_id as team_b_captain, tb.player_ids as team_b_players,
               tw.team_name as winner_name
        FROM ${matchesTable} m
        LEFT JOIN ${teamsTable} ta ON m.team_a_id = ta.team_id
        LEFT JOIN ${teamsTable} tb ON m.team_b_id = tb.team_id
        LEFT JOIN ${teamsTable} tw ON m.winner_id = tw.team_id
        ${where} ORDER BY m.round_num ASC, m.created_at ASC
      `;

      const [rows] = await pool.query(sql, params);

      // 收集所有队长ID并批量查询名字
      const captainIds = new Set();
      rows.forEach(m => {
        if (m.team_a_captain) captainIds.add(m.team_a_captain);
        if (m.team_b_captain) captainIds.add(m.team_b_captain);
      });
      const captainMap = {};
      if (captainIds.size > 0) {
        const [captains] = await pool.query(
          'SELECT id, wx_nickname FROM dota2_players WHERE id IN (?)',
          [[...captainIds]]
        );
        (captains || []).forEach(p => { captainMap[p.id] = p.wx_nickname || ''; });
      }

      // 格式化返回数据：为每个对战附加状态中文名 + 队长名
      const matches = rows.map(m => ({
        ...m,
        _statusName: m.match_status === 0 ? '未开始' : m.match_status === 1 ? '进行中' : '已结束',
        _isDone: m.match_status === 2,
        _winnerLabel: m.match_status === 2 ? (m.winner_name || '未知') : '—',
        team_a_captain_name: captainMap[m.team_a_captain] || '',
        team_b_captain_name: captainMap[m.team_b_captain] || '',
      }));

      res.json({ success: true, data: matches });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 获取赛事轮次汇总信息
   * GET /api/events/:eventId/matches/rounds
   * - 返回所有轮次的编号、对战数、已完成数、是否全部完成
   * - 用于前端轮次切换导航
   */
  app.get('/api/events/:eventId/matches/rounds', async (req, res) => {
    try {
      const { eventId } = req.params;
      const event = await validateEvent(pool, eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });

      const isArchived = event.is_archived === 1;
      const matchesTable = tableFor('dota2_event_matches', isArchived);

      const [rows] = await pool.query(
        `SELECT round_num,
                COUNT(*) as match_count,
                SUM(CASE WHEN match_status = 2 THEN 1 ELSE 0 END) as completed_count
         FROM ${matchesTable}
         WHERE event_id = ?
         GROUP BY round_num
         ORDER BY round_num ASC`,
        [eventId]
      );

      const rounds = rows.map(r => ({
        roundNum: r.round_num,
        matchCount: r.match_count,
        completedCount: r.completed_count,
        allDone: r.match_count > 0 && r.completed_count === r.match_count,
      }));

      // 判断当前轮次（最后一个未全部完成的轮次，或最新轮次）
      const currentRound = rounds.length > 0
        ? (rounds.find(r => !r.allDone) || rounds[rounds.length - 1]).roundNum
        : 0;

      res.json({
        success: true,
        data: { rounds, currentRound, totalRounds: rounds.length }
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 【核心接口】生成对战编排（自动匹配 / 手动编排）
   * POST /api/events/:eventId/matches/generate
   * Body: { mode: 'auto' | 'manual', pairs?: [{teamAId, teamBId}] }
   *
   * - auto 模式：自动获取所有队伍，按MMR从近到远两两配对
   * - manual 模式：由前端传入已配对的队伍ID对，未传入的队伍本轮轮空
   * - 轮次序号自动递增（取当前最大轮次+1）
   * - 校验：赛事状态=对战中(4)、队伍存在且属于本赛事、双方不为同一队
   * - 批量插入对战记录，返回本轮所有对阵
   */
  app.post('/api/events/:eventId/matches/generate', async (req, res) => {
    try {
      if (!await assertAdmin(req, res)) return;

      const { eventId } = req.params;

      // 【校验1】赛事必须处于分组锁定或对战中（status=3/4 都可编排对战）
      const battleCheck = await validateBattleEvent(pool, eventId, [3, 4]);
      if (!battleCheck.valid) {
        return res.status(400).json({ success: false, error: battleCheck.error, code: 'INVALID_STATUS' });
      }

      const { mode, pairs } = req.body;
      if (!mode || !['auto', 'manual'].includes(mode)) {
        return res.status(400).json({ success: false, error: 'mode 必须为 auto 或 manual' });
      }

      // 仅查询本赛事的队伍
      const [allTeams] = await pool.query(
        'SELECT team_id, team_name, captain_id, player_ids, total_mmr FROM dota2_event_teams WHERE event_id = ?',
        [eventId]
      );

      if (!allTeams || allTeams.length < 2) {
        return res.status(400).json({ success: false, error: '赛事至少需要2支队伍才能生成对战' });
      }

      // 构建队伍ID → 队伍信息映射
      const teamMap = {};
      allTeams.forEach(t => { teamMap[t.team_id] = t; });

      let matchPairs = [];

      if (mode === 'auto') {
        // 按积分（胜场）从近到远两两配对
        // 先获取每个队伍的胜场数和队长名
        const [winRows] = await pool.query(
          `SELECT winner_id as team_id, COUNT(*) as wins
           FROM dota2_event_matches
           WHERE event_id = ? AND match_status = 2
           GROUP BY winner_id`,
          [eventId]
        );
        const winMap = {};
        winRows.forEach(r => { winMap[r.team_id] = r.wins; });

        // 批量获取队长昵称
        const captainIds = allTeams.map(t => t.captain_id).filter(Boolean);
        const captainMap = {};
        if (captainIds.length > 0) {
          const [players] = await pool.query(
            'SELECT id, wx_nickname FROM dota2_players WHERE id IN (?)',
            [captainIds]
          );
          players.forEach(p => { captainMap[p.id] = p.wx_nickname || ''; });
        }

        // 给每个队伍附上 wins + captainName
        const teamsWithScore = allTeams.map(t => ({
          ...t,
          wins: winMap[t.team_id] || 0,
          captainName: captainMap[t.captain_id] || ''
        }));

        matchPairs = autoPairTeams(teamsWithScore);
        if (matchPairs.length === 0) {
          return res.status(400).json({ success: false, error: '自动配对失败，队伍数量不足' });
        }
      } else {
        // 使用前端传入的配对
        if (!pairs || !Array.isArray(pairs) || pairs.length === 0) {
          return res.status(400).json({ success: false, error: '手动模式需要传入 pairs 数组' });
        }

        for (let i = 0; i < pairs.length; i++) {
          const p = pairs[i];
          if (!p.teamAId || !p.teamBId) {
            return res.status(400).json({ success: false, error: `第${i + 1}组对战双方队伍ID不能为空` });
          }
          if (p.teamAId === p.teamBId) {
            return res.status(400).json({ success: false, error: `第${i + 1}组对战双方不能为同一支队伍` });
          }

          const teamA = teamMap[p.teamAId];
          const teamB = teamMap[p.teamBId];

          // 校验队伍属于本赛事
          if (!teamA) {
            return res.status(400).json({ success: false, error: `队伍 ${p.teamAId} 不属于本赛事` });
          }
          if (!teamB) {
            return res.status(400).json({ success: false, error: `队伍 ${p.teamBId} 不属于本赛事` });
          }

          matchPairs.push({ teamA, teamB });
        }
      }

      // 计算下一轮序号（自动递增）
      const [[{ maxRound }]] = await pool.query(
        'SELECT COALESCE(MAX(round_num), 0) as maxRound FROM dota2_event_matches WHERE event_id = ?',
        [eventId]
      );
      const nextRound = maxRound + 1;

      // 批量插入对战记录
      const now = Date.now();
      const createdMatches = [];
      const insertValues = [];
      const insertParams = [];

      for (const pair of matchPairs) {
        const matchId = genId();
        insertValues.push('(?, ?, ?, ?, ?, 0, ?)');
        insertParams.push(matchId, eventId, nextRound, pair.teamA.team_id, pair.teamB.team_id, now);
        createdMatches.push({
          matchId,
          roundNum: nextRound,
          teamAId: pair.teamA.team_id,
          teamAName: pair.teamA.team_name,
          teamAMmr: pair.teamA.total_mmr,
          teamBId: pair.teamB.team_id,
          teamBName: pair.teamB.team_name,
          teamBMmr: pair.teamB.total_mmr,
          matchStatus: 0,
        });
      }

      if (insertValues.length > 0) {
        await pool.query(
          `INSERT INTO dota2_event_matches (match_id, event_id, round_num, team_a_id, team_b_id, match_status, created_at) VALUES ${insertValues.join(', ')}`,
          insertParams
        );
      }

      // 首轮对战生成后，状态从对战预备(3)推进到对战中(4)
      let advanced = false;
      if (nextRound === 1 && battleCheck.event.event_status === 3) {
        await pool.query(
          'UPDATE dota2_events SET event_status = 4, updated_at = ? WHERE event_id = ? AND event_status = 3',
          [now, eventId]
        );
        advanced = true;
      }

      res.json({
        success: true,
        data: {
          roundNum: nextRound,
          matchCount: createdMatches.length,
          matches: createdMatches,
          statusAdvanced: advanced,
          // 轮空的队伍（手动模式中未被勾选的队伍）
          byes: mode === 'manual'
            ? allTeams.filter(t => !pairs.some(p => p.teamAId === t.team_id || p.teamBId === t.team_id))
                .map(t => ({ teamId: t.team_id, teamName: t.team_name }))
            : [],
        },
        message: `第${nextRound}轮已生成，共 ${createdMatches.length} 场对战${advanced ? '，赛事已进入对战中' : ''}`
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 【核心接口】开启本轮对战（admin/super_admin）
   * PUT /api/events/:eventId/matches/round/:roundNum/start
   * - 将本轮所有 match_status=0 的对战设为 1（进行中）
   * - 开战后对战不可再编辑/删除，仅可判定胜负
   */
  app.put('/api/events/:eventId/matches/round/:roundNum/start', async (req, res) => {
    try {
      if (!await assertAdmin(req, res)) return;

      const { eventId, roundNum } = req.params;
      const rn = parseInt(roundNum);

      // 校验赛事状态
      const battleCheck = await validateBattleEvent(pool, eventId);
      if (!battleCheck.valid) {
        return res.status(400).json({ success: false, error: battleCheck.error, code: 'INVALID_STATUS' });
      }

      // 查询本轮未开始的对战
      const [[{ pendingCount }]] = await pool.query(
        'SELECT COUNT(*) as pendingCount FROM dota2_event_matches WHERE event_id = ? AND round_num = ? AND match_status = 0',
        [eventId, rn]
      );

      if (pendingCount === 0) {
        return res.status(400).json({ success: false, error: '本轮没有待开始的对战' });
      }

      const now = Date.now();
      await pool.query(
        'UPDATE dota2_event_matches SET match_status = 1 WHERE event_id = ? AND round_num = ? AND match_status = 0',
        [eventId, rn]
      );

      res.json({
        success: true,
        data: { roundNum: rn, startedCount: pendingCount, message: `第${rn}轮对战已开始，共 ${pendingCount} 场` }
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 更新一场未开始对战的队伍（admin/super_admin，仅match_status=0时可操作）
   * PUT /api/events/:eventId/matches/:matchId
   * Body: { teamAId?, teamBId? }
   */
  app.put('/api/events/:eventId/matches/:matchId', async (req, res) => {
    try {
      if (!await assertAdmin(req, res)) return;
      const { eventId, matchId } = req.params;

      // 赛事状态校验（防止归档后通过 API 直接修改）
      const battleCheck = await validateBattleEvent(pool, eventId, [3, 4]);
      if (!battleCheck.valid) {
        return res.status(400).json({ success: false, error: battleCheck.error, code: 'INVALID_STATUS' });
      }

      const [matches] = await pool.query(
        'SELECT * FROM dota2_event_matches WHERE match_id = ? AND event_id = ?',
        [matchId, eventId]
      );
      if (!matches.length) return res.status(404).json({ success: false, error: '对战记录不存在' });

      if (matches[0].match_status !== 0) {
        return res.status(400).json({ success: false, error: '对战已开始或已结束，不可修改队伍' });
      }

      const { teamAId, teamBId } = req.body;
      const sets = []; const values = [];
      if (teamAId) { sets.push('team_a_id = ?'); values.push(teamAId); }
      if (teamBId) { sets.push('team_b_id = ?'); values.push(teamBId); }

      if (sets.length === 0) { return res.status(400).json({ success: false, error: '未指定要修改的队伍' }); }
      if (teamAId && teamBId && teamAId === teamBId) {
        return res.status(400).json({ success: false, error: '双方不能为同一支队伍' });
      }

      values.push(matchId);
      await pool.query('UPDATE dota2_event_matches SET ' + sets.join(', ') + ' WHERE match_id = ?', values);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 【核心接口】判定对战结果（admin/super_admin，二次确认）
   * PUT /api/events/:eventId/matches/:matchId/judge
   * Body: { winnerId, confirmed: true }
   *
   * - 校验链：管理员权限 → 赛事状态=对战中(4) → 对战存在 → 未判定 → 胜方为参赛队
   * - confirmed 必须为 true（前端二次确认后传入）
   * - 判定后 match_status 自动设为 2（已结束），保存后不可修改
   * - 操作留痕：记录 judge_id（操作人openid）+ judge_time（毫秒时间戳）
   */
  app.put('/api/events/:eventId/matches/:matchId/judge', async (req, res) => {
    try {
      if (!await assertAdmin(req, res)) return;

      const { eventId, matchId } = req.params;

      // 校验1 - 赛事必须处于对战中
      const battleCheck = await validateBattleEvent(pool, eventId);
      if (!battleCheck.valid) {
        return res.status(400).json({ success: false, error: battleCheck.error, code: 'INVALID_STATUS' });
      }

      // 校验2 - 对战记录存在且属于本赛事
      const [matches] = await pool.query(
        'SELECT * FROM dota2_event_matches WHERE match_id = ? AND event_id = ?',
        [matchId, eventId]
      );
      if (!matches.length) {
        return res.status(404).json({ success: false, error: '对战记录不存在' });
      }

      const match = matches[0];

      // 校验3 - 已判定的对战不可修改
      if (match.match_status === 2) {
        return res.status(400).json({
          success: false,
          error: '该对战已判定胜负，不可修改',
          code: 'ALREADY_JUDGED',
          data: { winnerId: match.winner_id, judgeTime: match.judge_time }
        });
      }

      const { winnerId, confirmed } = req.body;

      // 校验4 - 二次确认标记
      if (!confirmed) {
        return res.status(400).json({ success: false, error: '请二次确认后再提交', code: 'NEED_CONFIRM' });
      }

      // 校验5 - 胜方ID非空
      if (!winnerId) {
        return res.status(400).json({ success: false, error: '胜方队伍ID不能为空' });
      }

      // 校验6 - 胜方必须是参赛队伍之一
      if (winnerId !== match.team_a_id && winnerId !== match.team_b_id) {
        return res.status(400).json({ success: false, error: '胜方队伍不是本场对战的参赛队伍' });
      }

      // 执行判定：更新胜方 + 状态 + 操作留痕
      const judgeTime = Date.now();
      const judgeId = req._openid || '';

      await pool.query(
        'UPDATE dota2_event_matches SET winner_id = ?, match_status = 2, judge_id = ?, judge_time = ? WHERE match_id = ? AND event_id = ?',
        [winnerId, judgeId, judgeTime, matchId, eventId]
      );

      res.json({
        success: true,
        data: {
          matchId,
          winnerId,
          judgeTime,
          message: '胜负已判定，结果不可修改'
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 删除对战记录（admin/super_admin，仅可删除未判定的对战）
   * DELETE /api/events/:eventId/matches/:matchId
   */
  /**
   * 上传对战结果图片
   * POST /api/events/:eventId/matches/:matchId/image
   * 要求：对战已结束(match_status=2)，管理员或参赛队长可上传，归档后不可上传
   */
  app.post('/api/events/:eventId/matches/:matchId/image', upload.single('file'), async (req, res) => {
    try {
      const { eventId, matchId } = req.params;
      const openid = req._openid || '';
      if (!req.file) return res.status(400).json({ success: false, error: '请选择图片' });

      // 校验赛事：未归档
      const event = await validateEvent(pool, eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });
      if (event.is_archived === 1) {
        return res.status(403).json({ success: false, error: '赛事已归档，不可上传图片' });
      }

      // 检验对战记录
      const [matches] = await pool.query(
        'SELECT * FROM dota2_event_matches WHERE match_id = ? AND event_id = ?',
        [matchId, eventId]
      );
      if (!matches.length) return res.status(404).json({ success: false, error: '对战记录不存在' });
      if (matches[0].match_status !== 2) {
        return res.status(400).json({ success: false, error: '仅已结束的对战可上传结果图片' });
      }

      // 权限校验：管理员 or 参赛队长
      const role = await getCallerRole(openid);
      const isAdminRole = role === 'admin' || role === 'super_admin';

      if (!isAdminRole) {
        const playerId = await getPlayerIdByOpenid(openid);
        if (!playerId) {
          return res.status(403).json({ success: false, error: '未找到您的选手档案，无法上传' });
        }
        // 检查是否为参赛队伍的队长
        const match = matches[0];
        const [teams] = await pool.query(
          'SELECT team_id, captain_id FROM dota2_event_teams WHERE event_id = ? AND captain_id = ?',
          [eventId, playerId]
        );
        const isCaptainOfTeamA = teams.some(t => String(t.team_id) === String(match.team_a_id));
        const isCaptainOfTeamB = teams.some(t => String(t.team_id) === String(match.team_b_id));
        if (!isCaptainOfTeamA && !isCaptainOfTeamB) {
          return res.status(403).json({ success: false, error: '仅参赛队伍的队长或管理员可上传对战图片' });
        }
      }

      const imageUrl = '/uploads/' + req.file.filename;
      await pool.query(
        'UPDATE dota2_event_matches SET battle_image = ? WHERE match_id = ?',
        [imageUrl, matchId]
      );

      res.json({ success: true, data: { url: imageUrl, message: '上传成功' } });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.delete('/api/events/:eventId/matches/:matchId', async (req, res) => {
    try {
      if (!await assertAdmin(req, res)) return;
      const { eventId, matchId } = req.params;

      // 赛事状态校验（防止归档后通过 API 直接删除）
      const battleCheck = await validateBattleEvent(pool, eventId, [3, 4]);
      if (!battleCheck.valid) {
        return res.status(400).json({ success: false, error: battleCheck.error, code: 'INVALID_STATUS' });
      }

      const [matches] = await pool.query(
        'SELECT * FROM dota2_event_matches WHERE match_id = ? AND event_id = ?',
        [matchId, eventId]
      );
      if (!matches.length) return res.status(404).json({ success: false, error: '对战记录不存在' });

      // 已判定的对战不可删除
      if (matches[0].match_status === 2) {
        return res.status(400).json({ success: false, error: '已判定胜负的对战不可删除' });
      }

      await pool.query('DELETE FROM dota2_event_matches WHERE match_id = ? AND event_id = ?', [matchId, eventId]);
      res.json({ success: true, data: { matchId, message: '对战记录已删除' } });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 【核心接口】进入下一轮（admin/super_admin）
   * POST /api/events/:eventId/next-round
   *
   * - 校验本轮所有对战已完成判定
   * - 返回所有原始队伍列表（永久留存，无淘汰）供新一轮编排使用
   * - 返回下一轮序号、当前轮完成统计
   */
  app.post('/api/events/:eventId/next-round', async (req, res) => {
    try {
      if (!await assertAdmin(req, res)) return;

      const { eventId } = req.params;

      // 校验1 - 赛事必须处于对战中
      const battleCheck = await validateBattleEvent(pool, eventId);
      if (!battleCheck.valid) {
        return res.status(400).json({ success: false, error: battleCheck.error, code: 'INVALID_STATUS' });
      }

      // 校验2 - 查询当前最大轮次
      const [[{ maxRound }]] = await pool.query(
        'SELECT COALESCE(MAX(round_num), 0) as maxRound FROM dota2_event_matches WHERE event_id = ?',
        [eventId]
      );

      if (maxRound === 0) {
        return res.status(400).json({ success: false, error: '当前赛事还没有对战记录，请先生成第1轮对战' });
      }

      // 校验3 - 本轮所有对战必须全部完成判定
      const [[{ unfinished }]] = await pool.query(
        'SELECT COUNT(*) as unfinished FROM dota2_event_matches WHERE event_id = ? AND round_num = ? AND match_status != 2',
        [eventId, maxRound]
      );

      if (unfinished > 0) {
        return res.status(400).json({
          success: false,
          error: `第${maxRound}轮还有 ${unfinished} 场对战未判定，请先完成所有胜负判定`,
          code: 'ROUND_NOT_DONE'
        });
      }

      // 获取所有原始队伍（永存，无淘汰）
      const [allTeams] = await pool.query(
        'SELECT team_id, team_name, captain_id, player_ids, total_mmr FROM dota2_event_teams WHERE event_id = ? ORDER BY total_mmr DESC',
        [eventId]
      );

      res.json({
        success: true,
        data: {
          currentRound: maxRound,
          nextRound: maxRound + 1,
          teams: allTeams,
          teamCount: allTeams.length,
          message: `第${maxRound}轮已完成，准备进入第${maxRound + 1}轮`
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 【核心接口】结束比赛 / 赛事归档（admin/super_admin）
   * POST /api/events/:eventId/end-battle
   *
   * - 校验所有轮次所有对战已完成判定
   * - 更新赛事状态 对战中(4) → 名次归档(5)
   * - 后续可由排名模块设定名次
   */
  app.post('/api/events/:eventId/end-battle', async (req, res) => {
    try {
      if (!await assertAdmin(req, res)) return;

      const { eventId } = req.params;

      // 校验1 - 赛事必须处于对战中
      const battleCheck = await validateBattleEvent(pool, eventId);
      if (!battleCheck.valid) {
        return res.status(400).json({ success: false, error: battleCheck.error, code: 'INVALID_STATUS' });
      }

      // 校验2 - 所有对战必须全部完成判定
      const [[{ unfinished }]] = await pool.query(
        'SELECT COUNT(*) as unfinished FROM dota2_event_matches WHERE event_id = ? AND match_status != 2',
        [eventId]
      );

      if (unfinished > 0) {
        return res.status(400).json({
          success: false,
          error: `还有 ${unfinished} 场对战未判定胜负，请先完成所有判定`,
          code: 'BATTLE_NOT_DONE'
        });
      }

      // 校验3 - 至少要有对战记录
      const [[{ totalMatches }]] = await pool.query(
        'SELECT COUNT(*) as totalMatches FROM dota2_event_matches WHERE event_id = ?',
        [eventId]
      );

      if (totalMatches === 0) {
        return res.status(400).json({ success: false, error: '当前赛事无对战记录，无法归档' });
      }

      // 状态 4→5，不同时设置归档标记
      // 归档操作由独立的 /archive 接口完成，中间允许设置名次
      const now = Date.now();
      const openid = req._openid || '';
      await pool.query(
        'UPDATE dota2_events SET event_status = 5, ended_by = ?, ended_at = ?, updated_at = ? WHERE event_id = ?',
        [openid, now, now, eventId]
      );

      // 统计各轮次信息
      const [roundStats] = await pool.query(
        `SELECT round_num, COUNT(*) as matches, SUM(CASE WHEN match_status = 2 THEN 1 ELSE 0 END) as done
         FROM dota2_event_matches WHERE event_id = ? GROUP BY round_num ORDER BY round_num ASC`,
        [eventId]
      );

      res.json({
        success: true,
        data: {
          totalRounds: roundStats.length,
          totalMatches,
          eventStatus: 5,
          message: '比赛已结束。请设定队伍名次，完成后点击「归档比赛」正式归档。'
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 【第7轮核心接口】赛事归档（admin/super_admin）
   * POST /api/events/:eventId/archive
   *
   * - 仅赛事状态=5(已结束)但未归档时可调用
   * - 设置 is_archived=1，记录操作人与时间
   * - 归档后所有修改类接口被全局拦截
   */
  app.post('/api/events/:eventId/archive', async (req, res) => {
    try {
      if (!await assertAdmin(req, res)) return;

      const { eventId } = req.params;

      // 【校验1】赛事存在且状态=5(已结束)
      const event = await validateEvent(pool, eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });

      if (event.event_status !== 5) {
        return res.status(400).json({
          success: false,
          error: `赛事当前状态为「${STATUS_NAMES[event.event_status]}」，需要先结束比赛完成后才可归档`,
          code: 'NOT_ENDED'
        });
      }

      // 校验2 - 防止重复归档
      if (event.is_archived === 1) {
        return res.status(400).json({
          success: false,
          error: '赛事已归档，无需重复操作',
          code: 'ALREADY_ARCHIVED'
        });
      }

      // 执行归档：设置 is_archived=1 + 记录操作人与时间 + 数据迁移到 _his 表
      const now = Date.now();
      const openid = req._openid || '';

      // 先统计各表数据量（归档前统计）
      const [[{ signupCount }]] = await pool.query(
        'SELECT COUNT(*) as signupCount FROM dota2_event_signup WHERE event_id = ? AND signup_status = 1', [eventId]
      );
      const [[{ teamCount }]] = await pool.query(
        'SELECT COUNT(*) as teamCount FROM dota2_event_teams WHERE event_id = ?', [eventId]
      );
      const [[{ matchCount }]] = await pool.query(
        'SELECT COUNT(*) as matchCount FROM dota2_event_matches WHERE event_id = ?', [eventId]
      );
      const [[{ rankCount }]] = await pool.query(
        'SELECT COUNT(*) as rankCount FROM dota2_event_ranks WHERE event_id = ?', [eventId]
      );

      // 【数据迁移】事务：1) 拷贝到 _his 表 2) 清理在线表 3) 更新事件标记
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();

        // 1) 拷贝事件元数据到 _his（保留完整记录）
        await conn.query(migrateSql('dota2_events'), [eventId]);

        // 2) 拷贝各业务表到 _his
        for (const table of ARCHIVE_TABLES) {
          await conn.query(migrateSql(table), [eventId]);
        }

        // 3) 清理在线表业务数据（保留 events 元数据 + 归档标记）
        for (const table of ARCHIVE_TABLES) {
          await conn.query(cleanSql(table), [eventId]);
        }

        // 4) 更新 events 归档标记 + 状态推进到6
        await conn.query(
          'UPDATE dota2_events SET is_archived = 1, event_status = 6, archived_by = ?, archived_at = ?, updated_at = ? WHERE event_id = ?',
          [openid, now, now, eventId]
        );

        // 5) 同步更新 _his 表的归档标记（INSERT IGNORE 时 is_archived 仍为 0，需对齐）
        await conn.query(
          'UPDATE dota2_events_his SET is_archived = 1, archived_by = ?, archived_at = ? WHERE event_id = ?',
          [openid, now, eventId]
        );

        await conn.commit();
      } catch (err) {
        await safeRollback(conn, 'archiveEvent');
        throw err;
      } finally {
        conn.release();
      }

      // 获取操作人昵称
      const nickMap = await getUserNicknames(pool, [openid]);

      res.json({
        success: true,
        data: {
          eventId,
          archivedAt: now,
          archivedBy: nickMap.get(openid) || '',
          summary: { signups: signupCount, teams: teamCount, matches: matchCount, ranks: rankCount },
          message: '赛事已归档，所有数据固化为只读状态，不可再修改。'
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ════════════════════════════════════════════════════════════
  // 5. 名次管理模块（dota2_event_ranks）
  // ════════════════════════════════════════════════════════════

  /**
   * 获取某赛事名次排行（增强版：含队员昵称）
   * GET /api/events/:eventId/ranks
   * - 所有用户可查看，按名次升序
   * - 返回每个名次的队伍详情：队员昵称列表、队长信息
   */
  app.get('/api/events/:eventId/ranks', async (req, res) => {
    try {
      const { eventId } = req.params;
      const event = await validateEvent(pool, eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });

      const isArchived = event.is_archived === 1;
      const ranksTable = tableFor('dota2_event_ranks', isArchived);
      const teamsTable = tableFor('dota2_event_teams', isArchived);
      const matchesTable = tableFor('dota2_event_matches', isArchived);

      const [rows] = await pool.query(
        `SELECT r.*, t.team_name, t.total_mmr, t.player_ids, t.captain_id
         FROM ${ranksTable} r
         LEFT JOIN ${teamsTable} t ON r.team_id COLLATE utf8mb4_unicode_ci = t.team_id COLLATE utf8mb4_unicode_ci
         WHERE r.event_id = ? ORDER BY r.rank_num ASC`,
        [eventId]
      );

      // 统计每队的胜负场次
      const [winRows] = await pool.query(
        `SELECT winner_id, COUNT(*) as wins
         FROM ${matchesTable}
         WHERE event_id = ? AND match_status = 2 AND winner_id IS NOT NULL
         GROUP BY winner_id`,
        [eventId]
      );
      const winMap = {};
      (winRows || []).forEach(r => { winMap[r.winner_id] = r.wins; });

      const [playRows] = await pool.query(
        `SELECT team_id, COUNT(*) as total
         FROM (
           SELECT team_a_id as team_id FROM ${matchesTable} WHERE event_id = ? AND match_status = 2
           UNION ALL
           SELECT team_b_id as team_id FROM ${matchesTable} WHERE event_id = ? AND match_status = 2
         ) t
         GROUP BY team_id`,
        [eventId, eventId]
      );
      const playMap = {};
      (playRows || []).forEach(r => { playMap[r.team_id] = r.total; });

      // 收集所有队员ID，批量查询昵称
      const allPlayerIds = new Set();
      rows.forEach(row => {
        try {
          const ids = row.player_ids ? JSON.parse(row.player_ids) : [];
          ids.forEach(id => allPlayerIds.add(id));
        } catch (_) {}
      });
      const playerMap = {};
      if (allPlayerIds.size > 0) {
        const players = await getPlayersByIds(pool, [...allPlayerIds]);
        players.forEach(p => { playerMap[p.id] = p.wx_nickname || ''; });
      }

      // 查找 operator 昵称（将 openid 转为昵称）
      const allOperatorIds = [...new Set(rows.map(r => r.operator_id).filter(Boolean))];
      const operatorNickMap = await getUserNicknames(pool, allOperatorIds);

      // 组装结果：附加队员昵称列表 + operator_nickname + 队长标记 + 平均分
      const data = rows.map(row => {
        let members = [];
        let memberCount = 0;
        try {
          const ids = row.player_ids ? JSON.parse(row.player_ids) : [];
          memberCount = ids.length;
          members = ids.map(id => ({
            id,
            nickName: playerMap[id] || '',
            isCaptain: id === row.captain_id
          }));
          // 队长排最前
          members.sort((a, b) => (b.isCaptain ? 1 : 0) - (a.isCaptain ? 1 : 0));
        } catch (_) {}
        const captainName = playerMap[row.captain_id] || '';
        const avgMmr = memberCount > 0 && row.total_mmr
          ? Math.round(row.total_mmr / memberCount)
          : 0;
        const wins = winMap[row.team_id] || 0;
        const totalPlayed = playMap[row.team_id] || 0;
        return {
          rank_id: row.rank_id,
          event_id: row.event_id,
          rank_num: row.rank_num,
          team_id: row.team_id,
          team_name: row.team_name || '未知队伍',
          total_mmr: row.total_mmr || 0,
          avg_mmr: avgMmr,
          member_count: memberCount,
          captain_name: captainName,
          members,
          wins,
          losses: Math.max(0, totalPlayed - wins),
          operator_nickname: operatorNickMap.get(row.operator_id) || '',
          created_at: row.created_at
        };
      });

      res.json({ success: true, data });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 【第7轮改造】批量保存名次（admin/super_admin）
   * POST /api/events/:eventId/ranks/batch
   * Body: { ranks: [{ rankNum: 1, teamId: "xxx" }, ...] }
   *
   * - 全量替换：先删除该赛事所有现有名次，再批量插入
   * - 校验同赛事同名次不重复
   * - 名次非必填：rankNum 和 teamId 为空的项会跳过
   * - 已归档赛事拒绝操作
   */
  app.post('/api/events/:eventId/ranks/batch', async (req, res) => {
    try {
      if (!await assertAdmin(req, res)) return;
      const { eventId } = req.params;

      // 归档只读拦截：已归档赛事不可修改名次
      const archiveCheck = await checkNotArchived(pool, eventId);
      if (archiveCheck.blocked) {
        return res.status(403).json({ success: false, error: archiveCheck.error, code: 'ARCHIVED' });
      }

      // 【赛事状态校验】仅已结束(status=5)的比赛可以设定名次
      const event = await validateEvent(pool, eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });
      if (event.event_status !== 5) {
        return res.status(400).json({ success: false, error: `赛事当前状态为「${STATUS_NAMES[event.event_status]}」，需先结束比赛后才可设定名次`, code: 'NOT_ENDED' });
      }

      const { ranks } = req.body;
      if (!ranks || !Array.isArray(ranks)) {
        return res.status(400).json({ success: false, error: '参数 ranks 必须是数组' });
      }

      // 【过滤】去除无效项（空 rankNum 或空 teamId）
      const validRanks = ranks.filter(r =>
        r.rankNum !== undefined && r.rankNum !== null && r.rankNum !== '' &&
        r.teamId && r.teamId !== ''
      );

      // 【重复校验】同赛事内 rankNum 不可重复
      const rankNumSet = new Set();
      for (const r of validRanks) {
        const rn = parseInt(r.rankNum);
        if (rankNumSet.has(rn)) {
          return res.status(400).json({ success: false, error: `第${rn}名重复，请检查后重新提交` });
        }
        rankNumSet.add(rn);
      }

      // 【队伍存在性校验】确保所有 teamId 在该赛事中真实存在
      const teamsTable = tableFor('dota2_event_teams', false);
      const teamIds = [...new Set(validRanks.map(r => r.teamId))];
      if (teamIds.length > 0) {
        const [existTeams] = await pool.query(
          `SELECT team_id FROM ${teamsTable} WHERE event_id = ? AND team_id IN (?)`,
          [eventId, teamIds]
        );
        const existSet = new Set(existTeams.map(t => t.team_id));
        for (const r of validRanks) {
          if (!existSet.has(r.teamId)) {
            return res.status(400).json({ success: false, error: `队伍 ${r.teamId} 不存在，请刷新后重试`, code: 'INVALID_TEAM' });
          }
        }
      }

      const openid = req._openid || '';
      const now = Date.now();

      // 事务操作：删除旧数据 + 批量插入新数据
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();

        // 删除该赛事所有现有名次
        await conn.query('DELETE FROM dota2_event_ranks WHERE event_id = ?', [eventId]);

        // 批量插入新名次
        for (const r of validRanks) {
          const rankId = genId();
          const rankNum = parseInt(r.rankNum);
          await conn.query(
            'INSERT INTO dota2_event_ranks (rank_id, event_id, rank_num, team_id, operator_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            [rankId, eventId, rankNum, r.teamId, openid, now]
          );
        }

        await conn.commit();
        res.json({
          success: true,
          data: {
            savedCount: validRanks.length,
            skippedCount: ranks.length - validRanks.length,
            message: `成功保存 ${validRanks.length} 个名次${ranks.length - validRanks.length > 0 ? '，跳过 ' + (ranks.length - validRanks.length) + ' 个空项' : ''}`
          }
        });
      } catch (e) {
        await safeRollback(conn, 'batchRanks');
        if (e.code === 'ER_DUP_ENTRY') {
          return res.status(400).json({ success: false, error: '存在重复名次，请检查后重新提交' });
        }
        throw e;
      } finally {
        conn.release();
      }
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * 【第7轮归档拦截】设置单个名次（兼容旧接口，内部加归档校验）
   * POST /api/events/:eventId/ranks
   * Body: { rankNum, teamId }
   */
  app.post('/api/events/:eventId/ranks', async (req, res) => {
    try {
      if (!await assertAdmin(req, res)) return;
      const { eventId } = req.params;
      const event = await validateEvent(pool, eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });

      // 【归档只读拦截】
      const archiveCheck = await checkNotArchived(pool, eventId);
      if (archiveCheck.blocked) {
        return res.status(403).json({ success: false, error: archiveCheck.error, code: 'ARCHIVED' });
      }

      // 【赛事状态校验】仅已结束的比赛可以设定名次
      if (event.event_status !== 5) {
        return res.status(400).json({ success: false, error: `赛事当前状态为「${STATUS_NAMES[event.event_status]}」，需先结束比赛后才可设定名次`, code: 'NOT_ENDED' });
      }

      const { rankNum, teamId } = req.body;
      if (rankNum === undefined || rankNum < 1) return res.status(400).json({ success: false, error: '排名序号无效' });
      if (!teamId) return res.status(400).json({ success: false, error: '队伍ID不能为空' });

      try {
        const rankId = genId();
        await pool.query(
          'INSERT INTO dota2_event_ranks (rank_id, event_id, rank_num, team_id, operator_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          [rankId, eventId, rankNum, teamId, req._openid || '', Date.now()]
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
   * 【第7轮归档拦截】更新名次（admin/super_admin）
   * PUT /api/events/:eventId/ranks/:rankId
   */
  app.put('/api/events/:eventId/ranks/:rankId', async (req, res) => {
    try {
      if (!await assertAdmin(req, res)) return;
      const { eventId, rankId } = req.params;

      // 【归档只读拦截】
      const archiveCheck = await checkNotArchived(pool, eventId);
      if (archiveCheck.blocked) {
        return res.status(403).json({ success: false, error: archiveCheck.error, code: 'ARCHIVED' });
      }

      // 【赛事状态校验】仅已结束的比赛可以修改名次
      const event = await validateEvent(pool, eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });
      if (event.event_status !== 5) {
        return res.status(400).json({ success: false, error: `赛事当前状态为「${STATUS_NAMES[event.event_status]}」，需先结束比赛后才可修改名次`, code: 'NOT_ENDED' });
      }

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
        values.push(req._openid || '', rankId, eventId);
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
   * 【第7轮归档拦截】删除名次记录（admin/super_admin）
   * DELETE /api/events/:eventId/ranks/:rankId
   */
  app.delete('/api/events/:eventId/ranks/:rankId', async (req, res) => {
    try {
      if (!await assertAdmin(req, res)) return;
      const { eventId, rankId } = req.params;

      // 【归档只读拦截】
      const archiveCheck = await checkNotArchived(pool, eventId);
      if (archiveCheck.blocked) {
        return res.status(403).json({ success: false, error: archiveCheck.error, code: 'ARCHIVED' });
      }

      // 【赛事状态校验】仅已结束的比赛可以删除名次
      const event = await validateEvent(pool, eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });
      if (event.event_status !== 5) {
        return res.status(400).json({ success: false, error: `赛事当前状态为「${STATUS_NAMES[event.event_status]}」，需先结束比赛后才可删除名次`, code: 'NOT_ENDED' });
      }

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
      const openid = req._openid || '';
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
        [ruleId, eventId || null, ruleTitle, ruleContent, version || 1, req._openid || '', Date.now(), Date.now()]
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
