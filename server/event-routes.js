/**
 * ============================================================
 * 赛事业务模块 - 路由入口（模块化拆分版）
 * 包含：赛事管理 / 报名管理 / 队伍管理 / 对战管理 / 名次管理 / 赛事章程
 *
 * 子路由文件：
 *   routes/event-helpers.js  — 公共工具函数工厂
 *   routes/event-crud.js     — 赛事 CRUD（创建/列表/详情/编辑/状态/删除）
 *   routes/event-signups.js  — 报名管理（个人报名/管理员添加/批量导入/删除）
 *   routes/event-teams.js    — 队伍管理（批量创建/分配编队/锁定/记分板/编辑/删除）
 *   routes/event-matches.js  — 对战管理（列表/轮次/生成/开启/编辑/判定/图片/删除/下一轮/结束/归档）
 *   routes/event-ranks.js    — 名次管理（排行榜/批量保存/设置/更新/删除）
 *   routes/event-rules.js    — 章程管理（列表/详情/赛事章程/创建/编辑/删除）
 *
 * 与现有 server/index.js 共享：pool 连接池 / assertAdmin / getCallerRole
 * ============================================================
 */

const createHelpers = require('./routes/event-helpers');
const auth = require('./utils/auth');

module.exports = function (app, deps) {
  const h = createHelpers({ ...deps, auth });

  require('./routes/event-crud')(app, h);
  require('./routes/event-signups')(app, h);
  require('./routes/event-teams')(app, h);
  require('./routes/event-matches')(app, h);
  require('./routes/event-ranks')(app, h);
  require('./routes/event-rules')(app, h);
};
