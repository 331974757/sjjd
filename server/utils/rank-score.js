/**
 * ============================================================
 * DOTA2 段位分值计算工具 - 独立模块
 * ============================================================
 *
 * 将选手段位信息（calibrate_rank_sort + calibrate_rank_star）
 *         转换为可用于分队均衡计算的等效 MMR 分数。
 *
 * 使用方式
 *   const { getScore, RANK_CONFIG } = require('./utils/rank-score');
 *   const score = getScore(player);  // player 需含 calibrate_rank_sort, calibrate_rank_star, calibrate_mmr
 *
 * 设计说明
 *   - 内置 2026 年 DOTA2 官方段位体系配置表，后续若版本数值调整，只需修改本文件
 *   - 分值计算优先级：实际 MMR > 0 直接用 → 否则按段位+星级公式推算等效分
 *   - 冠绝一世（rank_sort=8/80）无星级概念，默认取 6000 分
 *   - 兼容两种 calibrate_rank_sort 编码：
 *     ① Dota 2 原生 medal 编码（11-15=先锋, 21-25=卫士, ..., 61-65=万古, 71-75=超凡, 80=冠绝）
 *     ② 已映射的 1-8 简化值（向后兼容）
 * ============================================================
 */

// ============================================================
// 段位配置表（单一数据源，方便后续调整参数）
// ============================================================
//
// 字段说明：
//   rankSort     - 段位排序值 calibrate_rank_sort，1-8
//   rankName     - 中文段位名称
//   baseScore    - 该段位起始分（1星0分的等效分）
//   maxScore     - 该段位理论最高分（5星对应分）
//   stepPerStar  - 每颗星对应的分值步长
//   hasStars     - 是否有星级概念（冠绝一世无星级）
//   starRange    - 星级范围 [min, max]
//
const RANK_CONFIG = Object.freeze({
  1: {
    rankSort: 1,
    rankName: '先锋',
    baseScore: 0,
    maxScore: 899,
    stepPerStar: 180,
    hasStars: true,
    starRange: [1, 5],
  },
  2: {
    rankSort: 2,
    rankName: '卫士',
    baseScore: 900,
    maxScore: 1749,
    stepPerStar: 170,
    hasStars: true,
    starRange: [1, 5],
  },
  3: {
    rankSort: 3,
    rankName: '中军',
    baseScore: 1750,
    maxScore: 2649,
    stepPerStar: 180,
    hasStars: true,
    starRange: [1, 5],
  },
  4: {
    rankSort: 4,
    rankName: '统帅',
    baseScore: 2650,
    maxScore: 3349,
    stepPerStar: 140,
    hasStars: true,
    starRange: [1, 5],
  },
  5: {
    rankSort: 5,
    rankName: '传奇',
    baseScore: 3350,
    maxScore: 4249,
    stepPerStar: 180,
    hasStars: true,
    starRange: [1, 5],
  },
  6: {
    rankSort: 6,
    rankName: '万古流芳',
    baseScore: 4250,
    maxScore: 5099,
    stepPerStar: 170,
    hasStars: true,
    starRange: [1, 5],
  },
  7: {
    rankSort: 7,
    rankName: '超凡入圣',
    baseScore: 5100,
    maxScore: 5999,
    stepPerStar: 180,
    hasStars: true,
    starRange: [1, 5],
  },
  8: {
    rankSort: 8,
    rankName: '冠绝一世',
    // 冠绝一世不使用公式推算，默认返回 6000
    // 若选手有实际 MMR，直接使用实际 MMR（见 getScore 优先级）
    defaultScore: 6000,
    hasStars: false,
    starRange: null,
  },
});

// 分数计算

/**
 * 获取单个选手用于分队计算的分值
 *
 * 优先级
 *   1. calibrate_mmr > 0 → 直接使用
 *   2. calibrate_mmr 为空/等于0 → 按 rank_sort + rank_star 公式推算等效分
 *
 * 公式
 *   先锋~超凡入圣（rank_sort 1-7）：
 *     equivalentMMR = RANK_CONFIG[rankSort].baseScore + (star - 1) × stepPerStar
 *
 *   冠绝一世（rank_sort 8）：
 *     equivalentMMR = RANK_CONFIG[8].defaultScore（固定 6000）
 *
 * @param {Object} player - 选手对象，需含以下字段
 * @param {number|null|undefined} player.calibrate_mmr   - 实际 MMR（优先使用）
 * @param {number}               player.calibrate_rank_sort - 段位排序值 1-8
 * @param {number}               player.calibrate_rank_star - 星级 1-5
 * @returns {{ score: number, source: string }}
 *          score  - 最终分值
 *          source - 分值来源标记：'actual_mmr' | 'rank_formula' | 'default_immortal' | 'unknown'
 */
