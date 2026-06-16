// ============================================================
// pages/event-detail/event-detail.js
// 【赛事详情 - 阶段式Tab分栏重构版】
// 5个Tab按赛事业务流程排列，随状态递进解锁
// 严格复用所有现有后端接口与权限系统，仅重构前端页面结构
// ============================================================
const api = require('../../utils/api.js')
const perm = require('../../utils/permission.js')
const R = require('../../utils/rank-utils.js')

// 位置格式化：优先 signup_position（报名位置），其次 good_at_positions → "1,2号位"
function formatPosition(p) {
  let pos = p.signup_position || p.signupPosition || p.good_at_positions || ''
  if (!pos) return ''
  if (Array.isArray(pos)) pos = pos.join(',')
  if (typeof pos !== 'string') return ''
  pos = pos.trim()
  if (!pos) return ''
  return pos + '号位'
}




// 工具：数字补零
const pad = n => String(n).padStart(2, '0')

Page({
  // ============ 页面数据 ============
  data: {
    // 基础
    eventId: '',
    event: null,
    loaded: false,
    userRole: '',
    isAdmin: false,
    readonly: false,
    fromHistory: false,

    // ===== Tab系统 =====
    // Tab定义: {key, label, unlockStatus} — unlockStatus为解锁所需的最小event_status
    tabs: [
      { key: 'overview', label: '赛事概览', unlockStatus: 0 },
      { key: 'signups', label: '报名管理', unlockStatus: 1 },
      { key: 'teams', label: '分组编组', unlockStatus: 2 },
      { key: 'matches', label: '对阵对战', unlockStatus: 4 },
      { key: 'ranks', label: '名次归档', unlockStatus: 5 }
    ],
    activeTab: 'overview',
    activeTabIndex: 0,

    // 操作 loading
    loading: false,

    // ===== Tab1: 赛事概览 =====
    // (复用 event + actions 数据)
    // 内联编辑
    editingName: false,
    editNameValue: '',
    editingDesc: false,
    editDescValue: '',

    // ===== Tab2: 报名管理 =====
    signups: [],           // 报名列表
    signupCount: 0,
    signupPage: 1,         // 当前分页页码
    signupPageSize: 10,    // 每页10人
    signupTotal: 0,        // 总报名人数
    signupHasMore: false,  // 是否有更多页
    signupLoadingMore: false, // 正在加载更多
    mySignup: null,        // 当前用户报名状态
    mySignupLoaded: false, // mySignup 是否已尝试加载（用于 WXML 避免闪烁）
    showCancelConfirm: false,
    // 搜索选手（管理员手动添加用）
    searchKeyword: '',
    searchResults: [],
    searchLoading: false,
    addLoading: false,
    // 剔除确认
    removeTarget: null,    // 待剔除报名对象

    // ===== Tab3: 分组编组 =====
    teams: [],             // 队伍列表 [{team_id, team_name, captain_id, members: [...]}]
    freeAgents: [],        // 自由选手池
    teamsLoading: false,
    teamsSaving: false,
    allocating: false,
    locking: false,
    teamsDirty: false,       // 队伍是否有未保存的修改
    dragData: null,        // 拖拽数据
    showTeamCountModal: false,  // 自动分队-输入组数弹窗
    autoTeamCount: '',          // 用户输入的组数
    selectedPlayerId: '',       // 当前选中的自由选手ID

    // ===== Tab4: 对阵对战 =====
    rounds: [],
    currentRound: 0,
    matches: [],
    totalRounds: 0,
    roundAllDone: false,
    allBattlesDone: false,
    // 胜负判定弹窗
    showJudgeModal: false,
    judgeMatch: null,
    judgeStep: 0,
    judgeWinnerId: '',
    // 下一轮/结束比赛
    showBattleActionModal: false,
    battleActionType: '',
    battleActionSubmitting: false,

    // ===== Tab5: 名次归档 =====
    isArchived: false,
    _archiveTimeText: '',
    _archiveByText: '',
    ranks: [],
    rankEditSlots: [],
    teamsForRank: [],
    ranksEditing: false,
    ranksSaving: false,
    showArchiveConfirm: false,
    archiveSubmitting: false,
  },

  // ============ 生命周期 ============
  onLoad(options) {
    const eventId = options.eventId || options.id || ''
    if (!eventId) {
      wx.showToast({ title: '赛事ID缺失', icon: 'none' })
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
    // 回页刷新赛事状态+权限
    this.loadEvent().then(() => {
      if (this.data.event) this._refreshTabData()
    })
  },

  // ============ 初始化 ============
  async initPage() {
    try {
      if (this.data.readonly) {
        const role = await perm.getRole()
        this.setData({ userRole: role, isAdmin: false })
      } else {
        const role = await perm.getRole()
        const isAdmin = role === 'admin' || role === 'super_admin'
        this.setData({ userRole: role, isAdmin })
      }

      // 【修复】并行加载赛事数据、报名计数和我的报名状态，确保首次渲染就有 signupCount
      await Promise.all([
        this.loadEvent(),
        this.loadSignups(),
        this.loadMySignup()
      ])

      if (!this.data.event) {
        this.setData({ loaded: true })
        return
      }

      // 更新 Tab 解锁状态
      this._updateTabLocks()
      // 解析权限
      this._updateActions()

      // 非 overview Tab 的预览数据（signup 列表等）延迟加载
      this.setData({ loaded: true })
    } catch (e) {
      console.error('[赛事详情] 初始化失败', e)
      this.setData({ loaded: true })
    }
  },

  // ============ 赛事数据加载 ============
  async loadEvent() {
    try {
      const res = await api.get('/events/' + this.data.eventId)
      if (res.success) {
        const event = res.data
        event._statusName = this.getStatusName(event.event_status)
        event._statusClass = this.getStatusClass(event.event_status)
        event._timeLabel = this.formatTime(event.start_time)
        this.setData({
          event,
          isArchived: event.is_archived === 1,
          _archiveTimeText: event.archived_at ? '归档时间：' + this.formatTime(event.archived_at) : '',
          _archiveByText: event.archived_by ? '归档操作人：' + event.archived_by : ''
        })
      } else {
        wx.showToast({ title: res.error || '赛事不存在', icon: 'none' })
        setTimeout(() => wx.navigateBack(), 1500)
      }
    } catch (e) {
      wx.showToast({ title: '加载赛事失败', icon: 'none' })
    }
  },

  // ============ Tab 系统 ============
  /** 刷新 Tab 解锁状态（基于 event.event_status） */
  _updateTabLocks() {
    const event = this.data.event
    if (!event) return
    const status = event.event_status
    // 【注意】名次归档解锁条件：已结束比赛（status>=5 或 is_archived=1）
    // Tab定义中 unlockStatus:5 即表示 status>=5 时解锁
    const tabs = this.data.tabs.map(t => ({
      ...t,
      // 特殊处理：readonly 模式下所有Tab解锁（但只读）
      _locked: this.data.readonly ? false : (status < t.unlockStatus)
    }))
    this.setData({ tabs })

    // 如果当前 Tab 未解锁，自动切到赛事概览
    const current = tabs.find(t => t.key === this.data.activeTab)
    if (current && current._locked) {
      this.setData({ activeTab: 'overview', activeTabIndex: 0 })
    }
  },

  /** Tab 点击切换 */
  switchTab(e) {
    const index = parseInt(e.currentTarget.dataset.index)
    const tab = this.data.tabs[index]
    if (!tab) return

    // 未解锁提示
    if (tab._locked && !this.data.readonly) {
      const statusNames = ['创建中', '报名中', '报名截止', '分组锁定', '对战中', '已归档']
      const required = statusNames[tab.unlockStatus] || '未知'
      wx.showToast({ title: '赛事进入「' + required + '」阶段后解锁', icon: 'none', duration: 2000 })
      return
    }

    if (tab.key === this.data.activeTab) return

    this.setData({ activeTab: tab.key, activeTabIndex: index })
    this._loadTabData(tab.key)
  },

  /** 自动切换到指定Tab */
  _switchToTab(tabKey) {
    const index = this.data.tabs.findIndex(t => t.key === tabKey)
    if (index >= 0) {
      this.setData({ activeTab: tabKey, activeTabIndex: index })
      this._loadTabData(tabKey)
    }
  },

  /** 加载对应 Tab 数据 */
  async _loadTabData(tabKey) {
    switch (tabKey) {
      case 'overview':
        // 赛事概览需要报名计数 + mySignup 判断"已报名"/"立即报名"状态
        this._updateActions()
        await Promise.all([this.loadSignups(), this.loadMySignup()])
        break
      case 'signups':
        await Promise.all([this.loadSignups(), this.loadMySignup()])
        break
      case 'teams':
        await this.loadTeams()
        break
      case 'matches':
        await this.loadBattleData(this.data.currentRound || 0)
        break
      case 'ranks':
        await this.loadRanks()
        break
    }
  },

  /** onShow 回页时刷新当前Tab数据 */
  async _refreshTabData() {
    this._updateTabLocks()
    this._updateActions()
    await this._loadTabData(this.data.activeTab)
  },

  // ============ 权限 ============
  _updateActions() {
    const event = this.data.event
    if (!event) return
    const opts = {
      eventStatus: event.event_status,
      isArchived: event.is_archived || 0,
      userRole: this.data.userRole
    }
    if (this.data.readonly) {
      const empty = { allowed: false, disabled: true, reason: '历史赛事只读' }
      this.setData({
        actions: {
          signup: empty, cancel_signup: empty, edit_event: empty,
          change_status: empty, manage_signups: empty, manage_teams: empty,
          lock_teams: empty, manage_matches: empty, manage_ranks: empty,
          archive_event: empty
        },
        signupBtn: empty, cancelSignupBtn: empty,
        signupDisabledReason: '历史赛事只读'
      })
      return
    }
    const actions = {}
    const keys = ['signup', 'cancel_signup', 'edit_event', 'change_status',
      'manage_signups', 'manage_teams', 'lock_teams',
      'manage_matches', 'manage_ranks', 'archive_event']
    keys.forEach(k => { actions[k] = perm.checkAction(k, opts) })
    this.setData({
      actions,
      signupBtn: actions.signup,
      cancelSignupBtn: actions.cancel_signup,
      signupDisabledReason: actions.signup.reason
    })
  },

  // ============ 赛事名 & 简介内联编辑（admin/super_admin，归档前） ============
  // 检查是否可以编辑
  _canEditEventInfo() {
    const { event, isAdmin, readonly } = this.data
    if (!event || readonly || !isAdmin) return false
    if (event.is_archived === 1) return false
    return true
  },

  // ── 赛事名称 ──
  startEditName() {
    if (!this._canEditEventInfo()) return
    this.setData({ editingName: true, editNameValue: this.data.event.event_name })
  },
  cancelEditName() {
    this.setData({ editingName: false, editNameValue: '' })
  },
  onEditNameInput(e) {
    this.setData({ editNameValue: e.detail.value })
  },
  async confirmEditName() {
    const val = (this.data.editNameValue || '').trim()
    if (!val) { wx.showToast({ title: '赛事名称不能为空', icon: 'none' }); return }
    if (val.length < 2 || val.length > 50) { wx.showToast({ title: '名称需2-50个字符', icon: 'none' }); return }
    if (val === this.data.event.event_name) { this.cancelEditName(); return }
    this.setData({ editingName: false })
    try {
      const res = await api.put('/events/' + this.data.eventId, { eventName: val })
      if (res.success) {
        this.setData({ 'event.event_name': val })
        wx.showToast({ title: '名称已更新', icon: 'success' })
      } else {
        wx.showToast({ title: res.error || '更新失败', icon: 'none' })
      }
    } catch (e) {
      wx.showToast({ title: '更新失败，请重试', icon: 'none' })
    }
  },

  // ── 赛事简介 ──
  startEditDesc() {
    if (!this._canEditEventInfo()) return
    this.setData({ editingDesc: true, editDescValue: this.data.event.event_desc || '' })
  },
  cancelEditDesc() {
    this.setData({ editingDesc: false, editDescValue: '' })
  },
  onEditDescInput(e) {
    this.setData({ editDescValue: e.detail.value })
  },
  async confirmEditDesc() {
    const val = (this.data.editDescValue || '').trim()
    if (val === (this.data.event.event_desc || '')) { this.cancelEditDesc(); return }
    this.setData({ editingDesc: false })
    try {
      const res = await api.put('/events/' + this.data.eventId, { eventDesc: val || null })
      if (res.success) {
        this.setData({ 'event.event_desc': val || '' })
        wx.showToast({ title: val ? '简介已更新' : '简介已清空', icon: 'success' })
      } else {
        wx.showToast({ title: res.error || '更新失败', icon: 'none' })
      }
    } catch (e) {
      wx.showToast({ title: '更新失败，请重试', icon: 'none' })
    }
  },

  // ============ 工具函数 ============
  getStatusName(status) {
    const map = { 0: '创建中', 1: '报名中', 2: '报名截止', 3: '分组锁定', 4: '对战中', 5: '已归档' }
    return map[status] || '未知'
  },
  getStatusClass(status) {
    const map = { 0: 's-draft', 1: 's-open', 2: 's-closed', 3: 's-locked', 4: 's-fighting', 5: 's-archived' }
    return map[status] || ''
  },
  formatTime(ts) {
    if (!ts) return '待定'
    const d = new Date(parseInt(ts))
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
  },
  getBtnDisabledReason() {
    const event = this.data.event
    if (!event) return ''
    const map = { 0: '报名未开始', 1: '', 2: '报名已截止', 3: '赛事已分组锁定', 4: '赛事对战中', 5: '赛事已归档' }
    return map[event.event_status] || ''
  },

  // ================================================================
  //  Tab1: 赛事概览
  // ================================================================
  /** 获取下一个有效状态流转 */
  getNextStatus() {
    const status = this.data.event.event_status
    if (status === 0) return { status: 1, name: '开启报名', title: '确认开启报名', msg: '开启后选手可自助报名，确定继续？' }
    if (status === 1) return { status: 2, name: '截止报名', title: '确认截止报名', msg: '截止后选手将无法报名或取消报名，确定继续？' }
    return null
  },

  // 开启/截止报名 (二次确认弹窗)
  showStatusConfirm() {
    const next = this.getNextStatus()
    if (!next) { wx.showToast({ title: '当前状态不支持此操作', icon: 'none' }); return }
    this.setData({
      showStatusConfirm: true,
      targetStatus: next.status,
      targetStatusName: next.name,
      _confirmTitle: next.title,
      _confirmMsg: next.msg
    })
  },
  hideStatusConfirm() { this.setData({ showStatusConfirm: false }) },
  async doChangeStatus() {
    this.setData({ showStatusConfirm: false, loading: true })
    try {
      const res = await api.put('/events/' + this.data.eventId + '/status',
        { eventStatus: this.data.targetStatus })
      this.setData({ loading: false })
      if (res.success) {
        wx.showToast({ title: this.data.targetStatusName + '成功', icon: 'success' })
        await this.loadEvent()
        this._updateTabLocks()
        this._updateActions()
        // 如果进入报名截止状态，自动切到分组编组
        if (this.data.targetStatus === 2) {
          setTimeout(() => this._switchToTab('teams'), 800)
        }
      } else {
        wx.showToast({ title: res.error || '操作失败', icon: 'none' })
      }
    } catch (e) {
      this.setData({ loading: false })
      wx.showToast({ title: '操作失败，请重试', icon: 'none' })
    }
  },

  // 去分组(状态=2时) — 直接切Tab
  goToTeamsTab() { this._switchToTab('teams') },

  // 去归档(状态=5未归档时) — 直接切Tab
  goToRanksTab() { this._switchToTab('ranks') },

  // ================================================================
  //  Tab2: 报名管理
  // ================================================================
  async loadSignups(page = 1) {
    try {
      const res = await api.get('/events/' + this.data.eventId + '/signups',
        { status: 1, page: page, pageSize: this.data.signupPageSize })
      if (res.success) {
        const list = (res.data || []).map(s => ({
          ...s,
          calibrate_rank_name: R.normalizeRankName(s.calibrate_rank_name),
          _typeLabel: s.signup_type === 1 ? '管理员添加' : '自主报名',
          _typeClass: s.signup_type === 1 ? 'type-admin' : 'type-self'
        }))
        const total = res.total || 0
        this.setData({
          signups: list,
          signupCount: res.total || list.length,
          signupPage: res.page || page,
          signupTotal: total,
          signupHasMore: page * this.data.signupPageSize < total
        })
      }
    } catch (e) { console.error('[报名] 加载列表失败', e) }
  },

  // 切换分页
  goSignupPage(e) {
    const page = parseInt(e.currentTarget.dataset.page)
    if (!page || page < 1) return
    const totalPages = Math.ceil(this.data.signupTotal / this.data.signupPageSize)
    if (page > totalPages) return
    this.setData({ signupPage: page })
    this.loadSignups(page)
  },

  async loadMySignup() {
    try {
      const res = await api.get('/events/' + this.data.eventId + '/my-signup')
      if (res.success) {
        this.setData({ mySignup: res.data, mySignupLoaded: true })
      } else {
        this.setData({ mySignupLoaded: true })
      }
    } catch (e) {
      console.error('[报名] 加载状态失败', e)
      this.setData({ mySignupLoaded: true })
    }
  },

  // --- 用户自主报名 ---
  async doSignup() {
    const { event, mySignup } = this.data
    if (event.event_status !== 1) { wx.showToast({ title: this.getBtnDisabledReason(), icon: 'none' }); return }
    if (mySignup && mySignup.signedUp) { wx.showToast({ title: '您已报名当前赛事', icon: 'none' }); return }
    this.setData({ loading: true })
    try {
      const res = await api.post('/events/' + this.data.eventId + '/signups', {})
      this.setData({ loading: false })
      if (res.success) {
        wx.showToast({ title: '报名成功！', icon: 'success' })
        await Promise.all([this.loadMySignup(), this.loadSignups()])
      } else {
        this._handleSignupError(res)
      }
    } catch (e) {
      this.setData({ loading: false })
      wx.showToast({ title: '报名失败，请重试', icon: 'none' })
    }
  },

  _handleSignupError(res) {
    const code = res.code || ''
    switch (code) {
      case 'NICKNAME_EMPTY':
        wx.showModal({ title: '未设置昵称', content: '请先设置您的微信群昵称后再报名。\n\n点击「确认」去设置昵称。', success: r => { if (r.confirm) wx.navigateBack() } }); break
      case 'PLAYER_NOT_FOUND':
        wx.showModal({ title: '未找到选手档案', content: '未找到与您昵称匹配的选手档案，请联系管理员先录入您的选手信息。', showCancel: false }); break
      case 'MULTIPLE_MATCH':
        wx.showModal({ title: '匹配到多条记录', content: '您的昵称匹配到多个选手档案，请联系管理员手动添加报名。', showCancel: false }); break
      case 'ALREADY_SIGNED':
        wx.showToast({ title: '您已报名当前赛事', icon: 'none' }); break
      case 'EVENT_NOT_OPEN':
        wx.showToast({ title: res.error || '当前赛事不在报名阶段', icon: 'none' }); break
      default:
        wx.showToast({ title: res.error || '报名失败', icon: 'none' })
    }
  },

  // --- 取消报名 ---
  showCancelSignup() { this.setData({ showCancelConfirm: true }) },
  hideCancelSignup() { this.setData({ showCancelConfirm: false }) },
  async doCancelSignup() {
    this.setData({ showCancelConfirm: false, loading: true })
    try {
      const res = await api.del('/events/' + this.data.eventId + '/signups/' + this.data.mySignup.signupId)
      this.setData({ loading: false })
      if (res.success) {
        wx.showToast({ title: '已取消报名', icon: 'success' })
        await Promise.all([this.loadMySignup(), this.loadSignups()])
      } else {
        wx.showToast({ title: res.error || '取消失败', icon: 'none' })
      }
    } catch (e) {
      this.setData({ loading: false })
      wx.showToast({ title: '取消失败，请重试', icon: 'none' })
    }
  },

  // --- 管理员：搜索选手 + 批量添加 ---
  onSearchInput(e) {
    const val = e.detail.value || ''
    this.setData({ searchKeyword: val })
    if (this._searchTimer) clearTimeout(this._searchTimer)
    this._searchTimer = setTimeout(() => this._doSearch(), 300)
  },
  clearSearch() { this.setData({ searchKeyword: '', searchResults: [] }) },

  async _doSearch() {
    const kw = this.data.searchKeyword.trim()
    if (!kw) { this.setData({ searchResults: [] }); return }
    this.setData({ searchLoading: true })
    try {
      const res = await api.get('/search/players', { keyword: kw })
      this.setData({ searchLoading: false })
      if (res.success) {
        // 标记已报名选手（后端返回 id 字段，映射为 _id 供内部使用）
        const signedIds = new Set(this.data.signups.map(s => s.player_id).filter(Boolean))
        const results = (res.data || []).map(p => ({
          ...p,
          calibrate_rank_name: R.normalizeRankName(p.calibrate_rank_name),
          _id: p.id,   // 后端搜索API返回的是 id，统一映射为 _id
          _alreadySigned: signedIds.has(p.id)
        }))
        this.setData({ searchResults: results })
      }
    } catch (e) {
      this.setData({ searchLoading: false })
      wx.showToast({ title: '搜索失败', icon: 'none' })
    }
  },

  // 单个添加：直接添加一名选手到报名池
  doSingleAdd(e) {
    const pid = e.currentTarget.dataset.pid
    const player = this.data.searchResults.find(p => p._id == pid)
    const name = player ? (player.wx_nickname || '未知') : ''
    wx.showModal({
      title: '添加报名',
      content: '确定将「' + name + '」加入报名池？',
      success: async (r) => {
        if (!r.confirm) return
        this.setData({ addLoading: true })
        try {
          const res = await api.post('/events/' + this.data.eventId + '/signups/batch', { playerIds: [pid] })
          // 服务器始终返回 success:true，实际添加结果在 res.data 中
          const result = res.data || {}
          const added = result.success || 0
          if (res.success && added > 0) {
            wx.showToast({ title: '添加成功', icon: 'success' })
            // 仅当服务器确认添加成功后，才在搜索结果中标记已报名
            const results = this.data.searchResults.map(p =>
              p._id == pid ? { ...p, _alreadySigned: true } : p
            )
            this.setData({ searchResults: results, addLoading: false })
            await this.loadSignups()
          } else if (res.success && result.skipped > 0) {
            this.setData({ addLoading: false })
            wx.showToast({ title: '该选手已报名，无需重复添加', icon: 'none' })
          } else if (res.success && result.failed > 0) {
            this.setData({ addLoading: false })
            wx.showToast({ title: (result.details && result.details[0] && result.details[0].reason) || '添加失败', icon: 'none' })
          } else {
            this.setData({ addLoading: false })
            wx.showToast({ title: res.error || '添加失败', icon: 'none' })
          }
        } catch (e) {
          this.setData({ addLoading: false })
          wx.showToast({ title: '添加失败，请重试', icon: 'none' })
        }
      }
    })
  },

  // --- 管理员：单个剔除报名 ---
  showRemoveSignup(e) {
    const sid = e.currentTarget.dataset.sid
    const s = this.data.signups.find(x => x.signup_id === sid)
    if (!s) return
    this.setData({ removeTarget: s })
  },
  hideRemoveSignup() { this.setData({ removeTarget: null }) },
  async doRemoveSignup() {
    const s = this.data.removeTarget
    if (!s) return
    this.setData({ removeTarget: null, loading: true })
    try {
      const res = await api.del('/events/' + this.data.eventId + '/signups/' + s.signup_id)
      this.setData({ loading: false })
      if (res.success) {
        wx.showToast({ title: '已剔除报名', icon: 'success' })
        await this.loadSignups()
      } else {
        wx.showToast({ title: res.error || '操作失败', icon: 'none' })
      }
    } catch (e) {
      this.setData({ loading: false })
      wx.showToast({ title: '操作失败，请重试', icon: 'none' })
    }
  },

  // ================================================================
  //  Tab3: 分组编组
  // ================================================================
  async loadTeams() {
    this.setData({ teamsLoading: true })
    try {
      const res = await api.get('/events/' + this.data.eventId + '/teams')
      this.setData({ teamsLoading: false })
      if (res.success) {
        let teams = (res.data && res.data.teams) ? res.data.teams : []
        let freeAgents = (res.data && res.data.free_agents) ? res.data.free_agents
          : ((res.data && res.data.freePlayers) ? res.data.freePlayers : [])

        // 兼容后端返回 members 和 players 两种字段名
        // 前台展示：有实际MMR用实际，否则按段位+星级推算等效分
        // 标准化所有选手的段位名为中文，并填充等效MMR
        const normPlayer = m => ({ ...m, calibrate_rank_name: R.normalizeRankName(m.calibrate_rank_name), _posText: formatPosition(m), calibrate_mmr: R.calcEquivalentMmr(R.normalizeRankName(m.calibrate_rank_name), m.calibrate_rank_star, m.calibrate_mmr) })
        teams = teams.map(t => {
          const rawMembers = (t.members || t.players || []).map(normPlayer)
          const cid = t.captain_id || t.captainId || ''
          // 队长昵称：优先 captain_name → captain.wx_nickname → 从队员列表匹配 → 空
          let cname = t.captain_name || (t.captain ? t.captain.wx_nickname : '') || ''
          if (!cname && cid && rawMembers.length > 0) {
            const found = rawMembers.find(m => String(m.id || m.player_id || m._id) === String(cid))
            cname = found ? (found.wx_nickname || found.nickName || '') : ''
          }
          const stats = this._calcTeamStats(rawMembers)
          return {
            ...t,
            team_id: t.team_id || t.teamId || '',
            team_name: t.team_name || t.teamName || '未命名',
            captain_id: cid,
            captain_name: cname,
            members: rawMembers,
            players: rawMembers,
            ...stats
          }
        })

        // 自由选手：保留完整字段，确保 id 存在，并标准化段位名
        freeAgents = freeAgents.map(normPlayer).map(p => ({
          ...p,
          id: p.id || p.player_id || p._id || ''
        })).filter(p => p.id)

        this.setData({ teams: this._normalizeTeams(teams), freeAgents, selectedPlayerId: '', teamsDirty: false })
      }
    } catch (e) {
      this.setData({ teamsLoading: false })
      console.error('[编组] 加载失败', e)
    }
  },

  // ============ 工具：计算队伍总分/均分/人数 ============
  _calcTeamStats(members) {
    const list = members || []
    const total_mmr = list.reduce((sum, m) => sum + (parseInt(m.calibrate_mmr) || 0), 0)
    const _memberCount = list.length
    const _avgMmr = _memberCount > 0 ? Math.round(total_mmr / _memberCount) : 0
    return { total_mmr, _memberCount, _avgMmr }
  },

  // 队伍排序：1.每队内部队长排第一 2.队伍按总分降序
  _normalizeTeams(teams) {
    if (!teams || teams.length === 0) return teams || []
    return teams
      .map(t => {
        const members = t.members || t.players || []
        const captainId = String(t.captain_id || '')
        // 队长排第一，其余按原始顺序
        const cap = captainId ? members.find(m => String(m.id) === captainId) : null
        const sortedMembers = cap
          ? [cap, ...members.filter(m => String(m.id) !== captainId)]
          : members
        return { ...t, members: sortedMembers, players: sortedMembers }
      })
      .sort((a, b) => (b.total_mmr || 0) - (a.total_mmr || 0))
  },

  // ============ 选手选择交互 ============

  // 点击自由选手：选中/取消选中
  selectFreeAgent(e) {
    const playerId = String(e.currentTarget.dataset.playerId)
    if (this.data.selectedPlayerId === playerId) {
      this.setData({ selectedPlayerId: '' })
    } else {
      const player = this.data.freeAgents.find(p => String(p.id) === playerId)
      this.setData({ selectedPlayerId: playerId })
      if (player) {
        wx.showToast({ title: '已选「' + (player.wx_nickname || '未知') + '」', icon: 'none', duration: 1200 })
      }
    }
  },

  // 点击队伍卡片：放入选中选手
  dropToTeam(e) {
    const teamId = e.currentTarget.dataset.teamId
    const playerId = this.data.selectedPlayerId
    if (!playerId || !teamId) return

    const player = this.data.freeAgents.find(p => String(p.id) === String(playerId))
    if (!player) {
      this.setData({ selectedPlayerId: '' })
      return
    }

    // 检查是否已在目标队伍中
    const targetTeam = this.data.teams.find(t => String(t.team_id) === String(teamId))
    if (targetTeam) {
      const members = targetTeam.members || targetTeam.players || []
      if (members.some(m => String(m.id) === String(playerId))) {
        wx.showToast({ title: '该选手已在队伍中', icon: 'none' })
        return
      }
    }

    // 从自由区移除
    const freeAgents = this.data.freeAgents.filter(p => String(p.id) !== String(playerId))
    // 加入目标队伍并重算总分/均分/人数
    const teams = this.data.teams.map(t => {
      if (String(t.team_id) === String(teamId)) {
        const members = t.members || t.players || []
        const newMembers = [...members, player]
        const stats = this._calcTeamStats(newMembers)
        // 队伍没队长时，第一个进入的自动成为队长
        const isFirstMember = !t.captain_id && members.length === 0
        return {
          ...t,
          members: newMembers,
          players: newMembers,
          captain_id: isFirstMember ? String(player.id) : t.captain_id,
          captain_name: isFirstMember ? (player.wx_nickname || player.nickName || '') : t.captain_name,
          ...stats
        }
      }
      return t
    })

    this.setData({ freeAgents, teams: this._normalizeTeams(teams), selectedPlayerId: '', teamsDirty: true })
    wx.showToast({ title: '已加入「' + (targetTeam ? targetTeam.team_name : '') + '」', icon: 'success', duration: 1200 })
  },

  // ============ 队伍内操作 ============

  // 从队伍移出选手（放回自由区）
  removeFromTeam(e) {
    const { teamId, playerId } = e.currentTarget.dataset
    if (!teamId || !playerId) return

    const targetTeam = this.data.teams.find(t => String(t.team_id) === String(teamId))
    if (!targetTeam) return

    const members = targetTeam.members || targetTeam.players || []
    const player = members.find(m => String(m.id) === String(playerId))
    if (!player) return

    const freeAgents = [...this.data.freeAgents, player]
    const teams = this.data.teams.map(t => {
      if (String(t.team_id) === String(teamId)) {
        const newMembers = members.filter(m => String(m.id) !== String(playerId))
        const wasCaptain = String(t.captain_id) === String(playerId)
        const stats = this._calcTeamStats(newMembers)
        return {
          ...t,
          members: newMembers,
          players: newMembers,
          captain_id: wasCaptain ? '' : t.captain_id,
          captain_name: wasCaptain ? '' : t.captain_name,
          ...stats
        }
      }
      return t
    })

    this.setData({ teams: this._normalizeTeams(teams), freeAgents, teamsDirty: true })
    wx.showToast({ title: '已移回自由区', icon: 'success', duration: 1000 })
  },

  // 设置/取消队长
  setTeamCaptain(e) {
    const { teamId, playerId } = e.currentTarget.dataset
    if (!teamId || !playerId) return

    const teams = this.data.teams.map(t => {
      if (String(t.team_id) === String(teamId)) {
        const isCurrentCaptain = String(t.captain_id) === String(playerId)
        const members = t.members || t.players || []
        const captainPlayer = members.find(m => String(m.id) === String(playerId))
        return {
          ...t,
          captain_id: isCurrentCaptain ? '' : playerId,
          captain_name: isCurrentCaptain ? '' : (captainPlayer ? (captainPlayer.wx_nickname || captainPlayer.nickName || '') : '')
        }
      }
      return t
    })

    this.setData({ teams: this._normalizeTeams(teams), teamsDirty: true })
  },

  // ============ 队伍增删 ============

  // 新建空队伍
  addTeam() {
    if (!this.data.actions.manage_teams || !this.data.actions.manage_teams.allowed) {
      wx.showToast({ title: '无操作权限', icon: 'none' }); return
    }
    const index = this.data.teams.length + 1
    const teams = [...this.data.teams, {
      team_id: 'temp_' + Date.now(),
      team_name: '战队' + index,
      captain_id: '',
      captain_name: '',
      total_mmr: 0,
      members: [],
      players: [],
      isNew: true
    }]
    this.setData({ teams: this._normalizeTeams(teams), teamsDirty: true })
    wx.showToast({ title: '已创建"战队' + index + '"', icon: 'success', duration: 1000 })
  },

  // 删除队伍（释放队员到自由区）
  deleteTeam(e) {
    const teamId = e.currentTarget.dataset.teamId
    const team = this.data.teams.find(t => String(t.team_id) === String(teamId))
    if (!team) return

    const members = team.members || team.players || []
    wx.showModal({
      title: '删除队伍',
      content: members.length > 0
        ? '删除「' + team.team_name + '」将释放 ' + members.length + ' 名队员到自由区，确认删除？'
        : '确认删除空队伍「' + team.team_name + '」？',
      success: (r) => {
        if (!r.confirm) return
        const freeAgents = [...this.data.freeAgents, ...members]
        const teams = this.data.teams.filter(t => String(t.team_id) !== String(teamId))
        this.setData({ teams: this._normalizeTeams(teams), freeAgents, selectedPlayerId: '', teamsDirty: true })
        wx.showToast({ title: '已删除', icon: 'success' })
      }
    })
  },

  // ============ 保存 & 锁定 ============

  // 保存编组到服务器
  async saveTeams() {
    if (!this.data.actions.manage_teams || !this.data.actions.manage_teams.allowed) {
      wx.showToast({ title: '无操作权限', icon: 'none' }); return
    }
    if (this.data.teams.length === 0) {
      wx.showToast({ title: '请先创建队伍', icon: 'none' }); return
    }

    // 前端校验
    for (const team of this.data.teams) {
      const members = team.members || team.players || []
      if (members.length === 0) {
        wx.showToast({ title: '「' + team.team_name + '」没有队员', icon: 'none' }); return
      }
      if (!team.captain_id) {
        wx.showToast({ title: '「' + team.team_name + '」未指定队长', icon: 'none' }); return
      }
      if (!members.some(m => String(m.id) === String(team.captain_id))) {
        wx.showToast({ title: '「' + team.team_name + '」队长不在队员中', icon: 'none' }); return
      }
    }

    const teamsPayload = this.data.teams.map(t => {
      const members = t.members || t.players || []
      return {
        teamName: t.team_name,
        captainId: t.captain_id,
        playerIds: members.map(p => p.id)
      }
    })

    this.setData({ teamsSaving: true })
    try {
      const res = await api.post('/events/' + this.data.eventId + '/teams/batch', { teams: teamsPayload })
      this.setData({ teamsSaving: false, teamsDirty: false })
      if (res.success) {
        wx.showToast({ title: res.message || '保存成功', icon: 'success' })
        setTimeout(() => {
          this.loadTeams()
          this.loadEvent().then(() => { this._updateTabLocks(); this._updateActions() })
        }, 800)
      } else {
        wx.showToast({ title: res.error || '保存失败', icon: 'none' })
      }
    } catch (e) {
      this.setData({ teamsSaving: false })
      wx.showToast({ title: '保存失败，请重试', icon: 'none' })
    }
  },

  // 自动分队 → 先弹窗输入组数
  doAutoAllocate() {
    if (!this.data.actions.manage_teams || !this.data.actions.manage_teams.allowed) {
      wx.showToast({ title: '无操作权限', icon: 'none' }); return
    }
    const suggested = Math.max(1, Math.floor((this.data.signupTotal || this.data.signupCount) / 5))
    this.setData({ showTeamCountModal: true, autoTeamSuggestion: String(suggested), autoTeamCount: String(suggested) })
  },

  // 关闭组数输入弹窗
  closeTeamCountModal() {
    this.setData({ showTeamCountModal: false, autoTeamSuggestion: '', autoTeamCount: '' })
  },

  // 组数输入框变化
  onTeamCountInput(e) {
    this.setData({ autoTeamCount: e.detail.value })
  },

  // 确认自动分队
  async confirmAutoAllocate() {
    const count = parseInt(this.data.autoTeamCount)
    if (isNaN(count) || count < 1) {
      wx.showToast({ title: '请输入有效的组数（≥1）', icon: 'none' }); return
    }
    const totalPlayers = this.data.signupTotal || this.data.signupCount || 0
    if (count > totalPlayers) {
      wx.showToast({ title: '组数不能超过选手总数（' + totalPlayers + '人）', icon: 'none' }); return
    }
    this.setData({ showTeamCountModal: false, allocating: true })
    try {
      const res = await api.post('/events/' + this.data.eventId + '/allocate-teams', { teamCount: count })
      this.setData({ allocating: false })
      if (res.success) {
        let teams = (res.data && res.data.teams) ? res.data.teams : []
        let freeAgents = (res.data && res.data.free_agents) ? res.data.free_agents : []

        // 规范化队伍数据，匹配 Tab3 渲染格式
        const normM = m => ({ ...m, calibrate_rank_name: R.normalizeRankName(m.calibrate_rank_name), _posText: formatPosition(m), calibrate_mmr: R.calcEquivalentMmr(R.normalizeRankName(m.calibrate_rank_name), m.calibrate_rank_star, m.calibrate_mmr) })
        teams = teams.map((t, i) => {
          const members = (t.players || t.members || []).map(normM)
          const cid = t.captainId || t.captain_id || ''
          let cname = t.captainName || t.captain_name || (t.captain ? (t.captain.wx_nickname || '') : '') || ''
          if (!cname && cid && members.length > 0) {
            const found = members.find(m => String(m.id || m.player_id || m._id) === String(cid))
            cname = found ? (found.wx_nickname || found.nickName || '') : ''
          }
          const stats = this._calcTeamStats(members)
          return {
            team_id: 'alloc_' + (i + 1) + '_' + Date.now(),
            team_name: t.teamName || t.team_name || ('战队' + (i + 1)),
            captain_id: cid,
            captain_name: cname,
            members,
            players: members,
            isNew: true,
            ...stats
          }
        })
        // 规范化自由选手
        freeAgents = freeAgents.map(normM).map(p => ({
          ...p,
          id: p.id || p.player_id || p._id || ''
        })).filter(p => p.id)

        this.setData({ teams: this._normalizeTeams(teams), freeAgents, selectedPlayerId: '', teamsDirty: true })
        wx.showToast({ title: '自动分队完成（共' + count + '组）', icon: 'success' })
      } else {
        wx.showToast({ title: res.error || '分队失败', icon: 'none' })
      }
    } catch (e) {
      this.setData({ allocating: false })
      wx.showToast({ title: '分队失败，请重试', icon: 'none' })
    }
  },

  // 锁定分组并开赛
  async doLockTeams() {
    if (!this.data.actions.lock_teams || !this.data.actions.lock_teams.allowed) {
      wx.showToast({ title: '无操作权限', icon: 'none' }); return
    }
    // 先保存再锁定
    if (this.data.teams.some(t => (t.isNew || String(t.team_id).startsWith('temp_') || String(t.team_id).startsWith('alloc_')))) {
      wx.showToast({ title: '请先保存编组再锁定开赛', icon: 'none' })
      return
    }
    wx.showModal({
      title: '锁定分组并开赛',
      content: '确认锁定当前分组并开始比赛？\n\n锁定后队伍信息不可修改，赛事进入对战中状态。',
      success: async (r) => {
        if (!r.confirm) return
        this.setData({ locking: true })
        try {
          const res = await api.post('/events/' + this.data.eventId + '/lock-teams', {})
          this.setData({ locking: false })
          if (res.success) {
            wx.showToast({ title: '已开赛', icon: 'success' })
            await this.loadEvent()
            this._updateTabLocks()
            this._updateActions()
            setTimeout(() => this._switchToTab('matches'), 800)
          } else {
            wx.showToast({ title: res.error || '开赛失败', icon: 'none' })
          }
        } catch (e) {
          this.setData({ locking: false })
          wx.showToast({ title: '操作失败，请重试', icon: 'none' })
        }
      }
    })
  },

  // 跳转到队伍编辑页（保留兼容，但不再使用）
  goTeamEdit() {
    // 不再跳转独立页面，所有操作在 Tab3 内完成
    this._switchToTab('teams')
  },

  // ================================================================
  //  Tab4: 对阵对战
  // ================================================================
  goMatchEdit() {
    wx.navigateTo({
      url: '/pages/event-match-edit/event-match-edit?eventId=' + this.data.eventId
    })
  },

  async loadBattleData(round) {
    try {
      const [roundsRes, matchesRes] = await Promise.all([
        api.get('/events/' + this.data.eventId + '/matches/rounds'),
        api.get('/events/' + this.data.eventId + '/matches',
          { round: round || this.data.currentRound || 0 })
      ])
      if (roundsRes.success) {
        const { rounds, currentRound: sr, totalRounds } = roundsRes.data
        const allDone = rounds.length > 0 && rounds.every(r => r.allDone)
        const keepRound = !round || round === 0 ? sr : round
        this.setData({ rounds, currentRound: keepRound, totalRounds, allBattlesDone: allDone })
      }
      if (matchesRes.success) {
        const matches = matchesRes.data || []
        const roundAllDone = matches.length > 0 && matches.every(m => m._isDone)
        this.setData({ matches, roundAllDone })
      }
    } catch (e) { console.error('[对战] 加载失败', e) }
  },

  switchRound(e) {
    const round = e.currentTarget.dataset.round
    this.setData({ currentRound: round })
    this.loadBattleData(round)
  },

  // 胜负判定
  openJudgeModal(e) {
    if (!this.data.isAdmin) return
    if (this.data.isArchived) { wx.showToast({ title: '赛事已归档，不可修改', icon: 'none' }); return }
    const matchId = e.currentTarget.dataset.matchId
    const match = this.data.matches.find(m => m.match_id === matchId)
    if (!match) return
    if (match._isDone) { wx.showToast({ title: '该对战已判定', icon: 'none' }); return }
    this.setData({ showJudgeModal: true, judgeMatch: match, judgeStep: 0, judgeWinnerId: '' })
  },
  selectWinner(e) {
    this.setData({ judgeWinnerId: e.currentTarget.dataset.teamId, judgeStep: 1 })
  },
  backToSelect() { this.setData({ judgeStep: 0, judgeWinnerId: '' }) },
  async confirmJudge() {
    const { judgeMatch, judgeWinnerId, eventId } = this.data
    if (!judgeMatch || !judgeWinnerId) return
    this.setData({ loading: true })
    try {
      const res = await api.put(`/events/${eventId}/matches/${judgeMatch.match_id}/judge`,
        { winnerId: judgeWinnerId, confirmed: true })
      this.setData({ loading: false })
      if (res.success) {
        wx.showToast({ title: '胜负已判定', icon: 'success' })
        this.setData({ showJudgeModal: false, judgeMatch: null, judgeWinnerId: '', judgeStep: 0 })
        await this.loadBattleData(this.data.currentRound)
      } else {
        wx.showToast({ title: res.error || '判定失败', icon: 'none' })
      }
    } catch (e) {
      this.setData({ loading: false })
      wx.showToast({ title: '判定失败，请重试', icon: 'none' })
    }
  },
  closeJudgeModal() {
    this.setData({ showJudgeModal: false, judgeMatch: null, judgeWinnerId: '', judgeStep: 0 })
  },

  // 下一轮 / 结束比赛
  showBattleAction(e) {
    const actionType = e.currentTarget.dataset.action
    let title = '', content = ''
    if (actionType === 'next-round') {
      title = '进入下一轮'
      content = '确认进入第' + (this.data.currentRound + 1) + '轮对战？\n\n所有原始队伍将保留，管理员需重新选择参赛队伍并编排对阵。'
    } else {
      title = '结束比赛'
      content = '确认结束当前赛事？\n\n比赛结束后可设定队伍名次，设定完成后需点击「归档比赛」正式归档。'
    }
    this.setData({ showBattleActionModal: true, battleActionType: actionType,
      _battleActionTitle: title, _battleActionContent: content })
  },
  hideBattleActionModal() { this.setData({ showBattleActionModal: false }) },
  async doBattleAction() {
    const { battleActionType } = this.data
    this.setData({ battleActionSubmitting: true })
    const url = battleActionType === 'next-round'
      ? '/events/' + this.data.eventId + '/next-round'
      : '/events/' + this.data.eventId + '/end-battle'
    try {
      const res = await api.post(url, {})
      this.setData({ battleActionSubmitting: false, showBattleActionModal: false })
      if (res.success) {
        wx.showToast({ title: res.data.message || '操作成功', icon: 'success' })
        if (battleActionType === 'end-battle') {
          await this.loadEvent()
          this._updateTabLocks()
          this._updateActions()
          // 自动切换到名次归档Tab
          setTimeout(() => this._switchToTab('ranks'), 800)
        } else {
          await this.loadBattleData(this.data.currentRound + 1)
        }
      } else {
        wx.showToast({ title: res.error || '操作失败', icon: 'none' })
      }
    } catch (e) {
      this.setData({ battleActionSubmitting: false, showBattleActionModal: false })
      wx.showToast({ title: '操作失败，请重试', icon: 'none' })
    }
  },

  // ================================================================
  //  Tab5: 名次归档
  // ================================================================
  async loadRanks() {
    try {
      const res = await api.get('/events/' + this.data.eventId + '/ranks')
      if (res.success) this.setData({ ranks: res.data || [] })
    } catch (e) { console.error('[名次] 加载失败', e) }
  },

  async loadTeamsForRank() {
    try {
      const res = await api.get('/events/' + this.data.eventId + '/teams')
      if (res.success) {
        const teams = (res.data && res.data.teams) ? res.data.teams : []
        this.setData({ teamsForRank: teams })
      }
    } catch (e) { console.error('[名次] 加载队伍列表失败', e) }
  },

  async startEditRanks() {
    if (!this.data.isAdmin) return
    await this.loadTeamsForRank()
    const existingRanks = this.data.ranks || []
    const defaultLabels = ['第1名（冠军）', '第2名（亚军）', '第3名（季军）']
    const slots = [1, 2, 3].map(n => {
      const existing = existingRanks.find(r => r.rank_num === n)
      const tid = existing ? existing.team_id : ''
      return { rankNum: n, teamId: tid, label: defaultLabels[n - 1], _displayName: this._resolveTeamName(tid) }
    })
    this.setData({ ranksEditing: true, rankEditSlots: slots })
  },

  cancelEditRanks() { this.setData({ ranksEditing: false, rankEditSlots: [] }) },

  _resolveTeamName(teamId) {
    if (!teamId) return ''
    const teams = this.data.teamsForRank || []
    const found = teams.find(t => t.team_id === teamId)
    return found ? (found.team_name || '未知') : ''
  },

  onRankTeamChange(e) {
    const index = e.currentTarget.dataset.index
    const item = this.data.teamsForRank[e.detail.value]
    const teamId = item ? item.team_id : ''
    const slots = [...this.data.rankEditSlots]
    slots[index].teamId = teamId
    slots[index]._displayName = item ? (item.team_name || '未知') : ''
    this.setData({ rankEditSlots: slots })
  },

  addMoreRankSlots() {
    const slots = [...this.data.rankEditSlots]
    const next = slots.length + 1
    slots.push({ rankNum: next, teamId: '', label: '第' + next + '名', _displayName: '' })
    this.setData({ rankEditSlots: slots })
  },

  removeRankSlot(e) {
    const index = e.currentTarget.dataset.index
    if (index < 3) { wx.showToast({ title: '前3名为默认保留位', icon: 'none' }); return }
    const slots = [...this.data.rankEditSlots]
    slots.splice(index, 1)
    slots.forEach((s, i) => {
      s.rankNum = i + 1
      s.label = i < 3 ? ['第1名（冠军）', '第2名（亚军）', '第3名（季军）'][i] : '第' + (i + 1) + '名'
    })
    this.setData({ rankEditSlots: slots })
  },

  saveRanks() {
    const { rankEditSlots } = this.data
    const ranks = rankEditSlots.map(s => ({ rankNum: s.rankNum, teamId: s.teamId || '' }))
    const hasContent = ranks.some(r => r.teamId !== '')
    if (!hasContent) {
      wx.showModal({
        title: '清空名次', content: '当前所有名次均为空，提交将清空所有已有名次记录。确定继续？',
        success: r => { if (r.confirm) this.doBatchSaveRanks(ranks) }
      })
      return
    }
    this.doBatchSaveRanks(ranks)
  },

  async doBatchSaveRanks(ranksData) {
    this.setData({ ranksSaving: true })
    try {
      const res = await api.post('/events/' + this.data.eventId + '/ranks/batch', { ranks: ranksData })
      this.setData({ ranksSaving: false })
      if (res.success) {
        wx.showToast({ title: '名次已保存', icon: 'success' })
        this.setData({ ranksEditing: false })
        await this.loadRanks()
      } else {
        wx.showToast({ title: res.error || '保存失败', icon: 'none' })
      }
    } catch (e) {
      this.setData({ ranksSaving: false })
      wx.showToast({ title: '保存失败，请重试', icon: 'none' })
    }
  },

  showArchiveBtn() { this.setData({ showArchiveConfirm: true }) },
  hideArchiveBtn() { this.setData({ showArchiveConfirm: false }) },
  async doArchive() {
    this.setData({ archiveSubmitting: true })
    try {
      const res = await api.post('/events/' + this.data.eventId + '/archive', {})
      this.setData({ archiveSubmitting: false, showArchiveConfirm: false })
      if (res.success) {
        wx.showToast({ title: '赛事已归档', icon: 'success', duration: 2000 })
        await this.loadEvent()
        this._updateTabLocks()
        this._updateActions()
        this.setData({ ranksEditing: false })
        await this.loadRanks()
      } else {
        wx.showToast({ title: res.error || '归档失败', icon: 'none' })
      }
    } catch (e) {
      this.setData({ archiveSubmitting: false, showArchiveConfirm: false })
      wx.showToast({ title: '归档失败，请重试', icon: 'none' })
    }
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
})
