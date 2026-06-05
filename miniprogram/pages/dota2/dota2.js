// pages/dota2/dota2.js
var db = null
var PAGE_SIZE = 15

Page({
  data: {
    allPlayers: [],
    filteredPlayers: [],
    filteredCount: 0,
    keyword: '',
    positionFilter: 'all',
    sortFilter: 'currentMmr-desc',
    loaded: false,
    hasMore: false,
    displayCount: 0 // 当前显示条数（分页用）
  },

  onLoad() {
    db = wx.cloud.database()
    this.loadAllPlayers()
  },

  onShow() {
    if (db) {
      this.loadAllPlayers()
    }
  },

  // 下拉刷新
  onPullDownRefresh() {
    this.loadAllPlayers().then(function() {
      wx.stopPullDownRefresh()
    })
  },

  // 上拉加载更多
  onReachBottom() {
    if (!this.data.loaded || !this.data.hasMore) return
    var count = this.data.displayCount + PAGE_SIZE
    var list = this.data.filteredPlayers
    var total = list.length
    this.setData({
      displayCount: Math.min(count, total),
      hasMore: count < total
    })
  },

  // 加载所有玩家（前端分页+筛选）
  async loadAllPlayers() {
    try {
      var all = []
      var res = await db.collection('dota2_players')
        .orderBy('createdAt', 'desc')
        .limit(20)
        .get()
      all = res.data || []

      // 分批加载全部
      var skip = 20
      while (res.data && res.data.length >= 20) {
        res = await db.collection('dota2_players')
          .orderBy('createdAt', 'desc')
          .skip(skip)
          .limit(20)
          .get()
        all = all.concat(res.data || [])
        skip += 20
      }

      this.setData({ allPlayers: all, loaded: true })
      this.filterPlayers()
    } catch (err) {
      console.error('加载失败', err)
      this.setData({ loaded: true })
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
  },

  // 关键词输入
  onKeywordInput(e) {
    this.setData({ keyword: e.detail.value.trim() })
    this.filterPlayers()
  },

  // 位置筛选
  onPosFilter(e) {
    this.setData({ positionFilter: e.currentTarget.dataset.pos })
    this.filterPlayers()
  },

  // 排序
  onSortFilter(e) {
    this.setData({ sortFilter: e.currentTarget.dataset.sort })
    this.filterPlayers()
  },

  // 筛选+排序+分页
  filterPlayers() {
    var list = this.data.allPlayers.slice()
    var kw = this.data.keyword.toLowerCase()
    var pos = this.data.positionFilter
    var sort = this.data.sortFilter

    // 关键词
    if (kw) {
      list = list.filter(function(p) {
        var name = (p.wxNickname || '').toLowerCase()
        var gid = (p.gameId || '').toLowerCase()
        return name.indexOf(kw) !== -1 || gid.indexOf(kw) !== -1
      })
    }

    // 位置
    if (pos !== 'all') {
      var posNum = parseInt(pos)
      list = list.filter(function(p) {
        return p.goodAtPositions && p.goodAtPositions.indexOf(posNum) !== -1
      })
    }

    // 排序
    if (sort === 'currentMmr-desc') {
      list.sort(function(a, b) { return (b.currentMmr || 0) - (a.currentMmr || 0) })
    } else if (sort === 'currentMmr-asc') {
      list.sort(function(a, b) { return (a.currentMmr || 0) - (b.currentMmr || 0) })
    }

    var displayCount = Math.min(PAGE_SIZE, list.length)
    this.setData({
      filteredPlayers: list,
      filteredCount: list.length,
      displayCount: displayCount,
      hasMore: list.length > PAGE_SIZE
    })
  },

  // 右上角菜单
  showMenu() {
    var that = this
    wx.showActionSheet({
      itemList: ['批量导入', '批量导出'],
      success: function(res) {
        if (res.tapIndex === 0) {
          that.goImport()
        } else if (res.tapIndex === 1) {
          that.doExport()
        }
      }
    })
  },

  // 跳转添加
  goAdd() {
    wx.navigateTo({ url: '/pages/dota2-add/dota2-add' })
  },

  // 跳转详情
  goDetail(e) {
    var id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/dota2-detail/dota2-detail?id=' + id })
  },

  // 跳转导入
  goImport() {
    wx.navigateTo({ url: '/pages/dota2-import/dota2-import' })
  },

  // 批量导出
  async doExport() {
    wx.showLoading({ title: '导出中...' })
    try {
      var res = await wx.cloud.callFunction({
        name: 'batchExport'
      })
      wx.hideLoading()

      if (res.result.success) {
        var url = res.result.tempFileURL
        var count = res.result.count
        wx.showModal({
          title: '导出成功',
          content: '共导出 ' + count + ' 名选手数据，是否下载文件？',
          success: function(modalRes) {
            if (modalRes.confirm) {
              wx.downloadFile({
                url: url,
                success: function(dlRes) {
                  if (dlRes.statusCode === 200) {
                    wx.openDocument({
                      filePath: dlRes.tempFilePath,
                      showMenu: true
                    })
                  }
                }
              })
            }
          }
        })
      } else {
        wx.showToast({ title: res.result.message || '导出失败', icon: 'none' })
      }
    } catch (err) {
      wx.hideLoading()
      console.error('导出失败', err)
      wx.showToast({ title: '导出失败', icon: 'none' })
    }
  }
})
