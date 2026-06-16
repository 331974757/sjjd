// pages/event-detail/event-detail.js
// 【赛事详情页】展示赛事信息 + 报名区域 + 报名人员列表 + 对战管理 + 名次设定 + 赛事归档
// 权限规则：admin/super_admin 拥有完整赛事管理权限，user 仅可查看和自助报名
// 【第8轮新增】支持 readonly=1 参数，从历史赛事Tab进入时强制纯只读模式
const api = require('../../utils/api.js')
const perm = require('../../utils/permission.js')

Page({
  data: {
    eventId: '',                // 赛事ID（从URL参数获取）
    event: null,                // 赛事详情对象
    loaded: false,              // 数据是否加载完成
    userRole: '',               // 当前用户角色
    isAdmin: false,             // 是否管理员
    // 【第8轮新增】纯只读模式标记（从历史赛事Tab进入时为true）
    readonly: false,            // true=纯只读，无论角色，隐藏所有编辑入口
    fromHistory: false,         // 来源是否为历史赛事
    // 报名状态（针对当前用户）
    mySignup: null,             // { signedUp, signupId, playerId, signupType, ... }
    // 已报名人员列表
    signups: [],                // 报名列表（仅有效报名）
    signupCount: 0,             // 报名总人数
    // UI 状态
    loading: false,             // 操作加载中
    showCancelConfirm: false,   // 取消报名二次确认弹窗
    showStatusConfirm: false,   // 状态变更二次确认弹窗
    targetStatus: -1,           // 目标状态
    targetStatusName: '',       // 目标状态中文名

    // ===== 第6轮：对战管理 =====
    battleTab: 'matches',       // 对战区域标签：matches | rounds
    rounds: [],                 // 轮次汇总 [{roundNum, matchCount, completedCount, allDone}]
    currentRound: 0,            // 当前查看的轮次
    matches: [],                // 当前轮次对战列表
    totalRounds: 0,             // 总轮次数
    roundAllDone: false,        // 本轮是否全部完成
    allBattlesDone: false,      // 所有轮次是否全部完成

    // 胜负判定弹窗
    showJudgeModal: false,
    judgeMatch: null,           // 当前判定的对战对象
    judgeStep: 0,               // 0=选择胜方, 1=二次确认
    judgeWinnerId: '',          // 选择的胜方ID

    // 下一轮/结束比赛确认弹窗
    showBattleActionModal: false,
    battleActionType: '',       // 'next-round' | 'end-battle'
    battleActionSubmitting: false,

    // ===== 第7轮：名次设定 + 赛事归档 =====
    isArchived: false,          // 是否已归档（is_archived=1，此时全数据只读）
    ranks: [],                  // 已有名次列表 [{rank_id, rank_num, team_id, team_name, total_mmr}]
    rankEditSlots: [],          // 名次编辑槽位 [{rankNum: 1, teamId: '', index: 0}, ...] 默认3个
    teamsForRank: [],           // 赛事队伍列表（供下拉选择）
    ranksEditing: false,        // 是否正在编辑名次
    ranksSaving: false,         // 名次保存中
    // 归档弹窗
    showArchiveConfirm: false,
    archiveSubmitting: false,
  },

  onLoad(options) {
    const eventId = options.eventId || options.id || ''
    if (!eventId) {
      wx.showToast({ title: '赛事ID缺失', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 1500)
      return
    }
    // 【第8轮新增】读取 readonly 参数：从历史赛事进入时强制纯只读
    const readonly = options.readonly === '1' || options.readonly === 'true'
    const fromHistory = options.fromHistory === '1' || options.fromHistory === 'true'
    this.setData({ eventId, readonly, fromHistory })
    // 纯只读模式下更新导航栏标题
    if (readonly) {
      wx.setNavigationBarTitle({ title: '历史赛事详情' })
    }
    this.initPage()
  },

  onShow() {
    // 每次显示页面时刷新数据（可能从报名管理页或对阵编排页返回）
    if (this.data.eventId && this.data.loaded) {
      // 重新加载赛事状态（状态可能已变更），并刷新权限判断
      this.loadEvent().then(() => {
        if (this.data.event) this.updateActionPermissions()
      })
      this.loadSignups()
      this.loadMySignup()
      // 如果赛事处于对战中/已归档，刷新对战数据
      if (this.data.event && this.data.event.event_status >= 4) {
        this.loadBattleData(this.data.currentRound || 0)
      }
      // 【第7轮】赛事已结束，刷新名次数据
      if (this.data.event && this.data.event.event_status === 5) {
        this.loadRanks()
      }
    }
  },

  // ====== 页面初始化 ======
  async initPage() {
    try {
      // 【第8轮】纯只读模式：跳过权限校验，但仍获取角色用于展示
      if (this.data.readonly) {
        const role = await perm.getRole()
        this.setData({ userRole: role, isAdmin: false }) // 强制 isAdmin=false 隐藏所有编辑入口
      } else {
        const role = await perm.getRole()
        const isAdmin = role === 'admin' || role === 'super_admin'
        this.setData({ userRole: role, isAdmin })
      }

      await this.loadEvent()
      if (this.data.event) {
        // 【统一权限】基于 checkAction() 生成按钮状态，保证前后端规则完全一致
        this.updateActionPermissions()
        // 赛事加载完成后，并行拉取报名信息
        const tasks = [this.loadSignups(), this.loadMySignup()]
        // 对战中/已归档：额外加载对战数据
        if (this.data.event.event_status >= 4) {
          tasks.push(this.loadBattleData(0))
        }
        // 【第7轮】赛事已结束(status=5)：加载名次数据
        if (this.data.event.event_status === 5) {
          tasks.push(this.loadRanks())
        }
        await Promise.all(tasks)
      }
      this.setData({ loaded: true })
    } catch (e) {
      console.error('[赛事详情] 初始化失败', e)
      this.setData({ loaded: true })
    }
  },

  // 【统一权限】基于 checkAction() 生成所有按钮的状态对象，保证前后端规则一致
  updateActionPermissions() {
    const event = this.data.event
    if (!event) return
    const opts = {
      eventStatus: event.event_status,
      isArchived: event.is_archived || 0,
      userRole: this.data.userRole
    }
    // 只读模式：所有写操作均禁止
    if (this.data.readonly) {
      const empty = { allowed: false, disabled: true, reason: '历史赛事只读' }
      this.setData({
        actions: {
          signup: empty, cancel_signup: empty, edit_event: empty,
          change_status: empty, manage_signups: empty, manage_teams: empty,
          lock_teams: empty, manage_matches: empty, manage_ranks: empty,
          archive_event: empty
        },
        signupBtn: empty,
        cancelSignupBtn: empty,
        signupDisabledReason: '历史赛事只读'
      })
      return
    }
    const actions = {}
    const actionKeys = [
      'signup', 'cancel_signup', 'edit_event', 'change_status',
      'manage_signups', 'manage_teams', 'lock_teams',
      'manage_matches', 'manage_ranks', 'archive_event'
    ]
    actionKeys.forEach(key => {
      actions[key] = perm.checkAction(key, opts)
    })
    this.setData({
      actions,
      signupBtn: actions.signup,
      cancelSignupBtn: actions.cancel_signup,
      signupDisabledReason: actions.signup.reason
    })
  },

  // ====== 加载赛事详情 ======
  async loadEvent() {
    try {
      const res = await api.get('/events/' + this.data.eventId)
      if (res.success) {
        const event = res.data
        // 补充状态中文名和时间格式化
        event._statusName = this.getStatusName(event.event_status)
        event._statusClass = this.getStatusClass(event.event_status)
        event._timeLabel = this.formatTime(event.start_time)
        // 【SEVERE-1修复】同步设置 isArchived，不依赖 loadRanks()
        this.setData({
          event,
          isArchived: event.is_archived === 1,
          _archiveTimeText: event.archived_at ? '归档时间：' + this.formatTime(event.archived_at) : ''
        })
      } else {
        wx.showToast({ title: res.error || '赛事不存在', icon: 'none' })
        setTimeout(() => wx.navigateBack(), 1500)
      }
    } catch (e) {
      wx.showToast({ title: '加载赛事失败', icon: 'none' })
    }
  },

  // ====== 加载当前用户报名状态 ======
  async loadMySignup() {
    try {
      const res = await api.get('/events/' + this.data.eventId + '/my-signup')
      if (res.success) {
        this.setData({ mySignup: res.data })
      }
    } catch (e) {
      console.error('[赛事详情] 加载报名状态失败', e)
    }
  },

  // ====== 加载已报名人员列表 ======
  async loadSignups() {
    try {
      // 管理员拉取所有有效报名，普通用户也查看列表
      const res = await api.get('/events/' + this.data.eventId + '/signups', {
        status: 1,
        pageSize: 200
      })
      if (res.success) {
        const list = res.data || []
        // 格式化报名数据
        list.forEach(s => {
          s._typeLabel = s.signup_type === 1 ? '管理员添加' : '自主报名'
          s._typeClass = s.signup_type === 1 ? 'type-admin' : 'type-self'
        })
        this.setData({ signups: list, signupCount: list.length })
      }
    } catch (e) {
      console.error('[赛事详情] 加载报名列表失败', e)
    }
  },

  // ====== 状态映射工具 ======
  getStatusName(status) {
    const map = { 0: '创建中', 1: '报名中', 2: '报名截止', 3: '分组锁定', 4: '对战中', 5: '已归档' }
    return map[status] || '未知'
  },
  getStatusClass(status) {
    // 不同状态对应的 CSS 类名
    const map = { 0: 's-draft', 1: 's-open', 2: 's-closed', 3: 's-locked', 4: 's-fighting', 5: 's-archived' }
    return map[status] || ''
  },
  // 获取按钮状态提示文本（用于灰化按钮时的原因说明）
  getBtnDisabledReason() {
    const event = this.data.event
    if (!event) return ''
    const status = event.event_status
    if (status === 0) return '报名未开始'
    if (status === 2) return '报名已截止'
    if (status === 3) return '赛事已分组锁定'
    if (status === 4) return '赛事对战中'
    if (status === 5) return '赛事已归档'
    return ''
  },

  formatTime(ts) {
    if (!ts) return '待定'
    const d = new Date(parseInt(ts))
    const pad = n => String(n).padStart(2, '0')
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
  },

  // ====== 用户自主报名（核心流程） ======
  async doSignup() {
    const { event, mySignup } = this.data

    // 【前置校验1】赛事状态检查
    if (event.event_status !== 1) {
      wx.showToast({ title: this.getBtnDisabledReason(), icon: 'none' })
      return
    }

    // 【前置校验2】已报名检查
    if (mySignup && mySignup.signedUp) {
      wx.showToast({ title: '您已报名当前赛事', icon: 'none' })
      return
    }

    this.setData({ loading: true })
    try {
      // 【核心】调用自主报名接口，后端自动完成昵称匹配校验
      const res = await api.post('/events/' + this.data.eventId + '/signups', {})
      wx.hideLoading()
      this.setData({ loading: false })

      if (res.success) {
        wx.showToast({ title: '报名成功！', icon: 'success' })
        // 刷新报名状态和列表
        await Promise.all([this.loadMySignup(), this.loadSignups()])
      } else {
        // 根据后端返回的 code 展示对应错误提示
        this.handleSignupError(res)
      }
    } catch (e) {
      this.setData({ loading: false })
      wx.showToast({ title: '报名失败，请重试', icon: 'none' })
      console.error('[赛事详情] 报名失败', e)
    }
  },

  // 处理报名错误（根据后端 code 展示不同提示）
  handleSignupError(res) {
    const code = res.code || ''
    switch (code) {
      case 'NICKNAME_EMPTY':
        wx.showModal({
          title: '未设置昵称',
          content: '请先设置您的微信群昵称后再报名。\n\n点击「确认」去设置昵称。',
          success: (modalRes) => {
            if (modalRes.confirm) {
              // 通过事件通知主页打开昵称弹窗
              wx.navigateBack()
            }
          }
        })
        break
      case 'PLAYER_NOT_FOUND':
        wx.showModal({
          title: '未找到选手档案',
          content: '未找到与您昵称匹配的选手档案，请联系管理员先录入您的选手信息。',
          showCancel: false
        })
        break
      case 'MULTIPLE_MATCH':
        wx.showModal({
          title: '匹配到多条记录',
          content: '您的昵称匹配到多个选手档案，请联系管理员手动添加报名。',
          showCancel: false
        })
        break
      case 'ALREADY_SIGNED':
        wx.showToast({ title: '您已报名当前赛事', icon: 'none' })
        break
      case 'EVENT_NOT_OPEN':
        wx.showToast({ title: res.error || '当前赛事不在报名阶段', icon: 'none' })
        break
      default:
        wx.showToast({ title: res.error || '报名失败', icon: 'none' })
    }
  },

  // ====== 普通用户取消报名 ======
  showCancelConfirm() {
    this.setData({ showCancelConfirm: true })
  },
  hideCancelConfirm() {
    this.setData({ showCancelConfirm: false })
  },

  async doCancelSignup() {
    this.setData({ showCancelConfirm: false, loading: true })
    try {
      const signupId = this.data.mySignup.signupId
      const res = await api.del('/events/' + this.data.eventId + '/signups/' + signupId)
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

  // ====== 管理员操作：开启/截止报名 ======
  // 根据当前状态计算下一个合法状态
  getNextStatus() {
    const status = this.data.event.event_status
    // 仅允许正向流转：0→1（开启报名）, 1→2（截止报名）
    if (status === 0) return { status: 1, name: '开启报名', confirmTitle: '确认开启报名', confirmMsg: '开启后选手可自助报名，确定继续？' }
    if (status === 1) return { status: 2, name: '截止报名', confirmTitle: '确认截止报名', confirmMsg: '截止后选手将无法报名或取消报名，确定继续？' }
    return null
  },

  showStatusConfirm() {
    const next = this.getNextStatus()
    if (!next) {
      wx.showToast({ title: '当前状态不支持此操作', icon: 'none' })
      return
    }
    this.setData({
      showStatusConfirm: true,
      targetStatus: next.status,
      targetStatusName: next.name,
      _confirmTitle: next.confirmTitle,
      _confirmMsg: next.confirmMsg
    })
  },
  hideStatusConfirm() {
    this.setData({ showStatusConfirm: false })
  },

  async doChangeStatus() {
    this.setData({ showStatusConfirm: false, loading: true })
    try {
      const res = await api.put('/events/' + this.data.eventId + '/status', {
        eventStatus: this.data.targetStatus
      })
      this.setData({ loading: false })

      if (res.success) {
        wx.showToast({ title: this.data.targetStatusName + '成功', icon: 'success' })
        await this.loadEvent()
        await Promise.all([this.loadMySignup(), this.loadSignups()])
      } else {
        wx.showToast({ title: res.error || '操作失败', icon: 'none' })
      }
    } catch (e) {
      this.setData({ loading: false })
      wx.showToast({ title: '操作失败，请重试', icon: 'none' })
    }
  },

  // ====== 管理员操作：跳转报名人员管理 ======
  goSignupManage() {
    wx.navigateTo({
      url: '/pages/event-signup-manage/event-signup-manage?eventId=' + this.data.eventId
    })
  },

  // 【第5轮新增】跳转队伍编组页
  goTeamEdit() {
    wx.navigateTo({
      url: '/pages/event-team-edit/event-team-edit?eventId=' + this.data.eventId
    })
  },

  // ============================================================
  // 【第6轮新增】对战管理
  // ============================================================

  /** 跳转对战编排页 */
  goMatchEdit() {
    wx.navigateTo({
      url: '/pages/event-match-edit/event-match-edit?eventId=' + this.data.eventId
    })
  },

  /** 加载轮次+对战数据 */
  async loadBattleData(round) {
    try {
      // 并行拉取：轮次汇总 + 指定轮次对战详情
      const [roundsRes, matchesRes] = await Promise.all([
        api.get('/events/' + this.data.eventId + '/matches/rounds'),
        api.get('/events/' + this.data.eventId + '/matches', {
          round: round || this.data.currentRound || 0
        })
      ])

      if (roundsRes.success) {
        const { rounds, currentRound: serverRound, totalRounds } = roundsRes.data
        const allDone = rounds.length > 0 && rounds.every(r => r.allDone)
        // 仅首次加载（round=0 或未传）时使用服务端 currentRound，否则保留用户手动切换的轮次
        const keepRound = !round || round === 0 ? serverRound : round
        this.setData({
          rounds,
          currentRound: keepRound,
          totalRounds,
          allBattlesDone: allDone,
        })
      }

      if (matchesRes.success) {
        const matches = matchesRes.data || []
        // 判断本轮是否全部完成
        const roundAllDone = matches.length > 0 && matches.every(m => m._isDone)
        this.setData({ matches, roundAllDone })
      }
    } catch (e) {
      console.error('[对战数据] 加载失败', e)
    }
  },

  /** 切换轮次 */
  switchRound(e) {
    const round = e.currentTarget.dataset.round
    this.setData({ currentRound: round })
    this.loadBattleData(round)
  },

  /** 切换对战区域标签 */
  switchBattleTab(e) {
    const tab = e.currentTarget.dataset.tab
    this.setData({ battleTab: tab })
    if (tab === 'matches') {
      this.loadBattleData(this.data.currentRound || 0)
    }
  },

  // ----- 胜负判定 -----

  /** 打开胜负判定弹窗（管理员点击对战卡片） */
  openJudgeModal(e) {
    if (!this.data.isAdmin) return
    // 【第7轮】已归档赛事不可判定
    if (this.data.isArchived) {
      wx.showToast({ title: '赛事已归档，不可修改', icon: 'none' })
      return
    }
    const matchId = e.currentTarget.dataset.matchId
    const match = this.data.matches.find(m => m.match_id === matchId)
    if (!match) return
    if (match._isDone) {
      wx.showToast({ title: '该对战已判定', icon: 'none' })
      return
    }
    this.setData({
      showJudgeModal: true,
      judgeMatch: match,
      judgeStep: 0,
      judgeWinnerId: '',
    })
  },

  /** 选择胜方 */
  selectWinner(e) {
    this.setData({
      judgeWinnerId: e.currentTarget.dataset.teamId,
      judgeStep: 1, // 进入二次确认
    })
  },

  /** 返回重新选择胜方 */
  backToSelect() {
    this.setData({ judgeStep: 0, judgeWinnerId: '' })
  },

  /** 确认判定（二次确认后提交） */
  async confirmJudge() {
    const { judgeMatch, judgeWinnerId, eventId } = this.data
    if (!judgeMatch || !judgeWinnerId) return

    this.setData({ loading: true })
    try {
      const res = await api.put(
        `/events/${eventId}/matches/${judgeMatch.match_id}/judge`,
        { winnerId: judgeWinnerId, confirmed: true }
      )
      this.setData({ loading: false })

      if (res.success) {
        wx.showToast({ title: '胜负已判定', icon: 'success' })
        this.setData({
          showJudgeModal: false,
          judgeMatch: null,
          judgeWinnerId: '',
          judgeStep: 0,
        })
        // 刷新对战数据
        await this.loadBattleData(this.data.currentRound)
      } else {
        wx.showToast({ title: res.error || '判定失败', icon: 'none' })
      }
    } catch (e) {
      this.setData({ loading: false })
      wx.showToast({ title: '判定失败，请重试', icon: 'none' })
    }
  },

  /** 关闭胜负判定弹窗 */
  closeJudgeModal() {
    this.setData({
      showJudgeModal: false,
      judgeMatch: null,
      judgeWinnerId: '',
      judgeStep: 0,
    })
  },

  // ----- 下一轮 / 结束比赛 -----

  /** 打开对战操作确认弹窗 */
  showBattleAction(e) {
    const actionType = e.currentTarget.dataset.action
    let title = '', content = ''

    if (actionType === 'next-round') {
      title = '进入下一轮'
      content = `确认进入第${this.data.currentRound + 1}轮对战？\n\n所有原始队伍将保留，管理员需重新选择参赛队伍并编排对阵。`
    } else if (actionType === 'end-battle') {
      title = '结束比赛'
      content = `确认结束当前赛事？\n\n比赛结束后可设定队伍名次，设定完成后需点击「归档比赛」正式归档。`
    }

    this.setData({
      showBattleActionModal: true,
      battleActionType: actionType,
      _battleActionTitle: title,
      _battleActionContent: content,
    })
  },

  /** 隐藏对战操作弹窗 */
  hideBattleActionModal() {
    this.setData({ showBattleActionModal: false })
  },

  /** 执行对战操作 */
  async doBattleAction() {
    const { battleActionType } = this.data
    this.setData({ battleActionSubmitting: true })

    const url = battleActionType === 'next-round'
      ? `/events/${this.data.eventId}/next-round`
      : `/events/${this.data.eventId}/end-battle`

    try {
      const res = await api.post(url, {})
      this.setData({ battleActionSubmitting: false, showBattleActionModal: false })

      if (res.success) {
        wx.showToast({ title: res.data.message || '操作成功', icon: 'success' })

        if (battleActionType === 'end-battle') {
          // 【第7轮修改】赛事已结束(status=5)，刷新全部数据+名次
          await this.loadEvent()
          await Promise.all([this.loadMySignup(), this.loadSignups(), this.loadBattleData(0), this.loadRanks()])
        } else {
          // 进入下一轮，刷新对战数据
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

  // ============================================================
  // 【第7轮新增】名次设定 + 赛事归档
  // ============================================================

  /** 加载名次数据 */
  async loadRanks() {
    try {
      const res = await api.get('/events/' + this.data.eventId + '/ranks')
      if (res.success) {
        const ranks = res.data || []
        this.setData({ ranks })
      }
    } catch (e) {
      console.error('[名次] 加载失败', e)
    }
  },

  /** 加载队伍列表（供名次下拉选择） */
  async loadTeamsForRank() {
    try {
      const res = await api.get('/events/' + this.data.eventId + '/teams')
      if (res.success) {
        const teams = res.data && res.data.teams ? res.data.teams : []
        this.setData({ teamsForRank: teams })
      }
    } catch (e) {
      console.error('[名次] 加载队伍列表失败', e)
    }
  },

  /** 进入名次编辑模式（管理员） */
  async startEditRanks() {
    if (!this.data.isAdmin) return

    // 先加载队伍列表
    await this.loadTeamsForRank()

    // 构建编辑槽位：已有名次填充 + 默认3个空槽位
    const existingRanks = this.data.ranks || []
    const defaultSlots = [
      { rankNum: 1, teamId: '', label: '第1名（冠军）' },
      { rankNum: 2, teamId: '', label: '第2名（亚军）' },
      { rankNum: 3, teamId: '', label: '第3名（季军）' }
    ]

    // 用已有数据填充默认槽位
    const slots = defaultSlots.map(slot => {
      const existing = existingRanks.find(r => r.rank_num === slot.rankNum)
      const teamId = existing ? existing.team_id : ''
      return {
        rankNum: slot.rankNum,
        teamId: teamId,
        label: slot.label,
        _displayName: this._resolveTeamName(teamId) // 【修复】预计算显示名，避免WXML箭头函数编译错误
      }
    })

    this.setData({
      ranksEditing: true,
      rankEditSlots: slots
    })
  },

  /** 取消编辑 */
  cancelEditRanks() {
    this.setData({
      ranksEditing: false,
      rankEditSlots: []
    })
  },

  /** 【修复】根据 teamId 从 teamsForRank 查找队伍名称，避免 WXML 中使用箭头函数导致编译错误 */
  _resolveTeamName(teamId) {
    if (!teamId) return ''
    const teams = this.data.teamsForRank || []
    const found = teams.find(t => t.team_id === teamId)
    return found ? (found.team_name || '未知') : ''
  },

  /** 名次下拉选择变更 */
  onRankTeamChange(e) {
    const index = e.currentTarget.dataset.index
    const teamId = this.data.teamsForRank[e.detail.value]
      ? this.data.teamsForRank[e.detail.value].team_id
      : ''
    const slots = [...this.data.rankEditSlots]
    slots[index].teamId = teamId
    slots[index]._displayName = this._resolveTeamName(teamId)
    this.setData({ rankEditSlots: slots })
  },

  /** 添加更多名次 */
  addMoreRankSlots() {
    const slots = [...this.data.rankEditSlots]
    const nextRankNum = slots.length + 1
    slots.push({
      rankNum: nextRankNum,
      teamId: '',
      label: '第' + nextRankNum + '名',
      _displayName: '' // 【修复】预计算显示名
    })
    this.setData({ rankEditSlots: slots })
  },

  /** 移除指定名次槽位（仅限前3名之后） */
  removeRankSlot(e) {
    const index = e.currentTarget.dataset.index
    if (index < 3) {
      wx.showToast({ title: '前3名为默认保留位', icon: 'none' })
      return
    }
    const slots = [...this.data.rankEditSlots]
    slots.splice(index, 1)
    // 重新编号 rankNum
    slots.forEach((s, i) => {
      s.rankNum = i + 1
      s.label = i < 3
        ? ['第1名（冠军）', '第2名（亚军）', '第3名（季军）'][i]
        : '第' + (i + 1) + '名'
    })
    this.setData({ rankEditSlots: slots })
  },

  /** 保存名次（批量提交） */
  async saveRanks() {
    const { rankEditSlots, eventId } = this.data

    // 构建提交数据
    const ranks = rankEditSlots.map(slot => ({
      rankNum: slot.rankNum,
      teamId: slot.teamId || ''
    }))

    // 过滤掉有实质内容的项
    const hasContent = ranks.some(r => r.teamId !== '')
    if (!hasContent) {
      // 全部为空，执行清空名次（提交空数组会触发删除所有名次）
      wx.showModal({
        title: '清空名次',
        content: '当前所有名次均为空，提交将清空所有已有名次记录。确定继续？',
        success: (modalRes) => {
          if (modalRes.confirm) {
            this.doBatchSaveRanks(ranks)
          }
        }
      })
      return
    }

    await this.doBatchSaveRanks(ranks)
  },

  /** 执行批量保存名次 */
  async doBatchSaveRanks(ranksData) {
    this.setData({ ranksSaving: true })
    try {
      const res = await api.post('/events/' + this.data.eventId + '/ranks/batch', {
        ranks: ranksData
      })
      this.setData({ ranksSaving: false })

      if (res.success) {
        wx.showToast({ title: '名次已保存', icon: 'success' })
        this.setData({ ranksEditing: false })
        // 刷新名次显示
        await this.loadRanks()
      } else {
        wx.showToast({ title: res.error || '保存失败', icon: 'none' })
      }
    } catch (e) {
      this.setData({ ranksSaving: false })
      wx.showToast({ title: '保存失败，请重试', icon: 'none' })
      console.error('[名次] 保存失败', e)
    }
  },

  // ----- 赛事归档 -----

  /** 显示归档确认弹窗 */
  showArchiveConfirm() {
    this.setData({ showArchiveConfirm: true })
  },

  /** 隐藏归档确认弹窗 */
  hideArchiveConfirm() {
    this.setData({ showArchiveConfirm: false })
  },

  /** 执行归档操作 */
  async doArchive() {
    this.setData({ archiveSubmitting: true })
    try {
      const res = await api.post('/events/' + this.data.eventId + '/archive', {})
      this.setData({ archiveSubmitting: false, showArchiveConfirm: false })

      if (res.success) {
        wx.showToast({ title: '赛事已归档', icon: 'success', duration: 2000 })
        // 刷新赛事详情（is_archived 变为 1）
        await this.loadEvent()
        // 进入只读模式
        this.setData({
          isArchived: true,
          ranksEditing: false
        })
        await this.loadRanks()
      } else {
        wx.showToast({ title: res.error || '归档失败', icon: 'none' })
      }
    } catch (e) {
      this.setData({ archiveSubmitting: false, showArchiveConfirm: false })
      wx.showToast({ title: '归档失败，请重试', icon: 'none' })
      console.error('[归档] 失败', e)
    }
  },

  /** 获取队伍名称（用于显示名次） */
  getTeamName(teamId) {
    const ranks = this.data.ranks || []
    const rank = ranks.find(r => r.team_id === teamId)
    return rank ? rank.team_name : '未知队伍'
  },

  /** 格式化归档时间（WXML 模板函数） */
  getFormattedTime(ts) {
    if (!ts) return ''
    const d = new Date(parseInt(ts))
    const pad = n => String(n).padStart(2, '0')
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
  },

  // ====== 分享 ======
  onShareAppMessage() {
    const event = this.data.event
    return {
      title: (event ? event.event_name : '赛事详情') + ' - 蜀国争霸系统',
      path: '/pages/event-detail/event-detail?eventId=' + this.data.eventId
    }
  },

  // 防止弹窗背景滚动
  preventMove() {},

  // 下拉刷新
  onPullDownRefresh() {
    const tasks = [
      this.loadEvent(),
      this.loadSignups(),
      this.loadMySignup()
    ]
    if (this.data.event && this.data.event.event_status === 5) {
      tasks.push(this.loadRanks())
    }
    Promise.all(tasks).then(() => wx.stopPullDownRefresh())
      .catch(() => wx.stopPullDownRefresh())
  }
})
