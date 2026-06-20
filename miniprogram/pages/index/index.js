// pages/index/index.js
// 核心页面 — 按功能导入选手/赛事/首页模块并合并

const perm = require('../../utils/permission.js')
const C = require('../../utils/constants.js')
const api = require('../../utils/api.js')

const playerModule = require('./modules/player-module.js')
const eventModule = require('./modules/event-module.js')
const homeModule = require('./modules/home-module.js')

// ———— 合并 data ————
const mergedData = Object.assign({},
  playerModule.data,
  eventModule.data,
  homeModule.data
)

// ———— 核心 Page 配置 ————
const pageConfig = {
  data: Object.assign({
    currentGame: 'home',
    subTab: 'profile',
    userInfo: { avatarUrl: '' },
    nickName: '',
    nickChangeCount: 0,
    nickChangeLimit: C.NICK_CHANGE_LIMIT,
    remainingCount: C.NICK_CHANGE_LIMIT,
    unlimitedNick: false,
    userRole: '',
    isAdmin: false,
    showNickModal: false,
    showAdminModal: false,
    nickInputValue: '',
    userOpenid: '',
    allAdminNames: [],
    _superAdminOnly: [],
    _adminOnly: [],
    statusBarHeight: 44,
    marqueeOffset: 0,
  }, mergedData),

  // ———— 生命周期 ————
  onLoad(options) {
    const sysInfo = wx.getSystemInfoSync()
    this.setData({ statusBarHeight: sysInfo.statusBarHeight || 44 })
    if (options && options.subTab) {
      this.setData({ subTab: options.subTab })
    }
    this.loadNickname()
    this.loadUserInfo()
    this.loadAllPlayers()
    this.loadSuperAdminInfo()
    this.homeLoadUsers()
    this.loadHomeData()
  },

  onReady() {
    this.startMarquee()
  },

  onShow() {
    if (this.data.currentGame === 'home') {
      this.startMarquee()
    }
    if (this._needsReload) {
      this._needsReload = false
      if (this._reloadTimer) clearTimeout(this._reloadTimer)
      this._reloadTimer = setTimeout(() => { this.loadAllPlayers() }, 500)
    }
    if (this._nickMayBeChanged) {
      this._nickMayBeChanged = false
      this.fetchNicknameInfo()
    }
    if (this.data.currentGame === 'home') {
      this.loadHomeData(true)
      if (this.data.userRole === 'super_admin') {
        this.homeLoadUsers()
      }
    }
    if (this.data.currentGame === 'dota2') {
      if (this.data.subTab === 'rules') {
        this.loadRuleEvents()
      } else if (this.data.subTab === 'history') {
        this.loadEvents()
      }
    }
  },

  // ———— 用户/昵称 ————
  loadUserInfo() {
    try {
      const info = wx.getStorageSync('user_info') || {}
      if (info.avatarUrl) { this.setData({ userInfo: info }) }
    } catch (e) { }
  },

  async loadSuperAdminInfo() {
    try {
      const res = await api.get('/users/admins/list')
      if (res.success && res.data) {
        const list = res.data
        const superAdmins = []
        const admins = []
        list.forEach(u => {
          const name = u.nickName || '未设置昵称'
          if (u.role === 'super_admin') { superAdmins.push(name) }
          else if (u.role === 'admin') { admins.push(name) }
        })
        this.setData({
          allAdminNames: superAdmins.concat(admins),
          _superAdminOnly: superAdmins,
          _adminOnly: admins
        })
      }
    } catch (err) {
      console.error('加载超管信息失败', err)
    }
  },

  async showSuperAdminInfo() {
    if (this.data.allAdminNames.length === 0) {
      wx.showLoading({ title: '查询中...' })
      await this.loadSuperAdminInfo()
      wx.hideLoading()
    }
    this.setData({ showAdminModal: true })
  },

  closeAdminModal() { this.setData({ showAdminModal: false }) },

  loadNickname() {
    const nick = perm.getNickName() || ''
    this.setData({ nickName: nick })
    this.fetchNicknameInfo().then(() => {
      if (!this.data.nickName && !this._nickModalAutoShown) {
        this._nickModalAutoShown = true
        this.setData({ showNickModal: true, nickInputValue: '' })
      }
    })
  },

  async fetchNicknameInfo() {
    try {
      const res = await api.get('/users/me')
      if (res.success) {
        const serverNick = res.nickName || ''
        const count = res.nickChangeCount || 0
        const role = res.role || 'user'
        perm.setCache(role)
        if (serverNick && serverNick !== this.data.nickName) {
          perm.saveNickName(serverNick)
        }
        const isManager = role === 'super_admin' || role === 'admin'
        this.setData({
          nickName: serverNick || this.data.nickName,
          nickChangeCount: count,
          remainingCount: Math.max(0, this.data.nickChangeLimit - count),
          userRole: role,
          isAdmin: isManager,
          unlimitedNick: isManager
        })
      } else {
        this._applyRoleFallback()
      }
    } catch (err) {
      console.error('获取昵称信息失败', err)
      this._applyRoleFallback()
    }
  },

  _applyRoleFallback() {
    const role = perm.getRoleSync()
    if (role) {
      const isManager = role === 'super_admin' || role === 'admin'
      this.setData({ userRole: role, isAdmin: isManager, unlimitedNick: isManager })
    }
  },

  async editNickname() {
    const currentNick = this.data.nickName
    let openid = this.data.userOpenid
    if (!openid) {
      try {
        const app = getApp()
        if (!app.globalData.openid) { await app.getOpenId() }
        openid = app.globalData.openid || ''
      } catch (e) { }
    }
    this.setData({
      showNickModal: true,
      nickInputValue: currentNick || '',
      userOpenid: openid || ''
    })
  },

  closeNickModal() {
    this._nickModalAutoShown = true
    this.setData({ showNickModal: false, nickInputValue: '' })
  },

  onNickInput(e) { this.setData({ nickInputValue: e.detail.value }) },

  copyOpenid() {
    const openid = this.data.userOpenid
    if (!openid) return
    wx.setClipboardData({
      data: openid,
      success: () => { wx.showToast({ title: '已复制 OpenID', icon: 'success' }) }
    })
  },

  saveNickFromModal() {
    const newNick = this.data.nickInputValue.trim()
    const currentNick = this.data.nickName
    if (currentNick && !this.data.unlimitedNick && this.data.nickChangeCount >= this.data.nickChangeLimit) {
      wx.showToast({ title: '修改次数已用完，请联系超级管理员重置', icon: 'none', duration: 3000 })
      return
    }
    if (!newNick) { wx.showToast({ title: '昵称不能为空', icon: 'none' }); return }
    if (newNick === currentNick) { this.closeNickModal(); return }
    this.closeNickModal()
    this.doSaveNickname(newNick)
  },

  preventMove() { },

  async doSaveNickname(newNick) {
    wx.showLoading({ title: '保存中...' })
    try {
      const res = await api.put('/users/me/nickname', { nickName: newNick })
      wx.hideLoading()
      if (res.success) {
        perm.saveNickName(newNick)
        const newCount = res.nickChangeCount || 0
        this.setData({
          nickName: newNick,
          nickChangeCount: newCount,
          remainingCount: Math.max(0, this.data.nickChangeLimit - newCount)
        })
        setTimeout(() => { wx.showToast({ title: '昵称已更新', icon: 'success' }) }, 300)
      } else {
        if (res.nickChangeCount !== undefined) { this.setData({ nickChangeCount: res.nickChangeCount }) }
        setTimeout(() => { wx.showToast({ title: res.message || '修改失败', icon: 'none', duration: 2500 }) }, 300)
      }
    } catch (err) {
      wx.hideLoading()
      console.error('保存昵称失败', err)
      setTimeout(() => { wx.showToast({ title: '保存失败', icon: 'none' }) }, 300)
    }
  },

  // ———— 全局导航 ————
  onPullDownRefresh() {
    let promise
    if (this.data.currentGame === 'home') {
      promise = this.loadHomeData(true)
    } else {
      const tab = this.data.subTab
      if (tab === 'profile') { promise = this.loadAllPlayers() }
      else if (tab === 'rules') { promise = this.loadRuleEvents() }
      else if (tab === 'history') { promise = this.loadEvents(true) }
    }
    if (promise) { promise.then(() => wx.stopPullDownRefresh()).catch(() => wx.stopPullDownRefresh()) }
    else { wx.stopPullDownRefresh() }
  },

  onHide() {
    this.stopMarquee()
  },

  // ———— 公告栏跑马灯 ————
  startMarquee() {
    this.stopMarquee()
    const text = this.data.homeAnnounceText
    if (!text || text.length === 0) return
    const speed = 1.5; // rpx per tick
    this._marqueeTimer = setInterval(() => {
      let offset = this.data.marqueeOffset + speed
      if (offset > 6000) offset = 0
      this.setData({ marqueeOffset: offset })
    }, 30)
  },

  stopMarquee() {
    if (this._marqueeTimer) {
      clearInterval(this._marqueeTimer)
      this._marqueeTimer = null
    }
  },

  onReachBottom() {
    if (this.data.currentGame === 'home') return
    if (this.data.subTab === 'profile') { this.loadMore() }
    else if (this.data.subTab === 'history') { this.loadMoreEvents() }
  },

  switchGame(e) {
    const game = e.currentTarget.dataset.game
    if (game === this.data.currentGame) return
    this.setData({ currentGame: game })
    if (game === 'home') {
      this.loadHomeData()
      if (this.data.userRole === 'super_admin') { this.homeLoadUsers() }
    }
  },

  onGamePlusTap() {
    wx.showToast({ title: '更多精彩内容后续开放', icon: 'none', duration: 2000 })
  },

  async onRefreshTap() {
    wx.showLoading({ title: '刷新中...' })
    try {
      const tab = this.data.subTab
      if (tab === 'profile') { await this.loadAllPlayers() }
      else if (tab === 'rules') { await this.loadRuleEvents() }
      else if (tab === 'history') { await this.loadEvents(true) }
      else { await this.loadHomeData() }
      wx.hideLoading()
    } catch (e) { wx.hideLoading() }
  },

  switchSubTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (tab === this.data.subTab) return
    this.setData({ subTab: tab })
    if (tab === 'profile' && !this.data.loaded) {
      this.loadAllPlayers()
    } else if (tab === 'rules') {
      this.loadRuleEvents()
    } else if (tab === 'history') {
      this.loadEvents()
    }
  },

  // ———— 分享 ————
  onShareAppMessage() {
    return {
      title: '蜀国争霸系统 - 看看大家的Dota2段位！',
      path: '/pages/index/index'
    }
  }
}

// ———— 合并所有模块的 methods ————
Object.assign(pageConfig,
  playerModule.methods,
  eventModule.methods,
  homeModule.methods
)

Page(pageConfig)
