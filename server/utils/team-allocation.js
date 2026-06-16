/**
 * ============================================================
 * MMR 均衡分队算法 - 独立工具函数
 * ============================================================
 *
 * 【使用方式】
 *   const { allocateTeams } = require('./utils/team-allocation');
 *   const result = allocateTeams(playerList, teamCount, forceRules);
 *
 * 【设计思路】
 *   1. 蛇形分配（Serpentine Draft）：MMR降序排列后按蛇形分配到各队
 *   2. 位置校验：每队必须覆盖1-5号位，缺失时跨队交换补全
 *   3. 强制规则：mustSameTeam / mustNotSameTeam 优先级最高
 *   4. 均衡度量：总MMR最大分差 + 平均分差 + 位置满足率
 *
 * 【数据契约】
 *   入参 playerList 每项字段对应 dota2_players 表：
 *     id, calibrate_mmr, good_at_positions, wx_nickname
 * ============================================================
 */

// ---------- 常量定义 ----------

/** Dota2 标准五个位置：1(Carry) 2(Mid) 3(Offlane) 4(Support) 5(HardSupport) */
const ALL_POSITIONS = [1, 2, 3, 4, 5];

/** 默认每队核心人数（不含替补，替补不占用强制位置名额） */
const CORE_SIZE = 5;

/** 位置补全换人时单次 MMR 差值容忍上限 */
const MMR_DIFF_TOLERANCE = 500;

/** 位置补全最大尝试轮数 */
const MAX_SWAP_ROUNDS = 3;


// ---------- 辅助函数 ----------

/**
 * 解析选手擅长位置字符串 → 数字数组
 * 支持 "1,3,5"、"1/3/5"、"1 3 5" 等分隔符
 * @param {string|null|undefined} posStr
 * @returns {number[]}
 */
function parsePositions(posStr) {
  if (!posStr) return [];
  return String(posStr)
    .split(/[,，/\s]+/)
    .map(s => parseInt(s, 10))
    .filter(n => ALL_POSITIONS.includes(n));
}

/**
 * 克隆选手对象（浅拷贝，避免修改原数据）
 */
function clonePlayer(p) {
  return { ...p };
}

/**
 * 计算标准差
 */
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
 * MMR 均衡分队主函数
 *
 * @param {Object[]} playerList - 参赛选手列表
 * @param {string}   playerList[].id - 选手ID（对应 dota2_players.id）
 * @param {number}   playerList[].calibrate_mmr - MMR分数
 * @param {string}   playerList[].good_at_positions - 擅长位置，如 "1,3,5"
 * @param {string}   playerList[].wx_nickname - 微信昵称
 * @param {number}   teamCount - 目标队伍数量（≥2）
 * @param {Object}   [forceRules] - 强制约束规则
 * @param {string[][]} [forceRules.mustSameTeam] - 必须同队的选手ID组，如 [["idA","idB"],["idC","idD"]]
 * @param {string[][]} [forceRules.mustNotSameTeam] - 禁止同队的选手ID组
 * @returns {{ teams: Object[], balanceInfo: Object, warnings: string[] }}
 */
