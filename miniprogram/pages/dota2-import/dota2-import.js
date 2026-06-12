// pages/dota2-import/dota2-import.js
const perm = require('../../utils/permission.js')
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

  // 获取导入模板（复制到剪贴板）
  downloadTemplate() {
    const content = TEMPLATE_HEADER + '\n' + TEMPLATE_ROW
    wx.setClipboardData({
      data: content,
      success: () => {
        wx.showToast({ title: '已复制到剪贴板', icon: 'success' })
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

    // 去掉预览用字段，只传数据字段给云函数
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
      const res = await wx.cloud.callFunction({
        name: 'batchImport',
        data: { players: cleanData }
      })
      wx.hideLoading()

      const result = res.result
      this.setData({
        importing: false,
        importDone: true,
        importedCount: result.imported || 0,
        replacedCount: result.updated || 0,
        failCount: result.failed || 0
      })

      if (result.errors && result.errors.length > 0) {
        this.setData({ errorRows: result.errors })
      }

      let tip = '导入完成！'
      if (result.updated > 0) tip = '导入完成，更新' + result.updated + '条已有记录'
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

    const fs = wx.getFileSystemManager()
    try {
      const fileBuf = fs.readFileSync(this.data.filePath)
      const base64 = wx.arrayBufferToBase64(fileBuf)

      wx.showLoading({ title: '上传解析中...' })
      const res = await wx.cloud.callFunction({
        name: 'batchImport',
        data: { fileType: 'xlsx', fileContent: base64 }
      })
      wx.hideLoading()

      const result = res.result
      this.setData({
        importing: false,
        importDone: true,
        importedCount: result.imported || 0,
        replacedCount: result.updated || 0,
        failCount: result.failed || 0
      })

      if (result.errors && result.errors.length > 0) {
        this.setData({ errorRows: result.errors })
      }

      let tip = '导入完成！'
      if (result.updated > 0) tip = '导入完成，更新' + result.updated + '条已有记录'
      wx.showToast({ title: tip, icon: 'success' })
    } catch (err) {
      wx.hideLoading()
      this.setData({ importing: false })
      console.error('导入失败', err)
      wx.showToast({ title: '导入失败', icon: 'none' })
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
      inQuotes = !inQuotes
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
