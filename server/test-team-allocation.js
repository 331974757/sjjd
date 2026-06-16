/**
 * ============================================================
 * 段位分值均衡分队算法 — 模拟测试 & 后端集成示例
 * ============================================================
 *
 * 运行方式：
 *   cd server && node test-team-allocation.js
 *
 * 在服务器运行：
 *   scp server/utils/rank-score.js server/utils/team-allocation.js server/test-team-allocation.js root@121.41.191.80:/opt/dota2-api/
 *   ssh root@121.41.191.80 "cd /opt/dota2-api && node test-team-allocation.js"
 * ============================================================
 */

const { allocateTeams, ALL_POSITIONS } = require('./utils/team-allocation');
const { getScore, getRankConfigTable } = require('./utils/rank-score');


// ============================================================
// 测试1：20名选手，4支队伍 — 纯 actual MMR，覆盖全段位
// ============================================================

function test1_allActualMmr() {
  console.log('\n' + '='.repeat(65));
  console.log('  测试1：20名选手 → 4支队伍');
  console.log('  特征：全部提供实际 calibrate_mmr，覆盖先锋→冠绝一世');
  console.log('  验证：纯 MMR 蛇形均衡分配效果');
  console.log('='.repeat(65));

  // 20 名选手，覆盖 8 个段位，位置互补分布
  const players = [
    // --- 冠绝一世 (8000+) ---
    { id: 'P01', calibrate_mmr: 8500,  calibrate_rank_sort: 8, calibrate_rank_star: 0, calibrate_rank_name: '冠绝一世',
      good_at_positions: '1,3',    wx_nickname: '神域之光' },
    { id: 'P02', calibrate_mmr: 8200,  calibrate_rank_sort: 8, calibrate_rank_star: 0, calibrate_rank_name: '冠绝一世',
      good_at_positions: '2',      wx_nickname: '中路皇帝' },

    // --- 超凡入圣 (5100-5999) ---
    { id: 'P03', calibrate_mmr: 5800,  calibrate_rank_sort: 7, calibrate_rank_star: 4, calibrate_rank_name: '超凡入圣',
      good_at_positions: '3',      wx_nickname: '劣单铁壁' },
    { id: 'P04', calibrate_mmr: 5600,  calibrate_rank_sort: 7, calibrate_rank_star: 3, calibrate_rank_name: '超凡入圣',
      good_at_positions: '1,5',    wx_nickname: '战术核心' },
    { id: 'P05', calibrate_mmr: 5300,  calibrate_rank_sort: 7, calibrate_rank_star: 2, calibrate_rank_name: '超凡入圣',
      good_at_positions: '4,5',    wx_nickname: '辅助天才' },

    // --- 万古流芳 (4250-5099) ---
    { id: 'P06', calibrate_mmr: 4900,  calibrate_rank_sort: 6, calibrate_rank_star: 4, calibrate_rank_name: '万古流芳',
      good_at_positions: '2,4',    wx_nickname: '节奏大师' },
    { id: 'P07', calibrate_mmr: 4600,  calibrate_rank_sort: 6, calibrate_rank_star: 3, calibrate_rank_name: '万古流芳',
      good_at_positions: '3,1',    wx_nickname: '多面手' },

    // --- 传奇 (3350-4249) ---
    { id: 'P08', calibrate_mmr: 4100,  calibrate_rank_sort: 5, calibrate_rank_star: 5, calibrate_rank_name: '传奇',
      good_at_positions: '4',      wx_nickname: '游走之王' },
    { id: 'P09', calibrate_mmr: 3800,  calibrate_rank_sort: 5, calibrate_rank_star: 3, calibrate_rank_name: '传奇',
      good_at_positions: '5,3',    wx_nickname: '奉献之光' },
    { id: 'P10', calibrate_mmr: 3500,  calibrate_rank_sort: 5, calibrate_rank_star: 2, calibrate_rank_name: '传奇',
      good_at_positions: '1,2',    wx_nickname: '全能摇摆' },

    // --- 统帅 (2650-3349) ---
    { id: 'P11', calibrate_mmr: 3200,  calibrate_rank_sort: 4, calibrate_rank_star: 5, calibrate_rank_name: '统帅',
      good_at_positions: '2',      wx_nickname: '中单新星' },
    { id: 'P12', calibrate_mmr: 2900,  calibrate_rank_sort: 4, calibrate_rank_star: 3, calibrate_rank_name: '统帅',
      good_at_positions: '3,4',    wx_nickname: '攻守兼备' },

    // --- 中军 (1750-2649) ---
    { id: 'P13', calibrate_mmr: 2500,  calibrate_rank_sort: 3, calibrate_rank_star: 5, calibrate_rank_name: '中军',
      good_at_positions: '4,5',    wx_nickname: '眼位精通' },
    { id: 'P14', calibrate_mmr: 2100,  calibrate_rank_sort: 3, calibrate_rank_star: 3, calibrate_rank_name: '中军',
      good_at_positions: '1',      wx_nickname: '打钱机器' },
    { id: 'P15', calibrate_mmr: 1900,  calibrate_rank_sort: 3, calibrate_rank_star: 2, calibrate_rank_name: '中军',
      good_at_positions: '5',      wx_nickname: '团队之盾' },

    // --- 卫士 (900-1749) ---
    { id: 'P16', calibrate_mmr: 1600,  calibrate_rank_sort: 2, calibrate_rank_star: 5, calibrate_rank_name: '卫士',
      good_at_positions: '3,5',    wx_nickname: '铁血抗压' },
    { id: 'P17', calibrate_mmr: 1300,  calibrate_rank_sort: 2, calibrate_rank_star: 3, calibrate_rank_name: '卫士',
      good_at_positions: '4',      wx_nickname: '默默付出' },
    { id: 'P18', calibrate_mmr: 1000,  calibrate_rank_sort: 2, calibrate_rank_star: 2, calibrate_rank_name: '卫士',
      good_at_positions: '2,1',    wx_nickname: '新手中路' },

    // --- 先锋 (0-899) ---
    { id: 'P19', calibrate_mmr: 700,   calibrate_rank_sort: 1, calibrate_rank_star: 4, calibrate_rank_name: '先锋',
      good_at_positions: '1,4',    wx_nickname: '萌新Carry' },
    { id: 'P20', calibrate_mmr: 300,   calibrate_rank_sort: 1, calibrate_rank_star: 2, calibrate_rank_name: '先锋',
      good_at_positions: '5,3',    wx_nickname: '勤能补拙' },
  ];

  printPlayerTable(players);

  const result = allocateTeams(players, 4);

  printResult(result);

  return result;
}


