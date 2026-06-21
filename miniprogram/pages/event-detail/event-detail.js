// ============================================================
// pages/event-detail/event-detail.js
// 【赛事详情 - 模块化重构版】
// 5个Tab模块拆分为独立文件，核心页面负责生命周期+Tab调度+权限
// ============================================================
const api = require('../../utils/api.js')
const perm = require('../../utils/permission.js')
const R = require('../../utils/rank-utils.js')
const C = require('../../utils/constants.js')
const dt = require('../../utils/datetime-picker.js')
const modal = require('../../utils/modal.js')

// 加载所有Tab模块
const tabOverview = require('./tab-overview.js')
const tabSignups = require('./tab-signups.js')
const tabTeams = require('./tab-teams.js')
const tabMatches = require('./tab-matches.js')
const tabRanks = require('./tab-ranks.js')

// 收集所有Tab的数据和方法
const tabModules = [tabOverview, tabSignups, tabTeams, tabMatches, tabRanks]

// 合并所有Tab的data
function mergeTabData() {
  const merged = {}
  tabModules.forEach(mod => {
    if (mod.data) Object.assign(merged, mod.data)
  })
  return merged
}

// 合并所有Tab的方法
function mergeTabMethods(pageObj) {
  tabModules.forEach(mod => {
    if (mod.methods) Object.assign(pageObj, mod.methods)
  })
}

