-- ============================================================
-- Dota2 赛事业务数据表 - 完整建表语句
-- 数据库: dota2
-- 字符集: utf8mb4 / 引擎: InnoDB
-- 与现有 dota2_players / dota2_users 字段风格完全对齐
-- ============================================================

USE dota2;

-- -----------------------------------------------------------
-- 1. 赛事主表
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `dota2_events` (
  `event_id`      varchar(64)   NOT NULL COMMENT '赛事ID（主键）',
  `event_name`    varchar(200)  DEFAULT NULL COMMENT '赛事名称',
  `event_desc`    text          DEFAULT NULL COMMENT '赛事简介',
  `creator_id`    varchar(64)   DEFAULT NULL COMMENT '创建管理员ID（关联dota2_users.id）',
  `event_status`  tinyint       DEFAULT NULL COMMENT '赛事状态：0创建中/1报名中/2报名截止/3分组锁定/4对战中/5已结束',
  `start_time`    bigint        DEFAULT NULL COMMENT '赛事开始时间戳',
  `signup_limit`  int           DEFAULT NULL COMMENT '报名人数上限（NULL=无限制）',
  `is_archived`   tinyint       DEFAULT 0 COMMENT '归档标记：0未归档/1已归档',
  `created_at`    bigint        DEFAULT NULL COMMENT '创建时间戳',
  `updated_at`    bigint        DEFAULT NULL COMMENT '更新时间戳',
  `ended_by`      varchar(64)   DEFAULT NULL COMMENT '结束比赛操作人',
  `ended_at`      bigint        DEFAULT NULL COMMENT '结束比赛时间戳',
  `archived_by`   varchar(64)   DEFAULT NULL COMMENT '归档操作人',
  `archived_at`   bigint        DEFAULT NULL COMMENT '归档时间戳',
  PRIMARY KEY (`event_id`),
  INDEX `idx_events_status` (`event_status`),
  INDEX `idx_events_archived` (`is_archived`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='赛事主表';


-- -----------------------------------------------------------
-- 2. 参赛报名表
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `dota2_event_signup` (
  `signup_id`     varchar(64)   NOT NULL COMMENT '报名记录ID（主键）',
  `event_id`      varchar(64)   DEFAULT NULL COMMENT '赛事ID（关联dota2_events.event_id）',
  `player_id`     varchar(64)   DEFAULT NULL COMMENT '选手ID（关联dota2_players.id）',
  `signup_type`   tinyint       DEFAULT NULL COMMENT '报名方式：0自主报名/1管理员添加',
  `signup_status` tinyint       DEFAULT 1 COMMENT '报名状态：0无效/1有效',
  `created_at`    bigint        DEFAULT NULL COMMENT '报名时间戳',
  `operator_id`   varchar(64)   DEFAULT NULL COMMENT '操作人ID（管理员代报时记录）',
  PRIMARY KEY (`signup_id`),
  UNIQUE INDEX `uk_event_player` (`event_id`, `player_id`),
  INDEX `idx_signup_event` (`event_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='参赛报名表';


-- -----------------------------------------------------------
-- 3. 队伍表
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `dota2_event_teams` (
  `team_id`       varchar(64)   NOT NULL COMMENT '队伍ID（主键）',
  `event_id`      varchar(64)   DEFAULT NULL COMMENT '赛事ID（关联dota2_events.event_id）',
  `team_name`     varchar(100)  DEFAULT NULL COMMENT '队伍名称',
  `captain_id`    varchar(64)   DEFAULT NULL COMMENT '队长ID（关联dota2_players.id）',
  `player_ids`    text          DEFAULT NULL COMMENT '队员ID列表（JSON数组，存储选手ID字符串）',
  `total_mmr`     int           DEFAULT NULL COMMENT '队伍总MMR分值',
  `avg_mmr`       int           DEFAULT 0 COMMENT '队伍均分（总分÷人数）',
  `created_at`    bigint        DEFAULT NULL COMMENT '创建时间戳',
  `updated_at`    bigint        DEFAULT NULL COMMENT '更新时间戳',
  PRIMARY KEY (`team_id`),
  INDEX `idx_teams_event` (`event_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='队伍表';


-- -----------------------------------------------------------
-- 4. 对战轮次表
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `dota2_event_matches` (
  `match_id`      varchar(64)   NOT NULL COMMENT '对战记录ID（主键）',
  `event_id`      varchar(64)   DEFAULT NULL COMMENT '赛事ID（关联dota2_events.event_id）',
  `round_num`     int           DEFAULT NULL COMMENT '轮次序号（从1开始递增）',
  `team_a_id`     varchar(64)   DEFAULT NULL COMMENT 'A队ID（关联dota2_event_teams.team_id）',
  `team_b_id`     varchar(64)   DEFAULT NULL COMMENT 'B队ID（关联dota2_event_teams.team_id）',
  `winner_id`     varchar(64)   DEFAULT NULL COMMENT '胜方队伍ID（关联dota2_event_teams.team_id）',
  `match_status`  tinyint       DEFAULT 0 COMMENT '对战状态：0未开始/1进行中/2已结束',
  `judge_id`      varchar(64)   DEFAULT NULL COMMENT '判定管理员ID（关联dota2_users.id）',
  `judge_time`    bigint        DEFAULT NULL COMMENT '判定时间戳',
  `battle_image`  varchar(500)  DEFAULT NULL COMMENT '对战结果图片URL',
  `created_at`    bigint        DEFAULT NULL COMMENT '创建时间戳',
  PRIMARY KEY (`match_id`),
  INDEX `idx_matches_event_round` (`event_id`, `round_num`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='对战轮次表';


-- -----------------------------------------------------------
-- 5. 赛事名次归档表
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `dota2_event_ranks` (
  `rank_id`       varchar(64)   NOT NULL COMMENT '名次记录ID（主键）',
  `event_id`      varchar(64)   DEFAULT NULL COMMENT '赛事ID（关联dota2_events.event_id）',
  `rank_num`      int           DEFAULT NULL COMMENT '排名序号（1/2/3...）',
  `team_id`       varchar(64)   DEFAULT NULL COMMENT '对应队伍ID（关联dota2_event_teams.team_id）',
  `operator_id`   varchar(64)   DEFAULT NULL COMMENT '操作人ID（关联dota2_users.id）',
  `created_at`    bigint        DEFAULT NULL COMMENT '创建时间戳',
  PRIMARY KEY (`rank_id`),
  UNIQUE INDEX `uk_event_rank` (`event_id`, `rank_num`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='赛事名次归档表';


-- -----------------------------------------------------------
-- 6. 赛事章程表
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `dota2_event_rules` (
  `rule_id`       varchar(64)   NOT NULL COMMENT '章程ID（主键）',
  `event_id`      varchar(64)   DEFAULT NULL COMMENT '关联赛事ID（NULL表示通用章程，不绑定单场赛事）',
  `rule_title`    varchar(200)  DEFAULT NULL COMMENT '章程标题',
  `rule_content`  text          DEFAULT NULL COMMENT '章程内容（富文本）',
  `version`       int           DEFAULT NULL COMMENT '版本号',
  `rule_status`   tinyint       DEFAULT 0 COMMENT '状态：0草稿/1已发布',
  `creator_id`    varchar(64)   DEFAULT NULL COMMENT '创建人ID（关联dota2_users.id）',
  `created_at`    bigint        DEFAULT NULL COMMENT '创建时间戳',
  `updated_at`    bigint        DEFAULT NULL COMMENT '更新时间戳',
  PRIMARY KEY (`rule_id`),
  INDEX `idx_rules_event` (`event_id`),
  INDEX `idx_rules_status` (`rule_status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='赛事章程表';
