/**
 * 导出云开发数据库数据到 HTTP 响应
 * 部署后在云控制台测试调用，返回 JSON 数据
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: 'prod-d3gac4qo6d76e770c' });
const db = cloud.database();

exports.main = async (event, context) => {
  const result = {};

  // 需要导出的集合列表
  const collections = ['dota2_users', 'dota2_players'];

  for (const name of collections) {
    try {
      const allData = [];
      const batchSize = 100;
      let offset = 0;

      while (true) {
        const res = await db.collection(name)
          .skip(offset)
          .limit(batchSize)
          .get();

        allData.push(...res.data);
        if (res.data.length < batchSize) break;
        offset += batchSize;
      }

      result[name] = allData;
      console.log(`[${name}] 导出 ${allData.length} 条`);
    } catch (err) {
      if (err.errCode === -502005) {
        console.log(`[${name}] 集合不存在，跳过`);
        result[name] = [];
      } else {
        throw err;
      }
    }
  }

  return { success: true, data: result };
};
