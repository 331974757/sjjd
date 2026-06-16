/**
 * ============================================================
 * DOTA2 段位分值均衡分队算法 - 独立工具函数
 * ============================================================
 *
 * 【依赖】server/utils/rank-score.js（段位分值计算）
 *
 * 【使用方式】
 *   const { allocateTeams } = require('./utils/team-allocation');
 *   const result = allocateTeams(playerList, teamCount, forceRules, config);
 *
 * 【设计思路】
 *   1. 分值预处理：调用 rank-score.getScore() 为每位选手计算最终分值
 *      （优先 calibrate_mmr > 0，否则按 rank_sort + rank_star 推算等效分）
 *   2. 强制规则：mustSameTeam → 打包虚拟选手；mustNotSameTeam → 冲突表
 *   3. 蛇形分配：按分值降序 → 蛇形分配 → 禁同队跳过冲突队伍
 *   4. 位置补全：每队必须1-5号位齐全，缺失时跨队交换（MMR差值≤阈值）
 *   5. 输出：队伍结果 + 均衡度统计 + 警告
 *
 * 【数据契约】入参 playerList 字段对应 dota2_players 表：
 *   id, calibrate_mmr, calibrate_rank_sort, calibrate_rank_star,
 *   calibrate_rank_name, good_at_positions, wx_nickname
 * ============================================================
 */

const { getScore, attachScores } = require('./rank-score');

// ---------- 常量定义 ----------

/** Dota2 标准五个位置：1(Carry) 2(Mid) 3(Offlane) 4(Support) 5(HardSupport) */
const ALL_POSITIONS = [1, 2, 3, 4, 5];

/** 默认每队核心人数（不含替补，替补不占用强制位置名额） */
const CORE_SIZE = 5;

/** 位置补全换人时单次分值差值容忍上限（默认500分） */
const DEFAULT_SWAP_TOLERANCE = 500;

/** 位置补全最大尝试轮数 */
const MAX_SWAP_ROUNDS = 3;


// ---------- 辅助函数 ----------

/**
 * 解析选手擅长位置字符串 → 数字数组
 * 支持 "1,3,5"、"1/3/5"、"1 3 5"、"1、3、5" 等分隔符
 * @param {string|null|undefined} posStr
 * @returns {number[]}
 */
function parsePositions(posStr) {
  if (!posStr) return [];
  return String(posStr)
    .split(/[,，/、\s]+/)
    .map(s => parseInt(s, 10))
    .filter(n => ALL_POSITIONS.includes(n));
}

/** 浅拷贝选手对象，避免修改原数据 */
function clonePlayer(p) {
  return { ...p };
}

/** 计算标准差 */
function stdDev(values) {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}


// ============================================================
// 核心算法入口
// ============================================================

/**
 * 段位分值均衡分队主函数
 *
 * @param {Object[]}   playerList            - 参赛选手列表
 * @param {string}     playerList[].id              - 选手ID (dota2_players.id)
 * @param {number|null} playerList[].calibrate_mmr   - 实际MMR（优先使用）
 * @param {number}     playerList[].calibrate_rank_sort - 段位排序值 1-8
 * @param {number}     playerList[].calibrate_rank_star - 段位星数 1-5
 * @param {string}     playerList[].good_at_positions   - 擅长位置 "1,3,5"
 * @param {string}     playerList[].wx_nickname         - 微信昵称
 * @param {number}     teamCount             - 目标队伍数量（≥2）
 * @param {Object}     [forceRules]          - 强制约束规则
 * @param {string[][]} [forceRules.mustSameTeam]    - 必须同队 ID 组
 * @param {string[][]} [forceRules.mustNotSameTeam] - 禁止同队 ID 组
 * @param {Object}     [config]              - 扩展配置
 * @param {boolean}    [config.positionRequired] - 是否强制补齐5位置，默认 true
 * @param {number}     [config.maxBalanceDiff]   - 允许最大总分差，默认不设限
 * @returns {{ teams: Object[], balanceInfo: Object, warnings: string[] }}
 */
