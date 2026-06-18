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
    battleIsLatestRound: false,  // 当前轮是否为最新轮（控制操作按钮显示）
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
    swapCurTeamName: '',        // 当前被换的队伍名
    swapBattleTeams: [],        // 对战区可选队伍（互换位置）
    swapFreeTeams: [],          // 自由区可选队伍（替换至对战区）
    // —— 手动配对-队伍选择弹窗 ——
    showPairTeamPicker: false,
    pairPickerIndex: -1,
    pairPickerSide: 'A',
    pairPickerAllTeams: [],     // 统一队伍列表（每项带 _status: 'free' | 'battle'）
    _pairBattleTeamMap: {},     // 已参战队伍→所在配对信息 {teamId: {pairIndex, pairSide}}

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
      // 【修复】从历史赛事进入时，默认显示赛事概览
      if (this.data.fromHistory) {
        this._switchToTab('overview')
      }
      // 进入页面时默认跳转到最新可用环节（如报名管理阶段则直接定位到报名管理）
      const latestUnlocked = [...this.data.tabs].reverse().find(t => !t._locked)
      if (latestUnlocked && latestUnlocked.key !== this.data.activeTab) {
        // 重置对战状态，确保 loadBattleData 走到最新轮次而非保留旧数据
        if (latestUnlocked.key === 'matches') {
          this.setData({ battleRound: 0, battleMatches: [] })
        }
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
          isArchived: event.is_archived === 1 || event.event_status >= 6,
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

  /** 计算赛事进度条（7步，一一对应event_status 0-6） */
  _updateProgressSteps() {
    const status = this.data.event.event_status
    const steps = [
      { label: '创建比赛', key: 'draft' },
      { label: '报名中', key: 'signup' },
      { label: '分组编队', key: 'teams' },
      { label: '对战预备', key: 'ready' },
      { label: '对战中', key: 'matches' },
      { label: '名次归档', key: 'ranks' },
      { label: '已归档', key: 'archived' }
    ]
    // event_status 直接对应 steps 下标
    const progressSteps = steps.map((s, i) => ({
      ...s,
      _done: i < status,
      _active: i === status
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
      // 未解锁，静默忽略
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
        // 赛事概览需要报名计数 + 队伍数 + mySignup 判断"已报名"/"立即报名"状态
        // 如果赛事已结束，同时预加载名次数据供概览统计
        this._updateActions()
        const overviewTasks = [this.loadSignups(), this.loadMySignup(), this.loadTeams()]
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
    // 正在上传截图时跳过对战数据全量刷新，避免 battleRound 被重置
    if (this._isUploading && this.data.activeTab === 'matches') {
      this._isUploading = false
      return
    }
    await this._loadTabData(this.data.activeTab)
  },

  // ============ 权限 ============
  _updateActions() {
    const event = this.data.event
    if (!event) return
    const opts = {
      eventStatus: event.event_status,
      isArchived: (event.is_archived || 0) || (event.event_status >= 6 ? 1 : 0),
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
    if (event.is_archived === 1 || event.event_status >= 6) return false
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
      if (!val) { return }
    if (val.length < 2 || val.length > 50) { return }
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
      // 时间无效，静默还原
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
    const map = { 0: '报名未开始', 1: '', 2: '报名已截止', 3: '对战预备中', 4: '赛事对战中', 5: '赛事已结束', 6: '赛事已归档' }
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
    if (!next) { return }
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
        // 成功，静默处理
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
        return
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
      0: null,                          // 创建比赛：不显示跳转按钮
      1: { tab: 'signups', index: 1, label: '📝 前往报名管理', desc: '管理报名人员' },
      2: { tab: 'teams', index: 2, label: '👥 前往分组编队', desc: '进行队伍分组编排' },
      3: { tab: 'matches', index: 3, label: '⚔️ 前往对阵对战', desc: '生成对战编排' },
      4: { tab: 'matches', index: 3, label: '⚔️ 前往对阵对战', desc: '编排对战与判定胜负' },
      5: { tab: 'ranks', index: 4, label: '🏆 前往名次归档', desc: '设定最终排名' },
      6: null                           // 已归档：不显示跳转按钮
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
    if (event.event_status !== 1) { return }
    if (mySignup && mySignup.signedUp) { return }
    // 前端校验：报名人数上限（仅自主报名受限，管理员添加不受限）
    if (event.signup_limit && event.signup_limit > 0 && signupCount >= event.signup_limit) {
      return
    }
    this.setData({ loading: true })
    try {
      const res = await api.post('/events/' + this.data.eventId + '/signups', {})
      this.setData({ loading: false })
      if (res.success) {
        // 报名成功，静默处理
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
        break
      case 'EVENT_NOT_OPEN':
        break
      case 'SIGNUP_FULL':
        break
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
    this.setData({ addLoading: true })
    try {
          const res = await api.post('/events/' + this.data.eventId + '/signups/batch', { playerIds: [pid] })
          // 服务器始终返回 success:true，实际添加结果在 res.data 中
          const result = res.data || {}
          const added = result.success || 0
          if (res.success && added > 0) {
            // 仅当服务器确认添加成功后，才在搜索结果中标记已报名
            const results = this.data.searchResults.map(p =>
              p._id == pid ? { ...p, _alreadySigned: true } : p
            )
            this.setData({ searchResults: results, addLoading: false })
            await this.loadSignups()
          } else if (res.success && result.skipped > 0) {
            this.setData({ addLoading: false })
          } else if (res.success && result.failed > 0) {
            this.setData({ addLoading: false })
          } else {
            this.setData({ addLoading: false })
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
        // 已剔除，静默处理
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
      this.setData({ selectedPlayerId: playerId })
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
      return
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
  },

  // ============ 战队名编辑（队长/管理员，保存分组后，归档前） ============
  /** 判断当前用户是否可以编辑指定队伍的名称 */
  _canEditTeamName(team) {
    const { event, isAdmin, isArchived, _myPlayerId } = this.data
    if (isArchived || event.event_status >= 6 || !team) return false
    // 仅「分组编队」阶段(状态2)可编辑战队名
    if (!event || event.event_status !== 2) return false
    // 未保存编组前（temp_/alloc_/isNew 队伍）不允许改战队名
    if (team.isNew || String(team.team_id).startsWith('temp_') || String(team.team_id).startsWith('alloc_')) return false
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
    if (!val) { return }
    if (val.length > 50) { return }

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
      wx.showToast({ title: '当前不可保存编组', icon: 'none' })
      return
    }
    if (this.data.teams.length === 0) {
      wx.showToast({ title: '请至少创建一支队伍', icon: 'none' })
      return
    }

    // 前端校验：每队至少5人且有队长
    for (const team of this.data.teams) {
      const members = team.members || team.players || []
      if (members.length < 5) {
        wx.showToast({ title: `队伍「${team.team_name}」至少需要5名队员，当前${members.length}人`, icon: 'none' })
        return
      }
      if (!team.captain_id) {
        wx.showToast({ title: `队伍「${team.team_name}」未指定队长`, icon: 'none' })
        return
      }
      if (!members.some(m => String(m.id) === String(team.captain_id))) {
        wx.showToast({ title: `队伍「${team.team_name}」的队长不在队员列表中`, icon: 'none' })
        return
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
        // 保存成功，静默处理
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
      return
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
      wx.showToast({ title: '请输入有效的队伍数量', icon: 'none' })
      return
    }
    const totalPlayers = this.data.signupTotal || this.data.signupCount || 0
    if (count > totalPlayers) {
      wx.showToast({ title: `队伍数量(${count})不能超过报名人数(${totalPlayers})`, icon: 'none' })
      return
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
    const lockAction = this.data.actions.lock_teams
    if (!lockAction || !lockAction.allowed) {
      wx.showToast({ title: lockAction?.reason || '当前不可锁定开赛', icon: 'none' })
      return
    }
    const r = await modal.confirm(this, {
      theme: 'danger',
      title: '锁定分组开赛',
      content: '确认锁定当前分组？\n\n锁定后队伍信息不可修改，对阵对战将开放进入「对战预备」状态。'
    })
    if (!r.confirm) return
    this.setData({ locking: true })
    try {
          const res = await api.post('/events/' + this.data.eventId + '/lock-teams', {})
          this.setData({ locking: false })
          if (res.success) {
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

  // 返回分组编队
  async doBackToTeams() {
    const r = await modal.confirm(this, {
      theme: 'warn',
      title: '返回分组编队',
      content: '确认返回分组编队阶段？\n\n返回后对阵对战将暂时关闭，可重新编辑队伍。'
    })
    if (!r.confirm) return
    try {
      const res = await api.post('/events/' + this.data.eventId + '/back-to-teams', {})
      if (res.success) {
        await this.loadEvent()
        this._updateTabLocks()
        this._updateActions()
        setTimeout(() => this._switchToTab('teams'), 400)
      } else {
        wx.showToast({ title: res.error || '返回失败', icon: 'none' })
      }
    } catch (e) {
      wx.showToast({ title: '返回失败，请重试', icon: 'none' })
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

  // 判断当前轮次是否为最新轮（有无更新的轮次存在）
  _isLatestRound(round, rounds) {
    if (!rounds || rounds.length === 0) return true
    return !rounds.some(r => r.roundNum > round)
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
      // 确定当前轮次：如果用户已选定某轮（battleRound>0），保留该轮次不跳转
      const keepRound = this.data.battleRound > 0
      const rn = keepRound ? this.data.battleRound : (curRound || (rounds.length > 0 ? rounds[rounds.length - 1].roundNum : 0))
      const nextRn = rn > 0 ? rn : 1
      this.setData({
        battleRounds: rounds, battleRound: rn, battleRoundNum: nextRn, battleAllDone: allDone,
        battleIsLatestRound: this._isLatestRound(rn, rounds),
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
            team_a_avg_mmr: a.avgMmr || m.team_a_avg_mmr || 0,
            team_a_captain: a.captainName || '',
            team_b_score: b.wins || 0,
            team_b_avg_mmr: b.avgMmr || m.team_b_avg_mmr || 0,
            team_b_captain: b.captainName || '',
            battle_image: this._normalizeImageUrl(m.battle_image)
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
        // 下一轮是否已有对战（影响上一轮是否还能「结束比赛」）
        const nextRoundData = this.data.battleRounds.find(r => r.roundNum === round + 1)
        const _nextRoundHasMatches = nextRoundData ? (nextRoundData.matchCount > 0) : false
        this.setData({
          battleMatches: matches,
          battleRoundHasMatches: hasMatches,
          battleRoundStatus: status,
          _isRoundDone: status === 'done',
          _nextRoundHasMatches
        })
        // 根据状态回填选中ID，同步 _selected 标记 + 对战信息
        if (hasMatches) {
          const ids = new Set()
          matches.forEach(m => { if (m.team_a_id) ids.add(String(m.team_a_id)); if (m.team_b_id) ids.add(String(m.team_b_id)) })
          this._syncBattleSelected([...ids])
          this._markScoreboardMatchInfo(matches)
        } else {
          this._markScoreboardMatchInfo([])
        }
        // 开战后不显示配对编辑
        if (status === 'fighting' || status === 'done') {
          this.setData({ battlePairs: [] })
        }
      }
    } catch (e) { console.error('[对战] 加载轮次失败', e) }
  },

  // 切换轮次
  async switchRound(e) {
    const round = parseInt(e.currentTarget.dataset.round)
    if (!round) return
    this.setData({ battleRound: round, battleRoundStatus: '', battleMatches: [], battlePairs: [],
      battleIsLatestRound: this._isLatestRound(round, this.data.battleRounds) })
    this._syncBattleSelected([])
    await this.loadRoundMatches(round)
  },

  // ============ 选队配对 ============

  // 将 battleSelectedIds 同步为 battleScoreboard 每项的 _selected 标记
  _syncBattleSelected(selectedIds) {
    const set = new Set(selectedIds || this.data.battleSelectedIds)
    const sb = this.data.battleScoreboard.map(s => ({ ...s, _selected: set.has(s.teamId) }))
    this.setData({ battleScoreboard: sb, battleSelectedIds: [...set] })
  },

  // 标记出战队伍卡片上的对战信息（用于显示「更换」按钮）
  _markScoreboardMatchInfo(matches) {
    const infoMap = {}
    ;(matches || []).forEach(m => {
      if (m.team_a_id) infoMap[String(m.team_a_id)] = { _matchId: m.match_id, _matchSide: 'A', _matchStatus: m.match_status }
      if (m.team_b_id) infoMap[String(m.team_b_id)] = { _matchId: m.match_id, _matchSide: 'B', _matchStatus: m.match_status }
    })
    const sb = this.data.battleScoreboard.map(s => {
      const info = infoMap[s.teamId]
      return info
        ? { ...s, _matchId: info._matchId, _matchSide: info._matchSide, _matchStatus: info._matchStatus }
        : { ...s, _matchId: '', _matchSide: '', _matchStatus: -1 }
    })
    this.setData({ battleScoreboard: sb })
  },

  // 点击队伍卡片切换参战选中
  toggleBattleTeam(e) {
    const teamId = String(e.currentTarget.dataset.teamId)

    // 检查是否已归档
    if (this.data.isArchived) {
      return
    }

    // 检查用户权限
    const matchPerm = this.data.actions.manage_matches
    if (!matchPerm || !matchPerm.allowed) {
      return
    }

    // 检查对战状态
    if (this.data.battleRoundStatus === 'fighting') {
      return
    }
    if (this.data.battleRoundStatus === 'done') {
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

  // 点击配对卡片的队伍位置：弹出队伍选择器（分对战区/自由区）
  pickTeamForPair(e) {
    if (!this.data.isAdmin) return
    const index = parseInt(e.currentTarget.dataset.index)
    const side = e.currentTarget.dataset.side
    const pairs = this.data.battlePairs
    const allTeams = this.data.battleScoreboard
    const curPair = pairs[index] || {}

    // 需要排除的队伍ID：当前槽位自己的 + 同组另一方
    const excludeIds = new Set()
    const curTeam = side === 'A' ? curPair.teamA : curPair.teamB
    if (curTeam && curTeam.teamId != null) excludeIds.add(String(curTeam.teamId))
    const samePairOther = side === 'A' ? curPair.teamB : curPair.teamA
    if (samePairOther && samePairOther.teamId != null) excludeIds.add(String(samePairOther.teamId))

    // 收集其他对战组已占用的队伍→对战区
    const battleMap = {}
    pairs.forEach((p, i) => {
      if (i === index) return
      if (p.teamA && p.teamA.teamId != null) battleMap[String(p.teamA.teamId)] = { pairIndex: i, pairSide: 'A' }
      if (p.teamB && p.teamB.teamId != null) battleMap[String(p.teamB.teamId)] = { pairIndex: i, pairSide: 'B' }
    })

    // 合并为一个列表，每项带 _status 标记
    const allTeamList = []
    allTeams.forEach(t => {
      const tid = String(t.teamId)
      if (excludeIds.has(tid)) return       // 当前组队伍完全不显示
      if (battleMap[tid]) {
        allTeamList.push({ ...t, _status: 'battle', _pairInfo: battleMap[tid] })
      } else {
        allTeamList.push({ ...t, _status: 'free' })
      }
    })

    this.setData({
      showPairTeamPicker: true,
      pairPickerIndex: index,
      pairPickerSide: side,
      pairPickerAllTeams: allTeamList,
      _pairBattleTeamMap: battleMap
    })
  },

  // 在弹窗中选定队伍（未参战→直接填入；已参战→互换位置）
  selectPairTeam(e) {
    const teamId = String(e.currentTarget.dataset.teamId)
    const { pairPickerIndex, pairPickerSide, pairPickerAllTeams, _pairBattleTeamMap } = this.data

    const team = pairPickerAllTeams.find(t => String(t.teamId) === teamId)
    if (!team) return

    const pairs = [...this.data.battlePairs]
    if (pairPickerIndex < 0 || pairPickerIndex >= pairs.length) return

    const curPair = pairs[pairPickerIndex] || { teamA: null, teamB: null }
    pairs[pairPickerIndex] = { ...curPair }

    if (team._status === 'battle') {
      // ★ 已参战：两个队伍互换配对位置
      const info = _pairBattleTeamMap[teamId]
      if (!info) return

      const curTeam = pairPickerSide === 'A' ? curPair.teamA : curPair.teamB
      const otherIdx = info.pairIndex
      if (otherIdx < 0 || otherIdx >= pairs.length) return

      pairs[otherIdx] = { ...(pairs[otherIdx] || { teamA: null, teamB: null }) }

      // 当前槽位填入选中的队伍
      if (pairPickerSide === 'A') {
        pairs[pairPickerIndex].teamA = team
      } else {
        pairs[pairPickerIndex].teamB = team
      }

      // 另一方槽位填入当前槽位原来的队伍
      if (info.pairSide === 'A') {
        pairs[otherIdx].teamA = curTeam
      } else {
        pairs[otherIdx].teamB = curTeam
      }
    } else {
      // ★ 未参战：直接填入当前槽位（原队伍退回自由区）
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
    this.setData({
      showPairTeamPicker: false,
      pairPickerIndex: -1,
      pairPickerSide: 'A',
      pairPickerAllTeams: [],
      _pairBattleTeamMap: {}
    })
  },

  // 自动匹配：根据分数将选中队伍相邻配对
  doBattleAutoMatch() {
    const { battleScoreboard, battleSelectedIds } = this.data
    const selectedIds = battleSelectedIds.length > 0
      ? battleSelectedIds
      : battleScoreboard.map(t => t.teamId)
    if (selectedIds.length < 2) { return }

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

  // 点击已生成对战的队伍位置：弹出换队选择器
  openSwapModal(e) {
    const { matchId, side } = e.currentTarget.dataset
    if (!matchId) return
    this._buildSwapModalCore(matchId, side)
  },

  // 从出战队伍卡片点击「更换」按钮
  openTeamSwap(e) {
    const teamId = String(e.currentTarget.dataset.teamId)
    const team = this.data.battleScoreboard.find(s => s.teamId === teamId)
    if (!team || !team._matchId) return
    this._buildSwapModalCore(team._matchId, team._matchSide)
  },

  // 核心：构建换队弹窗数据（分对战区/自由区）
  _buildSwapModalCore(matchId, side) {
    const { battleScoreboard, battleMatches } = this.data
    const curMatch = battleMatches.find(m => m.match_id === matchId)
    if (!curMatch) return

    const otherSideTeamId = side === 'A' ? String(curMatch.team_b_id || '') : String(curMatch.team_a_id || '')
    const curTeamId = side === 'A' ? String(curMatch.team_a_id || '') : String(curMatch.team_b_id || '')

    const inMatchSet = new Set()
    const teamMatchMap = {}
    battleMatches.forEach(m => {
      const aId = String(m.team_a_id || '')
      const bId = String(m.team_b_id || '')
      if (aId) { inMatchSet.add(aId); teamMatchMap[aId] = m.match_id }
      if (bId) { inMatchSet.add(bId); teamMatchMap[bId] = m.match_id }
    })

    const available = battleScoreboard
      .filter(t => {
        const tid = String(t.teamId)
        return tid !== otherSideTeamId && tid !== curTeamId
      })
      .map(t => {
        const tid = String(t.teamId)
        const inMatch = inMatchSet.has(tid)
        return {
          ...t,
          _inMatch: inMatch,
          _otherMatchId: inMatch ? (teamMatchMap[tid] || '') : ''
        }
      })

    const curTeam = battleScoreboard.find(s => s.teamId === curTeamId)
    this.setData({
      showSwapModal: true,
      swapMatchId: matchId,
      swapSide: side,
      swapCurTeamName: curTeam ? (curTeam.teamName || '未知') : '未知',
      swapBattleTeams: available.filter(t => t._inMatch),
      swapFreeTeams: available.filter(t => !t._inMatch)
    })
  },

  closeSwapModal() {
    this.setData({
      showSwapModal: false,
      swapMatchId: '',
      swapSide: 'A',
      swapCurTeamName: '',
      swapBattleTeams: [],
      swapFreeTeams: []
    })
  },

  // 选择替换的队伍（自由区→替换至对战区；对战区→互换位置）
  async doSwapTeam(e) {
    const newTeamId = String(e.currentTarget.dataset.teamId)
    const { swapSide, swapMatchId, swapBattleTeams, swapFreeTeams, eventId, battleMatches, battleScoreboard } = this.data
    if (!swapMatchId || !newTeamId) { this.setData({ showSwapModal: false }); return }

    const selectedTeam = [...swapBattleTeams, ...swapFreeTeams].find(t => String(t.teamId) === newTeamId)
    if (!selectedTeam) { this.setData({ showSwapModal: false }); return }

    const matchIdx = battleMatches.findIndex(m => m.match_id === swapMatchId)
    if (matchIdx < 0) { this.setData({ showSwapModal: false }); return }

    const match = battleMatches[matchIdx]
    if (match.match_status !== 0) { this.setData({ showSwapModal: false }); return }

    const updated = [...battleMatches]
    const apiCalls = []

    if (selectedTeam._inMatch) {
      // ★ 对战区队伍 → 两个队伍互换位置
      const otherMatchId = selectedTeam._otherMatchId
      const otherMatchIdx = battleMatches.findIndex(m => m.match_id === otherMatchId)
      if (otherMatchIdx < 0) { this.setData({ showSwapModal: false }); return }

      const otherMatch = updated[otherMatchIdx]
      const otherSide = String(otherMatch.team_a_id) === newTeamId ? 'A' : 'B'

      if (swapSide === 'A') {
        const oldTeamId = String(match.team_a_id || '')
        updated[matchIdx] = this._fillMatchTeam(updated[matchIdx], 'A', selectedTeam, battleScoreboard)
        updated[otherMatchIdx] = this._fillMatchTeamById(updated[otherMatchIdx], otherSide, oldTeamId, battleScoreboard)
        apiCalls.push(
          api.put('/events/' + eventId + '/matches/' + swapMatchId, { teamAId: newTeamId }),
          api.put('/events/' + eventId + '/matches/' + otherMatchId, otherSide === 'A' ? { teamAId: oldTeamId } : { teamBId: oldTeamId })
        )
      } else {
        const oldTeamId = String(match.team_b_id || '')
        updated[matchIdx] = this._fillMatchTeam(updated[matchIdx], 'B', selectedTeam, battleScoreboard)
        updated[otherMatchIdx] = this._fillMatchTeamById(updated[otherMatchIdx], otherSide, oldTeamId, battleScoreboard)
        apiCalls.push(
          api.put('/events/' + eventId + '/matches/' + swapMatchId, { teamBId: newTeamId }),
          api.put('/events/' + eventId + '/matches/' + otherMatchId, otherSide === 'A' ? { teamAId: oldTeamId } : { teamBId: oldTeamId })
        )
      }
    } else {
      // ★ 自由区队伍 → 替换至对战区（原队伍退回自由区）
      if (swapSide === 'A') {
        updated[matchIdx] = this._fillMatchTeam(updated[matchIdx], 'A', selectedTeam, battleScoreboard)
        apiCalls.push(api.put('/events/' + eventId + '/matches/' + swapMatchId, { teamAId: newTeamId }))
      } else {
        updated[matchIdx] = this._fillMatchTeam(updated[matchIdx], 'B', selectedTeam, battleScoreboard)
        apiCalls.push(api.put('/events/' + eventId + '/matches/' + swapMatchId, { teamBId: newTeamId }))
      }
    }

    this.setData({ battleMatches: updated, showSwapModal: false })

    try {
      const results = await Promise.all(apiCalls)
      const failed = results.filter(r => !r.success)
      if (failed.length > 0) {
        wx.showToast({ title: failed[0].error || '换队失败', icon: 'none' })
        this.setData({ battleMatches })
      } else {
        // 成功后刷新出战队伍卡片的对战信息
        this._markScoreboardMatchInfo(updated)
        // 同步参战ID
        const ids = new Set()
        updated.forEach(m => { if (m.team_a_id) ids.add(String(m.team_a_id)); if (m.team_b_id) ids.add(String(m.team_b_id)) })
        this._syncBattleSelected([...ids])
      }
    } catch (e) {
      wx.showToast({ title: '换队失败，请重试', icon: 'none' })
      this.setData({ battleMatches })
    }
  },

  // 工具：用队伍对象填充 match 的 A/B 槽位
  _fillMatchTeam(match, side, team, sb) {
    const sbTeam = sb.find(t => String(t.teamId) === String(team.teamId)) || team
    if (side === 'A') {
      return { ...match, team_a_id: String(team.teamId), team_a_name: team.teamName || sbTeam.teamName,
        team_a_mmr: sbTeam.totalMmr || 0, team_a_avg_mmr: sbTeam.avgMmr || 0 }
    } else {
      return { ...match, team_b_id: String(team.teamId), team_b_name: team.teamName || sbTeam.teamName,
        team_b_mmr: sbTeam.totalMmr || 0, team_b_avg_mmr: sbTeam.avgMmr || 0 }
    }
  },

  // 工具：用 teamId 字符串填充 match 的 A/B 槽位
  _fillMatchTeamById(match, side, teamId, sb) {
    const team = sb.find(t => String(t.teamId) === String(teamId))
    if (!team) return match
    if (side === 'A') {
      return { ...match, team_a_id: teamId, team_a_name: team.teamName,
        team_a_mmr: team.totalMmr || 0, team_a_avg_mmr: team.avgMmr || 0 }
    } else {
      return { ...match, team_b_id: teamId, team_b_name: team.teamName,
        team_b_mmr: team.totalMmr || 0, team_b_avg_mmr: team.avgMmr || 0 }
    }
  },

  // ============ 生成对战（调用API） ============
  async doGenerateMatches() {
    const { battlePairs } = this.data
    if (battlePairs.length === 0) { return }
    // 验证每对都有两支队伍
    const incomplete = battlePairs.some(p => !p.teamA || !p.teamB)
    if (incomplete) { return }
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
        this.setData({ battleRound: newRound, battleRoundNum: newRound + 1, battlePairs: [],
          battleIsLatestRound: true })
        await this.loadRoundMatches(newRound)
        // 刷新轮次信息
        const roundsRes = await api.get('/events/' + this.data.eventId + '/matches/rounds')
        if (roundsRes.success) {
          const rds = roundsRes.data.rounds || []
          this.setData({ battleRounds: rds, battleIsLatestRound: this._isLatestRound(newRound, rds) })
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
        this.setData({ battleRounds: rds, battleRound: cur, battleRoundNum: cur > 0 ? cur : 1, battleAllDone: allD,
          battleIsLatestRound: this._isLatestRound(cur, rds) })
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
    if (this.data.isArchived) { return }
    const matchId = e.currentTarget.dataset.matchId
    const match = this.data.battleMatches.find(m => m.match_id === matchId)
    if (!match) return
    if (match._isDone || match.match_status === 2) { return }
    if (match.match_status !== 1) { return }
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
      return
    }
    // 标记正在上传，避免 onShow 触发 loadBattleData 重置当前轮次
    this._isUploading = true
    const that = this
    wx.chooseImage({
      count: 1,
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success(res) {
        const tempPath = res.tempFilePaths[0]
        that._doUploadMatchImage(matchId, tempPath)
      },
      fail() {
        that._isUploading = false
      }
    })
  },

  /**
   * 上传对战结果图片（内部实现）
   * - 使用 wx.uploadFile 直传服务器
   * - 上传成功后更新本地 battleMatches 数据
   * - _isUploading 标记防止 onShow 刷数据覆盖当前轮次
   */
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
        const imageUrl = this._normalizeImageUrl(data.data.url)
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
    } finally {
      // 【修复】始终重置 _isUploading，防止阻止后续 onShow 刷新
      this._isUploading = false
    }
  },

  /**
   * 归一化图片URL：相对路径→完整URL
   * 统一处理所有图片URL前缀，避免多处重复拼接
   */
  _normalizeImageUrl(url) {
    if (!url) return ''
    return url.startsWith('http') ? url : 'https://congqin.online' + url
  },

  // 预览对战结果图片
  previewMatchImage(e) {
    const url = e.currentTarget.dataset.url
    if (url) {
      const fullUrl = this._normalizeImageUrl(url)
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
            battleAllDone: false, battleIsLatestRound: true,
            battleRoundStatus: 'select', battleRoundHasMatches: false,
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
          avgMmr: existing.avg_mmr || 0,
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
        slots[idx].avgMmr = 0
        slots[idx].members = []
      }
      const usedMap = {}
      slots.forEach(s => { if (s.teamId) usedMap[s.teamId] = true })
      this.setData({ rankEditSlots: slots, _rankUsedTeamMap: usedMap, rankSelectedTeamId: '' })
      return
    }

    // 找到第一个空槽位
    const card = rankTeamCards.find(c => c.teamId === teamId)
    if (!card) { return }

    const emptyIndex = rankEditSlots.findIndex(s => !s.teamId)
    if (emptyIndex < 0) {
      return
    }

    // 获取队员信息并填入
    const members = this._getTeamMembers(teamId)
    const slots = [...rankEditSlots]
    slots[emptyIndex].teamId = teamId
    slots[emptyIndex].teamName = card.teamName
    slots[emptyIndex].captainName = card.captainName
    slots[emptyIndex].avgMmr = card.avgMmr || 0
    slots[emptyIndex].members = members

    const usedMap = {}
    slots.forEach(s => { if (s.teamId) usedMap[s.teamId] = true })
    this.setData({ rankEditSlots: slots, _rankUsedTeamMap: usedMap, rankSelectedTeamId: '' })
  },

  // 点击排名区槽位 → 将选中队伍填入该名次
  assignTeamToRank(e) {
    const index = e.currentTarget.dataset.index
    const { rankSelectedTeamId, rankTeamCards, rankEditSlots } = this.data
    if (!rankSelectedTeamId) {
      return
    }
    // 检查该队伍是否已被其他名次占用
    const dupSlot = rankEditSlots.find((s, i) => i !== index && s.teamId === rankSelectedTeamId)
    if (dupSlot) {
      return
    }
    // 查找队伍卡片信息
    const card = rankTeamCards.find(c => c.teamId === rankSelectedTeamId)
    if (!card) { return }
    // 获取队员信息
    const members = this._getTeamMembers(rankSelectedTeamId)
    const slots = [...rankEditSlots]
    slots[index].teamId = rankSelectedTeamId
    slots[index].teamName = card.teamName
    slots[index].captainName = card.captainName
    slots[index].avgMmr = card.avgMmr || 0
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
    slots[index].avgMmr = 0
    slots[index].members = []
    const usedMap = {}
    slots.forEach(s => { if (s.teamId) usedMap[s.teamId] = true })
    this.setData({ rankEditSlots: slots, _rankUsedTeamMap: usedMap })
  },

  addMoreRankSlots() {
    const slots = [...this.data.rankEditSlots]
    if (slots.length >= 20) { return }
    const next = slots.length + 1
    slots.push({ rankNum: next, teamId: '', teamName: '', captainName: '', label: '第' + next + '名', members: [] })
    this.setData({ rankEditSlots: slots })
    this._updateRankUsedMap()
  },

  async removeRankSlot(e) {
    const index = e.currentTarget.dataset.index
    const slots = [...this.data.rankEditSlots]
    if (slots.length <= 1) { return }
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
