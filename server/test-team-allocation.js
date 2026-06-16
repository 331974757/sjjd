/**
 * ============================================================
 * MMR 均衡分队算法 - 模拟测试用例 & 后端调用示例
 * ============================================================
 *
 * 运行方式：
 *   cd server && node test-team-allocation.js
 *
 * 如果需要在服务器运行：
 *   scp server/utils/team-allocation.js server/test-team-allocation.js root@121.41.191.80:/opt/dota2-api/
 *   ssh root@121.41.191.80 "cd /opt/dota2-api && node test-team-allocation.js"
 * ============================================================
 */

const { allocateTeams, ALL_POSITIONS } = require('./utils/team-allocation');

// ============================================================
// 测试数据生成工具
// ============================================================

/** 随机生成选手 */
function makePlayer(id, mmr, positions) {
  return {
    id: id || `player_${Math.random().toString(36).slice(2, 8)}`,
    calibrate_mmr: mmr || Math.round(2000 + Math.random() * 6000),
    good_at_positions: positions || [1, 2, 3, 4, 5].filter(() => Math.random() > 0.5).join(','),
    wx_nickname: `选手${id}`,
  };
}

/** 按一套完整的阵容生成20人 */
function generateBalancedRoster(prefix, count) {
  const players = [];
  // MMR区间：3000-9000，正态分布倾向
  const mmrPool = [8900, 8600, 8200, 7900, 7500, 7200, 6800, 6500, 6100, 5800,
                   5400, 5100, 4800, 4500, 4200, 3900, 3600, 3400, 3200, 3100,
                   5000, 5500, 6000, 6500, 7000, 4100, 4600, 5300, 5700, 6300];

  // 位置分布模板：[1号位, 2号位, 3号位, 4号位, 5号位] × 每队各一套
  const positionTemplates = [
    '1',        '1,3',      '2',        '2,4',      '3',
    '3,1',      '4,5',      '4',        '5',        '5,3',
    '1,4',      '2,3',      '3,5',      '4,1',      '5,2',
    '1,5',      '2,1',      '3,4',      '4,2',      '5,1',
  ];

  for (let i = 0; i < count; i++) {
    const mmr = mmrPool[i % mmrPool.length] - Math.round(Math.random() * 200);
    const pos = positionTemplates[i % positionTemplates.length];
    players.push({
      id: `${prefix}_${String(i + 1).padStart(2, '0')}`,
      calibrate_mmr: mmr,
      good_at_positions: pos,
      wx_nickname: `${prefix}_选手${i + 1}`,
    });
  }
  return players;
}


// ============================================================
// 测试1：20名选手，4支队伍，位置齐全
// ============================================================

function test1_balancedAllocation() {
  console.log('\n' + '='.repeat(60));
  console.log(' 测试1：20名选手 → 4支队伍（位置齐全），验证均衡分配效果');
  console.log('='.repeat(60));

  const players = generateBalancedRoster('T1', 20);

  console.log('\n【选手术语】');
  players.forEach((p, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${p.wx_nickname.padEnd(12)} MMR:${String(p.calibrate_mmr).padStart(4)}  擅长位置: ${p.good_at_positions}`);
  });

  const result = allocateTeams(players, 4);

  printResult(result);
}


// ============================================================
// 测试2：15名选手，3支队伍，部分位置人员不足 + 强制规则
// ============================================================

function test2_partialPositionsAndRules() {
  console.log('\n' + '='.repeat(60));
  console.log(' 测试2：15名选手 → 3支队伍（部分位置不足 + 强制规则）');
  console.log('='.repeat(60));

  // 手动构造：故意让某些位置缺人，测试补全微调效果
  const players = [
    // 偏1号位（Carry）
    { id: 'P01', calibrate_mmr: 8200, good_at_positions: '1',    wx_nickname: 'Carry大师' },
    { id: 'P02', calibrate_mmr: 7800, good_at_positions: '1,3',  wx_nickname: 'C位出道' },
    { id: 'P03', calibrate_mmr: 6500, good_at_positions: '1,5',  wx_nickname: '补刀狂魔' },
    // 偏2号位（Mid）- 只有2人，3队不够分
    { id: 'P04', calibrate_mmr: 8500, good_at_positions: '2',    wx_nickname: '中路杀神' },
    { id: 'P05', calibrate_mmr: 7200, good_at_positions: '2,4',  wx_nickname: '对线王者' },
    // 偏3号位（Offlane）
    { id: 'P06', calibrate_mmr: 7600, good_at_positions: '3',    wx_nickname: '劣单霸主' },
    { id: 'P07', calibrate_mmr: 6900, good_at_positions: '3,1',  wx_nickname: '抗压战士' },
    { id: 'P08', calibrate_mmr: 5800, good_at_positions: '3,4',  wx_nickname: '铁血三号位' },
    // 偏4号位（Support）
    { id: 'P09', calibrate_mmr: 7100, good_at_positions: '4',    wx_nickname: '游走之王' },
    { id: 'P10', calibrate_mmr: 6400, good_at_positions: '4,5',  wx_nickname: '全图亮' },
    { id: 'P11', calibrate_mmr: 5200, good_at_positions: '4,2',  wx_nickname: '四号位之光' },
    // 偏5号位（Hard Support）- 只有2人
    { id: 'P12', calibrate_mmr: 6000, good_at_positions: '5',    wx_nickname: '辅助之神' },
    { id: 'P13', calibrate_mmr: 4800, good_at_positions: '5,4',  wx_nickname: '默默奉献' },
    // 多面手
    { id: 'P14', calibrate_mmr: 9000, good_at_positions: '1,2,3', wx_nickname: '全能大腿' },
    { id: 'P15', calibrate_mmr: 5500, good_at_positions: '3,4,5', wx_nickname: '万金油' },
  ];

  console.log('\n【选手列表】');
  console.log('  注意：2号位仅2人、5号位仅2人，3支队伍无法平均分配');
  players.forEach((p, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${p.wx_nickname.padEnd(12)} MMR:${String(p.calibrate_mmr).padStart(4)}  位置: ${p.good_at_positions}`);
  });

  // 强制规则：中路杀神和C位出道不能同队（恩怨局）
  //          Carry大师和对线王者必须同队（好基友）
  const forceRules = {
    mustSameTeam: [['P01', 'P05']],           // Carry大师 + 对线王者 绑定
    mustNotSameTeam: [['P04', 'P02']],         // 中路杀神 vs C位出道 拆开
  };

  console.log('\n【强制规则】');
  console.log('  ✓ 必须同队：Carry大师 ↔ 对线王者');
  console.log('  ✗ 禁止同队：中路杀神 ↔ C位出道（恩怨局）');

  const result = allocateTeams(players, 3, forceRules);

  printResult(result);

  // 验证强制规则
  verifyForceRules(result, forceRules);
  // 验证位置缺失提示是否合理
  console.log('\n【位置不足分析】');
  console.log('  理论上3队各需要1个2号位，但只有2个专精2号位的选手');
  console.log('  理论上3队各需要1个5号位，但只有2个专精5号位的选手');
  console.log('  算法的警告信息会明确提示哪些队伍仍缺位，方便手动调整');
}


