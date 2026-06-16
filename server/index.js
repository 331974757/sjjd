try { require('dotenv').config(); } catch (_) {}
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const xlsx = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const uploadDir = process.env.UPLOAD_DIR || 'uploads';
fs.mkdirSync(uploadDir, { recursive: true });
app.use('/uploads', express.static(uploadDir));

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => cb(null, Date.now() + '_' + file.originalname)
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'dota2',
  password: process.env.DB_PASSWORD || 'Yang8728135@',
  database: process.env.DB_NAME || 'dota2',
  waitForConnections: true,
  connectionLimit: 10,
});

const WECHAT_APPID = process.env.WECHAT_APPID || 'wxecea6e915b217430';
const WECHAT_SECRET = process.env.WECHAT_SECRET || 'f2c23d00ebb1e12debc58dc9a6157349';

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Dota2 API' });
});

// 微信登录 - 用 code 换取 openid
app.get('/api/auth/login', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).json({ success: false, error: '缺少 code' });

    const https = require('https');
    const wxUrl = `https://api.weixin.qq.com/sns/jscode2session?appid=${WECHAT_APPID}&secret=${WECHAT_SECRET}&js_code=${code}&grant_type=authorization_code`;

    const wxRes = await new Promise((resolve, reject) => {
      https.get(wxUrl, (resp) => {
        let data = '';
        resp.on('data', chunk => data += chunk);
        resp.on('end', () => resolve(JSON.parse(data)));
        resp.on('error', reject);
      });
    });

    if (wxRes.openid) {
      res.json({ success: true, openid: wxRes.openid, session_key: wxRes.session_key });
    } else {
      res.status(400).json({ success: false, error: wxRes.errmsg || '登录失败' });
    }
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 解析位置字符串: 兼容 [1,2,3] 和 1,2,3 两种格式
function parsePositions(val) {
  if (!val || val === '' || val === '[]') return [];
  let s = String(val).trim();
  if (s.startsWith('[')) s = s.slice(1);
  if (s.endsWith(']')) s = s.slice(0, -1);
  return s.split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n));
}

