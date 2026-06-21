// ====== 蜀国争霸系统 · 首页核心页面 ======
// 按功能拆分为 3 个子模块: player(选手档案) / event(赛事) / home(首页数据+权限管理)
// 模块的 data 和 methods 通过 Object.assign 合并到本 Page 配置

const perm = require('../../utils/permission.js')
const C = require('../../utils/constants.js')
const api = require('../../utils/api.js')
const modal = require('../../utils/modal.js')

const playerModule = require('./modules/player-module.js')
const eventModule = require('./modules/event-module.js')
const homeModule = require('./modules/home-module.js')

// ====== 合并模块 data ======
const mergedData = Object.assign({},
  playerModule.data,
  eventModule.data,
  homeModule.data
)

// ====== Page 核心配置 ======
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
    _popupCount: 0,
  }, mergedData),

  // ====== 生命周期 ======
  onLoad(options) {
    const sysInfo = wx.getSystemInfoSync()
    this.setData({ statusBarHeight: sysInfo.statusBarHeight || 44 })
    if (options && options.subTab) {
      this.setData({ subTab: options.subTab })
    }
    // 先加载角色信息，再加载首页数据（依赖 userRole）
    this.loadNickname().then(() => {
      this.loadHomeData()
      // 如果有 subTab 参数，直接加载对应 Tab 数据
      if (options && options.subTab === 'history') {
        this.loadEvents()
      } else if (options && options.subTab === 'rules') {
        this.loadRuleEvents()
      }
    })
    // 选手列表和用户管理延迟到用户切换到对应 Tab 时加载
  },

  onShow() {
    if (this._needsReload) {
      this._needsReload = false
      if (this._reloadTimer) clearTimeout(this._reloadTimer)
      this._reloadTimer = setTimeout(() => { this.loadAllPlayers() }, 500)
    }
    if (this._nickMayBeChanged) {
      this._nickMayBeChanged = false
      this.fetchNicknameInfo()
    }
    // 节流：30 秒内不重复加载首页数据
    if (this.data.currentGame === 'home') {
      const now = Date.now()
      if (!this._lastHomeLoad || (now - this._lastHomeLoad) > 30000) {
        this._lastHomeLoad = now
        this.loadHomeData(true)
      }
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

  // ====== 页面锁定辅助（计数器模式，多个弹窗同时打开时不会误解锁） ======
  _lockPage() {
    this.data._popupCount = (this.data._popupCount || 0) + 1
    this.setData({ pageLocked: true })
  },
  _unlockPage() {
    this.data._popupCount = Math.max(0, (this.data._popupCount || 0) - 1)
    if (this.data._popupCount <= 0) {
      this.data._popupCount = 0
      this.setData({ pageLocked: false })
    }
  },

  // ====== 用户信息 / 昵称管理 ======
  loadUserInfo() {
    try {
      const info = wx.getStorageSync('user_info') || {}
      if (info.avatarUrl) { this.setData({ userInfo: info }) }
    } catch (e) {
      console.warn('[首页] 读取用户信息缓存失败', e)
    }
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
    this._lockPage()
  },

  closeAdminModal() { this.setData({ showAdminModal: false }); this._unlockPage() },

  loadNickname() {
    const nick = perm.getNickName() || ''
    this.setData({ nickName: nick })
    this.fetchNicknameInfo().then(() => {
      if (!this.data.nickName && !this._nickModalAutoShown) {
        this._nickModalAutoShown = true
        this.setData({ showNickModal: true, nickInputValue: '' })
        this._lockPage()
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
      } catch (e) {
        console.warn('[首页] 获取openid失败', e)
      }
    }
    this.setData({
      showNickModal: true,
      nickInputValue: currentNick || '',
      userOpenid: openid || ''
    })
    this._lockPage()
  },

  closeNickModal() {
    this._nickModalAutoShown = true
    this.setData({ showNickModal: false, nickInputValue: '' })
    this._unlockPage()
  },

  onNickInput(e) { this.setData({ nickInputValue: e.detail.value }) },

  copyOpenid() {
    const openid = this.data.userOpenid
    if (!openid) return
    wx.setClipboardData({
      data: openid,
      success: () => { modal.toast(this, { theme: 'success', content: '已复制 OpenID' }) }
    })
  },

  saveNickFromModal() {
    const newNick = this.data.nickInputValue.trim()
    const currentNick = this.data.nickName
    if (currentNick && !this.data.unlimitedNick && this.data.nickChangeCount >= this.data.nickChangeLimit) {
      modal.toast(this, { theme: 'warning', content: '修改次数已用完，请联系超级管理员重置', duration: 3000 })
      return
    }
    if (!newNick) { modal.toast(this, { theme: 'warning', content: '昵称不能为空' }); return }
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
        modal.toast(this, { theme: 'success', content: '昵称已更新' })
      } else {
        if (res.nickChangeCount !== undefined) { this.setData({ nickChangeCount: res.nickChangeCount }) }
        modal.toast(this, { theme: 'danger', content: res.error || res.message || '修改失败', duration: 2500 })
      }
    } catch (err) {
      wx.hideLoading()
      console.error('保存昵称失败', err)
      modal.toast(this, { theme: 'danger', content: '保存失败' })
    }
  },

  // ====== 全局导航 / 下拉刷新 / 触底 ======
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
    modal.toast(this, { theme: 'default', content: '更多精彩内容后续开放', duration: 2000 })
  },

  async onRefreshTap() {
    wx.showLoading({ title: '刷新中...' })
    try {
      if (this.data.currentGame === 'home') {
        await this.loadHomeData(true)
      } else {
        const tab = this.data.subTab
        if (tab === 'profile') { await this.loadAllPlayers() }
        else if (tab === 'rules') { await this.loadRuleEvents() }
        else if (tab === 'history') { await this.loadEvents(true) }
      }
      wx.hideLoading()
      modal.toast(this, { theme: 'success', content: '已刷新', duration: 1000 })
    } catch (e) {
      wx.hideLoading()
      modal.toast(this, { theme: 'danger', content: '刷新失败' })
    }
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

  // ====== 首页加载失败重试 ======
  retryLoadHome() {
    this.setData({ homeLoadError: false, homeDataLoaded: false })
    this.loadHomeData()
  },

  // ====== 分享 ======
  onShareAppMessage() {
    return {
      title: '蜀国争霸系统 - 看看大家的Dota2段位！',
      path: '/pages/index/index'
    }
  },

  onUnload() {
    if (this._reloadTimer) clearTimeout(this._reloadTimer);
  }
}

// ====== 合并所有模块 methods 并创建 Page 实例 ======
Object.assign(pageConfig,
  playerModule.methods,
  eventModule.methods,
  homeModule.methods
)

Page(pageConfig)
