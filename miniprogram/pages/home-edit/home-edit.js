/**
 * pages/home-edit/home-edit.js
 * 首页介绍编辑页（仅 super_admin 可访问）
 * 
 * 权限校验：非超管直接展示「无权限」提示
 * 功能：富文本+图片编辑，保存后实时生效
 */
const perm = require('../../utils/permission.js')
const api = require('../../utils/api.js')
const modal = require('../../utils/modal.js')

Page({
  data: {
    loading: true,
    isSuperAdmin: false,
    blocks: [],        // [{ type:'text'|'image', content?/url? }]
    saving: false
  },

  async onLoad() {
    wx.showLoading({ title: '加载中...' })
    try {
      // 1. 权限校验
      const role = await perm.getRole()
      const isSuperAdmin = role === 'super_admin'
      this.setData({ isSuperAdmin })
      if (!isSuperAdmin) {
        wx.hideLoading()
        this.setData({ loading: false })
        return
      }
      // 2. 加载现有内容
      const res = await api.get('/home/intro')
      wx.hideLoading()
      if (res.success && res.data && Array.isArray(res.data)) {
        this.setData({ blocks: res.data, loading: false })
      } else {
        this.setData({ loading: false })
      }
    } catch (e) {
      wx.hideLoading()
      console.error('[home-edit] 加载失败', e)
      this.setData({ loading: false })
    }
  },

  /** 添加文字区块 */
  addTextBlock() {
    const blocks = [...this.data.blocks, { type: 'text', content: '' }]
    this.setData({ blocks })
  },

  /** 添加图片区块 */
  addImageBlock() {
    const blocks = [...this.data.blocks, { type: 'image', url: '' }]
    this.setData({ blocks })
  },

  /** 删除指定区块 */
  deleteBlock(e) {
    const index = e.currentTarget.dataset.index
    const blocks = [...this.data.blocks]
    blocks.splice(index, 1)
    this.setData({ blocks })
  },

  /** 上移区块 */
  moveBlockUp(e) {
    const index = e.currentTarget.dataset.index
    if (index <= 0) return
    const blocks = [...this.data.blocks]
    const tmp = blocks[index - 1]
    blocks[index - 1] = blocks[index]
    blocks[index] = tmp
    this.setData({ blocks })
  },

  /** 下移区块 */
  moveBlockDown(e) {
    const index = e.currentTarget.dataset.index
    const blocks = [...this.data.blocks]
    if (index >= blocks.length - 1) return
    const tmp = blocks[index + 1]
    blocks[index + 1] = blocks[index]
    blocks[index] = tmp
    this.setData({ blocks })
  },

  /** 文字输入事件 */
  onTextInput(e) {
    const index = e.currentTarget.dataset.index
    const value = e.detail.value
    const blocks = [...this.data.blocks]
    if (blocks[index] && blocks[index].type === 'text') {
      blocks[index].content = value
    }
    this.setData({ blocks })
  },

  /** 上传图片 */
  uploadImage(e) {
    const index = e.currentTarget.dataset.index
    wx.chooseImage({
      count: 1,
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const tempFilePath = res.tempFilePaths[0]
        wx.showLoading({ title: '上传中...' })
        wx.uploadFile({
          url: api.API_BASE + '/upload',
          filePath: tempFilePath,
          name: 'file',
          header: api.getUploadHeaders(),
          success: (uploadRes) => {
            wx.hideLoading()
            try {
              const data = JSON.parse(uploadRes.data)
              if (data.success && data.data && data.data.url) {
                const blocks = [...this.data.blocks]
                if (blocks[index] && blocks[index].type === 'image') {
                  blocks[index].url = api.BASE_URL + data.data.url
                }
                this.setData({ blocks })
                modal.toast(this, { title: '上传成功', icon: 'success' })
              } else {
                modal.toast(this, { title: data.error || data.message || '上传失败', icon: 'none' })
              }
            } catch (e) {
              modal.toast(this, { title: '上传异常', icon: 'none' })
            }
          },
          fail: () => {
            wx.hideLoading()
            modal.toast(this, { title: '上传失败', icon: 'none' })
          }
        })
      }
    })
  },

  /** 保存 */
  async onSave() {
    if (this.data.saving) return
    // 过滤空文本块
    const blocks = this.data.blocks.filter(b => {
      if (b.type === 'text') return (b.content || '').trim().length > 0
      if (b.type === 'image') return (b.url || '').length > 0
      return true
    })
    this.setData({ saving: true })
    wx.showLoading({ title: '保存中...' })
    try {
      const res = await api.put('/home/intro', { content: blocks })
      wx.hideLoading()
      if (res.success) {
        modal.toast(this, { title: '保存成功', icon: 'success' })
        // 通知首页强制刷新
        const pages = getCurrentPages()
        const homePage = pages.find(p => p.route === 'pages/index/index')
        if (homePage) {
          homePage._lastHomeLoad = 0
          if (typeof homePage.loadHomeData === 'function') {
            homePage.loadHomeData(true)
          }
        }
        setTimeout(() => { wx.navigateBack() }, 800)
      } else {
        modal.toast(this, { title: res.error || res.message || '保存失败', icon: 'none' })
      }
    } catch (e) {
      wx.hideLoading()
      modal.toast(this, { title: '保存失败', icon: 'none' })
    } finally {
      this.setData({ saving: false })
    }
  },

  /** 取消 */
  async onCancel() {
    // 检查是否有未保存内容
    const hasContent = this.data.blocks.some(b => {
      if (b.type === 'text') return (b.content || '').trim().length > 0
      if (b.type === 'image') return (b.url || '').length > 0
      return false
    })
    if (hasContent) {
      const r = await modal.confirm(this, {
        theme: 'warning', title: '放弃编辑',
        content: '当前内容尚未保存，确定要取消吗？',
        confirmText: '确定放弃'
      })
      if (!r.confirm) return
    }
    wx.navigateBack()
  }
})
