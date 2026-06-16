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

  getOpenId() {
    if (this.globalData.openid) return Promise.resolve(this.globalData.openid)
    if (this.globalData._openIdPromise) return this.globalData._openIdPromise

    const promise = new Promise((resolve) => {
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
                // 存储 openid 和 JWT token
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