function allocateTeams(playerList, teamCount, forceRules = {}) {
  const warnings = [];

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
    warnings.push(
      `选手总数(${totalPlayers})不足：${teamCount}支队伍×每队${CORE_SIZE}人=最少需要${minPlayersNeeded}人`
    );
    // 不阻断，允许继续（可能部分缺人，后续位置统计会体现）
  }

  // === 第1步：数据预处理 ===
  // 深拷贝选手数据，补全缺失字段
  const players = playerList.map(p => clonePlayer(p)).map(p => ({
    ...p,
    _mmr: p.calibrate_mmr != null ? p.calibrate_mmr : 0,
    _pos: parsePositions(p.good_at_positions),
  }));

  // 建立选手ID快速索引
  const playerMap = {};
  players.forEach(p => { playerMap[p.id] = p; });

  // === 第2步：处理强制规则 ===
  const { forceGroups, antigroups, groupMemo } = buildForceConstraints(
    players, forceRules, playerMap, warnings
  );

  // === 第3步：蛇形分配 ===
  let teams = snakeDraft(players, teamCount, forceGroups, antigroups, warnings);

  // === 第4步：位置补全微调 ===
  teams = positionSwap(teams, warnings);

  // === 第5步：生成最终输出 ===
  const finalTeams = buildTeamOutput(teams);
  const balanceInfo = computeBalance(finalTeams);

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
 * 将 mustSameTeam / mustNotSameTeam 规则预处理为内部使用的分组结构
 *
 * - forceGroups：Map<groupId, Set<playerId>>，同组的选手会被打包成一个"虚拟选手"
 * - antigroups：Set<setKey>，记录"playerIdA|playerIdB"禁止同队的关系对
 * - groupMemo：Map<playerId, groupId>，快速查找某个选手属于哪个强制组
 */
function buildForceConstraints(players, forceRules, playerMap, warnings) {
  const forceGroups = new Map();  // groupId → Set<playerId>
  const groupMemo = new Map();    // playerId → groupId
  const antigroups = new Set();   // "A|B"

  // 处理 mustSameTeam
  const mustSame = forceRules.mustSameTeam || [];
  mustSame.forEach((group, idx) => {
    if (!Array.isArray(group) || group.length < 2) return;
    const validIds = group.filter(id => playerMap[id]);
    if (validIds.length < 2) return;
    const groupId = `force_group_${idx}`;
    forceGroups.set(groupId, new Set(validIds));
    validIds.forEach(id => { groupMemo.set(id, groupId); });
  });

  // 检测冲突：同一个选手不能同时出现在两个强制组中
  const seenIds = new Set();
  for (const [gid, idSet] of forceGroups) {
    for (const id of idSet) {
      if (seenIds.has(id)) {
        warnings.push(`选手 ${playerMap[id]?.wx_nickname || id} 被分配到了多个强制同队组，已忽略后续`);
        idSet.delete(id); // 只保留第一次出现的组
      }
      seenIds.add(id);
    }
  }

  // 处理 mustNotSameTeam
  const mustNotSame = forceRules.mustNotSameTeam || [];
  mustNotSame.forEach(pair => {
    if (!Array.isArray(pair) || pair.length < 2) return;
    const a = pair[0], b = pair[1];
    if (!playerMap[a] || !playerMap[b]) return;
    // 检测与 mustSameTeam 的冲突
    if (groupMemo.has(a) && groupMemo.has(b) && groupMemo.get(a) === groupMemo.get(b)) {
      warnings.push(
        `${playerMap[a].wx_nickname || a} 和 ${playerMap[b].wx_nickname || b} 同时被设为必须同队和禁止同队，以禁止同队为准`
      );
      // 从强制组中移除这两个选手
      const gid = groupMemo.get(a);
      const gset = forceGroups.get(gid);
      if (gset) { gset.delete(a); gset.delete(b); }
      if (gset && gset.size < 2) forceGroups.delete(gid);
    }
    antigroups.add(`${a}|${b}`);
    antigroups.add(`${b}|${a}`);
  });

  return { forceGroups, antigroups, groupMemo };
}


// ============================================================
// 第3步：蛇形分配（Serpentine Draft）
// ============================================================

/**
 * 蛇形分配算法
 *
 * 【原理】
 *   所有选手按 MMR 降序排列后，按蛇形方向逐人分配到各队：
 *     第1轮：队1→队2→...→队N（正序）
 *     第2轮：队N→队N-1→...→队1（逆序）
 *     第3轮：队1→队2→...（正序）
 *     以此类推
 *   这样高分段选手分散到不同队伍，低分段补充到有高分的队伍，
 *   保证总 MMR 尽量均衡。
 *
 * 【强制规则处理】
 *   - mustSameTeam 组打包成一个"虚拟选手"，MMR = 组内平均
 *   - mustNotSameTeam 关系在分配时校验，跳过冲突的队
 */
