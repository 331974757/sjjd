/**
 * ============================================================
 * 第6轮：对战编排页 - 队伍勾选 + 两两配对 + 自动匹配
 * pages/event-match-edit/event-match-edit
 *
 * 【功能说明】
 * - 队伍列表支持勾选，拖拽组合对阵
 * - 「自动匹配」快捷按钮：按MMR分值从近到远两两配对
 * - 手动编排：管理员自由勾选本轮参赛队伍，两两组合对阵
 * - 未勾选的队伍本轮轮空，保留在队伍列表中
 * - 生成对阵后跳转对战详情
 *
 * 【路由参数】
 * ?eventId=xxx  赛事ID（必传）
 * ============================================================
 */

const api = require('../../utils/api')
const perm = require('../../utils/permission')

Page({
  data: {
    // 赛事信息
    eventId: '',
    eventName: '',
    eventStatus: -1,

    // 权限
    isAdmin: false,

    // 团队数据
    teams: [],               // 所有队伍 [{teamId, teamName, totalMmr, playerCount, ...}]
    selectedTeamIds: [],     // 当前勾选的队伍ID列表
    pairs: [],               // 已配对列表 [{teamA:{}, teamB:{}}]
    unpairedTeamIds: [],     // 已勾选但未配对的队伍ID

    // 轮次信息
    currentRound: 0,         // 当前轮次（已有最大轮次）
    nextRound: 1,            // 下一轮序号

    // UI 状态
    loading: true,
    generating: false,
    draggingTeamId: '',      // 正在拖拽的队伍ID
    showConfirmModal: false, // 生成确认弹窗
  },

  // =====================================================
  // 生命周期
  // =====================================================

  onLoad(options) {
    const { eventId } = options
    if (!eventId) {
      wx.showToast({ title: '缺少赛事ID', icon: 'none' })
      wx.navigateBack()
      return
    }
    this.setData({ eventId })
    this.init()
  },

  async init() {
    try {
      const role = await perm.getRole()
      const isAdmin = role === 'admin' || role === 'super_admin'
      this.setData({ isAdmin })

      if (!isAdmin) {
        wx.showToast({ title: '仅管理员可操作', icon: 'none' })
        setTimeout(() => wx.navigateBack(), 1500)
        return
      }

      await Promise.all([
        this.loadEventInfo(),
        this.loadTeams(),
        this.loadRoundInfo(),
      ])
      this.setData({ loading: false })
    } catch (e) {
      console.error('[对战编排] 初始化失败', e)
      this.setData({ loading: false })
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
  },

  // =====================================================
  // 数据加载
  // =====================================================

  /** 加载赛事基本信息 */
  async loadEventInfo() {
    try {
      const res = await api.get(`/events/${this.data.eventId}`)
      if (res.success) {
        this.setData({
          eventName: res.data.event_name || '',
          eventStatus: res.data.event_status,
        })
        // 非对战中状态提示
        if (res.data.event_status !== 4) {
          const map = { 0: '创建中', 1: '报名中', 2: '报名截止', 3: '分组锁定', 5: '已归档' }
          wx.showModal({
            title: '无法操作',
            content: `赛事当前状态为「${map[res.data.event_status] || '未知'}」，仅对战中可编排对阵`,
            showCancel: false,
            success: () => wx.navigateBack(),
          })
        }
      }
    } catch (e) {
      console.error('[对战编排] 加载赛事信息失败', e)
    }
  },

  /** 加载所有队伍 */
  async loadTeams() {
    try {
      const res = await api.get(`/events/${this.data.eventId}/teams`)
      if (res.success) {
        const teams = (res.data.teams || []).map(t => ({
          teamId: t.team_id,
          teamName: t.team_name,
          totalMmr: t.total_mmr || 0,
          playerCount: t.playerCount || 0,
          captainName: t.captain ? t.captain.wx_nickname : '未指定',
          players: t.players || [],
        }))
        this.setData({ teams })
      }
    } catch (e) {
      console.error('[对战编排] 加载队伍失败', e)
    }
  },

  /** 加载轮次信息 */
  async loadRoundInfo() {
    try {
      const res = await api.get(`/events/${this.data.eventId}/matches/rounds`)
      if (res.success) {
        const { rounds, currentRound, totalRounds } = res.data
        this.setData({
          currentRound: currentRound,
          nextRound: totalRounds + 1,
        })
      }
    } catch (e) {
      console.error('[对战编排] 加载轮次信息失败', e)
    }
  },

  // =====================================================
  // 队伍勾选交互
  // =====================================================

  /** 勾选/取消勾选队伍 */
  toggleTeam(e) {
    const teamId = e.currentTarget.dataset.teamId
    let selected = [...this.data.selectedTeamIds]

    const idx = selected.indexOf(teamId)
    if (idx >= 0) {
      // 取消勾选：同时移除相关配对
      selected.splice(idx, 1)
    } else {
      // 勾选
      selected.push(teamId)
    }

    // 重新计算配对（保持已有配对不变，只处理新增/移除的队伍）
    this.setData({ selectedTeamIds: selected })
    this.autoPairSelected()
  },

  /** 全选 / 取消全选 */
  toggleSelectAll() {
    if (this.data.selectedTeamIds.length === this.data.teams.length) {
      // 取消全选
      this.setData({ selectedTeamIds: [], pairs: [], unpairedTeamIds: [] })
    } else {
      // 全选
      const allIds = this.data.teams.map(t => t.teamId)
      this.setData({ selectedTeamIds: allIds })
      this.autoPairSelected()
    }
  },

  /** 自动将选中的队伍按索引顺序两两配对 */
  autoPairSelected() {
    const { selectedTeamIds, teams } = this.data
    const teamMap = {}
    teams.forEach(t => { teamMap[t.teamId] = t })

    // 按选中顺序排列
    const selectedTeams = selectedTeamIds.map(id => teamMap[id]).filter(Boolean)

    const pairs = []
    for (let i = 0; i < selectedTeams.length - 1; i += 2) {
      pairs.push({
        teamA: selectedTeams[i],
        teamB: selectedTeams[i + 1],
      })
    }

    // 奇数个选中：最后一个未配对
    const unpairedTeamIds = selectedTeams.length % 2 === 1
      ? [selectedTeams[selectedTeams.length - 1].teamId]
      : []

    this.setData({ pairs, unpairedTeamIds })
  },

  // =====================================================
  // 手动配对操作
  // =====================================================

  /** 点击「配对」按钮：将两个选中的队伍配成一对 */
  pairSelected() {
    const { selectedTeamIds, teams, pairs } = this.data

    if (selectedTeamIds.length < 2) {
      wx.showToast({ title: '请至少勾选2支队伍进行配对', icon: 'none' })
      return
    }

    // 取前两个未配对的选中队伍
    const alreadyPairedIds = new Set()
    pairs.forEach(p => {
      alreadyPairedIds.add(p.teamA.teamId)
      alreadyPairedIds.add(p.teamB.teamId)
    })

    const unpaired = selectedTeamIds.filter(id => !alreadyPairedIds.has(id))
    if (unpaired.length < 2) {
      wx.showToast({ title: '已全部配对完成', icon: 'none' })
      return
    }

    const teamMap = {}
    teams.forEach(t => { teamMap[t.teamId] = t })

    const newPairs = [...pairs]
    for (let i = 0; i < unpaired.length - 1; i += 2) {
      newPairs.push({
        teamA: teamMap[unpaired[i]],
        teamB: teamMap[unpaired[i + 1]],
      })
    }

    this.setData({ pairs: newPairs })
    wx.showToast({ title: `已配对 ${newPairs.length} 组`, icon: 'success', duration: 1000 })
  },

  /** 清除某组配对 */
  removePair(e) {
    const idx = e.currentTarget.dataset.index
    const pairs = [...this.data.pairs]
    const removed = pairs.splice(idx, 1)[0]

    // 被移除的队伍的ID仍然保留在选中列表中
    wx.showToast({
      title: `已取消「${removed.teamA.teamName}」vs「${removed.teamB.teamName}」`,
      icon: 'none',
      duration: 1500,
    })

    this.setData({ pairs })
  },

  // =====================================================
  // 自动匹配（快捷按钮）
  // =====================================================

  /** 自动匹配：按MMR从近到远两两配对 */
  autoMatch() {
    const { teams } = this.data
    if (teams.length < 2) {
      wx.showToast({ title: '至少需要2支队伍', icon: 'none' })
      return
    }

    // 按 total_mmr 升序排列
    const sorted = [...teams].sort((a, b) => (a.totalMmr || 0) - (b.totalMmr || 0))
    const pairs = []
    for (let i = 0; i < sorted.length - 1; i += 2) {
      pairs.push({ teamA: sorted[i], teamB: sorted[i + 1] })
    }

    const selectedIds = []
    pairs.forEach(p => {
      selectedIds.push(p.teamA.teamId, p.teamB.teamId)
    })
    // 奇数队伍：最后一条不配对
    const unpairedTeamIds = sorted.length % 2 === 1 ? [sorted[sorted.length - 1].teamId] : []
    if (unpairedTeamIds.length > 0) {
      selectedIds.push(unpairedTeamIds[0])
    }

    this.setData({
      selectedTeamIds: selectedIds,
      pairs,
      unpairedTeamIds,
    })

    wx.showToast({
      title: `已匹配 ${pairs.length} 组对战（按MMR排列）`,
      icon: 'success',
      duration: 2000,
    })
  },

  // =====================================================
  // 生成对阵（提交后端）
  // =====================================================

  /** 点击「生成对阵」→ 弹出确认窗 */
  showGenerateConfirm() {
    const { pairs, nextRound, unpairedTeamIds } = this.data

    if (pairs.length === 0) {
      wx.showToast({ title: '请先配对至少1组对战', icon: 'none' })
      return
    }

    // 构建确认信息
    const pairNames = pairs.map(p =>
      `${p.teamA.teamName}（${p.teamA.totalMmr}分）vs ${p.teamB.teamName}（${p.teamB.totalMmr}分）`
    ).join('\n')

    const byes = this.data.teams
      .filter(t => !this.data.selectedTeamIds.includes(t.teamId))
      .map(t => t.teamName)

    let confirmContent = `即将生成第${nextRound}轮对战：\n\n${pairNames}`
    if (byes.length > 0) {
      confirmContent += `\n\n本轮轮空：${byes.join('、')}`
    }
    confirmContent += '\n\n生成后不可撤销，确认继续？'

    this.setData({
      showConfirmModal: true,
      _confirmContent: confirmContent,
    })
  },

  /** 隐藏确认弹窗 */
  hideConfirmModal() {
    this.setData({ showConfirmModal: false })
  },

  /** 确认生成：调用后端接口 */
  async doGenerate() {
    this.setData({ showConfirmModal: false, generating: true })

    try {
      const { pairs } = this.data
      const payload = {
        mode: 'manual',
        pairs: pairs.map(p => ({
          teamAId: p.teamA.teamId,
          teamBId: p.teamB.teamId,
        })),
      }

      const res = await api.post(`/events/${this.data.eventId}/matches/generate`, payload)
      this.setData({ generating: false })

      if (res.success) {
        const { roundNum, matchCount, byes } = res.data
        let msg = `第${roundNum}轮已生成，共 ${matchCount} 场对战`
        if (byes && byes.length > 0) {
          msg += `，${byes.length} 队轮空`
        }

        wx.showModal({
          title: '对阵生成成功',
          content: msg,
          showCancel: false,
          confirmText: '查看对战',
          success: () => {
            // 返回赛事详情页查看对战列表
            wx.navigateBack()
          },
        })
      } else {
        wx.showToast({ title: res.error || '生成失败', icon: 'none' })
      }
    } catch (e) {
      this.setData({ generating: false })
      console.error('[生成对阵] 失败', e)
      wx.showToast({ title: '生成失败，请重试', icon: 'none' })
    }
  },

  /** 自动匹配并直接生成（快捷流程） */
  async autoGenerate() {
    const { teams } = this.data
    if (teams.length < 2) {
      wx.showToast({ title: '至少需要2支队伍', icon: 'none' })
      return
    }

    // 二次确认
    const confirmRes = await new Promise(r => {
      wx.showModal({
        title: '自动匹配生成',
        content: `将按MMR分值自动配对 ${teams.length} 支队伍，生成第${this.data.nextRound}轮对战。\n\n确认继续？`,
        success: r,
      })
    })
    if (!confirmRes.confirm) return

    this.setData({ generating: true })

    try {
      const res = await api.post(`/events/${this.data.eventId}/matches/generate`, {
        mode: 'auto',
      })
      this.setData({ generating: false })

      if (res.success) {
        wx.showModal({
          title: '自动配对完成',
          content: `第${res.data.roundNum}轮已生成，共 ${res.data.matchCount} 场对战。`,
          showCancel: false,
          confirmText: '查看对战',
          success: () => wx.navigateBack(),
        })
      } else {
        wx.showToast({ title: res.error || '生成失败', icon: 'none' })
      }
    } catch (e) {
      this.setData({ generating: false })
      console.error('[自动匹配] 失败', e)
      wx.showToast({ title: '生成失败，请重试', icon: 'none' })
    }
  },

  // =====================================================
  // 跳转对战列表
  // =====================================================

  /** 跳转查看已有对战 */
  goViewMatches() {
    wx.navigateBack() // 返回赛事详情页查看
  },

  // 防止弹窗背景滚动
  preventMove() {},
})
