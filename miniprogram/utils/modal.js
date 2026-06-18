/**
 * 美化弹窗工具 - 多主题
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

module.exports = { confirm, sheet }