// ============================================================
// 测试2：15名选手，3支队伍 — 无实际 MMR，仅段位+星级
// ============================================================

function test2_rankFormulaOnly() {
  console.log('\n' + '='.repeat(65));
  console.log('  测试2：15名选手 → 3支队伍');
  console.log('  特征：无实际 MMR（calibrate_mmr 为空/0），全部靠段位+星级推算等效分');
  console.log('  特殊：2号位仅有2人、5号位仅3人 → 验证位置补全+警告效果');
  console.log('='.repeat(65));

  // calibrate_mmr 设为 null/0，强制走 rank_sort + rank_star 公式推算
  const players = [
    // --- 冠绝一世 (等效6000) ---
    { id: 'R01', calibrate_mmr: null, calibrate_rank_sort: 8, calibrate_rank_star: 0, calibrate_rank_name: '冠绝一世',
      good_at_positions: '1,3',    wx_nickname: '冠绝大腿' },
    // --- 超凡入圣 (等效分按公式: 5100 + (star-1)*180) ---
    { id: 'R02', calibrate_mmr: 0, calibrate_rank_sort: 7, calibrate_rank_star: 5, calibrate_rank_name: '超凡入圣',
      good_at_positions: '2',      wx_nickname: '圣剑中单' },       // 等效: 5100+4*180=5820
    { id: 'R03', calibrate_mmr: 0, calibrate_rank_sort: 7, calibrate_rank_star: 3, calibrate_rank_name: '超凡入圣',
      good_at_positions: '3,1',    wx_nickname: '三号位支柱' },     // 等效: 5100+2*180=5460
    // --- 万古流芳 (等效: 4250 + (star-1)*170) ---
    { id: 'R04', calibrate_mmr: null, calibrate_rank_sort: 6, calibrate_rank_star: 4, calibrate_rank_name: '万古流芳',
      good_at_positions: '4,5',    wx_nickname: '万古游走' },       // 等效: 4250+3*170=4760
    { id: 'R05', calibrate_mmr: null, calibrate_rank_sort: 6, calibrate_rank_star: 2, calibrate_rank_name: '万古流芳',
      good_at_positions: '1,4',    wx_nickname: '节奏发动机' },     // 等效: 4250+1*170=4420
    // --- 传奇 (等效: 3350 + (star-1)*180) ---
    { id: 'R06', calibrate_mmr: 0, calibrate_rank_sort: 5, calibrate_rank_star: 5, calibrate_rank_name: '传奇',
      good_at_positions: '2,3',    wx_nickname: '传奇摇摆' },       // 等效: 3350+4*180=4070
    { id: 'R07', calibrate_mmr: 0, calibrate_rank_sort: 5, calibrate_rank_star: 3, calibrate_rank_name: '传奇',
      good_at_positions: '4',      wx_nickname: '传奇辅助' },       // 等效: 3350+2*180=3710
    // --- 统帅 (等效: 2650 + (star-1)*140) ---
    { id: 'R08', calibrate_mmr: null, calibrate_rank_sort: 4, calibrate_rank_star: 4, calibrate_rank_name: '统帅',
      good_at_positions: '3',      wx_nickname: '统帅三号位' },     // 等效: 2650+3*140=3070
    { id: 'R09', calibrate_mmr: null, calibrate_rank_sort: 4, calibrate_rank_star: 2, calibrate_rank_name: '统帅',
      good_at_positions: '5,4',    wx_nickname: '统帅老将' },       // 等效: 2650+1*140=2790
    // --- 中军 (等效: 1750 + (star-1)*180) ---
    { id: 'R10', calibrate_mmr: 0, calibrate_rank_sort: 3, calibrate_rank_star: 4, calibrate_rank_name: '中军',
      good_at_positions: '1',      wx_nickname: '中军Carry' },      // 等效: 1750+3*180=2290
    { id: 'R11', calibrate_mmr: 0, calibrate_rank_sort: 3, calibrate_rank_star: 2, calibrate_rank_name: '中军',
      good_at_positions: '5,3',    wx_nickname: '中军之盾' },       // 等效: 1750+1*180=1930
    // --- 卫士 (等效: 900 + (star-1)*170) ---
    { id: 'R12', calibrate_mmr: null, calibrate_rank_sort: 2, calibrate_rank_star: 5, calibrate_rank_name: '卫士',
      good_at_positions: '4,5',    wx_nickname: '卫士之光' },       // 等效: 900+4*170=1580
    { id: 'R13', calibrate_mmr: null, calibrate_rank_sort: 2, calibrate_rank_star: 2, calibrate_rank_name: '卫士',
      good_at_positions: '1,3',    wx_nickname: '新手之勇' },       // 等效: 900+1*170=1070
    // --- 先锋 (等效: 0 + (star-1)*180) ---
    { id: 'R14', calibrate_mmr: 0, calibrate_rank_sort: 1, calibrate_rank_star: 4, calibrate_rank_name: '先锋',
      good_at_positions: '3,4',    wx_nickname: '先锋小将' },       // 等效: 0+3*180=540
    { id: 'R15', calibrate_mmr: 0, calibrate_rank_sort: 1, calibrate_rank_star: 1, calibrate_rank_name: '先锋',
      good_at_positions: '5',      wx_nickname: '纯真辅助' },       // 等效: 0+0*180=0
  ];

  // 打印选手+等效分
  printPlayerWithRankScore(players);

  console.log('\n  ⚠ 注意：15名选手中，专精2号位的仅2人（圣剑中单、传奇摇摆），');
  console.log('         3支队伍各需要1个2号位，算法将产生位置缺失警告');

  const result = allocateTeams(players, 3);

  printResult(result);

  return result;
}


