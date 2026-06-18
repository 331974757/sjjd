-- ======================================================
-- 选手软删除字段
-- 删除选手后仅标记为 deleted，保留所有报名记录
-- ======================================================
USE dota2;

ALTER TABLE dota2_players 
  ADD COLUMN status VARCHAR(20) DEFAULT 'active' 
  COMMENT '选手状态: active=正常 / deleted=已删除（保留参赛记录）';

ALTER TABLE dota2_players 
  ADD INDEX idx_players_status (status);

-- 将现有所有选手设为 active
UPDATE dota2_players SET status = 'active' WHERE status IS NULL;