function allocateTeams(playerList, teamCount, forceRules = {}, config = {}) {
  const warnings = [];

  // 默值合并
  const cfg = {
    positionRequired: config.positionRequired !== false, // 默认 true
    maxBalanceDiff: config.maxBalanceDiff ?? Infinity,
    swapTolerance: config.swapTolerance ?? DEFAULT_SWAP_TOLERANCE,
  };

  // === 第0步：参数校验 ===
  if (!Array.isArray(playerList) || playerList.length === 0) {
    return { teams: [], balanceInfo: null, warnings: ['选手列表为空'] };
  }
  if (!Number.isInteger(teamCount) || teamCount < 2) {
    return { teams: [], balanceInfo: null, warnings: ['队伍数量至少为2'] };
  }

  const totalPlayers = playerList.length;
  const minPlayersNeeded = teamCount * CORE_SIZE;

  if (totalPlayers < minPlayersNeeded) {
    return {
      teams: [],
      balanceInfo: null,
      error: `选手总数(${totalPlayers})不足：${teamCount}支队伍×每队${CORE_SIZE}人=最少需要${minPlayersNeeded}人，当前仅${totalPlayers}人，请增加选手或减少队伍数量`
    };
  }

  // === 第1步：数据预处理（分值计算 + 位置解析） ===
  // 调用 rank-score 模块为每位选手计算最终分值
  const players = attachScores(playerList).map(p => ({
    ...p,
    _pos: parsePositions(p.good_at_positions),
  }));

  // 记录分值来源统计
  const scoreSourceCount = { actual_mmr: 0, rank_formula: 0, default_immortal: 0 };
  players.forEach(p => {
    const src = p._scoreSource || 'unknown';
    scoreSourceCount[src] = (scoreSourceCount[src] || 0) + 1;
  });

  // 建立选手ID快速索引
  const playerMap = {};
  players.forEach(p => { playerMap[p.id] = p; });

  // === 第2步：处理强制规则 ===
  const { forceGroups, antigroups } = buildForceConstraints(
    players, forceRules, playerMap, warnings
  );

  // === 第3步：蛇形分配 ===
  let teams = snakeDraft(players, teamCount, forceGroups, antigroups, warnings);

  // === 第4步：位置补全微调（如果启用了位置强制校验） ===
  let swapCount = 0;
  if (cfg.positionRequired) {
    const swapResult = positionSwap(teams, warnings, cfg.swapTolerance);
    teams = swapResult.teams;
    swapCount = swapResult.swapCount;
  }

  // === 第5步：生成最终输出 ===
  const finalTeams = buildTeamOutput(teams, players);
  const balanceInfo = computeBalance(finalTeams, {
    swapCount,
    scoreSourceCount,
    positionRequired: cfg.positionRequired,
  });

  return {
    teams: finalTeams,
    balanceInfo,
    warnings,
  };
}


// ============================================================
// 第2步：构建强制约束
// ============================================================

/**
 * 将 mustSameTeam / mustNotSameTeam 预处理为内部使用的分组结构
 *
 * - forceGroups：Map<groupId, Set<playerId>>
 *     同组选手打包成一个"虚拟分配单元"，按平均分参与蛇形排序
 * - antigroups：Set<"A|B">
 *     禁止同队的选手对，分配时跳过冲突队伍
 */
