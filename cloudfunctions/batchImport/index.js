const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// CSV 列映射
const COLUMN_MAP = {
  '微信群昵称': 'wxNickname',
  'wxNickname': 'wxNickname',
  'steamid': 'steamId',
  'steam id': 'steamId',
  'steam_id': 'steamId',
  'dota2游戏id': 'gameId',
  'dota2id': 'gameId',
  'gameid': 'gameId',
  'game_id': 'gameId',
  'dota2历史最高分': 'highestMmr',
  'highestmmr': 'highestMmr',
  '历史最高分': 'highestMmr',
  'dota2当前分数': 'currentMmr',
  'currentmmr': 'currentMmr',
  '当前分数': 'currentMmr',
  '自我认定分数': 'selfMmr',
  'selfmmr': 'selfMmr',
  '自认分数': 'selfMmr',
  '擅长游戏位置': 'goodAtPositions',
  '擅长位置': 'goodAtPositions',
  'goodatpositions': 'goodAtPositions',
  '比赛报名位置': 'signupPosition',
  '报名位置': 'signupPosition',
  'signupposition': 'signupPosition'
}

exports.main = async (event, context) => {
  const { fileType, fileContent, players } = event

  let dataRows = []

  // 方式1：直接传入解析好的选手数组
  if (players && players.length > 0) {
    dataRows = players
  }
  // 方式2：传入文件内容（base64编码），服务端解析
  else if (fileContent) {
    if (fileType === 'json') {
      dataRows = JSON.parse(Buffer.from(fileContent, 'base64').toString('utf-8'))
    } else {
      // xlsx / csv - 用 xlsx 库解析
      const XLSX = require('xlsx')
      const buf = Buffer.from(fileContent, 'base64')
      const workbook = XLSX.read(buf, { type: 'buffer' })
      const sheetName = workbook.SheetNames[0]
      const sheet = workbook.Sheets[sheetName]
      dataRows = XLSX.utils.sheet_to_json(sheet)
    }
  } else {
    return { success: false, message: '未提供数据' }
  }

  if (!dataRows || dataRows.length === 0) {
    return { success: false, message: '数据为空' }
  }

  // 解析列名映射
  function mapRow(row) {
    const result = {}
    for (const key of Object.keys(row)) {
      const normalizedKey = key.trim().toLowerCase()
      const field = COLUMN_MAP[normalizedKey]
      if (field) {
        result[field] = row[key]
      }
    }
    return result
  }

  // 解析位置字段
  function parsePositions(val) {
    if (Array.isArray(val)) return val.filter(n => n >= 1 && n <= 5)
    if (typeof val === 'string') {
      const parts = val.split(/[,，\/、\s]+/)
      const nums = []
      for (const p of parts) {
        const n = parseInt(p)
        if (n >= 1 && n <= 5) nums.push(n)
      }
      return nums
    }
    if (typeof val === 'number') return val >= 1 && val <= 5 ? [val] : []
    return []
  }

  // 校验并标准化
  const validRows = []
  const errors = []
  for (let i = 0; i < dataRows.length; i++) {
    const mapped = mapRow(dataRows[i])

    if (!mapped.wxNickname) {
      errors.push({ row: i + 1, msg: '微信群昵称缺失' })
      continue
    }
    if (!mapped.gameId) {
      errors.push({ row: i + 1, msg: 'Dota2游戏ID缺失' })
      continue
    }
    if (mapped.currentMmr === undefined || mapped.currentMmr === null || mapped.currentMmr === '') {
      errors.push({ row: i + 1, msg: '当前分数缺失' })
      continue
    }

    validRows.push({
      wxNickname: String(mapped.wxNickname),
      steamId: String(mapped.steamId || ''),
      gameId: String(mapped.gameId),
      highestMmr: Number(mapped.highestMmr) || 0,
      currentMmr: Number(mapped.currentMmr) || 0,
      selfMmr: Number(mapped.selfMmr) || 0,
      goodAtPositions: parsePositions(mapped.goodAtPositions),
      signupPosition: String(mapped.signupPosition || ''),
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
  }

  // 去重覆盖 + 分批写入（每批20条）
  let successCount = 0
  let failCount = 0
  let replacedCount = 0
  const batchSize = 20

  // 先批量查重：收集所有 wxNickname 和 steamId，一次性查出已有记录
  const allNicknames = [...new Set(validRows.map(r => r.wxNickname))]
  const allSteamIds = [...new Set(validRows.filter(r => r.steamId).map(r => r.steamId))]

  // 构建去重映射：nickname/steamId → 已有记录 _id 列表
  const dupMap = {} // key: 'nick:xxx' 或 'steam:xxx' → [_id, ...]

  // 分批查重（where 条件有长度限制）
  for (let i = 0; i < allNicknames.length; i += 20) {
    const batch = allNicknames.slice(i, i + 20)
    const res = await db.collection('dota2_players').where({ wxNickname: db.command.in(batch) }).get()
    for (const doc of res.data) {
      const key = 'nick:' + doc.wxNickname
      if (!dupMap[key]) dupMap[key] = []
      dupMap[key].push(doc._id)
    }
  }

  for (let i = 0; i < allSteamIds.length; i += 20) {
    const batch = allSteamIds.slice(i, i + 20)
    const res = await db.collection('dota2_players').where({ steamId: db.command.in(batch) }).get()
    for (const doc of res.data) {
      const key = 'steam:' + doc.steamId
      if (!dupMap[key]) dupMap[key] = []
      dupMap[key].push(doc._id)
    }
  }

  // 收集所有需要删除的 _id（去重）
  const idsToDelete = new Set()
  for (const row of validRows) {
    const nickKey = 'nick:' + row.wxNickname
    if (dupMap[nickKey]) {
      dupMap[nickKey].forEach(id => idsToDelete.add(id))
    }
    if (row.steamId) {
      const steamKey = 'steam:' + row.steamId
      if (dupMap[steamKey]) {
        dupMap[steamKey].forEach(id => idsToDelete.add(id))
      }
    }
  }

  // 批量删除旧记录
  const deleteIds = [...idsToDelete]
  for (let i = 0; i < deleteIds.length; i += 20) {
    const batch = deleteIds.slice(i, i + 20)
    const tasks = batch.map(id =>
      db.collection('dota2_players').doc(id).remove()
        .then(() => { replacedCount++ })
        .catch(() => {})
    )
    await Promise.all(tasks)
  }

  // 批量新增
  for (let i = 0; i < validRows.length; i += batchSize) {
    const batch = validRows.slice(i, i + batchSize)
    const tasks = batch.map(row =>
      db.collection('dota2_players').add({ data: row })
        .then(() => { successCount++ })
        .catch(() => { failCount++ })
    )
    await Promise.all(tasks)
  }

  return {
    success: true,
    total: dataRows.length,
    imported: successCount,
    failed: failCount,
    replaced: replacedCount,
    errors: errors
  }
}
