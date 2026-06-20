/**
 * 首页模块 — 首页数据加载 + 用户权限管理
 */
const C = require('../../../utils/constants.js')
const api = require('../../../utils/api.js')
const modal = require('../../../utils/modal.js')

module.exports = {
  data: {
    // 首页用户管理（超管权限）
    homeAllUsers: [],
    homeUsers: [],
    homeKeyword: '',
    homePage: 1,
    homeTotalPages: 0,
    homeFilteredTotal: 0,
    homeFiltered: [],
    homeUsersLoading: false,
    homeOperating: false,
    // 首页模块数据
    homeIntro: [],
    homeAnnouncements: [],
    homeAnnounceText: '',
    eventDynamicList: [],
    homeGameList: [
      {
        id: 'dota2',
        name: 'Dota 2',
        icon: '🛡️',
        actions: [
          { key: 'players', icon: '👤', label: '选手档案', subTab: 'profile' },
          { key: 'rules',   icon: '📜', label: '赛事章程', subTab: 'rules' },
          { key: 'history', icon: '📋', label: '历史赛事', subTab: 'history' }
        ]
      }
    ],
    homeStats: {
      registeredPlayers: 0,
      totalEvents: 0,
      activeEvents: 0,
      finishedEvents: 0
    },
    homeLoadError: false,
    homeDataLoaded: false,
    showUserMgmtModal: false,
    myOpenId: '',
  },

  methods: {
    // ====== 首页 - 用户管理（超管权限管理） ======
    async homeLoadUsers() {
      if (this.data.homeUsersLoading) return
      this.setData({ homeUsersLoading: true })
      try {
        let openid = ''
        try { const app = getApp(); openid = await app.getOpenId() } catch (e) { console.warn('[home] 获取openid失败', e) }
        wx.showLoading({ title: '加载中...' })
        const res = await api.get('/users')
        wx.hideLoading()
        let raw = (res && res.data) ? res.data : []
        raw = raw.map(u => ({
          openid: u.openid,
          role: u.role,
          nickName: u.nickName || '',
          isMe: !!(openid && u.openid === openid),
          nickChangeCount: u.nickChangeCount || 0
        }))
        this.setData({ homeAllUsers: raw, homeUsersLoading: false, myOpenId: openid || '' })
        this.homeFilterUsers()
      } catch (err) {
        wx.hideLoading()
        console.error('[home] 加载用户失败', err)
        this.setData({ homeUsersLoading: false })
      }
    },

    homeRefreshUsers() { this.homeLoadUsers() },

    onHomeKeywordInput(e) {
      const value = e.detail.value.trim()
      if (this._homeSearchTimer) clearTimeout(this._homeSearchTimer)
      this._homeSearchTimer = setTimeout(() => {
        this.setData({ homeKeyword: value, homePage: 1 })
        this.homeFilterUsers()
      }, 300)
    },

    onHomeClearKeyword() {
      if (this._homeSearchTimer) clearTimeout(this._homeSearchTimer)
      this.setData({ homeKeyword: '', homePage: 1 })
      this.homeFilterUsers()
    },

    homeGetFiltered() {
      let list = this.data.homeAllUsers.filter(u => u.nickName)
      list = [...list].sort((a, b) => {
        if (a.role === 'super_admin' && b.role !== 'super_admin') return -1
        if (a.role !== 'super_admin' && b.role === 'super_admin') return 1
        if (a.role === 'admin' && b.role === 'user') return -1
        if (a.role === 'user' && b.role === 'admin') return 1
        return 0
      })
      const kw = this.data.homeKeyword.toLowerCase()
      if (kw) {
        list = list.filter(u =>
          (u.nickName || '').toLowerCase().indexOf(kw) !== -1 ||
          (u.openid || '').toLowerCase().indexOf(kw) !== -1
        )
      }
      return list
    },

    homeFilterUsers() {
      const list = this.homeGetFiltered()
      const totalPages = Math.ceil(list.length / this.data.pageSize)
      let page = this.data.homePage
      if (page > totalPages && totalPages > 0) page = totalPages
      if (page < 1) page = 1
      const start = (page - 1) * this.data.pageSize
      this.setData({
        homeUsers: list.slice(start, start + this.data.pageSize),
        homePage: page,
        homeTotalPages: totalPages,
        homeFilteredTotal: list.length,
        homeFiltered: list
      })
    },

    homePrevPage() {
      if (this.data.homePage <= 1) return
      this.setData({ homePage: this.data.homePage - 1 })
      this.homeFilterUsers()
    },

    homeNextPage() {
      if (this.data.homePage >= this.data.homeTotalPages) return
      this.setData({ homePage: this.data.homePage + 1 })
      this.homeFilterUsers()
    },

    async homeToggleAdmin(e) {
      if (this.data.homeOperating) return
      const openid = e.currentTarget.dataset.openid
      const role = e.currentTarget.dataset.role
      const isMe = e.currentTarget.dataset.isme
      const nickName = e.currentTarget.dataset.nickname
      if (isMe === true || isMe === 'true') { wx.showToast({ title: '不能操作自己', icon: 'none' }); return }
      let itemList = [], actions = []
      if (role === 'super_admin') { itemList = ['取消超级管理员']; actions = ['removeSuper'] }
      else if (role === 'admin') { itemList = ['设为超级管理员', '取消管理员']; actions = ['setSuper', 'removeAdmin'] }
      else { itemList = ['设为超级管理员', '设为管理员']; actions = ['setSuper', 'setAdmin'] }
      const res = await modal.sheet(this, { title: '选择操作', items: itemList.map(label => ({ label })) })
      if (!res.confirm) return
      const action = actions[res.tapIndex]
      const name = nickName || '该用户'
      let title, content, theme, callback
      switch (action) {
        case 'setSuper': title = '设为超级管理员'; content = '确定将「' + name + '」设为超级管理员吗？\n\n超管拥有最高权限。'; theme = 'default'; callback = () => this.homeDoSetRole(openid, 'super_admin', '设为超级管理员'); break
        case 'removeSuper': title = '取消超级管理员'; content = '确定取消「' + name + '」的超级管理员权限吗？\n\n将降为普通用户。'; theme = 'danger'; callback = () => this.homeDoSetRole(openid, 'user', '取消超级管理员'); break
        case 'setAdmin': title = '设为管理员'; content = '确定将「' + name + '」设为管理员吗？'; theme = 'success'; callback = () => this.homeDoSetRole(openid, 'admin', '设为管理员'); break
        case 'removeAdmin': title = '取消管理员'; content = '确定取消「' + name + '」的管理员权限吗？'; theme = 'danger'; callback = () => this.homeDoSetRole(openid, 'user', '取消管理员'); break
      }
      const r = await modal.confirm(this, { theme, title, content, confirmText: '确认' })
      if (r.confirm) callback()
    },

    async homeDoSetRole(openid, role, label) {
      this.setData({ homeOperating: true })
      wx.showLoading({ title: '设置中...' })
      try {
        const res = await api.put('/users/' + openid + '/role', { role })
        wx.hideLoading()
        wx.showToast({ title: res.success ? '已' + label : (res.message || '失败'), icon: res.success ? 'success' : 'none' })
        if (res.success) this.homeLoadUsers()
      } catch (e) {
        wx.hideLoading(); wx.showToast({ title: '操作失败', icon: 'none' })
      } finally {
        this.setData({ homeOperating: false })
      }
    },

    async homeResetNickCount(e) {
      if (this.data.homeOperating) return
      const openid = e.currentTarget.dataset.openid
      const nickName = e.currentTarget.dataset.nickname
      const r = await modal.confirm(this, { theme: 'danger', title: '重置修改次数', content: '确定重置「' + nickName + '」的昵称修改次数吗？重置后可再修改' + C.NICK_CHANGE_LIMIT + '次。', confirmText: '确定重置' })
      if (!r.confirm) return
      this.setData({ homeOperating: true })
      wx.showLoading({ title: '重置中...' })
      try {
        const res = await api.put('/users/' + openid + '/reset-nickcount')
        wx.hideLoading()
        wx.showToast({ title: res.success ? '已重置' : (res.message || '失败'), icon: res.success ? 'success' : 'none' })
        if (res.success) this.homeLoadUsers()
      } catch (e) {
        wx.hideLoading(); wx.showToast({ title: '操作失败', icon: 'none' })
      } finally {
        this.setData({ homeOperating: false })
      }
    },

    // ====== 【首页】模块数据加载 ======
    async loadHomeData(force = false) {
      if (this._loadingHomeData) return
      if (!force && this.data.homeDataLoaded) return
      this._loadingHomeData = true
      try {
        const [introRes, annRes, dynRes, statsRes] = await Promise.all([
          api.get('/home/intro').catch(() => ({ success: false })),
          api.get('/announcements').catch(() => ({ success: false, data: [] })),
          api.get('/events/dynamic', { limit: 8 }).catch(() => ({ success: false, data: [] })),
          api.get('/stats/platform').catch(() => ({ success: false, data: {} }))
        ])
        this.setData({
          homeIntro: (introRes && introRes.success && introRes.data) ? introRes.data : [],
          homeAnnouncements: (annRes && annRes.success) ? (annRes.data || []) : [],
          homeAnnounceText: (annRes && annRes.success && annRes.data)
            ? annRes.data.map(function(a, i) { return (a.is_pinned ? '📌' : '') + a.content; }).join('　　|　　')
            : '',
          marqueeOffset: 0,
          eventDynamicList: (dynRes && dynRes.success) ? (dynRes.data || []) : [],
          homeStats: (statsRes && statsRes.success) ? Object.assign({
            registeredPlayers: 0, totalEvents: 0, activeEvents: 0, finishedEvents: 0
          }, statsRes.data) : { registeredPlayers: 0, totalEvents: 0, activeEvents: 0, finishedEvents: 0 },
          homeDataLoaded: true,
          homeLoadError: false
        })
        this.startMarquee()
      } catch (e) {
        console.error('[home] 加载首页数据失败', e)
        this.setData({ homeLoadError: true, homeDataLoaded: true })
      } finally {
        this._loadingHomeData = false
      }
    },

    async refreshHomeData() {
      this.setData({ homeDataLoaded: false })
      await this.loadHomeData()
      wx.showToast({ title: '已刷新', icon: 'success', duration: 1000 })
    },

    // ====== 首页跳转方法 ======
    goEditIntro() {
      wx.navigateTo({ url: '/pages/home-edit/home-edit' })
    },

    goManageAnnounce() {
      wx.navigateTo({ url: '/pages/announce-manage/announce-manage' })
    },

    showUserMgmtModal() {
      this.setData({ showUserMgmtModal: true })
      this.homeLoadUsers()
    },

    closeUserMgmtModal() {
      this.setData({ showUserMgmtModal: false })
    },

    homeJumpToGame(e) {
      const subTab = e.currentTarget.dataset.subtab
      this.setData({ currentGame: 'dota2', subTab: subTab })
      if (subTab === 'profile' && !this.data.loaded) {
        this.loadAllPlayers()
      } else if (subTab === 'rules' && !this.data.rulesLoaded) {
        this.loadRuleEvents()
      } else if (subTab === 'history' && !this.data.eventsLoaded) {
        this.loadEvents()
      }
    }
  }
}