// ============================================================
// 输出格式化
// ============================================================

function printResult(result) {
  console.log('\n【分队结果】');

  if (result.teams.length === 0) {
    console.log('  ✗ 分配失败');
    return;
  }

  result.teams.forEach(team => {
    const status = team.positionStats.isComplete ? '✓' : '⚠';
    console.log(`\n  ┌─ ${team.teamName} ${status} ─────────────────────────────`);
    console.log(`  │ 人数: ${team.memberCount}  │  总MMR: ${team.totalMmr}  │  均分: ${Math.round(team.mmrPerPlayer)}`);
    console.log(`  │ 队长: ${team.playerList.find(p => p.id === team.captainId)?.wx_nickname || 'N/A'}`);
    console.log(`  │ 位置覆盖:`);
    ALL_POSITIONS.forEach(pos => {
      const names = team.positionStats.coverage[pos] || [];
      console.log(`  │   ${pos}号位: ${names.length > 0 ? names.join(', ') : '(缺失)'}`);
    });
    console.log(`  │ 成员详情:`);
    team.playerList.forEach(p => {
      console.log(`  │   · ${p.wx_nickname.padEnd(12)} MMR:${String(p.calibrate_mmr).padStart(4)}  位置:${p.good_at_positions}`);
    });
    console.log(`  └──────────────────────────────────────────────`);
  });

  console.log('\n【均衡度统计】');
  if (result.balanceInfo) {
    const b = result.balanceInfo;
    console.log(`  总分区间: ${b.mmrStats.min} ~ ${b.mmrStats.max}`);
    console.log(`  平均总MMR: ${b.mmrStats.average}`);
    console.log(`  最大分差: ${b.mmrStats.maxDiff}`);
    console.log(`  标准差: ${b.mmrStats.stdDeviation}`);
    console.log(`  评级: ${b.mmrStats.grade}`);
    console.log(`  位置满足率: ${b.positionRate.completeTeams}/${b.positionRate.totalTeams} (${(b.positionRate.rate * 100).toFixed(0)}%) ${b.positionRate.grade}`);
    console.log(`  人数分布: ${b.memberDistribution.min}~${b.memberDistribution.max} 平均${b.memberDistribution.avg}`);
  }

  if (result.warnings && result.warnings.length > 0) {
    console.log('\n【警告信息】');
    result.warnings.forEach(w => console.log(`  ⚠ ${w}`));
  }
}

