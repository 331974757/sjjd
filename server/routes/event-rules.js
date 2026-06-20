/**
 * 赛事章程路由 — 章程列表/详情/赛事章程/创建/编辑/删除
 * 原 event-routes.js 第6部分（约第3204-3375行）
 */
module.exports = function (app, h) {

  /**
   * 获取章程列表（公开）
   * GET /api/rules?eventId=&status=1&page=1&pageSize=20
   * - eventId 为空时返回通用章程(event_id IS NULL)
   * - status 筛选：0草稿/1已发布（普通用户只能看已发布）
   */
  app.get('/api/rules', async (req, res) => {
    try {
      const openid = req._openid || '';
      const role = await h.getCallerRole(openid);
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

      const [rows] = await h.pool.query(sql, [...params, ps, (p - 1) * ps]);
      const [[{ total }]] = await h.pool.query(countSql, params);

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
      const [rows] = await h.pool.query('SELECT * FROM dota2_event_rules WHERE rule_id = ?', [ruleId]);
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
      const event = await h.validateEvent(eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });

      // 先查绑定该赛事的已发布章程
      const [rows] = await h.pool.query(
        'SELECT * FROM dota2_event_rules WHERE event_id = ? AND rule_status = 1 ORDER BY version DESC LIMIT 1',
        [eventId]
      );
      if (rows.length) return res.json({ success: true, data: rows[0] });

      // 查通用章程
      const [general] = await h.pool.query(
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
      if (!await h.assertAdmin(req, res)) return;

      const { eventId, ruleTitle, ruleContent, version } = req.body;
      if (!ruleTitle) return res.status(400).json({ success: false, error: '章程标题不能为空' });
      if (!ruleContent) return res.status(400).json({ success: false, error: '章程内容不能为空' });

      // 如果指定了 eventId，校验赛事存在
      if (eventId) {
        const event = await h.validateEvent(eventId);
        if (!event) return res.status(404).json({ success: false, error: '关联赛事不存在' });
      }

      const ruleId = h.genId();
      await h.pool.query(
        'INSERT INTO dota2_event_rules (rule_id, event_id, rule_title, rule_content, version, rule_status, creator_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, NOW(), NOW())',
        [ruleId, eventId || null, ruleTitle, ruleContent, version || 1, req._openid || '']
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
      if (!await h.assertAdmin(req, res)) return;
      const { ruleId } = req.params;
      const [rules] = await h.pool.query('SELECT * FROM dota2_event_rules WHERE rule_id = ?', [ruleId]);
      if (!rules.length) return res.status(404).json({ success: false, error: '章程不存在' });

      const { ruleTitle, ruleContent, version, ruleStatus } = req.body;
      const sets = [];
      const values = [];

      if (ruleTitle !== undefined) { sets.push('rule_title = ?'); values.push(ruleTitle); }
      if (ruleContent !== undefined) { sets.push('rule_content = ?'); values.push(ruleContent); }
      if (version !== undefined) { sets.push('version = ?'); values.push(version); }
      if (ruleStatus !== undefined) { sets.push('rule_status = ?'); values.push(ruleStatus); }

      if (sets.length > 0) {
        sets.push('updated_at = NOW()');
        values.push(ruleId);
        await h.pool.query('UPDATE dota2_event_rules SET ' + sets.join(', ') + ' WHERE rule_id = ?', values);
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
      if (!await h.assertAdmin(req, res)) return;
      const { ruleId } = req.params;
      await h.pool.query('DELETE FROM dota2_event_rules WHERE rule_id = ?', [ruleId]);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

};
