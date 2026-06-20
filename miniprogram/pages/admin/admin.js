// pages/admin/admin.js
const perm = require('../../utils/permission.js')
const C = require('../../utils/constants.js')
const api = require('../../utils/api.js')
const modal = require('../../utils/modal.js')
const PAGE_SIZE = C.PAGE_SIZE

Page({
  data: {
    isSuperAdmin: false,
    myOpenId: '',
    users: [],          // 当前页数据
    keyword: '',
    currentPage: 1,     // 当前页码
    totalPages: 0,      // 总页数
    total: 0,           // 服务端返回的总记录数
    loading: true,
    _operating: false   // 操作锁（防止重复提交）
  },

  async onLoad() {
    // 仅超级管理员可访问权限设置
    const isSuper = await perm.isSuperAdmin()
    if (!isSuper) {
      wx.showToast({ title: '仅超级管理员可访问', icon: 'none' })
      setTimeout(() => { wx.navigateBack() }, 1500)
      return
    }
    this.setData({ isSuperAdmin: true })
    this.loadPage()
  },

  onShow() {
    if (this.data.isSuperAdmin) {
      this.loadPage()
    }
  },

  onUnload() {
    if (this._searchTimer) {
      clearTimeout(this._searchTimer)
      this._searchTimer = null
    }
  },

  /** 手动刷新按钮 */
  async onRefreshTap() {
    if (this.data.loading) return
    wx.showLoading({ title: '刷新中...', mask: true })
    try {
      await this.loadPage()
      wx.showToast({ title: '已刷新', icon: 'success', duration: 1200 })
    } catch (e) {
      wx.showToast({ title: '刷新失败', icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },

  /** 服务端分页加载（含并发保护） */
  async loadPage() {
    if (this._loadingPromise) return this._loadingPromise

    this.setData({ loading: true })
    this._loadingPromise = (async () => {
      try {
        let openid = ''
        try {
          const app = getApp()
          openid = await app.getOpenId()
        } catch (e) {
          console.warn('[admin] 获取openid失败', e)
        }

        const params = {
          page: this.data.currentPage,
          pageSize: PAGE_SIZE
        }
        if (this.data.keyword) params.keyword = this.data.keyword

        const res = await api.get('/users', params)

        const rawUsers = (res && Array.isArray(res.data) ? res.data : [])
          .map(u => ({
            _id: u._id,
            openid: u.openid,
            role: u.role,
            nickName: u.nickName || '',
            isMe: !!(openid && u.openid === openid),
            nickChangeCount: u.nickChangeCount || 0
          }))

        this.setData({
          myOpenId: openid || '',
          users: rawUsers,
          total: res.total || 0,
          totalPages: res.totalPages || 0,
          loading: false
        })
      } catch (err) {
        console.error('加载用户列表失败', err)
        this.setData({ loading: false })
        wx.showToast({ title: '加载失败', icon: 'none' })
      } finally {
        this._loadingPromise = null
      }
    })()

    return this._loadingPromise
  },

  // 搜索输入（防抖 300ms）
  onKeywordInput(e) {
    const value = e.detail.value.trim()
    if (this._searchTimer) clearTimeout(this._searchTimer)
    this._searchTimer = setTimeout(() => {
      this.setData({ keyword: value, currentPage: 1 })
      this.loadPage()
    }, 300)
  },

  // 清除搜索关键词
  onClearKeyword() {
    if (this._searchTimer) clearTimeout(this._searchTimer)
    this.setData({ keyword: '', currentPage: 1 })
    this.loadPage()
  },

  // 上一页
  prevPage() {
    if (this.data.currentPage <= 1) return
    this.setData({ currentPage: this.data.currentPage - 1 })
    this.loadPage()
  },

  // 下一页
  nextPage() {
    if (this.data.currentPage >= this.data.totalPages) return
    this.setData({ currentPage: this.data.currentPage + 1 })
    this.loadPage()
  },

  // 切换权限（仅超级管理员可操作，ActionSheet 多选）
  async toggleAdmin(e) {
    if (this.data._operating) return
    const openid = e.currentTarget.dataset.openid
    const role = e.currentTarget.dataset.role
    const isMe = e.currentTarget.dataset.isme
    const nickName = e.currentTarget.dataset.nickname

    if (isMe === true || isMe === 'true') {
      wx.showToast({ title: '不能操作自己', icon: 'none' })
      return
    }

    // 提前加锁，防止在弹窗期间重复点击
    this.setData({ _operating: true })

    try {
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

      const res = await modal.sheet(this, { title: '选择操作', items: itemList.map(label => ({ label })) })
      if (!res.confirm) return

      // 边界检查 tapIndex
      const tapIndex = res.tapIndex
      if (tapIndex === undefined || tapIndex < 0 || tapIndex >= actions.length) {
        return
      }
      const action = actions[tapIndex]
      const name = nickName || '该用户'
      switch (action) {
        case 'setSuper':
          await this._confirmAction('设为超级管理员', '确定将「' + name + '」设为超级管理员吗？\n\n超管拥有最高权限。', 'default', '确认设置', () => { this.doSetSuperAdmin(openid) })
          break
        case 'removeSuper':
          await this._confirmAction('取消超级管理员', '确定取消「' + name + '」的超级管理员权限吗？\n\n将降为普通用户。', 'danger', '', () => { this.doRemoveSuperAdmin(openid) })
          break
        case 'setAdmin':
          await this._confirmAction('设为管理员', '确定将「' + name + '」设为管理员吗？', 'success', '', () => { this.doSetAdmin(openid) })
          break
        case 'removeAdmin':
          await this._confirmAction('取消管理员', '确定取消「' + name + '」的管理员权限吗？', 'danger', '', () => { this.doRemoveAdmin(openid) })
          break
      }
    } finally {
      this.setData({ _operating: false })
    }
  },

  async _confirmAction(title, content, theme, confirmText, callback) {
    const r = await modal.confirm(this, { theme, title, content, confirmText: confirmText || '确认' })
    if (r.confirm) await callback()
  },

  // 【重构】统一角色修改方法，消除4个方法的重复代码
  async _doSetRole(openid, role, label) {
    wx.showLoading({ title: '设置中...' })
    try {
      const res = await api.put('/users/' + openid + '/role', { role: role, operatorOpenid: this.data.myOpenId })
      wx.hideLoading()
      const text = res.success ? '已' + label : (res.error || res.message || '失败')
      wx.showToast({ title: text, icon: res.success ? 'success' : 'none' })
      if (res.success) {
        // 权限变更后清除本地角色缓存，确保其他页面的权限判断能立即生效
        perm.clearCache()
        this.loadPage()
      }
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: '操作失败', icon: 'none' })
    }
  },

  doSetAdmin(openid) { return this._doSetRole(openid, 'admin', '设为管理员') },
  doRemoveAdmin(openid) { return this._doSetRole(openid, 'user', '取消管理员') },
  doSetSuperAdmin(openid) { return this._doSetRole(openid, 'super_admin', '设为超级管理员') },
  doRemoveSuperAdmin(openid) { return this._doSetRole(openid, 'user', '取消超级管理员') },

  // 重置昵称修改次数（仅超级管理员可操作）
  async resetNickCount(e) {
    if (this.data._operating) return
    const openid = e.currentTarget.dataset.openid
    const nickName = e.currentTarget.dataset.nickname

    // 提前加锁
    this.setData({ _operating: true })
    try {
      const r = await modal.confirm(this, {
        theme: 'danger',
        title: '重置修改次数',
        content: '确定重置「' + nickName + '」的昵称修改次数吗？重置后可再修改' + C.NICK_CHANGE_LIMIT + '次。',
        confirmText: '确定重置'
      })
      if (!r.confirm) return
      await this.doResetNickCount(openid)
    } finally {
      this.setData({ _operating: false })
    }
  },

  async doResetNickCount(openid) {
    wx.showLoading({ title: '重置中...' })
    try {
      const res = await api.put('/users/' + openid + '/reset-nickcount')
      wx.hideLoading()
      wx.showToast({ title: res.success ? '已重置' : (res.error || res.message || '失败'), icon: res.success ? 'success' : 'none' })
      if (res.success) this.loadPage()
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: '操作失败', icon: 'none' })
    }
  }
})
