// app.js
const api = require('./utils/api.js')

App({
  onLaunch() {
    // 延迟 100ms 后再请求 openid，避免阻塞 App Service 初始化导致 SystemError timeout
    // 微信基础库对 App 启动有内部超时限制，同步发起的网络请求若不可达会触发
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
              if (res.data && res.data.success && res.data.openid) {
                this.globalData.openid = res.data.openid
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

  globalData: {
    openid: null,
    _openIdPromise: null
  }
})
