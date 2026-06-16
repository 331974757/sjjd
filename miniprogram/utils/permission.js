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

// ============================================================
// 【第9轮新增】赛事状态常量和操作权限映射
// ============================================================

/**
 * 赛事状态枚举
 */
const EVENT_STATUS = {
  CREATING: 0,        // 创建中
  SIGNUP_OPEN: 1,     // 报名中
  SIGNUP_CLOSED: 2,   // 报名截止
  TEAMS_LOCKED: 3,    // 分组锁定
  BATTLE_ACTIVE: 4,   // 对战中
  FINISHED: 5,        // 已归档(event_status)
};

/**
 * 赛事状态中文名
 */
const STATUS_NAMES = {
  0: '创建中',
  1: '报名中',
  2: '报名截止',
  3: '分组锁定',
  4: '对战中',
  5: '已归档',
};

/**
 * 【前端按钮灰化核心】根据赛事状态 + 用户角色 + 是否归档，判断某操作是否允许
 *
 * @param {string} action  - 操作类型标识（见下方 ACTION_KEY 映射）
 * @param {Object} options - { eventStatus, isArchived, userRole }
 * @returns {{ allowed: boolean, disabled: boolean, reason: string }}
 *
 * 使用示例：
 *   const btn = perm.checkAction('signup', { eventStatus: 1, isArchived: 0, userRole: 'user' })
 *   // { allowed: true, disabled: false, reason: '' }
 *
 *   const btn2 = perm.checkAction('signup', { eventStatus: 4, isArchived: 0, userRole: 'user' })
 *   // { allowed: false, disabled: true, reason: '当前赛事对战中，无法报名' }
 *
 * 前端按钮用法：
 *   <button disabled="{{!signupBtn.allowed}}">{{signupBtn.allowed ? '我要报名' : signupBtn.reason}}</button>
 */
