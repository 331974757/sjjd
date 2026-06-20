// ============================================================
// pages/event-detail/tab-overview.js
// Tab1: 赛事概览 - 数据定义与业务方法
// 整合到 event-detail.js Page 中，通过 Object.assign 合并
// ============================================================

const api = require('../../utils/api.js')

module.exports = {
  // ===== Tab1 数据定义 =====
  data: {
    // 赛事概览 - 内联编辑
    editingName: false,
    editNameValue: '',
    editingDesc: false,
    editDescValue: '',
    editingTime: false,
    editDateTimeRange: [],
    editDateTimeIndex: [0, 0, 0, 12, 0],
    editDateTimeText: '',
    // 状态流转确认弹窗
    showStatusConfirm: false,
    targetStatus: 0,
    targetStatusName: '',
    _confirmTitle: '',
    _confirmMsg: '',
    // 报名人数上限弹窗
    showSignupLimitModal: false,
    signupLimitIndex: 0,
    customSignupLimit: '',
    signupLimitOptions: ['0', '10', '20', '30', '40', '100', '200'],
    // 编辑报名人数
    editSignupLimitVal: '',
    editCustomSignupLimit: '',
    // 取消赛事弹窗
    showCancelEventModal: false,
    // 确认开战弹窗
    showBattleConfirmModal: false,
    _battleConfirmTitle: '',
    _battleConfirmLines: [],
    _battleConfirmNote: '',
    _battleConfirmCallback: null,
    // 概览页跳转按钮（根据赛事状态动态显示）
    _overviewJump: null,
  },

  // ===== Tab1 方法 =====
  methods: {
    /** 获取下一个有效状态流转 */
    getNextStatus() {
      const status = this.data.event.event_status
      if (status === 0) return { status: 1, name: '开启报名', title: '确认开启报名', msg: '开启后选手可自助报名，确定继续？' }
      if (status === 1) return { status: 2, name: '截止报名', title: '确认截止报名', msg: '截止后选手将无法报名或取消报名，确定继续？' }
      return null
    },

    // 开启/截止报名
    showStatusConfirm() {
      const next = this.getNextStatus()
      if (!next) { return }
      // 开启报名：直接执行，不弹窗
      if (next.status === 1) {
        this._doChangeStatusDirect(1)
        return
      }
      this.setData({
        showStatusConfirm: true,
        targetStatus: next.status,
        targetStatusName: next.name,
        _confirmTitle: next.title,
        _confirmMsg: next.msg
      })
    },
    // 直接变更状态（无需弹窗确认）
    async _doChangeStatusDirect(status) {
      const payload = { eventStatus: status }
      if (status === 1) {
        const limit = this.data.event.signup_limit
        payload.signupLimit = (limit && limit > 0) ? limit : 0
      }
      this.setData({ loading: true })
      try {
        const res = await api.put('/events/' + this.data.eventId + '/status', payload)
        this.setData({ loading: false })
        if (res.success) {
          await this.loadEvent()
          this._updateTabLocks()
          this._updateActions()
        } else {
          modal.toast(this, { title: res.error || '操作失败', icon: 'none' })
        }
      } catch (e) {
        this.setData({ loading: false })
        modal.toast(this, { title: '操作失败，请重试', icon: 'none' })
      }
    },
    hideStatusConfirm() {
      this.setData({ showStatusConfirm: false, signupLimitIndex: 0, customSignupLimit: '' })
    },
    // 滚轮选择器：报名人数上限
    onSignupLimitPick(e) {
      this.setData({ signupLimitIndex: e.detail.value, customSignupLimit: '' })
    },
    // 自定义人数输入
    onCustomLimitInput(e) { this.setData({ customSignupLimit: e.detail.value }) },
    async doChangeStatus() {
      const payload = { eventStatus: this.data.targetStatus }
      this.setData({ showStatusConfirm: false, loading: true })

      // 截止报名前校验最低人数
      if (this.data.targetStatus === 2) {
        const sigRes = await api.get('/events/' + this.data.eventId + '/signups', { status: 1, pageSize: 1 })
        const currentCount = sigRes.total || 0
        const minNeeded = 10  // 2队 × 5人
        if (currentCount < minNeeded) {
          this.setData({ loading: false })
          const r = await modal.confirm(this, {
            theme: 'warning', title: '报名人数不足',
            content: `当前仅 ${currentCount} 人报名，至少需要 ${minNeeded} 人才够比赛。\n\n确定要截止报名吗？`,
            confirmText: '仍要截止'
          })
          if (!r.confirm) return
          this.setData({ loading: true })
        }
      }
      try {
        const res = await api.put('/events/' + this.data.eventId + '/status', payload)
        this.setData({ loading: false })
        if (res.success) {
          // 成功，静默处理
          await this.loadEvent()
          this._updateTabLocks()
          this._updateActions()
          // 如果进入报名截止状态，自动切到分组编组
          if (this.data.targetStatus === 2) {
            modal.toast(this, { title: '报名已截止，进入分组编队', icon: 'success' })
            setTimeout(() => this._switchToTab('teams'), 800)
          } else {
            modal.toast(this, { title: '操作成功', icon: 'success' })
          }
        } else {
          modal.toast(this, { title: res.error || '操作失败', icon: 'none' })
        }
      } catch (e) {
        this.setData({ loading: false })
        modal.toast(this, { title: '操作失败，请重试', icon: 'none' })
      }
    },

    // 管理员：修改报名人数上限（分组编队前）
    showEditSignupLimit() {
      const { event } = this.data
      if (!event) return
      const currentLimit = event.signup_limit
      let val = 'unlimited'
      if (currentLimit && currentLimit > 0) {
        // 预设值匹配
        if ([10, 20, 30, 40].includes(currentLimit)) {
          val = String(currentLimit)
        } else {
          val = 'custom'
          this.setData({ editCustomSignupLimit: String(currentLimit) })
        }
      }
      this.setData({
        showSignupLimitModal: true,
        editSignupLimitVal: val,
        editCustomSignupLimit: val === 'custom' ? (this.data.editCustomSignupLimit || String(currentLimit || '')) : ''
      })
    },
    hideEditSignupLimit() {
      this.setData({ showSignupLimitModal: false, editSignupLimitVal: '', editCustomSignupLimit: '' })
    },
    selectEditSignupLimit(e) {
      this.setData({ editSignupLimitVal: e.currentTarget.dataset.val, editCustomSignupLimit: '' })
    },
    onEditCustomLimitInput(e) { this.setData({ editCustomSignupLimit: e.detail.value }) },
    async doUpdateSignupLimit() {
      const { editSignupLimitVal, editCustomSignupLimit } = this.data
      let limitVal
      if (editSignupLimitVal === 'unlimited') {
        limitVal = 0
      } else if (editSignupLimitVal === 'custom') {
        limitVal = parseInt(editCustomSignupLimit)
        if (!limitVal || limitVal <= 0) {
          return
        }
      } else {
        limitVal = parseInt(editSignupLimitVal)
      }

      this.setData({ showSignupLimitModal: false, loading: true })
      try {
        const res = await api.put('/events/' + this.data.eventId + '/signup-limit', { signupLimit: limitVal })
        this.setData({ loading: false })
        if (res.success) {
          await this.loadEvent()
          await this.loadSignups()
          this._updateActions()
        } else {
          modal.toast(this, { title: res.error || '更新失败', icon: 'none' })
        }
      } catch (e) {
        this.setData({ loading: false })
        modal.toast(this, { title: '更新失败，请重试', icon: 'none' })
      }
    },

    // 根据赛事状态计算概览页跳转按钮
    _computeOverviewJump() {
      const { event, readonly } = this.data
      if (!event || readonly) { this.setData({ _overviewJump: null }); return }
      const status = event.event_status
      const jumpMap = {
        0: null,                          // 创建比赛：不显示跳转按钮
        1: { tab: 'signups', index: 1, label: '📝 前往报名管理', desc: '管理报名人员' },
        2: { tab: 'teams', index: 2, label: '👥 前往分组编队', desc: '进行队伍分组编排' },
        3: { tab: 'matches', index: 3, label: '⚔️ 前往对阵对战', desc: '生成对战编排' },
        4: { tab: 'matches', index: 3, label: '⚔️ 前往对阵对战', desc: '编排对战与判定胜负' },
        5: { tab: 'ranks', index: 4, label: '🏆 前往名次归档', desc: '设定最终排名' },
        6: null                           // 已归档：不显示跳转按钮
      }
      this.setData({ _overviewJump: jumpMap[status] || null })
    },

    // 去分组(状态=2时) — 直接切Tab
    goToTeamsTab() { this._switchToTab('teams') },

    // 去对阵(状态=4时) — 直接切Tab
    goToMatchesTab() { this._switchToTab('matches') },

    // 去归档(状态=5未归档时) — 直接切Tab
    goToRanksTab() { this._switchToTab('ranks') },

    // 从概览页点击名次图标 → 切到名次Tab并进入编辑模式
    goEditRanks() {
      this._switchToTab('ranks')
      // 稍等Tab切换完成后再进入编辑
      setTimeout(() => this.startEditRanks(), 300)
    },
  }
}
