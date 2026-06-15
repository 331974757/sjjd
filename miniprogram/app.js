// app.js
const api = require('./utils/api.js')

App({
  onLaunch() {
    this.getOpenId()
  },

  getOpenId() {
    if (this.globalData.openid) return Promise.resolve(this.globalData.openid)
    if (this.globalData._openIdPromise) return this.globalData._openIdPromise

    const promise = new Promise((resolve) => {
      wx.login({
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
