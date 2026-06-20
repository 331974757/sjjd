// pages/dota2-add/dota2-add.js
const perm = require('../../utils/permission.js')
const R = require('../../utils/rank-utils.js')
const api = require('../../utils/api.js')
const modal = require('../../utils/modal.js')

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
    calibrateMmr: '',       // 实际天梯分(可选)
    rankDisplay: '请选择核准段位',
    selectedPos: { 1: false, 2: false, 3: false, 4: false, 5: false },
    signupPos: { 1: false, 2: false, 3: false, 4: false, 5: false },
    submitting: false,
    accessChecked: false,
    accessDenied: false
  },

  onLoad() {
    this.checkAccess()
  },

  async checkAccess() {
    try {
      const isAdmin = await perm.isAdmin()
      if (!isAdmin) {
        this.setData({ accessChecked: true, accessDenied: true })
        modal.confirm(this, {
          theme: 'warning',
          title: '仅管理员可添加选手',
          content: '请联系管理员添加选手',
          showCancel: false
        })
        wx.navigateBack()
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
        const uploadUrl = api.API_BASE + '/upload'
        wx.uploadFile({
          url: uploadUrl,
          filePath: tempPath,
          name: 'file',
          header: api.getUploadHeaders(),
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

  // 点击段位（直接选中）
  onPickRank(e) {
    const idx = parseInt(e.currentTarget.dataset.index)
    if (isNaN(idx) || idx < 0 || idx >= RANK_OPTIONS.length) return
    const rankName = RANK_OPTIONS[idx]
    if (idx === 7) {
      // 冠绝一世无星
      this.setData({ rankIndex: idx, rankStars: 0, rankDisplay: '冠绝一世' })
    } else {
      // 换段位时重置星数
      this.setData({ rankIndex: idx, rankStars: 0, rankDisplay: rankName + ' ?★' })
    }
  },

  // 点击星数（直接选中）
  onPickStar(e) {
    const star = parseInt(e.currentTarget.dataset.star)
    if (isNaN(star) || star < 1 || star > 5) return
    const rankName = RANK_OPTIONS[this.data.rankIndex]
    this.setData({ rankStars: star, rankDisplay: rankName + star + '★' })
  },

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
        calibrateMmr: this.data.calibrateMmr ? parseInt(this.data.calibrateMmr) : null,
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
    // 【修复】使用 find 查找首页，避免硬编码索引
    const homePage = pages.find(p => p.route && p.route.indexOf('pages/index/index') !== -1)
    if (homePage && homePage.loadAllPlayers) {
      homePage._needsReload = true
    }
  }
})
