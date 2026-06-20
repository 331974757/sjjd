/**
 * 共享工具函数
 * 集中定义 genId / safeRollback，避免多份重复代码
 */
const crypto = require('crypto');

/** 安全随机 ID 生成器（32位 hex 字符串） */
function genId() {
  return crypto.randomBytes(16).toString('hex');
}

/** 安全回滚辅助：避免回滚失败掩盖原始错误 */
async function safeRollback(conn, ctx) {
  try { await conn.rollback(); } catch (e) {
    console.error(`[tx:rollback:${ctx}]`, e.message);
  }
}

module.exports = { genId, safeRollback };
