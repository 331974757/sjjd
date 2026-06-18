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

function getModal(ctx) {
  const m = ctx.selectComponent('#modal')
  if (!m) throw new Error('未在页面中注册 modal 组件')
  return m
}

function confirm(ctx, opts = {}) {
  return getModal(ctx).show({ type: 'confirm', ...opts })
}

function sheet(ctx, opts = {}) {
  return getModal(ctx).show({ type: 'sheet', ...opts, showCancel: true, showConfirm: false })
}

module.exports = { confirm, sheet }
