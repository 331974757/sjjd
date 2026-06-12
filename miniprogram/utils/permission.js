// utils/permission.js - 用户角色权限工具

// 全局角色缓存（小程序生命周期内有效）
let roleCache = null
// 正在进行的角色查询 Promise（防止并发重复调用云函数）
let _rolePromise = null
// Storage 缓存 key
const STORAGE_ROLE_KEY = '_perm_role'
const STORAGE_ROLE_TIME_KEY = '_perm_role_time'
// Storage 缓存有效期：30分钟（毫秒）
const STORAGE_TTL = 30 * 60 * 1000

// 读取本地缓存的昵称
function getNickName() {
  try {
    return wx.getStorageSync('user_nickname') || ''
  } catch (e) {
    return ''
  }
}

// 保存昵称到本地
function saveNickName(name) {
  try {
    wx.setStorageSync('user_nickname', name)
  } catch (e) {}
}

// 从 Storage 读取缓存的角色（带 TTL 校验）
function _loadRoleFromStorage() {
  try {
    const role = wx.getStorageSync(STORAGE_ROLE_KEY)
    const time = wx.getStorageSync(STORAGE_ROLE_TIME_KEY) || 0
    if (role && (Date.now() - time) < STORAGE_TTL) {
      return role
    }
  } catch (e) {}
  return null
}

// 保存角色到 Storage
function _saveRoleToStorage(role) {
  try {
    wx.setStorageSync(STORAGE_ROLE_KEY, role)
    wx.setStorageSync(STORAGE_ROLE_TIME_KEY, Date.now())
  } catch (e) {}
}

// 构建 checkRole 请求数据
// 不传 nickName，仅查询角色信息。昵称更新由 dota2 首页 fetchNicknameInfo 统一管理
function buildCheckRoleData() {
  return { action: 'checkRole' }
}

// 同步获取角色（优先内存缓存 → Storage缓存）
function getRoleSync() {
  if (roleCache) return roleCache
  const stored = _loadRoleFromStorage()
  if (stored) {
    roleCache = stored
    return stored
  }
  return null
}

// 静默注册用户（不阻塞，复用 getRole 的 Promise）
function ensureRegistered() {
  try {
    getRole().catch(() => {})
  } catch (e) {}
}

// 等待注册完成（返回结果），复用 getRole 的 Promise，不重复调用云函数
function registerAndWait() {
  return getRole().then((role) => {
    return { success: true, role: role }
  }).catch((err) => {
    console.error('[权限] 注册失败:', err.errMsg || err.message)
    return null
  })
}

// 获取当前用户角色（异步），返回 'admin' | 'user' | 'super_admin'
// 缓存策略：内存缓存 → Storage缓存(30分钟TTL) → 云函数查询
// 多次并发调用只会请求一次云函数（Promise 去重）
function getRole() {
  // 1. 优先使用内存缓存
  if (roleCache) {
    return Promise.resolve(roleCache)
  }

  // 2. 尝试从 Storage 读取（有 TTL 校验）
  const stored = _loadRoleFromStorage()
  if (stored) {
    roleCache = stored
    return Promise.resolve(stored)
  }

  // 3. 复用已有的 Promise，防止同一时刻多次调用云函数
  if (_rolePromise) {
    return _rolePromise
  }

  // 4. 调用云函数查询
  _rolePromise = new Promise((resolve) => {
    try {
      wx.cloud.callFunction({
        name: 'manageUser',
        data: buildCheckRoleData()
      }).then((res) => {
        let role = 'user'
        if (res.result && res.result.role) {
          role = res.result.role
          roleCache = role
          _saveRoleToStorage(role)
        }
        _rolePromise = null
        resolve(role)
      }).catch((err) => {
        console.warn('manageUser 调用失败:', err.errMsg || err.message)
        _rolePromise = null
        resolve('user')
      })
    } catch (e) {
      console.warn('manageUser 调用异常:', e)
      _rolePromise = null
      resolve('user')
    }
  })

  return _rolePromise
}

function isAdmin() {
  return getRole().then((role) => {
    return role === 'admin' || role === 'super_admin'
  })
}

function isAdminSync() {
  const role = getRoleSync()
  return role === 'admin' || role === 'super_admin'
}

function isSuperAdmin() {
  return getRole().then((role) => {
    return role === 'super_admin'
  })
}

function isSuperAdminSync() {
  return getRoleSync() === 'super_admin'
}

// 外部直接注入角色缓存（避免重复调云函数）
function setCache(role) {
  roleCache = role
  _saveRoleToStorage(role)
}

function clearCache() {
  roleCache = null
  _rolePromise = null
}

module.exports = {
  getRole: getRole,
  getRoleSync: getRoleSync,
  isAdmin: isAdmin,
  isAdminSync: isAdminSync,
  isSuperAdmin: isSuperAdmin,
  isSuperAdminSync: isSuperAdminSync,
  ensureRegistered: ensureRegistered,
  registerAndWait: registerAndWait,
  getNickName: getNickName,
  saveNickName: saveNickName,
  setCache: setCache,
  clearCache: clearCache
}