// ============================================================
// 测试3：后端 Service 层集成示例
// ============================================================

function test3_apiIntegrationExample() {
  console.log('\n' + '='.repeat(65));
  console.log('  示例：后端接口中调用算法并批量写入 dota2_event_teams 表');
  console.log('='.repeat(65));

  console.log(`
  ┌─────────────────────────────────────────────────────────────┐
  │  在 server/index.js 中添加以下路由                            │
  │                                                              │
  │  POST /api/events/:eventId/allocate-teams                    │
  │  请求体：{ teamCount, forceRules?, config? }                  │
  └─────────────────────────────────────────────────────────────┘

  // ============ 后端代码 ============

  const { allocateTeams } = require('./utils/team-allocation');

  app.post('/api/events/:eventId/allocate-teams', async (req, res) => {
    try {
      const { eventId } = req.params;
      const { teamCount, forceRules, config } = req.body;

      // 1. 权限校验（admin 和 super_admin 均可操作）
      const role = await getCallerRole(req.query.openid);
      if (role !== 'admin' && role !== 'super_admin') {
        return res.json({ success: false, error: '仅管理员可操作' });
      }

      // 2. 校验赛事存在
      const [events] = await pool.query(
        'SELECT event_id FROM dota2_events WHERE event_id = ?', [eventId]
      );
      if (!events.length) {
        return res.json({ success: false, error: '赛事不存在' });
      }

      // 3. 获取已报名选手ID
      const [signups] = await pool.query(
        'SELECT player_id FROM dota2_event_signup WHERE event_id = ? AND signup_status = 1',
        [eventId]
      );
      if (!signups.length) {
        return res.json({ success: false, error: '暂无有效报名选手' });
      }

      // 4. 批量查询选手完整信息（含段位字段）
      const playerIds = signups.map(s => s.player_id);
      const [players] = await pool.query(
        \`SELECT id, wx_nickname, calibrate_mmr, calibrate_rank_sort,
                calibrate_rank_star, calibrate_rank_name, good_at_positions
         FROM dota2_players WHERE id IN (?)\`,
        [playerIds]
      );

      if (players.length < teamCount * 5) {
        return res.json({
          success: false,
          error: \`选手不足：\${players.length}人，至少需要\${teamCount * 5}人\`
        });
      }

      // 5. 调用分队算法（入参字段与 dota2_players 完全一致）
      const result = allocateTeams(players, teamCount, forceRules, config);

      // 6. 事务写入 dota2_event_teams
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();

        // 清空该赛事已有队伍（重新分队场景）
        await conn.execute('DELETE FROM dota2_event_teams WHERE event_id = ?', [eventId]);

        const now = Date.now();
        for (const team of result.teams) {
          const teamId = genId();
          // player_ids 存 JSON 数组，total_mmr 存计算后的总分
          const playerIdsJson = JSON.stringify(team.playerList.map(p => p.id));
          await conn.execute(
            \`INSERT INTO dota2_event_teams
             (team_id, event_id, team_name, captain_id, player_ids, total_mmr, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)\`,
            [teamId, eventId, team.teamName, team.captainId, playerIdsJson, team.totalScore, now, now]
          );
        }

        await conn.commit();

        res.json({
          success: true,
          data: {
            teams: result.teams,
            balanceInfo: result.balanceInfo,
            warnings: result.warnings,
          }
        });
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    } catch (err) {
      console.error('分队失败:', err);
      res.json({ success: false, error: err.message });
    }
  });


  // ============ 前端小程序调用 ============

  // pages/dota2-event-manage/dota2-event-manage.js

  const { get } = require('../../utils/api');

  async function doAllocateTeams(eventId) {
    const openid = wx.getStorageSync('openid');
    const result = await get(\`/api/events/\${eventId}/allocate-teams\`, {
      method: 'POST',
      data: {
        teamCount: 4,
        forceRules: {
          mustSameTeam: [['P01', 'P05']],      // 这些选手必须同队
          mustNotSameTeam: [['P04', 'P02']]     // 这些选手禁止同队
        },
        config: {
          positionRequired: true,               // 启用位置强制校验
        }
      },
      openid
    });

    if (result.success) {
      const { teams, balanceInfo, warnings } = result.data;
      console.log('分队完成!', \`最大分差: \${balanceInfo.scoreStats.maxDiff}\`);
      // 渲染队伍卡片 + 均衡度面板 + 警告列表
    }
  }
`);
}


