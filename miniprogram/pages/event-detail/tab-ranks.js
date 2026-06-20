// ============================================================
// pages/event-detail/tab-ranks.js
// Tab5: 名次归档 - 数据定义与业务方法
// ============================================================

const api = require('../../utils/api.js')
const modal = require('../../utils/modal.js')

module.exports = {
  data: {
    // 名次归档
    ranks: [],
    ranksLoading: false,
    ranksEditing: false,
    ranksSaving: false,
    rankEditSlots: [],
    rankTeamCards: [],
    teamsForRank: [],
    _rankUsedTeamMap: {},
    rankSelectedTeamId: '',
    showArchiveConfirm: false,
    archiveSubmitting: false,
  },

  methods: {
    async loadRanks() {
      try {
        const res = await api.get('/events/' + this.data.eventId + '/ranks')
        if (res.success) this.setData({ ranks: res.data || [] })
      } catch (e) {
        console.error('[名次] 加载失败', e)
        modal.toast(this, { title: '加载名次数据失败', icon: 'none' })
      }
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
          modal.toast(this, { title: res.error || '保存失败', icon: 'none' })
        }
      } catch (e) {
        this.setData({ ranksSaving: false })
        modal.toast(this, { title: '保存失败，请重试', icon: 'none' })
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
            wx.redirectTo({ url: '/pages/index/index?subTab=history' })
          }, 1500)
        } else {
          modal.toast(this, { title: res.error || '归档失败', icon: 'none' })
        }
      } catch (e) {
        this.setData({ archiveSubmitting: false, showArchiveConfirm: false })
        modal.toast(this, { title: '归档失败，请重试', icon: 'none' })
      }
    },
  }
}
