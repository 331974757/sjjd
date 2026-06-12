const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// CSV 列映射（必须包含所有老字段兼容+新字段）
const COLUMN_MAP = {
  '微信群昵称': 'wxNickname',
  'wxNickname': 'wxNickname',
  'steamid': 'steamId',
  'steam id': 'steamId',
  'steam_id': 'steamId',
  'dota2游戏昵称': 'gameId',
  'dota2游戏id': 'gameId',
  'dota2id': 'gameId',
  'gameid': 'gameId',
  'game_id': 'gameId',
  // 新字段：核准段位/星数
  '核准段位': 'calibrateRankName',
  'ranktitle': 'calibrateRankName',
  '段位': 'calibrateRankName',
  '核准星数': 'calibrateRankStar',
  'rankstars': 'calibrateRankStar',
  '星数': 'calibrateRankStar',
  // 老字段兼容（MMR -> 忽略，不导入）
  'dota2历史最高分': 'highestMmr',
  'dota2当前分数': 'currentMmr',
  '自我认定分数': 'selfMmr',
  '擅长游戏位置': 'goodAtPositions',
  '擅长位置': 'goodAtPositions',
  'goodatpositions': 'goodAtPositions',
  '比赛报名位置': 'signupPosition',
  '报名位置': 'signupPosition',
  'signupposition': 'signupPosition'
}

// 段位选项（与前端保持一致）
const RANK_OPTIONS = ['先锋', '卫士', '中军', '统帅', '传奇', '万古流芳', '超凡入圣', '冠绝一世']

// 计算段位显示标签（字符串）：传奇2, 万古流芳1, 冠绝一世
function calcRankLabel(rankName, star) {
  if (!rankName) return ''
  if (star > 0) return rankName + star
  return rankName
}

// 计算段位排序值：idx * 10 + 10 + star（先锋1★=11 ... 冠绝一世=80）
function calcRankSort(rankName, star) {
  const idx = RANK_OPTIONS.indexOf(rankName)
  if (idx < 0) return 0
  return idx * 10 + 10 + (star | 0)
}

exports.main = async (event, context) => {
  // 权限校验：仅 admin / super_admin 可导入
  const wxContext = cloud.getWXContext()
  const currentOpenId = wxContext.OPENID
  const user = await getUserRole(currentOpenId)
  if (user.role !== 'super_admin' && user.role !== 'admin') {
    return { success: false, message: '仅管理员可导入数据' }
  }

  const { fileType, fileContent, players } = event

  let dataRows = []

  // 方式1：直接传入解析好的选手数组
  if (players && players.length > 0) {
    dataRows = players
  }
  // 方式2：传入文件内容（base64编码），服务端解析
  else if (fileContent) {
    try {
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
    } catch (parseErr) {
      return { success: false, message: '文件解析失败：' + parseErr.message }
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
      errors.push({ row: i + 1, msg: 'Dota2游戏昵称缺失' })
      continue
    }

    const rankName = String(mapped.calibrateRankName || '')
    const rankStar = Number(mapped.calibrateRankStar) || 0

    validRows.push({
      avatarUrl: String(mapped.avatarUrl || ''),
      wxNickname: String(mapped.wxNickname),
      steamId: String(mapped.steamId || ''),
      gameId: String(mapped.gameId),
      calibrateRankName: rankName,
      calibrateRankStar: rankStar,
      calibrateRankLabel: calcRankLabel(rankName, rankStar),
      calibrateRankSort: calcRankSort(rankName, rankStar),
      goodAtPositions: parsePositions(mapped.goodAtPositions),
      signupPosition: parsePositions(mapped.signupPosition),
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
  }

  // 逐行 upsert：按 wxNickname 查重 → 存在则更新，不存在则新增
  // 保留已有记录的 _id 和 createdAt，不删除重建
  let successCount = 0
  let failCount = 0
  let updatedCount = 0
  const batchSize = 20

  // 先批量查出所有已有记录的昵称/steamId映射（减少逐条查询）
  const allNicknames = [...new Set(validRows.map(r => r.wxNickname))]
  const allSteamIds = [...new Set(validRows.filter(r => r.steamId).map(r => r.steamId))]

  // nickname → 已有完整记录明细
  const existingByNick = {}
  for (let i = 0; i < allNicknames.length; i += 20) {
    const batch = allNicknames.slice(i, i + 20)
    const res = await db.collection('dota2_players').where({ wxNickname: db.command.in(batch) }).get()
    for (const doc of res.data) {
      existingByNick[doc.wxNickname] = doc
    }
  }

  // steamId → 已有完整记录明细（仅用于 wxNickname 未命中时）
  const existingBySteam = {}
  for (let i = 0; i < allSteamIds.length; i += 20) {
    const batch = allSteamIds.slice(i, i + 20)
    const res = await db.collection('dota2_players').where({ steamId: db.command.in(batch) }).get()
    for (const doc of res.data) {
      existingBySteam[doc.steamId] = doc
    }
  }

  // 分批逐行 upsert
  for (let i = 0; i < validRows.length; i += batchSize) {
    const batch = validRows.slice(i, i + batchSize)
    const tasks = batch.map(async (row) => {
      try {
        // 1. 按 wxNickname 匹配 → 原地更新（保留 _id 和 createdAt）
        if (existingByNick[row.wxNickname]) {
          const updateData = { ...row }
          delete updateData.createdAt
          updateData.updatedAt = Date.now()
          await db.collection('dota2_players').doc(existingByNick[row.wxNickname]._id).update({ data: updateData })
          successCount++
          updatedCount++
          return
        }

        // 2. 按 steamId 匹配（处理改昵称的情况）
        if (row.steamId && existingBySteam[row.steamId]) {
          const updateData = { ...row }
          delete updateData.createdAt
          updateData.updatedAt = Date.now()
          await db.collection('dota2_players').doc(existingBySteam[row.steamId]._id).update({ data: updateData })
          successCount++
          updatedCount++
          return
        }

        // 3. 全新记录 → 新增
        row.createdAt = Date.now()
        row.updatedAt = Date.now()
        await db.collection('dota2_players').add({ data: row })
        successCount++
      } catch (err) {
        failCount++
      }
    })
    await Promise.all(tasks)
  }

  return {
    success: true,
    total: dataRows.length,
    imported: successCount,
    failed: failCount,
    updated: updatedCount,
    errors: errors
  }
}

// 获取用户角色
async function getUserRole(openid) {
  try {
    const res = await db.collection('dota2_users').where({ openid }).get()
    if (res.data.length > 0) {
      return { role: res.data[0].role, nickName: res.data[0].nickName || '' }
    }
  } catch (err) {
    if (err.errCode === -502005) { /* 集合不存在 */ }
  }
  return { role: 'user', nickName: '' }
}
