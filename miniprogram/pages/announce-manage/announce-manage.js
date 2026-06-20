/**
 * pages/announce-manage/announce-manage.js
 * 公告管理页（仅 super_admin 可访问）
 * 
 * 功能：公告列表、新增、编辑、删除、置顶/取消置顶
 * 权限：仅超管可进入，其他角色展示拦截提示
 */
const perm = require('../../utils/permission.js')
const api = require('../../utils/api.js')
const modal = require('../../utils/modal.js')

Page({
  data: {
    loading: true,
    isSuperAdmin: false,
    announcements: [],       // 公告列表
    // 弹窗
    showModal: false,
    editingId: null,
    modalContent: '',
    operating: false
  },

  async onLoad() {
    wx.showLoading({ title: '加载中...' })
    try {
      const role = await perm.getRole()
      const isSuperAdmin = role === 'super_admin'
      this.setData({ isSuperAdmin })
      if (!isSuperAdmin) {
        wx.hideLoading()
        this.setData({ loading: false })
        return
      }
      await this.loadList()
      wx.hideLoading()
    } catch (e) {
      wx.hideLoading()
      console.error('[announce] 加载失败', e)
      this.setData({ loading: false })
    }
  },

  /** 加载公告列表 */
  async loadList() {
    try {
      const res = await api.get('/announcements')
      this.setData({
        announcements: (res && res.success) ? (res.data || []) : [],
        loading: false
      })
    } catch (e) {
      console.error('[announce] 加载列表失败', e)
      this.setData({ loading: false })
    }
  },

  /** 新增公告 */
  onAdd() {
    this.setData({ showModal: true, editingId: null, modalContent: '' })
  },

  /** 编辑公告 */
  onEdit(e) {
    const id = e.currentTarget.dataset.id
    const content = e.currentTarget.dataset.content || ''
    this.setData({ showModal: true, editingId: id, modalContent: content })
  },

  /** 弹窗输入 */
  onModalInput(e) {
    this.setData({ modalContent: e.detail.value })
  },

  /** 阻止弹窗背景滚动 */
  preventMove() {},

  /** 关闭弹窗 */
  closeModal() {
    if (this.data.operating) return
    this.setData({ showModal: false, editingId: null, modalContent: '' })
  },

  /** 确认新增/编辑 */
  async onConfirmModal() {
    if (this.data.operating) return
    const content = (this.data.modalContent || '').trim()
    if (!content) {
      wx.showToast({ title: '请输入公告内容', icon: 'none' })
      return
    }
    this.setData({ operating: true })
    wx.showLoading({ title: '操作中...' })
    try {
      let res
      if (this.data.editingId) {
        // 编辑
        res = await api.put('/announcements/' + this.data.editingId, { content })
      } else {
        // 新增
        res = await api.post('/announcements', { content, isPinned: false })
      }
      wx.hideLoading()
      if (res.success) {
        wx.showToast({ title: this.data.editingId ? '已修改' : '已新增', icon: 'success' })
        this.setData({ showModal: false, editingId: null, modalContent: '' })
        await this.loadList()
      } else {
        wx.showToast({ title: res.message || '操作失败', icon: 'none' })
      }
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: '操作失败', icon: 'none' })
    } finally {
      this.setData({ operating: false })
    }
  },

  /** 删除公告 */
  async onDelete(e) {
    const id = e.currentTarget.dataset.id
    const content = e.currentTarget.dataset.content || ''
    const r = await modal.confirm(this, {
      theme: 'danger',
      title: '删除公告',
      content: '确定删除该公告吗？\n\n「' + (content.length > 30 ? content.substring(0, 30) + '...' : content) + '」',
      confirmText: '确认删除'
    })
    if (!r.confirm) return
    wx.showLoading({ title: '删除中...' })
    try {
      const res = await api.del('/announcements/' + id)
      wx.hideLoading()
      if (res.success) {
        wx.showToast({ title: '已删除', icon: 'success' })
        await this.loadList()
      } else {
        wx.showToast({ title: res.message || '删除失败', icon: 'none' })
      }
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: '删除失败', icon: 'none' })
    }
  },

  /** 切换置顶 */
  async onTogglePin(e) {
    const id = e.currentTarget.dataset.id
    const pinned = e.currentTarget.dataset.pinned
    const newPinned = !pinned
    wx.showLoading({ title: '操作中...' })
    try {
      const res = await api.put('/announcements/' + id + '/pin', { isPinned: newPinned })
      wx.hideLoading()
      if (res.success) {
        wx.showToast({ title: newPinned ? '已置顶' : '已取消置顶', icon: 'success' })
        await this.loadList()
      } else {
        wx.showToast({ title: res.message || '操作失败', icon: 'none' })
      }
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: '操作失败', icon: 'none' })
    }
  }
})