// ============================================================
// 输出格式化
// ============================================================

/** 打印选手列表（测试1：含 MMR） */
function printPlayerTable(players) {
  console.log('\n【选手列表】');
  console.log('  ' + '─'.repeat(58));
  players.forEach((p, i) => {
    const id = String(i + 1).padStart(2);
    const name = p.wx_nickname.padEnd(10);
    const mmr = String(p.calibrate_mmr ?? '-').padStart(6);
    const rank = (p.calibrate_rank_name || '').padEnd(8);
    console.log(`  ${id}. ${name}  MMR:${mmr}  ${rank}  位置: ${p.good_at_positions}`);
  });
  console.log('  ' + '─'.repeat(58));
}

/** 打印选手列表（测试2：含等效分计算） */
function printPlayerWithRankScore(players) {
  console.log('\n【选手列表（MMR为空→按段位公式推算等效分）】');
  console.log('  ' + '─'.repeat(68));
  players.forEach((p, i) => {
    const { score, source } = getScore(p);
    const id = String(i + 1).padStart(2);
    const name = p.wx_nickname.padEnd(10);
    const rank = (p.calibrate_rank_name || '').padEnd(8);
    const star = p.calibrate_rank_star || 0;
    const tag = source === 'rank_formula' ? '公式推算' :
                source === 'default_immortal' ? '冠绝默认' : source;
    console.log(`  ${id}. ${name}  ${rank} [${star}★]  → 等效分:${String(score).padStart(5)}  (${tag})  位置: ${p.good_at_positions}`);
  });
  console.log('  ' + '─'.repeat(68));
}

