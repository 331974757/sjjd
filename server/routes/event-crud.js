/**
 * 赛事 CRUD 路由 — 创建/列表/详情/编辑/状态/删除
 */
module.exports = function (app, h) {

  /** GET /api/events — 赛事列表 */
  app.get('/api/events', async (req, res) => {
    try {
      const { status, archived, page, pageSize } = req.query;
      let where = ' WHERE 1=1';
      const params = [];

      if (status !== undefined && status !== '') {
        where += ' AND event_status = ?';
        params.push(parseInt(status) || 0);
      }
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

      const [rows] = await h.pool.query(sql, [...params, ps, (p - 1) * ps]);
      const [[{ total }]] = await h.pool.query(countSql, params);

      const data = await Promise.all(rows.map(r => h.resolveCreatorNickname(r)));
      res.json({ success: true, data, total, page: p, pageSize: ps });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /** GET /api/events/archived — 已归档赛事列表（含参赛人数+前三名） */
  app.get('/api/events/archived', async (req, res) => {
    try {
      const { keyword, page, pageSize } = req.query;
      const p = parseInt(page) || 1;
      const ps = Math.min(parseInt(pageSize) || 10, 50);

      let where = ' WHERE e.is_archived = 1';
      const params = [];

      if (keyword && keyword.trim()) {
        where += ' AND e.event_name LIKE ?';
        params.push('%' + keyword.trim() + '%');
      }

      const sql = `
        SELECT e.*, COALESCE(sc.cnt, 0) as signup_count
        FROM dota2_events e
        LEFT JOIN (
          SELECT event_id, COUNT(*) AS cnt
          FROM dota2_event_signup_his
          WHERE signup_status = 1
          GROUP BY event_id
        ) sc ON sc.event_id COLLATE utf8mb4_unicode_ci = e.event_id COLLATE utf8mb4_unicode_ci
        ${where}
        ORDER BY e.archived_at DESC, e.created_at DESC
        LIMIT ? OFFSET ?
      `;
      const countSql = `SELECT COUNT(*) as total FROM dota2_events e ${where}`;

      const [rows] = await h.pool.query(sql, [...params, ps, (p - 1) * ps]);
      const [[{ total }]] = await h.pool.query(countSql, params);

      const eventIds = rows.map(r => r.event_id);
      let rankMap = {};
      if (eventIds.length > 0) {
        const [allRanks] = await h.pool.query(
          `SELECT r.event_id, r.rank_num, r.team_id, t.team_name, t.total_mmr, t.player_ids, t.captain_id
           FROM dota2_event_ranks_his r
           LEFT JOIN dota2_event_teams_his t ON r.team_id COLLATE utf8mb4_unicode_ci = t.team_id COLLATE utf8mb4_unicode_ci
           WHERE r.event_id IN (?) AND r.rank_num <= 3
           ORDER BY r.event_id, r.rank_num ASC`,
          [eventIds]
        );

        const rankAllPlayerIds = new Set();
        allRanks.forEach(r => {
          try { const ids = JSON.parse(r.player_ids || '[]'); ids.forEach(id => rankAllPlayerIds.add(id)); } catch (_) { }
          if (r.captain_id) rankAllPlayerIds.add(r.captain_id);
        });
        const rankPlayerMap = {};
        if (rankAllPlayerIds.size > 0) {
          const rankPlayers = await h.getPlayersByIds([...rankAllPlayerIds]);
          rankPlayers.forEach(p => { rankPlayerMap[p.id] = p.wx_nickname || ''; });
        }

        const [arcWinRows] = await h.pool.query(
          `SELECT winner_id, COUNT(*) as wins
           FROM dota2_event_matches_his
           WHERE event_id IN (?) AND match_status = 2 AND winner_id IS NOT NULL
           GROUP BY winner_id`,
          [eventIds]
        );
        const arcWinMap = {};
        (arcWinRows || []).forEach(r => { arcWinMap[r.winner_id] = r.wins; });

        const [arcPlayRows] = await h.pool.query(
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

        for (const rank of allRanks) {
          if (!rankMap[rank.event_id]) rankMap[rank.event_id] = [];
          let members = [];
          try {
            const ids = JSON.parse(rank.player_ids || '[]');
            members = ids.map(id => ({
              id, nickName: rankPlayerMap[id] || '', isCaptain: id === rank.captain_id
            }));
            members.sort((a, b) => (b.isCaptain ? 1 : 0) - (a.isCaptain ? 1 : 0));
          } catch (_) { }
          const wins = arcWinMap[rank.team_id] || 0;
          const totalPlayed = arcPlayMap[rank.team_id] || 0;
          rankMap[rank.event_id].push({
            rankNum: rank.rank_num, teamId: rank.team_id, teamName: rank.team_name || '未知队伍',
            captainName: rankPlayerMap[rank.captain_id] || '', members,
            wins, losses: Math.max(0, totalPlayed - wins), totalMmr: rank.total_mmr || 0
          });
        }
      }

      const allOpenids = new Set();
      rows.forEach(e => {
        if (e.creator_id) allOpenids.add(e.creator_id);
        if (e.ended_by && e.ended_by.length > 10) allOpenids.add(e.ended_by);
        if (e.archived_by && e.archived_by.length > 10) allOpenids.add(e.archived_by);
      });
      const nickMap = await h.getUserNicknames([...allOpenids]);

      const data = rows.map(e => {
        const item = { ...e };
        if (item.creator_id) { item.creator_nickname = nickMap.get(item.creator_id) || ''; delete item.creator_id; }
        if (item.ended_by && item.ended_by.length > 10) { item.ended_by_nickname = nickMap.get(item.ended_by) || ''; delete item.ended_by; }
        if (item.archived_by && item.archived_by.length > 10) { item.archived_by_nickname = nickMap.get(item.archived_by) || ''; delete item.archived_by; }
        return { ...item, signupCount: e.signup_count || 0, topRanks: rankMap[e.event_id] || [] };
      });

      res.json({ success: true, data, total, page: p, pageSize: ps });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /** GET /api/events/:eventId — 单场赛事详情 */
  app.get('/api/events/:eventId', async (req, res) => {
    try {
      const { eventId } = req.params;
      const [rows] = await h.pool.query('SELECT * FROM dota2_events WHERE event_id = ?', [eventId]);
      if (!rows.length) return res.status(404).json({ success: false, error: '赛事不存在' });
      const event = await h.resolveCreatorNickname(rows[0]);
      res.json({ success: true, data: event });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /** POST /api/events — 创建赛事 */
  async function handleCreateEvent(req, res) {
    try {
      const eventName = (req.body.event_name || req.body.eventName || '').trim();
      let startTime = req.body.start_time || req.body.startTime || null;
      // 毫秒时间戳 → MySQL datetime 格式
      if (startTime && !isNaN(Number(startTime))) {
        const ts = Number(startTime);
        // 过去超过1天的时间视为无效（允许少量时差）
        if (ts < Date.now() - 86400000) {
          return res.status(400).json({ success: false, error: '赛事时间不能是过去' });
        }
        // 拒绝超过2年后的时间
        if (ts > Date.now() + 730 * 86400000) {
          return res.status(400).json({ success: false, error: '赛事时间不能超过2年后' });
        }
        startTime = new Date(ts).toISOString().slice(0, 19).replace('T', ' ');
      }
      const eventDesc = (req.body.event_desc || req.body.eventDesc || '').trim();
      const signupLimitRaw = req.body.signup_limit || req.body.signupLimit || 0;
      const signupLimitVal = Math.max(0, parseInt(signupLimitRaw) || 0);

      if (!eventName) return res.status(400).json({ success: false, error: '请输入赛事名称' });
      if (eventName.length < 2) return res.status(400).json({ success: false, error: '赛事名称至少需要2个字符' });
      if (eventName.length > 50) return res.status(400).json({ success: false, error: '赛事名称不能超过50个字符' });

      const eventId = h.genId();
      const openid = req._openid || '';
      const limitDb = signupLimitVal > 0 ? signupLimitVal : null;

      await h.pool.query(
        'INSERT INTO dota2_events (event_id, event_name, event_desc, creator_id, event_status, start_time, signup_limit, is_archived, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, 0, NOW(), NOW())',
        [eventId, eventName, eventDesc || null, openid, startTime, limitDb]
      );

      res.json({
        success: true,
        data: { eventId, eventName, eventDesc: eventDesc || '', startTime, signupLimit: signupLimitVal > 0 ? signupLimitVal : null, eventStatus: 0, isArchived: 0, creatorId: openid, createdAt: new Date().toISOString(), message: '赛事创建成功' }
      });
    } catch (e) {
      console.error('[创建赛事] 未预期错误', e);
      res.status(500).json({ success: false, error: e.message });
    }
  }

  app.post('/api/events', h.auth.requireAdmin, handleCreateEvent);

  /** PUT /api/events/:eventId — 编辑赛事信息 */
  app.put('/api/events/:eventId', h.auth.requireAdminNotArchived, async (req, res) => {
    try {
      const { eventId } = req.params;
      const event = await h.validateEvent(eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });

      if (event.is_archived === 1) {
        return res.status(403).json({ success: false, error: '赛事已归档，不可修改基本信息', code: 'ARCHIVED' });
      }

      const { eventName, eventDesc, startTime } = req.body;
      const sets = [];
      const values = [];
      if (eventName !== undefined) { sets.push('event_name = ?'); values.push(eventName); }
      if (eventDesc !== undefined) { sets.push('event_desc = ?'); values.push(eventDesc); }
      if (startTime !== undefined) {
        // 毫秒时间戳 → MySQL datetime 格式
        let st = startTime
        if (st && !isNaN(Number(st))) {
          st = new Date(Number(st)).toISOString().slice(0, 19).replace('T', ' ')
        }
        sets.push('start_time = ?'); values.push(st);
      }

      if (sets.length > 0) {
        sets.push('updated_at = NOW()');
        values.push(eventId);
        await h.pool.query('UPDATE dota2_events SET ' + sets.join(', ') + ' WHERE event_id = ?', values);
      }
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /** PUT /api/events/:eventId/status — 更新赛事状态 */
  app.put('/api/events/:eventId/status', h.auth.requireAdmin, async (req, res) => {
    try {
      const { eventId } = req.params;
      const event = await h.validateEvent(eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });

      if (event.is_archived === 1) {
        return res.status(403).json({ success: false, error: '赛事已归档，不可修改状态', code: 'ARCHIVED' });
      }

      const { eventStatus, signupLimit } = req.body;
      if (!Number.isInteger(eventStatus) || eventStatus < 0 || eventStatus > 6) {
        return res.status(400).json({ success: false, error: '无效的赛事状态，有效值0-6' });
      }

      const transition = h.validateStatusTransition(event.event_status, eventStatus);
      if (!transition.valid) {
        return res.status(400).json({ success: false, error: transition.error });
      }

      // 截止报名时校验最低人数
      if (eventStatus === 2) {
        const [[{ cnt }]] = await h.pool.query(
          'SELECT COUNT(*) AS cnt FROM dota2_event_signup WHERE event_id = ? AND signup_status = 1', [eventId]
        );
        if (cnt < 10) {
          return res.status(400).json({
            success: false, error: `报名人数不足（当前 ${cnt} 人），至少需要 10 人才能截止报名`,
            code: 'SIGNUP_TOO_FEW'
          });
        }
      }

      const limitVal = (eventStatus === 1 && signupLimit !== undefined) ? signupLimit : null;
      if (limitVal !== null) {
        if (typeof limitVal !== 'number' || limitVal < 0 || (limitVal !== 0 && !Number.isInteger(limitVal))) {
          return res.status(400).json({ success: false, error: '报名人数上限必须为非负整数（0=无限制）' });
        }
      }

      if (limitVal !== null) {
        const setLimit = (limitVal === 0 ? null : limitVal);
        try {
          await h.pool.query(
            'UPDATE dota2_events SET event_status = ?, signup_limit = ?, updated_at = NOW() WHERE event_id = ?',
            [eventStatus, setLimit, eventId]
          );
        } catch (e) {
          if (e.code === 'ER_BAD_FIELD_ERROR') {
            await h.pool.query(
              'UPDATE dota2_events SET event_status = ?, updated_at = NOW() WHERE event_id = ?',
              [eventStatus, eventId]
            );
          } else { throw e; }
        }
      } else {
        await h.pool.query(
          'UPDATE dota2_events SET event_status = ?, updated_at = NOW() WHERE event_id = ?',
          [eventStatus, eventId]
        );
      }
      res.json({
        success: true,
        data: {
          fromStatus: event.event_status, fromStatusName: h.STATUS_NAMES[event.event_status],
          toStatus: eventStatus, toStatusName: h.STATUS_NAMES[eventStatus]
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /** PUT /api/events/:eventId/signup-limit — 修改报名人数上限 */
  app.put('/api/events/:eventId/signup-limit', h.auth.requireAdmin, async (req, res) => {
    try {
      const { eventId } = req.params;
      const event = await h.validateEvent(eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });

      if (event.is_archived === 1) {
        return res.status(403).json({ success: false, error: '赛事已归档，不可修改', code: 'ARCHIVED' });
      }

      if (event.event_status >= 3) {
        return res.status(400).json({
          success: false,
          error: `当前为「${h.STATUS_NAMES[event.event_status] || '未知'}」阶段，不可修改报名人数上限`,
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

      const [[{ currentCount }]] = await h.pool.query(
        'SELECT COUNT(*) as currentCount FROM dota2_event_signup WHERE event_id = ? AND signup_status = 1', [eventId]
      );

      await h.pool.query(
        'UPDATE dota2_events SET signup_limit = ?, updated_at = NOW() WHERE event_id = ?',
        [limitVal === 0 ? null : limitVal, eventId]
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

  /** DELETE /api/events/:eventId — 删除赛事（仅 super_admin） */
  app.delete('/api/events/:eventId', h.auth.requireSuperAdmin, async (req, res) => {
    try {
      const { eventId } = req.params;
      const event = await h.validateEvent(eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });
      if (event.is_archived === 1) return res.status(403).json({ success: false, error: '已归档赛事不可删除' });
      if (event.event_status >= 4) return res.status(403).json({ success: false, error: '对战已开始，赛事不可删除' });

      const conn = await h.pool.getConnection();
      try {
        await conn.beginTransaction();
        await conn.query('DELETE FROM dota2_event_signup WHERE event_id = ?', [eventId]);
        await conn.query('DELETE FROM dota2_event_ranks WHERE event_id = ?', [eventId]);
        await conn.query('DELETE FROM dota2_event_matches WHERE event_id = ?', [eventId]);
        await conn.query('DELETE FROM dota2_event_teams WHERE event_id = ?', [eventId]);
        await conn.query('DELETE FROM dota2_event_rules WHERE event_id = ?', [eventId]);
        await conn.query('DELETE FROM dota2_events WHERE event_id = ?', [eventId]);
        await conn.query('DELETE FROM dota2_event_signup_his WHERE event_id = ?', [eventId]);
        await conn.query('DELETE FROM dota2_event_teams_his WHERE event_id = ?', [eventId]);
        await conn.query('DELETE FROM dota2_event_matches_his WHERE event_id = ?', [eventId]);
        await conn.query('DELETE FROM dota2_event_ranks_his WHERE event_id = ?', [eventId]);
        await conn.query('DELETE FROM dota2_events_his WHERE event_id = ?', [eventId]);
        await conn.commit();
        res.json({ success: true });
      } catch (e) {
        await h.safeRollback(conn, 'deleteEvent');
        throw e;
      } finally {
        conn.release();
      }
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /** POST /api/events/:eventId/clone — 克隆赛事（复制名称/描述/时间/人数上限/章程） */
  app.post('/api/events/:eventId/clone', h.auth.requireAdmin, async (req, res) => {
    try {
      const { eventId } = req.params;
      const event = await h.validateEvent(eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });

      const newId = h.genId();
      const openid = req._openid || '';
      // 去掉旧名末尾的"（新）"或"(数字)"，再加"（新）"
      const newName = (event.event_name || '').replace(/[（(]\d*[)）]$/, '').replace(/（新）$/, '') + '（新）';

      await h.pool.query(
        'INSERT INTO dota2_events (event_id, event_name, event_desc, creator_id, event_status, start_time, signup_limit, is_archived, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, 0, NOW(), NOW())',
        [newId, newName, event.event_desc || null, openid, event.start_time || null, event.signup_limit || null]
      );

      // 克隆绑定的章程
      const [rules] = await h.pool.query(
        'SELECT * FROM dota2_event_rules WHERE event_id = ?', [eventId]
      );
      for (const rule of rules) {
        const ruleId = h.genId();
        await h.pool.query(
          'INSERT INTO dota2_event_rules (rule_id, event_id, rule_title, rule_content, version, rule_status, creator_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, NOW(), NOW())',
          [ruleId, newId, rule.rule_title, rule.rule_content, rule.version || 1, openid]
        );
      }

      res.json({ success: true, data: { eventId: newId, eventName: newName }, message: `已克隆为「${newName}」。（仅基本信息+章程已复制，报名、队伍、对战等数据需重新设置）` });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

};
