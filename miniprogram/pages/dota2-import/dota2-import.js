// pages/dota2-import/dota2-import.js
const perm = require('../../utils/permission.js')
const api = require('../../utils/api.js')
const COLUMN_MAP = [
  { name: '微信群昵称', field: 'wxNickname', required: true, hint: '' },
  { name: 'Steam ID', field: 'steamId', required: false, hint: '选填' },
  { name: 'Dota2游戏昵称', field: 'gameId', required: true, hint: '' },
  { name: '核准段位', field: 'calibrateRankName', required: false, hint: '' },
  { name: '核准星数', field: 'calibrateRankStar', required: false, hint: '填写数字' },
  { name: '擅长游戏位置', field: 'goodAtPositions', required: false, hint: '填1~5数字，逗号分隔' },
  { name: '比赛报名位置', field: 'signupPosition', required: false, hint: '填1~5数字，逗号分隔' }
]

const TEMPLATE_HEADER = '微信群昵称\tSteam ID\tDota2游戏昵称\t核准段位\t核准星数\t擅长游戏位置\t比赛报名位置'
const TEMPLATE_ROW = '示例选手\t123456789\tDota2示例昵称\t统帅\t3\t1,2,3\t1'

Page({
  async onLoad() {
    try {
      const isAdmin = await perm.isAdmin()
      if (!isAdmin) {
        this.setData({ accessChecked: true, accessDenied: true })
        wx.showModal({
          title: '仅管理员可导入',
          content: '请联系管理员操作',
          showCancel: false,
          success: () => { wx.navigateBack() }
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

  data: {
    columns: COLUMN_MAP,
    parsedData: [],
    errorRows: [],
    importing: false,
    importedCount: 0,
    replacedCount: 0,
    failCount: 0,
    importDone: false,
    fileName: '',
    filePath: '',
    isXlsx: false,
    accessChecked: false,
    accessDenied: false
  },

  // 获取导入模板：优先下载 Excel 文件，失败时回退到剪贴板
  downloadTemplate() {
    wx.showLoading({ title: '生成模板中...' })

    const templateUrl = api.API_BASE + '/players/template/xlsx'
    wx.downloadFile({
      url: templateUrl,
      timeout: 10000,  // 与 wx.request 超时保持一致
      success: (res) => {
        wx.hideLoading()
        if (res.statusCode === 200 && res.tempFilePath) {
          // 下载成功，自动打开 Excel 文件
          wx.openDocument({
            filePath: res.tempFilePath,
            showMenu: true,
            success: () => {
              wx.showToast({ title: '模板已打开', icon: 'success' })
            },
            fail: () => {
              wx.showToast({ title: '模板已下载，请到文件管理查看', icon: 'none', duration: 2500 })
            }
          })
        } else {
          // 服务器返回非 200 → 回退剪贴板
          this._fallbackToClipboard()
        }
      },
      fail: () => {
        wx.hideLoading()
        // 下载失败 → 回退剪贴板
        this._fallbackToClipboard()
      }
    })
  },

  // 回退方案：复制模板到剪贴板
  _fallbackToClipboard() {
    const content = TEMPLATE_HEADER + '\n' + TEMPLATE_ROW
    wx.setClipboardData({
      data: content,
      success: () => {
        wx.showModal({
          title: '已复制到剪贴板',
          content: '请打开一个空白 Excel，直接粘贴（Ctrl+V）即可自动分列，然后另存为 .xlsx 格式上传。',
          showCancel: false,
          confirmText: '知道了'
        })
      },
      fail: () => {
        wx.showToast({ title: '复制失败，请手动输入', icon: 'none' })
      }
    })
  },

  pickFile() {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['csv', 'xlsx', 'json'],
      success: (res) => {
        const file = res.tempFiles[0]
        const name = file.name.toLowerCase()
        const isXlsx = name.endsWith('.xlsx')

        this.setData({
          fileName: file.name,
          filePath: file.path,
          isXlsx: isXlsx,
          parsedData: [],
          errorRows: [],
          importDone: false,
          importedCount: 0,
          failCount: 0
        })

        if (isXlsx) {
          wx.showToast({ title: '请点击"上传并导入"', icon: 'none' })
        } else {
          this.readAndParse(file.path, name)
        }
      }
    })
  },

  // 客户端解析 CSV / JSON
  readAndParse(filePath, fileName) {
    const fs = wx.getFileSystemManager()
    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      if (fileName.endsWith('.json')) {
        this.parseJSON(content)
      } else {
        this.parseCSV(content)
      }
    } catch (err) {
      console.error('读取文件失败', err)
      wx.showToast({ title: '读取文件失败', icon: 'none' })
    }
  },

  parseJSON(content) {
    try {
      const data = JSON.parse(content)
      if (!Array.isArray(data)) {
        wx.showToast({ title: 'JSON需为数组格式', icon: 'none' })
        return
      }
      const parsedData = []
      const errorRows = []
      for (let i = 0; i < data.length; i++) {
        const result = validateAndFormat(data[i], i + 1)
        if (result.error) {
          errorRows.push(result.error)
        } else {
          parsedData.push(result.data)
        }
      }
      this.setData({ parsedData: parsedData, errorRows: errorRows })
    } catch (err) {
      wx.showToast({ title: 'JSON解析失败', icon: 'none' })
    }
  },

  parseCSV(content) {
    const lines = content.split(/\r?\n/).filter(l => { return l.trim() !== '' })
    if (lines.length < 2) {
      wx.showToast({ title: 'CSV文件无数据行', icon: 'none' })
      return
    }

    const headers = splitCSVLine(lines[0])
    const colMapping = []
    for (let c = 0; c < headers.length; c++) {
      const h = headers[c].trim().toLowerCase()
      let found = null
      for (let m = 0; m < COLUMN_MAP.length; m++) {
        if (h === COLUMN_MAP[m].name.toLowerCase() || h === COLUMN_MAP[m].field.toLowerCase()) {
          found = COLUMN_MAP[m]
          break
        }
      }
      colMapping.push(found)
    }

    const parsedData = []
    const errorRows = []

    for (let i = 1; i < lines.length; i++) {
      const cols = splitCSVLine(lines[i])
      const row = {}
      for (let ci = 0; ci < colMapping.length; ci++) {
        if (!colMapping[ci]) continue
        row[colMapping[ci].field] = (cols[ci] || '').trim()
      }
      const result = validateAndFormat(row, i + 1)
      if (result.error) {
        errorRows.push(result.error)
      } else {
        parsedData.push(result.data)
      }
    }

    this.setData({ parsedData: parsedData, errorRows: errorRows })
  },

  async doImportParsed() {
    if (this.data.importing) return
    const data = this.data.parsedData
    if (data.length === 0) return

    // 去掉预览用字段，只传数据字段给 API
    const cleanData = data.map(row => {
      return {
        wxNickname: row.wxNickname,
        steamId: row.steamId,
        gameId: row.gameId,
        calibrateRankName: row.calibrateRankName,
        calibrateRankStar: row.calibrateRankStar,
        goodAtPositions: row.goodAtPositions,
        signupPosition: row.signupPosition
      }
    })

    this.setData({ importing: true })
    wx.showLoading({ title: '导入中...' })
    try {
      const res = await api.post('/players/import', { players: cleanData })
      wx.hideLoading()

      this.setData({
        importing: false,
        importDone: true,
        importedCount: res.imported || 0,
        replacedCount: res.updated || 0,
        failCount: res.failed || 0
      })

      // 通知首页下次返回时刷新
      this._notifyHomeRefresh()

      if (res.errors && res.errors.length > 0) {
        this.setData({ errorRows: res.errors })
      }

      let tip = '导入完成！'
      if (res.updated > 0) tip = '导入完成，更新' + res.updated + '条已有记录'
      wx.showToast({ title: tip, icon: 'success' })
    } catch (err) {
      wx.hideLoading()
      this.setData({ importing: false })
      console.error('导入失败', err)
      wx.showToast({ title: '导入失败', icon: 'none' })
    }
  },

  async doImportXlsx() {
    if (this.data.importing || !this.data.filePath) return
    this.setData({ importing: true })

    const app = getApp()
    const openid = app.globalData.openid || ''
    const uploadUrl = api.API_BASE + '/players/import/xlsx' + (openid ? '?openid=' + openid : '')

    wx.showLoading({ title: '上传解析中...' })
    wx.uploadFile({
      url: uploadUrl,
      filePath: this.data.filePath,
      name: 'file',
      success: (uploadRes) => {
        wx.hideLoading()
        try {
          const result = JSON.parse(uploadRes.data)
          this.setData({
            importing: false,
            importDone: true,
            importedCount: result.imported || 0,
            replacedCount: result.updated || 0,
            failCount: result.failed || 0
          })
          // 通知首页下次返回时刷新
          this._notifyHomeRefresh()
          if (result.errors && result.errors.length > 0) {
            this.setData({ errorRows: result.errors })
          }
          let tip = '导入完成！'
          if (result.updated > 0) tip = '导入完成，更新' + result.updated + '条已有记录'
          wx.showToast({ title: tip, icon: 'success' })
        } catch (e) {
          wx.showToast({ title: '解析失败', icon: 'none' })
        }
      },
      fail: () => {
        wx.hideLoading()
        this.setData({ importing: false })
        wx.showToast({ title: '上传失败', icon: 'none' })
      }
    })
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

// 校验并格式化一行数据
const validateAndFormat = (row, rowNum) => {
  const wxNickname = (row.wxNickname || '').trim()
  const gameId = (row.gameId || '').trim()

  if (!wxNickname) return { error: { row: rowNum, msg: '微信群昵称缺失' } }
  if (!gameId) return { error: { row: rowNum, msg: 'Dota2游戏昵称缺失' } }

  const positions = parsePositions(row.goodAtPositions)
  const positionsText = positions.length > 0 ? positions.join(',') : ''
  const signupPos = parsePositions(row.signupPosition)
  const signupText = signupPos.length > 0 ? signupPos.join(',') : ''

  return {
    data: {
      wxNickname: wxNickname,
      steamId: String(row.steamId || '').trim(),
      gameId: gameId,
      calibrateRankName: String(row.calibrateRankName || '').trim(),
      calibrateRankStar: Number(row.calibrateRankStar) || 0,
      goodAtPositions: positions,
      signupPosition: signupPos,
      positionsText: positionsText,
      signupText: signupText
    }
  }
}

const parsePositions = (val) => {
  if (Array.isArray(val)) return val.filter(n => { return n >= 1 && n <= 5 })
  if (typeof val === 'string') {
    const parts = val.split(/[,，\/、\s]+/)
    const nums = []
    for (let i = 0; i < parts.length; i++) {
      const n = parseInt(parts[i])
      if (n >= 1 && n <= 5) nums.push(n)
    }
    return nums
  }
  if (typeof val === 'number') return val >= 1 && val <= 5 ? [val] : []
  return []
}

const splitCSVLine = (line) => {
  const result = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        // 遇到 "" 转义 → 保留一个双引号并跳过下一个字符
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  result.push(current)
  return result
}
