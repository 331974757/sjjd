// app.js
App({
  onLaunch() {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力')
    } else {
      wx.cloud.init({
        env: 'prod-d3gac4qo6d76e770c',
        traceUser: true
      })
    }

    // 延迟获取 openid，避免阻塞启动
    setTimeout(() => {
      this.getOpenId()
    }, 500)
  },

  getOpenId() {
    if (this.globalData.openid) return Promise.resolve(this.globalData.openid)
    if (this.globalData._openIdPromise) return this.globalData._openIdPromise

    const promise = wx.cloud.callFunction({
      name: 'getOpenId'
    }).then((res) => {
      this.globalData.openid = res.result.openid
      this.globalData._openIdPromise = null
      return res.result.openid
    }).catch((err) => {
      console.error('获取 openid 失败', err)
      this.globalData._openIdPromise = null
      return null
    })

    this.globalData._openIdPromise = promise
    return promise
  },

  globalData: {
    openid: null,
    _openIdPromise: null
  }
})
