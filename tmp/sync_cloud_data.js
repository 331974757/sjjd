/**
 * 将云开发数据库的 goodAtPositions / signupPosition 数据同步到 MySQL
 * 按 wxNickname 匹配选手，只更新位置字段，不覆盖已有数据
 */
const mysql = require('mysql2/promise');
const fs = require('fs');

async function sync() {
  // 1. 读取云数据库导出的 JSON
  const playersRaw = JSON.parse(fs.readFileSync('/tmp/cloud_players.json', 'utf8'));
  const cloudPlayers = playersRaw.data.map(d => JSON.parse(d));
  console.log(`云数据库共 ${cloudPlayers.length} 名选手`);

  // 2. 连接 MySQL
  const pool = mysql.createPool({
    host: '121.41.191.80',
    user: 'dota2',
    password: 'Yang8728135@',
    database: 'dota2',
    charset: 'utf8mb4',
  });

  // 3. 获取 MySQL 现有选手
  const [mysqlPlayers] = await pool.query("SELECT id, wx_nickname, good_at_positions, signup_position FROM dota2_players WHERE status = 'active'");
  console.log(`MySQL 共 ${mysqlPlayers.length} 名选手`);

  // 4. 按 wxNickname 匹配并更新
  let updated = 0, skipped = 0, notFound = 0;
  for (const cp of cloudPlayers) {
    const nick = (cp.wxNickname || '').trim();
    if (!nick) { skipped++; continue; }

    const mp = mysqlPlayers.find(p => p.wx_nickname === nick);
    if (!mp) { notFound++; continue; }

    // 将云数组转为逗号字符串
    const cloudGood = Array.isArray(cp.goodAtPositions) ? cp.goodAtPositions.join(',') : (cp.goodAtPositions || '');
    const cloudSignup = Array.isArray(cp.signupPosition) ? cp.signupPosition.join(',') : (cp.signupPosition || '');

    // 只在 MySQL 对应字段为空时才更新
    const needUpdateGood = (!mp.good_at_positions || mp.good_at_positions === '') && cloudGood;
    const needUpdateSignup = (!mp.signup_position || mp.signup_position === '') && cloudSignup;

    if (needUpdateGood || needUpdateSignup) {
      const sets = [];
      const vals = [];
      if (needUpdateGood) { sets.push('good_at_positions = ?'); vals.push(cloudGood); }
      if (needUpdateSignup) { sets.push('signup_position = ?'); vals.push(cloudSignup); }
      sets.push('updated_at = NOW()');
      vals.push(mp.id);
      await pool.query(`UPDATE dota2_players SET ${sets.join(', ')} WHERE id = ?`, vals);
      updated++;
      if (updated <= 5) console.log(`  更新: ${nick} -> good:[${cloudGood}] signup:[${cloudSignup}]`);
    } else {
      skipped++;
    }
  }

  console.log(`\n完成: 更新 ${updated} 人, 跳过 ${skipped} 人, 未匹配 ${notFound} 人`);
  await pool.end();
}

sync().catch(e => { console.error(e); process.exit(1); });
