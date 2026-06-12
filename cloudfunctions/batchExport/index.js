const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event, context) => {
  try {
    // 权限校验：仅 admin / super_admin 可导出
    const wxContext = cloud.getWXContext()
    const currentOpenId = wxContext.OPENID
    const user = await getUserRole(currentOpenId)
    if (user.role !== 'super_admin' && user.role !== 'admin') {
      return { success: false, message: '仅管理员可导出数据' }
    }

    // 分批查询所有选手
    const allPlayers = []
    const batchSize = 100
    let offset = 0

    while (true) {
      const res = await db.collection('dota2_players')
        .orderBy('createdAt', 'desc')
        .skip(offset)
        .limit(batchSize)
        .get()

      allPlayers.push.apply(allPlayers, res.data)
      if (res.data.length < batchSize) break
      offset += batchSize
    }

    if (allPlayers.length === 0) {
      return { success: false, message: '暂无选手数据' }
    }

    // 用 xlsx 库生成 Excel
    const XLSX = require('xlsx')

    // 清理位置数据：去掉"号位"文本，只保留数字
    function cleanPositions(arr) {
      if (!Array.isArray(arr)) return ''
      return arr.map(function(v) {
        if (typeof v === 'number') return String(v)
        return String(v).replace(/号位/g, '').trim()
      }).filter(Boolean).join(',')
    }

    const exportData = allPlayers.map((p, idx) => ({
      '序号': idx + 1,
      '微信群昵称': p.wxNickname || '',
      'Steam ID': p.steamId || '',
      'Dota2游戏昵称': p.gameId || '',
      '核准段位': p.calibrateRankName || '未定',
      '核准星数': p.calibrateRankStar || 0,
      '擅长位置': cleanPositions(p.goodAtPositions),
      '比赛报名位置': cleanPositions(p.signupPosition)
    }))

    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.json_to_sheet(exportData)

    // 设置列宽
    ws['!cols'] = [
      { wch: 6 },   // 序号
      { wch: 16 },  // 昵称
      { wch: 20 },  // Steam ID
      { wch: 16 },  // Dota2游戏昵称
      { wch: 14 },  // 核准段位
      { wch: 10 },  // 核准星数
      { wch: 18 },  // 擅长位置
      { wch: 18 }   // 报名位置
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
