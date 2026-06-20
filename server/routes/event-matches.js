/**
 * 对战管理路由 — 对战列表/轮次/生成/开启/编辑/判定/图片上传/删除/下一轮/结束比赛/归档
 * 原 event-routes.js 第4部分（约第1953-2854行）
 */
module.exports = function (app, h) {

  /** GET /api/events/:eventId/matches — 对战列表 */
  app.get('/api/events/:eventId/matches', async (req, res) => {
    try {
      const { eventId } = req.params;
      const event = await h.validateEvent(eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });

      const isArchived = event.is_archived === 1;
      const matchesTable = h.tableFor('dota2_event_matches', isArchived);
      const teamsTable = h.tableFor('dota2_event_teams', isArchived);

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

      const [rows] = await h.pool.query(sql, params);

      const captainIds = new Set();
      rows.forEach(m => { if (m.team_a_captain) captainIds.add(m.team_a_captain); if (m.team_b_captain) captainIds.add(m.team_b_captain); });
      const captainMap = {};
      if (captainIds.size > 0) {
        const [captains] = await h.pool.query('SELECT id, wx_nickname FROM dota2_players WHERE id IN (?)', [[...captainIds]]);
        (captains || []).forEach(p => { captainMap[p.id] = p.wx_nickname || ''; });
      }

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

  /** GET /api/events/:eventId/matches/rounds — 轮次汇总 */
  app.get('/api/events/:eventId/matches/rounds', async (req, res) => {
    try {
      const { eventId } = req.params;
      const event = await h.validateEvent(eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });

      const isArchived = event.is_archived === 1;
      const matchesTable = h.tableFor('dota2_event_matches', isArchived);

      const [rows] = await h.pool.query(
        `SELECT round_num, COUNT(*) as match_count, SUM(CASE WHEN match_status = 2 THEN 1 ELSE 0 END) as completed_count
         FROM ${matchesTable} WHERE event_id = ? GROUP BY round_num ORDER BY round_num ASC`, [eventId]
      );

      const rounds = rows.map(r => ({
        roundNum: r.round_num, matchCount: r.match_count, completedCount: r.completed_count, allDone: r.match_count > 0 && r.completed_count === r.match_count,
      }));

      const currentRound = rounds.length > 0
        ? (rounds.find(r => !r.allDone) || rounds[rounds.length - 1]).roundNum : 0;

      res.json({ success: true, data: { rounds, currentRound, totalRounds: rounds.length } });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /** POST /api/events/:eventId/matches/generate — 生成对战编排 */
  app.post('/api/events/:eventId/matches/generate', async (req, res) => {
    try {
      if (!await h.assertAdmin(req, res)) return;
      const { eventId } = req.params;

      const battleCheck = await h.validateBattleEvent(eventId, [3, 4]);
      if (!battleCheck.valid) {
        return res.status(400).json({ success: false, error: battleCheck.error, code: 'INVALID_STATUS' });
      }

      const { mode, pairs } = req.body;
      if (!mode || !['auto', 'manual'].includes(mode)) {
        return res.status(400).json({ success: false, error: 'mode 必须为 auto 或 manual' });
      }

      const [allTeams] = await h.pool.query(
        'SELECT team_id, team_name, captain_id, player_ids, total_mmr FROM dota2_event_teams WHERE event_id = ?', [eventId]
      );
      if (!allTeams || allTeams.length < 2) {
        return res.status(400).json({ success: false, error: '赛事至少需要2支队伍才能生成对战' });
      }

      const teamMap = {};
      allTeams.forEach(t => { teamMap[t.team_id] = t; });

      let matchPairs = [];
      if (mode === 'auto') {
        const [winRows] = await h.pool.query(
          `SELECT winner_id as team_id, COUNT(*) as wins FROM dota2_event_matches
           WHERE event_id = ? AND match_status = 2 GROUP BY winner_id`, [eventId]
        );
        const winMap = {};
        winRows.forEach(r => { winMap[r.team_id] = r.wins; });

        const captainIds = allTeams.map(t => t.captain_id).filter(Boolean);
        const captainMap = {};
        if (captainIds.length > 0) {
          const [players] = await h.pool.query('SELECT id, wx_nickname FROM dota2_players WHERE id IN (?)', [captainIds]);
          players.forEach(p => { captainMap[p.id] = p.wx_nickname || ''; });
        }

        const teamsWithScore = allTeams.map(t => ({
          ...t, wins: winMap[t.team_id] || 0, captainName: captainMap[t.captain_id] || ''
        }));

        matchPairs = h.autoPairTeams(teamsWithScore);
        if (matchPairs.length === 0) {
          return res.status(400).json({ success: false, error: '自动配对失败，队伍数量不足' });
        }
      } else {
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
          if (!teamA) return res.status(400).json({ success: false, error: `队伍 ${p.teamAId} 不属于本赛事` });
          if (!teamB) return res.status(400).json({ success: false, error: `队伍 ${p.teamBId} 不属于本赛事` });
          matchPairs.push({ teamA, teamB });
        }
      }

      const [[{ maxRound }]] = await h.pool.query(
        'SELECT COALESCE(MAX(round_num), 0) as maxRound FROM dota2_event_matches WHERE event_id = ?', [eventId]
      );
      const nextRound = maxRound + 1;

      const createdMatches = [];
      const insertValues = [];
      const insertParams = [];

      for (const pair of matchPairs) {
        const matchId = h.genId();
        insertValues.push('(?, ?, ?, ?, ?, 0, NOW())');
        insertParams.push(matchId, eventId, nextRound, pair.teamA.team_id, pair.teamB.team_id);
        createdMatches.push({
          matchId, roundNum: nextRound,
          teamAId: pair.teamA.team_id, teamAName: pair.teamA.team_name, teamAMmr: pair.teamA.total_mmr,
          teamBId: pair.teamB.team_id, teamBName: pair.teamB.team_name, teamBMmr: pair.teamB.total_mmr,
          matchStatus: 0,
        });
      }

      if (insertValues.length > 0) {
        await h.pool.query(
          `INSERT INTO dota2_event_matches (match_id, event_id, round_num, team_a_id, team_b_id, match_status, created_at) VALUES ${insertValues.join(', ')}`,
          insertParams
        );
      }

      let advanced = false;
      if (nextRound === 1 && battleCheck.event.event_status === 3) {
        await h.pool.query(
          'UPDATE dota2_events SET event_status = 4, updated_at = NOW() WHERE event_id = ? AND event_status = 3', [eventId]
        );
        advanced = true;
      }

      res.json({
        success: true,
        data: {
          roundNum: nextRound, matchCount: createdMatches.length, matches: createdMatches, statusAdvanced: advanced,
          byes: mode === 'manual'
            ? allTeams.filter(t => !pairs.some(p => p.teamAId === t.team_id || p.teamBId === t.team_id)).map(t => ({ teamId: t.team_id, teamName: t.team_name }))
            : [],
        },
        message: `第${nextRound}轮已生成，共 ${createdMatches.length} 场对战${advanced ? '，赛事已进入对战中' : ''}`
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /** PUT /api/events/:eventId/matches/round/:roundNum/start — 开启本轮对战 */
  app.put('/api/events/:eventId/matches/round/:roundNum/start', async (req, res) => {
    try {
      if (!await h.assertAdmin(req, res)) return;
      const { eventId, roundNum } = req.params;
      const rn = parseInt(roundNum);

      const battleCheck = await h.validateBattleEvent(eventId, [3, 4]);
      if (!battleCheck.valid) {
        return res.status(400).json({ success: false, error: battleCheck.error, code: 'INVALID_STATUS' });
      }

      const [[{ pendingCount }]] = await h.pool.query(
        'SELECT COUNT(*) as pendingCount FROM dota2_event_matches WHERE event_id = ? AND round_num = ? AND match_status = 0', [eventId, rn]
      );
      if (pendingCount === 0) {
        return res.status(400).json({ success: false, error: '本轮没有待开始的对战' });
      }

      if (battleCheck.event.event_status === 3) {
        await h.pool.query(
          'UPDATE dota2_events SET event_status = 4, updated_at = NOW() WHERE event_id = ? AND event_status = 3', [eventId]
        );
      }

      await h.pool.query(
        'UPDATE dota2_event_matches SET match_status = 1 WHERE event_id = ? AND round_num = ? AND match_status = 0', [eventId, rn]
      );

      res.json({ success: true, data: { roundNum: rn, startedCount: pendingCount, message: `第${rn}轮对战已开始，共 ${pendingCount} 场` } });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /** PUT /api/events/:eventId/matches/:matchId — 编辑未开始对战 */
  app.put('/api/events/:eventId/matches/:matchId', async (req, res) => {
    try {
      if (!await h.assertAdmin(req, res)) return;
      const { eventId, matchId } = req.params;

      const battleCheck = await h.validateBattleEvent(eventId, [3, 4]);
      if (!battleCheck.valid) {
        return res.status(400).json({ success: false, error: battleCheck.error, code: 'INVALID_STATUS' });
      }

      const [matches] = await h.pool.query('SELECT * FROM dota2_event_matches WHERE match_id = ? AND event_id = ?', [matchId, eventId]);
      if (!matches.length) return res.status(404).json({ success: false, error: '对战记录不存在' });
      if (matches[0].match_status !== 0) {
        return res.status(400).json({ success: false, error: '对战已开始或已结束，不可修改队伍' });
      }

      const { teamAId, teamBId } = req.body;
      const sets = []; const values = [];
      if (teamAId) { sets.push('team_a_id = ?'); values.push(teamAId); }
      if (teamBId) { sets.push('team_b_id = ?'); values.push(teamBId); }
      if (sets.length === 0) return res.status(400).json({ success: false, error: '未指定要修改的队伍' });
      if (teamAId && teamBId && teamAId === teamBId) {
        return res.status(400).json({ success: false, error: '双方不能为同一支队伍' });
      }

      values.push(matchId);
      await h.pool.query('UPDATE dota2_event_matches SET ' + sets.join(', ') + ' WHERE match_id = ?', values);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /** PUT /api/events/:eventId/matches/:matchId/judge — 判定胜负 */
  app.put('/api/events/:eventId/matches/:matchId/judge', async (req, res) => {
    try {
      if (!await h.assertAdmin(req, res)) return;
      const { eventId, matchId } = req.params;

      const battleCheck = await h.validateBattleEvent(eventId);
      if (!battleCheck.valid) {
        return res.status(400).json({ success: false, error: battleCheck.error, code: 'INVALID_STATUS' });
      }

      const [matches] = await h.pool.query('SELECT * FROM dota2_event_matches WHERE match_id = ? AND event_id = ?', [matchId, eventId]);
      if (!matches.length) return res.status(404).json({ success: false, error: '对战记录不存在' });

      const match = matches[0];
      if (match.match_status === 2) {
        return res.status(400).json({ success: false, error: '该对战已判定胜负，不可修改', code: 'ALREADY_JUDGED', data: { winnerId: match.winner_id, judgeTime: match.judge_time } });
      }

      const { winnerId, confirmed } = req.body;
      if (!confirmed) return res.status(400).json({ success: false, error: '请二次确认后再提交', code: 'NEED_CONFIRM' });
      if (!winnerId) return res.status(400).json({ success: false, error: '胜方队伍ID不能为空' });
      if (winnerId !== match.team_a_id && winnerId !== match.team_b_id) {
        return res.status(400).json({ success: false, error: '胜方队伍不是本场对战的参赛队伍' });
      }

      const judgeTime = new Date().toISOString();
      const judgeId = req._openid || '';
      await h.pool.query(
        'UPDATE dota2_event_matches SET winner_id = ?, match_status = 2, judge_id = ?, judge_time = NOW() WHERE match_id = ? AND event_id = ?',
        [winnerId, judgeId, matchId, eventId]
      );

      res.json({ success: true, data: { matchId, winnerId, judgeTime, message: '胜负已判定，结果不可修改' } });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /** POST /api/events/:eventId/matches/:matchId/image — 上传对战结果图片 */
  app.post('/api/events/:eventId/matches/:matchId/image', h.upload.single('file'), async (req, res) => {
    try {
      const { eventId, matchId } = req.params;
      const openid = req._openid || '';
      if (!req.file) return res.status(400).json({ success: false, error: '请选择图片' });

      const event = await h.validateEvent(eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });
      if (event.is_archived === 1) return res.status(403).json({ success: false, error: '赛事已归档，不可上传图片' });

      const [matches] = await h.pool.query('SELECT * FROM dota2_event_matches WHERE match_id = ? AND event_id = ?', [matchId, eventId]);
      if (!matches.length) return res.status(404).json({ success: false, error: '对战记录不存在' });
      if (matches[0].match_status !== 2) {
        return res.status(400).json({ success: false, error: '仅已结束的对战可上传结果图片' });
      }

      const role = await h.getCallerRole(openid);
      const isAdminRole = role === 'admin' || role === 'super_admin';
      if (!isAdminRole) {
        const playerId = await h.getPlayerIdByOpenid(openid);
        if (!playerId) return res.status(403).json({ success: false, error: '未找到您的选手档案，无法上传' });
        const match = matches[0];
        const [teams] = await h.pool.query('SELECT team_id, captain_id FROM dota2_event_teams WHERE event_id = ? AND captain_id = ?', [eventId, playerId]);
        const isCaptainOfTeamA = teams.some(t => String(t.team_id) === String(match.team_a_id));
        const isCaptainOfTeamB = teams.some(t => String(t.team_id) === String(match.team_b_id));
        if (!isCaptainOfTeamA && !isCaptainOfTeamB) {
          return res.status(403).json({ success: false, error: '仅参赛队伍的队长或管理员可上传对战图片' });
        }
      }

      const imageUrl = '/uploads/' + req.file.filename;
      await h.pool.query('UPDATE dota2_event_matches SET battle_image = ? WHERE match_id = ?', [imageUrl, matchId]);
      res.json({ success: true, data: { url: imageUrl, message: '上传成功' } });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /** DELETE /api/events/:eventId/matches/:matchId — 删除对战 */
  app.delete('/api/events/:eventId/matches/:matchId', async (req, res) => {
    try {
      if (!await h.assertAdmin(req, res)) return;
      const { eventId, matchId } = req.params;

      const battleCheck = await h.validateBattleEvent(eventId, [3, 4]);
      if (!battleCheck.valid) return res.status(400).json({ success: false, error: battleCheck.error, code: 'INVALID_STATUS' });

      const [matches] = await h.pool.query('SELECT * FROM dota2_event_matches WHERE match_id = ? AND event_id = ?', [matchId, eventId]);
      if (!matches.length) return res.status(404).json({ success: false, error: '对战记录不存在' });
      if (matches[0].match_status === 2) {
        return res.status(400).json({ success: false, error: '已判定胜负的对战不可删除' });
      }

      await h.pool.query('DELETE FROM dota2_event_matches WHERE match_id = ? AND event_id = ?', [matchId, eventId]);
      res.json({ success: true, data: { matchId, message: '对战记录已删除' } });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /** POST /api/events/:eventId/next-round — 进入下一轮 */
  app.post('/api/events/:eventId/next-round', async (req, res) => {
    try {
      if (!await h.assertAdmin(req, res)) return;
      const { eventId } = req.params;

      const battleCheck = await h.validateBattleEvent(eventId);
      if (!battleCheck.valid) {
        return res.status(400).json({ success: false, error: battleCheck.error, code: 'INVALID_STATUS' });
      }

      const [[{ maxRound }]] = await h.pool.query(
        'SELECT COALESCE(MAX(round_num), 0) as maxRound FROM dota2_event_matches WHERE event_id = ?', [eventId]
      );
      if (maxRound === 0) return res.status(400).json({ success: false, error: '当前赛事还没有对战记录，请先生成第1轮对战' });

      const [[{ unfinished }]] = await h.pool.query(
        'SELECT COUNT(*) as unfinished FROM dota2_event_matches WHERE event_id = ? AND round_num = ? AND match_status != 2', [eventId, maxRound]
      );
      if (unfinished > 0) {
        return res.status(400).json({ success: false, error: `第${maxRound}轮还有 ${unfinished} 场对战未判定，请先完成所有胜负判定`, code: 'ROUND_NOT_DONE' });
      }

      const [allTeams] = await h.pool.query(
        'SELECT team_id, team_name, captain_id, player_ids, total_mmr FROM dota2_event_teams WHERE event_id = ? ORDER BY total_mmr DESC', [eventId]
      );

      res.json({
        success: true,
        data: { currentRound: maxRound, nextRound: maxRound + 1, teams: allTeams, teamCount: allTeams.length, message: `第${maxRound}轮已完成，准备进入第${maxRound + 1}轮` }
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /** POST /api/events/:eventId/end-battle — 结束比赛 */
  app.post('/api/events/:eventId/end-battle', async (req, res) => {
    try {
      if (!await h.assertAdmin(req, res)) return;
      const { eventId } = req.params;

      const battleCheck = await h.validateBattleEvent(eventId);
      if (!battleCheck.valid) {
        return res.status(400).json({ success: false, error: battleCheck.error, code: 'INVALID_STATUS' });
      }

      const [[{ unfinished }]] = await h.pool.query(
        'SELECT COUNT(*) as unfinished FROM dota2_event_matches WHERE event_id = ? AND match_status != 2', [eventId]
      );
      if (unfinished > 0) {
        return res.status(400).json({ success: false, error: `还有 ${unfinished} 场对战未判定胜负，请先完成所有判定`, code: 'BATTLE_NOT_DONE' });
      }

      const [[{ totalMatches }]] = await h.pool.query(
        'SELECT COUNT(*) as totalMatches FROM dota2_event_matches WHERE event_id = ?', [eventId]
      );
      if (totalMatches === 0) return res.status(400).json({ success: false, error: '当前赛事无对战记录，无法归档' });

      const openid = req._openid || '';
      await h.pool.query(
        'UPDATE dota2_events SET event_status = 5, ended_by = ?, ended_at = NOW(), updated_at = NOW() WHERE event_id = ?', [openid, eventId]
      );

      const [roundStats] = await h.pool.query(
        `SELECT round_num, COUNT(*) as matches, SUM(CASE WHEN match_status = 2 THEN 1 ELSE 0 END) as done
         FROM dota2_event_matches WHERE event_id = ? GROUP BY round_num ORDER BY round_num ASC`, [eventId]
      );

      res.json({
        success: true,
        data: { totalRounds: roundStats.length, totalMatches, eventStatus: 5, message: '比赛已结束。请设定队伍名次，完成后点击「归档比赛」正式归档。' }
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /** POST /api/events/:eventId/archive — 赛事归档 */
  app.post('/api/events/:eventId/archive', async (req, res) => {
    try {
      if (!await h.assertAdmin(req, res)) return;
      const { eventId } = req.params;

      const event = await h.validateEvent(eventId);
      if (!event) return res.status(404).json({ success: false, error: '赛事不存在' });
      if (event.event_status !== 5) {
        return res.status(400).json({ success: false, error: `赛事当前状态为「${h.STATUS_NAMES[event.event_status]}」，需要先结束比赛完成后才可归档`, code: 'NOT_ENDED' });
      }
      if (event.is_archived === 1) {
        return res.status(400).json({ success: false, error: '赛事已归档，无需重复操作', code: 'ALREADY_ARCHIVED' });
      }

      const openid = req._openid || '';

      const [[{ signupCount }]] = await h.pool.query('SELECT COUNT(*) as signupCount FROM dota2_event_signup WHERE event_id = ? AND signup_status = 1', [eventId]);
      const [[{ teamCount }]] = await h.pool.query('SELECT COUNT(*) as teamCount FROM dota2_event_teams WHERE event_id = ?', [eventId]);
      const [[{ matchCount }]] = await h.pool.query('SELECT COUNT(*) as matchCount FROM dota2_event_matches WHERE event_id = ?', [eventId]);
      const [[{ rankCount }]] = await h.pool.query('SELECT COUNT(*) as rankCount FROM dota2_event_ranks WHERE event_id = ?', [eventId]);

      const conn = await h.pool.getConnection();
      try {
        await conn.beginTransaction();

        await conn.query(h.migrateSql('dota2_events'), [eventId]);
        for (const table of h.ARCHIVE_TABLES) {
          await conn.query(h.migrateSql(table), [eventId]);
        }

        for (const table of h.ARCHIVE_TABLES) {
          await conn.query(h.cleanSql(table), [eventId]);
        }

        await conn.query(
          'UPDATE dota2_events SET is_archived = 1, event_status = 6, archived_by = ?, archived_at = NOW(), updated_at = NOW() WHERE event_id = ?',
          [openid, eventId]
        );
        await conn.query(
          'UPDATE dota2_events_his SET is_archived = 1, archived_by = ?, archived_at = NOW() WHERE event_id = ?',
          [openid, eventId]
        );

        await conn.commit();
      } catch (err) {
        await h.safeRollback(conn, 'archiveEvent');
        throw err;
      } finally {
        conn.release();
      }

      const nickMap = await h.getUserNicknames([openid]);

      res.json({
        success: true,
        data: {
          eventId, archivedAt: new Date().toISOString(), archivedBy: nickMap.get(openid) || '',
          summary: { signups: signupCount, teams: teamCount, matches: matchCount, ranks: rankCount },
          message: '赛事已归档，所有数据固化为只读状态，不可再修改。'
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

};
