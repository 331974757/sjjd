/**
 * 美化弹窗工具 - 多主题 + Toast
 *
 * 主题说明:
 *   'default' - 蓝紫渐变（通用确认）
 *   'danger'  - 红色（删除/清空/不可逆操作）
 *   'success' - 绿色（操作完成/成功通知）
 *   'warning' - 橙色（权限不足/状态不对/需注意）
 * 
 * 用法：
 *   const modal = require('../../utils/modal.js')
 *   const r = await modal.confirm(ctx, { theme: 'danger', title: '删除', content: '确定删除？' })
 *   if (r.confirm) { ... }
 *   modal.toast(ctx, { theme: 'success', content: '操作成功' })
 */

/** 安全获取 modal 组件，未注册时降级到系统弹窗 */
function getModalSafe(ctx) {
  try {
    const m = ctx.selectComponent('#modal')
    if (m && typeof m.show === 'function') return m
  } catch (_) {}
  return null
}

function confirm(ctx, opts = {}) {
  const m = getModalSafe(ctx)
  if (m) return m.show({ type: 'confirm', ...opts })
  // 降级：使用系统原生弹窗
  return new Promise((resolve) => {
    wx.showModal({
      title: opts.title || '提示',
      content: opts.content || '',
      confirmColor: '#5865f2',
      success: (res) => resolve({ confirm: res.confirm }),
      fail: () => resolve({ confirm: false })
    })
  })
}

function sheet(ctx, opts = {}) {
  const m = getModalSafe(ctx)
  if (m) return m.show({ type: 'sheet', ...opts, showCancel: true, showConfirm: false })
  // 降级：使用系统原生操作菜单
  return new Promise((resolve) => {
    wx.showActionSheet({
      itemList: opts.items || [],
      success: (res) => resolve({ confirm: true, tapIndex: res.tapIndex }),
      fail: () => resolve({ confirm: false })
    })
  })
}

/**
 * 自定义 Toast 轻提示（兼容 wx.showToast 参数格式）
 *
 * @param {Object} ctx - 页面/组件上下文 (this)
 * @param {Object} opts
 * @param {string}  opts.content  - 提示文本（新风格，推荐）
 * @param {string}  opts.title    - 提示文本（兼容 wx.showToast，优先级低于 content）
 * @param {string}  opts.theme    - 主题: 'success'|'danger'|'warning'|'default'（新风格）
 * @param {string}  opts.icon     - 图标: 'success'|'error'|'none'（兼容 wx.showToast，自动映射到 theme）
 * @param {number}  opts.duration - 显示时长，默认 2000
 *
 * 使用示例：
 *   modal.toast(this, { content: '操作成功',          theme: 'success' })   // 推荐
 *   modal.toast(this, { title: '操作成功',            icon: 'success' })    // 兼容
 *   modal.toast(this, { title: '网络错误',            icon: 'error' })      // 兼容
 *   modal.toast(this, { title: '信息已保存',          icon: 'none' })       // 兼容
 */
function toast(ctx, opts = {}) {
  // 兼容 wx.showToast 参数格式：icon -> theme, title -> content
  const themeMap = { success: 'success', error: 'danger', none: 'default' };
  const resolvedOpts = {
    content: opts.content || opts.title || '',
    theme: opts.theme || themeMap[opts.icon] || 'default',
    duration: opts.duration || 2000,
  };
  const m = getModalSafe(ctx)
  if (m) {
    m.show({ type: 'toast', ...resolvedOpts })
  } else {
    // 降级：使用系统原生 Toast
    const iconMap = { success: 'success', danger: 'error', warning: 'none', default: 'none' }
    wx.showToast({
      title: resolvedOpts.content,
      icon: iconMap[resolvedOpts.theme] || 'none',
      duration: resolvedOpts.duration
    })
  }
}

module.exports = { confirm, sheet, toast }