function buildForceConstraints(players, forceRules, playerMap, warnings) {
  const forceGroups = new Map();
  const groupMemo = new Map();    // playerId → groupId
  const antigroups = new Set();

  // --- 处理 mustSameTeam ---
  const mustSame = forceRules.mustSameTeam || [];
  mustSame.forEach((group, idx) => {
    if (!Array.isArray(group) || group.length < 2) return;
    const validIds = group.filter(id => playerMap[id]);
    if (validIds.length < 2) return;
    const groupId = `fg_${idx}`;
    forceGroups.set(groupId, new Set(validIds));
    validIds.forEach(id => groupMemo.set(id, groupId));
  });

  // 检测：同一选手出现在多个强制组中
  const seenIds = new Set();
  for (const [, idSet] of forceGroups) {
    for (const id of idSet) {
      if (seenIds.has(id)) {
        warnings.push(`选手 ${playerMap[id]?.wx_nickname || id} 在多个强制同队组中，已保留首个组`);
        idSet.delete(id);
      }
      seenIds.add(id);
    }
  }

  // --- 处理 mustNotSameTeam ---
  const mustNotSame = forceRules.mustNotSameTeam || [];
  mustNotSame.forEach(pair => {
    if (!Array.isArray(pair) || pair.length < 2) return;
    const a = pair[0], b = pair[1];
    if (!playerMap[a] || !playerMap[b]) return;

    // 冲突检测：同组选手被设为禁同队 → 以禁同队为准
    if (groupMemo.has(a) && groupMemo.has(b) && groupMemo.get(a) === groupMemo.get(b)) {
      warnings.push(
        `「${playerMap[a]?.wx_nickname || a}」和「${playerMap[b]?.wx_nickname || b}」` +
        `同时被设为必须同队和禁止同队，以禁止同队为准`
      );
      const gid = groupMemo.get(a);
      const gset = forceGroups.get(gid);
      if (gset) { gset.delete(a); gset.delete(b); }
      if (gset && gset.size < 2) forceGroups.delete(gid);
    }
    antigroups.add(`${a}|${b}`);
    antigroups.add(`${b}|${a}`);
  });

  return { forceGroups, antigroups };
}


// ============================================================
// 第3步：蛇形分配（Serpentine Draft）
// ============================================================

/**
 * 蛇形分配算法
 *
 * 【原理】
 *   所有选手/虚拟组按分值降序排列后，按蛇形方向逐一分配：
 *     第1轮：队1 → 队2 → ... → 队N（正序）
 *     第2轮：队N → 队N-1 → ... → 队1（逆序）
 *     循环往复
 *   优点：高分选手分散到不同队伍，低分选手补充到有高分的队伍，
 *         保证各队总分尽可能接近。
 *
 * 【强制规则集成】
 *   - mustSameTeam 组：打包为"虚拟单元"，取组内平均分参与排序
 *   - mustNotSameTeam：分配当前单元时，跳过冲突队伍
 *   - 极端情况所有队都冲突：硬塞到总分最低的队伍
 */
