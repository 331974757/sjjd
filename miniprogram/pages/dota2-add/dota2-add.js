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
    // 恢复草稿
    try {
      const draft = wx.getStorageSync('dota2_add_draft')
      if (draft) {
        this.setData(draft)
        wx.removeStorageSync('dota2_add_draft')
      }
    } catch (_) {}
    this.checkAccess()
  },

  onUnload() {
    // 有内容时保存草稿
    const { wxNickname, gameId, steamId, calibrateMmr } = this.data
    if (wxNickname || gameId || steamId || calibrateMmr) {
      try {
        wx.setStorageSync('dota2_add_draft', {
          wxNickname: this.data.wxNickname,
          gameId: this.data.gameId,
          steamId: this.data.steamId,
          calibrateMmr: this.data.calibrateMmr,
          calibrateRankName: this.data.calibrateRankName,
          calibrateRankStar: this.data.calibrateRankStar,
          goodAtPositions: this.data.goodAtPositions,
          signupPosition: this.data.signupPosition,
          avatarUrl: this.data.avatarUrl
        })
      } catch (_) {}
    }
  },

  async checkAccess() {
    try {
      const isAdmin = await perm.isAdmin()
      if (isAdmin) {
        this.setData({ accessChecked: true, accessDenied: false, isAdmin: true })
        return
      }
      // 普通用户：检查是否可自建档案
      const res = await api.get('/users/me')
      if (!res.success) {
        this.setData({ accessChecked: true, accessDenied: true })
        modal.toast(this, { title: '网络异常，请重试', icon: 'none' })
        setTimeout(() => { wx.navigateBack() }, 1500)
        return
      }
      if (res.hasCreatedPlayer) {
        this.setData({ accessChecked: true, accessDenied: true })
        modal.toast(this, { title: '您已创建过选手档案', icon: 'none' })
        setTimeout(() => { wx.navigateBack() }, 1500)
        return
      }
      this.setData({ accessChecked: true, accessDenied: false, isAdmin: false })
      if (res.nickName) this.setData({ wxNickname: res.nickName })
      setTimeout(() => { wx.navigateBack() }, 1500)
    } catch (err) {
      console.error('权限检查失败', err)
      this.setData({ accessChecked: true, accessDenied: true })
      modal.toast(this, { title: '权限检查失败，请重试', icon: 'none' })
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
                modal.toast(this, { title: '头像上传失败', icon: 'none' })
              }
            } catch (e) {
              modal.toast(this, { title: '头像上传失败', icon: 'none' })
            }
          },
          fail: () => {
            modal.toast(this, { title: '头像上传失败', icon: 'none' })
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
      modal.toast(this, { title: '请输入微信群昵称', icon: 'none' })
      return
    }
    if (!gameId) {
      modal.toast(this, { title: '请输入Dota2游戏昵称', icon: 'none' })
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
      modal.toast(this, { title: '请选择核准段位', icon: 'none' })
      return
    }
    // 验证非冠绝时必须选星数
    const isEmperor = this.data.rankIndex === RANK_OPTIONS.length - 1
    if (!isEmperor && this.data.rankStars <= 0) {
      modal.toast(this, { title: '请选择核准星数', icon: 'none' })
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
        modal.toast(this, { title: msg, icon: 'success' })
        setTimeout(() => { wx.navigateBack() }, 800)
      } else {
        modal.toast(this, { title: res.error || res.message || '添加失败', icon: 'none' })
      }
    } catch (err) {
      console.error('添加失败', err)
      modal.toast(this, { title: '添加失败', icon: 'none' })
    } finally {
      this.setData({ submitting: false })
    }
  },

  // 通知首页下次 onShow 时刷新数据
  _notifyHomeRefresh() {
    try {
      const pages = getCurrentPages()
      const homePage = pages.find(p => p && p.route && p.route.indexOf('pages/index/index') !== -1)
      if (homePage && typeof homePage.loadAllPlayers === 'function') {
        homePage._needsReload = true
      }
    } catch (_) {
      // 页面栈异常时静默降级
    }
  }
})
