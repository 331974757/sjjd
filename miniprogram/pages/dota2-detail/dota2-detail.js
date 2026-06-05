// pages/dota2-detail/dota2-detail.js
var db = null

Page({
  data: {
    playerId: '',
    player: null
  },

  onLoad(options) {
    db = wx.cloud.database()
    this.setData({ playerId: options.id })
    this.loadPlayer()
  },

  async loadPlayer() {
    try {
      var res = await db.collection('dota2_players').doc(this.data.playerId).get()
      var player = res.data
      if (!player.goodAtPositions) player.goodAtPositions = []
      this.setData({ player: player })
    } catch (err) {
      console.error('加载失败', err)
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
  },

  // 编辑文本/数字字段
  editField(e) {
    var that = this
    var field = e.currentTarget.dataset.field
    var type = e.currentTarget.dataset.type
    var player = this.data.player
    var currentVal = player[field] || ''

    if (type === 'number') {
      wx.showModal({
        title: '修改' + getFieldLabel(field),
        editable: true,
        placeholderText: '请输入数值',
        content: String(currentVal),
        success: function(res) {
          if (res.confirm && res.content !== undefined) {
            var val = Number(res.content)
            if (isNaN(val)) {
              wx.showToast({ title: '请输入有效数值', icon: 'none' })
              return
            }
            that.updateField(field, val)
          }
        }
      })
    } else {
      wx.showModal({
        title: '修改' + getFieldLabel(field),
        editable: true,
        placeholderText: '请输入内容',
        content: String(currentVal),
        success: function(res) {
          if (res.confirm && res.content !== undefined) {
            that.updateField(field, res.content.trim())
          }
        }
      })
    }
  },

  // 编辑擅长位置（多选）
  editPositions() {
    var that = this
    var current = this.data.player.goodAtPositions || []
    var items = ['1号位', '2号位', '3号位', '4号位', '5号位']

    wx.showActionSheet({
      itemList: items,
      success: function() {
        // ActionSheet 不支持多选，用自定义弹窗方案
      }
    })

    // 简化：用 setClipboard 的方式不可行，改用 navigateTo 传参编辑
    // 直接用简易的多选弹窗
    var selectedObj = { 1: false, 2: false, 3: false, 4: false, 5: false }
    for (var i = 0; i < current.length; i++) {
      selectedObj[current[i]] = true
    }

    // 逐个提示是否选择（简化方案，实际应用中建议自定义组件）
    that._editPosStep = { selected: selectedObj, step: 1 }
    that._showPosToggle()
  },

  _showPosToggle() {
    var that = this
    var step = this._editPosStep.step
    var selected = this._editPosStep.selected
    if (step > 5) {
      // 完成多选，收集结果
      var positions = []
      for (var n = 1; n <= 5; n++) {
        if (selected[n]) positions.push(n)
      }
      that.updateField('goodAtPositions', positions)
      return
    }

    var currentSelected = selected[step]
    wx.showModal({
      title: '擅长位置 ( ' + step + '号位 )',
      content: currentSelected ? '当前已选中，是否取消？' : '是否选中该位置？',
      confirmText: currentSelected ? '取消选中' : '选中',
      success: function(res) {
        if (res.confirm) {
          that._editPosStep.selected[step] = !currentSelected
        }
        that._editPosStep.step++
        that._showPosToggle()
      },
      fail: function() {
        that._editPosStep.step++
        that._showPosToggle()
      }
    })
  },

  // 编辑比赛报名位置（单选）
  editSignupPosition() {
    var that = this
    var current = this.data.player.signupPosition || ''
    var items = ['未定', '1号位', '2号位', '3号位', '4号位', '5号位']
    var values = ['', '1', '2', '3', '4', '5']

    wx.showActionSheet({
      itemList: items,
      success: function(res) {
        that.updateField('signupPosition', values[res.tapIndex])
      }
    })
  },

  // 调用云函数更新字段
  async updateField(field, value) {
    var that = this
    var updateData = {}
    updateData[field] = value

    wx.showLoading({ title: '保存中...' })
    try {
      var res = await wx.cloud.callFunction({
        name: 'managePlayer',
        data: {
          action: 'update',
          playerId: that.data.playerId,
          data: updateData
        }
      })
      wx.hideLoading()

      if (res.result.success) {
        wx.showToast({ title: '已更新', icon: 'success' })
        // 更新本地数据
        var player = that.data.player
        player[field] = value
        that.setData({ player: player })
      } else {
        wx.showToast({ title: res.result.message || '更新失败', icon: 'none' })
      }
    } catch (err) {
      wx.hideLoading()
      console.error('更新失败', err)
      wx.showToast({ title: '更新失败', icon: 'none' })
    }
  },

  // 删除选手
  deletePlayer() {
    var that = this
    wx.showModal({
      title: '确认删除',
      content: '删除后不可恢复，确定要删除该选手吗？',
      confirmColor: '#e74c3c',
      success: function(res) {
        if (res.confirm) {
          that.doDelete()
        }
      }
    })
  },

  async doDelete() {
    wx.showLoading({ title: '删除中...' })
    try {
      var res = await wx.cloud.callFunction({
        name: 'managePlayer',
        data: {
          action: 'delete',
          playerId: this.data.playerId
        }
      })
      wx.hideLoading()

      if (res.result.success) {
        wx.showToast({ title: '已删除', icon: 'success' })
        setTimeout(function() {
          wx.navigateBack()
        }, 800)
      } else {
        wx.showToast({ title: res.result.message || '删除失败', icon: 'none' })
      }
    } catch (err) {
      wx.hideLoading()
      console.error('删除失败', err)
      wx.showToast({ title: '删除失败', icon: 'none' })
    }
  }
})

function getFieldLabel(field) {
  var labels = {
    wxNickname: '微信群昵称',
    steamId: 'Steam ID',
    gameId: 'Dota2游戏ID',
    highestMmr: '历史最高分',
    currentMmr: '当前分数',
    selfMmr: '自我认定分数'
  }
  return labels[field] || field
}
