// pages/dota2-import/dota2-import.js
var COLUMN_MAP = [
  { name: '微信群昵称', field: 'wxNickname', required: true },
  { name: 'Steam ID', field: 'steamId', required: false },
  { name: 'Dota2游戏ID', field: 'gameId', required: true },
  { name: '历史最高分', field: 'highestMmr', required: false, type: 'number' },
  { name: '当前分数', field: 'currentMmr', required: true, type: 'number' },
  { name: '自我认定分数', field: 'selfMmr', required: false, type: 'number' },
  { name: '擅长游戏位置', field: 'goodAtPositions', required: false, type: 'positions' },
  { name: '比赛报名位置', field: 'signupPosition', required: false }
]

Page({
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
    isXlsx: false
  },

  pickFile() {
    var that = this
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['csv', 'xlsx', 'xls', 'json'],
      success: function(res) {
        var file = res.tempFiles[0]
        var name = file.name.toLowerCase()
        var isXlsx = name.endsWith('.xlsx') || name.endsWith('.xls')

        that.setData({
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
          // xlsx 文件需要上传到云函数解析
          wx.showToast({ title: '请点击"上传并导入"', icon: 'none' })
        } else {
          // csv / json 客户端解析
          that.readAndParse(file.path, name)
        }
      }
    })
  },

  // 客户端解析 CSV / JSON
  readAndParse(filePath, fileName) {
    var fs = wx.getFileSystemManager()
    try {
      var content = fs.readFileSync(filePath, 'utf-8')
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

  // 解析 JSON
  parseJSON(content) {
    try {
      var data = JSON.parse(content)
      if (!Array.isArray(data)) {
        wx.showToast({ title: 'JSON需为数组格式', icon: 'none' })
        return
      }
      var parsedData = []
      var errorRows = []
      for (var i = 0; i < data.length; i++) {
        var row = data[i]
        var result = validateAndFormat(row, i + 1)
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

  // 解析 CSV
  parseCSV(content) {
    var lines = content.split(/\r?\n/).filter(function(l) { return l.trim() !== '' })
    if (lines.length < 2) {
      wx.showToast({ title: 'CSV文件无数据行', icon: 'none' })
      return
    }

    var headers = splitCSVLine(lines[0])

    // 建立列映射
    var colMapping = []
    for (var c = 0; c < headers.length; c++) {
      var h = headers[c].trim().toLowerCase()
      var found = null
      for (var m = 0; m < COLUMN_MAP.length; m++) {
        if (h === COLUMN_MAP[m].name.toLowerCase() || h === COLUMN_MAP[m].field.toLowerCase()) {
          found = COLUMN_MAP[m]
          break
        }
      }
      colMapping.push(found)
    }

    var parsedData = []
    var errorRows = []

    for (var i = 1; i < lines.length; i++) {
      var cols = splitCSVLine(lines[i])
      var row = {}
      for (var ci = 0; ci < colMapping.length; ci++) {
        if (!colMapping[ci]) continue
        row[colMapping[ci].field] = (cols[ci] || '').trim()
      }
      var result = validateAndFormat(row, i + 1)
      if (result.error) {
        errorRows.push(result.error)
      } else {
        parsedData.push(result.data)
      }
    }

    this.setData({ parsedData: parsedData, errorRows: errorRows })
  },

  // 客户端解析数据 → 调用云函数批量导入
  async doImportParsed() {
    if (this.data.importing) return
    var data = this.data.parsedData
    if (data.length === 0) return

    this.setData({ importing: true })

    wx.showLoading({ title: '导入中...' })
    try {
      var res = await wx.cloud.callFunction({
        name: 'batchImport',
        data: { players: data }
      })
      wx.hideLoading()

      var result = res.result
      this.setData({
        importing: false,
        importDone: true,
        importedCount: result.imported || 0,
        replacedCount: result.replaced || 0,
        failCount: result.failed || 0
      })

      if (result.errors && result.errors.length > 0) {
        this.setData({ errorRows: result.errors })
      }

      var tip = '导入完成！'
      if (result.replaced > 0) {
        tip = '导入完成，覆盖' + result.replaced + '条重复记录'
      }
      wx.showToast({ title: tip, icon: 'success' })
    } catch (err) {
      wx.hideLoading()
      this.setData({ importing: false })
      console.error('导入失败', err)
      wx.showToast({ title: '导入失败', icon: 'none' })
    }
  },

  // XLSX 文件上传到云函数解析
  async doImportXlsx() {
    if (this.data.importing || !this.data.filePath) return

    this.setData({ importing: true })

    // 读取文件为 base64
    var fs = wx.getFileSystemManager()
    try {
      var fileBuf = fs.readFileSync(this.data.filePath)
      var base64 = wx.arrayBufferToBase64(fileBuf)

      wx.showLoading({ title: '上传解析中...' })
      var res = await wx.cloud.callFunction({
        name: 'batchImport',
        data: {
          fileType: 'xlsx',
          fileContent: base64
        }
      })
      wx.hideLoading()

      var result = res.result
      this.setData({
        importing: false,
        importDone: true,
        importedCount: result.imported || 0,
        replacedCount: result.replaced || 0,
        failCount: result.failed || 0
      })

      if (result.errors && result.errors.length > 0) {
        this.setData({ errorRows: result.errors })
      }

      var tip = '导入完成！'
      if (result.replaced > 0) {
        tip = '导入完成，覆盖' + result.replaced + '条重复记录'
      }
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
function validateAndFormat(row, rowNum) {
  var wxNickname = (row.wxNickname || '').trim()
  var gameId = (row.gameId || '').trim()
  var currentMmr = row.currentMmr

  if (!wxNickname) return { error: { row: rowNum, msg: '微信群昵称缺失' } }
  if (!gameId) return { error: { row: rowNum, msg: 'Dota2游戏ID缺失' } }
  if (currentMmr === undefined || currentMmr === null || currentMmr === '') {
    return { error: { row: rowNum, msg: '当前分数缺失' } }
  }

  var positions = parsePositions(row.goodAtPositions)
  var positionsText = positions.length > 0 ? positions.map(function(p) { return p + '号位' }).join(' ') : '-'
  var signupPosition = String(row.signupPosition || '').trim()

  return {
    data: {
      wxNickname: wxNickname,
      steamId: String(row.steamId || '').trim(),
      gameId: gameId,
      highestMmr: Number(row.highestMmr) || 0,
      currentMmr: Number(currentMmr) || 0,
      selfMmr: Number(row.selfMmr) || 0,
      goodAtPositions: positions,
      signupPosition: signupPosition,
      positionsText: positionsText
    }
  }
}

function parsePositions(val) {
  if (Array.isArray(val)) return val.filter(function(n) { return n >= 1 && n <= 5 })
  if (typeof val === 'string') {
    var parts = val.split(/[,，\/、\s]+/)
    var nums = []
    for (var i = 0; i < parts.length; i++) {
      var n = parseInt(parts[i])
      if (n >= 1 && n <= 5) nums.push(n)
    }
    return nums
  }
  if (typeof val === 'number') return val >= 1 && val <= 5 ? [val] : []
  return []
}

function splitCSVLine(line) {
  var result = []
  var current = ''
  var inQuotes = false
  for (var i = 0; i < line.length; i++) {
    var ch = line[i]
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
