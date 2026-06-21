/**
 * 首页模块 — 首页数据加载 + 用户权限管理
 */
const C = require('../../../utils/constants.js')
const api = require('../../../utils/api.js')
const modal = require('../../../utils/modal.js')

module.exports = {
  data: {
    // 分页（与选手模块共用 C.PAGE_SIZE）
    pageSize: C.PAGE_SIZE,
    // 首页用户管理（超管权限）
    homeAllUsers: [],
    homeUsers: [],
    homePageSize: 10,
    homeKeyword: '',
    homePage: 1,
    homeTotalPages: 0,
    homeFilteredTotal: 0,
    homeFiltered: [],
    homeUsersLoading: false,
    homeOperating: false,
    homeAllSuperCount: 0,
    homeAllAdminCount: 0,
    homeAllUserCount: 0,
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
    pageLocked: false,
    myOpenId: '',
    // 公告编辑弹窗
    showAnnounceModal: false,
    annEditId: '',
    annEditContent: '',
    annOperating: false,
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
          createdAt: u.createdAt || '',
          isMe: !!(openid && u.openid === openid),
          nickChangeCount: u.nickChangeCount || 0
        }))
        const namedUsers = raw.filter(u => u.nickName)
        const superCount = namedUsers.filter(u => u.role === 'super_admin').length
        const adminCount = namedUsers.filter(u => u.role === 'admin').length
        const userCount = namedUsers.filter(u => u.role === 'user').length
        this.setData({
          homeAllUsers: raw,
          homeAllSuperCount: superCount,
          homeAllAdminCount: adminCount,
          homeAllUserCount: userCount,
          homeUsersLoading: false,
          myOpenId: openid || ''
        })
        this.homeFilterUsers()
      } catch (err) {
        wx.hideLoading()
        console.error('[home] 加载用户失败', err)
        this.setData({ homeUsersLoading: false })
      }
    },

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
      // 角色优先级：super_admin > admin > user，同角色按创建时间倒序
      const roleOrder = { super_admin: 0, admin: 1, user: 2 }
      list.sort((a, b) => {
        const roleDiff = (roleOrder[a.role] ?? 99) - (roleOrder[b.role] ?? 99)
        if (roleDiff !== 0) return roleDiff
        const ta = new Date(a.createdAt).getTime() || 0
        const tb = new Date(b.createdAt).getTime() || 0
        return tb - ta
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
      const pageSize = this.data.homePageSize
      const totalPages = Math.ceil(list.length / pageSize)
      let page = this.data.homePage
      if (page > totalPages && totalPages > 0) page = totalPages
      if (page < 1) page = 1
      const start = (page - 1) * pageSize
      this.setData({
        homeUsers: list.slice(start, start + pageSize),
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
      if (isMe === true || isMe === 'true') { modal.toast(this, { theme: 'warning', content: '不能操作自己' }); return }
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
        modal.toast(this, { theme: res.success ? 'success' : 'danger', content: res.success ? '已' + label : (res.error || res.message || '失败') })
        if (res.success) { perm.clearCache(); this.homeLoadUsers() }
      } catch (e) {
        wx.hideLoading()
        modal.toast(this, { theme: 'danger', content: '操作失败' })
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
        modal.toast(this, { theme: res.success ? 'success' : 'danger', content: res.success ? '已重置' : (res.error || res.message || '失败') })
        if (res.success) this.homeLoadUsers()
      } catch (e) {
        wx.hideLoading()
        modal.toast(this, { theme: 'danger', content: '操作失败' })
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
          api.get('/events/dynamic', { limit: 5 }).catch(() => ({ success: false, data: [] })),
          api.get('/stats/platform').catch(() => ({ success: false, data: {} }))
        ])
        this.setData({
          homeIntro: (introRes && introRes.success && introRes.data) ? introRes.data : [],
          homeAnnouncements: (annRes && annRes.success) ? (annRes.data || []) : [],
          homeAnnounceText: (annRes && annRes.success && annRes.data)
            ? annRes.data.map(function(a, i) { return (a.is_pinned ? '📌' : '') + a.content; }).join('　　|　　')
            : '',
          eventDynamicList: (dynRes && dynRes.success) ? (dynRes.data || []).map(e => ({
            id: e.id,
            event_name: e.event_name,
            status: e.status,
            event_time: e.event_time,
            signup_count: e.signup_count || 0
          })) : [],
          homeStats: (statsRes && statsRes.success) ? Object.assign({
            registeredPlayers: 0, totalEvents: 0, activeEvents: 0, finishedEvents: 0
          }, statsRes.data) : { registeredPlayers: 0, totalEvents: 0, activeEvents: 0, finishedEvents: 0 },
          homeDataLoaded: true,
          homeLoadError: false
        })
      } catch (e) {
        console.error('[home] 加载首页数据失败', e)
        this.setData({ homeLoadError: true, homeDataLoaded: true })
      } finally {
        this._loadingHomeData = false
      }
    },

    // ====== 首页跳转方法 ======
    goEditIntro() {
      wx.navigateTo({ url: '/pages/home-edit/home-edit' })
    },

    goManageAnnounce() {
      this.setData({ showAnnounceModal: true })
      this._lockPage()
      this.loadAnnounceForEdit()
    },

    showUserMgmtModal() {
      this.setData({ showUserMgmtModal: true })
      this._lockPage()
      this.homeLoadUsers()
    },

    closeUserMgmtModal() {
      this.setData({ showUserMgmtModal: false })
      this._unlockPage()
    },

    // ====== 公告编辑弹窗方法 ======
    async loadAnnounceForEdit() {
      wx.showLoading({ title: '加载中...' })
      try {
        const res = await api.get('/announcements')
        wx.hideLoading()
        const list = (res && res.success) ? (res.data || []) : []
        // 只取最新一条
        const latest = list[0]
        if (latest) {
          this.setData({ annEditId: latest.id, annEditContent: latest.content || '' })
        }
      } catch (e) {
        wx.hideLoading()
        console.error('[home] 加载公告失败', e)
      }
    },

    /** 输入变更 */
    annOnInput(e) {
      this.setData({ annEditContent: e.detail.value })
    },

    /** 关闭弹窗 */
    annCloseModal() {
      if (this.data.annOperating) return
      this.setData({ showAnnounceModal: false })
      this._unlockPage()
    },

    /** 保存 */
    async annOnSave() {
      if (this.data.annOperating) return
      const content = (this.data.annEditContent || '').trim()
      if (!content) {
        modal.toast(this, { theme: 'warning', content: '请输入公告内容' })
        return
      }
      this.setData({ annOperating: true })
      wx.showLoading({ title: '保存中...' })
      try {
        const res = this.data.annEditId
          ? await api.put('/announcements/' + this.data.annEditId, { content })
          : await api.post('/announcements', { content })
        wx.hideLoading()
        if (res && res.success) {
          modal.toast(this, { theme: 'success', content: '已保存' })
          this.setData({ showAnnounceModal: false })
          this._unlockPage()
          await this.loadHomeData(true)
        } else {
          modal.toast(this, { theme: 'danger', content: res.error || res.message || '保存失败' })
        }
      } catch (e) {
        wx.hideLoading()
        modal.toast(this, { theme: 'danger', content: '保存失败' })
      } finally {
        this.setData({ annOperating: false })
      }
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