function getScore(player) {
  // --- 优先级1：有实际 MMR，直接用 ---
  if (player.calibrate_mmr != null && player.calibrate_mmr > 0) {
    return {
      score: Number(player.calibrate_mmr),
      source: 'actual_mmr',
    };
  }

  // --- 优先级2：按段位+星级推算 ---
  const rawSort = Number(player.calibrate_rank_sort) || 0;
  const star = Number(player.calibrate_rank_star) || 0;

  // 未定段/无有效段位 → 0 分
  if (rawSort <= 0) {
    return { score: 0, source: 'unranked' };
  }

  // 把 Dota 2 原生 medal 编码（11-80）映射到内部 1-8 段位体系
  const { rankSort, effectiveStar } = mapRawRankSort(rawSort, star);

  // 冠绝一世（rank_sort=8）：无星级，固定 6000
  if (rankSort === 8) {
    return {
      score: RANK_CONFIG[8].defaultScore,
      source: 'default_immortal',
    };
  }

  // 普通段位（rank_sort 1-7）
  const rankCfg = RANK_CONFIG[rankSort];
  if (rankCfg && rankCfg.hasStars) {
    // 确保星级在有效范围内 [1, 5]
    const clampedStar = Math.max(1, Math.min(5, effectiveStar || 1));
    const equivalentScore = rankCfg.baseScore + (clampedStar - 1) * rankCfg.stepPerStar;
    // 有段位的最低 100 分
    return {
      score: Math.max(equivalentScore, 100),
      source: 'rank_formula',
    };
  }

  // 兜底：rankSort 不在 1-8 范围内 → 0 分（视为未定段）
  return { score: 0, source: 'unranked' };
}

/**
 * 将 Dota 2 原生 medal tier 编码（11-80）映射到内部 1-8 段位体系
 *
 * Dota 2 编码规则：
 *   11~15 = 先锋 1~5星      21~25 = 卫士 1~5星
 *   31~35 = 中军 1~5星      41~45 = 统帅 1~5星
 *   51~55 = 传奇 1~5星      61~65 = 万古流芳 1~5星
 *   71~75 = 超凡入圣 1~5星   80 = 冠绝一世（无星级）
 *
 * 同时兼容已映射的 1-8 直接输入（向后兼容）
 */
function mapRawRankSort(rawSort, starFromDb) {
  // 已经是 1-8 映射值 → 直接使用
  if (rawSort >= 1 && rawSort <= 8) {
    return { rankSort: rawSort, effectiveStar: starFromDb || 0 };
  }

  const tier = Math.floor(rawSort / 10); // 十位数 = 段位

  // 冠绝一世
  if (rawSort === 80) {
    return { rankSort: 8, effectiveStar: 0 };
  }

  // 有效段位范围：1-7，星级取 calibrate_rank_star 字段（不从 rawSort 个位数推导）
  const star = starFromDb || 0;
  if (tier >= 1 && tier <= 7) {
    return { rankSort: tier, effectiveStar: star };
  }

  // 无法映射 → 0
  return { rankSort: 0, effectiveStar: 0 };
}

/**
 * 批量计算选手分值并附加到选手对象上
 *
 * @param {Object[]} players - 选手列表
 * @returns {Object[]} 原选手对象，附加 _score 和 _scoreSource 字段
 */
function attachScores(players) {
  return players.map(p => {
    const { score, source } = getScore(p);
    return { ...p, _score: score, _scoreSource: source };
  });
}

/**
 * 获取段位配置表（只读），供外部展示或调试使用
 * 返回的配置已预处理成适合前端展示的格式
 */
function getRankConfigTable() {
  return Object.values(RANK_CONFIG).map(cfg => ({
    rankSort: cfg.rankSort,
    rankName: cfg.rankName,
    baseScore: cfg.baseScore ?? null,
    maxScore: cfg.maxScore ?? null,
    stepPerStar: cfg.stepPerStar ?? null,
    hasStars: cfg.hasStars,
    starRange: cfg.starRange,
    scoreRange: cfg.hasStars
      ? `${cfg.baseScore} ~ ${cfg.maxScore}`
      : `${cfg.defaultScore}+ (无星级)`,
  }));
}

// 导出

module.exports = {
  RANK_CONFIG,
  RANK_OPTIONS: Object.values(RANK_CONFIG).map(c => c.rankName),
  getScore,
  attachScores,
  getRankConfigTable,
};