function snakeDraft(players, teamCount, forceGroups, antigroups, warnings) {
  // 初始化空队伍
  const teams = [];
  for (let i = 0; i < teamCount; i++) {
    teams.push({ index: i, members: [] });
  }

  // === 3.1 构建待分配队列 ===
  const allocatedIds = new Set();
  const queue = [];

  // 强制同组 → 打包为虚拟单元（平均分参与排序）
  for (const [, idSet] of forceGroups) {
    const groupPlayers = [];
    let totalScore = 0;
    for (const pid of idSet) {
      const p = players.find(pl => pl.id === pid);
      if (p) {
        groupPlayers.push(p);
        totalScore += p._score;
        allocatedIds.add(pid);
      }
    }
    if (groupPlayers.length > 0) {
      queue.push({
        type: 'group',
        players: groupPlayers,
        _score: Math.round(totalScore / groupPlayers.length),
        memberIds: new Set(groupPlayers.map(p => p.id)),
        label: `[同队组]${groupPlayers.map(p => p.wx_nickname).join('+')}`,
      });
    }
  }

  // 普通选手（未被强制组囊括的）
  for (const p of players) {
    if (!allocatedIds.has(p.id)) {
      queue.push({
        type: 'single',
        players: [p],
        _score: p._score,
        memberIds: new Set([p.id]),
        label: p.wx_nickname || p.id,
      });
    }
  }

  // === 3.2 按分值降序排列 ===
  queue.sort((a, b) => b._score - a._score);

  // === 3.3 蛇形分配 ===
  let direction = 1;   // 1=正序，-1=逆序
  let currentIdx = 0;

  for (const unit of queue) {
    let assigned = false;

    for (let attempt = 0; attempt < teamCount; attempt++) {
      const teamIdx = currentIdx;

      // 检查禁同队约束
      const hasConflict = checkAntiConflict(teams[teamIdx], unit, antigroups);

      if (!hasConflict) {
        // 分配成功
        for (const p of unit.players) {
          teams[teamIdx].members.push(p);
        }
        assigned = true;

        // 移动到下一队（蛇形方向）
        currentIdx += direction;
        if (currentIdx >= teamCount) {
          currentIdx = teamCount - 1;
          direction = -1;
        } else if (currentIdx < 0) {
          currentIdx = 0;
          direction = 1;
        }
        break;
      } else {
        // 冲突，跳过当前队，继续尝试下一个
        currentIdx += direction;
        if (currentIdx >= teamCount) {
          currentIdx = teamCount - 1;
          direction = -1;
        } else if (currentIdx < 0) {
          currentIdx = 0;
          direction = 1;
        }
      }
    }

    if (!assigned) {
      // 所有队都冲突 → 强制分配到总分最低的队伍
      const fallbackTeam = teams.reduce((best, t) =>
        getTeamScore(t) < getTeamScore(best) ? t : best
      );
      for (const p of unit.players) {
        fallbackTeam.members.push(p);
      }
      warnings.push(
        `强制约束冲突：${unit.players.map(p => p.wx_nickname).join('、')} ` +
        `无法避开禁同队规则，已强制分配到${fallbackTeam.index + 1}队`
      );
    }
  }

  return teams;
}

/** 检查分配单元与目标队伍是否有 mustNotSameTeam 冲突 */
function checkAntiConflict(team, unit, antigroups) {
  for (const existPlayer of team.members) {
    for (const newPlayer of unit.players) {
      if (antigroups.has(`${existPlayer.id}|${newPlayer.id}`)) {
        return true;
      }
    }
  }
  return false;
}

/** 计算队伍总分数 */
function getTeamScore(team) {
  return team.members.reduce((sum, p) => sum + p._score, 0);
}


// ============================================================
// 第4步：位置补全微调（Position Swap）
// ============================================================

/**
 * 跨队交换选手，补全每队缺失的 Dota2 标准位置
 *
 * 【策略】
 *   遍历每支队伍 → 检测缺失的 1-5 号位 →
 *   从其他队伍找一个能补位、且换出后不会造成对方缺位的选手 →
 *   在 MMR 差值最小时执行交换
 *
 * 【约束】
 *   - 不拆散 mustSameTeam 组
 *   - 单次交换分值差 ≤ swapTolerance
 *   - 最多尝试 MAX_SWAP_ROUNDS 轮，达到稳定状态即退出
 *
 * @returns {{ teams, swapCount }}
 */
function positionSwap(teams, warnings, swapTolerance) {
  let swapCount = 0;

  for (let round = 0; round < MAX_SWAP_ROUNDS; round++) {
    let improved = false;

    // 按总分降序处理（高分队更容易换出合适人选）
    const sortedTeams = [...teams].sort((a, b) => getTeamScore(b) - getTeamScore(a));

    for (const team of sortedTeams) {
      const missing = getMissingPositions(team.members);
      if (missing.length === 0) continue;

      for (const needPos of missing) {
        const bestSwap = findBestSwap(team, needPos, teams, missing, swapTolerance);
        if (bestSwap) {
          executeSwap(team, bestSwap);
          swapCount++;
          improved = true;
        }
      }
    }

    if (!improved) break; // 本轮无任何改进，稳定了
  }

  // 生成缺失警告
  for (const team of teams) {
    const stillMissing = getMissingPositions(team.members);
    if (stillMissing.length > 0) {
      warnings.push(
        `队伍${team.index + 1} 仍缺失${stillMissing.length}个位置` +
        `(${stillMissing.join(',')}号位)，请手动调整`
      );
    }
  }

  return { teams, swapCount };
}

