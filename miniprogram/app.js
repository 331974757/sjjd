// app.js
App({
  onLaunch: function () {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力')
    } else {
      wx.cloud.init({
        env: 'prod-d3gac4qo6d76e770c',
        traceUser: true
      })
    }

    // 延迟获取 openid，避免阻塞启动
    var that = this
    setTimeout(function() {
      that.getOpenId()
    }, 500)
  },

  getOpenId() {
    if (this.globalData.openid) return Promise.resolve(this.globalData.openid)
    if (this.globalData._openIdPromise) return this.globalData._openIdPromise

    var promise = wx.cloud.callFunction({
      name: 'getOpenId'
    }).then(function(res) {
      this.globalData.openid = res.result.openid
      this.globalData._openIdPromise = null
      return res.result.openid
    }.bind(this)).catch(function(err) {
      console.error('获取 openid 失败', err)
      this.globalData._openIdPromise = null
      return null
    }.bind(this))

    this.globalData._openIdPromise = promise
    return promise
  },

  globalData: {
    openid: null,
    _openIdPromise: null
  }
})