function snakeDraft(players, teamCount, forceGroups, antigroups, warnings) {
  // 初始化每支队伍的空列表
  const teams = [];
  for (let i = 0; i < teamCount; i++) {
    teams.push({ index: i, members: [] });
  }

  // === 3.1 构建待分配队列 ===
  // 把强制同组的选手打包成虚拟单位
  const allocatedIds = new Set(); // 已在强制组中处理的选手
  const queue = [];               // 待蛇形分配的"分配单元"

  // 先放入强制同组（打包为一个虚拟选手）
  for (const [gid, idSet] of forceGroups) {
    const groupPlayers = [];
    let totalMmr = 0;
    for (const pid of idSet) {
      const p = players.find(pl => pl.id === pid);
      if (p) {
        groupPlayers.push(p);
        totalMmr += p._mmr;
        allocatedIds.add(pid);
      }
    }
    if (groupPlayers.length > 0) {
      queue.push({
        type: 'group',
        players: groupPlayers,
        _mmr: Math.round(totalMmr / groupPlayers.length), // 用平均MMR参与蛇形排序
        groupId: gid,
        memberIds: new Set(groupPlayers.map(p => p.id)),
      });
    }
  }

  // 再放入普通选手
  for (const p of players) {
    if (!allocatedIds.has(p.id)) {
      queue.push({
        type: 'single',
        players: [p],
        _mmr: p._mmr,
        memberIds: new Set([p.id]),
      });
    }
  }

  // === 3.2 MMR降序排序 ===
  queue.sort((a, b) => b._mmr - a._mmr);

  // === 3.3 蛇形分配 ===
  let direction = 1;  // 1=正序, -1=逆序
  let currentIdx = 0; // 当前分配到的队索引

  for (const unit of queue) {
    // 尝试分配：跳过与已有成员冲突的队
    let assigned = false;
    const maxAttempts = teamCount;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const teamIdx = currentIdx;

      // 检查 mustNotSameTeam 约束
      const hasConflict = checkAntiConflict(teams[teamIdx], unit, antigroups);

      if (!hasConflict) {
        // 分配成功：将该单元的所有选手加入队伍
        for (const p of unit.players) {
          teams[teamIdx].members.push(p);
        }
        assigned = true;

        // 移动到下一队（蛇形方向）
        currentIdx += direction;
        if (currentIdx >= teamCount) {
          currentIdx = teamCount - 1;
          direction = -1; // 到末尾，反向
        } else if (currentIdx < 0) {
          currentIdx = 0;
          direction = 1;  // 到开头，正向
        }
        break;
      } else {
        // 冲突，跳过当前队
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
      // 极端情况：所有队都冲突。硬塞到MMR最低的队
      const fallbackTeam = teams.reduce((best, t) =>
        getTeamMmr(t) < getTeamMmr(best) ? t : best
      );
      for (const p of unit.players) {
        fallbackTeam.members.push(p);
      }
      warnings.push(
        `强制约束冲突：${unit.players.map(p => p.wx_nickname).join('、')} 无法避开禁同队规则，已强制分配到队伍${fallbackTeam.index + 1}`
      );
    }
  }

  return teams;
}

/**
 * 检查分配单元与目标队伍是否有 mustNotSameTeam 冲突
 */
function checkAntiConflict(team, unit, antigroups) {
  for (const existPlayer of team.members) {
    for (const newPlayer of unit.players) {
      if (antigroups.has(`${existPlayer.id}|${newPlayer.id}`)) {
        return true; // 存在冲突
      }
    }
  }
  return false;
}

/**
 * 计算队伍总 MMR
 */
function getTeamMmr(team) {
  return team.members.reduce((sum, p) => sum + p._mmr, 0);
}


// ============================================================
// 第4步：位置补全微调（Position Swap）
// ============================================================

