// pages/dota2-add/dota2-add.js
const perm = require('../../utils/permission.js')
const R = require('../../utils/rank-utils.js')
const api = require('../../utils/api.js')

// 段位选项（与详情页保持一致）
const RANK_OPTIONS = R.RANK_OPTIONS

Page({
  data: {
    avatarUrl: '',
    wxNickname: '',
    steamId: '',
    gameId: '',
    rankIndex: -1,
    rankStars: 0,
    rankDisplay: '请选择核准段位',
    selectedPos: { 1: false, 2: false, 3: false, 4: false, 5: false },
    signupPos: { 1: false, 2: false, 3: false, 4: false, 5: false },
    submitting: false,
    accessChecked: false,
    accessDenied: false,
    // 段位弹窗
    showRankModal: false,
    rankPickedIndex: -1,
    starPickedIndex: -1
  },

  onLoad() {
    this.checkAccess()
  },

  async checkAccess() {
    try {
      const isAdmin = await perm.isAdmin()
      if (!isAdmin) {
        this.setData({ accessChecked: true, accessDenied: true })
        wx.showModal({
          title: '仅管理员可添加选手',
          content: '请联系管理员添加选手',
          showCancel: false,
          success: () => {
            wx.navigateBack()
          }
        })
      } else {
        this.setData({ accessChecked: true, accessDenied: false })
      }
    } catch (err) {
      console.error('权限检查失败', err)
      this.setData({ accessChecked: true, accessDenied: true })
      wx.showToast({ title: '权限检查失败，请重试', icon: 'none' })
      setTimeout(() => { wx.navigateBack() }, 1500)
    }
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field
    const obj = {}
    obj[field] = e.detail.value
    this.setData(obj)
  },

  // 选择头像
  chooseAvatar() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const tempPath = res.tempFiles[0].tempFilePath
        wx.showLoading({ title: '上传中...' })
        const app = getApp()
        const openid = app.globalData.openid || ''
        const uploadUrl = api.API_BASE + '/upload' + (openid ? '?openid=' + openid : '')
        wx.uploadFile({
          url: uploadUrl,
          filePath: tempPath,
          name: 'file',
          success: (uploadRes) => {
            try {
              const data = JSON.parse(uploadRes.data)
              if (data.success && data.data) {
                this.setData({ avatarUrl: api.API_BASE.replace(/\/api$/, '') + data.data.url })
              } else {
                wx.showToast({ title: '头像上传失败', icon: 'none' })
              }
            } catch (e) {
              wx.showToast({ title: '头像上传失败', icon: 'none' })
            }
          },
          fail: () => {
            wx.showToast({ title: '头像上传失败', icon: 'none' })
          },
          complete: () => { wx.hideLoading() }
        })
      }
    })
  },

  togglePos(e) {
    const pos = e.currentTarget.dataset.pos
    const key = 'selectedPos.' + pos
    const obj = {}
    obj[key] = !this.data.selectedPos[pos]
    this.setData(obj)
  },

  toggleSignup(e) {
    const pos = e.currentTarget.dataset.pos
    const key = 'signupPos.' + pos
    const obj = {}
    obj[key] = !this.data.signupPos[pos]
    this.setData(obj)
  },

  // 打开段位弹窗
  openRankModal() {
    const idx = this.data.rankIndex
    const star = this.data.rankStars
    this.setData({
      showRankModal: true,
      rankPickedIndex: idx >= 0 ? idx : -1,
      starPickedIndex: idx >= 0 && idx < 7 && star > 0 ? star - 1 : -1
    })
  },

  // 关闭段位弹窗
  closeRankModal() {
    this.setData({ showRankModal: false, rankPickedIndex: -1, starPickedIndex: -1 })
  },

  // 点击段位
  pickRank(e) {
    const idx = parseInt(e.currentTarget.dataset.index)
    if (isNaN(idx) || idx < 0 || idx >= RANK_OPTIONS.length) return
    this.setData({ rankPickedIndex: idx, starPickedIndex: -1 })
  },

  // 点击星数
  pickStar(e) {
    const idx = parseInt(e.currentTarget.dataset.index)
    if (isNaN(idx) || idx < 0 || idx > 4) return
    this.setData({ starPickedIndex: idx })
  },

  // 确认段位+星数
  confirmRankStar() {
    const rankIdx = this.data.rankPickedIndex
    if (rankIdx < 0) return

    const rankName = RANK_OPTIONS[rankIdx]

    if (rankIdx === 7) {
      // 冠绝一世无星
      this.setData({
        showRankModal: false,
        rankPickedIndex: -1,
        starPickedIndex: -1,
        rankIndex: rankIdx,
        rankStars: 0,
        rankDisplay: '冠绝一世'
      })
      return
    }

    const starIdx = this.data.starPickedIndex
    if (starIdx < 0) {
      wx.showToast({ title: '请选择星数', icon: 'none' })
      return
    }
    const star = starIdx + 1

    this.setData({
      showRankModal: false,
      rankPickedIndex: -1,
      starPickedIndex: -1,
      rankIndex: rankIdx,
      rankStars: star,
      rankDisplay: rankName + star + '★'
    })
  },

  preventMove() {},

  async onSubmit() {
    if (this.data.submitting) return

    const wxNickname = this.data.wxNickname.trim()
    const gameId = this.data.gameId.trim()

    if (!wxNickname) {
      wx.showToast({ title: '请输入微信群昵称', icon: 'none' })
      return
    }
    if (!gameId) {
      wx.showToast({ title: '请输入Dota2游戏昵称', icon: 'none' })
      return
    }

    // 收集擅长位置
    const goodAtPositions = []
    for (let i = 1; i <= 5; i++) {
      if (this.data.selectedPos[i]) goodAtPositions.push(i)
    }
    goodAtPositions.sort()

    // 收集报名位置
    const signupPosition = []
    for (let j = 1; j <= 5; j++) {
      if (this.data.signupPos[j]) signupPosition.push(j)
    }

    // 验证段位必选
    if (this.data.rankIndex < 0) {
      wx.showToast({ title: '请选择核准段位', icon: 'none' })
      return
    }
    // 验证非冠绝时必须选星数
    const isEmperor = this.data.rankIndex === RANK_OPTIONS.length - 1
    if (!isEmperor && this.data.rankStars <= 0) {
      wx.showToast({ title: '请选择核准星数', icon: 'none' })
      return
    }

    const rankTitle = RANK_OPTIONS[this.data.rankIndex]

    this.setData({ submitting: true })

    try {
      const res = await api.post('/players', {
        avatarUrl: this.data.avatarUrl || '',
        wxNickname: wxNickname,
        steamId: this.data.steamId.trim(),
        gameId: gameId,
        calibrateRankName: rankTitle,
        calibrateRankStar: this.data.rankStars,
        goodAtPositions: goodAtPositions,
        signupPosition: signupPosition
      })

      if (res.success) {
        // 通知首页强制刷新
        this._notifyHomeRefresh()
        const action = res.action
        const msg = action === 'updated' ? '已更新已有选手信息' : '添加成功！'
        wx.showToast({ title: msg, icon: 'success' })
        setTimeout(() => { wx.navigateBack() }, 800)
      } else {
        wx.showToast({ title: res.message || '添加失败', icon: 'none' })
      }
    } catch (err) {
      console.error('添加失败', err)
      wx.showToast({ title: '添加失败', icon: 'none' })
    } finally {
      this.setData({ submitting: false })
    }
  },

  // 通知首页下次 onShow 时刷新数据
  _notifyHomeRefresh() {
    const pages = getCurrentPages()
    const homePage = pages[pages.length - 2]
    if (homePage && homePage.loadAllPlayers) {
      homePage._needsReload = true
    }
  }
})
