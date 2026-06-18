const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 集合不存在时的错误码
function isCollectionNotExist(err) {
  return err && (err.errCode === -502005 || (err.message && err.message.indexOf('not exist') !== -1))
}

exports.main = async (event, context) => {
  const { action, targetOpenId } = event
  const wxContext = cloud.getWXContext()
  const currentOpenId = wxContext.OPENID

  switch (action) {
    case 'checkRole':          return await checkRole(currentOpenId, event.nickName)
    case 'setAdmin':           return await setAdmin(currentOpenId, targetOpenId)
    case 'removeAdmin':        return await removeAdmin(currentOpenId, targetOpenId)
    case 'setSuperAdmin':      return await setSuperAdmin(currentOpenId, targetOpenId)
    case 'removeSuperAdmin':   return await removeSuperAdmin(currentOpenId, targetOpenId)
    case 'listAdmins':         return await listAdmins(currentOpenId)
    case 'listUsers':          return await listUsers(currentOpenId)
    case 'resetNickCount':     return await resetNickCount(currentOpenId, targetOpenId)
    case 'getSuperAdminInfo':  return await getSuperAdminInfo()
    default:                   return { success: false, message: '未知操作' }
  }
}

// safeGet: 查询集合，集合不存在时返回空数组
async function safeGet(collectionName, query) {
  try {
    return await db.collection(collectionName).where(query).get()
  } catch (err) {
    if (isCollectionNotExist(err)) {
      return { data: [] }
    }
    throw err
  }
}

// safeCount: 计数，集合不存在时返回 0
async function safeCount(collectionName, query) {
  try {
    if (query) {
      return await db.collection(collectionName).where(query).count()
    }
    return await db.collection(collectionName).count()
  } catch (err) {
    if (isCollectionNotExist(err)) {
      return { total: 0 }
    }
    throw err
  }
}

// safeAdd: 添加数据（自动建集合）
const _createdCollections = {}
async function ensureCollection(name) {
  if (_createdCollections[name]) return
  try {
    await db.createCollection(name)
  } catch (e) {
    // 已经存在则忽略
  }
  _createdCollections[name] = true
}
async function safeAdd(collectionName, data) {
  try {
    return await db.collection(collectionName).add({ data })
  } catch (err) {
    if (isCollectionNotExist(err)) {
      await ensureCollection(collectionName)
      return await db.collection(collectionName).add({ data })
    }
    throw err
  }
}

// 自动登记当前用户 + 查询角色（幂等/upsert 语义，同一 openid 不会重复创建）
async function checkRole(openid, nickName) {
  try {
    const res = await safeGet('dota2_users', { openid })
    if (res.data.length > 0) {
      const user = res.data[0]
      // 传了昵称且与当前不同，检查修改次数限制（最多3次，首次设置不算修改）
      if (nickName && user.nickName !== nickName) {
        const changeCount = user.nickChangeCount || 0
        const isManager = user.role === 'super_admin' || user.role === 'admin'
        // 管理员/超管不限次数；普通用户首次设置不计次数，最多改3次
        if (!isManager && user.nickName && changeCount >= 3) {
          return { success: false, message: '已超过3次修改限制，请联系超级管理员', nickName: user.nickName, role: user.role, nickChangeCount: changeCount }
        }
        // 检查昵称是否已被其他用户占用
        const dupCheck = await safeGet('dota2_users', { nickName: nickName, openid: db.command.neq(openid) })
        if (dupCheck.data.length > 0) {
          return { success: false, message: '该昵称已被其他用户使用', nickName: user.nickName, role: user.role, nickChangeCount: changeCount }
        }
        const updateData = { nickName, updatedAt: Date.now() }
        // 管理员/超管不计数；普通用户只有已有昵称时的修改才计数
        if (!isManager && user.nickName) {
          updateData.nickChangeCount = changeCount + 1
          user.nickChangeCount = changeCount + 1
        }
        await db.collection('dota2_users').doc(user._id).update({ data: updateData })
        user.nickName = nickName
      }
      // 老用户：如果系统中无 super_admin，自动提拔为 super_admin
      if (user.role !== 'super_admin') {
        const saCount = await safeCount('dota2_users', { role: 'super_admin' })
        if (saCount.total === 0) {
          await db.collection('dota2_users').doc(user._id).update({
            data: { role: 'super_admin', updatedAt: Date.now() }
          })
          return { success: true, role: 'super_admin', nickName: user.nickName, nickChangeCount: user.nickChangeCount || 0 }
        }
      }
      return { success: true, role: user.role, nickName: user.nickName, nickChangeCount: user.nickChangeCount || 0 }
    }

    // 新用户：检查是否是第一个用户，第一个自动设为 super_admin
    const countRes = await safeCount('dota2_users')
    const isFirst = countRes.total === 0
    const role = isFirst ? 'super_admin' : 'user'

    // 插入新记录
    // 由于前端 permission.js 已通过 _rolePromise 对同一客户端做 Promise 去重，
    // 同一 openid 的并发插入仅可能在极端情况下发生（同一用户多设备同时首次打开），
    // 此处插入后做一次复查：如有重复则保留首条、删除多余、返回首条
    await safeAdd('dota2_users', {
      openid,
      role,
      nickName: nickName || '',
      createdAt: Date.now()
    })

    const checkAgain = await safeGet('dota2_users', { openid })
    if (checkAgain.data.length > 1) {
      // 存在并发写入的重复记录，保留第一条，删除其余
      // 按 createdAt 排序，相同时间戳用 _id 做稳定排序
      const sorted = checkAgain.data.sort((a, b) => {
        const diff = (a.createdAt || 0) - (b.createdAt || 0)
        if (diff !== 0) return diff
        return (a._id || '') < (b._id || '') ? -1 : 1
      })
      const keep = sorted[0]
      for (let i = 1; i < sorted.length; i++) {
        try {
          await db.collection('dota2_users').doc(sorted[i]._id).remove()
        } catch (e) {}
      }
      return { success: true, role: keep.role, nickName: keep.nickName, isFirst: false }
    }

    // 如果并发导致 isFirst 误判（countRes.total===0 但实际已有记录），修正 role
    // 正常情况这里 checkAgain.data.length === 1，返回即可
    return { success: true, role, isFirst }
  } catch (err) {
    return { success: false, message: err.message }
  }
}

