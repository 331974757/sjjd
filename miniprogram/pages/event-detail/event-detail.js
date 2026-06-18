// ============================================================
// pages/event-detail/event-detail.js
// 【赛事详情 - 阶段式Tab分栏重构版】
// 5个Tab按赛事业务流程排列，随状态递进解锁
// 严格复用所有现有后端接口与权限系统，仅重构前端页面结构
// ============================================================
const api = require('../../utils/api.js')
const perm = require('../../utils/permission.js')
const R = require('../../utils/rank-utils.js')
const dt = require('../../utils/datetime-picker.js')
const modal = require('../../utils/modal.js')

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

/** 统一选手数据规范化：填充中文段位名 + 等效MMR + 位置文本 */
function normalizePlayer(p) {
  const rankName = R.normalizeRankName(p.calibrate_rank_name)
  return {
    ...p,
    calibrate_rank_name: rankName,
    _posText: formatPosition(p),
    calibrate_mmr: R.calcEquivalentMmr(rankName, p.calibrate_rank_star, p.calibrate_mmr)
  }
}

/** 统一自由选手规范化：填充ID */
function normalizeFreeAgent(p) {
  const np = normalizePlayer(p)
  return { ...np, id: p.id || p.player_id || p._id || '' }
}

/** 统一队伍数据规范化：展开members、解析队长、计算统计 */
function normalizeTeamItem(t, calcStatsFn, canEditNameFn) {
  const rawMembers = (t.members || t.players || []).map(normalizePlayer)
  const cid = t.captain_id || t.captainId || ''
  let cname = t.captain_name || (t.captain ? t.captain.wx_nickname : '') || ''
  if (!cname && cid && rawMembers.length > 0) {
    const found = rawMembers.find(m => String(m.id || m.player_id || m._id) === String(cid))
    cname = found ? (found.wx_nickname || found.nickName || '') : ''
  }
  const stats = calcStatsFn(rawMembers)
  const teamObj = {
    team_id: t.team_id || t.teamId || '',
    team_name: t.team_name || t.teamName || '未命名',
    captain_id: cid,
    captain_name: cname,
    members: rawMembers,
    players: rawMembers,
    ...stats
  }
  teamObj._canEditName = canEditNameFn(teamObj)
  return teamObj
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
    isSuperAdmin: false,
    readonly: false,
    fromHistory: false,

    // ===== Tab系统 =====
    // Tab定义: {key, label, unlockStatus} — unlockStatus为解锁所需的最小event_status
    tabs: [
      { key: 'overview', label: '赛事概览', unlockStatus: 0 },
      { key: 'signups', label: '报名管理', unlockStatus: 1 },
      { key: 'teams', label: '分组编组', unlockStatus: 2 },
      { key: 'matches', label: '对阵对战', unlockStatus: 3 },
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
    // 比赛时间编辑（统一 multiSelector：年-月-日-时-分，点击即选，选择即保存）
    editTimeIndex: [0, 0, 0, 12, 0],
    editTimeRange: [
      ['2026年', '2027年', '2028年', '2029年'],
      ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'],
      ['1日', '2日', '3日', '4日', '5日', '6日', '7日', '8日', '9日', '10日', '11日', '12日', '13日', '14日', '15日', '16日', '17日', '18日', '19日', '20日', '21日', '22日', '23日', '24日', '25日', '26日', '27日', '28日', '29日', '30日', '31日'],
      ['00时', '01时', '02时', '03时', '04时', '05时', '06时', '07时', '08时', '09时', '10时', '11时', '12时', '13时', '14时', '15时', '16时', '17时', '18时', '19时', '20时', '21时', '22时', '23时'],
      ['00分', '30分']
    ],
    // 取消赛事
    showCancelEventModal: false,
    cancelEventSubmitting: false,
    // 对战确认弹窗
    showBattleConfirmModal: false,
    battleConfirmTitle: '',
    battleConfirmList: [],
    battleConfirmHint: '',
    _battleConfirmResolve: null,

    // ===== Tab2: 报名管理 =====
    signups: [],           // 报名列表
    signupCount: 0,
    signupPage: 1,         // 当前分页页码
    signupPageSize: 10,    // 每页10人
    signupTotal: 0,        // 总报名人数
    signupTotalPages: 1,   // 总页数（WXML不能用Math.ceil，在JS计算）
    signupHasMore: false,  // 是否有更多页
    signupLoadingMore: false, // 正在加载更多
    mySignup: null,        // 当前用户报名状态
    mySignupLoaded: false, // mySignup 是否已尝试加载（用于 WXML 避免闪烁）
    _myPlayerId: '',       // 当前用户的选手ID（从 mySignup 获取）
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
    autoTeamSuggestion: '',     // 建议组数
    selectedPlayerId: '',       // 当前选中的自由选手ID
    // 战队名编辑
    _editingTeamId: '',         // 正在编辑名称的队伍ID
    _editTeamNameValue: '',     // 编辑中的战队名

    // ===== Tab4: 对阵对战（积分榜模式） =====
    battleRounds: [],            // 轮次列表
    battleRound: 0,              // 当前轮次编号
    battleRoundNum: 0,           // 当前轮次（用于生成下一轮）
    battleAllDone: false,        // 所有轮次全部完成
    // —— 队伍积分榜 ——
    battleScoreboard: [],        // 所有队伍积分榜 [{teamId, teamName, captainName, score, wins, losses, totalMmr}]
    battleSelectedIds: [],       // 本轮选中参战的队伍ID
    // —— 对战配对 ——
    battlePairs: [],             // 本轮配对 [{teamA:{}, teamB:{}}]
    battleMatches: [],           // 本轮已生成的对战记录
    battleRoundHasMatches: false, // 本轮是否已有对战记录
    battleRoundStatus: '',       // 本轮状态: 'select'|'pairing'|'fighting'|'done'
    // —— 操作状态 ——
    battleLoading: false,
    battlePairing: false,        // 正在配对中
    battleStarting: false,       // 正在开战中
    battleDeleting: false,       // 正在清除本轮对战
    // —— 对战卡片交互 ——
    showJudgeModal: false,
    judgeMatch: null,
    judgeStep: 0,
    judgeWinnerId: '',
    // —— 下一轮/结束比赛 ——
    showBattleActionModal: false,
    battleActionType: '',
    battleActionSubmitting: false,
    // —— 换队选择弹窗 ——
    showSwapModal: false,
    swapMatchId: '',
    swapSide: 'A',  // 要换的是 A队 还是 B队
    // —— 手动配对-队伍选择弹窗 ——
    showPairTeamPicker: false,
    pairPickerIndex: -1,
    pairPickerSide: 'A',
    pairPickerTeams: [],        // 可选队伍列表（积分榜数据）
    _pairUsedIds: [],            // 当前已使用队伍ID（灰化）

    // ===== Tab5: 名次归档 =====
    isArchived: false,
    _archiveTimeText: '',
    _archiveByText: '',
    ranks: [],
    ranksLoading: false,
    rankEditSlots: [],           // [{rankNum, teamId, teamName, captainName, members:[{id,nickName}]}]
    rankTeamCards: [],           // 上方队伍展示区 [{teamId, teamName, captainName, wins}]
    _rankUsedTeamMap: {},        // 预计算的已用队伍映射 { teamId: true }
    rankSelectedTeamId: '',      // 当前选中的队伍ID（从上方队伍区选中）
    teamsForRank: [],
    ranksEditing: false,
    ranksSaving: false,
    showArchiveConfirm: false,
    archiveSubmitting: false,

    // ===== 修改报名人数上限弹窗 =====
    showSignupLimitModal: false,
    editSignupLimitVal: '',       // 当前选择的限制选项
    editCustomSignupLimit: '',    // 自定义输入

    // 开启报名时的人数上限（滚轮选择器）
    signupLimitOptions: ['10人', '20人', '30人', '40人', '无限制', '自定义'],
    signupLimitValues:  ['10',  '20',  '30',  '40',  'unlimited', 'custom'],
    signupLimitIndex: 0,
    customSignupLimit: '',

    // 赛事进度条
    progressSteps: [],
    // 概览页跳转按钮（根据赛事状态动态显示）
    _overviewJump: null,
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

    const app = getApp()
    const lastShow = app.globalData._lastShowTime || 0
    const now = Date.now()

    // 如果从小程序后台切回（间隔超过 60 秒），全量刷新
    if (lastShow && (now - lastShow) > 60000) {
      this.setData({ loaded: false })
      this.initPage()
      return
    }

    // 回页刷新赛事状态+权限
    this.loadEvent().then(() => {
      if (this.data.event) this._refreshTabData()
    })
  },

  /** 手动刷新按钮 */
  async onRefreshTap() {
    wx.showLoading({ title: '刷新中...', mask: true })
    try {
      await this.loadEvent()
      this._updateTabLocks()
      this._updateActions()
      await this._loadTabData(this.data.activeTab)
      wx.showToast({ title: '已刷新', icon: 'success', duration: 1200 })
    } catch (e) {
      wx.showToast({ title: '刷新失败', icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },

  // ============ 初始化 ============
  async initPage() {
    try {
      if (this.data.readonly) {
        const role = await perm.getRole()
        this.setData({ userRole: role, isAdmin: false, isSuperAdmin: false })
      } else {
        const role = await perm.getRole()
        const isAdmin = role === 'admin' || role === 'super_admin'
        const isSuperAdmin = role === 'super_admin'
        this.setData({ userRole: role, isAdmin, isSuperAdmin })
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
      // 进入页面时默认跳转到最新可用环节（如报名管理阶段则直接定位到报名管理）
      const latestUnlocked = [...this.data.tabs].reverse().find(t => !t._locked)
      if (latestUnlocked && latestUnlocked.key !== this.data.activeTab) {
        this._switchToTab(latestUnlocked.key)
      }
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
        event._createdAtText = event.created_at ? '创建时间：' + this.formatTime(event.created_at) : ''
        const ts = event.start_time
        this.setData({
          event,
          isArchived: event.is_archived === 1,
          _archiveTimeText: event.archived_at ? '归档时间：' + this.formatTime(event.archived_at) : '',
          _archiveByText: event.archived_by_nickname ? '归档操作人：' + event.archived_by_nickname : (event.archived_by ? '归档操作人：' + event.archived_by : ''),
          editTimeRange: this._buildEditTimeRange(ts),
          editTimeIndex: this._getEditTimeIndex(ts)
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

    // 更新进度条
    this._updateProgressSteps()
  },

  /** 计算赛事进度条 */
  _updateProgressSteps() {
    const status = this.data.event.event_status
    const isArchived = this.data.isArchived
    const steps = [
      { label: '创建中', key: 'draft' },
      { label: '报名中', key: 'signup' },
      { label: '分组编队', key: 'signup_closed' },
      { label: '分组锁定', key: 'locked' },
      { label: '对战中', key: 'fighting' },
      { label: '名次归档', key: 'archived' }
    ]
    const progressSteps = steps.map((s, i) => ({
      ...s,
      _done: isArchived ? true : (i < status),
      _active: isArchived ? (i === 5) : (i === status)
    }))
    this.setData({ progressSteps })
  },

  /** Tab 点击切换 */
  switchTab(e) {
    const index = parseInt(e.currentTarget.dataset.index)
    const tab = this.data.tabs[index]
    if (!tab) return

    // 未解锁提示
    if (tab._locked && !this.data.readonly) {
      const statusNames = ['创建中', '报名中', '分组编队', '分组锁定', '对战中', '名次归档']
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
        // 如果赛事已结束，同时预加载名次数据供概览统计
        this._updateActions()
        const overviewTasks = [this.loadSignups(), this.loadMySignup()]
        if (this.data.event && this.data.event.event_status >= 5) {
          overviewTasks.push(this.loadRanks())
        }
        await Promise.all(overviewTasks)
        break
      case 'signups':
        await Promise.all([this.loadSignups(), this.loadMySignup()])
        break
      case 'teams':
        await this.loadTeams()
        break
      case 'matches':
        await this.loadBattleData()
        break
      case 'ranks':
        this.setData({ ranksLoading: true })
        await Promise.all([this.loadRanks(), this.loadRankTeamCards()])
        this.setData({ ranksLoading: false })
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
    // 更新概览页跳转按钮
    this._computeOverviewJump()
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
      } else {
        wx.showToast({ title: res.error || '更新失败', icon: 'none' })
      }
    } catch (e) {
      wx.showToast({ title: '更新失败，请重试', icon: 'none' })
    }
  },

  // ── 比赛时间（点击即选，选择即保存） ──
  // 构建日期时间多列数据
  _buildEditTimeRange(ts) {
    const now = new Date()
    const d = ts ? new Date(parseInt(ts)) : now
    return dt.buildRange({ selYear: d.getFullYear(), selMonth: d.getMonth() + 1 })
  },

  // 从时间戳获取选择器索引
  _getEditTimeIndex(ts) {
    return dt.buildIndex(ts ? parseInt(ts) : null, new Date().getFullYear())
  },

  // 列滚动时动态调整日数
  onEditTimeColumnChange(e) {
    const { column, value } = e.detail
    const result = dt.onColumnChange(this.data.editTimeRange, this.data.editTimeIndex, column, value)
    this.setData({ editTimeRange: result.range, editTimeIndex: result.idx })
  },

  // 选择器确认 → 直接保存
  onEditTimeChange(e) {
    const idx = e.detail.value
    this.setData({ editTimeIndex: idx })
    this._saveTime(idx)
  },

  // 从索引推算时间戳
  _getDateTimeFromEditIndex(idx) {
    return dt.toTimestamp(this.data.editTimeRange, idx)
  },

  // 保存时间到服务器
  async _saveTime(idx) {
    const ts = this._getDateTimeFromEditIndex(idx)
    if (!ts || isNaN(ts)) {
      const backIdx = this._getEditTimeIndex(this.data.event.start_time)
      this.setData({ editTimeIndex: backIdx })
      wx.showToast({ title: '选择时间无效', icon: 'none' })
      return
    }
    if (ts === this.data.event.start_time) return
    wx.showLoading({ title: '更新中...' })
    try {
      const res = await api.put('/events/' + this.data.eventId, { startTime: ts })
      wx.hideLoading()
      if (res.success) {
        this.setData({
          'event.start_time': ts,
          'event._timeLabel': this.formatTime(ts),
          editTimeIndex: idx
        })
      } else {
        wx.showToast({ title: res.error || '更新失败', icon: 'none' })
        const backIdx = this._getEditTimeIndex(this.data.event.start_time)
        this.setData({ editTimeIndex: backIdx })
      }
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: '更新失败，请重试', icon: 'none' })
      const backIdx = this._getEditTimeIndex(this.data.event.start_time)
      this.setData({ editTimeIndex: backIdx })
    }
  },

  // ── 取消赛事 ──
  showCancelEvent() {
    this.setData({ showCancelEventModal: true })
  },
  hideCancelEvent() {
    this.setData({ showCancelEventModal: false })
  },
  async doCancelEvent() {
    this.setData({ showCancelEventModal: false, cancelEventSubmitting: true })
    try {
      const res = await api.del('/events/' + this.data.eventId)
      this.setData({ cancelEventSubmitting: false })
      if (res.success) {
        wx.showToast({ title: '赛事已取消', icon: 'success' })
        setTimeout(() => { wx.navigateBack() }, 1200)
      } else {
        wx.showToast({ title: res.error || '取消失败', icon: 'none' })
      }
    } catch (e) {
      this.setData({ cancelEventSubmitting: false })
      wx.showToast({ title: '取消失败，请重试', icon: 'none' })
    }
  },

  // ── 对战确认弹窗 ──
  showBattleConfirm(title, list, hint) {
    return new Promise(resolve => {
      this.setData({
        showBattleConfirmModal: true,
        battleConfirmTitle: title,
        battleConfirmList: list,
        battleConfirmHint: hint || '',
        _battleConfirmResolve: resolve
      })
    })
  },
  onBattleConfirmOk() {
    if (this.data._battleConfirmResolve) {
      this.data._battleConfirmResolve(true)
    }
    this.setData({ showBattleConfirmModal: false, _battleConfirmResolve: null })
  },
  onBattleConfirmCancel() {
    if (this.data._battleConfirmResolve) {
      this.data._battleConfirmResolve(false)
    }
    this.setData({ showBattleConfirmModal: false, _battleConfirmResolve: null })
  },

  // ============ 工具函数 ============
  getStatusName(status) {
    const map = { 0: '创建中', 1: '报名中', 2: '分组编队', 3: '分组锁定', 4: '对战中', 5: '名次归档' }
    return map[status] || '未知'
  },
  getStatusClass(status) {
    const map = { 0: 's-draft', 1: 's-open', 2: 's-closed', 3: 's-locked', 4: 's-fighting', 5: 's-archived' }
    return map[status] || ''
  },
  formatTime(ts) {
    if (!ts) return '待定'
    // 兼容多种格式：数字时间戳 / ISO字符串 / MySQL日期时间字符串
    let d
    if (typeof ts === 'number') {
      d = new Date(ts)
    } else if (typeof ts === 'string') {
      // MySQL datetime 可能没有 T 分隔符，先标准化
      const norm = ts.trim().replace(' ', 'T')
      d = new Date(norm)
    } else {
      d = new Date(ts)
    }
    if (isNaN(d.getTime())) {
      // 最后兜底：尝试 parseInt
      const n = parseInt(ts)
      if (!isNaN(n) && n > 0) d = new Date(n > 10000000000 ? n : n * 1000)
      else return '待定'
    }
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

  // 开启/截止报名
  showStatusConfirm() {
    const next = this.getNextStatus()
    if (!next) { wx.showToast({ title: '当前状态不支持此操作', icon: 'none' }); return }
    // 开启报名：直接执行，不弹窗
    if (next.status === 1) {
      this._doChangeStatusDirect(1)
      return
    }
    this.setData({
      showStatusConfirm: true,
      targetStatus: next.status,
      targetStatusName: next.name,
      _confirmTitle: next.title,
      _confirmMsg: next.msg
    })
  },
  // 直接变更状态（无需弹窗确认）
  async _doChangeStatusDirect(status) {
    const payload = { eventStatus: status }
    if (status === 1) {
      const limit = this.data.event.signup_limit
      payload.signupLimit = (limit && limit > 0) ? limit : 0
    }
    this.setData({ loading: true })
    try {
      const res = await api.put('/events/' + this.data.eventId + '/status', payload)
      this.setData({ loading: false })
      if (res.success) {
        await this.loadEvent()
        this._updateTabLocks()
        this._updateActions()
      } else {
        wx.showToast({ title: res.error || '操作失败', icon: 'none' })
      }
    } catch (e) {
      this.setData({ loading: false })
      wx.showToast({ title: '操作失败，请重试', icon: 'none' })
    }
  },
  hideStatusConfirm() {
    this.setData({ showStatusConfirm: false, signupLimitIndex: 0, customSignupLimit: '' })
  },
  // 滚轮选择器：报名人数上限
  onSignupLimitPick(e) {
    this.setData({ signupLimitIndex: e.detail.value, customSignupLimit: '' })
  },
  // 自定义人数输入
  onCustomLimitInput(e) { this.setData({ customSignupLimit: e.detail.value }) },
  async doChangeStatus() {
    const payload = { eventStatus: this.data.targetStatus }
    this.setData({ showStatusConfirm: false, loading: true })
    try {
      const res = await api.put('/events/' + this.data.eventId + '/status', payload)
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

  // 管理员：修改报名人数上限（分组编队前）
  showEditSignupLimit() {
    const { event } = this.data
    if (!event) return
    const currentLimit = event.signup_limit
    let val = 'unlimited'
    if (currentLimit && currentLimit > 0) {
      // 预设值匹配
      if ([10, 20, 30, 40].includes(currentLimit)) {
        val = String(currentLimit)
      } else {
        val = 'custom'
        this.setData({ editCustomSignupLimit: String(currentLimit) })
      }
    }
    this.setData({
      showSignupLimitModal: true,
      editSignupLimitVal: val,
      editCustomSignupLimit: val === 'custom' ? (this.data.editCustomSignupLimit || String(currentLimit || '')) : ''
    })
  },
  hideEditSignupLimit() {
    this.setData({ showSignupLimitModal: false, editSignupLimitVal: '', editCustomSignupLimit: '' })
  },
  selectEditSignupLimit(e) {
    this.setData({ editSignupLimitVal: e.currentTarget.dataset.val, editCustomSignupLimit: '' })
  },
  onEditCustomLimitInput(e) { this.setData({ editCustomSignupLimit: e.detail.value }) },
  async doUpdateSignupLimit() {
    const { editSignupLimitVal, editCustomSignupLimit } = this.data
    let limitVal
    if (editSignupLimitVal === 'unlimited') {
      limitVal = 0
    } else if (editSignupLimitVal === 'custom') {
      limitVal = parseInt(editCustomSignupLimit)
      if (!limitVal || limitVal <= 0) {
        wx.showToast({ title: '请输入有效人数', icon: 'none' }); return
      }
    } else {
      limitVal = parseInt(editSignupLimitVal)
    }

    this.setData({ showSignupLimitModal: false, loading: true })
    try {
      const res = await api.put('/events/' + this.data.eventId + '/signup-limit', { signupLimit: limitVal })
      this.setData({ loading: false })
      if (res.success) {
        await this.loadEvent()
        await this.loadSignups()
        this._updateActions()
      } else {
        wx.showToast({ title: res.error || '更新失败', icon: 'none' })
      }
    } catch (e) {
      this.setData({ loading: false })
      wx.showToast({ title: '更新失败，请重试', icon: 'none' })
    }
  },

  // 根据赛事状态计算概览页跳转按钮
  _computeOverviewJump() {
    const { event, readonly } = this.data
    if (!event || readonly) { this.setData({ _overviewJump: null }); return }
    const status = event.event_status
    const jumpMap = {
      0: null,                          // 创建中：不显示跳转按钮
      1: { tab: 'signups', index: 1, label: '📝 前往报名管理', desc: '管理报名人员' },
      2: { tab: 'teams', index: 2, label: '👥 前往分组编组', desc: '进行队伍分组编排' },
      3: { tab: 'teams', index: 2, label: '👥 查看分组编组', desc: '分组已锁定，查看队伍编排' },
      4: { tab: 'matches', index: 3, label: '⚔️ 前往对阵对战', desc: '编排对战与判定胜负' },
      5: { tab: 'ranks', index: 4, label: '🏆 前往名次归档', desc: '设定最终排名' }
    }
    this.setData({ _overviewJump: jumpMap[status] || null })
  },

  // 去分组(状态=2时) — 直接切Tab
  goToTeamsTab() { this._switchToTab('teams') },

  // 去对阵(状态=4时) — 直接切Tab
  goToMatchesTab() { this._switchToTab('matches') },

  // 去归档(状态=5未归档时) — 直接切Tab
  goToRanksTab() { this._switchToTab('ranks') },

  // 从概览页点击名次图标 → 切到名次Tab并进入编辑模式
  goEditRanks() {
    this._switchToTab('ranks')
    // 稍等Tab切换完成后再进入编辑
    setTimeout(() => this.startEditRanks(), 300)
  },

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
        const pageSize = this.data.signupPageSize
        this.setData({
          signups: list,
          signupCount: res.total || list.length,
          signupPage: res.page || page,
          signupTotal: total,
          signupTotalPages: Math.ceil(total / pageSize) || 1,
          signupHasMore: page * pageSize < total
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
        this.setData({
          mySignup: res.data,
          mySignupLoaded: true,
          _myPlayerId: res.data.playerId || ''
        })
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
    const { event, mySignup, signupCount } = this.data
    if (event.event_status !== 1) { wx.showToast({ title: this.getBtnDisabledReason(), icon: 'none' }); return }
    if (mySignup && mySignup.signedUp) { wx.showToast({ title: '您已报名当前赛事', icon: 'none' }); return }
    // 前端校验：报名人数上限（仅自主报名受限，管理员添加不受限）
    if (event.signup_limit && event.signup_limit > 0 && signupCount >= event.signup_limit) {
      wx.showToast({ title: '报名人数已满（上限' + event.signup_limit + '人）', icon: 'none', duration: 2000 })
      return
    }
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

  async _handleSignupError(res) {
    const code = res.code || ''
    switch (code) {
      case 'NICKNAME_EMPTY':
        const r1 = await modal.confirm(this, { theme: 'warning', title: '未设置昵称', content: '请先设置您的微信群昵称后再报名。\n\n点击「确认」去设置昵称。' }); if (r1.confirm) wx.navigateBack(); break
      case 'PLAYER_NOT_FOUND':
        await modal.confirm(this, { theme: 'warning', title: '未找到选手档案', content: '未找到与您昵称匹配的选手档案，请联系管理员先录入您的选手信息。', showCancel: false }); break
      case 'MULTIPLE_MATCH':
        await modal.confirm(this, { theme: 'warning', title: '匹配到多条记录', content: '您的昵称匹配到多个选手档案，请联系管理员手动添加报名。', showCancel: false }); break
      case 'ALREADY_SIGNED':
        wx.showToast({ title: '您已报名当前赛事', icon: 'none' }); break
      case 'EVENT_NOT_OPEN':
        wx.showToast({ title: res.error || '当前赛事不在报名阶段', icon: 'none' }); break
      case 'SIGNUP_FULL':
        wx.showToast({ title: '报名人数已满', icon: 'none', duration: 2000 }); break
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
  clearSearch() {
    if (this._searchTimer) { clearTimeout(this._searchTimer); this._searchTimer = null }
    this.setData({ searchKeyword: '', searchResults: [] })
  },

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
  async doSingleAdd(e) {
    const pid = e.currentTarget.dataset.pid
    const player = this.data.searchResults.find(p => p._id == pid)
    const name = player ? (player.wx_nickname || '未知') : ''
    const r = await modal.confirm(this, {
      title: '添加报名',
      content: '确定将「' + name + '」加入报名池？'
    })
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
        let freeAgents = (res.data && res.data.freePlayers) ? res.data.freePlayers : []

        teams = teams.map(t => normalizeTeamItem(t, this._calcTeamStats, this._canEditTeamName.bind(this)))

        // 自由选手：保留完整字段，确保 id 存在，并标准化段位名
        freeAgents = freeAgents.map(normalizeFreeAgent).filter(p => p.id)

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
        const result = { ...t, members: sortedMembers, players: sortedMembers }
        result._canEditName = this._canEditTeamName(result)
        return result
      })
      .sort((a, b) => (b.total_mmr || 0) - (a.total_mmr || 0))
  },

  /** 刷新所有队伍的 _canEditName 标记 */
  _refreshTeamEditFlags() {
    const teams = this.data.teams.map(t => ({ ...t, _canEditName: this._canEditTeamName(t) }))
    this.setData({ teams })
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
  async deleteTeam(e) {
    const teamId = e.currentTarget.dataset.teamId
    const team = this.data.teams.find(t => String(t.team_id) === String(teamId))
    if (!team) return

    const members = team.members || team.players || []
    const r = await modal.confirm(this, {
      theme: 'danger',
      title: '删除队伍',
      content: members.length > 0
        ? '删除「' + team.team_name + '」将释放 ' + members.length + ' 名队员到自由区，确认删除？'
        : '确认删除空队伍「' + team.team_name + '」？'
    })
    if (!r.confirm) return
    const freeAgents = [...this.data.freeAgents, ...members]
    const teams = this.data.teams.filter(t => String(t.team_id) !== String(teamId))
    this.setData({ teams: this._normalizeTeams(teams), freeAgents, selectedPlayerId: '', teamsDirty: true })
    wx.showToast({ title: '已删除', icon: 'success' })
  },

  // ============ 战队名编辑（队长/管理员，保存分组后，归档前） ============
  /** 判断当前用户是否可以编辑指定队伍的名称 */
  _canEditTeamName(team) {
    const { event, isAdmin, isArchived, _myPlayerId } = this.data
    if (isArchived || !team) return false
    // 仅「分组编队」阶段(状态2)可编辑；分组锁定(3)/对战中(4)/已归档(5)均禁止
    if (!event || event.event_status !== 2) return false
    // 管理员可编辑
    if (isAdmin) return true
    // 队长可编辑
    if (_myPlayerId && String(team.captain_id) === String(_myPlayerId)) return true
    return false
  },

  /** 开始编辑战队名 */
  startEditTeamName(e) {
    const teamId = e.currentTarget.dataset.teamId
    const team = this.data.teams.find(t => String(t.team_id) === String(teamId))
    if (!team || !this._canEditTeamName(team)) return
    this.setData({ _editingTeamId: teamId, _editTeamNameValue: team.team_name })
  },

  /** 取消编辑 */
  cancelEditTeamName() {
    this.setData({ _editingTeamId: '', _editTeamNameValue: '' })
  },

  /** 战队名输入 */
  onEditTeamNameInput(e) {
    this.setData({ _editTeamNameValue: e.detail.value })
  },

  /** 确认修改战队名 */
  async confirmEditTeamName() {
    const { _editingTeamId, _editTeamNameValue, eventId } = this.data
    const val = (_editTeamNameValue || '').trim()
    if (!val) { wx.showToast({ title: '战队名不能为空', icon: 'none' }); return }
    if (val.length > 50) { wx.showToast({ title: '战队名不能超过50个字符', icon: 'none' }); return }

    this.setData({ _editingTeamId: '', _editTeamNameValue: '' })
    wx.showLoading({ title: '更新中...' })
    try {
      const res = await api.put('/events/' + eventId + '/teams/' + _editingTeamId + '/name', { teamName: val })
      wx.hideLoading()
      if (res.success) {
        // 更新本地队伍名
        const teams = this.data.teams.map(t => {
          if (String(t.team_id) === String(_editingTeamId)) {
            return { ...t, team_name: val }
          }
          return t
        })
        this.setData({ teams })
        wx.showToast({ title: '战队名已更新', icon: 'success' })
      } else {
        wx.showToast({ title: res.error || '更新失败', icon: 'none' })
      }
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: '更新失败，请重试', icon: 'none' })
    }
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
      if (members.length < 5) {
        wx.showToast({ title: '「' + team.team_name + '」至少需要5名队员，当前仅' + members.length + '人', icon: 'none' }); return
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
        let freeAgents = (res.data && res.data.freePlayers) ? res.data.freePlayers : []

        // 规范化队伍数据，使用统一 helper + 分配临时ID
        teams = teams.map((t, i) => ({
          ...normalizeTeamItem(t, this._calcTeamStats, this._canEditTeamName.bind(this)),
          team_id: 'alloc_' + (i + 1) + '_' + Date.now(),
          team_name: t.teamName || t.team_name || ('战队' + (i + 1)),
          isNew: true
        }))
        // 规范化自由选手
        freeAgents = freeAgents.map(normalizeFreeAgent).filter(p => p.id)

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
    const r = await modal.confirm(this, {
      theme: 'danger',
      title: '锁定分组并开赛',
      content: '确认锁定当前分组并开始比赛？\n\n锁定后队伍信息不可修改，赛事进入对战中状态。'
    })
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
  },

  // 跳转到队伍编辑页（保留兼容，但不再使用）
  goTeamEdit() {
    // 不再跳转独立页面，所有操作在 Tab3 内完成
    this._switchToTab('teams')
  },

  // ================================================================
  //  Tab4: 对阵对战（积分榜模式）
  //  模式: select(选队配对) → pairing(调整分组+生成确认) → fighting(判定胜负) → done

  // ================================================================

  // 兜底：如果后端未返回 avgMmr，用 totalMmr / memberCount 前端计算
  _ensureAvgMmr(item) {
    if (item.avgMmr === undefined || item.avgMmr === null) {
      const memberCount = item.memberCount || (item.playerCount || 0);
      if (item.totalMmr && memberCount > 0) {
        item.avgMmr = Math.round(item.totalMmr / memberCount);
      } else {
        item.avgMmr = 0;
      }
    }
    return item;
  },

  // ============ 加载对战数据（积分榜+轮次+当前轮对战） ============
  async loadBattleData() {
    this.setData({ battleLoading: true })
    try {
      const eventId = this.data.eventId
      const [sbRes, roundsRes] = await Promise.all([
        api.get('/events/' + eventId + '/teams/scoreboard'),
        api.get('/events/' + eventId + '/matches/rounds')
      ])
      if (sbRes.success) {
        // teamId 统一转字符串，_selected 初始 false，并兜底计算 avgMmr
        const sb = (sbRes.data || []).map(s => this._ensureAvgMmr({ ...s, teamId: String(s.teamId), _selected: false }))
        this.setData({ battleScoreboard: sb, battleSelectedIds: [] })
      }
      let curRound = 0, allDone = false, rounds = []
      if (roundsRes.success) {
        rounds = roundsRes.data.rounds || []
        curRound = roundsRes.data.currentRound || 0
        allDone = rounds.length > 0 && rounds.every(r => r.allDone)
      }
      // 确定当前轮次
      const rn = curRound || (rounds.length > 0 ? rounds[rounds.length - 1].roundNum : 0)
      const nextRn = rn > 0 ? rn : 1
      this.setData({
        battleRounds: rounds, battleRound: rn, battleRoundNum: nextRn, battleAllDone: allDone,
        battleRoundHasMatches: false, battleRoundStatus: 'select',
        battleMatches: [], battlePairs: [], battleSelectedIds: [],
        battleLoading: false
      })
      // 加载当前轮对战详情
      if (rn > 0) await this.loadRoundMatches(rn)
    } catch (e) {
      this.setData({ battleLoading: false })
      console.error('[对战] 加载失败', e)
    }
  },

  // 加载指定轮次的对战记录
  async loadRoundMatches(round) {
    try {
      const res = await api.get('/events/' + this.data.eventId + '/matches', { round })
      if (res.success) {
        let matches = res.data || []
        // 用积分榜数据丰富每场对战的队伍分数和队长名（统一String key防类型不匹配）
        const sbMap = {}
        this.data.battleScoreboard.forEach(s => { sbMap[String(s.teamId)] = s })
        matches = matches.map(m => {
          const a = sbMap[String(m.team_a_id)] || {}
          const b = sbMap[String(m.team_b_id)] || {}
          return {
            ...m,
            team_a_score: a.wins || 0,
            team_a_captain: a.captainName || '',
            team_b_score: b.wins || 0,
            team_b_captain: b.captainName || '',
            battle_image: m.battle_image ? (m.battle_image.startsWith('http') ? m.battle_image : 'https://congqin.online' + m.battle_image) : ''
          }
        })
        // 判断本轮状态
        let status = 'select'
        let hasMatches = matches.length > 0
        if (hasMatches) {
          const allDraft = matches.every(m => m.match_status === 0)
          const allDone = matches.every(m => m.match_status === 2)
          const anyFighting = matches.some(m => m.match_status === 1)
          if (allDone) status = 'done'
          else if (anyFighting || !allDraft) status = 'fighting'
          else status = 'pairing'
        }
        this.setData({
          battleMatches: matches,
          battleRoundHasMatches: hasMatches,
          battleRoundStatus: status
        })
        // 根据状态回填选中ID，同步 _selected 标记
        if (hasMatches) {
          const ids = new Set()
          matches.forEach(m => { if (m.team_a_id) ids.add(String(m.team_a_id)); if (m.team_b_id) ids.add(String(m.team_b_id)) })
          this._syncBattleSelected([...ids])
        }
        // 开战后不显示配对编辑
        if (status === 'fighting' || status === 'done') {
          this.setData({ battlePairs: [] })
        }
      }
    } catch (e) { console.error('[对战] 加载轮次失败', e) }
  },

  // 切换轮次
  switchRound(e) {
    const round = parseInt(e.currentTarget.dataset.round)
    if (!round) return
    this.setData({ battleRound: round, battleRoundStatus: '', battleMatches: [], battlePairs: [] })
    this._syncBattleSelected([])
    this.loadRoundMatches(round)
  },

  // ============ 选队配对 ============

  // 将 battleSelectedIds 同步为 battleScoreboard 每项的 _selected 标记
  _syncBattleSelected(selectedIds) {
    const set = new Set(selectedIds || this.data.battleSelectedIds)
    const sb = this.data.battleScoreboard.map(s => ({ ...s, _selected: set.has(s.teamId) }))
    this.setData({ battleScoreboard: sb, battleSelectedIds: [...set] })
  },

  // 点击队伍卡片切换参战选中
  toggleBattleTeam(e) {
    const teamId = String(e.currentTarget.dataset.teamId)

    // 检查是否已归档
    if (this.data.isArchived) {
      wx.showToast({ title: '赛事已归档，无法选队', icon: 'none', duration: 2000 })
      return
    }

    // 检查用户权限
    const matchPerm = this.data.actions.manage_matches
    if (!matchPerm || !matchPerm.allowed) {
      wx.showToast({ title: matchPerm ? matchPerm.reason : '无操作权限', icon: 'none', duration: 2000 })
      return
    }

    // 检查对战状态
    if (this.data.battleRoundStatus === 'fighting') {
      wx.showToast({ title: '对战中，无法更改参战队伍', icon: 'none', duration: 2000 })
      return
    }
    if (this.data.battleRoundStatus === 'done') {
      wx.showToast({ title: '本轮已结束，无法更改参战队伍', icon: 'none', duration: 2000 })
      return
    }

    // 执行选择/取消 — 直接改 battleScoreboard 每项的 _selected 标记
    const selectedSet = new Set(this.data.battleSelectedIds)
    const wasSelected = selectedSet.has(teamId)
    if (wasSelected) {
      selectedSet.delete(teamId)
    } else {
      selectedSet.add(teamId)
    }
    this._syncBattleSelected([...selectedSet])
  },

  // 手动添加一个对战组（空位）
  addManualPair() {
    if (this.data.battleRoundStatus === 'fighting' || this.data.battleRoundStatus === 'done') return
    const pairs = [...this.data.battlePairs]
    pairs.push({ teamA: null, teamB: null })
    this.setData({ battlePairs: pairs })
  },

  // 点击配对卡片的队伍位置：弹出队伍选择器
  pickTeamForPair(e) {
    if (!this.data.isAdmin) return
    const index = parseInt(e.currentTarget.dataset.index)
    const side = e.currentTarget.dataset.side
    // 收集当前已占用的队伍ID（排除当前槽位）
    const pairs = this.data.battlePairs
    const usedIds = []
    pairs.forEach((p, i) => {
      if (i !== index && p.teamA) usedIds.push(String(p.teamA.teamId))
      if (i !== index && p.teamB) usedIds.push(String(p.teamB.teamId))
    })
    this.setData({
      showPairTeamPicker: true,
      pairPickerIndex: index,
      pairPickerSide: side,
      pairPickerTeams: this.data.battleScoreboard,
      _pairUsedIds: usedIds
    })
  },

  // 在弹窗中选定队伍并填入配对槽位
  selectPairTeam(e) {
    const teamId = String(e.currentTarget.dataset.teamId)
    const { pairPickerIndex, pairPickerSide, pairPickerTeams, _pairUsedIds } = this.data
    if (_pairUsedIds.indexOf(teamId) >= 0) return

    const team = pairPickerTeams.find(t => String(t.teamId) === teamId)
    if (!team) return

    const pairs = [...this.data.battlePairs]
    if (pairPickerIndex >= 0 && pairPickerIndex < pairs.length) {
      pairs[pairPickerIndex] = { ...pairs[pairPickerIndex] }
      if (pairPickerSide === 'A') {
        pairs[pairPickerIndex].teamA = team
      } else {
        pairs[pairPickerIndex].teamB = team
      }
    }
    this.setData({ battlePairs: pairs, showPairTeamPicker: false })
  },

  // 关闭手动配对队伍选择弹窗
  closePairTeamPicker() {
    this.setData({ showPairTeamPicker: false, pairPickerIndex: -1, pairPickerSide: 'A', _pairUsedIds: [] })
  },

  // 自动匹配：根据分数将选中队伍相邻配对
  doBattleAutoMatch() {
    const { battleScoreboard, battleSelectedIds } = this.data
    const selectedIds = battleSelectedIds.length > 0
      ? battleSelectedIds
      : battleScoreboard.map(t => t.teamId)
    if (selectedIds.length < 2) { wx.showToast({ title: '至少需要2支队伍', icon: 'none' }); return }

    // 从积分榜中取出选中队伍（保持积分榜排序：分数降→队长名升）
    const teamMap = {}; battleScoreboard.forEach(t => { teamMap[t.teamId] = t })
    const sorted = selectedIds.map(id => teamMap[id]).filter(Boolean)
    const pairs = []
    for (let i = 0; i < sorted.length - 1; i += 2) {
      pairs.push({ teamA: sorted[i], teamB: sorted[i + 1] })
    }
    this.setData({ battlePairs: pairs })
    this._syncBattleSelected(selectedIds)
  },

  // 取消一组配对
  cancelBattlePair(e) {
    const idx = e.currentTarget.dataset.index
    const pairs = [...this.data.battlePairs]
    pairs.splice(idx, 1)
    this.setData({ battlePairs: pairs })
  },

  // 点击配对的队伍位置：弹出换队选择器
  openSwapModal(e) {
    const { matchId, side } = e.currentTarget.dataset
    this.setData({ showSwapModal: true, swapMatchId: matchId || '', swapSide: side || 'A' })
  },
  closeSwapModal() { this.setData({ showSwapModal: false, swapMatchId: '', swapSide: 'A' }) },

  // 选择替换的队伍
  async doSwapTeam(e) {
    const newTeamId = e.currentTarget.dataset.teamId
    const { swapSide, swapMatchId, battleScoreboard, eventId, battleMatches } = this.data
    if (!swapMatchId || !newTeamId) {
      this.setData({ showSwapModal: false })
      return
    }

    const newTeam = battleScoreboard.find(t => String(t.teamId) === String(newTeamId))
    if (!newTeam) {
      this.setData({ showSwapModal: false })
      wx.showToast({ title: '队伍不存在', icon: 'none' })
      return
    }

    const matchIdx = battleMatches.findIndex(m => m.match_id === swapMatchId)
    if (matchIdx < 0) {
      this.setData({ showSwapModal: false })
      return
    }

    const match = battleMatches[matchIdx]
    if (match.match_status !== 0) {
      wx.showToast({ title: '仅可调整待开战的对战', icon: 'none' })
      this.setData({ showSwapModal: false })
      return
    }

    // 检查是否与另一方重复
    const otherTeamId = swapSide === 'A' ? match.team_b_id : match.team_a_id
    if (String(newTeamId) === String(otherTeamId)) {
      wx.showToast({ title: '不能与对方相同', icon: 'none' })
      return
    }

    // 先更新本地（含均分）
    const updated = [...battleMatches]
    if (swapSide === 'A') {
      updated[matchIdx] = { ...match, team_a_id: newTeamId, team_a_name: newTeam.teamName,
        team_a_mmr: newTeam.totalMmr || 0, team_a_avg_mmr: newTeam.avgMmr || 0 }
    } else {
      updated[matchIdx] = { ...match, team_b_id: newTeamId, team_b_name: newTeam.teamName,
        team_b_mmr: newTeam.totalMmr || 0, team_b_avg_mmr: newTeam.avgMmr || 0 }
    }
    this.setData({ battleMatches: updated, showSwapModal: false })

    // 同步更新到服务器
    try {
      const res = await api.put('/events/' + eventId + '/matches/' + swapMatchId,
        swapSide === 'A' ? { teamAId: newTeamId } : { teamBId: newTeamId })
      if (!res.success) {
        wx.showToast({ title: res.error || '换队失败', icon: 'none' })
        // 恢复
        this.setData({ battleMatches })
      } else {
        // 替换成功，静默更新
      }
    } catch (e) {
      wx.showToast({ title: '换队失败，请重试', icon: 'none' })
      this.setData({ battleMatches })
    }
  },

  // ============ 生成对战（调用API） ============
  async doGenerateMatches() {
    const { battlePairs } = this.data
    if (battlePairs.length === 0) { wx.showToast({ title: '请先添加对战组', icon: 'none' }); return }
    // 验证每对都有两支队伍
    const incomplete = battlePairs.some(p => !p.teamA || !p.teamB)
    if (incomplete) { wx.showToast({ title: '请先填满所有对战组的队伍', icon: 'none' }); return }
    // 组装确认弹窗内容：列出每场对战详情
    const pairLines = battlePairs.map((p) => {
      const a = p.teamA || {}
      const b = p.teamB || {}
      return (a.teamName || '?') + '  VS  ' + (b.teamName || '?')
    })
    const confirmRes = await this.showBattleConfirm('确认生成第' + this.data.battleRoundNum + '轮对战', pairLines, '确认后队伍锁定，直接进入胜负判定')
    if (!confirmRes) return
    this.setData({ battlePairing: true })
    try {
      const payload = {
        mode: 'manual',
        pairs: battlePairs.map(p => ({ teamAId: p.teamA.teamId, teamBId: p.teamB.teamId }))
      }
      const res = await api.post('/events/' + this.data.eventId + '/matches/generate', payload)
      if (res.success) {
        let newRound = res.data.roundNum
        this.setData({ battleRound: newRound, battleRoundNum: newRound + 1, battlePairs: [] })
        await this.loadRoundMatches(newRound)
        // 刷新轮次信息
        const roundsRes = await api.get('/events/' + this.data.eventId + '/matches/rounds')
        if (roundsRes.success) {
          this.setData({ battleRounds: roundsRes.data.rounds || [] })
        }
        // 生成后自动开战，跳过「开战」步骤
        const startRes = await api.put('/events/' + this.data.eventId + '/matches/round/' + newRound + '/start')
        if (startRes.success) {
          this.setData({ battleRoundStatus: 'fighting' })
          await this.loadRoundMatches(newRound)
        } else {
          wx.showToast({ title: startRes.error || '自动开战失败', icon: 'none' })
        }
      } else {
        wx.showToast({ title: res.error || '生成失败', icon: 'none' })
      }
      this.setData({ battlePairing: false })
    } catch (e) {
      this.setData({ battlePairing: false })
      wx.showToast({ title: '生成失败，请重试', icon: 'none' })
    }
  },

  // ============ 删除本轮所有对战（配对阶段回到选队） ============
  async doDeleteRoundMatches() {
    const confirmRes = await modal.confirm(this, {
      theme: 'danger',
      title: '清除本轮对战',
      content: '将删除第' + this.data.battleRound + '轮所有对战记录，回到选队阶段。\n\n确认清除？'
    })
    if (!confirmRes.confirm) return
    this.setData({ battleDeleting: true })
    try {
      const { battleMatches } = this.data
      let deleted = 0
      for (const m of battleMatches) {
        if (m.match_status === 0) {
          await api.del('/events/' + this.data.eventId + '/matches/' + m.match_id)
          deleted++
        }
      }
      this.setData({ battleDeleting: false })
      this.setData({
        battleRoundStatus: 'select', battleRoundHasMatches: false,
        battleMatches: [], battlePairs: []
      })
      this._syncBattleSelected([])
      // 刷新轮次
      const roundsRes = await api.get('/events/' + this.data.eventId + '/matches/rounds')
      if (roundsRes.success) {
        const rds = roundsRes.data.rounds || []
        const cur = roundsRes.data.currentRound || 0
        const allD = rds.length > 0 && rds.every(r => r.allDone)
        this.setData({ battleRounds: rds, battleRound: cur, battleRoundNum: cur > 0 ? cur : 1, battleAllDone: allD })
      }
    } catch (e) {
      this.setData({ battleDeleting: false })
      wx.showToast({ title: '删除失败，请重试', icon: 'none' })
    }
  },

  // ============ 开战（锁定本轮） ============
  async doStartRound() {
    const { battleRound, battleMatches } = this.data
    // 列出所有对战，让用户最后确认
    const matchLines = battleMatches.map((m) => {
      return (m.team_a_name || '?') + '  VS  ' + (m.team_b_name || '?')
    })
    const confirmRes = await this.showBattleConfirm('🔥 开始第' + battleRound + '轮对战', matchLines, '开战后分组锁定，无法再更换队伍')
    if (!confirmRes) return
    this.setData({ battleStarting: true })
    try {
      const res = await api.put('/events/' + this.data.eventId + '/matches/round/' + this.data.battleRound + '/start')
      this.setData({ battleStarting: false })
      if (res.success) {
        this.setData({ battleRoundStatus: 'fighting' })
        await this.loadRoundMatches(this.data.battleRound)
      } else {
        wx.showToast({ title: res.error || '开战失败', icon: 'none' })
      }
    } catch (e) {
      this.setData({ battleStarting: false })
      wx.showToast({ title: '开战失败，请重试', icon: 'none' })
    }
  },

  // ============ 胜负判定 ============
  openJudgeModal(e) {
    if (!this.data.isAdmin) return
    if (this.data.isArchived) { wx.showToast({ title: '赛事已归档，不可修改', icon: 'none' }); return }
    const matchId = e.currentTarget.dataset.matchId
    const match = this.data.battleMatches.find(m => m.match_id === matchId)
    if (!match) return
    if (match._isDone || match.match_status === 2) { wx.showToast({ title: '该对战已判定', icon: 'none' }); return }
    if (match.match_status !== 1) { wx.showToast({ title: '请先点击「开战」', icon: 'none' }); return }
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
      const res = await api.put('/events/' + eventId + '/matches/' + judgeMatch.match_id + '/judge',
        { winnerId: judgeWinnerId, confirmed: true })
      this.setData({ loading: false })
      if (res.success) {
        this.setData({ showJudgeModal: false, judgeMatch: null, judgeWinnerId: '', judgeStep: 0 })
        await this.loadRoundMatches(this.data.battleRound)
        // 刷新积分榜（兜底计算 avgMmr，保留现有 _selected 状态）
        const sbRes = await api.get('/events/' + eventId + '/teams/scoreboard')
        if (sbRes.success) {
          const prevMap = {}
          this.data.battleScoreboard.forEach(s => { prevMap[s.teamId] = s._selected })
          const sb = (sbRes.data || []).map(s => this._ensureAvgMmr({ ...s, teamId: String(s.teamId), _selected: !!prevMap[String(s.teamId)] }))
          this.setData({ battleScoreboard: sb })
        }
        // 检查本轮是否全部完成
        await this._checkRoundComplete()
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

  // ============ 上传对战结果图片 ============
  /** 判断是否可以上传/替换某场对战的图片 */
  _canUploadMatchImage(match) {
    if (!match || this.data.isArchived) return false
    if (match.match_status !== 2) return false
    // 管理员可上传
    if (this.data.isAdmin) return true
    // 非管理员：检查是否为参赛队伍的队长
    const { _myPlayerId, battleScoreboard } = this.data
    if (!_myPlayerId) return false
    const teamA = battleScoreboard.find(s => String(s.teamId) === String(match.team_a_id))
    const teamB = battleScoreboard.find(s => String(s.teamId) === String(match.team_b_id))
    const isCaptainA = teamA && String(teamA.captainId) === String(_myPlayerId)
    const isCaptainB = teamB && String(teamB.captainId) === String(_myPlayerId)
    return isCaptainA || isCaptainB
  },

  /** 上传对战结果图片（队长/管理员） */
  uploadMatchImage(e) {
    const matchId = e.currentTarget.dataset.matchId
    const match = this.data.battleMatches.find(m => m.match_id === matchId)
    if (!match) return
    if (!this._canUploadMatchImage(match)) {
      wx.showToast({ title: '仅参赛队伍队长或管理员可上传', icon: 'none' })
      return
    }
    const that = this
    wx.chooseImage({
      count: 1,
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success(res) {
        const tempPath = res.tempFilePaths[0]
        that._doUploadMatchImage(matchId, tempPath)
      }
    })
  },

  async _doUploadMatchImage(matchId, filePath) {
    wx.showLoading({ title: '上传中...' })
    try {
      const API_BASE = api.API_BASE
      let url = API_BASE + '/events/' + this.data.eventId + '/matches/' + matchId + '/image'

      // 添加 openid
      const app = getApp()
      let openid = ''
      try { openid = app.globalData.openid || '' } catch (e) { }
      if (openid) url += (url.indexOf('?') >= 0 ? '&' : '?') + 'openid=' + encodeURIComponent(openid)

      // 添加 token
      const header = {}
      try {
        const token = app.getToken ? app.getToken() : ''
        if (token) header['Authorization'] = 'Bearer ' + token
      } catch (e) { }

      const res = await new Promise((resolve, reject) => {
        wx.uploadFile({
          url: url,
          filePath: filePath,
          name: 'file',
          header: header,
          success: resolve,
          fail: reject
        })
      })
      wx.hideLoading()
      const data = JSON.parse(res.data)
      if (data.success) {
        wx.showToast({ title: '上传成功', icon: 'success' })
        const imageUrl = data.data.url.startsWith('http') ? data.data.url : 'https://congqin.online' + data.data.url
        const matches = this.data.battleMatches.map(m => {
          if (m.match_id === matchId) return { ...m, battle_image: imageUrl }
          return m
        })
        this.setData({ battleMatches: matches })
      } else {
        wx.showToast({ title: data.error || '上传失败', icon: 'none' })
      }
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: '上传失败', icon: 'none' })
    }
  },

  // 预览对战结果图片
  previewMatchImage(e) {
    const url = e.currentTarget.dataset.url
    if (url) {
      const fullUrl = url.startsWith('http') ? url : 'https://congqin.online' + url
      wx.previewImage({ urls: [fullUrl], current: fullUrl })
    }
  },

  // 检查本轮是否全部完成
  async _checkRoundComplete() {
    const res = await api.get('/events/' + this.data.eventId + '/matches', { round: this.data.battleRound })
    if (res.success) {
      const matches = res.data || []
      const allDone = matches.length > 0 && matches.every(m => m.match_status === 2)
      if (allDone) {
        this.setData({ battleRoundStatus: 'done' })
        // 重新拉轮次检查是否全部完成
        const rRes = await api.get('/events/' + this.data.eventId + '/matches/rounds')
        if (rRes.success) {
          const rds = rRes.data.rounds || []
          const allBattlesDone = rds.length > 0 && rds.every(r => r.allDone)
          this.setData({ battleRounds: rds, battleAllDone: allBattlesDone })
        }
      }
    }
  },

  // ============ 下一轮 / 结束比赛 ============
  showBattleAction(e) {
    const actionType = e.currentTarget.dataset.action
    let title = '', content = ''
    if (actionType === 'next-round') {
      title = '进入下一轮'
      content = '确认进入第' + (this.data.battleRound + 1) + '轮对战？\n\n所有原始队伍保留，需重新选择参战队伍并编排对阵。'
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
        if (battleActionType === 'end-battle') {
          await this.loadEvent()
          this._updateTabLocks()
          this._updateActions()
          setTimeout(() => this._switchToTab('ranks'), 800)
        } else {
          // 下一轮：使用 API 返回的 nextRound，而非 /matches/rounds（后者不知道新轮次）
          const nextRound = res.data.nextRound || (this.data.battleRound + 1)
          // 刷新积分榜
          const sbRes = await api.get('/events/' + this.data.eventId + '/teams/scoreboard')
          if (sbRes.success) this.setData({ battleScoreboard: sbRes.data || [] })
          // 刷新轮次列表（但本轮 = 新轮次）
          const roundsRes = await api.get('/events/' + this.data.eventId + '/matches/rounds')
          const rds = (roundsRes.success && roundsRes.data.rounds) ? roundsRes.data.rounds : []
          // 把即将到来的新轮次也加入导航，方便后续切换回来看已完成轮次
          if (!rds.some(r => r.roundNum === nextRound)) {
            rds.push({ roundNum: nextRound, matchCount: 0, completedCount: 0, allDone: false })
          }
          this.setData({
            battleRounds: rds, battleRound: nextRound, battleRoundNum: nextRound,
            battleAllDone: false, battleRoundStatus: 'select', battleRoundHasMatches: false,
            battleMatches: [], battlePairs: []
          })
          this._syncBattleSelected([])
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

  // 加载上方队伍展示区数据（积分榜，按胜利数排序）
  async loadRankTeamCards() {
    try {
      const res = await api.get('/events/' + this.data.eventId + '/teams/scoreboard')
      if (res.success) {
        const cards = (res.data || []).map(t => ({
          teamId: String(t.teamId),
          teamName: t.teamName || '未命名',
          captainName: t.captainName || '',
          wins: t.wins || 0,
          losses: t.losses || 0,
          avgMmr: t.avgMmr || 0,
          totalMmr: t.totalMmr || 0,
          memberCount: t.memberCount || 0,
          score: t.score || 0
        }))
        // 按胜利数降序
        cards.sort((a, b) => b.wins - a.wins || a.teamName.localeCompare(b.teamName, 'zh'))
        this.setData({ rankTeamCards: cards })
      }
    } catch (e) { console.error('[名次] 加载队伍卡片失败', e) }
  },

  // 加载队伍详情（队员昵称），用于排名区展示
  async loadTeamsForRank() {
    try {
      const res = await api.get('/events/' + this.data.eventId + '/teams')
      if (res.success) {
        const teams = (res.data && res.data.teams) ? res.data.teams : []
        this.setData({ teamsForRank: teams })
      }
    } catch (e) { console.error('[名次] 加载队伍列表失败', e) }
  },

  // 获取队伍成员昵称（从 teamsForRank 中查找）
  _getTeamMembers(teamId) {
    if (!teamId) return []
    const teams = this.data.teamsForRank || []
    const team = teams.find(t => t.team_id === teamId)
    if (!team) return []
    const members = []
    // 队长排第一个
    if (team.captain) {
      members.push({ id: team.captain.id, nickName: team.captain.wx_nickname || '', isCaptain: true })
    }
    if (team.players) {
      team.players.forEach(p => {
        if (!members.find(m => m.id === p.id)) {
          members.push({ id: p.id, nickName: p.wx_nickname || '', isCaptain: p.id === team.captain_id })
        }
      })
    }
    return members
  },

  // 更新已用队伍映射
  _updateRankUsedMap() {
    const map = {}
    const slots = this.data.rankEditSlots
    slots.forEach(s => { if (s.teamId) map[s.teamId] = true })
    this.setData({ _rankUsedTeamMap: map })
  },

  async startEditRanks() {
    if (!this.data.isAdmin) return
    this.setData({ ranksLoading: true })
    // 并行加载队伍详情+队伍卡片+已有名次
    await Promise.all([this.loadTeamsForRank(), this.loadRankTeamCards(), this.loadRanks()])

    const existingRanks = this.data.ranks || []
    const baseCount = existingRanks.length > 0 ? existingRanks.length : 3
    const defaultNames = ['冠军', '亚军', '季军']

    // 基于已保存名次数量初始化槽位，回填已有数据
    const slots = []
    for (let n = 1; n <= baseCount; n++) {
      const existing = existingRanks.find(r => r.rank_num === n)
      if (existing) {
        const members = this._getTeamMembers(existing.team_id)
        slots.push({
          rankNum: n,
          teamId: existing.team_id,
          teamName: existing.team_name || '',
          captainName: existing.captain_name || '',
          label: '第' + n + '名（' + (defaultNames[n - 1] || '第' + n + '名') + '）',
          members
        })
      } else {
        slots.push({
          rankNum: n,
          teamId: '',
          teamName: '',
          captainName: '',
          label: '第' + n + '名（' + (defaultNames[n - 1] || '第' + n + '名') + '）',
          members: []
        })
      }
    }

    const usedMap = {}
    slots.forEach(s => { if (s.teamId) usedMap[s.teamId] = true })
    this.setData({ ranksEditing: true, ranksLoading: false, rankEditSlots: slots, _rankUsedTeamMap: usedMap, rankSelectedTeamId: '' })
  },

  cancelEditRanks() {
    this.setData({ ranksEditing: false, rankEditSlots: [], _rankUsedTeamMap: {}, rankSelectedTeamId: '' })
  },

  // 点击上方队伍卡片 → 自动按顺序填入第一个空名次槽位
  selectRankTeam(e) {
    const teamId = String(e.currentTarget.dataset.teamId)
    const { rankEditSlots, rankTeamCards, _rankUsedTeamMap } = this.data

    // 如果该队伍已填入某个槽位，点击则取消填入
    if (_rankUsedTeamMap[teamId]) {
      const slots = [...rankEditSlots]
      const idx = slots.findIndex(s => s.teamId === teamId)
      if (idx >= 0) {
        slots[idx].teamId = ''
        slots[idx].teamName = ''
        slots[idx].captainName = ''
        slots[idx].members = []
      }
      const usedMap = {}
      slots.forEach(s => { if (s.teamId) usedMap[s.teamId] = true })
      this.setData({ rankEditSlots: slots, _rankUsedTeamMap: usedMap, rankSelectedTeamId: '' })
      return
    }

    // 找到第一个空槽位
    const card = rankTeamCards.find(c => c.teamId === teamId)
    if (!card) { wx.showToast({ title: '队伍信息未找到', icon: 'none' }); return }

    const emptyIndex = rankEditSlots.findIndex(s => !s.teamId)
    if (emptyIndex < 0) {
      wx.showToast({ title: '所有名次均已填满，请先添加更多名次', icon: 'none' })
      return
    }

    // 获取队员信息并填入
    const members = this._getTeamMembers(teamId)
    const slots = [...rankEditSlots]
    slots[emptyIndex].teamId = teamId
    slots[emptyIndex].teamName = card.teamName
    slots[emptyIndex].captainName = card.captainName
    slots[emptyIndex].members = members

    const usedMap = {}
    slots.forEach(s => { if (s.teamId) usedMap[s.teamId] = true })
    this.setData({ rankEditSlots: slots, _rankUsedTeamMap: usedMap, rankSelectedTeamId: '' })
  },

  // 点击排名区槽位 → 将选中队伍填入该名次
  assignTeamToRank(e) {
    const index = e.currentTarget.dataset.index
    const { rankSelectedTeamId, rankTeamCards, rankEditSlots, teamsForRank } = this.data
    if (!rankSelectedTeamId) {
      wx.showToast({ title: '请先点击上方队伍卡片选择队伍', icon: 'none' })
      return
    }
    // 检查该队伍是否已被其他名次占用
    const dupSlot = rankEditSlots.find((s, i) => i !== index && s.teamId === rankSelectedTeamId)
    if (dupSlot) {
      wx.showToast({ title: '该队伍已在第' + dupSlot.rankNum + '名', icon: 'none' })
      return
    }
    // 查找队伍卡片信息
    const card = rankTeamCards.find(c => c.teamId === rankSelectedTeamId)
    if (!card) { wx.showToast({ title: '队伍信息未找到', icon: 'none' }); return }
    // 获取队员信息
    const members = this._getTeamMembers(rankSelectedTeamId)
    const slots = [...rankEditSlots]
    slots[index].teamId = rankSelectedTeamId
    slots[index].teamName = card.teamName
    slots[index].captainName = card.captainName
    slots[index].members = members
    const usedMap = {}
    slots.forEach(s => { if (s.teamId) usedMap[s.teamId] = true })
    this.setData({ rankEditSlots: slots, _rankUsedTeamMap: usedMap, rankSelectedTeamId: '' })
  },

  // 清除某个名次槽位的队伍
  clearRankSlot(e) {
    const index = e.currentTarget.dataset.index
    const slots = [...this.data.rankEditSlots]
    slots[index].teamId = ''
    slots[index].teamName = ''
    slots[index].captainName = ''
    slots[index].members = []
    const usedMap = {}
    slots.forEach(s => { if (s.teamId) usedMap[s.teamId] = true })
    this.setData({ rankEditSlots: slots, _rankUsedTeamMap: usedMap })
  },

  addMoreRankSlots() {
    const slots = [...this.data.rankEditSlots]
    if (slots.length >= 20) { wx.showToast({ title: '最多设置20个名次', icon: 'none' }); return }
    const next = slots.length + 1
    slots.push({ rankNum: next, teamId: '', teamName: '', captainName: '', label: '第' + next + '名', members: [] })
    this.setData({ rankEditSlots: slots })
    this._updateRankUsedMap()
  },

  async removeRankSlot(e) {
    const index = e.currentTarget.dataset.index
    const slots = [...this.data.rankEditSlots]
    if (slots.length <= 1) { wx.showToast({ title: '至少保留1个名次', icon: 'none' }); return }
    // 如果被移除的槽位有队伍数据，提示确认
    if (slots[index].teamId) {
      const r = await modal.confirm(this, {
        theme: 'danger',
        title: '移除名次',
        content: '将移除第' + slots[index].rankNum + '名（' + (slots[index].teamName || '未命名') + '）的数据，确定？'
      })
      if (r.confirm) this._doRemoveSlot(index, slots)
    } else {
      this._doRemoveSlot(index, slots)
    }
  },

  _doRemoveSlot(index, slots) {
    slots.splice(index, 1)
    // 重新编号 & 更新标签
    slots.forEach((s, i) => {
      s.rankNum = i + 1
      const names = ['冠军', '亚军', '季军']
      s.label = i < 3 ? '第' + (i + 1) + '名（' + names[i] + '）' : '第' + (i + 1) + '名'
    })
    const usedMap = {}
    slots.forEach(s => { if (s.teamId) usedMap[s.teamId] = true })
    this.setData({ rankEditSlots: slots, _rankUsedTeamMap: usedMap })
  },

  async saveRanks() {
    const { rankEditSlots } = this.data
    // 只提交有队伍的槽位
    const ranks = rankEditSlots
      .filter(s => s.teamId)
      .map(s => ({ rankNum: s.rankNum, teamId: s.teamId }))
    const hasContent = ranks.length > 0
    if (!hasContent) {
      const r = await modal.confirm(this, {
        theme: 'danger',
        title: '清空名次', content: '当前所有名次均为空，提交将清空所有已有名次记录。确定继续？'
      })
      if (r.confirm) this.doBatchSaveRanks([])
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
        this.setData({ ranksEditing: false, _rankUsedTeamMap: {}, rankSelectedTeamId: '' })
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
        wx.showToast({ title: '赛事已归档', icon: 'success', duration: 1500 })
        // 归档完成后自动跳转到历史赛事
        setTimeout(() => {
          wx.redirectTo({ url: '/pages/dota2/dota2?subTab=history' })
        }, 1500)
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
