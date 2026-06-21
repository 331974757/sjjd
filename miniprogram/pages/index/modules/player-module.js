/**
 * 选手档案模块 — 数据、搜索/筛选/排序、段位饼图、批量删除、导出、导航
 */
const R = require('../../../utils/rank-utils.js')
const C = require('../../../utils/constants.js')
const api = require('../../../utils/api.js')
const modal = require('../../../utils/modal.js')

const RANK_ORDER = R.RANK_ORDER
const RANK_ICONS = R.RANK_ICONS
const RANK_LABELS = R.RANK_LABELS
const RANK_COLORS = R.RANK_COLORS

module.exports = {
  data: {
    allPlayers: [],
    displayPlayers: [],
    positionFilter: 'all',
    rankFilter: 'all',
    sortFilter: 'rank-desc',
    filteredCount: 0,
    loaded: false,
    pageSize: C.PAGE_SIZE,
    currentPage: 1,
    hasMore: false,
    _searchText: '',
    showChart: false,
    rankDistribution: [],
    deleteMode: false,
    selectedIds: {},
    selectedCount: 0,
  },

  methods: {
    // ====== 服务端分页加载选手数据 ======
    async loadAllPlayers(reset = true) {
      if (this._loading) return
      this._loading = true
      if (reset) {
        this.setData({ displayPlayers: [], loaded: false, hasMore: false, currentPage: 1 })
      }
      try {
        const params = {
          page: reset ? 1 : (this.data.currentPage || 1),
          pageSize: this.data.pageSize,
          sortBy: 'rank'
        }
        // 读取排序方向
        if (this.data.sortFilter === 'rank-asc') {
          params.sortOrder = 'asc'
        } else {
          params.sortOrder = 'desc'
        }
        const kw = this.data._searchText || ''
        if (kw) params.keyword = kw
        const pos = this.data.positionFilter
        if (pos !== 'all') params.position = pos
        const rank = this.data.rankFilter
        if (rank !== 'all') params.rank = rank

        const res = await api.get('/players', params)
        const list = (res.data || []).map(p => ({
          ...p,
          calibrateRankName: R.normalizeRankName(p.calibrateRankName),
          _rankIcon: R.getRankIcon(p.calibrateRankName),
          _rankIconIsImg: R.isRankIconImage(R.getRankIcon(p.calibrateRankName)),
        }))
        this.setData({
          displayPlayers: reset ? list : [...this.data.displayPlayers, ...list],
          loaded: true,
          hasMore: (res.page * res.pageSize) < (res.total || 0),
          currentPage: res.page || 1,
          filteredCount: res.total || list.length,
        })
        // 缓存全量数据用于导出（无筛选条件时）
        if (reset && !kw && pos === 'all' && rank === 'all' && (res.total || 0) <= 500) {
          // 加载全量数据仅用于导出
        }
      } catch (err) {
        console.error('[选手数据] 加载失败', err)
        this.setData({ loaded: true })
        modal.toast(this, { theme: 'danger', content: '加载失败' })
      } finally {
        this._loading = false
      }
    },

    // ====== 加载更多（滚底加载下一页） ======
    loadMore() {
      if (this._loading || !this.data.hasMore) return
      this.setData({ currentPage: (this.data.currentPage || 1) + 1 })
      this.loadAllPlayers(false)
    },

    // ====== 搜索/筛选/排序（触发服务端查询） ======
    onKeywordInput(e) {
      const val = e.detail.value || ''
      this.setData({ _searchText: val })
      if (this._searchTimer) clearTimeout(this._searchTimer)
      this._searchTimer = setTimeout(() => { this.loadAllPlayers(true) }, 300)
    },

    onSearchConfirm(e) {
      if (this._searchTimer) clearTimeout(this._searchTimer)
      this.setData({ _searchText: e.detail.value || '' })
      this.loadAllPlayers(true)
    },

    clearSearch() {
      this.setData({ _searchText: '' })
      this.loadAllPlayers(true)
    },

    onPosFilter(e) {
      this.setData({ positionFilter: e.currentTarget.dataset.pos })
      this.loadAllPlayers(true)
    },

    onRankFilter(e) {
      this.setData({ rankFilter: e.currentTarget.dataset.rank })
      this.loadAllPlayers(true)
    },

    onSortToggle() {
      // 服务端默认按 rank desc 排序，切换为 asc
      const next = this.data.sortFilter === 'rank-desc' ? 'rank-asc' : 'rank-desc'
      this.setData({ sortFilter: next })
      this.loadAllPlayers(true)
    },

    resetFilters() {
      this.setData({ _searchText: '', positionFilter: 'all', rankFilter: 'all', sortFilter: 'rank-desc' })
      this.loadAllPlayers(true)
    },

    filterAndDisplay() {
      // 服务端分页模式下此方法由 loadAllPlayers 直接完成
      this.loadAllPlayers(true)
    },

    // ====== 导航 ======
    async goAdd() {
      if (!this.data.isAdmin) {
        const names = this.data.allAdminNames.join('、')
        await modal.confirm(this, {
          theme: 'warning',
          title: '仅管理员可添加选手',
          content: '请联系管理员添加选手：\n' + (names || '请稍后再试'),
          showCancel: false
        })
        return
      }
      this._needsReload = true
      wx.navigateTo({ url: '/pages/dota2-add/dota2-add' })
    },

    goDetail(e) {
      if (this.data.deleteMode) return
      const id = e.currentTarget.dataset.id
      this._needsReload = true
      wx.navigateTo({ url: '/pages/dota2-detail/dota2-detail?id=' + id })
    },

    goImport() {
      this._needsReload = true
      wx.navigateTo({ url: '/pages/dota2-import/dota2-import' })
    },

    async showAdminMenu() {
      const isSuper = this.data.userRole === 'super_admin'
      const items = ['批量导入', '批量导出']
      if (isSuper) items.push('批量删除选手')
      const res = await modal.sheet(this, { title: '管理员操作', items: items.map(label => ({ label })) })
      if (!res.confirm) return
      const action = items[res.tapIndex]
      if (action === '批量导入') { this.goImport() }
      else if (action === '批量导出') { this.doExport() }
      else if (action === '批量删除选手') { this.toggleDeleteMode() }
    },

    // ====== 段位分布饼图 ======
    toggleChart() {
      const willShow = !this.data.showChart
      this.setData({ showChart: willShow })
      if (willShow) {
        this.computeRankDistribution()
        if (this._pieTimer) clearTimeout(this._pieTimer)
        this._pieTimer = setTimeout(() => { this.drawPieChart() }, 300)
      }
    },

    closeChart() {
      this.setData({ showChart: false })
    },

    computeRankDistribution() {
      // 从后端统计数据获取段位分布（不受分页影响）
      api.get('/stats/ranks').then(res => {
        if (!res.success || !res.data || !res.data.length) return
        const result = res.data
          .filter(d => d.name && d.name !== '')
          .map(d => {
            const tier = R.getRankTier(d.name)
            if (!tier) return null
            const j = RANK_ORDER.indexOf(tier)
            return { tier, label: RANK_LABELS[tier], icon: RANK_ICONS[tier], iconIsImg: R.isRankIconImage(RANK_ICONS[tier]), count: d.value, color: RANK_COLORS[j >= 0 ? j : 0] }
          })
          .filter(Boolean)
          .sort((a, b) => b.count - a.count)
        this.setData({ rankDistribution: result }, () => {
          if (this._pieTimer) clearTimeout(this._pieTimer)
          this._pieTimer = setTimeout(() => { this.drawPieChart() }, 300)
        })
      }).catch(() => {})
    },

    drawPieChart() {
      const query = wx.createSelectorQuery().in(this)
      query.select('#rankPieCanvas').fields({ node: true, size: true }).exec((res) => {
        if (!res || !res[0] || !res[0].node) return
        const canvas = res[0].node
        const ctx = canvas.getContext('2d')
        const dpr = wx.getSystemInfoSync().pixelRatio
        const width = res[0].width
        const height = res[0].height
        canvas.width = width * dpr
        canvas.height = height * dpr
        ctx.scale(dpr, dpr)

        const data = this.data.rankDistribution
        if (!data.length) return

        const cx = width / 2, cy = height / 2
        const outerR = Math.min(cx, cy) - 8
        const innerR = outerR * 0.45

        let total = 0
        for (let i = 0; i < data.length; i++) total += data[i].count

        let startAngle = -Math.PI / 2
        for (let i = 0; i < data.length; i++) {
          const sweepAngle = (data[i].count / total) * Math.PI * 2
          ctx.beginPath()
          ctx.arc(cx, cy, outerR, startAngle, startAngle + sweepAngle)
          ctx.arc(cx, cy, innerR, startAngle + sweepAngle, startAngle, true)
          ctx.closePath()
          ctx.fillStyle = data[i].color
          ctx.fill()
          ctx.strokeStyle = '#0d1117'
          ctx.lineWidth = 1.5
          ctx.stroke()
          startAngle += sweepAngle
        }

        ctx.fillStyle = '#e6edf3'
        ctx.font = 'bold 14px sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText('共' + total + '人', cx, cy)
      })
    },

    // ====== 批量删除 ======
    toggleDeleteMode() {
      const mode = !this.data.deleteMode
      this.setData({ deleteMode: mode, selectedIds: {}, selectedCount: 0 })
      if (!mode) {
        this.setData({ showChart: false })
      }
    },

    onSelectCard(e) {
      if (!this.data.deleteMode) return
      const id = e.currentTarget.dataset.id
      const selected = this.data.selectedIds
      if (selected[id]) {
        delete selected[id]
      } else {
        selected[id] = true
      }
      this.setData({ selectedIds: selected, selectedCount: Object.keys(selected).length })
    },

    async batchDelete() {
      const ids = Object.keys(this.data.selectedIds)
      if (ids.length === 0) {
        modal.toast(this, { theme: 'warning', content: '请先选择要删除的选手' })
        return
      }
      const players = this.data.allPlayers
      const names = ids.map(id => {
        const p = players.find(pl => { return pl._id === id })
        return p ? p.wxNickname : id
      }).join('、')
      const r = await modal.confirm(this, {
        theme: 'danger',
        title: '批量删除',
        content: '确定删除以下 ' + ids.length + ' 名选手？\n\n' + names + '\n\n此操作不可恢复！'
      })
      if (r.confirm) this.doBatchDelete(ids)
    },

    async doBatchDelete(ids) {
      wx.showLoading({ title: '删除中...' })
      try {
        const res = await api.post('/players/batch-delete', { ids: ids })
        wx.hideLoading()
        if (res.success) {
          modal.toast(this, { theme: 'success', content: '已删除 ' + (res.deleted || ids.length) + ' 名选手' })
          this.setData({ deleteMode: false, selectedIds: {}, selectedCount: 0 })
          this.loadAllPlayers()
        } else {
          modal.toast(this, { theme: 'danger', content: res.error || res.message || '删除失败' })
        }
      } catch (err) {
        wx.hideLoading()
        console.error('批量删除失败', err)
        modal.toast(this, { theme: 'danger', content: '删除失败' })
      }
    },

    // ====== 批量导出 ======
    async doExport() {
      if (this._exporting) return; this._exporting = true
      wx.showLoading({ title: '导出中...' })
      try {
        const res = await api.get('/players/export/all')
        wx.hideLoading()

        if (!res) {
          modal.toast(this, { theme: 'danger', content: '服务器无响应' })
          return
        }
        if (!res.success) {
          modal.toast(this, { theme: 'danger', content: res.error || res.message || '导出失败' })
          return
        }
        const players = res.data
        if (!players || !Array.isArray(players) || players.length === 0) {
          modal.toast(this, { theme: 'default', content: '暂无选手数据' })
          return
        }

        const count = players.length
        const header = '微信群昵称,Steam ID,Dota2游戏昵称,核准段位,核准星数,擅长位置,报名位置'
        const escapeCSV = (v) => {
          const s = String(v == null ? '' : v)
          return s.indexOf(',') >= 0 || s.indexOf('"') >= 0 || s.indexOf('\n') >= 0 ? '"' + s.replace(/"/g, '""') + '"' : s
        }
        const rows = players.map(p => {
          const pos = Array.isArray(p.goodAtPositions) ? p.goodAtPositions.join(';') : (p.goodAtPositions || '')
          const sp = Array.isArray(p.signupPosition) ? p.signupPosition.join(';') : (p.signupPosition || '')
          return [p.wxNickname, p.steamId, p.gameId, p.calibrateRankName, p.calibrateRankStar, pos, sp].map(escapeCSV).join(',')
        })
        const csv = '\ufeff' + header + '\n' + rows.join('\n')

        let filePath = ''
        try {
          const fs = wx.getFileSystemManager()
          const userPath = (wx.env && wx.env.USER_DATA_PATH) || ''
          filePath = userPath + '/dota2_export_' + Date.now() + '.csv'
          fs.writeFileSync(filePath, csv, 'utf8')
        } catch (fileErr) {
          console.error('[导出] 文件写入失败:', fileErr)
          wx.setClipboardData({
            data: csv,
            success: () => {
              modal.toast(this, { theme: 'success', content: '已复制 ' + count + ' 条数据到剪贴板', duration: 2500 })
            },
            fail: () => {
              modal.toast(this, { theme: 'danger', content: '导出失败，请重试' })
            }
          })
          return
        }

        wx.nextTick(async () => {
          const modalRes = await modal.confirm(this, {
            theme: 'success',
            title: '导出成功',
            content: '共导出 ' + count + ' 名选手数据',
            confirmText: '打开文件',
            cancelText: '关闭'
          })
          if (modalRes.confirm && filePath) {
            wx.openDocument({
              filePath: filePath,
              showMenu: true,
              fail: (err) => {
                console.error('[导出] 打开文件失败:', err)
                modal.toast(this, { theme: 'warning', content: '打开失败，文件已保存' })
              }
            })
          }
        })
      } catch (err) {
        wx.hideLoading()
        console.error('[导出] 异常:', err)
        modal.toast(this, { theme: 'danger', content: '导出失败: ' + (err.message || '未知错误'), duration: 2500 })
      }
    }
  }
}