// 获取所有选手 (映射 snake_case → camelCase)
function mapPlayer(row) {
  return {
    _id: row.id,
    wxNickname: row.wx_nickname,
    gameId: row.game_id,
    steamId: row.steam_id,
    avatarUrl: row.avatar_url,
    calibrateRankName: row.calibrate_rank_name,
    calibrateRankStar: row.calibrate_rank_star,
    calibrateRankLabel: row.calibrate_rank_label,
    calibrateRankSort: row.calibrate_rank_sort,
    goodAtPositions: parsePositions(row.good_at_positions),
    signupPosition: parsePositions(row.signup_position),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// 段位计算（后端统一，不依赖前端传值）
const RANK_OPTIONS = ['先锋', '卫士', '中军', '统帅', '传奇', '万古流芳', '超凡入圣', '冠绝一世'];
function computeRankLabel(rankName, star) {
  if (!rankName) return '';
  return star > 0 ? rankName + star : rankName;
}
function computeRankSort(rankName, star) {
  const idx = RANK_OPTIONS.indexOf(rankName);
  return idx < 0 ? 0 : idx * 10 + 10 + star;
}

function mapUser(row) {
  return {
    _id: row.id,
    openid: row.openid,
    nickName: row.nick_name || '',
    role: row.role,
    nickChangeCount: row.nick_change_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ============== 选手管理 ==============

app.get('/api/players', async (req, res) => {
  try {
    const { rank, position, keyword, page, pageSize } = req.query;
    let where = ' WHERE 1=1';
    const params = [];
    if (rank) { where += ' AND calibrate_rank_name = ?'; params.push(rank); }
    if (position) { where += ' AND FIND_IN_SET(?, signup_position)'; params.push(String(position)); }
    if (keyword) {
      where += ' AND (wx_nickname LIKE ? OR steam_id LIKE ? OR game_id LIKE ?)';
      const kw = '%' + keyword + '%'; params.push(kw, kw, kw);
    }
    const p = parseInt(page) || 1, ps = parseInt(pageSize) || 20;
    const sql = 'SELECT * FROM dota2_players' + where + ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    const countSql = 'SELECT COUNT(*) as total FROM dota2_players' + where;
    const [rows] = await pool.query(sql, [...params, ps, (p - 1) * ps]);
    const [[{ total }]] = await pool.query(countSql, params);
    res.json({ success: true, data: rows.map(mapPlayer), total, page: p, pageSize: ps });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/players/:id', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM dota2_players WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'not found' });
    res.json({ success: true, data: mapPlayer(rows[0]) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/players', async (req, res) => {
  try {
    if (!await assertAdmin(req, res)) return;
    const { wxNickname, steamId, gameId, calibrateRankName, calibrateRankStar, goodAtPositions, signupPosition, avatarUrl } = req.body;
    if (!wxNickname) return res.status(400).json({ success: false, error: '微信群昵称不能为空' });

    // 检查微信群昵称是否已存在
    const [dupWx] = await pool.query('SELECT id FROM dota2_players WHERE wx_nickname = ?', [wxNickname]);
    if (dupWx.length > 0) {
      return res.status(400).json({ success: false, message: '该微信群昵称已存在，请使用其他昵称' });
    }
    const gpos = Array.isArray(goodAtPositions) ? goodAtPositions.join(',') : (goodAtPositions || '');
    const spos = Array.isArray(signupPosition) ? signupPosition.join(',') : (signupPosition || '');
    const id = Date.now().toString(16) + Math.random().toString(16).slice(2, 10);
    const label = computeRankLabel(calibrateRankName, calibrateRankStar);
    const sort = computeRankSort(calibrateRankName, calibrateRankStar);
    await pool.query(
      'INSERT INTO dota2_players (id, wx_nickname, steam_id, game_id, calibrate_rank_name, calibrate_rank_star, calibrate_rank_label, calibrate_rank_sort, good_at_positions, signup_position, avatar_url, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())',
      [id, wxNickname, steamId || '', gameId || '', calibrateRankName || '', calibrateRankStar || 0, label, sort, gpos, spos, avatarUrl || '']
    );
    res.json({ success: true, action: 'inserted', data: { _id: id } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.put('/api/players/:id', async (req, res) => {
  try {
    const openid = req.query.openid || '';
    const role = await getCallerRole(openid);
    const isAdmin = role === 'admin' || role === 'super_admin';

    // 非管理员需校验：昵称必须匹配选手 wxNickname，且不能修改段位
    if (!isAdmin) {
      const [userRows] = await pool.query('SELECT nick_name FROM dota2_users WHERE openid = ?', [openid]);
      const userNick = (userRows.length && userRows[0].nick_name) ? userRows[0].nick_name : '';
      const [playerRows] = await pool.query('SELECT wx_nickname FROM dota2_players WHERE id = ?', [req.params.id]);
      if (!playerRows.length || !userNick || playerRows[0].wx_nickname !== userNick) {
        return res.status(403).json({ success: false, error: '仅管理员或选手本人可修改' });
      }
      // 非管理员禁止修改段位相关字段
      if (req.body.calibrateRankName !== undefined || req.body.calibrateRankStar !== undefined || req.body.wxNickname !== undefined) {
        return res.status(403).json({ success: false, error: '仅管理员可修改段位和微信昵称' });
      }
    }

    const { wxNickname, steamId, gameId, calibrateRankName, calibrateRankStar, goodAtPositions, signupPosition, avatarUrl } = req.body;
    const playerId = req.params.id;

    // 检查微信群昵称是否与其他人重复
    if (wxNickname !== undefined) {
      if (!wxNickname) return res.status(400).json({ success: false, error: '微信群昵称不能为空' });
      const [dupWx] = await pool.query('SELECT id FROM dota2_players WHERE wx_nickname = ? AND id != ?', [wxNickname, playerId]);
      if (dupWx.length > 0) {
        return res.status(400).json({ success: false, message: '该微信群昵称已被其他选手使用' });
      }
    }

    // 只更新实际传入的字段，防止覆盖
    const sets = [];
    const values = [];
    const fieldMap = {
      wxNickname: 'wx_nickname',
      steamId: 'steam_id',
      gameId: 'game_id',
      calibrateRankName: 'calibrate_rank_name',
      calibrateRankStar: 'calibrate_rank_star',
      goodAtPositions: 'good_at_positions',
      signupPosition: 'signup_position',
      avatarUrl: 'avatar_url'
    };
    for (const [key, col] of Object.entries(fieldMap)) {
      const val = req.body[key];
      if (val !== undefined) {
        sets.push(col + ' = ?');
        if (key === 'goodAtPositions' || key === 'signupPosition') {
          values.push(Array.isArray(val) ? val.join(',') : (val || ''));
        } else {
          values.push(val);
        }
      }
    }
    // 如果更新了段位，同步更新 label 和 sort（后端统一计算，不信任前端传值）
    if (req.body.calibrateRankName !== undefined || req.body.calibrateRankStar !== undefined) {
      let rankName = req.body.calibrateRankName;
      let rankStar = req.body.calibrateRankStar;
      if (rankName === undefined || rankStar === undefined) {
        const [cur] = await pool.query(
          'SELECT calibrate_rank_name, calibrate_rank_star FROM dota2_players WHERE id = ?',
          [playerId]
        );
        if (cur.length > 0) {
          if (rankName === undefined) rankName = cur[0].calibrate_rank_name;
          if (rankStar === undefined) rankStar = cur[0].calibrate_rank_star;
        }
      }
      const label = computeRankLabel(rankName, rankStar);
      const sort = computeRankSort(rankName, rankStar);
      sets.push('calibrate_rank_label = ?', 'calibrate_rank_sort = ?');
      values.push(label, sort);
    }

    if (sets.length > 0) {
      sets.push('updated_at = NOW()');
      values.push(playerId);
      await pool.query('UPDATE dota2_players SET ' + sets.join(', ') + ' WHERE id = ?', values);
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.delete('/api/players/:id', async (req, res) => {
  try {
    if (!await assertAdmin(req, res)) return;
    await pool.query('DELETE FROM dota2_players WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/players/batch-delete', async (req, res) => {
  try {
    if (!await assertAdmin(req, res)) return;
    const { ids } = req.body;
    if (!ids || !ids.length) return res.status(400).json({ success: false, error: 'missing ids' });
    await pool.query('DELETE FROM dota2_players WHERE id IN (?)', [ids]);
    res.json({ success: true, deleted: ids.length });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/players/import', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    if (!await assertAdmin(req, res)) { conn.release(); return; }
    const { players } = req.body;
    let inserted = 0, updated = 0;
    await conn.beginTransaction();
    for (const p of players) {
      const wxNickname = p.wxNickname || '';
      const igp = Array.isArray(p.goodAtPositions) ? p.goodAtPositions.join(',') : (p.goodAtPositions || '');
      const isp = Array.isArray(p.signupPosition) ? p.signupPosition.join(',') : (p.signupPosition || '');
      // 后端统一计算段位，不信任前端传值
      const label = computeRankLabel(p.calibrateRankName, p.calibrateRankStar);
      const sort = computeRankSort(p.calibrateRankName, p.calibrateRankStar);
      const [existing] = await conn.query('SELECT id FROM dota2_players WHERE wx_nickname = ?', [wxNickname]);
      if (existing.length > 0) {
        await conn.query(
          'UPDATE dota2_players SET steam_id=?, game_id=?, calibrate_rank_name=?, calibrate_rank_star=?, calibrate_rank_label=?, calibrate_rank_sort=?, good_at_positions=?, signup_position=?, avatar_url=?, updated_at=NOW() WHERE wx_nickname=?',
          [p.steamId || '', p.gameId || '', p.calibrateRankName || '', p.calibrateRankStar || 0, label, sort, igp, isp, p.avatarUrl || '', wxNickname]
        );
        updated++;
      } else {
        const id = Date.now().toString(16) + Math.random().toString(16).slice(2, 10);
        await conn.query(
          'INSERT INTO dota2_players (id, wx_nickname, steam_id, game_id, calibrate_rank_name, calibrate_rank_star, calibrate_rank_label, calibrate_rank_sort, good_at_positions, signup_position, avatar_url, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())',
          [id, wxNickname, p.steamId || '', p.gameId || '', p.calibrateRankName || '', p.calibrateRankStar || 0, label, sort, igp, isp, p.avatarUrl || '']
        );
        inserted++;
      }
    }
    await conn.commit();
    res.json({ success: true, imported: inserted + updated, inserted, updated });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ success: false, error: e.message });
  } finally {
    conn.release();
  }
});

// XLSX 文件导入（服务端解析）
const uploadXlsx = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
app.post('/api/players/import/xlsx', uploadXlsx.single('file'), async (req, res) => {
  try {
    if (!await assertAdmin(req, res)) return;
    if (!req.file) return res.status(400).json({ success: false, error: '请上传文件' });
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return res.status(400).json({ success: false, error: 'XLSX 文件无工作表' });
    const sheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(sheet, { defval: '' });
    if (!rows.length) return res.status(400).json({ success: false, error: 'XLSX 文件无数据' });

    const colMap = {
      '微信群昵称': 'wxNickname', 'wxNickname': 'wxNickname', 'wxnickname': 'wxNickname',
      'steam id': 'steamId', 'steamId': 'steamId', 'steamid': 'steamId',
      'dota2游戏昵称': 'gameId', 'gameId': 'gameId', 'gameid': 'gameId',
      '核准段位': 'calibrateRankName', 'calibrateRankName': 'calibrateRankName', 'calibraterankname': 'calibrateRankName',
      '核准星数': 'calibrateRankStar', 'calibrateRankStar': 'calibrateRankStar', 'calibraterankstar': 'calibrateRankStar',
      '擅长游戏位置': 'goodAtPositions', 'goodAtPositions': 'goodAtPositions', 'goodatpositions': 'goodAtPositions',
      '比赛报名位置': 'signupPosition', 'signupPosition': 'signupPosition', 'signupposition': 'signupPosition',
    };

    // 先做预校验，筛出不合格行
    const validRows = [];
    const errors = [];
    for (let i = 0; i < rows.length; i++) {
      const rawRow = rows[i];
      const row = {};
      for (const key in rawRow) {
        const mapped = colMap[key.trim()] || colMap[key.trim().toLowerCase()];
        if (mapped) row[mapped] = String(rawRow[key] || '').trim();
      }
      if (!row.wxNickname) { errors.push({ row: i + 2, msg: '微信群昵称缺失' }); continue; }
      if (!row.gameId) { errors.push({ row: i + 2, msg: 'Dota2游戏昵称缺失' }); continue; }
      validRows.push({ row, index: i });
    }

    // 事务写入（全部有效行一次性提交）
    let imported = 0, updated = 0;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const { row } of validRows) {
        const gpos = row.goodAtPositions || '';
        const spos = row.signupPosition || '';
        const rankName = row.calibrateRankName || '';
        const rankStar = parseInt(row.calibrateRankStar) || 0;
        const label = computeRankLabel(rankName, rankStar);
        const sort = computeRankSort(rankName, rankStar);
        const [existing] = await conn.query('SELECT id FROM dota2_players WHERE wx_nickname = ?', [row.wxNickname]);
        if (existing.length > 0) {
          await conn.query(
            'UPDATE dota2_players SET steam_id=?, game_id=?, calibrate_rank_name=?, calibrate_rank_star=?, calibrate_rank_label=?, calibrate_rank_sort=?, good_at_positions=?, signup_position=?, updated_at=NOW() WHERE wx_nickname=?',
            [row.steamId || '', row.gameId, rankName, rankStar, label, sort, gpos, spos, row.wxNickname]
          );
          updated++;
        } else {
          await conn.query(
            'INSERT INTO dota2_players (id, wx_nickname, steam_id, game_id, calibrate_rank_name, calibrate_rank_star, calibrate_rank_label, calibrate_rank_sort, good_at_positions, signup_position, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,NOW(),NOW())',
            [Date.now().toString(16) + Math.random().toString(16).slice(2, 10), row.wxNickname, row.steamId || '', row.gameId, rankName, rankStar, label, sort, gpos, spos]
          );
          imported++;
        }
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      errors.push({ row: 0, msg: '写入事务失败: ' + e.message });
      imported = 0; updated = 0;
    } finally {
      conn.release();
    }
    res.json({ success: true, imported, updated, failed: errors.length, errors });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ============== 下载导入模板（Excel） ==============
app.get('/api/players/template/xlsx', async (req, res) => {
  try {
    const workbook = xlsx.utils.book_new();
    const headers = ['微信群昵称', 'Steam ID', 'Dota2游戏昵称', '核准段位', '核准星数', '擅长游戏位置', '比赛报名位置'];
    const exampleRow = ['示例选手', '123456789', 'Dota2示例昵称', '统帅', 3, '1,2,3', '1'];
    const dataRows = [headers, exampleRow];

    // 添加说明行（合并样式）
    const sheet = xlsx.utils.aoa_to_sheet(dataRows);

    // 设置列宽
    sheet['!cols'] = [
      { wch: 16 },  // 微信群昵称
      { wch: 16 },  // Steam ID
      { wch: 20 },  // Dota2游戏昵称
      { wch: 14 },  // 核准段位
      { wch: 10 },  // 核准星数
      { wch: 16 },  // 擅长游戏位置
      { wch: 16 }   // 比赛报名位置
    ];

    xlsx.utils.book_append_sheet(workbook, sheet, '选手导入模板');
    const buf = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="dota2_import_template.xlsx"');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============== 导出（必须在 /:id 路由前定义，避免路由冲突） ==============
app.get('/api/players/export/all', async (req, res) => {
  try {
    if (!await assertAdmin(req, res)) return;
    const [rows] = await pool.query('SELECT * FROM dota2_players ORDER BY created_at DESC');
    res.json({ success: true, data: rows.map(mapPlayer) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ============== 统计 & 文件 ==============

app.get('/api/stats/ranks', async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT calibrate_rank_name as name, COUNT(*) as value FROM dota2_players WHERE calibrate_rank_name != '' GROUP BY calibrate_rank_name ORDER BY value DESC"
    );
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!await assertAdmin(req, res)) return;
    if (!req.file) return res.status(400).json({ success: false, error: 'no file' });
    res.json({ success: true, data: { url: '/uploads/' + req.file.filename } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ============== 权限校验中间件/工具 ==============
async function getCallerRole(openid) {
  if (!openid) return 'user'
  try {
    const [rows] = await pool.query('SELECT role FROM dota2_users WHERE openid = ?', [openid])
    return rows.length ? rows[0].role : 'user'
  } catch (e) { return 'user' }
}

// 断言当前请求者为管理员，非管理员直接返回 403
async function assertAdmin(req, res) {
  const openid = req.query.openid || ''
  const role = await getCallerRole(openid)
  if (role !== 'admin' && role !== 'super_admin') {
    res.status(403).json({ success: false, error: '仅管理员可操作' })
    return false
  }
  return true
}

// ============== 用户管理 ==============

app.get('/api/users/me', async (req, res) => {
  try {
    const { openid } = req.query;
    if (!openid) return res.status(400).json({ success: false, error: '缺少 openid' });
    const [rows] = await pool.query('SELECT * FROM dota2_users WHERE openid = ?', [openid]);
    if (!rows.length) return res.json({ success: true, nickName: '', nickChangeCount: 0, role: 'user' });
    const u = mapUser(rows[0]);
    res.json({ success: true, ...u });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/users/:openid', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM dota2_users WHERE openid = ?', [req.params.openid]);
    res.json({ success: true, data: rows[0] ? mapUser(rows[0]) : null });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/users', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM dota2_users ORDER BY created_at DESC');
    res.json({ success: true, data: rows.map(mapUser) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/users/admins/list', async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM dota2_users WHERE role IN ('admin','super_admin') ORDER BY role DESC, created_at ASC");
    res.json({ success: true, data: rows.map(mapUser) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.put('/api/users/:openid/role', async (req, res) => {
  try {
    const { role, operatorOpenid } = req.body;
    // 权限校验：仅超级管理员可修改角色
    const callerRole = await getCallerRole(operatorOpenid || req.query.operatorOpenid || req.query.openid);
    if (callerRole !== 'super_admin') {
      return res.status(403).json({ success: false, error: '仅超级管理员可修改权限' });
    }
    const [r] = await pool.query('SELECT * FROM dota2_users WHERE openid = ?', [req.params.openid]);
    if (r.length) {
      await pool.query('UPDATE dota2_users SET role = ?, updated_at = NOW() WHERE openid = ?', [role, req.params.openid]);
    } else {
      const id = Date.now().toString(16) + Math.random().toString(16).slice(2, 10);
      await pool.query('INSERT INTO dota2_users (id, openid, role, nick_name, created_at, updated_at) VALUES (?,?,?,?,NOW(),NOW())', [id, req.params.openid, role, '']);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.put('/api/users/me/nickname', async (req, res) => {
  try {
    const { openid } = req.query;
    const { nickName } = req.body;
    if (!openid || !nickName) return res.status(400).json({ success: false, error: '缺少参数' });

    const [dups] = await pool.query('SELECT openid FROM dota2_users WHERE nick_name = ? AND openid != ?', [nickName, openid]);
    if (dups.length) {
      return res.status(400).json({ success: false, message: '该昵称已被其他用户使用，请换一个' });
    }

    const [rows] = await pool.query('SELECT * FROM dota2_users WHERE openid = ?', [openid]);
    if (!rows.length) {
      const id = Date.now().toString(16) + Math.random().toString(16).slice(2, 10);
      try {
        await pool.query("INSERT INTO dota2_users (id,openid,nick_name,role,nick_change_count,created_at,updated_at) VALUES (?,?,?,'user',0,NOW(),NOW())", [id, openid, nickName]);
        res.json({ success: true, nickChangeCount: 0 });
      } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') {
          return res.status(400).json({ success: false, message: '该昵称已被其他用户使用，请换一个' });
        }
        throw e;
      }
    } else {
      const user = rows[0];
      const count = (user.nick_change_count || 0);
      const role = user.role || 'user';
      const MAX_CHANGES = 3;
      if (role !== 'admin' && role !== 'super_admin' && count >= MAX_CHANGES) {
        return res.status(400).json({ success: false, message: '修改次数已用完，请联系超级管理员重置', nickChangeCount: count });
      }
      try {
        await pool.query('UPDATE dota2_users SET nick_name=?,nick_change_count=nick_change_count+1,updated_at=NOW() WHERE openid=?', [nickName, openid]);
        res.json({ success: true, nickChangeCount: count + 1 });
      } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') {
          return res.status(400).json({ success: false, message: '该昵称已被其他用户使用，请换一个' });
        }
        throw e;
      }
    }
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.put('/api/users/:openid/reset-nickcount', async (req, res) => {
  try {
    // 权限校验：仅超级管理员可重置
    const operatorOpenid = req.query.openid || req.body.operatorOpenid || '';
    const callerRole = await getCallerRole(operatorOpenid);
    if (callerRole !== 'super_admin') {
      return res.status(403).json({ success: false, error: '仅超级管理员可重置修改次数' });
    }
    await pool.query('UPDATE dota2_users SET nick_change_count=0,updated_at=NOW() WHERE openid=?', [req.params.openid]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// === 全局错误处理（防止无效 JSON 等导致进程崩溃） ===
// body-parser 遇到非法 JSON 时会抛 SyntaxError，Express 4 默认不捕获会导致 crash
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, error: '请求 JSON 格式错误' });
  }
  console.error('[UNHANDLED]', err.message || err);
  res.status(500).json({ success: false, error: '服务器内部错误' });
});

// 未匹配路由 404
app.use((req, res) => {
  res.status(404).json({ success: false, error: '接口不存在' });
});

app.listen(PORT, () => {
  console.log(`Dota2 API running on http://localhost:${PORT}`);
});