// 设置管理员（仅超级管理员可操作）
async function setAdmin(currentOpenId, targetOpenId) {
  if (!targetOpenId) {
    return { success: false, message: '缺少目标用户 openid' }
  }

  const self = await safeGet('dota2_users', { openid: currentOpenId })
  if (self.data.length === 0 || self.data[0].role !== 'super_admin') {
    return { success: false, message: '无权限，仅超级管理员可操作' }
  }

  try {
    const target = await db.collection('dota2_users').where({ openid: targetOpenId }).get()
    if (target.data.length === 0) {
      return { success: false, message: '目标用户未注册' }
    }
    if (target.data[0].role === 'super_admin') {
      return { success: false, message: '不能修改超级管理员' }
    }
    await db.collection('dota2_users').doc(target.data[0]._id).update({
      data: { role: 'admin', updatedAt: Date.now() }
    })
    return { success: true, message: '已设为管理员' }
  } catch (err) {
    return { success: false, message: err.message }
  }
}

// 移除管理员（仅超级管理员可操作）
async function removeAdmin(currentOpenId, targetOpenId) {
  if (!targetOpenId) {
    return { success: false, message: '缺少目标用户 openid' }
  }
  if (currentOpenId === targetOpenId) {
    return { success: false, message: '不能取消自己的权限' }
  }

  const self = await safeGet('dota2_users', { openid: currentOpenId })
  if (self.data.length === 0 || self.data[0].role !== 'super_admin') {
    return { success: false, message: '无权限，仅超级管理员可操作' }
  }

  try {
    const target = await db.collection('dota2_users').where({ openid: targetOpenId }).get()
    if (target.data.length === 0) {
      return { success: false, message: '目标用户未注册' }
    }
    if (target.data[0].role === 'super_admin') {
      return { success: false, message: '不能取消超级管理员权限' }
    }
    await db.collection('dota2_users').doc(target.data[0]._id).update({
      data: { role: 'user', updatedAt: Date.now() }
    })
    return { success: true, message: '已取消管理员权限' }
  } catch (err) {
    return { success: false, message: err.message }
  }
}

// 设为超级管理员（仅超级管理员可将他人设为超管）
async function setSuperAdmin(currentOpenId, targetOpenId) {
  if (!targetOpenId) {
    return { success: false, message: '缺少目标用户 openid' }
  }
  if (currentOpenId === targetOpenId) {
    return { success: false, message: '不能对自己操作' }
  }

  const self = await safeGet('dota2_users', { openid: currentOpenId })
  if (self.data.length === 0 || self.data[0].role !== 'super_admin') {
    return { success: false, message: '无权限，仅超级管理员可操作' }
  }

  try {
    const target = await db.collection('dota2_users').where({ openid: targetOpenId }).get()
    if (target.data.length === 0) {
      return { success: false, message: '目标用户未注册' }
    }
    if (target.data[0].role === 'super_admin') {
      return { success: false, message: '该用户已是超级管理员' }
    }
    await db.collection('dota2_users').doc(target.data[0]._id).update({
      data: { role: 'super_admin', nickChangeCount: -1, updatedAt: Date.now() }
    })
    return { success: true, message: '已设为超级管理员' }
  } catch (err) {
    return { success: false, message: err.message }
  }
}

