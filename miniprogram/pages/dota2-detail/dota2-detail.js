// pages/dota2-detail/dota2-detail.js
const perm = require('../../utils/permission.js')
const R = require('../../utils/rank-utils.js')
const api = require('../../utils/api.js')
const RANK_OPTIONS = R.RANK_OPTIONS

Page({
  data: {
    playerId: '',
    player: null,
    // 权限
    canEditAll: false,      // 管理员/超管 → 可编辑所有字段
    canEditOwn: false,      // 普通用户匹配到自己的选手 → 可编辑部分字段
    canDelete: false,       // 管理员/超管 → 可删除
    // 位置选择弹窗
    showPosModal: false,
    posModalTitle: '',
    posModalField: '',      // 'goodAtPositions' 或 'signupPosition'
    posModalSelected: { 1: false, 2: false, 3: false, 4: false, 5: false },

    // 段位选择弹窗
    showRankModal: false,
    rankPickedIndex: -1,     // 当前选中的段位索引（0~7）
    starPickedIndex: -1      // 当前选中的星数索引（0~4 对应 1~5星）
  },

  onLoad(options) {
    this.setData({ playerId: options.id })
    this.initPage()
  },

  async initPage() {
    await this.loadPlayer()
    await this.checkEditPermission()
  },

  async loadPlayer() {
    try {
      const res = await api.get('/players/' + this.data.playerId)
      const player = res.data
      if (!player.goodAtPositions) player.goodAtPositions = []
      if (!player.signupPosition || !Array.isArray(player.signupPosition)) player.signupPosition = []
      this.setData({ player: player })
    } catch (err) {
      console.error('加载失败', err)
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
  },

  // 检查当前用户对这位选手的编辑权限
  async checkEditPermission() {
    try {
      const role = await perm.getRole()
      const myNick = perm.getNickName() || ''
      const player = this.data.player

      const isManager = role === 'super_admin' || role === 'admin'
      const isOwnPlayer = player && player.wxNickname && myNick && player.wxNickname === myNick

      this.setData({
        canEditAll: isManager,
        canEditOwn: isOwnPlayer && !isManager,  // 自己匹配到的选手（非管理员）
        canDelete: isManager
      })
    } catch (err) {
      console.error('权限检查失败', err)
    }
  },

  // 更换头像
  changeAvatar() {
    if (!this.data.canEditAll && !this.data.canEditOwn) return
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const tempPath = res.tempFiles[0].tempFilePath
        wx.showLoading({ title: '上传中...' })
        const app = getApp()
        const openid = app.globalData.openid || ''
        const uploadUrl = api.API_BASE + '/upload' + (openid ? '?openid=' + encodeURIComponent(openid) : '')
        wx.uploadFile({
          url: uploadUrl,
          filePath: tempPath,
          name: 'file',
          header: api.getUploadHeaders(),
          success: (uploadRes) => {
            try {
              const data = JSON.parse(uploadRes.data)
              if (data.success && data.data) {
                const fullUrl = api.API_BASE.replace(/\/api$/, '') + data.data.url
                this.updateField('avatarUrl', fullUrl)
              } else {
                wx.showToast({ title: '上传失败', icon: 'none' })
              }
            } catch (e) {
              wx.showToast({ title: '上传失败', icon: 'none' })
            }
          },
          fail: () => {
            wx.showToast({ title: '上传失败', icon: 'none' })
          },
          complete: () => { wx.hideLoading() }
        })
      }
    })
  },

  // 编辑文本字段
  editField(e) {
    const field = e.currentTarget.dataset.field
    const currentVal = this.data.player[field] || ''

    // 天梯分使用 number 类型输入
    const isNumberField = field === 'calibrateMmr'

    wx.showModal({
      title: '修改' + getFieldLabel(field),
      editable: true,
      placeholderText: isNumberField ? '请输入整数天梯分' : ('请输入' + getFieldLabel(field)),
      content: String(currentVal),
      success: (res) => {
        if (res.confirm && res.content !== undefined) {
          let val = res.content.trim()
          if (!val && !isNumberField) {
            wx.showToast({ title: getFieldLabel(field) + '不能为空', icon: 'none' })
            return
          }
          // 天梯分：空值允许清空，非空时转为数字
          if (isNumberField) {
            val = val ? parseInt(val) : null
            if (val !== null && (isNaN(val) || val < 0 || val > 20000)) {
              wx.showToast({ title: '请输入有效的天梯分（0-20000）', icon: 'none' })
              return
            }
          }
          if (String(val) === String(currentVal)) return
          this.updateField(field, val)
        }
      }
    })
  },

  // 打开段位选择弹窗（预填当前段位和星数）
  editRankTitle() {
    const player = this.data.player
    const currentRank = player.calibrateRankName || ''
    const currentStar = player.calibrateRankStar || 0
    const rankIdx = RANK_OPTIONS.indexOf(currentRank)
    const starIdx = currentStar > 0 ? currentStar - 1 : -1
    this.setData({
      showRankModal: true,
      rankPickedIndex: rankIdx >= 0 ? rankIdx : -1,
      starPickedIndex: rankIdx >= 0 && rankIdx < 7 ? starIdx : -1
    })
  },

  // 点击段位 → 高亮选中
  pickRank(e) {
    const idx = parseInt(e.currentTarget.dataset.index)
    if (isNaN(idx) || idx < 0 || idx >= RANK_OPTIONS.length) return
    this.setData({
      rankPickedIndex: idx,
      starPickedIndex: -1
    })
  },

  // 关闭段位弹窗
  closeRankModal() {
    this.setData({ showRankModal: false, rankPickedIndex: -1, starPickedIndex: -1 })
  },

  // 点击星数 → 高亮选中
  pickStar(e) {
    const idx = parseInt(e.currentTarget.dataset.index)
    if (isNaN(idx) || idx < 0 || idx > 4) return
    this.setData({ starPickedIndex: idx })
  },

  // 确认段位+星数
  confirmRankStar() {
    const rankIdx = this.data.rankPickedIndex
    if (rankIdx < 0) return

    // 冠绝一世无星级，直接保存
    if (rankIdx === 7) {
      this.setData({ showRankModal: false, rankPickedIndex: -1, starPickedIndex: -1 })
      this.updateFields({
        calibrateRankName: '冠绝一世',
        calibrateRankStar: 0
      })
      return
    }

    const starIdx = this.data.starPickedIndex
    if (starIdx < 0) {
      wx.showToast({ title: '请选择星数', icon: 'none' })
      return
    }
    const star = starIdx + 1
    const newTitle = RANK_OPTIONS[rankIdx]

    this.setData({ showRankModal: false, rankPickedIndex: -1, starPickedIndex: -1 })
    this.updateFields({
      calibrateRankName: newTitle,
      calibrateRankStar: star
    })
  },

  // 编辑擅长位置（弹窗多选）
  editPositions() {
    const current = this.data.player.goodAtPositions || []
    const selectedObj = { 1: false, 2: false, 3: false, 4: false, 5: false }
    for (let i = 0; i < current.length; i++) {
      selectedObj[current[i]] = true
    }
    this.setData({
      showPosModal: true,
      posModalTitle: '擅长游戏位置',
      posModalField: 'goodAtPositions',
      posModalSelected: selectedObj
    })
  },

  // 编辑报名位置（弹窗多选）
  editSignupPosition() {
    const current = this.data.player.signupPosition || []
    const selectedObj = { 1: false, 2: false, 3: false, 4: false, 5: false }
    for (let i = 0; i < current.length; i++) {
      selectedObj[current[i]] = true
    }
    this.setData({
      showPosModal: true,
      posModalTitle: '比赛报名位置',
      posModalField: 'signupPosition',
      posModalSelected: selectedObj
    })
  },

  // 弹窗内切换位置选中状态
  toggleModalPos(e) {
    const pos = e.currentTarget.dataset.pos
    const key = 'posModalSelected.' + pos
    const obj = {}
    obj[key] = !this.data.posModalSelected[pos]
    this.setData(obj)
  },

  // 关闭弹窗
  closePosModal() {
    this.setData({ showPosModal: false })
  },

  // 确认选择
  confirmPosModal() {
    const field = this.data.posModalField
    const positions = []
    for (let n = 1; n <= 5; n++) {
      if (this.data.posModalSelected[n]) positions.push(n)
    }
    this.setData({ showPosModal: false })
    this.updateField(field, positions)
  },

  preventMove() {},

  // API 更新字段
  async updateField(field, value) {
    const updateData = {}
    updateData[field] = value

    wx.showLoading({ title: '保存中...' })
    try {
      const res = await api.put('/players/' + this.data.playerId, updateData)
      wx.hideLoading()

      if (res.success) {
        // 通知首页刷新（段位/昵称等变更后首页卡片需更新）
        this._notifyHomeRefresh()
        wx.showToast({ title: '已更新', icon: 'success' })
        const player = this.data.player
        player[field] = value
        this.setData({ player: player })
      } else {
        wx.showToast({ title: res.message || '更新失败', icon: 'none' })
      }
    } catch (err) {
      wx.hideLoading()
      console.error('更新失败', err)
      wx.showToast({ title: '更新失败', icon: 'none' })
    }
  },

  // 批量更新多个字段（一次 API 调用）
  async updateFields(data) {
    wx.showLoading({ title: '保存中...' })
    try {
      const res = await api.put('/players/' + this.data.playerId, data)
      wx.hideLoading()
      if (res.success) {
        // 通知首页刷新
        this._notifyHomeRefresh()
        wx.showToast({ title: '已更新', icon: 'success' })
        const player = this.data.player
        for (const key in data) {
          player[key] = data[key]
        }
        this.setData({ player: player })
      } else {
        wx.showToast({ title: res.message || '更新失败', icon: 'none' })
      }
    } catch (err) {
      wx.hideLoading()
      console.error('更新失败', err)
      wx.showToast({ title: '更新失败', icon: 'none' })
    }
  },

  // 删除选手
  deletePlayer() {
    wx.showModal({
      title: '确认删除',
      content: '删除后不可恢复，确定要删除该选手吗？',
      confirmColor: '#da3633',
      success: (res) => {
        if (res.confirm) this.doDelete()
      }
    })
  },

  async doDelete() {
    wx.showLoading({ title: '删除中...' })
    try {
      const res = await api.del('/players/' + this.data.playerId)
      wx.hideLoading()
      if (res.success) {
        // 通知首页强制刷新
        this._notifyHomeRefresh()
        wx.showToast({ title: '已删除', icon: 'success' })
        setTimeout(() => { wx.navigateBack() }, 800)
      } else {
        wx.showToast({ title: res.message || '删除失败', icon: 'none' })
      }
    } catch (err) {
      wx.hideLoading()
      console.error('删除失败', err)
      wx.showToast({ title: '删除失败', icon: 'none' })
    }
  },

  // 通知首页下次 onShow 时刷新数据
  _notifyHomeRefresh() {
    const pages = getCurrentPages()
    // 【BUG-P4修复】遍历导航栈查找首页，而不是硬编码 pages.length-2
    const homePage = pages.find(p => p.route && p.route.indexOf('pages/dota2/dota2') !== -1)
    if (homePage && homePage.loadAllPlayers) {
      homePage._needsReload = true
    }
  },

  // 分享
  onShareAppMessage() {
    const player = this.data.player
    if (player) {
      return {
        title: player.wxNickname + ' - ' + (player.calibrateRankName || '未定段位') + ' | 蜀国争霸系统',
        path: '/pages/dota2-detail/dota2-detail?id=' + this.data.playerId,
        imageUrl: player.avatarUrl || ''
      }
    }
    return {
      title: '蜀国争霸系统 - Dota2',
      path: '/pages/dota2/dota2'
    }
  }
})

function getFieldLabel(field) {
  const labels = {
    wxNickname: '微信群昵称',
    steamId: 'Steam ID',
    gameId: 'Dota2游戏昵称',
    calibrateMmr: '天梯分'
  }
  return labels[field] || field
}
