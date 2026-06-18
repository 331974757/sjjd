// pages/admin/admin.js
const perm = require('../../utils/permission.js')
const C = require('../../utils/constants.js')
const api = require('../../utils/api.js')
const PAGE_SIZE = C.PAGE_SIZE

Page({
  data: {
    isSuperAdmin: false,
    myOpenId: '',
    allUsers: [],
    users: [],          // 当前页数据
    keyword: '',
    currentPage: 1,     // 当前页码
    totalPages: 0,      // 总页数
    loading: true,
    _filteredTotal: 0,  // 筛选后总数
    _filtered: []       // 筛选后的全量列表（内存缓存）
  },

  async onLoad() {
    // 仅超级管理员可访问权限设置
    // 始终异步校验（避免缓存过期导致权限错误）
    const isSuper = await perm.isSuperAdmin()
    if (!isSuper) {
      wx.showToast({ title: '仅超级管理员可访问', icon: 'none' })
      setTimeout(() => { wx.navigateBack() }, 1500)
      return
    }
    this.setData({ isSuperAdmin: true })
    this.loadAll()
  },

  /** 手动刷新按钮 */
  async onRefreshTap() {
    wx.showLoading({ title: '刷新中...', mask: true })
    try {
      await this.loadAll()
      wx.showToast({ title: '已刷新', icon: 'success', duration: 1200 })
    } catch (e) {
      wx.showToast({ title: '刷新失败', icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },

  async loadAll() {
    this.setData({ loading: true })
    try {
      let openid = ''
      try {
        const app = getApp()
        openid = await app.getOpenId()
      } catch (e) {}

      wx.showLoading({ title: '加载用户列表...' })
      const res = await api.get('/users')
      wx.hideLoading()

      let rawUsers = (res && res.data) ? res.data : []
      rawUsers = rawUsers.map((u) => {
        return {
          _id: u._id,
          openid: u.openid,
          displayName: u.nickName || '未命名用户',
          role: u.role,
          nickName: u.nickName || '',
          isMe: u.openid === openid,
          createdAt: u.createdAt,
          nickChangeCount: u.nickChangeCount || 0
        }
      })

      this.setData({ myOpenId: openid || '', allUsers: rawUsers, loading: false })
      this.filterUsers()
    } catch (err) {
      wx.hideLoading()
      console.error('加载用户列表失败', err)
      this.setData({ loading: false })
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
  },

  // 搜索输入（防抖 300ms）
  onKeywordInput(e) {
    const value = e.detail.value.trim()
    if (this._searchTimer) clearTimeout(this._searchTimer)
    this._searchTimer = setTimeout(() => {
      this.setData({ keyword: value, currentPage: 1 })
      this.filterUsers()
    }, 300)
  },

  // 清除搜索关键词
  onClearKeyword() {
    if (this._searchTimer) clearTimeout(this._searchTimer)
    this.setData({ keyword: '', currentPage: 1 })
    this.filterUsers()
  },

  // 公共筛选方法：仅显示已改过昵称的用户
  _getFiltered() {
    let list = this.data.allUsers.filter(u => !!u.nickName)
    const kw = this.data.keyword.toLowerCase()
    if (kw) {
      list = list.filter(u => {
        return u.nickName.toLowerCase().indexOf(kw) !== -1
      })
    }
    return list
  },

  // 筛选 + 分页
  filterUsers() {
    const list = this._getFiltered()
    const totalPages = Math.ceil(list.length / PAGE_SIZE)
    // 确保当前页不超出范围
    let page = this.data.currentPage
    if (page > totalPages && totalPages > 0) page = totalPages
    if (page < 1) page = 1

    const start = (page - 1) * PAGE_SIZE
    this.setData({
      users: list.slice(start, start + PAGE_SIZE),
      currentPage: page,
      totalPages: totalPages,
      _filteredTotal: list.length,
      _filtered: list   // 缓存筛选后全量，分页按钮用
    })
  },

  // 上一页
  prevPage() {
    if (this.data.currentPage <= 1) return
    this.setData({ currentPage: this.data.currentPage - 1 })
    this.filterUsers()
  },

  // 下一页
  nextPage() {
    if (this.data.currentPage >= this.data.totalPages) return
    this.setData({ currentPage: this.data.currentPage + 1 })
    this.filterUsers()
  },

  // 切换权限（仅超级管理员可操作，ActionSheet 多选）
  toggleAdmin(e) {
    const openid = e.currentTarget.dataset.openid
    const role = e.currentTarget.dataset.role
    const isMe = e.currentTarget.dataset.isme
    const nickName = e.currentTarget.dataset.nickname

    if (isMe === true || isMe === 'true') {
      wx.showToast({ title: '不能操作自己', icon: 'none' })
      return
    }

    // 根据目标角色展示不同选项
    let itemList = []
    let actions = []

    if (role === 'super_admin') {
      itemList = ['取消超级管理员']
      actions = ['removeSuper']
    } else if (role === 'admin') {
      itemList = ['设为超级管理员', '取消管理员']
      actions = ['setSuper', 'removeAdmin']
    } else {
      itemList = ['设为超级管理员', '设为管理员']
      actions = ['setSuper', 'setAdmin']
    }

    wx.showActionSheet({
      itemList: itemList,
      success: (res) => {
        const action = actions[res.tapIndex]
        const name = nickName || '该用户'
        switch (action) {
          case 'setSuper':
            this._confirmAction('设为超级管理员', '确定将「' + name + '」设为超级管理员吗？\n\n超管拥有最高权限。', '#1a237e', '确认设置', () => { this.doSetSuperAdmin(openid) })
            break
          case 'removeSuper':
            this._confirmAction('取消超级管理员', '确定取消「' + name + '」的超级管理员权限吗？\n\n将降为普通用户。', '#e74c3c', '', () => { this.doRemoveSuperAdmin(openid) })
            break
          case 'setAdmin':
            this._confirmAction('设为管理员', '确定将「' + name + '」设为管理员吗？', '#27ae60', '', () => { this.doSetAdmin(openid) })
            break
          case 'removeAdmin':
            this._confirmAction('取消管理员', '确定取消「' + name + '」的管理员权限吗？', '#e74c3c', '', () => { this.doRemoveAdmin(openid) })
            break
        }
      }
    })
  },

  _confirmAction(title, content, confirmColor, confirmText, callback) {
    wx.showModal({
      title: title,
      content: content,
      confirmColor: confirmColor,
      confirmText: confirmText || '确认',
      success: (r) => { if (r.confirm) callback() }
    })
  },

  async doSetAdmin(openid) {
    wx.showLoading({ title: '设置中...' })
    try {
      const res = await api.put('/users/' + openid + '/role', { role: 'admin', operatorOpenid: this.data.myOpenId })
      wx.hideLoading()
      wx.showToast({ title: res.success ? '已设为管理员' : (res.message || '失败'), icon: res.success ? 'success' : 'none' })
      if (res.success) this.loadAll()
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: '操作失败', icon: 'none' })
    }
  },

  async doRemoveAdmin(openid) {
    wx.showLoading({ title: '操作中...' })
    try {
      const res = await api.put('/users/' + openid + '/role', { role: 'user', operatorOpenid: this.data.myOpenId })
      wx.hideLoading()
      wx.showToast({ title: res.success ? '已取消管理员' : (res.message || '失败'), icon: res.success ? 'success' : 'none' })
      if (res.success) this.loadAll()
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: '操作失败', icon: 'none' })
    }
  },

  async doSetSuperAdmin(openid) {
    wx.showLoading({ title: '设置中...' })
    try {
      const res = await api.put('/users/' + openid + '/role', { role: 'super_admin', operatorOpenid: this.data.myOpenId })
      wx.hideLoading()
      wx.showToast({ title: res.success ? '已设为超级管理员' : (res.message || '失败'), icon: res.success ? 'success' : 'none' })
      if (res.success) this.loadAll()
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: '操作失败', icon: 'none' })
    }
  },

  async doRemoveSuperAdmin(openid) {
    wx.showLoading({ title: '操作中...' })
    try {
      const res = await api.put('/users/' + openid + '/role', { role: 'user', operatorOpenid: this.data.myOpenId })
      wx.hideLoading()
      wx.showToast({ title: res.success ? '已取消超级管理员' : (res.message || '失败'), icon: res.success ? 'success' : 'none' })
      if (res.success) this.loadAll()
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: '操作失败', icon: 'none' })
    }
  },

  // 重置昵称修改次数（仅超级管理员可操作）
  resetNickCount(e) {
    const openid = e.currentTarget.dataset.openid
    const nickName = e.currentTarget.dataset.nickname
    wx.showModal({
      title: '重置修改次数',
      content: '确定重置「' + nickName + '」的昵称修改次数吗？重置后可再修改' + C.NICK_CHANGE_LIMIT + '次。',
      confirmText: '确定重置',
      success: (r) => {
        if (!r.confirm) return
        this.doResetNickCount(openid)
      }
    })
  },

  async doResetNickCount(openid) {
    wx.showLoading({ title: '重置中...' })
    try {
      const res = await api.put('/users/' + openid + '/reset-nickcount')
      wx.hideLoading()
      wx.showToast({ title: res.success ? '已重置' : (res.message || '失败'), icon: res.success ? 'success' : 'none' })
      if (res.success) this.loadAll()
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: '操作失败', icon: 'none' })
    }
  }
})
