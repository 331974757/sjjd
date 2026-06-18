// pages/dota2/dota2.js
const perm = require('../../utils/permission.js')
const R = require('../../utils/rank-utils.js')
const C = require('../../utils/constants.js')
const api = require('../../utils/api.js')
const modal = require('../../utils/modal.js')
const dt = require('../../utils/datetime-picker.js')
const pad2 = n => String(n).padStart(2, '0')

const RANK_ORDER = R.RANK_ORDER
const RANK_ICONS = R.RANK_ICONS
const RANK_LABELS = R.RANK_LABELS
const RANK_COLORS = R.RANK_COLORS

Page({
  data: {
    currentGame: 'dota2',
    subTab: 'profile',        // profile=选手档案, rules=赛事章程, history=历史赛事
    allPlayers: [],
    filteredPlayers: [],
    displayPlayers: [],
    positionFilter: 'all',
    rankFilter: 'all',
    sortFilter: 'rank-desc',
    filteredCount: 0,
    loaded: false,
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
    pageSize: C.PAGE_SIZE,
    morePageSize: C.MORE_PAGE_SIZE,
    hasMore: false,
    loadingMore: false,
    allAdminNames: [],          // 所有管理员名称（扁平数组，用于展示+寻路提示）
    _superAdminOnly: [],        // 仅超管（内部用于模态区分）
    _adminOnly: [],             // 仅普通管理员（内部用于模态区分）
    showChart: false,
    rankDistribution: [],
    deleteMode: false,
    selectedIds: {},
    selectedCount: 0,
    statusBarHeight: 44,
    _searchText: '',
    // 【第4轮新增】赛事章程 + 历史赛事列表
    rulesLoaded: false,
    rulesLoading: false,
    ruleEventList: [],           // 赛事章程：进行中赛事（archived=0）
    // 【第8轮增强】历史赛事：已归档赛事（archived=1）+ 搜索 + 分页
    eventsLoaded: false,
    eventsLoading: false,
    eventList: [],               // 历史赛事列表（当前页）
    eventTotal: 0,               // 历史赛事总数
    eventPage: 1,                // 当前页码
    eventHasMore: false,         // 是否有更多
    eventLoadingMore: false,     // 加载更多中
    historySearchText: '',       // 历史赛事搜索关键词
    historySearchTimer: null,    // 搜索防抖定时器
    eventStatusMap: perm.STATUS_NAMES,  // 【修复】使用共享常量，避免硬编码不一致
    // 【赛事创建】弹窗相关数据
    showCreateModal: false,       // 是否显示新建赛事弹窗
    createEventName: '',          // 赛事名称输入
    createEventDesc: '',          // 赛事简介输入
    createEventLimit: 0,            // 报名人数上限(0=无限制, -1=自定义)
    createEventLimitCustom: '',     // 自定义人数输入值
    // 日期时间多列选择器
    createDateTimeRange: [],
    createDateTimeIndex: [0, 0, 0, 12, 0],
    createDateTimeText: '',
  },

  onLoad(options) {
    const sysInfo = wx.getSystemInfoSync()
    this.setData({ statusBarHeight: sysInfo.statusBarHeight || 44 })
    // 支持从归档页跳转过来直接切到历史赛事
    if (options && options.subTab) {
      this.setData({ subTab: options.subTab })
    }
    this.loadNickname()
    this.loadUserInfo()
    this.loadAllPlayers()
    this.loadSuperAdminInfo()
  },

  onShow() {
    // 从其他页面返回时仅刷新昵称，不重新拉取数据（除非标记为脏）
    if (this._needsReload) {
      this._needsReload = false
      // 延迟刷新，避免页面转场动画期间 setData 打断 input 的内部状态
      if (this._reloadTimer) clearTimeout(this._reloadTimer)
      this._reloadTimer = setTimeout(() => { this.loadAllPlayers() }, 500)
    }
    // 仅当昵称可能被管理员修改时才拉取最新昵称信息
    if (this._nickMayBeChanged) {
      this._nickMayBeChanged = false
      this.fetchNicknameInfo()
    }
    // 当前在赛事章程/历史赛事Tab时，刷新对应列表
    if (this.data.subTab === 'rules') {
      this.loadRuleEvents()
    } else if (this.data.subTab === 'history') {
      this.loadEvents()
    }
  },

  loadUserInfo() {
    try {
      const info = wx.getStorageSync('user_info') || {}
      if (info.avatarUrl) {
        this.setData({ userInfo: info })
      }
    } catch(e) {}
  },

  // 加载管理员信息（公开接口，供用户联系）
  async loadSuperAdminInfo() {
    try {
      const res = await api.get('/users/admins/list')
      if (res.success && res.data) {
        const list = res.data
        const superAdmins = []
        const admins = []
        list.forEach(u => {
          const name = u.nickName || '未设置昵称'
          if (u.role === 'super_admin') {
            superAdmins.push(name)
          } else if (u.role === 'admin') {
            admins.push(name)
          }
        })
        const allNames = superAdmins.concat(admins)
        this.setData({
          allAdminNames: allNames,
          _superAdminOnly: superAdmins,
          _adminOnly: admins
        })
      }
    } catch (err) {
      console.error('加载超管信息失败', err)
    }
  },

  // 点击管理栏弹出管理员列表
  async showSuperAdminInfo() {
    if (this.data.allAdminNames.length === 0) {
      wx.showLoading({ title: '查询中...' })
      await this.loadSuperAdminInfo()
      wx.hideLoading()
    }
    this.setData({ showAdminModal: true })
  },
  closeAdminModal() {
    this.setData({ showAdminModal: false })
  },

  // 加载昵称和修改次数（首次用本地缓存，异步拉服务端最新值）
  loadNickname() {
    const nick = perm.getNickName() || ''
    this.setData({ nickName: nick })
    // 异步从服务端拉取最新 nickName + nickChangeCount
    this.fetchNicknameInfo().then(() => {
      // 仅 onLoad 首次加载时自动弹窗，且只弹一次
      if (!this.data.nickName && !this._nickModalAutoShown) {
        this._nickModalAutoShown = true
        this.setData({
          showNickModal: true,
          nickInputValue: ''
        })
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
        // 注入 perm 缓存，后续页面切换不再重复调API
        perm.setCache(role)
        // 服务端有昵称而本地没有，说明其他设备设置过，同步到本地
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
        // API 返回失败，尝试从缓存兜底
        this._applyRoleFallback()
      }
    } catch (err) {
      console.error('获取昵称信息失败', err)
      // 网络异常，从缓存兜底
      this._applyRoleFallback()
    }
  },

  // 从 perm 缓存回退角色信息
  _applyRoleFallback() {
    const role = perm.getRoleSync()
    if (role) {
      const isManager = role === 'super_admin' || role === 'admin'
      this.setData({
        userRole: role,
        isAdmin: isManager,
        unlimitedNick: isManager
      })
    }
  },

  // 点击修改昵称 → 始终打开弹窗（次数用完在弹窗内提示）
  async editNickname() {
    const currentNick = this.data.nickName
    // 获取 openid 展示
    let openid = this.data.userOpenid
    if (!openid) {
      try {
        const app = getApp()
        if (!app.globalData.openid) {
          await app.getOpenId()
        }
        openid = app.globalData.openid || ''
      } catch (e) {}
    }
    this.setData({
      showNickModal: true,
      nickInputValue: currentNick || '',
      userOpenid: openid || ''
    })
  },

  // 关闭昵称弹窗
  closeNickModal() {
    this._nickModalAutoShown = true  // 关闭后不再自动弹
    this.setData({ showNickModal: false, nickInputValue: '' })
  },

  // 输入框内容变化
  onNickInput(e) {
    this.setData({ nickInputValue: e.detail.value })
  },

  // 点击复制 openid
  copyOpenid() {
    const openid = this.data.userOpenid
    if (!openid) return
    wx.setClipboardData({
      data: openid,
      success: () => {
        wx.showToast({ title: '已复制 OpenID', icon: 'success' })
      }
    })
  },

  // 弹窗内点击保存
  saveNickFromModal() {
    const newNick = this.data.nickInputValue.trim()
    const currentNick = this.data.nickName

    // 非管理员且次数用完 → 拦截保存
    if (currentNick && !this.data.unlimitedNick && this.data.nickChangeCount >= this.data.nickChangeLimit) {
      wx.showToast({
        title: '修改次数已用完，请联系超级管理员重置',
        icon: 'none',
        duration: 3000
      })
      return
    }

    if (!newNick) {
      wx.showToast({ title: '昵称不能为空', icon: 'none' })
      return
    }
    if (newNick === currentNick) {
      this.closeNickModal()
      return
    }
    this.closeNickModal()
    this.doSaveNickname(newNick)
  },

  // 防止弹窗背景滚动
  preventMove() {},

  // 调用 API 保存昵称
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
        // 可能是超限被后端拒绝，刷新次数
        if (res.nickChangeCount !== undefined) {
          this.setData({ nickChangeCount: res.nickChangeCount })
        }
        setTimeout(() => { wx.showToast({ title: res.message || '修改失败', icon: 'none', duration: 2500 }) }, 300)
      }
    } catch (err) {
      wx.hideLoading()
      console.error('保存昵称失败', err)
      setTimeout(() => { wx.showToast({ title: '保存失败', icon: 'none' }) }, 300)
    }
  },

  /**
   * 下拉刷新：根据当前子Tab刷新对应数据
   */
  onPullDownRefresh() {
    const tab = this.data.subTab
    let promise
    if (tab === 'profile') {
      promise = this.loadAllPlayers()
    } else if (tab === 'rules') {
      promise = this.loadRuleEvents()
    } else if (tab === 'history') {
      promise = this.loadEvents(true)
    }
    if (promise) {
      promise.then(() => wx.stopPullDownRefresh()).catch(() => wx.stopPullDownRefresh())
    } else {
      wx.stopPullDownRefresh()
    }
  },

  // 滚到底部加载更多
  onReachBottom() {
    if (this.data.subTab === 'profile') {
      this.loadMore()
    } else if (this.data.subTab === 'history') {
      this.loadMoreEvents()
    }
  },

  /**
   * 全量拉取选手数据（一次性拉取，本地做分页/筛选/排序）
   * - 5秒超时锁防止请求卡死
   * - 失败后标记 loaded=true 避免永久 loading
   */
  async loadAllPlayers() {
    if (this._loading) return
    this._loading = true
    const lockTimer = setTimeout(() => { this._loading = false }, 5000)
    try {
      const res = await api.get('/players', { pageSize: 1000 })
      const all = (res.data || []).map(p => ({
        ...p,
        calibrateRankName: R.normalizeRankName(p.calibrateRankName)
      }))

      this.setData({ allPlayers: all, loaded: true })
      this.filterAndDisplay()
    } catch (err) {
      console.error('[选手数据] 加载失败', err)
      this.setData({ loaded: true })
      wx.showToast({ title: '加载失败', icon: 'none' })
    } finally {
      clearTimeout(lockTimer)
      this._loading = false
    }
  },

  // 从已排序的 filteredPlayers 中追加更多到 displayPlayers（修复：追加时附加 _rankIcon）
  loadMore() {
    if (this.data.loadingMore || !this.data.hasMore) return
    this.setData({ loadingMore: true })

    const filtered = this.data.filteredPlayers
    const current = this.data.displayPlayers
    const moreSize = this.data.morePageSize
    const nextItems = filtered.slice(current.length, current.length + moreSize).map(p => {
      const icon = R.getRankIcon(p.calibrateRankName)
      return { ...p, _rankIcon: icon, _rankIconIsImg: R.isRankIconImage(icon) }
    })

    if (nextItems.length > 0) {
      this.setData({
        displayPlayers: current.concat(nextItems),
        loadingMore: false,
        hasMore: current.length + nextItems.length < filtered.length
      })
    } else {
      this.setData({
        loadingMore: false,
        hasMore: false
      })
    }
  },

  // ====== 搜索 & 筛选 ======
  // 搜索输入存到内部变量，同步到 data 供 wxml 显示清除按钮
  onKeywordInput(e) {
    const val = e.detail.value || ''
    this._searchText = val
    this.setData({ _searchText: val })
    if (this._searchTimer) clearTimeout(this._searchTimer)
    this._searchTimer = setTimeout(() => {
      this.filterAndDisplay()
    }, 300)
  },

  onSearchConfirm(e) {
    if (this._searchTimer) clearTimeout(this._searchTimer)
    const val = e.detail.value || ''
    this._searchText = val
    this.setData({ _searchText: val })
    this.filterAndDisplay()
  },

  /**
   * 清除搜索关键词并重新渲染
   */
  clearSearch() {
    this._searchText = ''
    this.setData({ _searchText: '' })
    this.filterAndDisplay()
  },

  onPosFilter(e) {
    this.setData({ positionFilter: e.currentTarget.dataset.pos })
    this.filterAndDisplay()
  },

  onRankFilter(e) {
    this.setData({ rankFilter: e.currentTarget.dataset.rank })
    this.filterAndDisplay()
  },

  onSortToggle() {
    const next = this.data.sortFilter === 'rank-desc' ? 'rank-asc' : 'rank-desc'
    this.setData({ sortFilter: next })
    this.filterAndDisplay()
  },

  // 重置所有筛选条件
  resetFilters() {
    this._searchText = ''
    this.setData({
      _searchText: '',
      positionFilter: 'all',
      rankFilter: 'all',
      sortFilter: 'rank-desc'
    })
    this.filterAndDisplay()
  },

  switchGame(e) {
    const game = e.currentTarget.dataset.game
    if (game === this.data.currentGame) return
    this.setData({ currentGame: game })
  },

  // 点击游戏标签中间的 + 号
  onGamePlusTap() {
    wx.showToast({ title: '更多精彩内容后续开放', icon: 'none', duration: 2000 })
  },

  // 刷新按钮：重新加载当前页面数据
  async onRefreshTap() {
    wx.showLoading({ title: '刷新中...' })
    try {
      const tab = this.data.subTab
      if (tab === 'profile') {
        await this.loadAllPlayers()
      } else if (tab === 'rules') {
        await this.loadRuleEvents()
      } else if (tab === 'history') {
        await this.loadEvents(true)
      }
      wx.hideLoading()
    } catch (e) {
      wx.hideLoading()
    }
  },

  // 子分页切换
  switchSubTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (tab === this.data.subTab) return
    this.setData({ subTab: tab })
    // 切换到赛事章程时加载进行中赛事
    if (tab === 'rules') {
      this.loadRuleEvents()
    }
    // 切换到历史赛事时加载已归档赛事
    if (tab === 'history') {
      this.loadEvents()
    }
  },

  // 【修复】加载赛事章程列表（进行中赛事：archived=0）
  async loadRuleEvents() {
    if (this.data.rulesLoading) return
    this.setData({ rulesLoading: true })
    try {
      const res = await api.get('/events', { archived: 0, pageSize: 50 })
      if (res.success) {
        const list = (res.data || []).map(e => ({
          ...e,
          _statusName: this.data.eventStatusMap[e.event_status] || '未知',
          _timeLabel: this.formatEventTime(e.start_time)
        }))
        this.setData({ ruleEventList: list, rulesLoaded: true })
      }
    } catch (e) {
      console.error('[赛事章程] 加载失败', e)
      // 【OPT-P1修复】失败后保持未加载状态，允许后续切换tab或下拉重试
    } finally {
      this.setData({ rulesLoading: false })
    }
  },

  // 【第8轮增强】加载历史赛事列表（已归档赛事，使用增强接口含参赛人数+前三名）
  async loadEvents(reset = true) {
    if (this.data.eventsLoading) return
    // 重置时清空列表
    if (reset) {
      this.setData({ eventPage: 1, eventList: [], eventTotal: 0, eventHasMore: false })
    }
    this.setData({ eventsLoading: true })
    try {
      const params = {
        page: this.data.eventPage || 1,
        pageSize: 10
      }
      const kw = this.data.historySearchText ? this.data.historySearchText.trim() : ''
      if (kw) params.keyword = kw

      // 【第8轮】使用专用已归档赛事接口，返回参赛人数和前三名
      const res = await api.get('/events/archived', params)
      if (res.success) {
        const list = (res.data || []).map(e => ({
          ...e,
          _statusName: '名次归档',
          _timeLabel: this.formatEventTime(e.start_time),
          // 计算参赛总人数
          _signupCount: e.signupCount || 0,
          // 前三名队伍（topRanks 由接口直接返回）
          _topRanks: e.topRanks || []
        }))
        if (reset) {
          this.setData({ eventList: list })
        } else {
          this.setData({ eventList: [...this.data.eventList, ...list] })
        }
        this.setData({
          eventsLoaded: true,
          eventTotal: res.total || list.length,
          eventHasMore: (res.page * res.pageSize) < (res.total || 0)
        })
      }
    } catch (e) {
      console.error('[历史赛事] 加载失败', e)
      // 【OPT-P1修复】失败后不标记为loaded，允许后续切换tab时重试
      if (reset) this.setData({ eventsLoaded: false })
    } finally {
      this.setData({ eventsLoading: false })
    }
  },

  // 【第8轮新增】加载更多历史赛事（修复：先计算目标页码再 setData，避免异步 data 过期）
  async loadMoreEvents() {
    if (this.data.eventLoadingMore || !this.data.eventHasMore) return
    const nextPage = (this.data.eventPage || 1) + 1
    this.setData({ eventLoadingMore: true, eventPage: nextPage })
    try {
      await this.loadEvents(false) // 追加模式
    } finally {
      this.setData({ eventLoadingMore: false })
    }
  },

  // 【第8轮新增】历史赛事搜索输入（防抖300ms）
  onHistorySearchInput(e) {
    const val = e.detail.value || ''
    this.setData({ historySearchText: val })
    if (this._historySearchTimer) clearTimeout(this._historySearchTimer)
    this._historySearchTimer = setTimeout(() => {
      this.loadEvents(true)
    }, 300)
  },

  // 【第8轮新增】历史赛事搜索确认
  onHistorySearchConfirm(e) {
    if (this._historySearchTimer) clearTimeout(this._historySearchTimer)
    const val = e.detail.value || ''
    this.setData({ historySearchText: val })
    this.loadEvents(true)
  },

  // 【第8轮新增】清除历史赛事搜索
  clearHistorySearch() {
    // 【OPT-P2修复】如果当前已经是空搜索，不重复触发API请求
    const currentEmpty = !this.data.historySearchText || !this.data.historySearchText.trim()
    this.setData({ historySearchText: '' })
    if (!currentEmpty) {
      this.loadEvents(true)
    }
  },

  // 格式化赛事时间
  formatEventTime(ts) {
    if (!ts) return '待定'
    // 兼容多种格式：数字时间戳 / ISO字符串 / MySQL日期时间字符串
    let d
    if (typeof ts === 'number') {
      d = new Date(ts)
    } else if (typeof ts === 'string') {
      const norm = ts.trim().replace(' ', 'T')
      d = new Date(norm)
    } else {
      d = new Date(ts)
    }
    if (isNaN(d.getTime())) {
      const n = parseInt(ts)
      if (!isNaN(n) && n > 0) d = new Date(n > 10000000000 ? n : n * 1000)
      else return '待定'
    }
    const y = d.getFullYear()
    const M = pad2(d.getMonth() + 1)
    const D = pad2(d.getDate())
    const h = pad2(d.getHours())
    const m = pad2(d.getMinutes())
    // 如果是今年，不显示年份
    const now = new Date()
    if (y === now.getFullYear()) return M + '/' + D + ' ' + h + ':' + m
    return y + '/' + M + '/' + D + ' ' + h + ':' + m
  },

  // 【第4轮新增】跳转赛事详情页
  // 【第8轮增强】从历史赛事Tab跳转时携带 readonly=1 参数，强制纯只读模式
  goEventDetail(e) {
    const eventId = e.currentTarget.dataset.eventId
    if (!eventId) return
    // 如果是历史赛事Tab，添加 readonly 标记
    const isHistory = this.data.subTab === 'history'
    const extra = isHistory ? '&readonly=1&fromHistory=1' : ''
    wx.navigateTo({ url: '/pages/event-detail/event-detail?eventId=' + eventId + extra })
  },



  // 筛选 + 排序 + 显示
  filterAndDisplay() {
    let list = this.data.allPlayers.slice()
    const kw = (this._searchText || '').toLowerCase()
    const pos = this.data.positionFilter
    const rank = this.data.rankFilter
    const sort = this.data.sortFilter

    // 关键词搜索
    if (kw) {
      list = list.filter(p => {
        const name = (p.wxNickname || '').toLowerCase()
        const gid = (p.gameId || '').toLowerCase()
        return name.indexOf(kw) !== -1 || gid.indexOf(kw) !== -1
      })
    }

    // 位置筛选
    if (pos !== 'all') {
      const posNum = parseInt(pos)
      list = list.filter(p => {
        return p.goodAtPositions && p.goodAtPositions.indexOf(posNum) !== -1
      })
    }

    // 段位筛选
    if (rank !== 'all') {
      list = list.filter(p => {
        return R.getRankTier(p.calibrateRankName) === rank
      })
    }

    // 排序（按 calibrateRankSort 数值，越大段位越高）
    if (sort === 'rank-desc') {
      list.sort((a, b) => { return (b.calibrateRankSort || 0) - (a.calibrateRankSort || 0) })
    } else if (sort === 'rank-asc') {
      list.sort((a, b) => { return (a.calibrateRankSort || 0) - (b.calibrateRankSort || 0) })
    }

    // 【性能优化】仅在 displayPlayers 上附加 _rankIcon/_rankIconIsImg，避免对全量 filtered 做 map
    const pageSize = this.data.pageSize
    const firstPage = list.slice(0, pageSize).map(p => {
      const icon = R.getRankIcon(p.calibrateRankName)
      return { ...p, _rankIcon: icon, _rankIconIsImg: R.isRankIconImage(icon) }
    })

    this.setData({
      // filteredPlayers 保持原始对象引用（不含 _rankIcon 属性），减少内存占用
      filteredPlayers: list,
      displayPlayers: firstPage,
      filteredCount: list.length,
      hasMore: list.length > pageSize
    })
  },

  // ====== 导航 ======
  async goAdd() {
    if (!this.data.isAdmin) {
      const names = this.data.allAdminNames.join('、')
      await modal.confirm(this, {
        theme: 'warning',
        title: '仅管理员可添加选手',
        content: '请联系管理员添加选手：\n' + (names || '请稍后再试'),
        showCancel: false
      })
      return
    }
    this._needsReload = true
    wx.navigateTo({ url: '/pages/dota2-add/dota2-add' })
  },

  goDetail(e) {
    if (this.data.deleteMode) return
    const id = e.currentTarget.dataset.id
    this._needsReload = true
    wx.navigateTo({ url: '/pages/dota2-detail/dota2-detail?id=' + id })
  },

  goImport() {
    this._needsReload = true
    wx.navigateTo({ url: '/pages/dota2-import/dota2-import' })
  },

  // ⚙ 管理员菜单（导入/导出/批量删除/管理员设置）
  async showAdminMenu() {
    const isSuper = this.data.userRole === 'super_admin'
    const items = ['批量导入', '批量导出']
    if (isSuper) items.push('批量删除选手')
    const res = await modal.sheet(this, { title: '管理员操作', items: items.map(label => ({ label })) })
    if (!res.confirm) return
    const action = items[res.tapIndex]
    if (action === '批量导入') { this.goImport() }
    else if (action === '批量导出') { this.doExport() }
    else if (action === '批量删除选手') { this.toggleDeleteMode() }
  },

  // 跳转管理员页面
  goAdmin() {
    this._needsReload = true
    this._nickMayBeChanged = true
    wx.navigateTo({ url: '/pages/admin/admin' })
  },

  // ====== 段位分布饼图 ======
  toggleChart() {
    // 按一下打开，再按一下关闭
    const willShow = !this.data.showChart
    this.setData({ showChart: willShow })
    if (willShow) {
      this.computeRankDistribution()
      if (this._pieTimer) clearTimeout(this._pieTimer)
      this._pieTimer = setTimeout(() => { this.drawPieChart() }, 300)
    }
  },

  closeChart() {
    this.setData({ showChart: false })
  },

  computeRankDistribution() {
    const all = this.data.allPlayers
    const dist = {}
    for (let i = 0; i < all.length; i++) {
      const tier = R.getRankTier(all[i].calibrateRankName) || 'unknown'
      if (!dist[tier]) dist[tier] = 0
      dist[tier]++
    }
    const result = []
    for (let j = 0; j < RANK_ORDER.length; j++) {
      const key = RANK_ORDER[j]
      if (dist[key]) {
        const ico = RANK_ICONS[key]
        result.push({ tier: key, label: RANK_LABELS[key], icon: ico, iconIsImg: R.isRankIconImage(ico), count: dist[key], color: RANK_COLORS[j] })
      }
    }
    if (dist['unknown']) {
      result.push({ tier: 'unknown', label: '未定段位', icon: '❓', count: dist['unknown'], color: '#666' })
    }
    this.setData({ rankDistribution: result })
  },

  drawPieChart() {
    const query = wx.createSelectorQuery().in(this)
    query.select('#rankPieCanvas').fields({ node: true, size: true }).exec((res) => {
      if (!res || !res[0] || !res[0].node) return
      const canvas = res[0].node
      const ctx = canvas.getContext('2d')
      const dpr = wx.getSystemInfoSync().pixelRatio
      const width = res[0].width
      const height = res[0].height
      canvas.width = width * dpr
      canvas.height = height * dpr
      ctx.scale(dpr, dpr)

      const data = this.data.rankDistribution
      if (!data.length) return

      const cx = width / 2, cy = height / 2
      const outerR = Math.min(cx, cy) - 8
      const innerR = outerR * 0.45

      let total = 0
      for (let i = 0; i < data.length; i++) total += data[i].count

      // 绘制扇形（不显示内部数字）
      let startAngle = -Math.PI / 2
      for (let i = 0; i < data.length; i++) {
        const sweepAngle = (data[i].count / total) * Math.PI * 2
        ctx.beginPath()
        ctx.arc(cx, cy, outerR, startAngle, startAngle + sweepAngle)
        ctx.arc(cx, cy, innerR, startAngle + sweepAngle, startAngle, true)
        ctx.closePath()
        ctx.fillStyle = data[i].color
        ctx.fill()
        ctx.strokeStyle = '#0d1117'
        ctx.lineWidth = 1.5
        ctx.stroke()
        startAngle += sweepAngle
      }

      // 中心文字
      ctx.fillStyle = '#e6edf3'
      ctx.font = 'bold 14px sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('共' + total + '人', cx, cy)
    })
  },

  // ====== 批量删除 ======
  toggleDeleteMode() {
    const mode = !this.data.deleteMode
    this.setData({ deleteMode: mode, selectedIds: {}, selectedCount: 0 })
    if (!mode) {
      this.setData({ showChart: false })
    }
  },

  onSelectCard(e) {
    if (!this.data.deleteMode) return
    const id = e.currentTarget.dataset.id
    const selected = this.data.selectedIds
    if (selected[id]) {
      delete selected[id]
    } else {
      selected[id] = true
    }
    this.setData({ selectedIds: selected, selectedCount: Object.keys(selected).length })
  },

  async batchDelete() {
    const ids = Object.keys(this.data.selectedIds)
    if (ids.length === 0) {
      wx.showToast({ title: '请先选择要删除的选手', icon: 'none' })
      return
    }
    // 构建删除名单详情
    const players = this.data.allPlayers
    const names = ids.map(id => {
      const p = players.find(pl => { return pl._id === id })
      return p ? p.wxNickname : id
    }).join('、')
    const r = await modal.confirm(this, {
      theme: 'danger',
      title: '批量删除',
      content: '确定删除以下 ' + ids.length + ' 名选手？\n\n' + names + '\n\n此操作不可恢复！'
    })
    if (r.confirm) this.doBatchDelete(ids)
  },

  async doBatchDelete(ids) {
    wx.showLoading({ title: '删除中...' })
    try {
      const res = await api.post('/players/batch-delete', { ids: ids })
      wx.hideLoading()
      if (res.success) {
        setTimeout(() => { wx.showToast({ title: '已删除 ' + (res.deleted || ids.length) + ' 名选手', icon: 'success' }) }, 300)
        this.setData({ deleteMode: false, selectedIds: {}, selectedCount: 0 })
        this.loadAllPlayers()
      } else {
        setTimeout(() => { wx.showToast({ title: res.message || '删除失败', icon: 'none' }) }, 300)
      }
    } catch (err) {
      wx.hideLoading()
      console.error('批量删除失败', err)
      setTimeout(() => { wx.showToast({ title: '删除失败', icon: 'none' }) }, 300)
    }
  },

  // ====== 分享 ======
  onShareAppMessage() {
    return {
      title: '蜀国争霸系统 - 看看大家的Dota2段位！',
      path: '/pages/dota2/dota2'
    }
  },

  // ====== 【赛事创建】新建赛事弹窗逻辑 ======

  /**
   * 初始化日期时间选择器（默认1小时后）
   */
  _initCreateDateTimePicker() {
    const now = new Date()
    const range = dt.buildRange({ refYear: now.getFullYear(), yearSpan: 3, selYear: now.getFullYear(), selMonth: now.getMonth() + 1 })
    const idx = dt.buildIndex(Date.now() + 3600000, now.getFullYear())  // 默认1小时后
    const text = dt.toDisplayText(range, idx)
    this.setData({ createDateTimeRange: range, createDateTimeIndex: idx, createDateTimeText: text })
  },

  /**
   * 打开「新建赛事」弹窗（仅管理员可见入口）
   */
  showCreateEventModal() {
    this._initCreateDateTimePicker()
    this.setData({
      showCreateModal: true,
      createEventName: '',
      createEventDesc: '',
      createEventLimit: 0,
      createEventLimitCustom: ''
    })
  },

  /**
   * 关闭「新建赛事」弹窗，重置表单
   */
  closeCreateEventModal() {
    this.setData({
      showCreateModal: false,
      createEventName: '',
      createEventDesc: '',
      createEventLimit: 0,
      createEventLimitCustom: '',
      createDateTimeText: ''
    })
  },

  /**
   * 赛事名称输入绑定
   */
  onCreateEventNameInput(e) {
    this.setData({ createEventName: e.detail.value })
  },

  /**
   * 日期时间选择器：列滚动时动态调整日数
   */
  onCreateDateTimeColumnChange(e) {
    const { column, value } = e.detail
    const result = dt.onColumnChange(this.data.createDateTimeRange, this.data.createDateTimeIndex, column, value)
    this.setData({ createDateTimeRange: result.range, createDateTimeIndex: result.idx })
  },

  /**
   * 日期时间选择器确认 → 更新显示文本
   */
  onCreateDateTimeChange(e) {
    const idx = e.detail.value
    const text = dt.toDisplayText(this.data.createDateTimeRange, idx)
    this.setData({ createDateTimeIndex: idx, createDateTimeText: text })
  },

  /**
   * 赛事简介输入绑定（多行文本）
   */
  onCreateEventDescInput(e) {
    this.setData({ createEventDesc: e.detail.value })
  },

  /**
   * 报名人数上限选项点击
   */
  pickEventLimit(e) {
    const val = parseInt(e.currentTarget.dataset.val)
    this.setData({ createEventLimit: val })
    if (val !== -1) {
      this.setData({ createEventLimitCustom: '' })
    }
  },

  /**
   * 自定义人数输入绑定
   */
  onCreateEventLimitCustomInput(e) {
    this.setData({ createEventLimitCustom: e.detail.value })
  },

  /**
   * 【核心】提交创建赛事
   * 1. 前端校验：赛事名称必填、2-50 字符
   * 2. 日期时间选择器 → 毫秒时间戳
   * 3. 调用 POST /api/events
   * 4. 成功 → 关闭弹窗 + 刷新赛事章程列表 + 跳转详情页
   */
  async submitCreateEvent() {
    // ── 校验1：赛事名称非空 ──
    const name = (this.data.createEventName || '').trim()
    if (!name) {
      wx.showToast({ title: '请输入赛事名称', icon: 'none' })
      return
    }

    // ── 校验2：长度 2-50 字符 ──
    if (name.length < 2) {
      wx.showToast({ title: '赛事名称至少需要2个字符', icon: 'none' })
      return
    }
    if (name.length > 50) {
      wx.showToast({ title: '赛事名称不能超过50个字符', icon: 'none' })
      return
    }

    // ── 构造请求参数：日期时间选择器 → 毫秒时间戳 ──
    let startTime = null
    if (this.data.createDateTimeRange.length > 0 && this.data.createDateTimeIndex.length > 0) {
      startTime = dt.toTimestamp(this.data.createDateTimeRange, this.data.createDateTimeIndex)
      if (isNaN(startTime)) startTime = null
    }

    const desc = (this.data.createEventDesc || '').trim()

    // 报名人数上限处理
    let signupLimit = null
    if (this.data.createEventLimit > 0) {
      signupLimit = this.data.createEventLimit
    } else if (this.data.createEventLimit === -1 && this.data.createEventLimitCustom) {
      const custom = parseInt(this.data.createEventLimitCustom)
      if (!isNaN(custom) && custom > 0) {
        signupLimit = custom
      }
    }

    wx.showLoading({ title: '创建中...', mask: true })

    try {
      const res = await api.post('/events', {
        event_name: name,
        start_time: startTime,
        event_desc: desc || undefined,
        signup_limit: signupLimit
      })

      wx.hideLoading()

      if (res.success) {
        // 关闭弹窗
        this.setData({ showCreateModal: false })

        wx.showToast({ title: '赛事创建成功', icon: 'success', duration: 1500 })

        // 刷新赛事章程列表
        this.loadRuleEvents()

        // 延迟跳转详情（确保 toast 可见）
        const eventId = (res.data && res.data.eventId) ? res.data.eventId : null
        if (eventId) {
          setTimeout(() => {
            wx.navigateTo({
              url: '/pages/event-detail/event-detail?eventId=' + eventId
            })
          }, 800)
        }
      } else {
        wx.showToast({ title: res.error || '创建失败', icon: 'none', duration: 2000 })
      }
    } catch (err) {
      wx.hideLoading()
      console.error('[赛事创建] 失败', err)
      wx.showToast({ title: '网络错误，请重试', icon: 'none' })
    }
  },

  // 批量导出（JSON数据 → CSV）
  async doExport() {
    wx.showLoading({ title: '导出中...' })
    try {
      const res = await api.get('/players/export/all')
      wx.hideLoading()
      
      if (!res) {
        wx.showToast({ title: '服务器无响应', icon: 'none' })
        return
      }
      if (!res.success) {
        wx.showToast({ title: res.error || res.message || '导出失败', icon: 'none' })
        return
      }
      const players = res.data
      if (!players || !Array.isArray(players) || players.length === 0) {
        wx.showToast({ title: '暂无选手数据', icon: 'none' })
        return
      }
      
      const count = players.length
      // 生成CSV
      const header = '微信群昵称,Steam ID,Dota2游戏昵称,核准段位,核准星数,擅长位置,报名位置'
      const escapeCSV = (v) => {
        const s = String(v == null ? '' : v)
        return s.indexOf(',') >= 0 || s.indexOf('"') >= 0 || s.indexOf('\n') >= 0 ? '"' + s.replace(/"/g, '""') + '"' : s
      }
      const rows = players.map(p => {
        const pos = Array.isArray(p.goodAtPositions) ? p.goodAtPositions.join(';') : (p.goodAtPositions || '')
        const sp = Array.isArray(p.signupPosition) ? p.signupPosition.join(';') : (p.signupPosition || '')
        return [p.wxNickname, p.steamId, p.gameId, p.calibrateRankName, p.calibrateRankStar, pos, sp].map(escapeCSV).join(',')
      })
      const csv = '\ufeff' + header + '\n' + rows.join('\n')
      
      // 写入文件
      let filePath = ''
      try {
        const fs = wx.getFileSystemManager()
        const userPath = (wx.env && wx.env.USER_DATA_PATH) || ''
        filePath = userPath + '/dota2_export_' + Date.now() + '.csv'
        fs.writeFileSync(filePath, csv, 'utf8')
      } catch (fileErr) {
        console.error('[导出] 文件写入失败:', fileErr)
        // 备选方案：直接复制到剪贴板
        wx.setClipboardData({
          data: csv,
          success: () => {
            wx.showToast({ title: '已复制 ' + count + ' 条数据到剪贴板', icon: 'success', duration: 2500 })
          },
          fail: () => {
            wx.showToast({ title: '导出失败，请重试', icon: 'none' })
          }
        })
        return
      }
      
      // 弹窗询问是否打开
      setTimeout(async () => {
        const modalRes = await modal.confirm(this, {
          theme: 'success',
          title: '导出成功',
          content: '共导出 ' + count + ' 名选手数据',
          confirmText: '打开文件',
          cancelText: '关闭'
        })
        if (modalRes.confirm && filePath) {
          wx.openDocument({ 
            filePath: filePath, 
            showMenu: true,
            fail: (err) => {
              console.error('[导出] 打开文件失败:', err)
              wx.showToast({ title: '打开失败，文件已保存', icon: 'none' })
            }
          })
        }
      }, 300)
    } catch (err) {
      wx.hideLoading()
      console.error('[导出] 异常:', err)
      wx.showToast({ title: '导出失败: ' + (err.message || '未知错误'), icon: 'none', duration: 2500 })
    }
  }
})


