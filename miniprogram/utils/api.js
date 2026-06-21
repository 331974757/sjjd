// utils/api.js - ECS REST API 统一请求模块
const API_BASE = 'https://congqin.online/api'

// 缓存 openid 避免每次都调 getApp
let _openidCache = null
let _lastFetchTime = 0
const OPENID_CACHE_TTL = 5 * 60 * 1000  // 5 分钟 TTL（超时后重新获取）

async function getOpenId() {
  // 缓存有效期内直接返回（含空字符串，避免死循环）
  if (_openidCache !== null && (Date.now() - _lastFetchTime) < OPENID_CACHE_TTL) {
    return _openidCache
  }
  try {
    const app = getApp()
    // 如果 globalData.openid 为空，等待 app.getOpenId() 完成
    if (!app.globalData.openid) {
      await app.getOpenId()
    }
    const result = app.globalData.openid || ''
    _openidCache = result
    _lastFetchTime = Date.now()
    return result
  } catch (e) { /* 静默降级 */ }
  _openidCache = ''
  _lastFetchTime = Date.now()
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

async function request(options, _retried) {
  const token = getToken()
  let url = API_BASE + options.url
  const method = (options.method || 'GET').toUpperCase()

  // GET 参数拼接到 URL
  if (method === 'GET' && options.data) {
    const params = Object.keys(options.data).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(options.data[k])).join('&')
    if (params) url += (url.indexOf('?') >= 0 ? '&' : '?') + params
  }

  // body 数据仅用于非 GET
  const data = method === 'GET' ? undefined : JSON.stringify(options.data || {})

  // GET 请求添加防缓存时间戳，确保每次拉取最新数据
  if (method === 'GET') {
    url += (url.indexOf('?') >= 0 ? '&' : '?') + '_t=' + Date.now()
  }

  // JWT token 作为唯一身份认证（Authorization 头部）
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

/** 获取 wx.uploadFile 所需的认证 headers（含 JWT） */
function getUploadHeaders() {
  var headers = {}
  var token = getToken()
  if (token) {
    headers['Authorization'] = 'Bearer ' + token
  }
  return headers
}

module.exports = {
  get: (url, data) => request({ url, method: 'GET', data }),
  post: (url, data) => request({ url, method: 'POST', data }),
  put: (url, data) => request({ url, method: 'PUT', data }),
  del: (url, data) => request({ url, method: 'DELETE', data }),
  getUploadHeaders: getUploadHeaders,
  getOpenId: getOpenId,
  getToken: getToken,
  clearCache() {
    _openidCache = null;
    _lastFetchTime = 0;
  },
  API_BASE,
  BASE_URL: API_BASE.replace('/api', '')
}