/** 通用输出 */
function printResult(result) {
  console.log('\n【分队结果】');

  if (!result.teams || result.teams.length === 0) {
    console.log('  ✗ 分配失败');
    return;
  }

  result.teams.forEach(team => {
    const status = team.positionStats.isComplete ? '✓ 位置齐全' : '⚠ 缺位';
    const bar = '─'.repeat(58);
    console.log(`\n  ${bar}`);
    console.log(`  │ ${team.teamName}  ${status}`);
    console.log(`  │ 人数: ${team.memberCount}  │  总分: ${team.totalScore}  │  均分: ${team.avgScore}`);
    console.log(`  │ 队长: ${team.playerList.find(p => p.id === team.captainId)?.wx_nickname || 'N/A'}`);
    console.log(`  │ 位置覆盖:`);
    ALL_POSITIONS.forEach(pos => {
      const names = team.positionStats.coverage[pos] || [];
      const mark = names.length > 0 ? `✓ ${names.join(', ')}` : '✗ (缺失!!)';
      console.log(`  │   ${pos}号位: ${mark}`);
    });
    console.log(`  │ 成员详情:`);
    team.playerList.forEach(p => {
      const name = (p.wx_nickname || '').padEnd(10);
      const score = String(p.computedScore).padStart(5);
      const src = p.scoreSource === 'actual_mmr' ? 'MMR' :
                   p.scoreSource === 'rank_formula' ? '段位' : '—';
      const pos = (p.good_at_positions || '');
      console.log(`  │   · ${name} 分值:${score}(${src})  位置: ${pos}`);
    });
    console.log(`  ${bar}`);
  });

  console.log('\n【均衡度统计】');
  if (result.balanceInfo) {
    const b = result.balanceInfo;
    console.log(`  总分区间  : ${b.scoreStats.min} ~ ${b.scoreStats.max}`);
    console.log(`  平均总分  : ${b.scoreStats.average}`);
    console.log(`  最大分差  : ${b.scoreStats.maxDiff}`);
    console.log(`  标准差    : ${b.scoreStats.stdDeviation}`);
    console.log(`  评级      : ${b.scoreStats.grade}`);
    console.log(`  位置满足  : ${b.positionRate.completeTeams}/${b.positionRate.totalTeams} ` +
                `(${(b.positionRate.rate * 100).toFixed(0)}%) ${b.positionRate.grade}`);
    console.log(`  人数分布  : ${b.memberDistribution.min}~${b.memberDistribution.max} ` +
                `(平均${b.memberDistribution.avg}人)`);
    console.log(`  交换次数  : ${b.swapCount} 次`);
    if (b.scoreSource) {
      console.log(`  分值来源  : 实际MMR=${b.scoreSource.actual_mmr || 0} ` +
                  `段位推算=${b.scoreSource.rank_formula || 0} ` +
                  `冠绝默认=${b.scoreSource.default_immortal || 0}`);
    }
  }

  if (result.warnings && result.warnings.length > 0) {
    console.log('\n【警告信息】');
    result.warnings.forEach(w => console.log(`  ⚠ ${w}`));
  }
}


// ============================================================
// 段位配置表展示
// ============================================================

function showRankConfig() {
  console.log('\n' + '='.repeat(65));
  console.log('  DOTA2 段位分值配置表（内置数据源）');
  console.log('='.repeat(65));

  const table = getRankConfigTable();
  console.log('\n  rank_sort  段位名称        分数区间          单星步长  星级');
  console.log('  ' + '─'.repeat(58));
  table.forEach(row => {
    const sort = String(row.rankSort).padStart(9);
    const name = row.rankName.padEnd(14);
    const range = row.scoreRange.padEnd(16);
    const step = row.hasStars ? String(row.stepPerStar).padStart(5) : '  无';
    const star = row.hasStars ? `1~5星` : '无星级';
    console.log(`  ${sort}  ${name}  ${range}  ${step}    ${star}`);
  });
  console.log('  ' + '─'.repeat(58));
}


// ============================================================
// 运行入口
// ============================================================

console.log('\n' + '█'.repeat(65));
console.log('█  DOTA2 段位分值均衡分队算法 — 自动化测试套件');
console.log('█'.repeat(65));

showRankConfig();

const r1 = test1_allActualMmr();
const r2 = test2_rankFormulaOnly();
test3_apiIntegrationExample();

console.log('\n' + '█'.repeat(65));
console.log('█  全部测试完成');
console.log('█'.repeat(65) + '\n');
