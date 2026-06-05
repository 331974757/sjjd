const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event, context) => {
  const { action, data, playerId } = event

  switch (action) {
    case 'add':
      return await addPlayer(data)
    case 'update':
      return await updatePlayer(playerId, data)
    case 'delete':
      return await deletePlayer(playerId)
    default:
      return { success: false, message: '未知操作' }
  }
}

// 新增选手（支持重复覆盖：微信群昵称或Steam ID重复时，删除旧记录后新增）
async function addPlayer(data) {
  // 校验必填字段
  if (!data.wxNickname) {
    return { success: false, message: '微信群昵称必填' }
  }
  if (!data.gameId) {
    return { success: false, message: 'Dota2游戏ID必填' }
  }
  if (data.currentMmr === undefined || data.currentMmr === null) {
    return { success: false, message: '当前分数必填' }
  }

  const record = {
    wxNickname: data.wxNickname,
    steamId: data.steamId || '',
    gameId: data.gameId,
    highestMmr: Number(data.highestMmr) || 0,
    currentMmr: Number(data.currentMmr) || 0,
    selfMmr: Number(data.selfMmr) || 0,
    goodAtPositions: data.goodAtPositions || [],
    signupPosition: data.signupPosition || '',
    createdAt: Date.now(),
    updatedAt: Date.now()
  }

  try {
    // 去重查询：按微信群昵称或Steam ID查找已有记录
    const dupConditions = []
    dupConditions.push({ wxNickname: data.wxNickname })
    if (data.steamId) {
      dupConditions.push({ steamId: data.steamId })
    }

    let replacedCount = 0
    for (const cond of dupConditions) {
      const dupRes = await db.collection('dota2_players').where(cond).get()
      for (const doc of dupRes.data) {
        await db.collection('dota2_players').doc(doc._id).remove()
        replacedCount++
      }
    }

    const res = await db.collection('dota2_players').add({ data: record })
    return { success: true, _id: res._id, replaced: replacedCount > 0 ? replacedCount : 0 }
  } catch (err) {
    return { success: false, message: err.message }
  }
}

// 更新选手
async function updatePlayer(playerId, data) {
  if (!playerId) {
    return { success: false, message: '缺少选手ID' }
  }

  const updateData = { updatedAt: Date.now() }

  // 只更新传入的字段
  const allowedFields = ['wxNickname', 'steamId', 'gameId', 'highestMmr', 'currentMmr', 'selfMmr', 'goodAtPositions', 'signupPosition']
  for (const field of allowedFields) {
    if (data[field] !== undefined) {
      if (['highestMmr', 'currentMmr', 'selfMmr'].includes(field)) {
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

// 删除选手
async function deletePlayer(playerId) {
  if (!playerId) {
    return { success: false, message: '缺少选手ID' }
  }

  try {
    await db.collection('dota2_players').doc(playerId).remove()
    return { success: true }
  } catch (err) {
    return { success: false, message: err.message }
  }
}
