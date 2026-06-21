/**
 * 队伍管理路由 — 队伍列表/批量保存/自动分队/锁定/回退/重命名/删除/积分榜
 */
const { allocateTeams } = require('../utils/team-allocation');

module.exports = function (app, h) {

  /** GET /api/events/:eventId/teams — 获取队伍列表（含队员详情+未入队选手） */
  app.get('/api/events/:eventId/teams', async (req, res) => {
    try {
      const { eventId } = req.params;
      const event = await h.validateEvent(eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });

      const isArchived = event.is_archived === 1;
      const teamsTable = h.tableFor('dota2_event_teams', isArchived);
      const signupTable = h.tableFor('dota2_event_signup', isArchived);

      const [rows] = await h.pool.query(
        `SELECT * FROM ${teamsTable} WHERE event_id = ? ORDER BY total_mmr DESC`, [eventId]
      );

      const teams = [];
      const allAssignedPlayerIds = new Set();
      const teamPlayerIds = []; // 按队伍索引存储 playerIds
      for (const team of rows) {
        let playerIds = [];
        try { playerIds = team.player_ids ? JSON.parse(team.player_ids) : []; } catch (_) { playerIds = []; }
        playerIds.forEach(pid => allAssignedPlayerIds.add(pid));
        teamPlayerIds.push(playerIds);
      }

      // 收集所有已分配选手ID，一次查询
      const allPlayerIds = [...allAssignedPlayerIds];
      const allPlayersMap = {};
      if (allPlayerIds.length) {
        const players = await h.getPlayersByIds(allPlayerIds);
        players.forEach(p => { allPlayersMap[p.id] = p; });
      }

      // 用 Map 映射到各队伍
      for (let i = 0; i < rows.length; i++) {
        const team = rows[i];
        const playerIds = teamPlayerIds[i];
        const members = playerIds.map(pid => {
          const p = allPlayersMap[pid];
          return p ? {
            id: p.id, nickName: p.wx_nickname || '', rankName: p.calibrate_rank_name || '', rankStar: p.calibrate_rank_star || 0,
            mmr: p.calibrate_mmr || 0, rankSort: p.calibrate_rank_sort || 0, avatarUrl: p.avatar_url || '',
            isCaptain: p.id === team.captain_id
          } : null;
        }).filter(Boolean);
        const captainPlayer = members.find(m => m.isCaptain);
        const avgMmr = members.length > 0 ? Math.round((team.total_mmr || 0) / members.length) : 0;

        teams.push({
          teamId: team.team_id, teamName: team.team_name, captainId: team.captain_id,
          captainName: captainPlayer ? captainPlayer.nickName : '', members, memberCount: members.length,
          totalMmr: team.total_mmr || 0, avgMmr, createdAt: team.created_at
        });
      }

      const [signupRows] = await h.pool.query(
        `SELECT player_id FROM ${signupTable} WHERE event_id = ? AND signup_status = 1`, [eventId]
      );
      const signedPlayerIds = signupRows.map(r => r.player_id);
      const freePlayerIds = signedPlayerIds.filter(pid => !allAssignedPlayerIds.has(pid));
      const freePlayers = freePlayerIds.length ? await h.getPlayersByIds(freePlayerIds) : [];
      const freeList = freePlayers.map(p => ({
        id: p.id, nickName: p.wx_nickname || '', rankName: p.calibrate_rank_name || '', rankStar: p.calibrate_rank_star || 0,
        mmr: p.calibrate_mmr || 0, rankSort: p.calibrate_rank_sort || 0, avatarUrl: p.avatar_url || '',
        gameId: p.game_id || ''
      }));

      res.json({ success: true, data: { teams, freePlayers: freeList } });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /** POST /api/events/:eventId/teams/batch — 批量保存队伍 */
  app.post('/api/events/:eventId/teams/batch', async (req, res) => {
    try {
      if (!await h.assertAdmin(req, res)) return;
      const { eventId } = req.params;

      const editCheck = await h.validateTeamEditable(eventId);
      if (editCheck.locked) return res.status(400).json({ success: false, error: editCheck.error });

      const { teams } = req.body;
      if (!teams || !Array.isArray(teams)) return res.status(400).json({ success: false, error: '参数 teams 必须是数组' });

      // 【安全】校验传入的 playerId 是否属于本赛事已报名选手
      const [signedIds] = await h.pool.query(
        'SELECT player_id FROM dota2_event_signup WHERE event_id = ? AND signup_status = 1', [eventId]
      );
      const validPlayerIds = new Set(signedIds.map(r => r.player_id));
      const allSubmittedIds = teams.flatMap(t => t.playerIds || []);
      const invalidIds = allSubmittedIds.filter(pid => !validPlayerIds.has(pid));
      if (invalidIds.length) {
        return res.status(400).json({ success: false, error: `选手 ${invalidIds.join(', ')} 未报名本赛事` });
      }

      const uniqCheck = h.validatePlayerUniqueness(teams);
      if (!uniqCheck.valid) return res.status(400).json({ success: false, error: uniqCheck.error });

      // 【校验】每队人数至少 MIN_TEAM_PLAYERS
      const invalidTeams = teams.filter(t => !t.teamName || !t.playerIds || t.playerIds.length < h.MIN_TEAM_PLAYERS);
      if (invalidTeams.length) {
        return res.status(400).json({
          success: false,
          error: `队伍「${invalidTeams.map(t => t.teamName || '未命名').join('、')}」人数不足 ${h.MIN_TEAM_PLAYERS} 人`
        });
      }

      const conn = await h.pool.getConnection();
      try {
        await conn.beginTransaction();

        await conn.query('DELETE FROM dota2_event_teams WHERE event_id = ?', [eventId]);

        for (const team of teams) {
          if (!team.teamName || !team.playerIds || !team.playerIds.length) continue;
          const teamId = h.genId();
          const captainId = team.captainId || team.playerIds[0];
          const playerIdsJson = JSON.stringify(team.playerIds);
          const players = await h.getPlayersByIds(team.playerIds);
          const totalMmr = players.reduce((sum, p) => sum + (p.calibrate_mmr || 0), 0);
          await conn.query(
            'INSERT INTO dota2_event_teams (team_id, event_id, team_name, captain_id, player_ids, total_mmr, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())',
            [teamId, eventId, team.teamName, captainId, playerIdsJson, totalMmr]
          );
        }

        await conn.commit();
        res.json({ success: true, data: { savedCount: teams.filter(t => t.teamName && t.playerIds && t.playerIds.length).length } });
      } catch (e) {
        await h.safeRollback(conn, 'batchTeams');
        throw e;
      } finally {
        conn.release();
      }
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /** POST /api/events/:eventId/allocate-teams — 自动分队 */
  app.post('/api/events/:eventId/allocate-teams', async (req, res) => {
    try {
      if (!await h.assertAdmin(req, res)) return;
      const { eventId } = req.params;

      const editCheck = await h.validateTeamEditable(eventId);
      if (editCheck.locked) return res.status(400).json({ success: false, error: editCheck.error });

      const { teamCount } = req.body;
      if (!teamCount || teamCount < 2) return res.status(400).json({ success: false, error: '队伍数量至少为2' });

      const [signupRows] = await h.pool.query(
        'SELECT s.player_id AS id, p.calibrate_mmr, p.wx_nickname, p.calibrate_rank_sort, p.calibrate_rank_star, p.good_at_positions, p.calibrate_rank_name FROM dota2_event_signup s LEFT JOIN dota2_players p ON s.player_id = p.id WHERE s.event_id = ? AND s.signup_status = 1 ORDER BY p.calibrate_rank_sort DESC, p.calibrate_mmr DESC',
        [eventId]
      );
      if (!signupRows.length) return res.status(400).json({ success: false, error: '暂无已报名选手' });

      const allocation = allocateTeams(signupRows, teamCount);
      if (allocation.error) {
        return res.status(400).json({ success: false, error: allocation.error });
      }

      const conn = await h.pool.getConnection();
      try {
        await conn.beginTransaction();
        await conn.query('DELETE FROM dota2_event_teams WHERE event_id = ?', [eventId]);

        for (const team of allocation.teams) {
          const teamId = h.genId();
          const playerIdsJson = JSON.stringify((team.playerList || []).map(p => p.id));
          const totalMmr = team.totalScore || 0;
          await conn.query(
            'INSERT INTO dota2_event_teams (team_id, event_id, team_name, captain_id, player_ids, total_mmr, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())',
            [teamId, eventId, team.teamName, team.captainId || ((team.playerList || [])[0]?.id || null), playerIdsJson, totalMmr]
          );
        }

        await conn.commit();
        res.json({
          success: true,
          data: { teamCount: allocation.teams.length, teams: allocation.teams, message: `已自动分为 ${allocation.teams.length} 支队伍` }
        });
      } catch (e) {
        await h.safeRollback(conn, 'allocateTeams');
        throw e;
      } finally {
        conn.release();
      }
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /** POST /api/events/:eventId/lock-teams — 锁定编组 */
  app.post('/api/events/:eventId/lock-teams', async (req, res) => {
    try {
      if (!await h.assertAdmin(req, res)) return;
      const { eventId } = req.params;

      const conn = await h.pool.getConnection();
      try {
        await conn.beginTransaction();
        const [events] = await conn.query(
          'SELECT * FROM dota2_events WHERE event_id = ? FOR UPDATE', [eventId]
        );
        if (!events.length) {
          await conn.rollback(); conn.release();
          return res.status(404).json({ success: false, error: '赛事不存在' });
        }
        const event = events[0];
        if (event.event_status !== 2) {
          await conn.rollback(); conn.release();
          return res.status(400).json({ success: false, error: '当前不在分组编队阶段' });
        }

        const [[{ cnt }]] = await conn.query(
          'SELECT COUNT(*) as cnt FROM dota2_event_teams WHERE event_id = ?', [eventId]
        );
        if (cnt < 2) {
          await conn.rollback(); conn.release();
          return res.status(400).json({ success: false, error: '至少需要2支队伍才能锁定编组' });
        }

        const transition = h.validateStatusTransition(2, 3);
        if (!transition.valid) {
          await conn.rollback(); conn.release();
          return res.status(400).json({ success: false, error: transition.error });
        }

        await conn.query('UPDATE dota2_events SET event_status = 3, updated_at = NOW() WHERE event_id = ?', [eventId]);
        await conn.commit();
        conn.release();
        res.json({ success: true, data: { eventStatus: 3, message: '编组已锁定，进入对战预备阶段' } });
      } catch (e) {
        await h.safeRollback(conn, 'lockTeams');
        conn.release();
        throw e;
      }
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /** POST /api/events/:eventId/back-to-teams — 退回到编组阶段 */
  app.post('/api/events/:eventId/back-to-teams', async (req, res) => {
    try {
      if (!await h.assertAdmin(req, res)) return;
      const { eventId } = req.params;

      const event = await h.validateEvent(eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });
      if (event.event_status !== 3) return res.status(400).json({ success: false, error: '仅对战预备阶段可退回到编组' });

      const [matchRows] = await h.pool.query('SELECT COUNT(*) as cnt FROM dota2_event_matches WHERE event_id = ?', [eventId]);
      if (matchRows[0].cnt > 0) {
        return res.status(400).json({ success: false, error: '已有对战记录，需先删除所有对战才可退回到编组阶段' });
      }

      await h.pool.query('UPDATE dota2_events SET event_status = 2, updated_at = NOW() WHERE event_id = ?', [eventId]);
      res.json({ success: true, data: { eventStatus: 2, message: '已退回到分组编队阶段' } });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /** PUT /api/events/:eventId/teams/:teamId/name — 重命名队伍 */
  app.put('/api/events/:eventId/teams/:teamId/name', async (req, res) => {
    try {
      if (!await h.assertAdmin(req, res)) return;
      const { eventId, teamId } = req.params;
      const editCheck = await h.validateTeamEditable(eventId);
      if (editCheck.locked) return res.status(400).json({ success: false, error: editCheck.error });

      const { teamName } = req.body;
      if (!teamName) return res.status(400).json({ success: false, error: '队伍名称不能为空' });

      const [rows] = await h.pool.query('SELECT * FROM dota2_event_teams WHERE team_id = ? AND event_id = ?', [teamId, eventId]);
      if (!rows.length) return res.status(404).json({ success: false, error: '队伍不存在' });

      await h.pool.query('UPDATE dota2_event_teams SET team_name = ? WHERE team_id = ?', [teamName, teamId]);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /** DELETE /api/events/:eventId/teams/:teamId — 删除队伍 */
  app.delete('/api/events/:eventId/teams/:teamId', async (req, res) => {
    try {
      if (!await h.assertAdmin(req, res)) return;
      const { eventId, teamId } = req.params;
      const editCheck = await h.validateTeamEditable(eventId);
      if (editCheck.locked) return res.status(400).json({ success: false, error: editCheck.error });

      const [rows] = await h.pool.query('SELECT * FROM dota2_event_teams WHERE team_id = ? AND event_id = ?', [teamId, eventId]);
      if (!rows.length) return res.status(404).json({ success: false, error: '队伍不存在' });

      await h.pool.query('DELETE FROM dota2_event_teams WHERE team_id = ?', [teamId]);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /** GET /api/events/:eventId/teams/scoreboard — 队伍积分榜 */
  app.get('/api/events/:eventId/teams/scoreboard', async (req, res) => {
    try {
      const { eventId } = req.params;
      const event = await h.validateEvent(eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });

      const isArchived = event.is_archived === 1;
      const teamsTable = h.tableFor('dota2_event_teams', isArchived);
      const matchesTable = h.tableFor('dota2_event_matches', isArchived);

      const [teams] = await h.pool.query(
        `SELECT team_id, team_name, captain_id, player_ids, total_mmr, avg_mmr FROM ${teamsTable} WHERE event_id = ?`, [eventId]
      );
      if (!teams || teams.length === 0) return res.json({ success: true, data: [] });

      const [winRows] = await h.pool.query(
        `SELECT winner_id, COUNT(*) as wins FROM ${matchesTable} WHERE event_id = ? AND match_status = 2 AND winner_id IS NOT NULL GROUP BY winner_id`, [eventId]
      );
      const winMap = {};
      (winRows || []).forEach(r => { winMap[r.winner_id] = r.wins; });

      const [playRows] = await h.pool.query(
        `SELECT team_id, COUNT(*) as total FROM (
           SELECT team_a_id as team_id FROM ${matchesTable} WHERE event_id = ? AND match_status = 2
           UNION ALL
           SELECT team_b_id as team_id FROM ${matchesTable} WHERE event_id = ? AND match_status = 2
         ) t GROUP BY team_id`, [eventId, eventId]
      );
      const playMap = {};
      (playRows || []).forEach(r => { playMap[r.team_id] = r.total; });

      const captainIds = [...new Set(teams.map(t => t.captain_id).filter(Boolean))];
      const captainMap = {};
      if (captainIds.length > 0) {
        const players = await h.getPlayersByIds(captainIds);
        players.forEach(p => { captainMap[p.id] = p.wx_nickname || ''; });
      }

      const scoreboard = teams.map(t => {
        const wins = winMap[t.team_id] || 0;
        const totalPlayed = playMap[t.team_id] || 0;
        return {
          teamId: t.team_id, teamName: t.team_name, captainName: captainMap[t.captain_id] || '',
          wins, losses: Math.max(0, totalPlayed - wins), score: wins,
          totalMmr: t.total_mmr || 0, avgMmr: t.avg_mmr || 0
        };
      });

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

};
