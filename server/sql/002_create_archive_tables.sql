-- ============================================================
-- Dota2 赛事归档历史表 - 完整建表语句
-- 数据库: dota2
-- 字符集: utf8mb4 / 引擎: InnoDB
-- 
-- 说明: 赛事归档后，所有业务数据迁移到 _his 表
--       主表保留事件元数据(is_archived=1)用于索引
--       历史查询统一走 _his 表，与在线表结构完全一致
-- ============================================================

USE dota2;

-- -----------------------------------------------------------
-- 1. 赛事归档表（列顺序与 dota2_events 完全一致，确保 INSERT...SELECT * 可用）
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `dota2_events_his` (
  `event_id`      varchar(64)   NOT NULL COMMENT '赛事ID（主键）',
  `event_name`    varchar(200)  DEFAULT NULL COMMENT '赛事名称',
  `event_desc`    text          DEFAULT NULL COMMENT '赛事简介',
  `creator_id`    varchar(64)   DEFAULT NULL COMMENT '创建管理员ID',
  `event_status`  tinyint       DEFAULT NULL COMMENT '赛事状态',
  `start_time`    bigint        DEFAULT NULL COMMENT '赛事开始时间戳',
  `signup_limit`  int           DEFAULT NULL COMMENT '报名人数上限',
  `is_archived`   tinyint       DEFAULT 1 COMMENT '归档标记（固定为1）',
  `created_at`    bigint        DEFAULT NULL COMMENT '创建时间戳',
  `updated_at`    bigint        DEFAULT NULL COMMENT '更新时间戳',
  `ended_by`      varchar(64)   DEFAULT NULL COMMENT '结束比赛操作人',
  `ended_at`      bigint        DEFAULT NULL COMMENT '结束比赛时间戳',
  `archived_by`   varchar(64)   DEFAULT NULL COMMENT '归档操作人',
  `archived_at`   bigint        DEFAULT NULL COMMENT '归档时间戳',
  PRIMARY KEY (`event_id`),
  INDEX `idx_events_his_name` (`event_name`),
  INDEX `idx_events_his_archived_at` (`archived_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='赛事归档表';


-- -----------------------------------------------------------
-- 2. 参赛报名归档表
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `dota2_event_signup_his` (
  `signup_id`     varchar(64)   NOT NULL COMMENT '报名记录ID（主键）',
  `event_id`      varchar(64)   DEFAULT NULL COMMENT '赛事ID',
  `player_id`     varchar(64)   DEFAULT NULL COMMENT '选手ID',
  `signup_type`   tinyint       DEFAULT NULL COMMENT '报名方式：0自主报名/1管理员添加',
  `signup_status` tinyint       DEFAULT 1 COMMENT '报名状态：0无效/1有效',
  `created_at`    bigint        DEFAULT NULL COMMENT '报名时间戳',
  `operator_id`   varchar(64)   DEFAULT NULL COMMENT '操作人ID（管理员代报时记录）',
  PRIMARY KEY (`signup_id`),
  INDEX `idx_signup_his_event` (`event_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='参赛报名归档表';


-- -----------------------------------------------------------
-- 3. 队伍归档表
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `dota2_event_teams_his` (
  `team_id`       varchar(64)   NOT NULL COMMENT '队伍ID（主键）',
  `event_id`      varchar(64)   DEFAULT NULL COMMENT '赛事ID',
  `team_name`     varchar(100)  DEFAULT NULL COMMENT '队伍名称',
  `captain_id`    varchar(64)   DEFAULT NULL COMMENT '队长ID',
  `player_ids`    text          DEFAULT NULL COMMENT '队员ID列表（JSON数组）',
  `total_mmr`     int           DEFAULT NULL COMMENT '队伍总MMR分值',
  `avg_mmr`       int           DEFAULT 0 COMMENT '队伍均分',
  `created_at`    bigint        DEFAULT NULL COMMENT '创建时间戳',
  `updated_at`    bigint        DEFAULT NULL COMMENT '更新时间戳',
  PRIMARY KEY (`team_id`),
  INDEX `idx_teams_his_event` (`event_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='队伍归档表';


-- -----------------------------------------------------------
-- 4. 对战轮次归档表
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `dota2_event_matches_his` (
  `match_id`      varchar(64)   NOT NULL COMMENT '对战记录ID（主键）',
  `event_id`      varchar(64)   DEFAULT NULL COMMENT '赛事ID',
  `round_num`     int           DEFAULT NULL COMMENT '轮次序号（从1开始递增）',
  `team_a_id`     varchar(64)   DEFAULT NULL COMMENT 'A队ID',
  `team_b_id`     varchar(64)   DEFAULT NULL COMMENT 'B队ID',
  `winner_id`     varchar(64)   DEFAULT NULL COMMENT '胜方队伍ID',
  `match_status`  tinyint       DEFAULT 0 COMMENT '对战状态：0未开始/1进行中/2已结束',
  `judge_id`      varchar(64)   DEFAULT NULL COMMENT '判定管理员ID',
  `judge_time`    bigint        DEFAULT NULL COMMENT '判定时间戳',
  `battle_image`  varchar(500)  DEFAULT NULL COMMENT '对战结果图片URL',
  `created_at`    bigint        DEFAULT NULL COMMENT '创建时间戳',
  PRIMARY KEY (`match_id`),
  INDEX `idx_matches_his_event` (`event_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='对战轮次归档表';


-- -----------------------------------------------------------
-- 5. 赛事名次归档表
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `dota2_event_ranks_his` (
  `rank_id`       varchar(64)   NOT NULL COMMENT '名次记录ID（主键）',
  `event_id`      varchar(64)   DEFAULT NULL COMMENT '赛事ID',
  `rank_num`      int           DEFAULT NULL COMMENT '排名序号（1/2/3...）',
  `team_id`       varchar(64)   DEFAULT NULL COMMENT '对应队伍ID',
  `operator_id`   varchar(64)   DEFAULT NULL COMMENT '操作人ID',
  `created_at`    bigint        DEFAULT NULL COMMENT '创建时间戳',
  PRIMARY KEY (`rank_id`),
  INDEX `idx_ranks_his_event` (`event_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='赛事名次归档表';
