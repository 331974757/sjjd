// ============================================================
// pages/event-detail/tab-signups.js
// Tab2: 报名管理 - 数据定义与业务方法
// ============================================================

const api = require('../../utils/api.js')
const R = require('../../utils/rank-utils.js')
const modal = require('../../utils/modal.js')

module.exports = {
  data: {
    // 报名管理
    signups: [],
    signupCount: 0,
    signupTotal: 0,
    signupPage: 1,
    signupTotalPages: 1,
    signupPageSize: 20,
    signupHasMore: false,
    searchKeyword: '',
    searchResults: [],
    searchLoading: false,
    addLoading: false,
    mySignup: null,
    mySignupLoaded: false,
    _myPlayerId: '',
    showCancelConfirm: false,
    removeTarget: null,
  },

  methods: {
    async loadSignups(page = 1) {
      try {
        const res = await api.get('/events/' + this.data.eventId + '/signups',
          { status: 1, page: page, pageSize: this.data.signupPageSize })
        if (res.success) {
          const list = (res.data || []).map(s => ({
            ...s,
            calibrate_rank_name: R.normalizeRankName(s.calibrate_rank_name),
            _typeLabel: s.signup_type === 1 ? '管理员添加' : '自主报名',
            _typeClass: s.signup_type === 1 ? 'type-admin' : 'type-self'
          }))
          const total = res.total || 0
          const pageSize = this.data.signupPageSize
          this.setData({
            signups: list,
            signupCount: res.total || list.length,
            signupPage: res.page || page,
            signupTotal: total,
            signupTotalPages: Math.ceil(total / pageSize) || 1,
            signupHasMore: page * pageSize < total
          })
        }
      } catch (e) {
        console.error('[报名] 加载列表失败', e)
        modal.toast(this, { title: '加载报名列表失败', icon: 'none' })
      }
    },

    // 切换分页
    goSignupPage(e) {
      const page = parseInt(e.currentTarget.dataset.page)
      if (!page || page < 1) return
      const totalPages = Math.ceil(this.data.signupTotal / this.data.signupPageSize)
      if (page > totalPages) return
      this.setData({ signupPage: page })
      this.loadSignups(page)
    },

    async loadMySignup() {
      try {
        const res = await api.get('/events/' + this.data.eventId + '/my-signup')
        if (res.success) {
          this.setData({
            mySignup: res.data,
            mySignupLoaded: true,
            _myPlayerId: res.data.playerId || ''
          })
        } else {
          this.setData({ mySignupLoaded: true })
        }
      } catch (e) {
        console.error('[报名] 加载状态失败', e)
        this.setData({ mySignupLoaded: true })
        // 静默降级：不在 UI 上弹 Toast
      }
    },

    // --- 用户自主报名 ---
    async doSignup() {
      if (this._signupLock) return; this._signupLock = true
      const { event, mySignup, signupCount } = this.data
      if (event.event_status !== 1) {
        modal.toast(this, { title: '当前赛事不在报名阶段', icon: 'none' })
        return
      }
      if (mySignup && mySignup.isActive) {
        modal.toast(this, { title: '您已报名', icon: 'none' })
        return
      }
      // 前端校验：报名人数上限（仅自主报名受限，管理员添加不受限）
      if (event.signup_limit && event.signup_limit > 0 && signupCount >= event.signup_limit) {
        modal.toast(this, { title: '报名人数已满', icon: 'none' })
        return
      }
      this.setData({ loading: true })
      try {
        const res = await api.post('/events/' + this.data.eventId + '/signups', {})
        this.setData({ loading: false })
        if (res.success) {
          // 报名成功，静默处理
          await Promise.all([this.loadMySignup(), this.loadSignups()])
        } else {
          this._handleSignupError(res)
        }
      } catch (e) {
        this.setData({ loading: false })
        modal.toast(this, { title: '报名失败，请重试', icon: 'none' })
      } finally {
        this._signupLock = false
      }
    },

    async _handleSignupError(res) {
      const code = res.code || ''
      switch (code) {
        case 'NICKNAME_EMPTY':
          const r1 = await modal.confirm(this, { theme: 'warning', title: '未设置昵称', content: '请先设置您的微信群昵称后再报名。\n\n点击「确认」去设置昵称。' }); if (r1.confirm) wx.navigateBack(); break
        case 'PLAYER_NOT_FOUND':
          await modal.confirm(this, { theme: 'warning', title: '未找到选手档案', content: '未找到与您昵称匹配的选手档案，请联系管理员先录入您的选手信息。', showCancel: false }); break
        case 'MULTIPLE_MATCH':
          await modal.confirm(this, { theme: 'warning', title: '匹配到多条记录', content: '您的昵称匹配到多个选手档案，请联系管理员手动添加报名。', showCancel: false }); break
        case 'ALREADY_SIGNED':
          modal.toast(this, { title: '您已报名该赛事', icon: 'none' })
          break
        case 'EVENT_NOT_OPEN':
          modal.toast(this, { title: '赛事报名未开启', icon: 'none' })
          break
        case 'SIGNUP_FULL':
          modal.toast(this, { title: '报名人数已满', icon: 'none' })
          break
        default:
          modal.toast(this, { title: res.error || '报名失败', icon: 'none' })
      }
    },

    // --- 取消报名 ---
    showCancelSignup() { this.setData({ showCancelConfirm: true }) },
    hideCancelSignup() { this.setData({ showCancelConfirm: false }) },
    async doCancelSignup() {
      if (this._cancelLock) return; this._cancelLock = true
      this.setData({ showCancelConfirm: false, loading: true })
      try {
        const res = await api.del('/events/' + this.data.eventId + '/signups/' + this.data.mySignup.signupId)
        this.setData({ loading: false })
        if (res.success) {
          await Promise.all([this.loadMySignup(), this.loadSignups()])
        } else {
          modal.toast(this, { title: res.error || '取消失败', icon: 'none' })
        }
      } catch (e) {
        this.setData({ loading: false })
        modal.toast(this, { title: '取消失败，请重试', icon: 'none' })
      } finally {
        this._cancelLock = false
      }
    },

    // --- 管理员：搜索选手 + 批量添加 ---
    onSearchInput(e) {
      const val = e.detail.value || ''
      this.setData({ searchKeyword: val })
      if (this._searchTimer) clearTimeout(this._searchTimer)
      this._searchTimer = setTimeout(() => this._doSearch(), 300)
    },
    clearSearch() {
      if (this._searchTimer) { clearTimeout(this._searchTimer); this._searchTimer = null }
      this.setData({ searchKeyword: '', searchResults: [] })
    },

    async _doSearch() {
      const kw = this.data.searchKeyword.trim()
      if (!kw) { this.setData({ searchResults: [] }); return }
      this.setData({ searchLoading: true })
      try {
        // 并行请求：搜索选手 + 获取全部已报名ID（不分页，避免分页遗漏）
        const [res, idsRes] = await Promise.all([
          api.get('/search/players', { keyword: kw }),
          api.get('/events/' + this.data.eventId + '/signups/ids')
        ])
        this.setData({ searchLoading: false })
        if (res.success) {
          // 用后端返回的全量已报名ID构建 Set
          const signedIds = new Set((idsRes.success && idsRes.data) ? idsRes.data.map(id => String(id)) : [])
          const results = (res.data || []).map(p => ({
            ...p,
            calibrate_rank_name: R.normalizeRankName(p.calibrate_rank_name),
            _id: p.id,   // 后端搜索API返回的是 id，统一映射为 _id
            _alreadySigned: signedIds.has(String(p.id))
          }))
          this.setData({ searchResults: results })
        }
      } catch (e) {
        this.setData({ searchLoading: false })
        modal.toast(this, { title: '搜索失败', icon: 'none' })
      }
    },

    // 单个添加：直接添加一名选手到报名池
    async doSingleAdd(e) {
      const pid = e.currentTarget.dataset.pid
      console.log('[add] pid:', pid, 'eventId:', this.data.eventId)
      this.setData({ addLoading: true })
      try {
        const payload = { playerIds: [pid] }
        console.log('[add] sending:', JSON.stringify(payload))
        const res = await api.post('/events/' + this.data.eventId + '/signups/batch', payload)
        console.log('[add] response:', JSON.stringify(res))
        // 服务器始终返回 success:true，实际添加结果在 res.data 中
        const result = res.data || {}
        const added = result.success || 0
        const skipped = result.skipped || 0
        const failed = result.failed || 0
        if (res.success && added > 0) {
          // 仅当服务器确认添加成功后，才在搜索结果中标记已报名
          const results = this.data.searchResults.map(p =>
            String(p.id) === String(pid) ? { ...p, _alreadySigned: true } : p
          )
          this.setData({ searchResults: results, addLoading: false })
          modal.toast(this, { title: '已添加报名', icon: 'success' })
          await this.loadSignups()
        } else if (res.success && skipped > 0) {
          this.setData({ addLoading: false })
          // 已报名，更新搜索结果的 _alreadySigned 标记
          const results = this.data.searchResults.map(p =>
            String(p.id) === String(pid) ? { ...p, _alreadySigned: true } : p
          )
          this.setData({ searchResults: results })
          modal.toast(this, { title: '该选手已报名', icon: 'none' })
        } else if (res.success && failed > 0) {
          this.setData({ addLoading: false })
          modal.toast(this, { title: '添加失败：' + (result.errors ? result.errors.join(',') : '未知原因'), icon: 'none' })
        } else {
          this.setData({ addLoading: false })
          modal.toast(this, { title: '添加失败，请重试', icon: 'none' })
        }
      } catch (e) {
        console.log('[add] error:', e)
        this.setData({ addLoading: false })
        modal.toast(this, { title: '添加失败，请重试', icon: 'none' })
      }
    },

    // --- 管理员：单个剔除报名 ---
    showRemoveSignup(e) {
      const sid = e.currentTarget.dataset.sid
      const s = this.data.signups.find(x => x.signup_id === sid)
      if (!s) return
      this.setData({ removeTarget: s })
    },
    hideRemoveSignup() { this.setData({ removeTarget: null }) },
    async doRemoveSignup() {
      const s = this.data.removeTarget
      if (!s) return
      this.setData({ removeTarget: null, loading: true })
      try {
        const res = await api.del('/events/' + this.data.eventId + '/signups/' + s.signup_id)
        this.setData({ loading: false })
        if (res.success) {
          // 已剔除，静默处理
          await this.loadSignups()
        } else {
          modal.toast(this, { title: res.error || '操作失败', icon: 'none' })
        }
      } catch (e) {
        this.setData({ loading: false })
        modal.toast(this, { title: '操作失败，请重试', icon: 'none' })
      }
    },
  }
}
