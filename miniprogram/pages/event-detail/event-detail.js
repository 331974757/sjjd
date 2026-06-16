// pages/event-detail/event-detail.js
// 【赛事详情页】展示赛事信息 + 报名区域 + 报名人员列表
// 权限规则：admin/super_admin 拥有完整赛事管理权限，user 仅可查看和自助报名
const api = require('../../utils/api.js')
const perm = require('../../utils/permission.js')

Page({
  data: {
    eventId: '',                // 赛事ID（从URL参数获取）
    event: null,                // 赛事详情对象
    loaded: false,              // 数据是否加载完成
    userRole: '',               // 当前用户角色
    isAdmin: false,             // 是否管理员
    // 报名状态（针对当前用户）
    mySignup: null,             // { signedUp, signupId, playerId, signupType, ... }
    // 已报名人员列表
    signups: [],                // 报名列表（仅有效报名）
    signupCount: 0,             // 报名总人数
    // UI 状态
    loading: false,             // 操作加载中
    showCancelConfirm: false,   // 取消报名二次确认弹窗
    showStatusConfirm: false,   // 状态变更二次确认弹窗
    targetStatus: -1,           // 目标状态
    targetStatusName: '',       // 目标状态中文名
  },

  onLoad(options) {
    const eventId = options.eventId || options.id || ''
    if (!eventId) {
      wx.showToast({ title: '赛事ID缺失', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 1500)
      return
    }
    this.setData({ eventId })
    this.initPage()
  },

  onShow() {
    // 每次显示页面时刷新报名数据（可能从报名管理页返回）
    if (this.data.eventId && this.data.loaded) {
      this.loadSignups()
      this.loadMySignup()
    }
  },

  // ====== 页面初始化 ======
  async initPage() {
    try {
      // 并行拉取：用户角色 + 赛事详情
      const role = await perm.getRole()
      const isAdmin = role === 'admin' || role === 'super_admin'
      this.setData({ userRole: role, isAdmin })

      await this.loadEvent()
      if (this.data.event) {
        // 赛事加载完成后，并行拉取报名信息
        await Promise.all([
          this.loadSignups(),
          this.loadMySignup()
        ])
      }
      this.setData({ loaded: true })
    } catch (e) {
      console.error('[赛事详情] 初始化失败', e)
      this.setData({ loaded: true })
    }
  },

  // ====== 加载赛事详情 ======
  async loadEvent() {
    try {
      const res = await api.get('/events/' + this.data.eventId)
      if (res.success) {
        const event = res.data
        // 补充状态中文名和时间格式化
        event._statusName = this.getStatusName(event.event_status)
        event._statusClass = this.getStatusClass(event.event_status)
        event._timeLabel = this.formatTime(event.start_time)
        this.setData({ event })
      } else {
        wx.showToast({ title: res.error || '赛事不存在', icon: 'none' })
        setTimeout(() => wx.navigateBack(), 1500)
      }
    } catch (e) {
      wx.showToast({ title: '加载赛事失败', icon: 'none' })
    }
  },

  // ====== 加载当前用户报名状态 ======
  async loadMySignup() {
    try {
      const res = await api.get('/events/' + this.data.eventId + '/my-signup')
      if (res.success) {
        this.setData({ mySignup: res.data })
      }
    } catch (e) {
      console.error('[赛事详情] 加载报名状态失败', e)
    }
  },

  // ====== 加载已报名人员列表 ======
  async loadSignups() {
    try {
      // 管理员拉取所有有效报名，普通用户也查看列表
      const res = await api.get('/events/' + this.data.eventId + '/signups', {
        status: 1,
        pageSize: 200
      })
      if (res.success) {
        const list = res.data || []
        // 格式化报名数据
        list.forEach(s => {
          s._typeLabel = s.signup_type === 1 ? '管理员添加' : '自主报名'
          s._typeClass = s.signup_type === 1 ? 'type-admin' : 'type-self'
        })
        this.setData({ signups: list, signupCount: list.length })
      }
    } catch (e) {
      console.error('[赛事详情] 加载报名列表失败', e)
    }
  },

  // ====== 状态映射工具 ======
  getStatusName(status) {
    const map = { 0: '创建中', 1: '报名中', 2: '报名截止', 3: '分组锁定', 4: '对战中', 5: '已归档' }
    return map[status] || '未知'
  },
  getStatusClass(status) {
    // 不同状态对应的 CSS 类名
    const map = { 0: 's-draft', 1: 's-open', 2: 's-closed', 3: 's-locked', 4: 's-fighting', 5: 's-archived' }
    return map[status] || ''
  },
  // 获取按钮状态提示文本（用于灰化按钮时的原因说明）
  getBtnDisabledReason() {
    const event = this.data.event
    if (!event) return ''
    const status = event.event_status
    if (status === 0) return '报名未开始'
    if (status === 2) return '报名已截止'
    if (status === 3) return '赛事已分组锁定'
    if (status === 4) return '赛事对战中'
    if (status === 5) return '赛事已归档'
    return ''
  },

  formatTime(ts) {
    if (!ts) return '待定'
    const d = new Date(parseInt(ts))
    const pad = n => String(n).padStart(2, '0')
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
  },

  // ====== 用户自主报名（核心流程） ======
  async doSignup() {
    const { event, mySignup } = this.data

    // 【前置校验1】赛事状态检查
    if (event.event_status !== 1) {
      wx.showToast({ title: this.getBtnDisabledReason(), icon: 'none' })
      return
    }

    // 【前置校验2】已报名检查
    if (mySignup && mySignup.signedUp) {
      wx.showToast({ title: '您已报名当前赛事', icon: 'none' })
      return
    }

    this.setData({ loading: true })
    try {
      // 【核心】调用自主报名接口，后端自动完成昵称匹配校验
      const res = await api.post('/events/' + this.data.eventId + '/signups', {})
      wx.hideLoading()
      this.setData({ loading: false })

      if (res.success) {
        wx.showToast({ title: '报名成功！', icon: 'success' })
        // 刷新报名状态和列表
        await Promise.all([this.loadMySignup(), this.loadSignups()])
      } else {
        // 根据后端返回的 code 展示对应错误提示
        this.handleSignupError(res)
      }
    } catch (e) {
      this.setData({ loading: false })
      wx.showToast({ title: '报名失败，请重试', icon: 'none' })
      console.error('[赛事详情] 报名失败', e)
    }
  },

  // 处理报名错误（根据后端 code 展示不同提示）
  handleSignupError(res) {
    const code = res.code || ''
    switch (code) {
      case 'NICKNAME_EMPTY':
        wx.showModal({
          title: '未设置昵称',
          content: '请先设置您的微信群昵称后再报名。\n\n点击「确认」去设置昵称。',
          success: (modalRes) => {
            if (modalRes.confirm) {
              // 通过事件通知主页打开昵称弹窗
              wx.navigateBack()
            }
          }
        })
        break
      case 'PLAYER_NOT_FOUND':
        wx.showModal({
          title: '未找到选手档案',
          content: '未找到与您昵称匹配的选手档案，请联系管理员先录入您的选手信息。',
          showCancel: false
        })
        break
      case 'MULTIPLE_MATCH':
        wx.showModal({
          title: '匹配到多条记录',
          content: '您的昵称匹配到多个选手档案，请联系管理员手动添加报名。',
          showCancel: false
        })
        break
      case 'ALREADY_SIGNED':
        wx.showToast({ title: '您已报名当前赛事', icon: 'none' })
        break
      case 'EVENT_NOT_OPEN':
        wx.showToast({ title: res.error || '当前赛事不在报名阶段', icon: 'none' })
        break
      default:
        wx.showToast({ title: res.error || '报名失败', icon: 'none' })
    }
  },

  // ====== 普通用户取消报名 ======
  showCancelConfirm() {
    this.setData({ showCancelConfirm: true })
  },
  hideCancelConfirm() {
    this.setData({ showCancelConfirm: false })
  },

  async doCancelSignup() {
    this.setData({ showCancelConfirm: false, loading: true })
    try {
      const signupId = this.data.mySignup.signupId
      const res = await api.del('/events/' + this.data.eventId + '/signups/' + signupId)
      this.setData({ loading: false })

      if (res.success) {
        wx.showToast({ title: '已取消报名', icon: 'success' })
        await Promise.all([this.loadMySignup(), this.loadSignups()])
      } else {
        wx.showToast({ title: res.error || '取消失败', icon: 'none' })
      }
    } catch (e) {
      this.setData({ loading: false })
      wx.showToast({ title: '取消失败，请重试', icon: 'none' })
    }
  },

  // ====== 管理员操作：开启/截止报名 ======
  // 根据当前状态计算下一个合法状态
  getNextStatus() {
    const status = this.data.event.event_status
    // 仅允许正向流转：0→1（开启报名）, 1→2（截止报名）
    if (status === 0) return { status: 1, name: '开启报名', confirmTitle: '确认开启报名', confirmMsg: '开启后选手可自助报名，确定继续？' }
    if (status === 1) return { status: 2, name: '截止报名', confirmTitle: '确认截止报名', confirmMsg: '截止后选手将无法报名或取消报名，确定继续？' }
    return null
  },

  showStatusConfirm() {
    const next = this.getNextStatus()
    if (!next) {
      wx.showToast({ title: '当前状态不支持此操作', icon: 'none' })
      return
    }
    this.setData({
      showStatusConfirm: true,
      targetStatus: next.status,
      targetStatusName: next.name,
      _confirmTitle: next.confirmTitle,
      _confirmMsg: next.confirmMsg
    })
  },
  hideStatusConfirm() {
    this.setData({ showStatusConfirm: false })
  },

  async doChangeStatus() {
    this.setData({ showStatusConfirm: false, loading: true })
    try {
      const res = await api.put('/events/' + this.data.eventId + '/status', {
        eventStatus: this.data.targetStatus
      })
      this.setData({ loading: false })

      if (res.success) {
        wx.showToast({ title: this.data.targetStatusName + '成功', icon: 'success' })
        await this.loadEvent()
        await Promise.all([this.loadMySignup(), this.loadSignups()])
      } else {
        wx.showToast({ title: res.error || '操作失败', icon: 'none' })
      }
    } catch (e) {
      this.setData({ loading: false })
      wx.showToast({ title: '操作失败，请重试', icon: 'none' })
    }
  },

  // ====== 管理员操作：跳转报名人员管理 ======
  goSignupManage() {
    wx.navigateTo({
      url: '/pages/event-signup-manage/event-signup-manage?eventId=' + this.data.eventId
    })
  },

  // ====== 分享 ======
  onShareAppMessage() {
    const event = this.data.event
    return {
      title: (event ? event.event_name : '赛事详情') + ' - 蜀国争霸系统',
      path: '/pages/event-detail/event-detail?eventId=' + this.data.eventId
    }
  },

  // 防止弹窗背景滚动
  preventMove() {},

  // 下拉刷新
  onPullDownRefresh() {
    Promise.all([
      this.loadEvent(),
      this.loadSignups(),
      this.loadMySignup()
    ]).then(() => wx.stopPullDownRefresh())
      .catch(() => wx.stopPullDownRefresh())
  }
})
