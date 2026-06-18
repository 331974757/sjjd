// pages/event-signup-manage/event-signup-manage.js
// 【管理员报名人员管理页】左侧已报名列表 + 右侧选手检索 + 批量添加/单个剔除
// 复用现有选手档案检索能力，通过 api.js 和 permission.js
const api = require('../../utils/api.js')
const perm = require('../../utils/permission.js')
const modal = require('../../utils/modal.js')

Page({
  data: {
    eventId: '',            // 赛事ID
    event: null,            // 赛事详情
    loaded: false,          // 页面加载完成
    // 已报名人员列表
    signups: [],
    signupCount: 0,
    loadingSignups: false,
    // 选手检索
    searchKeyword: '',
    searchResults: [],
    searching: false,
    searched: false,       // 是否已执行过搜索
    // 已选择的选手
    selectedPlayers: {},   // { playerId: true }
    selectedCount: 0,
    // 操作状态
    loading: false,
    // 二次确认弹窗
    showRemoveConfirm: false,
    removeTarget: null,    // { signupId, playerName }
  },

  onLoad(options) {
    const eventId = options.eventId || ''
    if (!eventId) {
      wx.showToast({ title: '赛事ID缺失', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 1500)
      return
    }
    this.setData({ eventId })
    this.initPage()
  },

  async initPage() {
    try {
      // 校验管理员权限
      const role = await perm.getRole()
      if (role !== 'admin' && role !== 'super_admin') {
        wx.showToast({ title: '仅管理员可操作', icon: 'none' })
        setTimeout(() => wx.navigateBack(), 1500)
        return
      }

      // 加载赛事并校验状态
      await this.loadEvent()
      const event = this.data.event
      if (!event) {
        wx.showToast({ title: '赛事不存在', icon: 'none' })
        setTimeout(() => wx.navigateBack(), 1500)
        return
      }
      // 【BUG-P2修复】已归档或对战中/已结束的赛事禁止报名管理操作
      if (event.is_archived === 1) {
        wx.showToast({ title: '赛事已归档，不可管理报名', icon: 'none' })
        setTimeout(() => wx.navigateBack(), 1500)
        return
      }
      if (event.event_status >= 4) {
        wx.showToast({ title: '赛事已进入对战/结束阶段，不可管理报名', icon: 'none' })
        setTimeout(() => wx.navigateBack(), 1500)
        return
      }

      await this.loadSignups()
      this.setData({ loaded: true })
    } catch (e) {
      console.error('[报名管理] 初始化失败', e)
      this.setData({ loaded: true })
    }
  },

  // ====== 加载赛事 ======
  async loadEvent() {
    try {
      const res = await api.get('/events/' + this.data.eventId)
      if (res.success) {
        this.setData({ event: res.data })
      }
    } catch (e) { /* 静默降级 */ }
  },

  /** 手动刷新按钮 */
  async onRefreshTap() {
    wx.showLoading({ title: '刷新中...', mask: true })
    try {
      await this.loadSignups()
      if (this.data.searchResults.length > 0) {
        this.refreshSearchResults()
      }
      wx.showToast({ title: '已刷新', icon: 'success', duration: 1200 })
    } catch (e) {
      wx.showToast({ title: '刷新失败', icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },

  // ====== 加载已报名人员列表 ======
  async loadSignups() {
    this.setData({ loadingSignups: true })
    try {
      const res = await api.get('/events/' + this.data.eventId + '/signups', {
        status: 1,    // 仅加载有效报名
        pageSize: 500
      })
      if (res.success) {
        const list = res.data || []
        list.forEach(s => {
          s._typeLabel = s.signup_type === 1 ? '管理员添加' : '自主报名'
          s._typeClass = s.signup_type === 1 ? 'type-admin' : 'type-self'
        })
        this.setData({ signups: list, signupCount: list.length })
      }
    } catch (e) {
      console.error('[报名管理] 加载报名列表失败', e)
    } finally {
      this.setData({ loadingSignups: false })
    }
  },

  // ====== 选手模糊检索 ======
  onSearchInput(e) {
    this.setData({ searchKeyword: e.detail.value })
  },

  // 【核心】通过 wx_nickname 模糊搜索选手档案
  async doSearch() {
    const keyword = this.data.searchKeyword.trim()
    if (!keyword) {
      wx.showToast({ title: '请输入微信昵称', icon: 'none' })
      return
    }

    this.setData({ searching: true, searched: false })
    try {
      // 调用选手检索接口
      const res = await api.get('/search/players', { keyword, limit: 30 })
      this.setData({ searching: false, searched: true })

      if (res.success) {
        const results = res.data || []
        // 标记已报名的选手（防止重复添加）
        const signupPlayerIds = {}
        this.data.signups.forEach(s => { signupPlayerIds[String(s.player_id)] = true })

        results.forEach(p => {
          p._alreadySigned = !!signupPlayerIds[String(p.id)]
        })

        this.setData({
          searchResults: results,
          selectedPlayers: {},
          selectedCount: 0
        })

        if (results.length === 0) {
          wx.showToast({ title: '未找到匹配选手', icon: 'none' })
        }
      }
    } catch (e) {
      this.setData({ searching: false, searched: true })
      wx.showToast({ title: '搜索失败', icon: 'none' })
    }
  },

  // 搜索框回车确认
  onSearchConfirm() {
    this.doSearch()
  },

  // ====== 选择/取消选择选手 ======
  toggleSelect(e) {
    const playerId = String(e.currentTarget.dataset.id)
    const player = this.data.searchResults.find(p => String(p.id) === playerId)
    if (player && player._alreadySigned) {
      wx.showToast({ title: '该选手已报名', icon: 'none', duration: 1500 })
      return
    }

    const selected = { ...this.data.selectedPlayers }
    if (selected[playerId]) {
      delete selected[playerId]
    } else {
      selected[playerId] = true
    }
    this.setData({
      selectedPlayers: selected,
      selectedCount: Object.keys(selected).length
    })
  },

  // ====== 管理员批量添加报名 ======
  async doBatchAdd() {
    // 过滤掉已报名的选手（防御性检查）
    const players = this.data.searchResults
    const selectedIds = Object.keys(this.data.selectedPlayers).filter(id => {
      const p = players.find(pl => String(pl.id) === String(id))
      return p && !p._alreadySigned
    })
    if (selectedIds.length === 0) {
      wx.showToast({ title: '请先选择未报名选手', icon: 'none' })
      return
    }

    // 二次确认
    const names = selectedIds.map(id => {
      const p = players.find(pl => String(pl.id) === String(id))
      return p ? p.wx_nickname : id
    }).join('、')

    const confirmRes = await modal.confirm(this, {
      title: '批量添加报名',
      content: `确定添加以下 ${selectedIds.length} 名选手？\n\n${names}`
    })

    if (!confirmRes) return

    this.setData({ loading: true })
    try {
      const res = await api.post('/events/' + this.data.eventId + '/signups/batch', {
        playerIds: selectedIds
      })
      this.setData({ loading: false })

      if (res.success) {
        const result = res.data
        let msg = `成功添加 ${result.success} 人`
        if (result.skipped > 0) msg += `，${result.skipped} 人已有报名`
        if (result.failed > 0) msg += `，${result.failed} 人失败`
        wx.showToast({ title: msg, icon: 'none', duration: 2500 })

        // 清空选择 + 刷新列表
        this.setData({ selectedPlayers: {}, selectedCount: 0 })
        await this.loadSignups()
        // 重新标记搜索结果中已报名的
        this.refreshSearchResults()
      } else {
        wx.showToast({ title: res.error || '添加失败', icon: 'none' })
      }
    } catch (e) {
      this.setData({ loading: false })
      wx.showToast({ title: '添加失败，请重试', icon: 'none' })
    }
  },

  // 刷新搜索结果的已报名标记
  refreshSearchResults() {
    const signupPlayerIds = {}
    this.data.signups.forEach(s => { signupPlayerIds[String(s.player_id)] = true })
    const results = this.data.searchResults.map(p => ({
      ...p,
      _alreadySigned: !!signupPlayerIds[String(p.id)]
    }))
    // 清除已报名选手的选择
    const selected = { ...this.data.selectedPlayers }
    Object.keys(selected).forEach(id => {
      if (signupPlayerIds[String(id)]) delete selected[id]
    })
    this.setData({
      searchResults: results,
      selectedPlayers: selected,
      selectedCount: Object.keys(selected).length
    })
  },

  // ====== 单个剔除报名 ======
  showRemoveConfirm(e) {
    const signupId = e.currentTarget.dataset.signupId
    const player = this.data.signups.find(s => s.signup_id === signupId)
    if (!player) return

    this.setData({
      showRemoveConfirm: true,
      removeTarget: {
        signupId: signupId,
        playerName: player.wx_nickname || '未知选手',
        playerId: player.player_id
      }
    })
  },

  hideRemoveConfirm() {
    this.setData({ showRemoveConfirm: false, removeTarget: null })
  },

  // 【核心】管理员剔除报名（软删除 + 留痕）
  async doRemoveSignup() {
    if (!this.data.removeTarget) return
    const { signupId, playerName } = this.data.removeTarget
    this.setData({ showRemoveConfirm: false, loading: true })

    try {
      const res = await api.del('/events/' + this.data.eventId + '/signups/' + signupId)
      this.setData({ loading: false })

      if (res.success) {
        wx.showToast({ title: '已剔除 ' + playerName, icon: 'success' })
        await this.loadSignups()
        // 同步刷新搜索结果的标记
        if (this.data.searchResults.length > 0) {
          this.refreshSearchResults()
        }
      } else {
        wx.showToast({ title: res.error || '操作失败', icon: 'none' })
      }
    } catch (e) {
      this.setData({ loading: false })
      wx.showToast({ title: '操作失败，请重试', icon: 'none' })
    }
  },

  // ====== 分享 ======
  onShareAppMessage() {
    return {
      title: '赛事报名管理 - 蜀国争霸系统',
      path: '/pages/event-signup-manage/event-signup-manage?eventId=' + this.data.eventId
    }
  },

  preventMove() {},

  onPullDownRefresh() {
    this.loadSignups().then(() => wx.stopPullDownRefresh()).catch(() => wx.stopPullDownRefresh())
  }
})
