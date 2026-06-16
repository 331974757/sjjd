// ============================================================
// pages/event-detail/event-detail.js
// 【赛事详情 - 阶段式Tab分栏重构版】
// 5个Tab按赛事业务流程排列，随状态递进解锁
// 严格复用所有现有后端接口与权限系统，仅重构前端页面结构
// ============================================================
const api = require('../../utils/api.js')
const perm = require('../../utils/permission.js')

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

    // ===== Tab2: 报名管理 =====
    signups: [],           // 报名列表
    signupCount: 0,
    mySignup: null,        // 当前用户报名状态
    showCancelConfirm: false,
    // 搜索选手（管理员批量添加用）
    searchKeyword: '',
    searchResults: [],
    searchLoading: false,
    searchSelected: {},       // { playerId: true }
    searchSelectedCount: 0,   // 已勾选数（WXML 无法直接取 Object.keys 长度）
    batchAddLoading: false,
    // 剔除确认
    removeTarget: null,    // 待剔除报名对象

    // ===== Tab3: 分组编组 =====
    teams: [],             // 队伍列表 [{team_id, team_name, captain_id, members: [...]}]
    freeAgents: [],        // 自由选手池
    teamsLoading: false,
    teamsSaving: false,
    allocating: false,
    locking: false,
    dragData: null,        // 拖拽数据

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

      await this.loadEvent()
      if (!this.data.event) {
        this.setData({ loaded: true })
        return
      }

      // 更新 Tab 解锁状态
      this._updateTabLocks()
      // 解析权限
      this._updateActions()

      // 默认加载 Tab1 数据 + 预览加载后面 Tab
      const tasks = [this._loadTabData('overview')]
      await Promise.all(tasks)
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
        // 赛事概览使用 event 数据，无需额外加载
        this._updateActions()
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
  async loadSignups() {
    try {
      const res = await api.get('/events/' + this.data.eventId + '/signups',
        { status: 1, pageSize: 200 })
      if (res.success) {
        const list = (res.data || []).map(s => ({
          ...s,
          _typeLabel: s.signup_type === 1 ? '管理员添加' : '自主报名',
          _typeClass: s.signup_type === 1 ? 'type-admin' : 'type-self'
        }))
        this.setData({ signups: list, signupCount: list.length })
      }
    } catch (e) { console.error('[报名] 加载列表失败', e) }
  },

  async loadMySignup() {
    try {
      const res = await api.get('/events/' + this.data.eventId + '/my-signup')
      if (res.success) this.setData({ mySignup: res.data })
    } catch (e) { console.error('[报名] 加载状态失败', e) }
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
  clearSearch() { this.setData({ searchKeyword: '', searchResults: [], searchSelected: {}, searchSelectedCount: 0 }) },

  async _doSearch() {
    const kw = this.data.searchKeyword.trim()
    if (!kw) { this.setData({ searchResults: [] }); return }
    this.setData({ searchLoading: true })
    try {
      const res = await api.get('/search/players', { keyword: kw })
      this.setData({ searchLoading: false })
      if (res.success) {
        // 标记已报名选手
        const signedIds = new Set(this.data.signups.map(s => s.player_id).filter(Boolean))
        const results = (res.data || []).map(p => ({
          ...p,
          _alreadySigned: signedIds.has(p._id),
          _selected: !!this.data.searchSelected[p._id]
        }))
        this.setData({ searchResults: results })
      }
    } catch (e) {
      this.setData({ searchLoading: false })
      wx.showToast({ title: '搜索失败', icon: 'none' })
    }
  },

  toggleSelectPlayer(e) {
    const pid = e.currentTarget.dataset.pid
    const selected = { ...this.data.searchSelected }
    if (selected[pid]) delete selected[pid]
    else selected[pid] = true
    const count = Object.keys(selected).length
    const results = this.data.searchResults.map(p => ({ ...p, _selected: !!selected[p._id] }))
    this.setData({ searchSelected: selected, searchSelectedCount: count, searchResults: results })
  },

  async doBatchAdd() {
    const pids = Object.keys(this.data.searchSelected)
    if (!pids.length) { wx.showToast({ title: '请先勾选选手', icon: 'none' }); return }
    const names = this.data.searchResults.filter(p => p._selected).map(p => p.wx_nickname || '未知').join(', ')
    wx.showModal({
      title: '批量添加报名',
      content: '确定将以下选手加入报名池？\n\n' + names,
      success: async (r) => {
        if (!r.confirm) return
        this.setData({ batchAddLoading: true })
        try {
          const res = await api.post('/events/' + this.data.eventId + '/signups/batch', { playerIds: pids })
          this.setData({ batchAddLoading: false })
          if (res.success) {
            wx.showToast({ title: '成功添加 ' + (res.data.success || 0) + ' 人', icon: 'success' })
            this.setData({ searchKeyword: '', searchResults: [], searchSelected: {}, searchSelectedCount: 0 })
            await this.loadSignups()
          } else {
            wx.showToast({ title: res.error || '添加失败', icon: 'none' })
          }
        } catch (e) {
          this.setData({ batchAddLoading: false })
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
        const teams = (res.data && res.data.teams) ? res.data.teams : []
        const freeAgents = (res.data && res.data.free_agents) ? res.data.free_agents : []
        this.setData({ teams, freeAgents })
      }
    } catch (e) {
      this.setData({ teamsLoading: false })
      console.error('[编组] 加载失败', e)
    }
  },

  // 自动分队
  async doAutoAllocate() {
    if (!this.data.actions.manage_teams || !this.data.actions.manage_teams.allowed) {
      wx.showToast({ title: '无操作权限', icon: 'none' }); return
    }
    wx.showModal({
      title: '自动分队',
      content: '将使用蛇形均衡算法自动编组，确定继续？',
      success: async (r) => {
        if (!r.confirm) return
        this.setData({ allocating: true })
        try {
          const res = await api.post('/events/' + this.data.eventId + '/allocate-teams', {})
          this.setData({ allocating: false })
          if (res.success) {
            // 自动分队返回的是建议方案，不直接写库，展示给用户确认
            const teams = (res.data && res.data.teams) ? res.data.teams : []
            const freeAgents = (res.data && res.data.free_agents) ? res.data.free_agents : []
            this.setData({ teams, freeAgents })
            wx.showToast({ title: '自动分队完成', icon: 'success' })
          } else {
            wx.showToast({ title: res.error || '分队失败', icon: 'none' })
          }
        } catch (e) {
          this.setData({ allocating: false })
          wx.showToast({ title: '分队失败，请重试', icon: 'none' })
        }
      }
    })
  },

  // 前往队伍编辑页
  goTeamEdit() {
    wx.navigateTo({
      url: '/pages/event-team-edit/event-team-edit?eventId=' + this.data.eventId
    })
  },

  // 锁定分组并开赛
  async doLockTeams() {
    if (!this.data.actions.lock_teams || !this.data.actions.lock_teams.allowed) {
      wx.showToast({ title: '无操作权限', icon: 'none' }); return
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
            // 自动切换到对战Tab
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