function checkAction(action, options) {
  // 【修复】避免对象解构触发 babel runtime，改用显式取值
  var opts = options || {};
  var eventStatus = opts.eventStatus;
  var isArchived = opts.isArchived;
  var userRole = opts.userRole;
  var status = parseInt(eventStatus);
  var archived = parseInt(isArchived) || 0;
  var role = userRole || 'user';
  var isAdmin = role === 'admin' || role === 'super_admin';
  var isSuperAdmin = role === 'super_admin';

  // 通用规则：已归档 → 所有写操作禁止
  if (archived === 1 && action !== 'view' && action !== 'view_detail') {
    return { allowed: false, disabled: true, reason: '赛事已归档' };
  }

  switch (action) {
    // ─── 查看类：所有角色全部允许 ───
    case 'view':
    case 'view_detail':
    case 'view_signups':
    case 'view_teams':
    case 'view_matches':
    case 'view_ranks':
      return { allowed: true, disabled: false, reason: '' };

    // ─── 自主报名 ───
    case 'signup':
    case 'cancel_signup':
      if (status !== EVENT_STATUS.SIGNUP_OPEN) {
        return { allowed: false, disabled: true, reason: STATUS_NAMES[status] ? `「${STATUS_NAMES[status]}」阶段不可报名` : '非报名阶段' };
      }
      return { allowed: true, disabled: false, reason: '' };

    // ─── 管理员：编辑赛事基本信息 ───
    case 'edit_event':
      if (!isAdmin) return { allowed: false, disabled: true, reason: '仅管理员可编辑' };
      return { allowed: true, disabled: false, reason: '' };

    // ─── 管理员：状态变更 ───
    case 'change_status':
      if (!isAdmin) return { allowed: false, disabled: true, reason: '仅管理员可操作' };
      if (status >= EVENT_STATUS.FINISHED) {
        return { allowed: false, disabled: true, reason: '赛事已结束，无法变更状态' };
      }
      return { allowed: true, disabled: false, reason: '' };

    // ─── 管理员：报名管理 ───
    case 'manage_signups':
      if (!isAdmin) return { allowed: false, disabled: true, reason: '仅管理员可操作' };
      if (status >= EVENT_STATUS.BATTLE_ACTIVE) {
        return { allowed: false, disabled: true, reason: `${STATUS_NAMES[status]}阶段不可管理报名` };
      }
      return { allowed: true, disabled: false, reason: '' };

    // ─── 管理员：队伍编组 ───
    case 'manage_teams':
      if (!isAdmin) return { allowed: false, disabled: true, reason: '仅管理员可操作' };
      if (status < EVENT_STATUS.SIGNUP_CLOSED) {
        return { allowed: false, disabled: true, reason: '报名尚未截止，无法编组' };
      }
      if (status >= EVENT_STATUS.BATTLE_ACTIVE) {
        return { allowed: false, disabled: true, reason: '队伍已锁定，不可编辑' };
      }
      return { allowed: true, disabled: false, reason: '' };

    // ─── 管理员：锁定队伍开赛 ───
    case 'lock_teams':
      if (!isAdmin) return { allowed: false, disabled: true, reason: '仅管理员可操作' };
      if (status !== EVENT_STATUS.TEAMS_LOCKED) {
        return { allowed: false, disabled: true, reason: '仅在「分组锁定」状态可开赛' };
      }
      return { allowed: true, disabled: false, reason: '' };

    // ─── 管理员：对战管理 ───
    case 'manage_matches':
    case 'judge':
    case 'next_round':
    case 'end_battle':
      if (!isAdmin) return { allowed: false, disabled: true, reason: '仅管理员可操作' };
      if (status !== EVENT_STATUS.BATTLE_ACTIVE) {
        return { allowed: false, disabled: true, reason: `「${STATUS_NAMES[status] || '未知'}」阶段不可操作对战` };
      }
      return { allowed: true, disabled: false, reason: '' };

    // ─── 管理员：名次设定 ───
    case 'manage_ranks':
      if (!isAdmin) return { allowed: false, disabled: true, reason: '仅管理员可操作' };
      if (status !== EVENT_STATUS.FINISHED) {
        return { allowed: false, disabled: true, reason: `赛事尚未结束，不可设定名次` };
      }
      return { allowed: true, disabled: false, reason: '' };

    // ─── 管理员：归档操作 ───
    case 'archive_event':
      if (!isAdmin) return { allowed: false, disabled: true, reason: '仅管理员可操作' };
      if (status !== EVENT_STATUS.FINISHED) {
        return { allowed: false, disabled: true, reason: '赛事尚未结束，不可归档' };
      }
      return { allowed: true, disabled: false, reason: '' };

    // ─── 超管独有：删除赛事 ───
    case 'delete_event':
      if (!isSuperAdmin) return { allowed: false, disabled: true, reason: '仅超级管理员可删除赛事' };
      return { allowed: true, disabled: false, reason: '' };

    // ─── 超管独有：管理员账号管理 ───
    case 'manage_admins':
      if (!isSuperAdmin) return { allowed: false, disabled: true, reason: '仅超级管理员可管理管理员账号' };
      return { allowed: true, disabled: false, reason: '' };

    // ─── 超管独有：系统配置 ───
    case 'system_config':
      if (!isSuperAdmin) return { allowed: false, disabled: true, reason: '仅超级管理员可修改系统配置' };
      return { allowed: true, disabled: false, reason: '' };

    default:
      return { allowed: false, disabled: true, reason: '未知操作类型' };
  }
}

/**
 * 【便捷方法】批量检查多个操作，返回键值对
 *
 * @returns {Object} { signup: {allowed, disabled, reason}, manage_teams: {...}, ... }
 *
 * 页面中使用：
 *   onLoad() {
 *     const btns = perm.checkActions(['signup', 'manage_teams', 'archive_event'], {
 *       eventStatus: 1, isArchived: 0, userRole: 'user'
 *     })
 *     this.setData({ btns })
 *   }
 */
function checkActions(actions, options) {
  var result = {};
  // 【修复】避免 for...of 触发 babel runtime 依赖，改用普通 for 循环
  for (var i = 0; i < actions.length; i++) {
    var action = actions[i];
    result[action] = checkAction(action, options);
  }
  return result;
}

/**
 * 【WXML模板辅助】从 checkActions 结果中取 allowed 和 reason 展平
 * 避免模板中出现 {{btns.signup.allowed}} 这样的深层访问
 */
function flattenActions(actionsResult) {
  var flat = {};
  // 【修复】用 Object.keys + 普通 for 循环替代 Object.entries + for...of，避免 babel runtime 依赖
  var keys = Object.keys(actionsResult);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var val = actionsResult[key];
    flat[key + '_allowed'] = val.allowed;
    flat[key + '_reason'] = val.reason;
    flat[key + '_disabled'] = val.disabled;
  }
  return flat;
}

module.exports = {
  getRole: getRole,
  getRoleSync: getRoleSync,
  isAdmin: isAdmin,
  isSuperAdmin: isSuperAdmin,
  getNickName: getNickName,
  saveNickName: saveNickName,
  setCache: setCache,
  // 【第9轮新增】
  EVENT_STATUS,
  STATUS_NAMES,
  checkAction,
  checkActions,
  flattenActions,
}
