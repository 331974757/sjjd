// utils/permission.js - 用户角色权限工具
const api = require('./api.js')

// 全局角色缓存（小程序生命周期内有效）
let roleCache = null
// 正在进行的角色查询 Promise（防止并发重复调用API）
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

// 获取当前用户角色（异步），返回 'admin' | 'user' | 'super_admin'
// 缓存策略：内存缓存 → Storage缓存(30分钟TTL) → API查询
// 多次并发调用只会请求一次API（Promise 去重）
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

  // 3. 复用已有的 Promise，防止同一时刻多次调用API
  if (_rolePromise) {
    return _rolePromise
  }

  // 4. 调用 ECS API 查询
  _rolePromise = new Promise((resolve) => {
    try {
      api.get('/users/me').then((res) => {
        let role = 'user'
        if (res && res.role) {
          role = res.role
          roleCache = role
          _saveRoleToStorage(role)
        }
        _rolePromise = null
        resolve(role)
      }).catch(() => {
        _rolePromise = null
        resolve('user')
      })
    } catch (e) {
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

function isSuperAdmin() {
  return getRole().then((role) => {
    return role === 'super_admin'
  })
}

// 外部直接注入角色缓存（避免重复调 API）
function setCache(role) {
  roleCache = role
  _saveRoleToStorage(role)
}

module.exports = {
  getRole: getRole,
  getRoleSync: getRoleSync,
  isAdmin: isAdmin,
  isSuperAdmin: isSuperAdmin,
  getNickName: getNickName,
  saveNickName: saveNickName,
  setCache: setCache
}
