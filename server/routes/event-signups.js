/**
 * 报名管理路由 — 报名列表/自主报名/管理员添加/批量/取消/搜索
 * 原 event-routes.js 第2部分（约第705-1314行）
 */
module.exports = function (app, h) {

  /** GET /api/events/:eventId/signups — 获取报名列表 */
  app.get('/api/events/:eventId/signups', async (req, res) => {
    try {
      const { eventId } = req.params;
      const event = await h.validateEvent(eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });

      const isArchived = event.is_archived === 1;
      const signupTable = h.tableFor('dota2_event_signup', isArchived);

      const openid = req._openid || '';
      const role = await h.getCallerRole(openid);
      const isAdmin = role === 'admin' || role === 'super_admin';

      const { status, page, pageSize } = req.query;
      let where = ' WHERE s.event_id = ?';
      const params = [eventId];

      if (!isAdmin) {
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

      const [rows] = await h.pool.query(sql, [...params, ps, (p - 1) * ps]);
      const [[{ total }]] = await h.pool.query(countSql, params);

      const data = rows.map(r => { delete r.operator_id; return r; });
      res.json({ success: true, data, total, page: p, pageSize: ps });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /** GET /api/events/:eventId/my-signup — 查看本人报名状态 */
  app.get('/api/events/:eventId/my-signup', async (req, res) => {
    // ...existing code identical to original...
    try {
      const { eventId } = req.params;
      const openid = req._openid || '';
      if (!openid) return res.json({ success: true, signed: false });

      const [userRows] = await h.pool.query('SELECT nick_name FROM users WHERE openid = ?', [openid]);
      const userNick = (userRows.length && userRows[0].nick_name) ? userRows[0].nick_name : '';
      if (!userNick) return res.json({ success: true, signed: false, reason: 'no_nickname' });

      const [playerRows] = await h.pool.query(
        "SELECT id, wx_nickname FROM dota2_players WHERE wx_nickname = ? AND status = 'active'", [userNick]
      );
      if (!playerRows.length) return res.json({ success: true, signed: false, reason: 'no_player' });

      const playerId = playerRows[0].id;
      const event = await h.validateEvent(eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });

      const isArchived = event.is_archived === 1;
      const signupTable = h.tableFor('dota2_event_signup', isArchived);
      const [rows] = await h.pool.query(
        `SELECT * FROM ${signupTable} WHERE event_id = ? AND player_id = ?`, [eventId, playerId]
      );

      if (!rows.length) return res.json({ success: true, signed: false });
      const sig = rows[0];
      res.json({
        success: true, signed: true,
        data: { signupId: sig.signup_id, playerId, signupStatus: sig.signup_status, isActive: sig.signup_status === 1 }
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /** POST /api/events/:eventId/signups — 自主报名 */
  app.post('/api/events/:eventId/signups', async (req, res) => {
    try {
      const openid = req._openid || '';
      if (!openid) return res.status(401).json({ success: false, error: '请先登录' });

      const { eventId } = req.params;
      const eventCheck = await h.validateSignupEvent(eventId);
      if (!eventCheck.valid) {
        return res.status(400).json({ success: false, error: eventCheck.error });
      }

      const limitCheck = await h.checkSignupLimit(eventId);
      if (limitCheck.full) {
        return res.status(400).json({ success: false, error: limitCheck.error, code: 'LIMIT_FULL' });
      }

      const [userRows] = await h.pool.query('SELECT nick_name FROM users WHERE openid = ?', [openid]);
      const userNick = (userRows.length && userRows[0].nick_name) ? userRows[0].nick_name : '';
      const matchResult = await h.matchPlayerByNickname(userNick);
      if (!matchResult.success) {
        return res.status(400).json({ success: false, error: matchResult.message, code: matchResult.code });
      }

      const playerId = matchResult.playerId;
      const [existing] = await h.pool.query(
        'SELECT signup_id, signup_status FROM dota2_event_signup WHERE event_id = ? AND player_id = ?',
        [eventId, playerId]
      );

      if (existing.length > 0) {
        if (existing[0].signup_status === 1) {
          return res.status(400).json({ success: false, error: '您已报名本赛事，请勿重复报名', code: 'ALREADY_SIGNED' });
        }
        await h.pool.query(
          'UPDATE dota2_event_signup SET signup_status = 1, signup_type = 0, operator_id = ?, created_at = NOW() WHERE signup_id = ?',
          [openid, existing[0].signup_id]
        );
        return res.json({
          success: true,
          data: { signupId: existing[0].signup_id, playerId, playerInfo: matchResult.playerInfo, signupType: 'self_signup', message: '报名成功' }
        });
      }

      const signupId = h.genId();
      await h.pool.query(
        'INSERT INTO dota2_event_signup (signup_id, event_id, player_id, signup_type, signup_status, operator_id, created_at) VALUES (?, ?, ?, 0, 1, ?, NOW())',
        [signupId, eventId, playerId, openid]
      );

      res.json({
        success: true,
        data: { signupId, playerId, playerInfo: matchResult.playerInfo, signupType: 'self_signup', message: '报名成功' }
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /** POST /api/events/:eventId/signups/admin — 管理员添加报名 */
  app.post('/api/events/:eventId/signups/admin', async (req, res) => {
    try {
      if (!await h.assertAdmin(req, res)) return;
      const { eventId } = req.params;
      const event = await h.validateEvent(eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });
      if (event.is_archived === 1) {
        return res.status(403).json({ success: false, error: '赛事已归档，不可添加报名', code: 'ARCHIVED' });
      }

      const openid = req._openid || '';
      const { playerId } = req.body;
      if (!playerId) return res.status(400).json({ success: false, error: '选手ID不能为空' });

      const [players] = await h.pool.query(
        "SELECT id, wx_nickname, calibrate_rank_name, calibrate_rank_star FROM dota2_players WHERE id = ? AND status = 'active'",
        [playerId]
      );
      if (!players.length) return res.status(404).json({ success: false, error: '选手不存在' });

      const [existing] = await h.pool.query(
        'SELECT signup_id, signup_status FROM dota2_event_signup WHERE event_id = ? AND player_id = ?',
        [eventId, playerId]
      );

      if (existing.length > 0) {
        const row = existing[0];
        if (row.signup_status === 1) {
          return res.status(400).json({ success: false, error: '该选手已报名本赛事', code: 'ALREADY_SIGNED' });
        }
        await h.pool.query(
          'UPDATE dota2_event_signup SET signup_status = 1, signup_type = 1, operator_id = ?, created_at = NOW() WHERE signup_id = ?',
          [openid, row.signup_id]
        );
        return res.json({
          success: true,
          data: { signupId: row.signup_id, playerId, playerInfo: { wxNickname: players[0].wx_nickname, rankName: players[0].calibrate_rank_name, rankStar: players[0].calibrate_rank_star }, signupType: 'admin_add', reactivated: true }
        });
      }

      const signupId = h.genId();
      await h.pool.query(
        'INSERT INTO dota2_event_signup (signup_id, event_id, player_id, signup_type, signup_status, operator_id, created_at) VALUES (?, ?, ?, 1, 1, ?, NOW())',
        [signupId, eventId, playerId, openid]
      );
      res.json({
        success: true,
        data: { signupId, playerId, playerInfo: { wxNickname: players[0].wx_nickname, rankName: players[0].calibrate_rank_name, rankStar: players[0].calibrate_rank_star }, signupType: 'admin_add' }
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /** POST /api/events/:eventId/signups/batch — 管理员批量添加报名 */
  app.post('/api/events/:eventId/signups/batch', async (req, res) => {
    try {
      if (!await h.assertAdmin(req, res)) return;
      const { eventId } = req.params;
      const event = await h.validateEvent(eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });
      if (event.is_archived === 1) {
        return res.status(403).json({ success: false, error: '赛事已归档，不可批量添加', code: 'ARCHIVED' });
      }

      const { playerIds } = req.body;
      if (!playerIds || !Array.isArray(playerIds) || playerIds.length === 0) {
        return res.status(400).json({ success: false, error: '选手ID数组不能为空' });
      }

      const openid = req._openid || '';
      const results = [];
      let successCount = 0, skipCount = 0, failCount = 0;

      for (const playerId of playerIds) {
        try {
          const [existing] = await h.pool.query(
            'SELECT signup_id, signup_status FROM dota2_event_signup WHERE event_id = ? AND player_id = ?',
            [eventId, playerId]
          );
          if (existing.length > 0 && existing[0].signup_status === 1) {
            skipCount++;
            results.push({ playerId, status: 'skipped', reason: '已报名' });
            continue;
          }

          if (existing.length > 0) {
            await h.pool.query(
              'UPDATE dota2_event_signup SET signup_status = 1, signup_type = 1, operator_id = ?, created_at = NOW() WHERE signup_id = ?',
              [openid, existing[0].signup_id]
            );
          } else {
            const signupId = h.genId();
            await h.pool.query(
              'INSERT INTO dota2_event_signup (signup_id, event_id, player_id, signup_type, signup_status, operator_id, created_at) VALUES (?, ?, ?, 1, 1, ?, NOW())',
              [signupId, eventId, playerId, openid]
            );
          }
          successCount++;
          results.push({ playerId, status: 'success' });
        } catch (err) {
          failCount++;
          results.push({ playerId, status: 'failed', error: err.message });
        }
      }

      res.json({
        success: true,
        data: { successCount, skipCount, failCount, total: playerIds.length, results }
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /** DELETE /api/events/:eventId/signups/:signupId — 取消报名（软删除） */
  app.delete('/api/events/:eventId/signups/:signupId', async (req, res) => {
    try {
      const openid = req._openid || '';
      if (!openid) return res.status(401).json({ success: false, error: '请先登录' });

      const { eventId, signupId } = req.params;
      const event = await h.validateEvent(eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });
      if (event.is_archived === 1) {
        return res.status(403).json({ success: false, error: '赛事已归档，不可取消报名', code: 'ARCHIVED' });
      }

      const [rows] = await h.pool.query(
        'SELECT * FROM dota2_event_signup WHERE signup_id = ? AND event_id = ?',
        [signupId, eventId]
      );
      if (!rows.length) return res.status(404).json({ success: false, error: '报名记录不存在' });

      const signup = rows[0];
      if (signup.signup_status === 0) {
        return res.status(400).json({ success: false, error: '该报名已取消' });
      }

      const role = await h.getCallerRole(openid);
      const isAdmin = role === 'admin' || role === 'super_admin';
      if (!isAdmin) {
        const [userRows] = await h.pool.query('SELECT nick_name FROM users WHERE openid = ?', [openid]);
        const userNick = (userRows.length && userRows[0].nick_name) ? userRows[0].nick_name : '';
        if (!userNick) return res.status(403).json({ success: false, error: '您没有权限取消此报名' });
        const [playerRows] = await h.pool.query(
          "SELECT id FROM dota2_players WHERE wx_nickname = ? AND status = 'active'", [userNick]
        );
        if (!playerRows.length || playerRows[0].id !== signup.player_id) {
          return res.status(403).json({ success: false, error: '您只能取消自己的报名' });
        }
      }

      await h.pool.query(
        'UPDATE dota2_event_signup SET signup_status = 0, operator_id = ? WHERE signup_id = ?',
        [openid, signupId]
      );
      res.json({ success: true, data: { signupId, message: '已取消报名' } });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /** GET /api/search/players — 搜索选手 */
  app.get('/api/search/players', async (req, res) => {
    try {
      const { keyword } = req.query;
      if (!keyword || !keyword.trim()) return res.json({ success: true, data: [] });
      const kw = '%' + keyword.trim() + '%';
      const [rows] = await h.pool.query(
        "SELECT id, wx_nickname, calibrate_rank_name, calibrate_rank_star, avatar_url, game_id, calibrate_mmr FROM dota2_players WHERE status = 'active' AND (wx_nickname LIKE ? OR game_id LIKE ?) LIMIT 20",
        [kw, kw]
      );
      res.json({ success: true, data: rows });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /** GET /api/events/:eventId/signups/ids — 获取已报名选手ID列表 */
  app.get('/api/events/:eventId/signups/ids', async (req, res) => {
    try {
      const { eventId } = req.params;
      const event = await h.validateEvent(eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });

      const isArchived = event.is_archived === 1;
      const signupTable = h.tableFor('dota2_event_signup', isArchived);
      const [rows] = await h.pool.query(
        `SELECT player_id FROM ${signupTable} WHERE event_id = ? AND signup_status = 1`, [eventId]
      );
      const ids = rows.map(r => r.player_id);
      res.json({ success: true, data: ids });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

};
