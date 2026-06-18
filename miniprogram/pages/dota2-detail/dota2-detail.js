// pages/dota2-detail/dota2-detail.js
const perm = require('../../utils/permission.js')
const R = require('../../utils/rank-utils.js')
const api = require('../../utils/api.js')
const modal = require('../../utils/modal.js')
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

    // 段位内联编辑
    editingRank: false,
    rankPickedIndex: -1,
    starPickedIndex: -1,
    // 行内编辑
    editingField: '',         // 正在编辑的字段名（空表示未编辑）
    editingFieldValue: ''     // 编辑中的值
  },

  onLoad(options) {
    this.setData({ playerId: options.id })
    this.initPage()
  },

  /**
   * 初始化页面：加载选手数据 → 检查编辑权限
   * 使用回调版本的 setData 确保 player 已写入 data 后再查权限，
   * 避免 checkEditPermission 读到 null player
   */
  async initPage() {
    try {
      const res = await api.get('/players/' + this.data.playerId)
      const player = res.data
      if (!player.goodAtPositions) player.goodAtPositions = []
      if (!player.signupPosition || !Array.isArray(player.signupPosition)) player.signupPosition = []

      // 使用 setData 回调确保 player 已同步到 data 后再检查权限
      this.setData({ player }, () => {
        this.checkEditPermission()
      })
    } catch (err) {
      console.error('[选手详情] 加载失败', err)
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
  },

  /**
   * 检查当前用户对这位选手的编辑权限
   * - canEditAll: 管理员/超管 → 可编辑所有字段
   * - canEditOwn: 普通用户且昵称匹配选手 wxNickname → 可编辑部分字段（steamId/gameId/位置）
   * - canDelete:  管理员/超管 → 可删除
   */
  async checkEditPermission() {
    try {
      const role = await perm.getRole()
      const myNick = perm.getNickName() || ''
      const player = this.data.player

      if (!player) return  // 玩家数据未就绪，静默退出

      const isManager = role === 'super_admin' || role === 'admin'
      const isOwnPlayer = !!(player.wxNickname && myNick && player.wxNickname === myNick)

      this.setData({
        canEditAll: isManager,
        canEditOwn: isOwnPlayer && !isManager,  // 本人匹配到的选手（非管理员）
        canDelete: isManager
      })
    } catch (err) {
      console.error('[选手详情] 权限检查失败', err)
    }
  },

  /**
   * 更换头像：选择图片 → 上传到服务器 → 更新玩家 avatarUrl
   * 使用 api.getOpenId() 走 TTL 缓存，避免每次冷启动调 getApp()
   */
  changeAvatar() {
    if (!this.data.canEditAll && !this.data.canEditOwn) return
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: async (res) => {
        const tempPath = res.tempFiles[0].tempFilePath
        wx.showLoading({ title: '上传中...' })
        try {
          const openid = await api.getOpenId()
          const uploadUrl = api.API_BASE + '/upload' + (openid ? '?openid=' + encodeURIComponent(openid) : '')
          wx.uploadFile({
            url: uploadUrl,
            filePath: tempPath,
            name: 'file',
            header: api.getUploadHeaders(),
            success: (uploadRes) => {
              try {
                const data = JSON.parse(uploadRes.data)
                if (data.success && data.data && data.data.url) {
                  const fullUrl = api.API_BASE.replace(/\/api$/, '') + data.data.url
                  this.updateField('avatarUrl', fullUrl)
                } else {
                  wx.showToast({ title: data.error || '上传失败', icon: 'none' })
                }
              } catch (e) {
                wx.showToast({ title: '上传失败', icon: 'none' })
              }
            },
            fail: () => {
              wx.showToast({ title: '上传失败，请检查网络', icon: 'none' })
            },
            complete: () => { wx.hideLoading() }
          })
        } catch (e) {
          wx.hideLoading()
          wx.showToast({ title: '获取身份信息失败', icon: 'none' })
        }
      }
    })
  },

  /**
   * 进入行内编辑模式（文本字段：昵称/SteamID/游戏昵称/天梯分）
   */
  editField(e) {
    const field = e.currentTarget.dataset.field
    const currentVal = this.data.player[field] || ''
    this.setData({ editingField: field, editingFieldValue: String(currentVal) })
  },

  /**
   * 行内编辑输入变更（双向绑定）
   */
  onEditInput(e) {
    this.setData({ editingFieldValue: e.detail.value })
  },

  /**
   * 行内编辑确认：前端校验 → 调用 updateField
   * - 非空文本必填
   * - 数字字段范围 0-20000
   * - 值未变化则直接退出编辑模式
   */
  confirmEditField() {
    const field = this.data.editingField
    const currentVal = this.data.player[field] || ''
    const isNumberField = field === 'calibrateMmr'
    let val = this.data.editingFieldValue.trim()

    if (!val && !isNumberField) {
      wx.showToast({ title: getFieldLabel(field) + '不能为空', icon: 'none' })
      return
    }
    if (isNumberField) {
      val = val ? parseInt(val) : null
      if (val !== null && (isNaN(val) || val < 0 || val > 20000)) {
        wx.showToast({ title: '请输入有效的天梯分（0-20000）', icon: 'none' })
        return
      }
    }
    if (String(val) === String(currentVal)) {
      this.setData({ editingField: '', editingFieldValue: '' })
      return
    }
    this.setData({ editingField: '', editingFieldValue: '' })
    this.updateField(field, val)
  },

  /**
   * 行内编辑取消（不做任何保存）
   */
  cancelEditField() {
    this.setData({ editingField: '', editingFieldValue: '' })
  },

  /**
   * 进入段位编辑模式：回显当前段位和星数
   */
  editRankTitle() {
    const player = this.data.player
    const currentRank = player.calibrateRankName || ''
    const currentStar = player.calibrateRankStar || 0
    const rankIdx = RANK_OPTIONS.indexOf(currentRank)
    const starIdx = currentStar > 0 ? currentStar - 1 : -1
    this.setData({
      editingRank: true,
      rankPickedIndex: rankIdx >= 0 ? rankIdx : -1,
      starPickedIndex: rankIdx >= 0 && rankIdx < 7 ? starIdx : -1
    })
  },

  /**
   * 点击段位：冠绝一世（idx=7）直接保存，其他段位等待选星
   */
  pickRank(e) {
    const idx = parseInt(e.currentTarget.dataset.index)
    if (isNaN(idx) || idx < 0 || idx >= RANK_OPTIONS.length) return
    if (idx === 7) {
      // 冠绝一世没有星级，直接保存
      this.setData({ editingRank: false, rankPickedIndex: -1, starPickedIndex: -1 })
      this.updateFields({ calibrateRankName: '冠绝一世', calibrateRankStar: 0 })
      return
    }
    this.setData({ rankPickedIndex: idx, starPickedIndex: -1 })
  },

  /**
   * 点击星数（1-5）：选段位+星数一次性保存
   */
  pickStar(e) {
    const idx = parseInt(e.currentTarget.dataset.index)
    if (isNaN(idx) || idx < 0 || idx > 4) return
    const star = idx + 1
    const rankName = RANK_OPTIONS[this.data.rankPickedIndex]
    this.setData({ editingRank: false, rankPickedIndex: -1, starPickedIndex: -1 })
    this.updateFields({ calibrateRankName: rankName, calibrateRankStar: star })
  },

  /**
   * 打开"擅长游戏位置"多选弹窗
   */
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

  /**
   * 打开"比赛报名位置"多选弹窗
   */
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

  /**
   * 弹窗内切换位置选中状态
   * data-pos 传数字 1-5（JS 自动转字符串 key，与对象数字 key 兼容）
   */
  toggleModalPos(e) {
    const pos = parseInt(e.currentTarget.dataset.pos)  // 转为数字保证类型一致
    if (isNaN(pos) || pos < 1 || pos > 5) return
    const key = 'posModalSelected.' + pos
    this.setData({ [key]: !this.data.posModalSelected[pos] })
  },

  /**
   * 关闭位置选择弹窗
   */
  closePosModal() {
    this.setData({ showPosModal: false })
  },

  /**
   * 确认位置选择：收集选中位置 → 关闭弹窗 → 调用 API 更新
   */
  confirmPosModal() {
    const field = this.data.posModalField
    const positions = []
    for (let n = 1; n <= 5; n++) {
      if (this.data.posModalSelected[n]) positions.push(n)
    }
    this.setData({ showPosModal: false })
    this.updateField(field, positions)
  },

  /** 阻止事件冒泡到遮罩层（catchtap 已处理，但 keep 为 debug 保留） */
  preventMove() {},

  /**
   * 更新单个字段（调用 PUT /api/players/:id）
   * - 成功后乐观更新本地 player 对象（不可变方式）
   * - 通知首页标记 needsReload
   */
  async updateField(field, value) {
    wx.showLoading({ title: '保存中...' })
    try {
      const res = await api.put('/players/' + this.data.playerId, { [field]: value })
      wx.hideLoading()

      if (res.success) {
        this._notifyHomeRefresh()
        wx.showToast({ title: '已更新', icon: 'success' })
        // 不可变更新：展开旧对象 + 覆盖字段
        this.setData({ player: { ...this.data.player, [field]: value } })
      } else {
        wx.showToast({ title: res.message || res.error || '更新失败', icon: 'none' })
      }
    } catch (err) {
      wx.hideLoading()
      console.error('[选手详情] 更新失败', err)
      wx.showToast({ title: '更新失败', icon: 'none' })
    }
  },

  /**
   * 批量更新多个字段（一次 API 调用，用于段位选择等场景）
   */
  async updateFields(data) {
    wx.showLoading({ title: '保存中...' })
    try {
      const res = await api.put('/players/' + this.data.playerId, data)
      wx.hideLoading()
      if (res.success) {
        this._notifyHomeRefresh()
        wx.showToast({ title: '已更新', icon: 'success' })
        // 不可变更新
        this.setData({ player: { ...this.data.player, ...data } })
      } else {
        wx.showToast({ title: res.message || res.error || '更新失败', icon: 'none' })
      }
    } catch (err) {
      wx.hideLoading()
      console.error('[选手详情] 批量更新失败', err)
      wx.showToast({ title: '更新失败', icon: 'none' })
    }
  },

  /**
   * 删除选手（需管理员/超管权限，调 modal 确认）
   */
  async deletePlayer() {
    const r = await modal.confirm(this, {
      theme: 'danger',
      title: '确认删除',
      content: '删除后不可恢复，确定要删除该选手吗？'
    })
    if (r && r.confirm) this.doDelete()
  },

  /**
   * 执行软删除：PUT /api/players/:id → 标记 status='deleted'
   */
  async doDelete() {
    wx.showLoading({ title: '删除中...' })
    try {
      const res = await api.del('/players/' + this.data.playerId)
      wx.hideLoading()
      if (res.success) {
        this._notifyHomeRefresh()
        wx.showToast({ title: '已删除', icon: 'success' })
        setTimeout(() => { wx.navigateBack() }, 800)
      } else {
        wx.showToast({ title: res.message || res.error || '删除失败', icon: 'none' })
      }
    } catch (err) {
      wx.hideLoading()
      console.error('[选手详情] 删除失败', err)
      wx.showToast({ title: '删除失败', icon: 'none' })
    }
  },

  /**
   * 通知首页下次 onShow 时重新加载数据
   * 遍历导航栈查找首页页面实例，避免硬编码下标
   * - 如果首页不在页面栈中（如从分享直接进入详情），静默跳过
   */
  _notifyHomeRefresh() {
    try {
      const pages = getCurrentPages()
      const homePage = pages.find(p => p && p.route && p.route.indexOf('pages/dota2/dota2') !== -1)
      if (homePage && typeof homePage.loadAllPlayers === 'function') {
        homePage._needsReload = true
      }
    } catch (_) {
      // 页面栈异常时静默降级
    }
  },

  /**
   * 微信分享：标题包含选手昵称+段位，路径指向详情页
   */
  onShareAppMessage() {
    const player = this.data.player
    if (player) {
      return {
        title: (player.wxNickname || '选手') + ' - ' + (player.calibrateRankName || '未定段位') + ' | 蜀国争霸系统',
        path: '/pages/dota2-detail/dota2-detail?id=' + this.data.playerId,
        imageUrl: player.avatarUrl || ''
      }
    }
    return {
      title: '蜀国争霸系统 - 选手档案',
      path: '/pages/dota2/dota2'
    }
  }
})

/**
 * 字段中文标签映射（用于错误提示等场景）
 */
function getFieldLabel(field) {
  const labels = {
    wxNickname: '微信群昵称',
    steamId: 'Steam ID',
    gameId: 'Dota2游戏昵称',
    calibrateMmr: '天梯分'
  }
  return labels[field] || field
}
