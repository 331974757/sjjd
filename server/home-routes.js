/**
 * ============================================================
 * 首页业务模块 - 首页介绍 / 公告管理 / 数据统计 / 赛事动态
 *
 * 【整合方式】在 server/index.js 中 app.listen 之前添加一行：
 *   require('./home-routes')(app, { pool, assertAdmin, getCallerRole, upload });
 *
 * 与现有 server/index.js 共享：pool 连接池 / assertAdmin / getCallerRole
 * ============================================================
 */

const crypto = require('crypto');

function genId() {
  return crypto.randomBytes(16).toString('hex');
}

/** 将时间戳 (Number) 转为可读字符串 */
function formatTimestamp(ts) {
  if (!ts) return null;
  const d = new Date(Number(ts));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${h}:${mi}`;
}

module.exports = function (app, { pool, assertAdmin, getCallerRole, upload }) {

  // ==================== 确保表存在 ====================
  async function ensureTables() {
    const conn = await pool.getConnection();
    try {
      // 首页介绍表（单行数据）
      await conn.query(`
        CREATE TABLE IF NOT EXISTS home_intro (
          id       INT          NOT NULL DEFAULT 1 PRIMARY KEY,
          content  LONGTEXT     DEFAULT NULL COMMENT 'JSON图文内容 [{type, content/url}]',
          updated_at DATETIME   DEFAULT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      // 公告表
      await conn.query(`
        CREATE TABLE IF NOT EXISTS announcements (
          id          VARCHAR(64)  NOT NULL PRIMARY KEY,
          content     TEXT         NOT NULL COMMENT '公告文字',
          is_pinned   TINYINT      NOT NULL DEFAULT 0 COMMENT '是否置顶:0否1是',
          sort_order  INT          NOT NULL DEFAULT 0 COMMENT '排序权重(越大越前)',
          created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at  DATETIME     DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    } finally {
      conn.release();
    }
  }
  ensureTables().catch(e => console.error('[home-routes] 建表失败:', e.message));

  // ==================== 权限辅助 ====================

  /** 从请求中提取 operatorOpenid */
  function getOperatorOpenid(req) {
    return req._openid || '';
  }

  /** 断言当前用户是 super_admin，否则 403 */
  async function assertSuperAdmin(req, res, next) {
    try {
      const openid = getOperatorOpenid(req);
      if (!openid) return res.status(401).json({ success: false, error: '请先登录' });
      const role = await getCallerRole(openid);
      if (role !== 'super_admin') {
        return res.status(403).json({ success: false, error: '仅超级管理员可操作' });
      }
      next();
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  }

  // ==================== 1. 首页介绍接口 ====================

  /**
   * GET /api/home/intro - 获取首页图文介绍（全员可访问）
   */
  app.get('/api/home/intro', async (req, res) => {
    try {
      const [rows] = await pool.query('SELECT content, updated_at FROM home_intro WHERE id = 1');
      let content = null;
      if (rows.length && rows[0].content) {
        try { content = JSON.parse(rows[0].content); } catch (_) { content = rows[0].content; }
      }
      res.json({ success: true, data: content, updatedAt: rows.length ? rows[0].updated_at : null });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * PUT /api/home/intro - 保存首页图文介绍（仅 super_admin）
   * Body: { content: [...] } JSON数组
   */
  app.put('/api/home/intro', assertSuperAdmin, async (req, res) => {
    try {
      const { content } = req.body;
      const jsonStr = JSON.stringify(content || []);
      await pool.query(
        'INSERT INTO home_intro (id, content, updated_at) VALUES (1, ?, NOW()) ON DUPLICATE KEY UPDATE content = VALUES(content), updated_at = NOW()',
        [jsonStr]
      );
      res.json({ success: true, message: '保存成功' });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ==================== 2. 公告接口 ====================

  /**
   * GET /api/announcements - 获取公告列表（全员可访问）
   * 置顶优先，然后按 sort_order DESC
   */
  app.get('/api/announcements', async (req, res) => {
    try {
      const [rows] = await pool.query(
        'SELECT id, content, is_pinned, sort_order, created_at, updated_at FROM announcements ORDER BY is_pinned DESC, sort_order DESC, created_at DESC'
      );
      res.json({ success: true, data: rows });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * POST /api/announcements - 新增公告（仅 super_admin）
   * Body: { content, isPinned? }
   */
  app.post('/api/announcements', assertSuperAdmin, async (req, res) => {
    try {
      const { content, isPinned } = req.body;
      if (!content || !content.trim()) {
        return res.status(400).json({ success: false, message: '公告内容不能为空' });
      }
      const id = genId();
      // 获取当前最大 sort_order
      const [maxRows] = await pool.query('SELECT COALESCE(MAX(sort_order), 0) AS mx FROM announcements');
      const nextOrder = maxRows[0].mx + 1;
      await pool.query(
        'INSERT INTO announcements (id, content, is_pinned, sort_order, created_at) VALUES (?, ?, ?, ?, NOW())',
        [id, content.trim(), isPinned ? 1 : 0, nextOrder]
      );
      res.json({ success: true, message: '新增成功', data: { id } });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * PUT /api/announcements/:id - 编辑公告（仅 super_admin）
   * Body: { content }
   */
  app.put('/api/announcements/:id', assertSuperAdmin, async (req, res) => {
    try {
      const { content } = req.body;
      if (!content || !content.trim()) {
        return res.status(400).json({ success: false, message: '公告内容不能为空' });
      }
      const [result] = await pool.query(
        'UPDATE announcements SET content = ?, updated_at = NOW() WHERE id = ?',
        [content.trim(), req.params.id]
      );
      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, message: '公告不存在' });
      }
      res.json({ success: true, message: '编辑成功' });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * DELETE /api/announcements/:id - 删除公告（仅 super_admin）
   */
  app.delete('/api/announcements/:id', assertSuperAdmin, async (req, res) => {
    try {
      const [result] = await pool.query('DELETE FROM announcements WHERE id = ?', [req.params.id]);
      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, message: '公告不存在' });
      }
      res.json({ success: true, message: '已删除' });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * PUT /api/announcements/:id/pin - 置顶/取消置顶（仅 super_admin）
   * Body: { isPinned: true/false }
   */
  app.put('/api/announcements/:id/pin', assertSuperAdmin, async (req, res) => {
    try {
      const { isPinned } = req.body;
      const [result] = await pool.query(
        'UPDATE announcements SET is_pinned = ?, updated_at = NOW() WHERE id = ?',
        [isPinned ? 1 : 0, req.params.id]
      );
      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, message: '公告不存在' });
      }
      res.json({ success: true, message: isPinned ? '已置顶' : '已取消置顶' });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * PUT /api/announcements/sort - 排序公告（仅 super_admin）
   * Body: { ids: [...] } 按新的顺序排列的 ID 列表
   */
  app.put('/api/announcements/sort', assertSuperAdmin, async (req, res) => {
    try {
      const { ids } = req.body;
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ success: false, message: '请提供排序列表' });
      }
      // 批量更新 sort_order：越靠前越大
      for (let i = 0; i < ids.length; i++) {
        await pool.query('UPDATE announcements SET sort_order = ?, updated_at = NOW() WHERE id = ?',
          [ids.length - i, ids[i]]);
      }
      res.json({ success: true, message: '排序已更新' });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ==================== 3. 平台数据统计接口 ====================

  /**
   * GET /api/stats/platform - 获取平台统计数据（全员可访问）
   * 返回：累计注册选手、总赛事、进行中赛事、已完结赛事
   */
  app.get('/api/stats/platform', async (req, res) => {
    try {
      // 累计注册选手：有昵称或修改过昵称的用户
      const [userRows] = await pool.query(
        "SELECT COUNT(*) AS cnt FROM users WHERE nick_name != '' OR nick_change_count > 0"
      );
      // 总赛事（不含已归档）
      const [totalRows] = await pool.query(
        "SELECT COUNT(*) AS cnt FROM dota2_events WHERE is_archived = 0"
      );
      // 进行中赛事：状态 0-4（创建中/报名中/报名截止/对战预备/对战中）且未归档
      const [activeRows] = await pool.query(
        "SELECT COUNT(*) AS cnt FROM dota2_events WHERE event_status IN (0,1,2,3,4) AND is_archived = 0"
      );
      // 已完结赛事：状态 5 未归档 + 已归档
      const [finishedMain] = await pool.query(
        "SELECT COUNT(*) AS cnt FROM dota2_events WHERE event_status = 5 AND is_archived = 0"
      );
      const [archived] = await pool.query(
        "SELECT COUNT(*) AS cnt FROM dota2_events WHERE is_archived = 1"
      );

      res.json({
        success: true,
        data: {
          registeredPlayers: userRows[0].cnt || 0,
          totalEvents: totalRows[0].cnt || 0,
          activeEvents: activeRows[0].cnt || 0,
          finishedEvents: (finishedMain[0].cnt || 0) + (archived[0].cnt || 0)
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ==================== 4. 赛事动态接口 ====================

  /**
   * GET /api/events/dynamic - 获取赛事动态列表（全员可访问）
   * 仅展示状态 0-4（创建中/报名中/报名截止/对战预备/对战中）未归档赛事
   * 默认前8条，按创建时间倒序
   * Query: limit (默认8)
   */
  app.get('/api/events/dynamic', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 8, 20);
      const [rows] = await pool.query(`
        SELECT e.event_id AS id, e.event_name, e.event_status AS status,
               e.start_time, e.is_archived,
               COALESCE(s.signup_count, 0) AS signup_count
        FROM dota2_events e
        LEFT JOIN (
          SELECT event_id, COUNT(*) AS signup_count
          FROM dota2_event_signup
          WHERE signup_status = 1
          GROUP BY event_id
        ) s ON s.event_id = e.event_id
        WHERE e.event_status IN (0,1,2,3,4)
          AND e.is_archived = 0
        ORDER BY e.created_at DESC
        LIMIT ?
      `, [limit]);
      // 将 start_time 转为可读字符串
      const result = rows.map(r => ({
        ...r,
        event_time: r.start_time ? formatTimestamp(r.start_time) : null
      }));
      res.json({ success: true, data: result });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  console.log('[home-routes] 首页业务模块已加载');
};
