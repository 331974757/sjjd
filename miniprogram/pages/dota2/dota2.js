// pages/dota2/dota2.js
const perm = require('../../utils/permission.js')
const R = require('../../utils/rank-utils.js')
const C = require('../../utils/constants.js')

const RANK_ORDER = R.RANK_ORDER
const RANK_ICONS = R.RANK_ICONS
const RANK_LABELS = R.RANK_LABELS
const RANK_COLORS = R.RANK_COLORS

Page({
  data: {
    currentGame: 'dota2',
    allPlayers: [],
    filteredPlayers: [],
    displayPlayers: [],
    positionFilter: 'all',
    rankFilter: 'all',
    sortFilter: 'rank-desc',
    loaded: false,
    userInfo: { avatarUrl: '' },
    nickName: '',
    nickChangeCount: 0,
    nickChangeLimit: C.NICK_CHANGE_LIMIT,
    unlimitedNick: false,
    userRole: '',
    isAdmin: false,
    showNickModal: false,
    showAdminModal: false,
    nickInputValue: '',
    pageSize: C.PAGE_SIZE,
    morePageSize: C.MORE_PAGE_SIZE,
    hasMore: false,
    loadingMore: false,
    superAdminNames: [],
    _superAdminOnly: [],
    _adminOnly: [],
    showChart: false,
    rankDistribution: [],
    deleteMode: false,
    selectedIds: {},
    selectedCount: 0,
    statusBarHeight: 44,
    _searchText: '',
  },

  onLoad() {
    const sysInfo = wx.getSystemInfoSync()
    this.setData({ statusBarHeight: sysInfo.statusBarHeight || 44 })
    this.loadNickname()
    this.loadUserInfo()
    this.loadAllPlayers()
    this.loadSuperAdminInfo()
  },

  onShow() {
    // 从其他页面返回时仅刷新昵称，不重新拉取数据（除非标记为脏）
    if (this._needsReload) {
      this._needsReload = false
      this.loadAllPlayers()
    }
    // 始终检查昵称变更（可能在管理员页面被重置）
    if (this.data.loaded) {
      this.fetchNicknameInfo()
    }
  },

  loadUserInfo() {
    try {
      const info = wx.getStorageSync('user_info') || {}
      if (info.avatarUrl) {
        this.setData({ userInfo: info })
      }
    } catch(e) {}
  },

  // 加载管理员信息（公开接口，供用户联系）
  async loadSuperAdminInfo() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'manageUser',
        data: { action: 'getSuperAdminInfo' }
      })
      if (res.result.success && res.result.data) {
        const list = res.result.data
        const superAdmins = []
        const admins = []
        list.forEach(u => {
          const name = u.nickName || '未设置昵称'
          if (u.role === 'super_admin') {
            superAdmins.push(name)
          } else if (u.role === 'admin') {
            admins.push(name)
          }
        })
        const allNames = superAdmins.concat(admins)
        this.setData({
          superAdminNames: allNames,
          _superAdminOnly: superAdmins,
          _adminOnly: admins
        })
        return allNames
      }
    } catch (err) {
      console.error('加载超管信息失败', err)
    }
    return []
  },

  // 点击管理栏弹出说明
  async showSuperAdminInfo() {
    wx.showLoading({ title: '查询中...' })
    if (this.data.superAdminNames.length === 0) {
      await this.loadSuperAdminInfo()
    }
    wx.hideLoading()
    this.setData({ showAdminModal: true })
  },
  closeAdminModal() {
    this.setData({ showAdminModal: false })
  },

  // 加载昵称和修改次数（首次用本地缓存，异步拉服务端最新值）
  loadNickname() {
    const nick = perm.getNickName() || ''
    this.setData({ nickName: nick })
    // 异步从服务端拉取最新 nickName + nickChangeCount
    this.fetchNicknameInfo()
  },

  async fetchNicknameInfo() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'manageUser',
        data: { action: 'checkRole' }
      })
      if (res.result.success) {
        const serverNick = res.result.nickName || ''
        const count = res.result.nickChangeCount || 0
        const role = res.result.role || 'user'
        // 注入 perm 缓存，后续页面切换不再重复调云函数
        perm.setCache(role)
        // 服务端有昵称而本地没有，说明其他设备设置过，同步到本地
        if (serverNick && serverNick !== this.data.nickName) {
          perm.saveNickName(serverNick)
        }
        const isManager = role === 'super_admin' || role === 'admin'
        this.setData({
          nickName: serverNick || this.data.nickName,
          nickChangeCount: count,
          userRole: role,
          isAdmin: isManager,
          unlimitedNick: isManager
        })

        // 未设置昵称 → 自动弹出昵称设置弹窗
        if (!serverNick) {
          this.setData({
            nickName: '',
            showNickModal: true,
            nickInputValue: ''
          })
        }
      }
    } catch (err) {
      console.error('获取昵称信息失败', err)
    }
  },

  // 点击修改昵称 → 始终打开弹窗（次数用完在弹窗内提示）
  editNickname() {
    const currentNick = this.data.nickName
    this.setData({
      showNickModal: true,
      nickInputValue: currentNick || ''
    })
  },

  // 关闭昵称弹窗
  closeNickModal() {
    this.setData({ showNickModal: false, nickInputValue: '' })
  },

  // 输入框内容变化
  onNickInput(e) {
    this.setData({ nickInputValue: e.detail.value })
  },

  // 弹窗内点击保存
  saveNickFromModal() {
    const newNick = this.data.nickInputValue.trim()
    const currentNick = this.data.nickName

    // 非管理员且次数用完 → 拦截保存
    if (currentNick && !this.data.unlimitedNick && this.data.nickChangeCount >= this.data.nickChangeLimit) {
      const names = this.data.superAdminNames
      wx.showToast({
        title: '修改次数已用完，请联系超级管理员重置' + (names.length > 0 ? '：' + names.join('、') : ''),
        icon: 'none',
        duration: 3000
      })
      return
    }

    if (!newNick) {
      wx.showToast({ title: '昵称不能为空', icon: 'none' })
      return
    }
    if (newNick === currentNick) {
      this.closeNickModal()
      return
    }
    this.closeNickModal()
    this.doSaveNickname(newNick)
  },

  // 防止弹窗背景滚动
  preventMove() {},

  // 调用云函数保存昵称
  async doSaveNickname(newNick) {
    wx.showLoading({ title: '保存中...' })
    try {
      const res = await wx.cloud.callFunction({
        name: 'manageUser',
        data: { action: 'checkRole', nickName: newNick }
      })
      wx.hideLoading()

      if (res.result.success) {
        perm.saveNickName(newNick)
        const newCount = res.result.nickChangeCount || 0
        this.setData({
          nickName: newNick,
          nickChangeCount: newCount
        })
        setTimeout(() => { wx.showToast({ title: '昵称已更新', icon: 'success' }) }, 300)
      } else {
        // 可能是超限被后端拒绝，刷新次数
        if (res.result.nickChangeCount !== undefined) {
          this.setData({ nickChangeCount: res.result.nickChangeCount })
        }
        setTimeout(() => { wx.showToast({ title: res.result.message || '修改失败', icon: 'none', duration: 2500 }) }, 300)
      }
    } catch (err) {
      wx.hideLoading()
      console.error('保存昵称失败', err)
      setTimeout(() => { wx.showToast({ title: '保存失败', icon: 'none' }) }, 300)
    }
  },

  onPullDownRefresh() {
    this.loadAllPlayers().then(() => {
      wx.stopPullDownRefresh()
    })
  },

  // 滚到底部加载更多
  onReachBottom() {
    this.loadMore()
  },

  // ====== 数据加载（分页拉取全部数据） ======
  async loadAllPlayers() {
    if (this._loading) return
    this._loading = true
    try {
      const all = []
      const batchSize = C.BATCH_LOAD_SIZE
      let skipCount = 0
      const db = wx.cloud.database()
      while (true) {
        const res = await db.collection('dota2_players')
          .orderBy('_id', 'asc')
          .skip(skipCount)
          .limit(batchSize)
          .get()
        const batch = res.data || []
        if (batch.length === 0) break
        all.push.apply(all, batch)
        skipCount += batch.length
      }

      console.log('[loadAllPlayers] 共加载 ' + all.length + ' 条数据')
      this.setData({
        allPlayers: all,
        loaded: true
      })
      this.filterAndDisplay()
    } catch (err) {
      console.error('加载失败', err)
      this.setData({ loaded: true })
      wx.showToast({ title: '加载失败', icon: 'none' })
    } finally {
      this._loading = false
    }
  },

  // 从已排序的 filteredPlayers 中追加更多到 displayPlayers
  loadMore() {
    if (this.data.loadingMore || !this.data.hasMore) return
    this.setData({ loadingMore: true })

    const filtered = this.data.filteredPlayers
    const current = this.data.displayPlayers
    const moreSize = this.data.morePageSize
    const nextItems = filtered.slice(current.length, current.length + moreSize)

    if (nextItems.length > 0) {
      this.setData({
        displayPlayers: current.concat(nextItems),
        loadingMore: false,
        hasMore: current.length + nextItems.length < filtered.length
      })
    } else {
      this.setData({
        loadingMore: false,
        hasMore: false
      })
    }
  },

  // ====== 搜索 & 筛选 ======
  // 搜索输入存到内部变量，同步到 data 供 wxml 显示清除按钮
  onKeywordInput(e) {
    const val = e.detail.value || ''
    this._searchText = val
    this.setData({ _searchText: val })
    if (this._searchTimer) clearTimeout(this._searchTimer)
    this._searchTimer = setTimeout(() => {
      this.filterAndDisplay()
    }, 300)
  },

  onSearchConfirm(e) {
    if (this._searchTimer) clearTimeout(this._searchTimer)
    const val = e.detail.value || ''
    this._searchText = val
    this.setData({ _searchText: val })
    this.filterAndDisplay()
  },

  clearSearch() {
    this._searchText = ''
    this.setData({ _searchText: '' })
    this.filterAndDisplay()
  },

  onPosFilter(e) {
    this.setData({ positionFilter: e.currentTarget.dataset.pos })
    this.filterAndDisplay()
  },

  onRankFilter(e) {
    this.setData({ rankFilter: e.currentTarget.dataset.rank })
    this.filterAndDisplay()
  },

  onSortFilter(e) {
    this.setData({ sortFilter: e.currentTarget.dataset.sort })
    this.filterAndDisplay()
  },

  switchGame(e) {
    const game = e.currentTarget.dataset.game
    if (game === this.data.currentGame) return
    if (game === 'cs2') {
      wx.showToast({ title: '暂未开放，敬请期待', icon: 'none' })
      return
    }
    this.setData({ currentGame: game })
  },


  // 筛选 + 排序 + 显示
  filterAndDisplay() {
    let list = this.data.allPlayers.slice()
    const kw = (this._searchText || '').toLowerCase()
    const pos = this.data.positionFilter
    const rank = this.data.rankFilter
    const sort = this.data.sortFilter

    // 关键词搜索
    if (kw) {
      list = list.filter(p => {
        const name = (p.wxNickname || '').toLowerCase()
        const gid = (p.gameId || '').toLowerCase()
        return name.indexOf(kw) !== -1 || gid.indexOf(kw) !== -1
      })
    }

    // 位置筛选
    if (pos !== 'all') {
      const posNum = parseInt(pos)
      list = list.filter(p => {
        return p.goodAtPositions && p.goodAtPositions.indexOf(posNum) !== -1
      })
    }

    // 段位筛选
    if (rank !== 'all') {
      list = list.filter(p => {
        return R.getRankTier(p.calibrateRankName) === rank
      })
    }

    // 排序（按 calibrateRankSort 数值，越大段位越高）
    if (sort === 'rank-desc') {
      list.sort((a, b) => { return (b.calibrateRankSort || 0) - (a.calibrateRankSort || 0) })
    } else if (sort === 'rank-asc') {
      list.sort((a, b) => { return (a.calibrateRankSort || 0) - (b.calibrateRankSort || 0) })
    }

    for (let i = 0; i < list.length; i++) {
      const icon = R.getRankIcon(list[i].calibrateRankName)
      list[i]._rankIcon = icon
      list[i]._rankIconIsImg = R.isRankIconImage(icon)
    }

    // 全量排序后存入 filteredPlayers，displayPlayers 只取前 pageSize 条
    const pageSize = this.data.pageSize
    const firstPage = list.slice(0, pageSize)

    this.setData({
      filteredPlayers: list,
      displayPlayers: firstPage,
      filteredCount: list.length,
      hasMore: list.length > pageSize
    })
  },

  // ====== 导航 ======
  goAdd() {
    if (!this.data.isAdmin) {
      const names = this.data.superAdminNames.join('、')
      wx.showModal({
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

  // ⚙ 管理员菜单（导入/导出/批量删除/管理员设置）
  showAdminMenu() {
    const isSuper = this.data.userRole === 'super_admin'
    const items = ['批量导入', '批量导出', '批量删除选手']
    if (isSuper) items.push('权限管理')
    wx.showActionSheet({
      itemList: items,
      success: (res) => {
        if (res.tapIndex === 0) { this.goImport() }
        else if (res.tapIndex === 1) { this.doExport() }
        else if (res.tapIndex === 2) { this.toggleDeleteMode() }
        else if (res.tapIndex === 3) { this.goAdmin() }
      }
    })
  },

  // 跳转管理员页面
  goAdmin() {
    this._needsReload = true
    wx.navigateTo({ url: '/pages/admin/admin' })
  },

  // ====== 段位分布饼图 ======
  toggleChart() {
    const show = !this.data.showChart
    this.setData({ showChart: show })
    if (show) {
      this.computeRankDistribution()
      if (this._pieTimer) clearTimeout(this._pieTimer)
      this._pieTimer = setTimeout(() => { this.drawPieChart() }, 300)
    }
  },

  computeRankDistribution() {
    const all = this.data.allPlayers
    const dist = {}
    for (let i = 0; i < all.length; i++) {
      const tier = R.getRankTier(all[i].calibrateRankName) || 'unknown'
      if (!dist[tier]) dist[tier] = 0
      dist[tier]++
    }
    // 按段位从高到低排序（先构建，再按人数降序排列用于图例）
    const result = []
    const RANK_COLORS_MAP = {}
    for (let j = 0; j < RANK_ORDER.length; j++) {
      RANK_COLORS_MAP[RANK_ORDER[j]] = RANK_COLORS[j]
    }
    for (let j = 0; j < RANK_ORDER.length; j++) {
      const key = RANK_ORDER[j]
      if (dist[key]) {
        const ico = RANK_ICONS[key]
        result.push({ tier: key, label: RANK_LABELS[key], icon: ico, iconIsImg: R.isRankIconImage(ico), count: dist[key], color: RANK_COLORS_MAP[key] })
      }
    }
    if (dist['unknown']) {
      result.push({ tier: 'unknown', label: '未定段位', icon: '❓', count: dist['unknown'], color: '#666' })
    }
    // 保持段位从高到低排序（冠绝→先锋），不按人数排序
    this.setData({ rankDistribution: result })
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

      // 绘制扇形（不显示内部数字）
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

      // 中心文字
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

  batchDelete() {
    const ids = Object.keys(this.data.selectedIds)
    if (ids.length === 0) {
      wx.showToast({ title: '请先选择要删除的选手', icon: 'none' })
      return
    }
    // 构建删除名单详情
    const players = this.data.allPlayers
    const names = ids.map(id => {
      const p = players.find(pl => { return pl._id === id })
      return p ? p.wxNickname : id
    }).join('、')
    wx.showModal({
      title: '批量删除',
      content: '确定删除以下 ' + ids.length + ' 名选手？\n\n' + names + '\n\n此操作不可恢复！',
      confirmColor: '#da3633',
      success: (res) => {
        if (res.confirm) this.doBatchDelete(ids)
      }
    })
  },

  async doBatchDelete(ids) {
    wx.showLoading({ title: '删除中...' })
    try {
      const res = await wx.cloud.callFunction({
        name: 'managePlayer',
        data: { action: 'batchDelete', ids: ids }
      })
      wx.hideLoading()
      if (res.result.success) {
        setTimeout(() => { wx.showToast({ title: '已删除 ' + (res.result.deleted || ids.length) + ' 名选手', icon: 'success' }) }, 300)
        this.setData({ deleteMode: false, selectedIds: {}, selectedCount: 0 })
        this.loadAllPlayers()
      } else {
        setTimeout(() => { wx.showToast({ title: res.result.message || '删除失败', icon: 'none' }) }, 300)
      }
    } catch (err) {
      wx.hideLoading()
      console.error('批量删除失败', err)
      setTimeout(() => { wx.showToast({ title: '删除失败', icon: 'none' }) }, 300)
    }
  },

  // ====== 分享 ======
  onShareAppMessage() {
    return {
      title: '蜀军战力排行 - 看看大家的Dota2段位！',
      path: '/pages/dota2/dota2'
    }
  },

  // 批量导出
  async doExport() {
    wx.showLoading({ title: '导出中...' })
    try {
      const res = await wx.cloud.callFunction({ name: 'batchExport' })
      wx.hideLoading()
      if (res.result.success) {
        const url = res.result.tempFileURL
        const count = res.result.count
        setTimeout(() => {
          wx.showModal({
            title: '导出成功',
            content: '共导出 ' + count + ' 名选手数据，是否下载文件？',
            success: (modalRes) => {
              if (modalRes.confirm) {
                wx.downloadFile({
                  url: url,
                  success: (dlRes) => {
                    if (dlRes.statusCode === 200) {
                      wx.openDocument({ filePath: dlRes.tempFilePath, showMenu: true })
                    }
                  }
                })
              }
            }
          })
        }, 300)
      } else {
        setTimeout(() => { wx.showToast({ title: res.result.message || '导出失败', icon: 'none' }) }, 300)
      }
    } catch (err) {
      wx.hideLoading()
      console.error('导出失败', err)
      setTimeout(() => { wx.showToast({ title: '导出失败', icon: 'none' }) }, 300)
    }
  }
})





