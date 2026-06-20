/**
 * 赛事模块 — 赛事章程（进行中）+ 历史赛事 + 赛事创建弹窗
 */
const perm = require('../../../utils/permission.js')
const C = require('../../../utils/constants.js')
const api = require('../../../utils/api.js')
const dt = require('../../../utils/datetime-picker.js')
const modal = require('../../../utils/modal.js')

module.exports = {
  data: {
    // 赛事章程（进行中赛事）
    rulesLoaded: false,
    rulesLoading: false,
    ruleEventList: [],
    // 历史赛事（已归档赛事 + 搜索 + 分页）
    eventsLoaded: false,
    eventsLoading: false,
    eventList: [],
    eventTotal: 0,
    eventPage: 1,
    eventHasMore: false,
    eventLoadingMore: false,
    historySearchText: '',
    eventStatusMap: perm.STATUS_NAMES,
    // 赛事创建弹窗
    showCreateModal: false,
    creatingEvent: false,
    createEventName: '',
    createEventDesc: '',
    createEventLimit: 0,
    createEventLimitCustom: '',
    createDateTimeRange: [],
    createDateTimeIndex: [0, 0, 0, 12, 0],
    createDateTimeText: '',
  },

  methods: {
    // ====== 赛事章程（进行中赛事） ======
    async loadRuleEvents() {
      if (this.data.rulesLoading) return
      this.setData({ rulesLoading: true })
      try {
        const res = await api.get('/events', { archived: 0, pageSize: 50 })
        if (res.success) {
          const list = (res.data || []).map(e => ({
            ...e,
            _statusName: this.data.eventStatusMap[e.event_status] || '未知',
            _timeLabel: this.formatEventTime(e.start_time)
          }))
          this.setData({ ruleEventList: list, rulesLoaded: true })
        }
      } catch (e) {
        console.error('[赛事章程] 加载失败', e)
      } finally {
        this.setData({ rulesLoading: false })
      }
    },

    // ====== 历史赛事（已归档赛事） ======
    async loadEvents(reset = true) {
      if (this.data.eventsLoading) return
      if (reset) {
        this.setData({ eventPage: 1, eventList: [], eventTotal: 0, eventHasMore: false })
      }
      this.setData({ eventsLoading: true })
      try {
        const params = { page: this.data.eventPage || 1, pageSize: 10 }
        const kw = this.data.historySearchText ? this.data.historySearchText.trim() : ''
        if (kw) params.keyword = kw

        const res = await api.get('/events/archived', params)
        if (res.success) {
          const list = (res.data || []).map(e => ({
            ...e,
            _statusName: '名次归档',
            _timeLabel: this.formatEventTime(e.start_time),
            _signupCount: e.signupCount || 0,
            _topRanks: e.topRanks || []
          }))
          if (reset) {
            this.setData({ eventList: list })
          } else {
            this.setData({ eventList: [...this.data.eventList, ...list] })
          }
          this.setData({
            eventsLoaded: true,
            eventTotal: res.total || list.length,
            eventHasMore: (res.page * res.pageSize) < (res.total || 0)
          })
        }
      } catch (e) {
        console.error('[历史赛事] 加载失败', e)
        if (reset) this.setData({ eventsLoaded: false })
      } finally {
        this.setData({ eventsLoading: false })
      }
    },

    async loadMoreEvents() {
      if (this.data.eventLoadingMore || !this.data.eventHasMore) return
      const nextPage = (this.data.eventPage || 1) + 1
      this.setData({ eventLoadingMore: true, eventPage: nextPage })
      try {
        await this.loadEvents(false)
      } finally {
        this.setData({ eventLoadingMore: false })
      }
    },

    onHistorySearchInput(e) {
      const val = e.detail.value || ''
      this.setData({ historySearchText: val })
      if (this._historySearchTimer) clearTimeout(this._historySearchTimer)
      this._historySearchTimer = setTimeout(() => { this.loadEvents(true) }, 300)
    },

    onHistorySearchConfirm(e) {
      if (this._historySearchTimer) clearTimeout(this._historySearchTimer)
      this.setData({ historySearchText: e.detail.value || '' })
      this.loadEvents(true)
    },

    clearHistorySearch() {
      const currentEmpty = !this.data.historySearchText || !this.data.historySearchText.trim()
      this.setData({ historySearchText: '' })
      if (!currentEmpty) { this.loadEvents(true) }
    },

    /** 格式化赛事时间 */
    formatEventTime(ts) {
      if (!ts) return '待定'
      let d
      if (typeof ts === 'number') {
        d = new Date(ts)
      } else if (typeof ts === 'string') {
        const norm = ts.trim().replace(' ', 'T')
        d = new Date(norm)
      } else {
        d = new Date(ts)
      }
      if (isNaN(d.getTime())) {
        const n = parseInt(ts)
        if (!isNaN(n) && n > 0) d = new Date(n > 10000000000 ? n : n * 1000)
        else return '待定'
      }
      const y = d.getFullYear()
      const M = C.pad(d.getMonth() + 1)
      const D = C.pad(d.getDate())
      const h = C.pad(d.getHours())
      const m = C.pad(d.getMinutes())
      const now = new Date()
      if (y === now.getFullYear()) return M + '/' + D + ' ' + h + ':' + m
      return y + '/' + M + '/' + D + ' ' + h + ':' + m
    },

    /** 跳转赛事详情页 */
    goEventDetail(e) {
      const dataset = e.currentTarget.dataset
      const eventId = dataset.eventId || dataset.id
      if (!eventId) return
      const isHistory = this.data.subTab === 'history'
      const extra = isHistory ? '&readonly=1&fromHistory=1' : ''
      wx.navigateTo({ url: '/pages/event-detail/event-detail?eventId=' + eventId + extra })
    },

    // ====== 【赛事创建】新建赛事弹窗 ======
    _initCreateDateTimePicker() {
      const now = new Date()
      const range = dt.buildRange({ refYear: now.getFullYear(), yearSpan: 3, selYear: now.getFullYear(), selMonth: now.getMonth() + 1 })
      const idx = dt.buildIndex(Date.now() + 3600000, now.getFullYear())
      const text = dt.toDisplayText(range, idx)
      this.setData({ createDateTimeRange: range, createDateTimeIndex: idx, createDateTimeText: text })
    },

    showCreateEventModal() {
      this._initCreateDateTimePicker()
      this.setData({
        showCreateModal: true,
        createEventName: '',
        createEventDesc: '',
        createEventLimit: 0,
        createEventLimitCustom: ''
      })
    },

    closeCreateEventModal() {
      this.setData({
        showCreateModal: false,
        createEventName: '',
        createEventDesc: '',
        createEventLimit: 0,
        createEventLimitCustom: '',
        createDateTimeText: ''
      })
    },

    onCreateEventNameInput(e) {
      this.setData({ createEventName: e.detail.value })
    },

    onCreateDateTimeColumnChange(e) {
      const { column, value } = e.detail
      const result = dt.onColumnChange(this.data.createDateTimeRange, this.data.createDateTimeIndex, column, value)
      this.setData({ createDateTimeRange: result.range, createDateTimeIndex: result.idx })
    },

    onCreateDateTimeChange(e) {
      const idx = e.detail.value
      const text = dt.toDisplayText(this.data.createDateTimeRange, idx)
      this.setData({ createDateTimeIndex: idx, createDateTimeText: text })
    },

    onCreateEventDescInput(e) {
      this.setData({ createEventDesc: e.detail.value })
    },

    pickEventLimit(e) {
      const val = parseInt(e.currentTarget.dataset.val)
      this.setData({ createEventLimit: val })
      if (val !== -1) {
        this.setData({ createEventLimitCustom: '' })
      }
    },

    onCreateEventLimitCustomInput(e) {
      this.setData({ createEventLimitCustom: e.detail.value })
    },

    async submitCreateEvent() {
      // 防重复提交锁
      if (this._creatingEvent) return
      const name = (this.data.createEventName || '').trim()
      if (!name) { modal.toast(this, { theme: 'warning', content: '请输入赛事名称' }); return }
      if (name.length < 2) { modal.toast(this, { theme: 'warning', content: '赛事名称至少需要2个字符' }); return }
      if (name.length > 50) { modal.toast(this, { theme: 'warning', content: '赛事名称不能超过50个字符' }); return }

      let startTime = null
      if (this.data.createDateTimeRange.length > 0 && this.data.createDateTimeIndex.length > 0) {
        startTime = dt.toTimestamp(this.data.createDateTimeRange, this.data.createDateTimeIndex)
        if (isNaN(startTime)) startTime = null
      }

      const desc = (this.data.createEventDesc || '').trim()

      let signupLimit = null
      if (this.data.createEventLimit > 0) {
        signupLimit = this.data.createEventLimit
      } else if (this.data.createEventLimit === -1 && this.data.createEventLimitCustom) {
        const custom = parseInt(this.data.createEventLimitCustom)
        if (!isNaN(custom) && custom > 0) { signupLimit = custom }
      }

      this._creatingEvent = true
      this.setData({ creatingEvent: true })
      wx.showLoading({ title: '创建中...', mask: true })
      try {
        const res = await api.post('/events', {
          event_name: name,
          start_time: startTime,
          event_desc: desc || undefined,
          signup_limit: signupLimit
        })
        wx.hideLoading()

        if (res.success) {
          this.setData({ showCreateModal: false })
          modal.toast(this, { theme: 'success', content: '赛事创建成功', duration: 1500 })
          this.loadRuleEvents()

          const eventId = (res.data && res.data.eventId) ? res.data.eventId : null
          if (eventId) {
            setTimeout(() => {
              wx.navigateTo({ url: '/pages/event-detail/event-detail?eventId=' + eventId })
            }, 800)
          } else {
            console.warn('[赛事创建] API 成功但未返回 eventId，跳过详情跳转')
          }
        } else {
          modal.toast(this, { theme: 'danger', content: res.error || '创建失败', duration: 2000 })
        }
      } catch (err) {
        wx.hideLoading()
        console.error('[赛事创建] 失败', err)
        modal.toast(this, { theme: 'danger', content: '网络错误，请重试' })
      } finally {
        this._creatingEvent = false
        this.setData({ creatingEvent: false })
      }
    }
  }
}
