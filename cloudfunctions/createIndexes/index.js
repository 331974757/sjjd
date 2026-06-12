const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 通用创建索引辅助函数
async function tryCreateIndex(collectionName, keys, indexName) {
  try {
    await db.collection(collectionName).createIndex({ keys, name: indexName })
    return { collection: collectionName, index: indexName, status: 'ok' }
  } catch (err) {
    // 索引已存在 → 忽略
    if (err.errCode === -1 && err.errMsg && err.errMsg.indexOf('already exists') !== -1) {
      return { collection: collectionName, index: indexName, status: 'already_exists' }
    }
    return { collection: collectionName, index: indexName, status: 'failed', error: err.message || err.errMsg || '' }
  }
}

exports.main = async (event, context) => {
  const results = []

  // === dota2_players 集合 ===

  // 1. createdAt 降序索引（用于首页排序、加载更多）
  results.push(await tryCreateIndex('dota2_players', { createdAt: -1 }, 'idx_createdAt'))

  // 2. wxNickname 升序索引（addPlayer 去重、batchImport 批量查重）
  results.push(await tryCreateIndex('dota2_players', { wxNickname: 1 }, 'idx_wxNickname'))

  // 3. steamId 升序索引（去重匹配）
  results.push(await tryCreateIndex('dota2_players', { steamId: 1 }, 'idx_steamId'))

  // 4. calibrateRankSort 降序索引（首页段位排序）
  results.push(await tryCreateIndex('dota2_players', { calibrateRankSort: -1 }, 'idx_calibrateRankSort'))

  // === dota2_users 集合 ===

  // 4. openid 升序索引（checkRole/getRole 查询——最频繁）
  results.push(await tryCreateIndex('dota2_users', { openid: 1 }, 'idx_openid'))

  // 5. role 升序索引（listAdmins/用户列表——管理功能）
  results.push(await tryCreateIndex('dota2_users', { role: 1 }, 'idx_role'))

  return { success: true, results }
}
