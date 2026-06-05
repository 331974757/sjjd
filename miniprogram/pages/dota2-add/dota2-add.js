// pages/dota2-add/dota2-add.js
Page({
  data: {
    wxNickname: '',
    steamId: '',
    gameId: '',
    highestMmr: '',
    currentMmr: '',
    selfMmr: '',
    selectedPos: { 1: false, 2: false, 3: false, 4: false, 5: false },
    signupOptions: ['未定', '1号位', '2号位', '3号位', '4号位', '5号位'],
    signupIndex: 0,
    submitting: false
  },

  onInput(e) {
    var field = e.currentTarget.dataset.field
    var obj = {}
    obj[field] = e.detail.value
    this.setData(obj)
  },

  togglePos(e) {
    var pos = e.currentTarget.dataset.pos
    var key = 'selectedPos.' + pos
    var obj = {}
    obj[key] = !this.data.selectedPos[pos]
    this.setData(obj)
  },

  onSignupPick(e) {
    this.setData({ signupIndex: Number(e.detail.value) })
  },

  async onSubmit() {
    if (this.data.submitting) return

    var wxNickname = this.data.wxNickname.trim()
    var gameId = this.data.gameId.trim()
    var currentMmr = Number(this.data.currentMmr)

    if (!wxNickname) {
      wx.showToast({ title: '请输入微信群昵称', icon: 'none' })
      return
    }
    if (!gameId) {
      wx.showToast({ title: '请输入Dota2游戏ID', icon: 'none' })
      return
    }
    if (isNaN(currentMmr) || this.data.currentMmr.trim() === '') {
      wx.showToast({ title: '请输入当前分数', icon: 'none' })
      return
    }

    // 收集擅长位置
    var goodAtPositions = []
    var sp = this.data.selectedPos
    for (var i = 1; i <= 5; i++) {
      if (sp[i]) goodAtPositions.push(i)
    }
    goodAtPositions.sort()

    // 比赛报名位置
    var signupPosition = ''
    if (this.data.signupIndex > 0) {
      signupPosition = String(this.data.signupIndex)
    }

    this.setData({ submitting: true })

    try {
      var res = await wx.cloud.callFunction({
        name: 'managePlayer',
        data: {
          action: 'add',
          data: {
            wxNickname: wxNickname,
            steamId: this.data.steamId.trim(),
            gameId: gameId,
            highestMmr: Number(this.data.highestMmr) || 0,
            currentMmr: currentMmr,
            selfMmr: Number(this.data.selfMmr) || 0,
            goodAtPositions: goodAtPositions,
            signupPosition: signupPosition
          }
        }
      })

      if (res.result.success) {
        var replaced = res.result.replaced || 0
        var msg = replaced > 0 ? '已覆盖' + replaced + '条重复记录' : '添加成功！'
        wx.showToast({ title: msg, icon: 'success' })
        setTimeout(function() {
          wx.navigateBack()
        }, 800)
      } else {
        wx.showToast({ title: res.result.message || '添加失败', icon: 'none' })
      }
    } catch (err) {
      console.error('添加失败', err)
      wx.showToast({ title: '添加失败', icon: 'none' })
    } finally {
      this.setData({ submitting: false })
    }
  }
})
