// ============================================================
// pages/event-detail/tab-teams.js
// Tab3: 分组编队 - 数据定义与业务方法
// ============================================================

const api = require('../../utils/api.js')
const modal = require('../../utils/modal.js')
const { normalizeTeamItem, normalizeFreeAgent } = require('./utils.js')

module.exports = {
  data: {
    // 分组编队
    teams: [],
    freeAgents: [],
    teamsLoading: false,
    teamsSaving: false,
    teamsDirty: false,
    selectedPlayerId: '',
    dragData: null,
    autoTeamCount: '',
    autoTeamSuggestion: '',
    allocating: false,
    locking: false,
    showTeamCountModal: false,
    // 战队名编辑
    _editingTeamId: '',
    _editTeamNameValue: '',
  },

  methods: {
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
        modal.toast(this, { title: '加载队伍数据失败', icon: 'none' })
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
          modal.toast(this, { title: res.error || '更新失败', icon: 'none' })
        }
      } catch (e) {
        wx.hideLoading()
        modal.toast(this, { title: '更新失败，请重试', icon: 'none' })
      }
    },

    // ============ 保存 & 锁定 ============

    // 保存编组到服务器
    async saveTeams() {
      if (!this.data.actions.manage_teams || !this.data.actions.manage_teams.allowed) {
        modal.toast(this, { title: '当前不可保存编组', icon: 'none' })
        return
      }
      if (this.data.teams.length === 0) {
        modal.toast(this, { title: '请至少创建一支队伍', icon: 'none' })
        return
      }

      // 前端校验：每队至少5人且有队长
      for (const team of this.data.teams) {
        const members = team.members || team.players || []
        if (members.length < 5) {
          modal.toast(this, { title: `队伍「${team.team_name}」至少需要5名队员，当前${members.length}人`, icon: 'none' })
          return
        }
        if (!team.captain_id) {
          modal.toast(this, { title: `队伍「${team.team_name}」未指定队长`, icon: 'none' })
          return
        }
        if (!members.some(m => String(m.id) === String(team.captain_id))) {
          modal.toast(this, { title: `队伍「${team.team_name}」的队长不在队员列表中`, icon: 'none' })
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
          modal.toast(this, { title: res.error || '保存失败', icon: 'none' })
        }
      } catch (e) {
        this.setData({ teamsSaving: false })
        modal.toast(this, { title: '保存失败，请重试', icon: 'none' })
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
        modal.toast(this, { title: '请输入有效的队伍数量', icon: 'none' })
        return
      }
      const totalPlayers = this.data.signupTotal || this.data.signupCount || 0
      if (count > totalPlayers) {
        modal.toast(this, { title: `队伍数量(${count})不能超过报名人数(${totalPlayers})`, icon: 'none' })
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
          modal.toast(this, { title: res.error || '分队失败', icon: 'none' })
        }
      } catch (e) {
        this.setData({ allocating: false })
        modal.toast(this, { title: '分队失败，请重试', icon: 'none' })
      }
    },

    // 锁定分组并开赛
    async doLockTeams() {
      const lockAction = this.data.actions.lock_teams
      if (!lockAction || !lockAction.allowed) {
        modal.toast(this, { title: lockAction?.reason || '当前不可锁定开赛', icon: 'none' })
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
          modal.toast(this, { title: res.error || '开赛失败', icon: 'none' })
        }
      } catch (e) {
        this.setData({ locking: false })
        modal.toast(this, { title: '操作失败，请重试', icon: 'none' })
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
          modal.toast(this, { title: res.error || '返回失败', icon: 'none' })
        }
      } catch (e) {
        modal.toast(this, { title: '返回失败，请重试', icon: 'none' })
      }
    },

    // 跳转到队伍编辑页（保留兼容，但不再使用）
    goTeamEdit() {
      // 不再跳转独立页面，所有操作在 Tab3 内完成
      this._switchToTab('teams')
    },
  }
}
