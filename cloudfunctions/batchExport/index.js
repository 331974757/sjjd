const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event, context) => {
  try {
    // 分批查询所有选手
    let allPlayers = []
    const batchSize = 100
    let offset = 0

    while (true) {
      const res = await db.collection('dota2_players')
        .orderBy('currentMmr', 'desc')
        .skip(offset)
        .limit(batchSize)
        .get()

      allPlayers = allPlayers.concat(res.data)
      if (res.data.length < batchSize) break
      offset += batchSize
    }

    if (allPlayers.length === 0) {
      return { success: false, message: '暂无选手数据' }
    }

    // 用 xlsx 库生成 Excel
    const XLSX = require('xlsx')

    const exportData = allPlayers.map((p, idx) => ({
      '序号': idx + 1,
      '微信群昵称': p.wxNickname || '',
      'Steam ID': p.steamId || '',
      'Dota2游戏ID': p.gameId || '',
      '历史最高分': p.highestMmr || 0,
      '当前分数': p.currentMmr || 0,
      '自我认定分数': p.selfMmr || 0,
      '擅长位置': (p.goodAtPositions || []).map(n => n + '号位').join(','),
      '比赛报名位置': p.signupPosition ? p.signupPosition + '号位' : ''
    }))

    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.json_to_sheet(exportData)

    // 设置列宽
    ws['!cols'] = [
      { wch: 6 },   // 序号
      { wch: 16 },  // 昵称
      { wch: 20 },  // Steam ID
      { wch: 16 },  // Dota2 ID
      { wch: 12 },  // 历史最高
      { wch: 12 },  // 当前分数
      { wch: 12 },  // 自认分数
      { wch: 18 },  // 擅长位置
      { wch: 14 }   // 报名位置
    ]

    XLSX.utils.book_append_sheet(wb, ws, '选手数据')

    // 生成 Buffer
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })

    // 上传到云存储
    const fileName = 'dota2_players_' + new Date().toISOString().slice(0, 10) + '.xlsx'
    const uploadRes = await cloud.uploadFile({
      cloudPath: 'exports/' + fileName,
      fileContent: buf
    })

    // 获取临时下载链接
    const urlRes = await cloud.getTempFileURL({
      fileList: [uploadRes.fileID]
    })

    return {
      success: true,
      fileID: uploadRes.fileID,
      tempFileURL: urlRes.fileList[0].tempFileURL,
      count: allPlayers.length
    }
  } catch (err) {
    console.error('导出失败', err)
    return { success: false, message: err.message }
  }
}
