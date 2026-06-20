// ============================================================
// pages/event-detail/tab-matches.js
// Tab4: 对阵对战（积分榜模式）- 数据定义与业务方法
// 模式: select(选队配对) → pairing(调整分组+生成确认) → fighting(判定胜负) → done
// ============================================================

const api = require('../../utils/api.js')
const modal = require('../../utils/modal.js')

module.exports = {
  data: {
    // 对阵对战（积分榜 + 轮次 + 当前轮对战）
    battleLoading: false,
    battlePairing: false,
    battleStarting: false,
    battleDeleting: false,
    battleRound: 0,
    battleRoundNum: 1,
    battleRoundStatus: 'select',   // select | pairing | fighting | done
    battleRoundHasMatches: false,
    battleAllDone: false,
    battleIsLatestRound: true,
    battleRounds: [],
    battleMatches: [],
    battleScoreboard: [],          // 积分榜（按战功排序），每项含 teamId, teamName, wins, avgMmr, _selected
    battlePairs: [],               // 当前轮配对列表 [{teamA, teamB}]
    battleSelectedIds: [],
    _isRoundDone: false,
    _nextRoundHasMatches: false,
    // 换队弹窗
    showSwapModal: false,
    swapMatchId: '',
    swapSide: 'A',
    swapCurTeamName: '',
    swapBattleTeams: [],
    swapFreeTeams: [],
    // 手动配对 - 队伍选择弹窗
    showPairTeamPicker: false,
    pairPickerIndex: -1,
    pairPickerSide: 'A',
    pairPickerAllTeams: [],
    _pairBattleTeamMap: {},
    // 胜负判定弹窗
    showJudgeModal: false,
    judgeMatch: null,
    judgeWinnerId: '',
    judgeStep: 0,
    // 下一轮/结束比赛弹窗
    showBattleActionModal: false,
    battleActionType: '',
    battleActionSubmitting: false,
    _battleActionTitle: '',
    _battleActionContent: '',
  },

  methods: {
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
        modal.toast(this, { title: '加载对战数据失败', icon: 'none' })
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
      if (this.data.isArchived) return
      const matchPerm = this.data.actions.manage_matches
      if (!matchPerm || !matchPerm.allowed) return
      if (this.data.battleRoundStatus === 'fighting') return
      if (this.data.battleRoundStatus === 'done') return

      const selectedSet = new Set(this.data.battleSelectedIds)
      const wasSelected = selectedSet.has(teamId)
      if (wasSelected) { selectedSet.delete(teamId) }
      else { selectedSet.add(teamId) }
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

      const excludeIds = new Set()
      const curTeam = side === 'A' ? curPair.teamA : curPair.teamB
      if (curTeam && curTeam.teamId != null) excludeIds.add(String(curTeam.teamId))
      const samePairOther = side === 'A' ? curPair.teamB : curPair.teamA
      if (samePairOther && samePairOther.teamId != null) excludeIds.add(String(samePairOther.teamId))

      const battleMap = {}
      pairs.forEach((p, i) => {
        if (i === index) return
        if (p.teamA && p.teamA.teamId != null) battleMap[String(p.teamA.teamId)] = { pairIndex: i, pairSide: 'A' }
        if (p.teamB && p.teamB.teamId != null) battleMap[String(p.teamB.teamId)] = { pairIndex: i, pairSide: 'B' }
      })

      const allTeamList = []
      allTeams.forEach(t => {
        const tid = String(t.teamId)
        if (excludeIds.has(tid)) return
        if (battleMap[tid]) { allTeamList.push({ ...t, _status: 'battle', _pairInfo: battleMap[tid] }) }
        else { allTeamList.push({ ...t, _status: 'free' }) }
      })

      this.setData({
        showPairTeamPicker: true, pairPickerIndex: index, pairPickerSide: side,
        pairPickerAllTeams: allTeamList, _pairBattleTeamMap: battleMap
      })
    },

    // 在弹窗中选定队伍
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
        const info = _pairBattleTeamMap[teamId]
        if (!info) return
        const curTeam = pairPickerSide === 'A' ? curPair.teamA : curPair.teamB
        const otherIdx = info.pairIndex
        if (otherIdx < 0 || otherIdx >= pairs.length) return
        pairs[otherIdx] = { ...(pairs[otherIdx] || { teamA: null, teamB: null }) }
        if (pairPickerSide === 'A') { pairs[pairPickerIndex].teamA = team }
        else { pairs[pairPickerIndex].teamB = team }
        if (info.pairSide === 'A') { pairs[otherIdx].teamA = curTeam }
        else { pairs[otherIdx].teamB = curTeam }
      } else {
        if (pairPickerSide === 'A') { pairs[pairPickerIndex].teamA = team }
        else { pairs[pairPickerIndex].teamB = team }
      }
      this.setData({ battlePairs: pairs, showPairTeamPicker: false })
    },

    closePairTeamPicker() {
      this.setData({ showPairTeamPicker: false, pairPickerIndex: -1, pairPickerSide: 'A', pairPickerAllTeams: [], _pairBattleTeamMap: {} })
    },

    // 自动匹配
    doBattleAutoMatch() {
      const { battleScoreboard, battleSelectedIds } = this.data
      const selectedIds = battleSelectedIds.length > 0 ? battleSelectedIds : battleScoreboard.map(t => t.teamId)
      if (selectedIds.length < 2) {
        modal.toast(this, { title: '至少选择2支队伍才能自动匹配', icon: 'none' })
        return
      }
      const teamMap = {}; battleScoreboard.forEach(t => { teamMap[t.teamId] = t })
      const sorted = selectedIds.map(id => teamMap[id]).filter(Boolean)
      const pairs = []
      for (let i = 0; i < sorted.length - 1; i += 2) { pairs.push({ teamA: sorted[i], teamB: sorted[i + 1] }) }
      this.setData({ battlePairs: pairs })
      this._syncBattleSelected(selectedIds)
    },

    cancelBattlePair(e) {
      const idx = e.currentTarget.dataset.index
      const pairs = [...this.data.battlePairs]
      pairs.splice(idx, 1)
      this.setData({ battlePairs: pairs })
    },

    // 换队弹窗
    openSwapModal(e) {
      const { matchId, side } = e.currentTarget.dataset
      if (!matchId) return
      this._buildSwapModalCore(matchId, side)
    },

    openTeamSwap(e) {
      const teamId = String(e.currentTarget.dataset.teamId)
      const team = this.data.battleScoreboard.find(s => s.teamId === teamId)
      if (!team || !team._matchId) return
      this._buildSwapModalCore(team._matchId, team._matchSide)
    },

    _buildSwapModalCore(matchId, side) {
      const { battleScoreboard, battleMatches } = this.data
      const curMatch = battleMatches.find(m => m.match_id === matchId)
      if (!curMatch) return
      const otherSideTeamId = side === 'A' ? String(curMatch.team_b_id || '') : String(curMatch.team_a_id || '')
      const curTeamId = side === 'A' ? String(curMatch.team_a_id || '') : String(curMatch.team_b_id || '')
      const inMatchSet = new Set()
      const teamMatchMap = {}
      battleMatches.forEach(m => {
        const aId = String(m.team_a_id || ''); const bId = String(m.team_b_id || '')
        if (aId) { inMatchSet.add(aId); teamMatchMap[aId] = m.match_id }
        if (bId) { inMatchSet.add(bId); teamMatchMap[bId] = m.match_id }
      })
      const available = battleScoreboard
        .filter(t => { const tid = String(t.teamId); return tid !== otherSideTeamId && tid !== curTeamId })
        .map(t => {
          const tid = String(t.teamId); const inMatch = inMatchSet.has(tid)
          return { ...t, _inMatch: inMatch, _otherMatchId: inMatch ? (teamMatchMap[tid] || '') : '' }
        })
      const curTeam = battleScoreboard.find(s => s.teamId === curTeamId)
      this.setData({
        showSwapModal: true, swapMatchId: matchId, swapSide: side,
        swapCurTeamName: curTeam ? (curTeam.teamName || '未知') : '未知',
        swapBattleTeams: available.filter(t => t._inMatch),
        swapFreeTeams: available.filter(t => !t._inMatch)
      })
    },

    closeSwapModal() {
      this.setData({ showSwapModal: false, swapMatchId: '', swapSide: 'A', swapCurTeamName: '', swapBattleTeams: [], swapFreeTeams: [] })
    },

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
          modal.toast(this, { title: failed[0].error || '换队失败', icon: 'none' })
          this.setData({ battleMatches })
        } else {
          this._markScoreboardMatchInfo(updated)
          const ids = new Set()
          updated.forEach(m => { if (m.team_a_id) ids.add(String(m.team_a_id)); if (m.team_b_id) ids.add(String(m.team_b_id)) })
          this._syncBattleSelected([...ids])
        }
      } catch (e) {
        modal.toast(this, { title: '换队失败，请重试', icon: 'none' })
        this.setData({ battleMatches })
      }
    },

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

    // ============ 生成对战 + 开战 ============
    async doGenerateMatches() {
      const { battlePairs } = this.data
      if (battlePairs.length === 0) { modal.toast(this, { title: '请先选择参战队伍进行配对', icon: 'none' }); return }
      const incomplete = battlePairs.some(p => !p.teamA || !p.teamB)
      if (incomplete) { modal.toast(this, { title: '存在未配对完整的对战，请检查', icon: 'none' }); return }
      const pairLines = battlePairs.map((p) => { const a = p.teamA || {}; const b = p.teamB || {}; return (a.teamName || '?') + '  VS  ' + (b.teamName || '?') })
      const confirmRes = await this.showBattleConfirm('确认生成第' + this.data.battleRoundNum + '轮对战', pairLines, '确认后队伍锁定，直接进入胜负判定')
      if (!confirmRes) return
      this.setData({ battlePairing: true })
      try {
        const payload = { mode: 'manual', pairs: battlePairs.map(p => ({ teamAId: String(p.teamA.teamId), teamBId: String(p.teamB.teamId) })) }
        const res = await api.post('/events/' + this.data.eventId + '/matches/generate', payload)
        if (res.success) {
          let newRound = res.data.roundNum
          this.setData({ battleRound: newRound, battleRoundNum: newRound + 1, battlePairs: [], battleIsLatestRound: true })
          await this.loadRoundMatches(newRound)
          const roundsRes = await api.get('/events/' + this.data.eventId + '/matches/rounds')
          if (roundsRes.success) { const rds = roundsRes.data.rounds || []; this.setData({ battleRounds: rds, battleIsLatestRound: this._isLatestRound(newRound, rds) }) }
          wx.showLoading({ title: '生成中...', mask: true })
          const startRes = await api.put('/events/' + this.data.eventId + '/matches/round/' + newRound + '/start')
          wx.hideLoading()
          if (startRes.success) {
            this.setData({ battleRoundStatus: 'fighting' })
            await this.loadRoundMatches(newRound)
            await this.loadEvent(); this._updateTabLocks(); this._updateActions()
            modal.toast(this, { title: '第' + newRound + '轮对战已开启', icon: 'success' })
          } else {
            await this.loadRoundMatches(newRound)
            modal.toast(this, { title: startRes.error || '开战失败，请点击"开始对战"重试', icon: 'none', duration: 3000 })
          }
        } else { modal.toast(this, { title: res.error || '生成失败', icon: 'none', duration: 2500 }) }
        this.setData({ battlePairing: false })
      } catch (e) { this.setData({ battlePairing: false }); wx.hideLoading(); modal.toast(this, { title: '网络错误，生成失败', icon: 'none', duration: 2000 }) }
    },

    async doDeleteRoundMatches() {
      const confirmRes = await modal.confirm(this, { theme: 'danger', title: '清除本轮对战', content: '将删除第' + this.data.battleRound + '轮所有对战记录，回到选队阶段。\n\n确认清除？' })
      if (!confirmRes.confirm) return
      this.setData({ battleDeleting: true })
      try {
        const { battleMatches } = this.data
        for (const m of battleMatches) { if (m.match_status === 0) { await api.del('/events/' + this.data.eventId + '/matches/' + m.match_id) } }
        this.setData({ battleDeleting: false })
        const roundsRes = await api.get('/events/' + this.data.eventId + '/matches/rounds')
        if (roundsRes.success) {
          const rds = roundsRes.data.rounds || []; const cur = roundsRes.data.currentRound || 0
          const allD = rds.length > 0 && rds.every(r => r.allDone)
          const targetRound = cur > 0 ? cur : (rds.length > 0 ? rds[rds.length - 1].roundNum : 0)
          this.setData({ battleRounds: rds, battleRound: targetRound, battleRoundNum: targetRound > 0 ? targetRound : 1, battleAllDone: allD, battleIsLatestRound: this._isLatestRound(targetRound, rds) })
          if (targetRound > 0) { await this.loadRoundMatches(targetRound) }
          else { this.setData({ battleRoundStatus: 'select', battleRoundHasMatches: false, battleMatches: [], battlePairs: [] }); this._syncBattleSelected([]) }
        }
      } catch (e) { this.setData({ battleDeleting: false }); modal.toast(this, { title: '删除失败，请重试', icon: 'none' }) }
    },

    async doStartRound() {
      const { battleRound, battleMatches } = this.data
      const matchLines = battleMatches.map((m) => (m.team_a_name || '?') + '  VS  ' + (m.team_b_name || '?'))
      const confirmRes = await this.showBattleConfirm('🔥 开始第' + battleRound + '轮对战', matchLines, '开战后分组锁定，无法再更换队伍')
      if (!confirmRes) return
      this.setData({ battleStarting: true })
      try {
        const res = await api.put('/events/' + this.data.eventId + '/matches/round/' + this.data.battleRound + '/start')
        this.setData({ battleStarting: false })
        if (res.success) {
          this.setData({ battleRoundStatus: 'fighting' }); await this.loadRoundMatches(this.data.battleRound)
          await this.loadEvent(); this._updateTabLocks(); this._updateActions()
          modal.toast(this, { title: '第' + this.data.battleRound + '轮对战已开启', icon: 'success' })
        } else { modal.toast(this, { title: res.error || '开战失败', icon: 'none' }) }
      } catch (e) { this.setData({ battleStarting: false }); modal.toast(this, { title: '开战失败，请重试', icon: 'none' }) }
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
    selectWinner(e) { this.setData({ judgeWinnerId: e.currentTarget.dataset.teamId, judgeStep: 1 }) },
    backToSelect() { this.setData({ judgeStep: 0, judgeWinnerId: '' }) },
    async confirmJudge() {
      const { judgeMatch, judgeWinnerId, eventId } = this.data
      if (!judgeMatch || !judgeWinnerId) return
      this.setData({ loading: true })
      try {
        const res = await api.put('/events/' + eventId + '/matches/' + judgeMatch.match_id + '/judge', { winnerId: judgeWinnerId, confirmed: true })
        this.setData({ loading: false })
        if (res.success) {
          this.setData({ showJudgeModal: false, judgeMatch: null, judgeWinnerId: '', judgeStep: 0 })
          await this.loadRoundMatches(this.data.battleRound)
          const sbRes = await api.get('/events/' + eventId + '/teams/scoreboard')
          if (sbRes.success) {
            const prevMap = {}; this.data.battleScoreboard.forEach(s => { prevMap[s.teamId] = s._selected })
            const sb = (sbRes.data || []).map(s => this._ensureAvgMmr({ ...s, teamId: String(s.teamId), _selected: !!prevMap[String(s.teamId)] }))
            this.setData({ battleScoreboard: sb })
          }
          await this._checkRoundComplete()
        } else { modal.toast(this, { title: res.error || '判定失败', icon: 'none' }) }
      } catch (e) { this.setData({ loading: false }); modal.toast(this, { title: '判定失败，请重试', icon: 'none' }) }
    },
    closeJudgeModal() { this.setData({ showJudgeModal: false, judgeMatch: null, judgeWinnerId: '', judgeStep: 0 }) },

    // ============ 上传对战结果图片 ============
    _canUploadMatchImage(match) {
      if (!match || this.data.isArchived) return false
      if (match.match_status !== 2) return false
      if (this.data.isAdmin) return true
      const { _myPlayerId, battleScoreboard } = this.data
      if (!_myPlayerId) return false
      const teamA = battleScoreboard.find(s => String(s.teamId) === String(match.team_a_id))
      const teamB = battleScoreboard.find(s => String(s.teamId) === String(match.team_b_id))
      const isCaptainA = teamA && String(teamA.captainId) === String(_myPlayerId)
      const isCaptainB = teamB && String(teamB.captainId) === String(_myPlayerId)
      return isCaptainA || isCaptainB
    },

    uploadMatchImage(e) {
      const matchId = e.currentTarget.dataset.matchId
      const match = this.data.battleMatches.find(m => m.match_id === matchId)
      if (!match) return
      if (!this._canUploadMatchImage(match)) { return }
      this._isUploading = true
      const that = this
      wx.chooseImage({
        count: 1, sizeType: ['compressed'], sourceType: ['album', 'camera'],
        success(res) { const tempPath = res.tempFilePaths[0]; that._doUploadMatchImage(matchId, tempPath) },
        fail() { that._isUploading = false }
      })
    },

    async _doUploadMatchImage(matchId, filePath) {
      wx.showLoading({ title: '上传中...' })
      try {
        const API_BASE = api.API_BASE
        let url = API_BASE + '/events/' + this.data.eventId + '/matches/' + matchId + '/image'
        const app = getApp()
        let openid = ''
        try { openid = app.globalData.openid || '' } catch (e) { }
        if (openid) url += (url.indexOf('?') >= 0 ? '&' : '?') + 'openid=' + encodeURIComponent(openid)
        const header = {}
        try { const token = app.getToken ? app.getToken() : ''; if (token) header['Authorization'] = 'Bearer ' + token } catch (e) { }
        const res = await new Promise((resolve, reject) => {
          wx.uploadFile({ url, filePath, name: 'file', header, success: resolve, fail: reject })
        })
        wx.hideLoading()
        const data = JSON.parse(res.data)
        if (data.success) {
          const imageUrl = this._normalizeImageUrl(data.data.url)
          const matches = this.data.battleMatches.map(m => m.match_id === matchId ? { ...m, battle_image: imageUrl } : m)
          this.setData({ battleMatches: matches })
        } else { modal.toast(this, { title: data.error || '上传失败', icon: 'none' }) }
      } catch (e) { wx.hideLoading(); modal.toast(this, { title: '上传失败', icon: 'none' }) }
      finally { this._isUploading = false }
    },

    _normalizeImageUrl(url) {
      if (!url) return ''
      return url.startsWith('http') ? url : api.BASE_URL + url
    },

    previewMatchImage(e) {
      const url = e.currentTarget.dataset.url
      if (url) { const fullUrl = this._normalizeImageUrl(url); wx.previewImage({ urls: [fullUrl], current: fullUrl }) }
    },

    async _checkRoundComplete() {
      const res = await api.get('/events/' + this.data.eventId + '/matches', { round: this.data.battleRound })
      if (res.success) {
        const matches = res.data || []
        const allDone = matches.length > 0 && matches.every(m => m.match_status === 2)
        if (allDone) {
          this.setData({ battleRoundStatus: 'done' })
          const rRes = await api.get('/events/' + this.data.eventId + '/matches/rounds')
          if (rRes.success) { const rds = rRes.data.rounds || []; const allBattlesDone = rds.length > 0 && rds.every(r => r.allDone); this.setData({ battleRounds: rds, battleAllDone: allBattlesDone }) }
        }
      }
    },

    // ============ 下一轮 / 结束比赛 ============
    showBattleAction(e) {
      const actionType = e.currentTarget.dataset.action
      let title = '', content = ''
      if (actionType === 'next-round') { title = '进入下一轮'; content = '确认进入第' + (this.data.battleRound + 1) + '轮对战？\n\n所有原始队伍保留，需重新选择参战队伍并编排对阵。' }
      else { title = '结束比赛'; content = '确认结束当前赛事？\n\n比赛结束后可设定队伍名次，设定完成后需点击「归档比赛」正式归档。' }
      this.setData({ showBattleActionModal: true, battleActionType: actionType, _battleActionTitle: title, _battleActionContent: content })
    },
    hideBattleActionModal() { this.setData({ showBattleActionModal: false }) },
    async doBattleAction() {
      const { battleActionType } = this.data
      this.setData({ battleActionSubmitting: true })
      const url = battleActionType === 'next-round' ? '/events/' + this.data.eventId + '/next-round' : '/events/' + this.data.eventId + '/end-battle'
      try {
        const res = await api.post(url, {})
        this.setData({ battleActionSubmitting: false, showBattleActionModal: false })
        if (res.success) {
          if (battleActionType === 'end-battle') { await this.loadEvent(); this._updateTabLocks(); this._updateActions(); setTimeout(() => this._switchToTab('ranks'), 800) }
          else {
            const nextRound = res.data.nextRound || (this.data.battleRound + 1)
            const sbRes = await api.get('/events/' + this.data.eventId + '/teams/scoreboard')
            if (sbRes.success) this.setData({ battleScoreboard: sbRes.data || [] })
            const roundsRes = await api.get('/events/' + this.data.eventId + '/matches/rounds')
            const rds = (roundsRes.success && roundsRes.data.rounds) ? roundsRes.data.rounds : []
            if (!rds.some(r => r.roundNum === nextRound)) { rds.push({ roundNum: nextRound, matchCount: 0, completedCount: 0, allDone: false }) }
            this.setData({ battleRounds: rds, battleRound: nextRound, battleRoundNum: nextRound, battleAllDone: false, battleIsLatestRound: true, battleRoundStatus: 'select', battleRoundHasMatches: false, battleMatches: [], battlePairs: [] })
            this._syncBattleSelected([])
          }
        } else { modal.toast(this, { title: res.error || '操作失败', icon: 'none' }) }
      } catch (e) { this.setData({ battleActionSubmitting: false, showBattleActionModal: false }); modal.toast(this, { title: '操作失败，请重试', icon: 'none' }) }
    },
  }
}
