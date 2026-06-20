-- ============================================================
-- 为 users / dota2_players 表所有列添加注释
-- 数据库: dota2
-- 说明: 使用 MODIFY COLUMN 语法，保留原有列类型不变
-- ⚠️ SET NAMES utf8mb4 必须放在最前面，否则中文注释会乱码
-- ============================================================

SET NAMES utf8mb4;
USE dota2;

-- -----------------------------------------------------------
-- 1. users 表（用户身份表）
-- -----------------------------------------------------------

ALTER TABLE `users`
  MODIFY COLUMN `id` VARCHAR(64) NOT NULL COMMENT '用户ID（主键，32位hex字符串）';

ALTER TABLE `users`
  MODIFY COLUMN `openid` VARCHAR(64) NULL COMMENT '微信 OpenID（唯一标识）';

ALTER TABLE `users`
  MODIFY COLUMN `role` VARCHAR(20) NULL DEFAULT 'user' COMMENT '角色：user普通用户 / admin管理员 / super_admin超级管理员';

ALTER TABLE `users`
  MODIFY COLUMN `nick_name` VARCHAR(200) NULL DEFAULT NULL COMMENT '用户昵称（与选手 wx_nickname 对应）';

ALTER TABLE `users`
  MODIFY COLUMN `nick_change_count` INT NULL DEFAULT 0 COMMENT '昵称修改次数（普通用户每次修改+1）';

ALTER TABLE `users`
  MODIFY COLUMN `created_at` DATETIME NULL DEFAULT NULL COMMENT '创建时间';

ALTER TABLE `users`
  MODIFY COLUMN `updated_at` DATETIME NULL DEFAULT NULL COMMENT '更新时间';


-- -----------------------------------------------------------
-- 2. dota2_players 表（Dota2选手档案表）
-- -----------------------------------------------------------

ALTER TABLE `dota2_players`
  MODIFY COLUMN `id` VARCHAR(64) NOT NULL COMMENT '选手ID（主键，32位hex字符串）';

ALTER TABLE `dota2_players`
  MODIFY COLUMN `wx_nickname` VARCHAR(200) NULL DEFAULT NULL COMMENT '微信群昵称（唯一，与 users.nick_name 对应）';

ALTER TABLE `dota2_players`
  MODIFY COLUMN `steam_id` VARCHAR(100) NULL DEFAULT NULL COMMENT 'Steam好友代码 / Steam ID';

ALTER TABLE `dota2_players`
  MODIFY COLUMN `game_id` VARCHAR(200) NULL DEFAULT NULL COMMENT '游戏内数字ID';

ALTER TABLE `dota2_players`
  MODIFY COLUMN `calibrate_rank_name` VARCHAR(100) NULL DEFAULT NULL COMMENT '定级段位名称（如：万古流芳、超凡入圣、冠绝一世）';

ALTER TABLE `dota2_players`
  MODIFY COLUMN `calibrate_rank_star` INT NULL DEFAULT 0 COMMENT '定级段位星级（0-5）';

ALTER TABLE `dota2_players`
  MODIFY COLUMN `calibrate_rank_label` VARCHAR(100) NULL DEFAULT NULL COMMENT '定级段位+星级合并标签（如：超凡入圣3星，用于展示）';

ALTER TABLE `dota2_players`
  MODIFY COLUMN `calibrate_rank_sort` INT NULL DEFAULT 0 COMMENT '定级段位排序值（1-8，越大段位越高，用于排序）';

ALTER TABLE `dota2_players`
  MODIFY COLUMN `calibrate_mmr` INT NULL DEFAULT NULL COMMENT '定级MMR值（匹配积分）';

ALTER TABLE `dota2_players`
  MODIFY COLUMN `good_at_positions` VARCHAR(200) NULL DEFAULT NULL COMMENT '擅长位置（逗号分隔，如：1,2,4）';

ALTER TABLE `dota2_players`
  MODIFY COLUMN `signup_position` VARCHAR(200) NULL DEFAULT NULL COMMENT '报名位置（逗号分隔，如：1,3）';

ALTER TABLE `dota2_players`
  MODIFY COLUMN `avatar_url` VARCHAR(500) NULL DEFAULT NULL COMMENT '选手头像URL';

ALTER TABLE `dota2_players`
  MODIFY COLUMN `status` VARCHAR(20) NULL DEFAULT 'active' COMMENT '选手状态：active正常 / deleted已删除（软删除，保留参赛记录）';

ALTER TABLE `dota2_players`
  MODIFY COLUMN `created_at` DATETIME NULL DEFAULT NULL COMMENT '创建时间';

ALTER TABLE `dota2_players`
  MODIFY COLUMN `updated_at` DATETIME NULL DEFAULT NULL COMMENT '更新时间';
