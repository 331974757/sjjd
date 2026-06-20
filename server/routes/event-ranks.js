/**
 * 名次管理路由 — 名次排行榜/批量保存/设置/更新/删除
 * 原 event-routes.js 第5部分（约第2856-3202行）
 */
module.exports = function (app, h) {

  /**
   * 获取某赛事名次排行（增强版：含队员昵称）
   * GET /api/events/:eventId/ranks
   * - 所有用户可查看，按名次升序
   * - 返回每个名次的队伍详情：队员昵称列表、队长信息
   */
  app.get('/api/events/:eventId/ranks', async (req, res) => {
    try {
      const { eventId } = req.params;
      const event = await h.validateEvent(eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });

      const isArchived = event.is_archived === 1;
      const ranksTable = h.tableFor('dota2_event_ranks', isArchived);
      const teamsTable = h.tableFor('dota2_event_teams', isArchived);
      const matchesTable = h.tableFor('dota2_event_matches', isArchived);

      const [rows] = await h.pool.query(
        `SELECT r.*, t.team_name, t.total_mmr, t.player_ids, t.captain_id
         FROM ${ranksTable} r
         LEFT JOIN ${teamsTable} t ON r.team_id COLLATE utf8mb4_unicode_ci = t.team_id COLLATE utf8mb4_unicode_ci
         WHERE r.event_id = ? ORDER BY r.rank_num ASC`,
        [eventId]
      );

      // 统计每队的胜负场次
      const [winRows] = await h.pool.query(
        `SELECT winner_id, COUNT(*) as wins
         FROM ${matchesTable}
         WHERE event_id = ? AND match_status = 2 AND winner_id IS NOT NULL
         GROUP BY winner_id`,
        [eventId]
      );
      const winMap = {};
      (winRows || []).forEach(r => { winMap[r.winner_id] = r.wins; });

      const [playRows] = await h.pool.query(
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
        const players = await h.getPlayersByIds([...allPlayerIds]);
        players.forEach(p => { playerMap[p.id] = p.wx_nickname || ''; });
      }

      // 查找 operator 昵称（将 openid 转为昵称）
      const allOperatorIds = [...new Set(rows.map(r => r.operator_id).filter(Boolean))];
      const operatorNickMap = await h.getUserNicknames(allOperatorIds);

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
      if (!await h.assertAdmin(req, res)) return;
      const { eventId } = req.params;

      // 归档只读拦截：已归档赛事不可修改名次
      const archiveCheck = await h.checkNotArchived(eventId);
      if (archiveCheck.blocked) {
        return res.status(403).json({ success: false, error: archiveCheck.error, code: 'ARCHIVED' });
      }

      // 【赛事状态校验】仅已结束(status=5)的比赛可以设定名次
      const event = await h.validateEvent(eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });
      if (event.event_status !== 5) {
        return res.status(400).json({ success: false, error: `赛事当前状态为「${h.STATUS_NAMES[event.event_status]}」，需先结束比赛后才可设定名次`, code: 'NOT_ENDED' });
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
      const teamsTable = h.tableFor('dota2_event_teams', false);
      const teamIds = [...new Set(validRanks.map(r => r.teamId))];
      if (teamIds.length > 0) {
        const [existTeams] = await h.pool.query(
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
      const conn = await h.pool.getConnection();
      try {
        await conn.beginTransaction();

        // 删除该赛事所有现有名次
        await conn.query('DELETE FROM dota2_event_ranks WHERE event_id = ?', [eventId]);

        // 批量插入新名次
        for (const r of validRanks) {
          const rankId = h.genId();
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
        await h.safeRollback(conn, 'batchRanks');
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
      if (!await h.assertAdmin(req, res)) return;
      const { eventId } = req.params;
      const event = await h.validateEvent(eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });

      // 【归档只读拦截】
      const archiveCheck = await h.checkNotArchived(eventId);
      if (archiveCheck.blocked) {
        return res.status(403).json({ success: false, error: archiveCheck.error, code: 'ARCHIVED' });
      }

      // 【赛事状态校验】仅已结束的比赛可以设定名次
      if (event.event_status !== 5) {
        return res.status(400).json({ success: false, error: `赛事当前状态为「${h.STATUS_NAMES[event.event_status]}」，需先结束比赛后才可设定名次`, code: 'NOT_ENDED' });
      }

      const { rankNum, teamId } = req.body;
      if (rankNum === undefined || rankNum < 1) return res.status(400).json({ success: false, error: '排名序号无效' });
      if (!teamId) return res.status(400).json({ success: false, error: '队伍ID不能为空' });

      try {
        const rankId = h.genId();
        await h.pool.query(
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
      if (!await h.assertAdmin(req, res)) return;
      const { eventId, rankId } = req.params;

      // 【归档只读拦截】
      const archiveCheck = await h.checkNotArchived(eventId);
      if (archiveCheck.blocked) {
        return res.status(403).json({ success: false, error: archiveCheck.error, code: 'ARCHIVED' });
      }

      // 【赛事状态校验】仅已结束的比赛可以修改名次
      const event = await h.validateEvent(eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });
      if (event.event_status !== 5) {
        return res.status(400).json({ success: false, error: `赛事当前状态为「${h.STATUS_NAMES[event.event_status]}」，需先结束比赛后才可修改名次`, code: 'NOT_ENDED' });
      }

      const [ranks] = await h.pool.query(
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
        await h.pool.query(
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
      if (!await h.assertAdmin(req, res)) return;
      const { eventId, rankId } = req.params;

      // 【归档只读拦截】
      const archiveCheck = await h.checkNotArchived(eventId);
      if (archiveCheck.blocked) {
        return res.status(403).json({ success: false, error: archiveCheck.error, code: 'ARCHIVED' });
      }

      // 【赛事状态校验】仅已结束的比赛可以删除名次
      const event = await h.validateEvent(eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });
      if (event.event_status !== 5) {
        return res.status(400).json({ success: false, error: `赛事当前状态为「${h.STATUS_NAMES[event.event_status]}」，需先结束比赛后才可删除名次`, code: 'NOT_ENDED' });
      }

      await h.pool.query('DELETE FROM dota2_event_ranks WHERE rank_id = ? AND event_id = ?', [rankId, eventId]);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

};
