-- ============================================================
-- 迁移已标记 is_archived=1 的赛事数据到 _his 归档表
-- ============================================================
USE dota2;

-- 迁移事件元数据（显式列名，避免顺序不一致）
INSERT INTO dota2_events_his (event_id, event_name, event_desc, creator_id, event_status, ended_by, ended_at, start_time, signup_limit, is_archived, archived_by, archived_at, created_at, updated_at)
SELECT event_id, event_name, event_desc, creator_id, event_status, ended_by, ended_at, start_time, signup_limit, is_archived, archived_by, archived_at, created_at, updated_at
FROM dota2_events WHERE is_archived=1;

-- 迁移报名数据
INSERT INTO dota2_event_signup_his
SELECT * FROM dota2_event_signup
WHERE event_id IN (SELECT event_id FROM dota2_events WHERE is_archived=1);

-- 迁移队伍数据
INSERT INTO dota2_event_teams_his
SELECT * FROM dota2_event_teams
WHERE event_id IN (SELECT event_id FROM dota2_events WHERE is_archived=1);

-- 迁移对战数据
INSERT INTO dota2_event_matches_his
SELECT * FROM dota2_event_matches
WHERE event_id IN (SELECT event_id FROM dota2_events WHERE is_archived=1);

-- 迁移名次数据
INSERT INTO dota2_event_ranks_his
SELECT * FROM dota2_event_ranks
WHERE event_id IN (SELECT event_id FROM dota2_events WHERE is_archived=1);

-- 清理在线表业务数据（保留 events 元数据）
DELETE FROM dota2_event_signup
WHERE event_id IN (SELECT event_id FROM dota2_events WHERE is_archived=1);

DELETE FROM dota2_event_teams
WHERE event_id IN (SELECT event_id FROM dota2_events WHERE is_archived=1);

DELETE FROM dota2_event_matches
WHERE event_id IN (SELECT event_id FROM dota2_events WHERE is_archived=1);

DELETE FROM dota2_event_ranks
WHERE event_id IN (SELECT event_id FROM dota2_events WHERE is_archived=1);

-- 验证迁移结果
SELECT 'events_his' as tbl, COUNT(*) as cnt FROM dota2_events_his
UNION ALL SELECT 'signup_his', COUNT(*) FROM dota2_event_signup_his
UNION ALL SELECT 'teams_his', COUNT(*) FROM dota2_event_teams_his
UNION ALL SELECT 'matches_his', COUNT(*) FROM dota2_event_matches_his
UNION ALL SELECT 'ranks_his', COUNT(*) FROM dota2_event_ranks_his;