// ════════════════════════════════════════════════════════════
// 核心 Page 配置
// ════════════════════════════════════════════════════════════
const coreMethods = {

  // ============ 页面数据 ============
  data: Object.assign({
    // 基础
    eventId: '',
    event: null,
    loaded: false,
    userRole: '',
    isAdmin: false,
    isSuperAdmin: false,
    readonly: false,
    fromHistory: false,

    // ===== Tab系统 =====
    tabs: [
      { key: 'overview', label: '赛事概览', unlockStatus: 0 },
      { key: 'signups', label: '报名管理', unlockStatus: 1 },
      { key: 'teams', label: '分组编队', unlockStatus: 2 },
      { key: 'matches', label: '对阵对战', unlockStatus: 3 },
      { key: 'ranks', label: '名次归档', unlockStatus: 5 }
    ],
    activeTab: 'overview',
    activeTabIndex: 0,

    // 操作 loading
    loading: false,

    // 进度条
    progressSteps: [],
    progressLabel: '',

    // 其他基础数据
    isArchived: false,
    _cloning: false,
    showNameModal: false,
    showDescModal: false,
    showTimeModal: false,
  }, mergeTabData()),

  // ============ 生命周期 ============
  onLoad(options) {
    const eventId = options.eventId || options.id || ''
    if (!eventId) {
      modal.toast(this, { title: '赛事ID缺失', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 1500)
      return
    }
    const readonly = options.readonly === '1' || options.readonly === 'true'
    const fromHistory = options.fromHistory === '1' || options.fromHistory === 'true'
    if (readonly) {
      wx.setNavigationBarTitle({ title: '历史赛事详情' })
    }
    this.setData({ eventId, readonly, fromHistory })
    this.initPage()
  },

  onShow() {
    if (!this.data.eventId || !this.data.loaded) return

    const app = getApp()
    const lastShow = app.globalData._lastShowTime || 0
    const now = Date.now()

    // 如果从小程序后台切回（间隔超过 60 秒），全量刷新
    if (lastShow && (now - lastShow) > 60000) {
      this.setData({ loaded: false })
      this.initPage()
      return
    }

    // 回页刷新：但 15 秒内不重复请求
    if (this._lastRefresh && (now - this._lastRefresh) < 15000) return
    this._lastRefresh = now

    this.loadEvent().then(() => {
      if (this.data.event) this._refreshTabData()
    })
  },

  /** 手动刷新按钮 */
  async onRefreshTap() {
    // 清除 Tab 缓存强制重新加载
    this._tabSignupsLoaded = this._tabTeamsLoaded = this._tabMatchesLoaded = this._tabRanksLoaded = false
    wx.showLoading({ title: '刷新中...', mask: true })
    try {
      await this.loadEvent()
      this._updateTabLocks()
      this._updateActions()
      await this._loadTabData(this.data.activeTab)
    } catch (e) {
      modal.toast(this, { title: '刷新失败', icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },

  // ============ 初始化 ============
  async initPage() {
    try {
      if (this.data.readonly) {
        this.setData({ userRole: 'anonymous', isAdmin: false, isSuperAdmin: false })
      } else {
        const role = await perm.getRole()
        const isAdmin = role === 'admin' || role === 'super_admin'
        this.setData({ userRole: role, isAdmin, isSuperAdmin: role === 'super_admin' })
      }
      await this.loadEvent()
      this._updateTabLocks()
      this._updateActions()
      const tab = this.data.readonly ? 'overview' : this.data.tabs.find(t => !t._locked)?.key || 'overview'
      await this._loadTabData(tab)
      this._switchToTab(tab)
      this.setData({ loaded: true })
    } catch (e) {
      console.error('[赛事详情] 初始化失败', e)
      modal.toast(this, { title: '加载失败，请重试', icon: 'none' })
    }
  },

  async loadEvent() {
    try {
      const res = await api.get('/events/' + this.data.eventId)
      if (res.success) {
        const event = res.data
        event._statusName = perm.STATUS_NAMES[event.event_status] || '未知'
        event._timeLabel = this.formatTime(event.start_time)
        const isArchived = event.is_archived === 1 || event.event_status >= 6
        this.setData({ event, isArchived })
        this._updateProgressSteps()
        this._computeOverviewJump()
        this.startEditTime()
        // startEditTime 已内部设置 editingTime: true，概览不需要编辑态
        // 预加载报名人数供概览显示
        this.loadSignups()
      } else {
        modal.toast(this, { title: '赛事不存在或已删除', icon: 'none' })
        setTimeout(() => wx.navigateBack(), 1500)
      }
    } catch (e) {
      console.error('[赛事详情] 加载失败', e)
      modal.toast(this, { title: '加载赛事失败', icon: 'none' })
    }
  },

  // ============ Tab 系统 ============
  _updateTabLocks() {
    const { event, readonly } = this.data
    const status = event ? event.event_status : 0
    const tabs = this.data.tabs.map(t => {
      const unlocked = readonly ? t.key === 'overview' : status >= t.unlockStatus
      const unlockedFlag = status >= t.unlockStatus
      return { ...t, _locked: !unlocked, _unlocked: unlockedFlag }
    })
    this.setData({ tabs })
  },

  _updateProgressSteps() {
    const { event } = this.data
    if (!event) return
    const status = event.event_status
    const steps = Object.values(perm.STATUS_NAMES).map((name, i) => {
      let state = 'pending'
      if (i < status) state = 'done'
      else if (i === status) state = 'active'
      return { label: name, state }
    })
    this.setData({ progressSteps: steps, progressLabel: perm.STATUS_NAMES[status] || '未知' })
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab
    this._switchToTab(tab)
  },

  _switchToTab(tab) {
    const idx = this.data.tabs.findIndex(t => t.key === tab)
    if (idx < 0) return
    const tabDef = this.data.tabs[idx]
    if (tabDef._locked) {
      modal.toast(this, { title: '当前赛事状态未到"' + tabDef.label + '"阶段', icon: 'none' })
      return
    }
    // 如果 Tab 已解锁但未到完全开放（status < unlockStatus），给提示但不阻止
    if (!tabDef._unlocked) {
      // 不阻止，允许预览
    }
    this.setData({ activeTab: tab, activeTabIndex: idx })
    this._loadTabData(tab)
  },

  async _loadTabData(tab) {
    switch (tab) {
      case 'overview':
        this._computeOverviewJump()
        break
      case 'signups':
        if (!this._tabSignupsLoaded) { this._tabSignupsLoaded = true; this.loadSignups() }
        // mySignup 每次都要刷新（轻量接口 + 用户可能在别处报名了）
        this.loadMySignup()
        break
      case 'teams':
        this._tabTeamsLoaded = true; this.loadTeams()
        break
      case 'matches':
        this._tabMatchesLoaded = true; this.loadBattleData()
        break
      case 'ranks':
        this._tabRanksLoaded = true; this.loadRanks(); if (!this.data.readonly) this.loadRankTeamCards()
        break
    }
  },

  _refreshTabData() {
    const tab = this.data.activeTab
    this._loadTabData(tab)
  },

  // ============ 权限（复用统一权限检查器） ============
  _updateActions() {
    const event = this.data.event
    const isAdmin = this.data.isAdmin
    const readonly = this.data.readonly
    if (!event) return

    const role = readonly ? 'anonymous' : this.data.userRole
    const opts = {
      eventStatus: event.event_status,
      isArchived: this.data.isArchived ? 1 : 0,
      userRole: role
    }
    const actions = perm.checkActions([
      'edit_event', 'change_status', 'manage_signups', 'manage_teams',
      'manage_matches', 'manage_ranks', 'lock_teams', 'archive_event',
      'delete_event', 'signup', 'cancel_signup'
    ], opts)

    // 非管理员仅禁用管理类操作，保留用户自主报名/取消报名权限
    if (!readonly && !isAdmin) {
      var adminOnlyActions = ['edit_event', 'change_status', 'manage_signups', 'manage_teams',
        'manage_matches', 'manage_ranks', 'lock_teams', 'archive_event', 'delete_event']
      for (var i = 0; i < adminOnlyActions.length; i++) {
        var key = adminOnlyActions[i]
        if (actions[key]) actions[key].allowed = false
      }
    }

    this.setData({
      actions,
      signupBtn: actions.signup,
      cancelSignupBtn: actions.cancel_signup
    })
  },

  // ============ 赛事名&简介内联编辑 ============
  // 赛事名称编辑
  startEditName() { this.setData({ editingName: true, editNameValue: this.data.event.event_name || '' }) },
  cancelEditName() { this.setData({ editingName: false, editNameValue: '' }) },
  onEditNameInput(e) { this.setData({ editNameValue: e.detail.value }) },
  async confirmEditName() {
    const val = (this.data.editNameValue || '').trim()
    if (!val || val.length < 2) { modal.toast(this, { title: '赛事名称至少2个字符', icon: 'none' }); return }
    if (val.length > 50) { modal.toast(this, { title: '赛事名称不能超过50个字符', icon: 'none' }); return }
    this.setData({ editingName: false })
    try {
      const res = await api.put('/events/' + this.data.eventId, { eventName: val })
      if (res.success) { await this.loadEvent() }
      else { modal.toast(this, { title: res.error || '更新失败', icon: 'none' }) }
    } catch (e) { modal.toast(this, { title: '更新失败，请重试', icon: 'none' }) }
  },

  // 赛事简介编辑
  startEditDesc() { this.setData({ editingDesc: true, editDescValue: this.data.event.event_desc || '' }) },
  cancelEditDesc() { this.setData({ editingDesc: false, editDescValue: '' }) },
  onEditDescInput(e) { this.setData({ editDescValue: e.detail.value }) },
  async confirmEditDesc() {
    const val = (this.data.editDescValue || '').trim()
    this.setData({ editingDesc: false })
    try {
      const res = await api.put('/events/' + this.data.eventId, { eventDesc: val })
      if (res.success) { await this.loadEvent() }
      else { modal.toast(this, { title: res.error || '更新失败', icon: 'none' }) }
    } catch (e) { modal.toast(this, { title: '更新失败，请重试', icon: 'none' }) }
  },

  // 比赛时间编辑
  startEditTime() {
    const { event } = this.data
    const ts = event.start_time
    const now = new Date()
    const refYear = now.getFullYear()
    // 兼容 DATETIME 字符串和毫秒时间戳
    let d
    if (!ts) {
      d = new Date(Date.now() + 3600000)
    } else if (typeof ts === 'number' || !isNaN(Number(ts))) {
      d = new Date(Number(ts) > 10000000000 ? Number(ts) : Number(ts) * 1000)
    } else {
      d = new Date(ts)
    }
    if (isNaN(d.getTime())) return
    const range = dt.buildRange({ refYear, yearSpan: 3, selYear: d.getFullYear(), selMonth: d.getMonth() + 1 })
    const idx = dt.buildIndex(d.getTime(), refYear)
    const text = dt.toDisplayText(range, idx)
    this.setData({ editDateTimeRange: range, editDateTimeIndex: idx, editDateTimeText: text })
  },
  cancelEditTime() { this.setData({ editingTime: false }) },
  onEditDateTimeColumnChange(e) {
    const { column, value } = e.detail
    const result = dt.onColumnChange(this.data.editDateTimeRange, this.data.editDateTimeIndex, column, value)
    this.setData({ editDateTimeRange: result.range, editDateTimeIndex: result.idx })
  },
  onEditDateTimeChange(e) {
    const idx = e.detail.value
    const text = dt.toDisplayText(this.data.editDateTimeRange, idx)
    this.setData({ editDateTimeIndex: idx, editDateTimeText: text })
    // picker 确认后自动保存
    this.confirmEditTime()
  },
  async confirmEditTime() {
    const range = this.data.editDateTimeRange
    const idx = this.data.editDateTimeIndex
    if (!range || range.length < 5) return
    // 从 range/idx 直接构建 "YYYY-MM-DD HH:mm:ss"
    const y = parseInt(range[0][idx[0]]) || 0
    const mo = parseInt(range[1][idx[1]]) || 1
    const d = parseInt(range[2][idx[2]]) || 1
    const h = parseInt(range[3][idx[3]]) || 0
    const mi = parseInt(range[4][idx[4]]) || 0
    const startTime = `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')} ${String(h).padStart(2,'0')}:${String(mi).padStart(2,'0')}:00`
    this.setData({ editingTime: false })
    try {
      const res = await api.put('/events/' + this.data.eventId, { startTime })
      if (res.success) { await this.loadEvent() }
      else { modal.toast(this, { title: res.error || '更新失败', icon: 'none' }) }
    } catch (e) { modal.toast(this, { title: '更新失败，请重试', icon: 'none' }) }
  },

  // 取消赛事弹窗
  showCancelEvent() { this.setData({ showCancelEventModal: true }) },
  hideCancelEvent() { this.setData({ showCancelEventModal: false }) },
  async doCancelEvent() {
    this.setData({ showCancelEventModal: false, loading: true })
    try {
      const res = await api.del('/events/' + this.data.eventId)
      this.setData({ loading: false })
      if (res.success) { modal.toast(this, { title: '赛事已取消', icon: 'success' }); setTimeout(() => wx.navigateBack(), 1500) }
      else { modal.toast(this, { title: res.error || '取消失败', icon: 'none' }) }
    } catch (e) { this.setData({ loading: false }); modal.toast(this, { title: '取消失败，请重试', icon: 'none' }) }
  },

  /** 克隆赛事（仅归档赛事可用） */
  async cloneEvent() {
    if (this._cloning) return; this._cloning = true
    this.setData({ _cloning: true })
    try {
      const res = await api.post('/events/' + this.data.eventId + '/clone')
      this.setData({ _cloning: false })
      if (res.success) {
        modal.toast(this, { title: res.message || '克隆成功', icon: 'success' })
        // 跳转到新创建的赛事
        setTimeout(() => {
          wx.redirectTo({ url: '/pages/event-detail/event-detail?eventId=' + res.data.eventId })
        }, 800)
      } else {
        modal.toast(this, { title: res.error || '克隆失败', icon: 'none' })
      }
    } catch (e) {
      this.setData({ _cloning: false })
      modal.toast(this, { title: '克隆失败', icon: 'none' })
    }
  },

  // 确认开战弹窗（供Tab4 method调用）
  async showBattleConfirm(title, lines, note) {
    return new Promise(resolve => {
      this.setData({
        showBattleConfirmModal: true,
        _battleConfirmTitle: title,
        _battleConfirmLines: lines,
        _battleConfirmNote: note,
        _battleConfirmCallback: (confirmed) => {
          this.setData({ showBattleConfirmModal: false })
          resolve(confirmed)
        }
      })
    })
  },
  onBattleConfirmYes() {
    const cb = this.data._battleConfirmCallback
    this.setData({ showBattleConfirmModal: false })
    if (cb) cb(true)
  },
  onBattleConfirmOk() { this.onBattleConfirmYes() },
  onBattleConfirmNo() {
    const cb = this.data._battleConfirmCallback
    this.setData({ showBattleConfirmModal: false })
    if (cb) cb(false)
  },
  onBattleConfirmCancel() { this.onBattleConfirmNo() },

  // ============ 工具函数 ============
  getStatusName(status) {
    return perm.STATUS_NAMES[status] || ''
  },

  getStatusClass(status) {
    const map = { 0: 'status-0', 1: 'status-1', 2: 'status-2', 3: 'status-3', 4: 'status-4', 5: 'status-5', 6: 'status-6' }
    return map[status] || ''
  },

  formatTime(ts) {
    if (!ts) return '待定'
    let d
    if (typeof ts === 'number') { d = new Date(ts > 10000000000 ? ts : ts * 1000) }
    else { const norm = String(ts).trim().replace(' ', 'T'); d = new Date(norm) }
    if (isNaN(d.getTime())) return '待定'
    const y = d.getFullYear(); const M = C.pad(d.getMonth() + 1); const D = C.pad(d.getDate())
    const h = C.pad(d.getHours()); const m = C.pad(d.getMinutes())
    const now = new Date()
    return y === now.getFullYear() ? M + '/' + D + ' ' + h + ':' + m : y + '/' + M + '/' + D + ' ' + h + ':' + m
  },

  getBtnDisabledReason(event) {
    if (!event) return '未知'
    const s = event.event_status
    if (s === 2) return '报名已截止'
    if (s >= 3) return '赛事已进入' + (this.getStatusName(s) || '后期')
    return '当前不可操作'
  },

  // ============ 通用 ============
  onShareAppMessage() {
    const event = this.data.event
    return {
      title: (event ? event.event_name : '赛事详情') + ' - 蜀国争霸系统',
      path: '/pages/event-detail/event-detail?eventId=' + this.data.eventId
    }
  },
  preventMove() {},
  onPullDownRefresh() {
    this.loadEvent().then(() => {
      this._updateTabLocks()
      this._updateActions()
      this._loadTabData(this.data.activeTab).finally(() => wx.stopPullDownRefresh())
    }).catch(() => wx.stopPullDownRefresh())
  }
}

// 合并所有Tab方法到coreMethods
mergeTabMethods(coreMethods)

// 注册页面
// 注意：WXML模板需要用相同的变量名访问合并后的data
// data已通过Object.assign合并了所有tab的data
Page(coreMethods)
