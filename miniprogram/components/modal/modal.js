/**
 * 通用美化弹窗组件 - 多主题
 * 
 * 主题: default(蓝紫) / danger(红/删除) / success(绿/完成) / warning(橙/警告)
 * 
 * 用法：
 *   const modal = this.selectComponent('#modal')
 *   modal.show({ type: 'confirm', theme: 'danger', title: '确认删除', content: '...' })
 */
Component({
  data: {
    visible: false,
    type: 'confirm',
    theme: 'default',
    title: '',
    content: '',
    showCancel: true,
    showConfirm: true,
    cancelText: '取消',
    confirmText: '确认',
    items: [],
    _resolve: null
  },

  methods: {
    show(opts) {
      const {
        type = 'confirm',
        theme = 'default',
        title = '',
        content = '',
        showCancel = true,
        showConfirm = true,
        cancelText = '取消',
        confirmText = '确认',
        confirmColor = '',
        items = []
      } = opts

      // confirmColor 自动映射到 theme
      let resolvedTheme = theme
      if (!theme || theme === 'default') {
        if (confirmColor === '#da3633' || confirmColor === '#f85149' || confirmColor === '#e74c3c') {
          resolvedTheme = 'danger'
        } else if (confirmColor === '#27ae60' || confirmColor === '#3fb950') {
          resolvedTheme = 'success'
        }
      }

      return new Promise((resolve) => {
        this.setData({
          visible: true,
          _showClass: 'modal-show',
          type,
          theme: resolvedTheme,
          title,
          content,
          showCancel,
          showConfirm,
          cancelText,
          confirmText,
          items,
          _resolve: resolve
        })
      })
    },

    onConfirm() {
      const resolve = this.data._resolve
      this.setData({ visible: false, _showClass: '', _resolve: null })
      if (resolve) resolve({ confirm: true })
    },

    onCancel() {
      const resolve = this.data._resolve
      this.setData({ visible: false, _showClass: '', _resolve: null })
      if (resolve) resolve({ confirm: false })
    },

    onSelect(e) {
      const index = e.currentTarget.dataset.index
      const resolve = this.data._resolve
      this.setData({ visible: false, _showClass: '', _resolve: null })
      if (resolve) resolve({ confirm: true, tapIndex: index })
    },

    preventTouchMove() {}
  }
})