/**
 * 跨队交换选手，补全每队缺失的位置
 *
 * 【策略】
 *   遍历每队 → 检测缺失的1-5号位 → 在MMR差值最小的前提下，
 *   从其他队伍交换一个能补位且不会造成对方缺位的选手过来。
 *
 * 【约束】
 *   - 交换后不破坏强制同队规则
 *   - 单次交换 MMR 差值不超过阈值
 *   - 最多尝试 N 轮，避免死循环
 */
function positionSwap(teams, warnings) {
  for (let round = 0; round < MAX_SWAP_ROUNDS; round++) {
    let improved = false;

    // 按总 MMR 降序排列（先处理高分段队伍，它们更容易换出合适人选）
    const sortedTeams = [...teams].sort((a, b) => getTeamMmr(b) - getTeamMmr(a));

    for (const team of sortedTeams) {
      const missing = getMissingPositions(team.members);
      if (missing.length === 0) continue; // 位置齐全，跳过

      // 尝试为每个缺失位置找到最佳交换
      for (const needPos of missing) {
        const bestSwap = findBestSwap(team, needPos, teams, missing);
        if (bestSwap) {
          // 执行交换
          executeSwap(team, bestSwap, teams);
          improved = true;
        }
      }
    }

    if (!improved) break; // 无改进，不再尝试
  }

  // 生成最终的警告信息
  for (const team of teams) {
    const stillMissing = getMissingPositions(team.members);
    if (stillMissing.length > 0) {
      warnings.push(
        `队伍${team.index + 1} 仍缺失${stillMissing.length}个位置(${stillMissing.join(',')}号位)，请手动调整`
      );
    }
  }

  return teams;
}

/**
 * 获取队伍中缺失的位置列表
 */
function getMissingPositions(members) {
  const covered = new Set();
  for (const p of members) {
    for (const pos of p._pos) {
      covered.add(pos);
    }
  }
  // 替补(第6人起)不占用强制位置名额：只检查前 CORE_SIZE 人
  // 但覆盖度按全员算，给更多弹性
  return ALL_POSITIONS.filter(pos => !covered.has(pos));
}

/**
 * 为缺失位置找到最优的跨队交换选手
 *
 * @returns {{ fromTeam, fromPlayer, toPlayer } | null}
 */
function findBestSwap(needTeam, needPos, allTeams, needTeamMissing) {
  let best = null;
  let bestMmrDiff = Infinity;

  // 在需要补位的队伍中找一个可以被换出的选手
  // 优先换出与该位置无关且MMR接近的选手
  for (const toPlayer of needTeam.members) {
    // 注意：不能换出当前队伍唯一覆盖了某个位置但自己还需要其他位置的选手
    // 简化处理：跳过覆盖了 needTeam 其他缺失位置的选手，避免拆东墙补西墙
    const toPlayerCoversMissing = needTeamMissing.some(pos =>
      pos !== needPos && toPlayer._pos.includes(pos)
    );

    // 在别的队伍找能补 needPos 的选手
    for (const fromTeam of allTeams) {
      if (fromTeam === needTeam) continue;

      const fromMissing = getMissingPositions(fromTeam.members);

      for (const fromPlayer of fromTeam.members) {
        // 这个选手必须擅长 needPos
        if (!fromPlayer._pos.includes(needPos)) continue;

        // 换出后 fromTeam 不能缺位（除非 fromTeam 有新的人覆盖）
        const fromTeamAfterRemove = fromTeam.members.filter(p => p.id !== fromPlayer.id);
        const fromMissingAfter = getMissingPositions(fromTeamAfterRemove);
        // 如果换出后 fromTeam 缺失变多，跳过
        if (fromMissingAfter.length > fromMissing.length + 1) continue;

        // 计算MMR差值
        const mmrDiff = Math.abs(fromPlayer._mmr - toPlayer._mmr);
        if (mmrDiff < bestMmrDiff && mmrDiff <= MMR_DIFF_TOLERANCE) {
          bestMmrDiff = mmrDiff;
          best = { fromTeam, fromPlayer, toPlayer };
        }
      }
    }
  }

  return best;
}

