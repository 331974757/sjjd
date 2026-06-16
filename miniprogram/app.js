// app.js
const api = require('./utils/api.js')

App({
  onLaunch() {
    // 先从本地缓存恢复 token 和 openid（快速恢复会话）
    try {
      const cachedToken = wx.getStorageSync('jwt_token')
      const cachedOpenid = wx.getStorageSync('openid')
      if (cachedToken) this.globalData.token = cachedToken
      if (cachedOpenid) this.globalData.openid = cachedOpenid
    } catch (_) {}

    // 延迟 100ms 后再请求登录，避免阻塞 App Service 初始化导致 SystemError timeout
    setTimeout(() => {
      this.getOpenId()
    }, 100)
  },

  /**
   * 验证已有 token 是否有效（通过服务端 /api/auth/verify）
   * 返回 { valid, token } - 如果有效还会返回续期后的新 token
   */
  verifyToken() {
    const token = this.getToken()
    if (!token) return Promise.resolve({ valid: false })
    return new Promise((resolve) => {
      wx.request({
        url: api.API_BASE + '/auth/verify',
        method: 'GET',
        timeout: 8000,
        header: { 'Authorization': 'Bearer ' + token },
        success: (res) => {
          if (res.data && res.data.success && res.data.token) {
            // Token 有效，使用续期后的新 token
            this.globalData.token = res.data.token
            this.globalData.openid = res.data.openid
            try {
              wx.setStorageSync('jwt_token', res.data.token)
              wx.setStorageSync('openid', res.data.openid)
            } catch (_) {}
            resolve({ valid: true, token: res.data.token })
          } else {
            resolve({ valid: false })
          }
        },
        fail: () => {
          resolve({ valid: false })
        }
      })
    })
  },

  /** 清除本地缓存的登录信息 */
  clearLoginCache() {
    this.globalData.openid = null
    this.globalData.token = null
    this.globalData._openIdPromise = null
    try {
      wx.removeStorageSync('openid')
      wx.removeStorageSync('jwt_token')
    } catch (_) {}
  },

  getOpenId() {
    if (this.globalData._openIdPromise) return this.globalData._openIdPromise

    const promise = (async () => {
      // 【关键修复】先验证已有 token 是否有效，避免使用旧密钥签发的过期 token
      if (this.globalData.token) {
        const verifyResult = await this.verifyToken()
        if (verifyResult.valid) {
          this.globalData._openIdPromise = null
          return this.globalData.openid
        }
        // Token 无效（如服务器 JWT 密钥变更），清除缓存重新登录
        this.clearLoginCache()
      }

      // 执行完整登录流程
      return new Promise((resolve) => {
        wx.login({
          timeout: 5000,
          success: (loginRes) => {
            if (!loginRes.code) {
              console.error('[App] wx.login 未返回 code')
              this.globalData._openIdPromise = null
              resolve('')
              return
            }
            wx.request({
              url: api.API_BASE + '/auth/login?code=' + loginRes.code,
              method: 'GET',
              timeout: 8000,
              success: (res) => {
                if (res.data && res.data.success && res.data.openid && res.data.token) {
                  this.globalData.openid = res.data.openid
                  this.globalData.token = res.data.token
                  try {
                    wx.setStorageSync('openid', res.data.openid)
                    wx.setStorageSync('jwt_token', res.data.token)
                  } catch (_) {}
                  this.globalData._openIdPromise = null
                  resolve(res.data.openid)
                } else {
                  console.error('[App] 登录接口返回错误:', res.data)
                  this.globalData._openIdPromise = null
                  resolve('')
                }
              },
              fail: (err) => {
                console.error('[App] 登录接口请求失败:', err)
                this.globalData._openIdPromise = null
                resolve('')
              }
            })
          },
          fail: (err) => {
            console.error('[App] wx.login 失败:', err)
            this.globalData._openIdPromise = null
            resolve('')
          }
        })
      })
    })()

    this.globalData._openIdPromise = promise
    return promise
  },

  /** 获取当前有效的 JWT token，优先读缓存 */
  getToken() {
    if (this.globalData.token) return this.globalData.token
    try {
      const cached = wx.getStorageSync('jwt_token')
      if (cached) this.globalData.token = cached
      return cached || ''
    } catch (_) { return '' }
  },

  globalData: {
    openid: null,
    token: null,
    _openIdPromise: null
  }
})
