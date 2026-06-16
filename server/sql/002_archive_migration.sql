-- ============================================================
-- 第7轮：赛事归档 + 名次设定 数据库迁移
-- 新增字段：ended_by(结束操作人) / ended_at(结束时间)
--            archived_by(归档操作人) / archived_at(归档时间)
-- 执行方式：mysql -u dota2 -p dota2 < this_file.sql
-- 兼容：MySQL 5.7+ （不使用 IF NOT EXISTS）
-- ============================================================

USE dota2;

-- 1. 为 dota2_events 表新增结束与归档操作人/时间字段
-- 使用存储过程安全添加：字段存在则跳过，不存在则添加
DROP PROCEDURE IF EXISTS add_column_if_not_exists;

DELIMITER //
CREATE PROCEDURE add_column_if_not_exists(
  IN tbl_name VARCHAR(128),
  IN col_name VARCHAR(128),
  IN col_def  TEXT
)
BEGIN
  SET @cnt = 0;
  SELECT COUNT(*) INTO @cnt
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = 'dota2'
      AND TABLE_NAME = tbl_name
      AND COLUMN_NAME = col_name;
  IF @cnt = 0 THEN
    SET @sql = CONCAT('ALTER TABLE `', tbl_name, '` ADD COLUMN `', col_name, '` ', col_def);
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END//
DELIMITER ;

CALL add_column_if_not_exists('dota2_events', 'ended_by',    "varchar(64) DEFAULT NULL COMMENT '结束比赛操作人openid'");
CALL add_column_if_not_exists('dota2_events', 'ended_at',    "bigint DEFAULT NULL COMMENT '结束比赛时间戳'");
CALL add_column_if_not_exists('dota2_events', 'archived_by', "varchar(64) DEFAULT NULL COMMENT '归档操作人openid'");
CALL add_column_if_not_exists('dota2_events', 'archived_at', "bigint DEFAULT NULL COMMENT '归档时间戳'");

DROP PROCEDURE IF EXISTS add_column_if_not_exists;

-- 2. 历史数据补丁：如果之前通过 end-battle 设置了 is_archived=1，
--    则视作同时完成了「结束」和「归档」（旧流程兼容）
UPDATE `dota2_events`
  SET `ended_at` = `updated_at`,
      `archived_at` = `updated_at`
  WHERE `is_archived` = 1 AND `ended_at` IS NULL;

-- 3. 确保 dota2_event_ranks 表的联合唯一索引存在（防同名次重复）
-- 先检查索引是否存在
SET @idx_exists = 0;
SELECT COUNT(*) INTO @idx_exists
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = 'dota2'
    AND TABLE_NAME = 'dota2_event_ranks'
    AND INDEX_NAME = 'idx_ranks_event_rank';

SET @sql_idx = IF(@idx_exists = 0,
  'CREATE UNIQUE INDEX idx_ranks_event_rank ON dota2_event_ranks (event_id, rank_num)',
  'SELECT ''索引 idx_ranks_event_rank 已存在，跳过创建'' AS msg'
);

PREPARE stmt FROM @sql_idx;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