/** 验证强制规则是否正确执行 */
function verifyForceRules(result, rules) {
  console.log('\n【强制规则验证】');

  // 找选手所在队伍
  function findTeam(playerId) {
    for (const team of result.teams) {
      if (team.playerList.some(p => p.id === playerId)) return team.teamIndex;
    }
    return -1;
  }

  // 验证 mustSameTeam
  if (rules.mustSameTeam) {
    for (const group of rules.mustSameTeam) {
      const teamIdx = findTeam(group[0]);
      const allSame = group.every(id => findTeam(id) === teamIdx);
      console.log(`  ${allSame ? '✓' : '✗'} 同队 [${group.join(', ')}] → 队伍${teamIdx}`);
    }
  }

  // 验证 mustNotSameTeam
  if (rules.mustNotSameTeam) {
    for (const pair of rules.mustNotSameTeam) {
      const tA = findTeam(pair[0]), tB = findTeam(pair[1]);
      console.log(`  ${tA !== tB ? '✓' : '✗'} 禁同队 [${pair[0]}, ${pair[1]}] → 队${tA} vs 队${tB}`);
    }
  }
}


// ============================================================
// 测试3（附赠）：后端接口调用示例
// ============================================================

function test3_apiIntegrationExample() {
  console.log('\n' + '='.repeat(60));
  console.log(' 测试3（示例）：后端接口中如何调用算法并写入数据库');
  console.log('='.repeat(60));

  console.log(`
  【后端集成代码示例】

  在 server/index.js 或 server/event-routes.js 中添加以下路由：

  // POST /api/events/:eventId/allocate-teams
  // 请求体：{ teamCount: 4, forceRules: { mustSameTeam: [["P01","P05"]], mustNotSameTeam: [["P04","P02"]] } }
  app.post('/api/events/:eventId/allocate-teams', async (req, res) => {
    try {
      const { eventId } = req.params;
      const { teamCount, forceRules } = req.body;

      // 1. 权限校验
      const role = await getCallerRole(req.query.openid);
      if (role !== 'admin' && role !== 'super_admin') {
        return res.json({ success: false, error: '仅管理员可操作' });
      }

      // 2. 从报名表获取已报名选手ID列表
      const [signups] = await pool.query(
        'SELECT player_id FROM dota2_event_signup WHERE event_id = ? AND signup_status = 1',
        [eventId]
      );
      if (!signups.length) {
        return res.json({ success: false, error: '暂无有效报名选手' });
      }

      // 3. 批量查询选手详情（含MMR和擅长位置）
      const playerIds = signups.map(s => s.player_id);
      const [players] = await pool.query(
        'SELECT id, wx_nickname, calibrate_mmr, good_at_positions FROM dota2_players WHERE id IN (?)',
        [playerIds]
      );

      if (players.length < teamCount * 5) {
        return res.json({ success: false, error: \`选手不足：\${players.length}人，至少需要\${teamCount * 5}人\` });
      }

      // 4. 调用分队算法
      const { allocateTeams } = require('./utils/team-allocation');
      const result = allocateTeams(players, teamCount, forceRules);

      // 5. 批量写入 dota2_event_teams 表
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();

        // 先清空该赛事已有队伍（重新分队场景）
        await connection.execute('DELETE FROM dota2_event_teams WHERE event_id = ?', [eventId]);

        for (const team of result.teams) {
          const teamId = Date.now().toString(16) + Math.random().toString(16).slice(2, 10);
          const playerIdsJson = JSON.stringify(team.playerList.map(p => p.id));
          const now = Date.now();

          await connection.execute(
            'INSERT INTO dota2_event_teams (team_id, event_id, team_name, captain_id, player_ids, total_mmr, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [teamId, eventId, team.teamName, team.captainId, playerIdsJson, team.totalMmr, now, now]
          );
        }

        await connection.commit();

        res.json({
          success: true,
          data: {
            teams: result.teams,
            balanceInfo: result.balanceInfo,
            warnings: result.warnings,
          }
        });
      } catch (err) {
        await connection.rollback();
        throw err;
      } finally {
        connection.release();
      }
    } catch (err) {
      console.error('分队失败:', err);
      res.json({ success: false, error: err.message });
    }
  });

  【前端调用（微信小程序）】

  const { get } = require('../../utils/api');

  // 在赛事管理页调用分队接口
  async function allocateTeams(eventId, teamCount, forceRules) {
    const openid = wx.getStorageSync('openid');
    const result = await get(\`/api/events/\${eventId}/allocate-teams\`, {
      method: 'POST',
      data: { teamCount, forceRules },
      openid
    });
    if (result.success) {
      console.log('分队完成!', result.data);
      // 展示分队结果 + 均衡度统计
    }
  }

  allocateTeams('your_event_id', 4, {
    mustSameTeam: [['P01', 'P05']],      // 必须同队
    mustNotSameTeam: [['P04', 'P02']]     // 禁止同队
  });
`);
}


// ============================================================
// 运行所有测试
// ============================================================

console.log('\n' + '█'.repeat(60));
console.log('█  MMR 均衡分队算法 — 自动化测试套件');
console.log('█'.repeat(60));

test1_balancedAllocation();
test2_partialPositionsAndRules();
test3_apiIntegrationExample();

console.log('\n' + '█'.repeat(60));
console.log('█  全部测试完成');
console.log('█'.repeat(60) + '\n');
