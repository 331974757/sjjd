/**
 * ============================================================
 * 第5轮：队伍拖拽编组 + 指定队长
 * pages/event-team-edit/event-team-edit
 *
 * 【交互说明】
 * - 自由选手区：点击选择选手（高亮），再点击队伍卡片放入
 * - 队伍内操作：点击👑设为队长，点击×移出队伍
 * - 管理员专属：自动分队/保存编组/开始比赛/新建删除队伍
 * - 普通用户：只读查看最终编组结果
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
    eventStatus: -1,
    eventName: '',

    // 权限
    userRole: '',
    isAdmin: false,
    canEdit: false,   // 综合判断：管理员 + 状态为2/3

    // 数据
    loading: true,
    freePlayers: [],     // 未入队选手
    teams: [],           // 已编组队伍
    originalTeams: [],   // 原始队伍快照（用于对比是否修改）

    // 交互状态
    selectedPlayerId: '',   // 当前选中的自由选手ID
    saving: false,
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

  onShow() {
    // 每次进入刷新数据（编辑后返回可看到更新）
    // loading=true 可能是初次加载未完成，跳过刷新避免重复请求
    if (this.data.eventId && !this.data.loading) {
      // 【P5修复】同步刷新赛事状态，确保 canEdit 不滞后
      this.loadEventStatus()
      this.loadTeamData()
    }
  },

  /** 手动刷新按钮 */
  async onRefreshTap() {
    wx.showLoading({ title: '刷新中...', mask: true })
    try {
      await Promise.all([
        this.loadEventStatus(),
        this.loadTeamData()
      ])
      wx.showToast({ title: '已刷新', icon: 'success', duration: 1200 })
    } catch (e) {
      wx.showToast({ title: '刷新失败', icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },

  async init() {
    try {
      // 1. 获取用户权限 【第9轮修复】perm.requireRole 不存在，改用 getRole
      const role = await perm.getRole()
      const isAdmin = role === 'admin' || role === 'super_admin'
      this.setData({ userRole: role, isAdmin })

      // 2. 加载赛事状态
      await this.loadEventStatus()

      // 3. 加载队伍数据
      await this.loadTeamData()
    } catch (e) {
      console.error('[队伍编组] 初始化失败', e)
      wx.showToast({ title: '加载失败', icon: 'none' })
      // 不阻塞后续 onShow 刷新
      this.setData({ loading: false })
    }
  },

  // =====================================================
  // 数据加载
  // =====================================================

  /**
   * 加载赛事详情（获取状态和名称）
   */
  async loadEventStatus() {
    try {
      const res = await api.get(`/events/${this.data.eventId}`)
      if (res.success && res.data) {
        const event = res.data
        // 判断是否可编辑：管理员 + 状态为报名截止(2)或分组锁定(3) + 未归档
        const canEdit = this.data.isAdmin && (event.event_status === 2 || event.event_status === 3) && event.is_archived !== 1
        this.setData({
          eventStatus: event.event_status,
          eventName: event.event_name || '',
          canEdit,
        })
      }
    } catch (e) {
      console.error('[队伍编组] 获取赛事信息失败', e)
    }
  },

  /**
   * 加载队伍+自由选手数据
   * GET /api/events/:eventId/teams
   */
  async loadTeamData() {
    this.setData({ loading: true })
    try {
      const res = await api.get(`/events/${this.data.eventId}/teams`)
      if (res.success) {
        const { teams, freePlayers, eventStatus } = res.data

        // 【修复】规范化队伍数据：API返回snake_case(team_id/team_name/total_mmr)，前端统一使用camelCase
        const normalizedTeams = (teams || []).map(t => ({
          teamId: t.team_id || t.teamId || '',
          teamName: t.team_name || t.teamName || '未命名',
          captain_id: t.captain_id || t.captainId || '',
          captain: t.captain || null,
          players: t.players || [],
          playerIds: (t.players || []).map(p => p.id),
          totalMmr: t.total_mmr || t.totalMmr || 0,
        }))

        this.setData({
          teams: normalizedTeams,
          freePlayers: freePlayers || [],
          eventStatus: eventStatus || this.data.eventStatus,
          selectedPlayerId: '', // 清空选中
          loading: false,
        })

        // 首次加载时保存快照
        if (this.data.originalTeams.length === 0) {
          this.setData({ originalTeams: JSON.parse(JSON.stringify(normalizedTeams)) })
        }
      } else {
        this.setData({ loading: false })
        wx.showToast({ title: res.error || '加载失败', icon: 'none' })
      }
    } catch (e) {
      console.error('[队伍编组] 加载队伍失败', e)
      this.setData({ loading: false })
    }
  },

  // =====================================================
  // 选手选择交互（模拟拖拽：点击选择 → 点击队伍放入）
  // =====================================================

  /**
   * 点击自由选手：选中/取消选中
   */
  selectPlayer(e) {
    const playerId = e.currentTarget.dataset.playerId
    // 如果已选中同一个，取消选中；否则选中新选手
    if (this.data.selectedPlayerId === playerId) {
      this.setData({ selectedPlayerId: '' })
      wx.showToast({ title: '已取消选择', icon: 'none', duration: 1000 })
    } else {
      this.setData({ selectedPlayerId: playerId })
      // 从自由选手中找到昵称做提示
      const player = this.data.freePlayers.find(p => p.id === playerId)
      if (player) {
        wx.showToast({ title: `已选「${player.wx_nickname}」，点击队伍放入`, icon: 'none', duration: 1500 })
      }
    }
  },

  /**
   * 点击队伍卡片：将选中的自由选手放入该队伍
   */
  dropToTeam(e) {
    const teamId = e.currentTarget.dataset.teamId
    const selectedId = this.data.selectedPlayerId

    if (!selectedId) return
    if (!teamId) return

    // 找到选中的选手
    const player = this.data.freePlayers.find(p => p.id === selectedId)
    if (!player) {
      this.setData({ selectedPlayerId: '' })
      return
    }

    // 【重复入队校验】检查该选手是否已在目标队伍中
    const targetTeam = this.data.teams.find(t => t.teamId === teamId)
    if (targetTeam) {
      const alreadyIn = targetTeam.players.some(p => p.id === selectedId)
      if (alreadyIn) {
        wx.showToast({ title: '该选手已在队伍中', icon: 'none' })
        return
      }
    }

    // 执行移动：从自由区移除，加入目标队伍
    const freePlayers = this.data.freePlayers.filter(p => p.id !== selectedId)
    const teams = this.data.teams.map(t => {
      if (t.teamId === teamId) {
        return {
          ...t,
          players: [...t.players, player],
          playerIds: [...(t.playerIds || []), player.id],
        }
      }
      return t
    })

    this.setData({
      freePlayers,
      teams,
      selectedPlayerId: '',
    })

    wx.showToast({ title: `已加入「${targetTeam?.teamName}」`, icon: 'success', duration: 1200 })
  },

  // =====================================================
  // 队伍内操作
  // =====================================================

  /**
   * 设置/取消队长
   * 点击👑：如已是队长则取消，否则设为队长
   */
  setTeamCaptain(e) {
    const { teamId, playerId } = e.currentTarget.dataset
    if (!teamId || !playerId) return

    const teams = this.data.teams.map(t => {
      if (t.teamId === teamId) {
        // 如果当前队长就是这个选手，取消队长
        const newCaptainId = (t.captain && t.captain.id === playerId) ? '' : playerId
        return {
          ...t,
          captain_id: newCaptainId,
          captain: newCaptainId
            ? (t.players.find(p => p.id === playerId) || { id: playerId, wx_nickname: '未知' })
            : null,
        }
      }
      return t
    })

    this.setData({ teams })

    // 【修复】取消队长后 captain 为 null，所以 captain?.id !== playerId 才是移除操作
    const isRemoving = teams.find(t => t.teamId === teamId)?.captain?.id !== playerId
    wx.showToast({
      title: isRemoving ? '已取消队长' : '已设为队长',
      icon: 'success',
      duration: 1000
    })
  },

  /**
   * 从队伍中移出选手（放回自由区）
   */
  removeFromTeam(e) {
    const { teamId, playerId } = e.currentTarget.dataset
    if (!teamId || !playerId) return

    const targetTeam = this.data.teams.find(t => t.teamId === teamId)
    if (!targetTeam) return

    const playerToRemove = targetTeam.players.find(p => p.id === playerId)
    if (!playerToRemove) return

    // 将选手放回自由区
    const freePlayers = [...this.data.freePlayers, playerToRemove]

    // 从队伍中移除
    const teams = this.data.teams.map(t => {
      if (t.teamId === teamId) {
        const newPlayers = t.players.filter(p => p.id !== playerId)
        const newPlayerIds = (t.playerIds || []).filter(pid => pid !== playerId)
        // 如果移除的是队长，清除队长
        const wasCaptain = t.captain && t.captain.id === playerId
        return {
          ...t,
          players: newPlayers,
          playerIds: newPlayerIds,
          captain_id: wasCaptain ? '' : t.captain_id,
          captain: wasCaptain ? null : t.captain,
        }
      }
      return t
    })

    this.setData({ teams, freePlayers })
    wx.showToast({ title: '已移出队伍', icon: 'success', duration: 1000 })
  },

  // =====================================================
  // 队伍操作
  // =====================================================

  /**
   * 新建队伍
   */
  addTeam() {
    const teamIndex = this.data.teams.length + 1
    const teamName = '战队' + teamIndex

    const teams = [...this.data.teams, {
      teamId: 'temp_' + Date.now(), // 临时ID，保存时会重新生成
      teamName,
      captain_id: '',
      captain: null,
      playerIds: [],
      players: [],
      totalMmr: 0,
      isNew: true, // 标记为新建
    }]

    this.setData({ teams })
    wx.showToast({ title: `已创建「${teamName}」`, icon: 'success', duration: 1000 })
  },

  /**
   * 删除队伍（释放队员到自由区）
   */
  deleteTeam(e) {
    const teamId = e.currentTarget.dataset.teamId
    const team = this.data.teams.find(t => t.teamId === teamId)
    if (!team) return

    // 二次确认
    const playerCount = team.players.length
    const confirmMsg = playerCount > 0
      ? `删除「${team.teamName}」将释放 ${playerCount} 名队员到自由区，确认删除？`
      : `确认删除空队伍「${team.teamName}」？`

    wx.showModal({
      title: '删除队伍',
      content: confirmMsg,
      success: (res) => {
        if (!res.confirm) return

        // 释放队员回自由区
        const freePlayers = [...this.data.freePlayers, ...team.players]
        const teams = this.data.teams.filter(t => t.teamId !== teamId)

        this.setData({ teams, freePlayers, selectedPlayerId: '' })
        wx.showToast({ title: '已删除', icon: 'success' })
      }
    })
  },

  // =====================================================
  // 自动分队
  // =====================================================

  /**
   * 调用后端自动分队接口
   * POST /api/events/:eventId/allocate-teams
   */
  async autoAllocate() {
    // 二次确认（会覆盖当前编组）
    const hasExisting = this.data.teams.some(t => t.players.length > 0)
    const confirmMsg = hasExisting
      ? '自动分队将覆盖当前编组结果，是否继续？'
      : '自动分队将根据选手段位均衡分配，是否继续？'

    const confirmRes = await new Promise(r => {
      wx.showModal({
        title: '自动分队',
        content: confirmMsg,
        success: r,
      })
    })
    if (!confirmRes.confirm) return

    // 队伍数量确认
    const playerCount = this.data.freePlayers.length +
      this.data.teams.reduce((sum, t) => sum + t.players.length, 0)
    const defaultTeamCount = Math.max(1, Math.ceil(playerCount / 5))

    const countRes = await new Promise(r => {
      wx.showModal({
        title: '分队参数',
        content: `共计 ${playerCount} 名选手，建议 ${defaultTeamCount} 支队伍（每队约${Math.ceil(playerCount / defaultTeamCount)}人）。\n使用建议数量？\n\n（点「取消」可手动输入数量）`,
        confirmText: '使用建议',
        cancelText: '手动输入',
        success: r,
      })
    })

    let teamCount = defaultTeamCount
    if (!countRes.confirm) {
      // 手动输入队伍数量
      const inputRes = await new Promise(r => {
        wx.showModal({
          title: '输入队伍数量',
          editable: true,
          placeholderText: String(defaultTeamCount),
          content: `共${playerCount}名选手，请输入队伍数量：`,
          success: r,
        })
      })
      if (!inputRes.confirm) return
      const val = parseInt(inputRes.content)
      if (isNaN(val) || val < 1) {
        wx.showToast({ title: '队伍数量无效', icon: 'none' })
        return
      }
      teamCount = val
    }

    // 调用后端
    wx.showLoading({ title: '自动分队中...' })
    try {
      const res = await api.post(`/events/${this.data.eventId}/allocate-teams`, {
        teamCount,
        teamNamePrefix: '战队',
      })

      if (res.success) {
        const { teams, stats, warnings } = res.data

        // 转为前端格式
        const formattedTeams = teams.map(t => ({
          teamId: 'temp_' + t.index + '_' + Date.now(),
          teamName: t.teamName,
          captain_id: t.captainId,
          captain: t.players.length > 0
            ? (t.players.find(p => p.id === t.captainId) || t.players[0])
            : null,
          playerIds: t.playerIds,
          players: t.players,
          totalMmr: t.totalMmr,
          isNew: true,
        }))

        // 释放所有选手回自由区（全量覆盖）
        const allFreePlayers = []
        this.setData({
          teams: formattedTeams,
          freePlayers: allFreePlayers,
          selectedPlayerId: '',
        })

        wx.hideLoading()

        // 显示均衡度统计
        if (stats) {
          const info = [
            `共${teams.length}队 · ${res.data.totalPlayers}名选手`,
            `最大分差：${stats.scoreStats.maxDiff}分 (${stats.scoreStats.grade})`,
            `位置满足率：${Math.round(stats.positionRate.rate * 100)}%`,
          ]
          if (warnings && warnings.length) {
            info.push(`⚠ ${warnings[0]}`)
          }
          wx.showModal({
            title: '分队完成',
            content: info.join('\n'),
            showCancel: false,
            confirmText: '好的',
          })
        }
      } else {
        wx.hideLoading()
        wx.showToast({ title: res.error || '分队失败', icon: 'none' })
      }
    } catch (e) {
      wx.hideLoading()
      console.error('[自动分队] 失败', e)
      wx.showToast({ title: '自动分队失败', icon: 'none' })
    }
  },

  // =====================================================
  // 保存 & 开始比赛
  // =====================================================

  /**
   * 批量保存编组结果
   * POST /api/events/:eventId/teams/batch
   */
  async saveTeams() {
    // 【前端校验】每队至少5人 + 必须有队长且队长在队员列表中
    for (const team of this.data.teams) {
      if (team.players.length < 5) {
        wx.showToast({ title: `「${team.teamName}」至少需要5名队员，当前仅${team.players.length}人`, icon: 'none' })
        return
      }
      if (!team.captain || !team.captain_id) {
        wx.showToast({ title: `「${team.teamName}」未指定队长`, icon: 'none' })
        return
      }
      if (!team.players.some(p => p.id === team.captain_id)) {
        wx.showToast({ title: `「${team.teamName}」队长不在队员中`, icon: 'none' })
        return
      }
    }

    // 构建提交数据
    const teamsPayload = this.data.teams.map(t => ({
      teamName: t.teamName,
      captainId: t.captain_id,
      playerIds: t.players.map(p => p.id),
    }))

    this.setData({ saving: true })
    wx.showLoading({ title: '保存中...' })

    try {
      const res = await api.post(`/events/${this.data.eventId}/teams/batch`, {
        teams: teamsPayload,
      })

      wx.hideLoading()
      this.setData({ saving: false })

      if (res.success) {
        wx.showToast({ title: res.message || '保存成功', icon: 'success' })

        // 重新加载最新数据
        setTimeout(() => {
          this.loadTeamData()
          // 刷新赛事状态
          this.loadEventStatus()
        }, 800)
      } else {
        wx.showToast({ title: res.error || '保存失败', icon: 'none' })
      }
    } catch (e) {
      wx.hideLoading()
      this.setData({ saving: false })
      console.error('[保存编组] 失败', e)
      wx.showToast({ title: '保存失败', icon: 'none' })
    }
  },

  /**
   * 开始比赛（锁定队伍）
   * POST /api/events/:eventId/lock-teams
   * - 需赛事状态=分组锁定(3)
   * - 队伍数据完整，二次确认
   */
  async startMatch() {
    // 二次确认
    const confirmRes = await new Promise(r => {
      wx.showModal({
        title: '开始比赛',
        content: `确认开始比赛？\n\n这将永久锁定 ${this.data.teams.length} 支队伍的编组结果，锁定后无法修改。`,
        confirmText: '确认开赛',
        cancelText: '取消',
        confirmColor: '#f85149',
        success: r,
      })
    })
    if (!confirmRes.confirm) return

    wx.showLoading({ title: '锁定中...' })

    try {
      const res = await api.post(`/events/${this.data.eventId}/lock-teams`, {})

      wx.hideLoading()

      if (res.success) {
        wx.showModal({
          title: '比赛开始！',
          content: `队伍已永久锁定，${res.data.teamCount} 支队伍进入对战阶段。`,
          showCancel: false,
          confirmText: '知道了',
          success: () => {
            // 刷新状态
            this.loadTeamData()
            this.loadEventStatus()
          }
        })
      } else {
        wx.showToast({ title: res.error || '操作失败', icon: 'none' })
      }
    } catch (e) {
      wx.hideLoading()
      console.error('[开始比赛] 失败', e)
      wx.showToast({ title: '操作失败', icon: 'none' })
    }
  },
})