// 取消超级管理员（仅超级管理员可操作，不能取消自己）
async function removeSuperAdmin(currentOpenId, targetOpenId) {
  if (!targetOpenId) {
    return { success: false, message: '缺少目标用户 openid' }
  }
  if (currentOpenId === targetOpenId) {
    return { success: false, message: '不能取消自己的超级管理员权限' }
  }

  const self = await safeGet('dota2_users', { openid: currentOpenId })
  if (self.data.length === 0 || self.data[0].role !== 'super_admin') {
    return { success: false, message: '无权限，仅超级管理员可操作' }
  }

  try {
    const target = await db.collection('dota2_users').where({ openid: targetOpenId }).get()
    if (target.data.length === 0) {
      return { success: false, message: '目标用户未注册' }
    }
    if (target.data[0].role !== 'super_admin') {
      return { success: false, message: '该用户不是超级管理员' }
    }
    // 降级为普通用户时，重置昵称修改次数为0（恢复3次修改额度）
    const resetData = { role: 'user', updatedAt: Date.now() }
    if (target.data[0].nickChangeCount < 0) {
      resetData.nickChangeCount = 0
    }
    await db.collection('dota2_users').doc(target.data[0]._id).update({ data: resetData })
    return { success: true, message: '已取消超级管理员权限，昵称修改次数已重置' }
  } catch (err) {
    return { success: false, message: err.message }
  }
}

// 获取所有用户列表（超管和管理员都可以看）
async function listUsers(currentOpenId) {
  const self = await safeGet('dota2_users', { openid: currentOpenId })
  if (self.data.length === 0 || (self.data[0].role !== 'super_admin' && self.data[0].role !== 'admin')) {
    return { success: false, message: '无权限' }
  }

  try {
    const res = await db.collection('dota2_users')
      .orderBy('createdAt', 'desc')
      .get()
    return { success: true, data: res.data }
  } catch (err) {
    return { success: false, message: err.message }
  }
}

// 重置昵称修改次数（仅超级管理员可操作）
async function resetNickCount(currentOpenId, targetOpenId) {
  if (!targetOpenId) {
    return { success: false, message: '缺少目标用户 openid' }
  }
  const self = await safeGet('dota2_users', { openid: currentOpenId })
  if (self.data.length === 0 || self.data[0].role !== 'super_admin') {
    return { success: false, message: '无权限，仅超级管理员可操作' }
  }
  try {
    const target = await db.collection('dota2_users').where({ openid: targetOpenId }).get()
    if (target.data.length === 0) {
      return { success: false, message: '目标用户未注册' }
    }
    const targetRole = target.data[0].role
    if (targetRole === 'super_admin' || targetRole === 'admin') {
      return { success: false, message: '管理员/超管不需要重置昵称修改次数' }
    }
    await db.collection('dota2_users').doc(target.data[0]._id).update({
      data: { nickChangeCount: 0, updatedAt: Date.now() }
    })
    return { success: true, message: '已重置昵称修改次数', nickChangeCount: 0 }
  } catch (err) {
    return { success: false, message: err.message }
  }
}

// 公开查询管理员+超管昵称（无需登录态，任何人均可查）
async function getSuperAdminInfo() {
  try {
    const res = await safeGet('dota2_users', {
      role: db.command.in(['super_admin', 'admin'])
    })
    if (res.data.length === 0) {
      return { success: true, data: [] }
    }
    // 超管排前面
    res.data.sort((a, b) => {
      if (a.role === 'super_admin' && b.role !== 'super_admin') return -1
      if (a.role !== 'super_admin' && b.role === 'super_admin') return 1
      return 0
    })
    const list = res.data.map(u => {
      return { nickName: u.nickName || '未设置昵称', openid: u.openid, role: u.role }
    })
    return { success: true, data: list }
  } catch (err) {
    return { success: false, message: err.message }
  }
}

// 获取管理员列表（超管和管理员都可以看）
async function listAdmins(currentOpenId) {
  const self = await safeGet('dota2_users', { openid: currentOpenId })
  if (self.data.length === 0 || (self.data[0].role !== 'super_admin' && self.data[0].role !== 'admin')) {
    return { success: false, message: '无权限' }
  }

  try {
    const res = await db.collection('dota2_users').where({
      role: db.command.in(['super_admin', 'admin'])
    }).get()
    return { success: true, data: res.data }
  } catch (err) {
    if (isCollectionNotExist(err)) {
      return { success: true, data: [] }
    }
    return { success: false, message: err.message }
  }
}