/** 获取队伍覆盖的所有位置集合，返回缺失的 1-5 号位 */
function getMissingPositions(members) {
  const covered = new Set();
  for (const p of members) {
    for (const pos of p._pos) {
      covered.add(pos);
    }
  }
  return ALL_POSITIONS.filter(pos => !covered.has(pos));
}

/**
 * 为 needTeam 的缺失位置 needPos，找全局最优交换方案
 *
 * 【找法】
 *   遍历 needTeam 每个成员作为 toPlayer（被换出者）
 *     → 遍历其他队每个成员作为 fromPlayer（换入者，必须擅长 needPos）
 *       → 检查 fromPlayer 被换走后，原队伍位置覆盖不恶化
 *       → MMR 差值越小越好，且必须 ≤ swapTolerance
 *
 * @returns {{ fromTeam, fromPlayer, toPlayer } | null}
 */
function findBestSwap(needTeam, needPos, allTeams, needTeamMissing, swapTolerance) {
  let best = null;
  let bestScoreDiff = Infinity;

  for (const toPlayer of needTeam.members) {
    // toPlayer 覆盖了 needTeam 其他缺失位置 → 跳过（避免拆东墙补西墙）
    const toPlayerCoversOtherMissing = needTeamMissing.some(
      pos => pos !== needPos && toPlayer._pos.includes(pos)
    );

    for (const fromTeam of allTeams) {
      if (fromTeam.index === needTeam.index) continue;

      const fromMissingBefore = getMissingPositions(fromTeam.members);

      for (const fromPlayer of fromTeam.members) {
        // fromPlayer 必须擅长 needPos
        if (!fromPlayer._pos.includes(needPos)) continue;

        // 模拟换出 fromPlayer 后 fromTeam 的位置覆盖
        const fromAfterRemove = fromTeam.members.filter(p => p.id !== fromPlayer.id);
        const fromMissingAfter = getMissingPositions(fromAfterRemove);

        // 换出后缺失不能显著恶化（允许多1个缺失，因为换入的 toPlayer 可能补位）
        if (fromMissingAfter.length > fromMissingBefore.length + 1) continue;

        // 分值差值计算
        const scoreDiff = Math.abs(fromPlayer._score - toPlayer._score);
        if (scoreDiff < bestScoreDiff && scoreDiff <= swapTolerance) {
          bestScoreDiff = scoreDiff;
          best = { fromTeam, fromPlayer, toPlayer };
        }
      }
    }
  }

  return best;
}

/** 执行跨队选手交换 */
function executeSwap(needTeam, swapInfo) {
  const { fromTeam, fromPlayer, toPlayer } = swapInfo;

  needTeam.members = needTeam.members.filter(p => p.id !== toPlayer.id);
  fromTeam.members = fromTeam.members.filter(p => p.id !== fromPlayer.id);

  needTeam.members.push(fromPlayer);
  fromTeam.members.push(toPlayer);
}


// ============================================================
// 第5步：生成最终输出
// ============================================================

/**
 * 构建每支队伍的输出对象
 */