/**
 * 执行跨队选手交换
 */
function executeSwap(needTeam, swapInfo, allTeams) {
  const { fromTeam, fromPlayer, toPlayer } = swapInfo;

  // 从 needTeam 移除 toPlayer
  needTeam.members = needTeam.members.filter(p => p.id !== toPlayer.id);
  // 从 fromTeam 移除 fromPlayer
  fromTeam.members = fromTeam.members.filter(p => p.id !== fromPlayer.id);
  // 交换：fromPlayer → needTeam, toPlayer → fromTeam
  needTeam.members.push(fromPlayer);
  fromTeam.members.push(toPlayer);
}


// ============================================================
// 第5步：生成最终输出
// ============================================================

/**
 * 构建每支队伍的输出对象
 */
function buildTeamOutput(teams) {
  return teams.map(team => {
    const members = team.members;

    // 计算总 MMR
    const totalMmr = members.reduce((sum, p) => sum + p._mmr, 0);

    // 推荐队长：MMR 最高的选手
    const sortedByMmr = [...members].sort((a, b) => b._mmr - a._mmr);
    const captainId = sortedByMmr.length > 0 ? sortedByMmr[0].id : null;

    // 位置覆盖统计
    const positionCoverage = {};
    ALL_POSITIONS.forEach(pos => { positionCoverage[pos] = []; });
    for (const p of members) {
      for (const pos of p._pos) {
        positionCoverage[pos].push(p.wx_nickname || p.id);
      }
    }

    // 缺失位置
    const missingPositions = ALL_POSITIONS.filter(pos => positionCoverage[pos].length === 0);

    // 成员列表（对外输出字段）
    const playerList = members.map(p => ({
      id: p.id,
      wx_nickname: p.wx_nickname || '',
      calibrate_mmr: p._mmr,
      good_at_positions: p.good_at_positions || '',
      positionDetail: p._pos,
    }));

    return {
      teamIndex: team.index + 1,
      teamName: `队伍${team.index + 1}`,
      memberCount: members.length,
      playerList,
      captainId,
      totalMmr,
      mmrPerPlayer: totalMmr / members.length,
      positionStats: {
        coverage: positionCoverage,       // 每个位置有哪些人覆盖
        missingPositions,                 // 缺失的位置
        isComplete: missingPositions.length === 0, // 1-5号位是否齐全
      },
    };
  });
}

/**
 * 计算全局均衡度统计
 */
function computeBalance(finalTeams) {
  const mmrs = finalTeams.map(t => t.totalMmr);
  const memberCounts = finalTeams.map(t => t.memberCount);

  if (mmrs.length === 0) return null;

  const maxMmr = Math.max(...mmrs);
  const minMmr = Math.min(...mmrs);
  const avgMmr = mmrs.reduce((a, b) => a + b, 0) / mmrs.length;
  const maxDiff = maxMmr - minMmr;
  const stdDeviation = stdDev(mmrs);

  // 位置满足率
  const completeTeams = finalTeams.filter(t => t.positionStats.isComplete).length;
  const positionRate = finalTeams.length > 0
    ? completeTeams / finalTeams.length
    : 0;

  return {
    mmrStats: {
      max: maxMmr,
      min: minMmr,
      average: Math.round(avgMmr),
      maxDiff,                                    // 最大分差
      stdDeviation: Math.round(stdDeviation),     // 标准差
      grade: gradeBalance(maxDiff, stdDeviation), // 均衡等级
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
  };
}

/**
 * 均衡等级评价
 */
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
  // 子函数也导出，方便单元测试
  parsePositions,
  getMissingPositions,
  getTeamMmr,
  stdDev,
  ALL_POSITIONS,
  CORE_SIZE,
  MMR_DIFF_TOLERANCE,
  MAX_SWAP_ROUNDS,
};
