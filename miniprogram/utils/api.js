// utils/api.js - ECS REST API 统一请求模块
const API_BASE = 'https://congqin.online/api'

// 缓存 openid 避免每次都调 getApp
let _openidCache = null
let _openidFetched = false  // 标记是否已完成首次获取（防止空串死循环）

async function getOpenId() {
  if (_openidCache) return _openidCache
  if (_openidFetched) return ''  // 已尝试过且结果为空的，不再重试
  try {
    const app = getApp()
    // 如果 globalData.openid 为空，等待 app.getOpenId() 完成
    if (!app.globalData.openid) {
      await app.getOpenId()
    }
    const result = app.globalData.openid || ''
    _openidCache = result
    _openidFetched = true
    return result
  } catch (e) { /* 静默降级 */ }
  _openidFetched = true
  return ''
}

/** 获取 JWT token（优先读缓存） */
function getToken() {
  try {
    const app = getApp()
    if (app && typeof app.getToken === 'function') {
      return app.getToken()
    }
  } catch (_) {}
  return ''
}

async function request(options) {
  const openid = await getOpenId()
  const token = getToken()
  let url = API_BASE + options.url
  const method = (options.method || 'GET').toUpperCase()

  // GET 参数拼接到 URL
  if (method === 'GET' && options.data) {
    const params = Object.keys(options.data).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(options.data[k])).join('&')
    if (params) url += (url.indexOf('?') >= 0 ? '&' : '?') + params
  }

  // body 数据仅用于非 GET
  // 必须显式 JSON.stringify，微信 wx.request 传对象时可能不按 Content-Type 序列化
  const data = method === 'GET' ? undefined : JSON.stringify(options.data || {})

  // openid 通过 query 传递（向后兼容尚未迁移 JWT 的路由）
  if (openid) {
    const sep = url.indexOf('?') >= 0 ? '&' : '?'
    url += sep + 'openid=' + openid
  }

  // GET 请求添加防缓存时间戳，确保每次拉取最新数据
  if (method === 'GET') {
    url += (url.indexOf('?') >= 0 ? '&' : '?') + '_t=' + Date.now()
  }

  // 构建请求头：JWT token 作为身份认证
  const headers = { 'Content-Type': 'application/json' }
  if (token) {
    headers['Authorization'] = 'Bearer ' + token
  }

  return new Promise((resolve, reject) => {
    wx.request({
      url: url,
      method: method,
      data: data,
      timeout: 8000,  // 8 秒超时，避免 App Service 层累计超时触发 SystemError
      header: headers,
      success: (res) => {
        // 200~499 都 resolve，让调用方通过 res.success 判断业务成败
        // 否则 400 校验错误（如昵称重复）会走 reject 导致看不到具体错误消息
        if (res.statusCode < 500) {
          resolve(res.data || {})
        } else {
          reject(Object.assign(new Error('HTTP ' + res.statusCode), { data: res.data }))
        }
      },
      fail: (err) => {
        reject(err)
      }
    })
  })
}

module.exports = {
  get: (url, data) => request({ url, method: 'GET', data }),
  post: (url, data) => request({ url, method: 'POST', data }),
  put: (url, data) => request({ url, method: 'PUT', data }),
  del: (url, data) => request({ url, method: 'DELETE', data }),
  clearCache() {
    _openidCache = null;
    _openidFetched = false;
  },
  API_BASE
}
