const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event, context) => {
  const { action, data, playerId } = event
  const wxContext = cloud.getWXContext()
  const currentOpenId = wxContext.OPENID

  switch (action) {
    case 'add':
      return await addPlayer(data, currentOpenId)
    case 'update':
      return await updatePlayer(playerId, data, currentOpenId)
    case 'delete':
      return await deletePlayer(playerId, currentOpenId)
    case 'batchDelete':
      return await batchDeletePlayers(event.ids, currentOpenId)
    default:
      return { success: false, message: '未知操作' }
  }
}

// 获取用户角色，集合不存在时返回 'user'
async function getUserRole(openid) {
  try {
    const res = await db.collection('dota2_users').where({ openid }).get()
    if (res.data.length > 0) {
      return { role: res.data[0].role, nickName: res.data[0].nickName || '' }
    }
  } catch (err) {
    if (err.errCode === -502005) { /* 集合不存在 */ }
  }
  return { role: 'user', nickName: '' }
}

// 检查权限：返回 { allowed, role, nickName, reason }
// admin/super_admin → 全部允许
// 普通用户 → 只能改自己昵称匹配的选手，且不能改 wxNickname 和 calibrateRankName
async function checkUpdatePermission(openid, playerId, updateFields) {
  const user = await getUserRole(openid)
  if (user.role === 'super_admin' || user.role === 'admin') {
    return { allowed: true, role: user.role, nickName: user.nickName }
  }

  // 普通用户：必须有昵称
  if (!user.nickName) {
    return { allowed: false, reason: '请先设置昵称' }
  }

  // 查找选手
  try {
    const res = await db.collection('dota2_players').doc(playerId).get()
    if (!res.data) {
      return { allowed: false, reason: '选手不存在' }
    }
    // 昵称必须匹配
    if (res.data.wxNickname !== user.nickName) {
      return { allowed: false, reason: '只能编辑自己的选手信息' }
    }
    // 普通用户不能改 wxNickname、calibrateRankName、calibrateRankStar、calibrateRankLabel、calibrateRankSort
    for (const key in updateFields) {
      if (key === 'wxNickname' || key === 'calibrateRankName' || key === 'calibrateRankStar'
        || key === 'calibrateRankLabel' || key === 'calibrateRankSort') {
        return { allowed: false, reason: '无权修改微信群昵称或核定段位，请联系管理员' }
      }
    }
    return { allowed: true, role: 'user', nickName: user.nickName }
  } catch (err) {
    if (err.errCode === -502005) {
      return { allowed: false, reason: '选手不存在' }
    }
    throw err
  }
}

// 新增选手（仅 admin/super_admin 可操作）
// 同一微信昵称视为同一选手，存在则更新，不存在则新增
async function addPlayer(data, openid) {
  const user = await getUserRole(openid)
  if (user.role !== 'super_admin' && user.role !== 'admin') {
    return { success: false, message: '仅管理员可添加选手' }
  }

  if (!data.wxNickname) {
    return { success: false, message: '微信群昵称必填' }
  }
  if (!data.gameId) {
    return { success: false, message: 'Dota2游戏昵称必填' }
  }

  const record = {
    avatarUrl: data.avatarUrl || '',
    wxNickname: data.wxNickname,
    steamId: data.steamId || '',
    gameId: data.gameId,
    calibrateRankName: data.calibrateRankName || '',
    calibrateRankStar: Number(data.calibrateRankStar) || 0,
    calibrateRankLabel: data.calibrateRankLabel || '',
    calibrateRankSort: Number(data.calibrateRankSort) || 0,
    goodAtPositions: data.goodAtPositions || [],
    signupPosition: data.signupPosition || [],
    updatedAt: Date.now()
  }

  try {
    // 1. 按 wxNickname 查找已有记录 → 存在则原地更新（保留 _id 和 createdAt）
    const nickRes = await db.collection('dota2_players').where({ wxNickname: data.wxNickname }).get()
    if (nickRes.data.length > 0) {
      const existingId = nickRes.data[0]._id
      await db.collection('dota2_players').doc(existingId).update({ data: record })
      return { success: true, _id: existingId, updated: 1, action: 'updated' }
    }

    // 2. 按 steamId 查找（如果提供）→ 存在则原地更新（处理用户改昵称的情况）
    if (data.steamId) {
      const steamRes = await db.collection('dota2_players').where({ steamId: data.steamId }).get()
      if (steamRes.data.length > 0) {
        const existingId = steamRes.data[0]._id
        await db.collection('dota2_players').doc(existingId).update({ data: record })
        return { success: true, _id: existingId, updated: 1, action: 'updated' }
      }
    }

    // 3. 全新记录 → 新增
    record.createdAt = Date.now()
    const res = await db.collection('dota2_players').add({ data: record })
    return { success: true, _id: res._id, updated: 0, action: 'created' }
  } catch (err) {
    return { success: false, message: err.message }
  }
}

// 更新选手（权限分级）
async function updatePlayer(playerId, data, openid) {
  if (!playerId) {
    return { success: false, message: '缺少选手ID' }
  }

  // 权限检查
  const perm = await checkUpdatePermission(openid, playerId, data)
  if (!perm.allowed) {
    return { success: false, message: perm.reason }
  }

  const updateData = { updatedAt: Date.now() }
  const allowedFields = ['avatarUrl', 'wxNickname', 'steamId', 'gameId', 'calibrateRankName', 'calibrateRankStar', 'calibrateRankLabel', 'calibrateRankSort', 'goodAtPositions', 'signupPosition']
  for (const field of allowedFields) {
    if (data[field] !== undefined) {
      if (field === 'calibrateRankStar') {
        updateData[field] = Number(data[field]) || 0
      } else {
        updateData[field] = data[field]
      }
    }
  }

  try {
    await db.collection('dota2_players').doc(playerId).update({ data: updateData })
    return { success: true }
  } catch (err) {
    return { success: false, message: err.message }
  }
}

// 删除选手（仅 admin/super_admin 可操作）
async function deletePlayer(playerId, openid) {
  if (!playerId) {
    return { success: false, message: '缺少选手ID' }
  }

  const user = await getUserRole(openid)
  if (user.role !== 'super_admin' && user.role !== 'admin') {
    return { success: false, message: '仅管理员可删除选手' }
  }

  try {
    await db.collection('dota2_players').doc(playerId).remove()
    return { success: true }
  } catch (err) {
    return { success: false, message: err.message }
  }
}

// 批量删除选手（仅 admin/super_admin 可操作）
async function batchDeletePlayers(ids, openid) {
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return { success: false, message: '缺少选手ID列表' }
  }

  const user = await getUserRole(openid)
  if (user.role !== 'super_admin' && user.role !== 'admin') {
    return { success: false, message: '仅管理员可批量删除选手' }
  }

  let deleted = 0
  let failed = 0
  try {
    // 分批并行删除（每批20条，避免并发过高）
    const batchSize = 20
    for (let offset = 0; offset < ids.length; offset += batchSize) {
      const batch = ids.slice(offset, offset + batchSize)
      const tasks = batch.map(id => {
        return db.collection('dota2_players').doc(id).remove()
          .then(() => { deleted++ })
          .catch(err => {
            failed++
            console.error('删除失败:', id, err.message)
          })
      })
      await Promise.all(tasks)
    }
    return { success: true, deleted: deleted, failed: failed }
  } catch (err) {
    return { success: false, message: err.message }
  }
}