function buildTeamOutput(teams, allPlayers) {
  return teams.map(team => {
    const members = team.members;

    // 队伍总分
    const totalScore = members.reduce((sum, p) => sum + p._score, 0);

    // 推荐队长：分值最高的选手
    const sortedByScore = [...members].sort((a, b) => b._score - a._score);
    const captainId = sortedByScore.length > 0 ? sortedByScore[0].id : null;

    // 位置覆盖统计
    const positionCoverage = {};
    ALL_POSITIONS.forEach(pos => { positionCoverage[pos] = []; });
    for (const p of members) {
      for (const pos of p._pos) {
        positionCoverage[pos].push(p.wx_nickname || p.id);
      }
    }

    const missingPositions = ALL_POSITIONS.filter(
      pos => positionCoverage[pos].length === 0
    );

    // 成员列表（输出字段包含完整的段位信息）
    const playerList = members.map(p => ({
      id: p.id,
      wx_nickname: p.wx_nickname || '',
      calibrate_mmr: p.calibrate_mmr ?? null,
      calibrate_rank_sort: p.calibrate_rank_sort ?? null,
      calibrate_rank_star: p.calibrate_rank_star ?? null,
      calibrate_rank_name: p.calibrate_rank_name || '',
      good_at_positions: p.good_at_positions || '',
      positionDetail: p._pos,
      computedScore: p._score,          // 参与计算的最终分值
      scoreSource: p._scoreSource,       // 分值来源：actual_mmr | rank_formula | ...
    }));

    return {
      teamIndex: team.index + 1,
      teamName: `队伍${team.index + 1}`,
      memberCount: members.length,
      playerList,
      captainId,
      totalScore,
      avgScore: Math.round(totalScore / members.length),
      positionStats: {
        coverage: positionCoverage,
        missingPositions,
        isComplete: missingPositions.length === 0,
      },
    };
  });
}

/**
 * 计算全局均衡度统计
 * @param {number} meta.swapCount - 位置补全交换次数
 * @param {Object} meta.scoreSourceCount - 分值来源统计
 * @param {boolean} meta.positionRequired - 是否启用了位置校验
 */
function computeBalance(finalTeams, meta) {
  const scores = finalTeams.map(t => t.totalScore);
  const memberCounts = finalTeams.map(t => t.memberCount);
  const { swapCount, scoreSourceCount, positionRequired } = meta;

  if (scores.length === 0) return null;

  const maxScore = Math.max(...scores);
  const minScore = Math.min(...scores);
  const avgScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  const maxDiff = maxScore - minScore;
  const stdDeviation = stdDev(scores);

  // 位置满足率
  const completeTeams = finalTeams.filter(t => t.positionStats.isComplete).length;
  const positionRate = finalTeams.length > 0
    ? completeTeams / finalTeams.length
    : 0;

  return {
    scoreStats: {
      max: maxScore,
      min: minScore,
      average: avgScore,
      maxDiff,
      stdDeviation: Math.round(stdDeviation),
      grade: gradeBalance(maxDiff, stdDeviation),
    },
    positionRate: {
      completeTeams,
      totalTeams: finalTeams.length,
      rate: positionRate,
      grade: positionRate >= 1 ? '完美' : positionRate >= 0.75 ? '良好' : '需手动调整',
    },
    memberDistribution: {
      max: Math.max(...memberCounts),
      min: Math.min(...memberCounts),
      avg: Math.round(memberCounts.reduce((a, b) => a + b, 0) / memberCounts.length),
    },
    swapCount,     // 位置补全交换次数
    scoreSource: scoreSourceCount, // 分值来源分布
    positionRequired,
  };
}

/** 分值均衡等级评价 */
function gradeBalance(maxDiff, stdDev) {
  if (maxDiff <= 200 && stdDev <= 80) return '★ 非常均衡';
  if (maxDiff <= 500 && stdDev <= 200) return '★★ 均衡';
  if (maxDiff <= 1000 && stdDev <= 400) return '★★★ 可接受';
  return '⚠ 偏差较大，建议手动调整';
}


// ============================================================
// 导出
// ============================================================

module.exports = {
  allocateTeams,
  // 子函数导出（方便单元测试）
  parsePositions,
  getMissingPositions,
  getTeamScore,
  stdDev,
  ALL_POSITIONS,
  CORE_SIZE,
};
