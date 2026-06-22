try { require('dotenv').config(); } catch (_) {}
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const xlsx = require('xlsx');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { genId, safeRollback } = require('./utils/helpers');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS 白名单
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',')
  : ['https://servicewechat.com', 'https://congqin.online'];
app.use(cors({
  origin: (origin, callback) => {
    // 无 origin 的请求（小程序、服务端调用）直接放行
    if (!origin) return callback(null, true);
    try {
      const parsed = new URL(origin);
      const hostname = parsed.hostname;
      if (allowedOrigins.some(o => {
        const allowedHost = new URL(o).hostname;
        return hostname === allowedHost || hostname.endsWith('.' + allowedHost);
      })) return callback(null, true);
    } catch (_) {}
    callback(new Error('Not allowed by CORS'));
  }
}));
app.use(express.json({ limit: '5mb' }));

const uploadDir = process.env.UPLOAD_DIR || 'uploads';
fs.mkdirSync(uploadDir, { recursive: true });
app.use('/uploads', express.static(uploadDir));

const path = require('path');
const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    // 清理文件名：移除路径遍历字符，仅保留安全字符
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext)
      .replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_')  // 仅保留字母数字中文下划线连字符
      .substring(0, 100);  // 限制长度
    cb(null, Date.now() + '_' + base + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

const { errorHandler } = require('./utils/errors');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'dota2',
  password: process.env.DB_PASSWORD || 'Yang8728135@',
  database: process.env.DB_NAME || 'dota2',
  charset: 'utf8mb4',              // 确保中文正常存储
  dateStrings: true,               // DATETIME 直接返回字符串，无需 JS Date 转换
  waitForConnections: true,
  connectionLimit: 10,
  connectTimeout: 10000,           // 10秒连接超时
  enableKeepAlive: true,           // 启用TCP Keep-Alive
  keepAliveInitialDelay: 0,        // Keep-Alive初始延迟
});

const WECHAT_APPID = process.env.WECHAT_APPID || 'wxecea6e915b217430';
const WECHAT_SECRET = process.env.WECHAT_SECRET || 'f2c23d00ebb1e12debc58dc9a6157349';
// JWT 密钥：优先从环境变量读取；否则从 WECHAT 凭据派生固定值，确保重启后 Token 不失效
const JWT_SECRET = process.env.JWT_SECRET
  || crypto.createHash('sha256').update(WECHAT_APPID + WECHAT_SECRET).digest('hex');
const JWT_EXPIRES = '7d';

// genId / safeRollback 定义在 utils/helpers.js 中

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Dota2 API' });
});

// 微信登录 - 用 code 换取 openid，签发 JWT token
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
        resp.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (parseErr) {
            reject(new Error('微信API返回非JSON: ' + parseErr.message));
          }
        });
        resp.on('error', reject);
      });
    });

    if (wxRes.openid) {
      // 签发 JWT token
      const token = jwt.sign({ openid: wxRes.openid }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
      // 确保用户记录存在
      try {
        const [rows] = await pool.query('SELECT openid FROM users WHERE openid = ?', [wxRes.openid]);
        if (!rows.length) {
          // 首个用户自动升级为超级管理员
          const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM users');
          const role = (total === 0) ? 'super_admin' : 'user';
          await pool.query(
            "INSERT INTO users (id, openid, role, nick_name, nick_change_count, created_at, updated_at) VALUES (?, ?, ?, '', 0, NOW(), NOW())",
            [genId(), wxRes.openid, role]
          );
        }
      } catch (e) {
        console.error('[auth] 用户初始化失败:', e.message);
      }
      // 【安全】不返回 session_key，防止泄露
      res.json({ success: true, openid: wxRes.openid, token });
    } else {
      res.status(400).json({ success: false, error: wxRes.errmsg || '登录失败' });
    }
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// JWT token 验证端点
app.get('/api/auth/verify', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: '未提供身份令牌' });
    }
    const token = authHeader.slice(7);
    const decoded = jwt.verify(token, JWT_SECRET);
    // 刷新 token（续期）
    const newToken = jwt.sign({ openid: decoded.openid }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    res.json({ success: true, openid: decoded.openid, token: newToken });
  } catch (e) {
    res.status(401).json({ success: false, error: '身份令牌无效或已过期' });
  }
});

// JWT 认证中间件 - 从 Authorization header 提取 openid
function jwtAuth(req, res, next) {
  req._openid = null;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.slice(7);
      const decoded = jwt.verify(token, JWT_SECRET);
      req._openid = decoded.openid || '';
    } catch (e) {
      // Token 无效或过期 - 记录日志以便排查（但不过度影响性能）
      if (e.name === 'TokenExpiredError') {
        console.log('[jwt] Token 已过期');
      } else if (e.name === 'JsonWebTokenError') {
        console.log('[jwt] Token 无效:', e.message);
      }
    }
  }
  next();
}

// 应用 JWT 中间件到所有请求
app.use(jwtAuth);

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
    calibrateMmr: row.calibrate_mmr ?? null,
    goodAtPositions: parsePositions(row.good_at_positions),
    signupPosition: parsePositions(row.signup_position),
    status: row.status || 'active',
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
    hasCreatedPlayer: row.has_created_player || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ============== 选手管理 ==============

// 前端筛选用英文code → 数据库存储的中文段位名映射
const RANK_CODE_MAP = {
  herald: '先锋', guardian: '卫士', crusader: '中军', archon: '统帅',
  legend: '传奇', ancient: '万古流芳', divine: '超凡入圣', immortal: '冠绝一世'
};

app.get('/api/players', async (req, res) => {
  try {
    const { rank, position, keyword, page, pageSize, sortBy, sortOrder } = req.query;
    let where = " WHERE status = 'active'";
    const params = [];
    // 将前端英文code转换为数据库中的中文段位名
    const rankName = RANK_CODE_MAP[rank] || rank;
    if (rank) { where += ' AND calibrate_rank_name = ?'; params.push(rankName); }
    if (position) { where += ' AND FIND_IN_SET(?, good_at_positions)'; params.push(String(position)); }
    if (keyword) {
      where += ' AND (wx_nickname LIKE ? OR steam_id LIKE ? OR game_id LIKE ?)';
      const kw = '%' + keyword + '%'; params.push(kw, kw, kw);
    }
    // 按段位排序
    let orderBy = ' ORDER BY created_at DESC';
    if (sortBy === 'rank') {
      orderBy = sortOrder === 'asc' ? ' ORDER BY calibrate_rank_sort ASC, created_at DESC' : ' ORDER BY calibrate_rank_sort DESC, created_at DESC';
    }
    const p = parseInt(page) || 1, ps = parseInt(pageSize) || 20;
    const sql = 'SELECT * FROM dota2_players' + where + orderBy + ' LIMIT ? OFFSET ?';
    const countSql = 'SELECT COUNT(*) as total FROM dota2_players' + where;
    const [rows] = await pool.query(sql, [...params, ps, (p - 1) * ps]);
    const [[{ total }]] = await pool.query(countSql, params);
    res.json({ success: true, data: rows.map(mapPlayer), total, page: p, pageSize: ps });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/players/:id', async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM dota2_players WHERE id = ? AND status = 'active'", [req.params.id]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'not found' });
    res.json({ success: true, data: mapPlayer(rows[0]) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/players', async (req, res) => {
  try {
    const openid = req._openid || '';
    const role = await getCallerRole(openid);
    const isAdmin = role === 'admin' || role === 'super_admin';

    // 普通用户自建档案：限昵称匹配 + 只能建一次
    if (!isAdmin) {
      // 非管理员自建档案：限昵称匹配 + 只能建一次
      const [userRows] = await pool.query('SELECT nick_name, has_created_player FROM users WHERE openid = ?', [openid]);
      const userNick = (userRows.length && userRows[0].nick_name) ? userRows[0].nick_name.trim() : '';
      if (!userNick) return res.status(400).json({ success: false, error: '请先设置昵称' });
      if (userRows[0].has_created_player) return res.status(400).json({ success: false, error: '您已创建过选手档案' });
      const wxNickname = (req.body.wxNickname || '').trim();
      if (userNick !== wxNickname) return res.status(400).json({ success: false, error: '昵称需与选手名一致' });
      // 检查是否已存在活跃选手
      const [dup] = await pool.query("SELECT id FROM dota2_players WHERE wx_nickname = ? AND status = 'active'", [wxNickname]);
      if (dup.length) return res.status(400).json({ success: false, error: '该昵称已存在' });
      // 创建基础档案（无段位/MMR）
      const { steamId, gameId } = req.body;
      const id = genId();
      await pool.query(
        "INSERT INTO dota2_players (id, wx_nickname, steam_id, game_id, status, created_at, updated_at) VALUES (?,?,?,?,'active',NOW(),NOW())",
        [id, wxNickname, steamId || '', gameId || '']
      );
      await pool.query('UPDATE users SET has_created_player = 1 WHERE openid = ?', [openid]);
      return res.json({ success: true, data: { _id: id } });
    }

    // 以下为管理员创建选手
    if (!await assertAdmin(req, res)) return;
    const { wxNickname, steamId, gameId, calibrateRankName, calibrateRankStar, calibrateMmr, goodAtPositions, signupPosition, avatarUrl } = req.body;
    const mmr = calibrateMmr != null && calibrateMmr > 0 ? Number(calibrateMmr) : null;
    if (!wxNickname) return res.status(400).json({ success: false, error: '微信群昵称不能为空' });

    // 检查是否已存在活跃选手（同名）
    const [dupActive] = await pool.query("SELECT id FROM dota2_players WHERE wx_nickname = ? AND status = 'active'", [wxNickname]);
    if (dupActive.length > 0) {
      return res.status(400).json({ success: false, error: '该微信群昵称已存在，请使用其他昵称' });
    }

    // 检查是否存在已删除的同名选手——恢复活跃并更新字段
    const [deletedPlayer] = await pool.query("SELECT id FROM dota2_players WHERE wx_nickname = ? AND status = 'deleted'", [wxNickname]);
    const gpos = Array.isArray(goodAtPositions) ? goodAtPositions.join(',') : (goodAtPositions || '');
    const spos = Array.isArray(signupPosition) ? signupPosition.join(',') : (signupPosition || '');
    const label = computeRankLabel(calibrateRankName, calibrateRankStar);
    const sort = computeRankSort(calibrateRankName, calibrateRankStar);

    if (deletedPlayer.length > 0) {
      // 恢复已删除选手
      await pool.query(
        "UPDATE dota2_players SET steam_id=?, game_id=?, calibrate_rank_name=?, calibrate_rank_star=?, calibrate_rank_label=?, calibrate_rank_sort=?, calibrate_mmr=?, good_at_positions=?, signup_position=?, avatar_url=?, status='active', updated_at=NOW() WHERE id=?",
        [steamId || '', gameId || '', calibrateRankName || '', calibrateRankStar || 0, label, sort, mmr, gpos, spos, avatarUrl || '', deletedPlayer[0].id]
      );
      res.json({ success: true, action: 'restored', data: { _id: deletedPlayer[0].id } });
    } else {
      const id = genId();
      await pool.query(
        "INSERT INTO dota2_players (id, wx_nickname, steam_id, game_id, calibrate_rank_name, calibrate_rank_star, calibrate_rank_label, calibrate_rank_sort, calibrate_mmr, good_at_positions, signup_position, avatar_url, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'active',NOW(),NOW())",
        [id, wxNickname, steamId || '', gameId || '', calibrateRankName || '', calibrateRankStar || 0, label, sort, mmr, gpos, spos, avatarUrl || '']
      );
      res.json({ success: true, action: 'inserted', data: { _id: id } });
    }
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.put('/api/players/:id', async (req, res) => {
  try {
    // 从 JWT 获取身份
    const openid = req._openid || '';
    const role = await getCallerRole(openid);
    const isAdmin = role === 'admin' || role === 'super_admin';

    // 非管理员需校验：昵称必须匹配选手 wxNickname，且不能修改段位/微信昵称
    if (!isAdmin) {
      const [userRows] = await pool.query('SELECT nick_name FROM users WHERE openid = ?', [openid]);
      const userNick = (userRows.length && userRows[0].nick_name) ? userRows[0].nick_name : '';
      const [playerRows] = await pool.query(
        "SELECT wx_nickname, calibrate_rank_name, calibrate_rank_star, calibrate_mmr FROM dota2_players WHERE id = ? AND status = 'active'",
        [req.params.id]
      );
      if (!playerRows.length) {
        return res.status(404).json({ success: false, error: '选手不存在或已被删除' });
      }
      if (!userNick) {
        return res.status(403).json({ success: false, error: '请先在首页设置您的游戏昵称，与选手的微信群昵称保持一致后即可自行编辑', code: 'NICK_NOT_SET' });
      }
      if ((playerRows[0].wx_nickname || '').trim() !== userNick.trim()) {
        return res.status(403).json({ success: false, error: '您的游戏昵称与选手微信群昵称不匹配，请确认或联系管理员修改' });
      }
      // 仅拦截实际修改的字段，避免误拒
      const current = playerRows[0];
      const rankNameChanged = req.body.calibrateRankName !== undefined && req.body.calibrateRankName !== (current.calibrate_rank_name || '');
      const rankStarChanged = req.body.calibrateRankStar !== undefined && req.body.calibrateRankStar !== (current.calibrate_rank_star || 0);
      const wxNickChanged = req.body.wxNickname !== undefined && req.body.wxNickname !== (current.wx_nickname || '');
      const mmrChanged = req.body.calibrateMmr !== undefined && (req.body.calibrateMmr ?? null) !== (current.calibrate_mmr ?? null);
      if (rankNameChanged || rankStarChanged || wxNickChanged || mmrChanged) {
        const blocked = [];
        if (rankNameChanged) blocked.push('段位名称');
        if (rankStarChanged) blocked.push('段位星数');
        if (wxNickChanged) blocked.push('微信昵称');
        if (mmrChanged) blocked.push('天梯分');
        return res.status(403).json({ success: false, error: '仅管理员可修改：' + blocked.join('、') });
      }
    }

    const { wxNickname, steamId, gameId, calibrateRankName, calibrateRankStar, calibrateMmr, goodAtPositions, signupPosition, avatarUrl } = req.body;
    const playerId = req.params.id;

    // 检查微信群昵称是否与其他人重复
    if (wxNickname !== undefined) {
      if (!wxNickname) return res.status(400).json({ success: false, error: '微信群昵称不能为空' });
      const [dupWx] = await pool.query("SELECT id FROM dota2_players WHERE wx_nickname = ? AND id != ? AND status = 'active'", [wxNickname, playerId]);
      if (dupWx.length > 0) {
        return res.status(400).json({ success: false, error: '该微信群昵称已被其他选手使用' });
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
      calibrateMmr: 'calibrate_mmr',
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
      // 白名单校验：确保所有列名均来自预定义集合（防御动态SQL注入）
      const ALLOWED_COLS = Object.values(fieldMap).concat(['calibrate_rank_label', 'calibrate_rank_sort', 'updated_at']);
      const setCols = sets.map(s => s.split(' ')[0]);
      const invalidCols = setCols.filter(c => !ALLOWED_COLS.includes(c));
      if (invalidCols.length) {
        return res.status(400).json({ success: false, error: '包含无效字段: ' + invalidCols.join(', ') });
      }
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
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      // 软删除选手
      const [result] = await conn.query("UPDATE dota2_players SET status='deleted', updated_at=NOW() WHERE id = ? AND status = 'active'", [req.params.id]);
      if (result.affectedRows === 0) {
        await safeRollback(conn, 'deletePlayer');
        conn.release();
        return res.status(404).json({ success: false, error: '选手不存在或已被删除' });
      }
      // 级联标记该选手未归档赛事的报名为无效
      await conn.query("UPDATE dota2_event_signup SET signup_status = 0 WHERE player_id = ? AND signup_status = 1 AND event_id IN (SELECT event_id FROM dota2_events WHERE is_archived = 0)", [req.params.id]);
      // 清理未归档赛事队伍中的选手
      const [teams] = await conn.query(
        "SELECT team_id, player_ids, captain_id FROM dota2_event_teams WHERE event_id IN (SELECT event_id FROM dota2_events WHERE is_archived = 0 OR is_archived IS NULL)"
      );
      for (const team of teams) {
        try {
          let ids = team.player_ids ? JSON.parse(team.player_ids) : [];
          if (!Array.isArray(ids)) continue;
          const newIds = ids.filter(pid => pid !== req.params.id);
          if (newIds.length === ids.length) continue;
          // 如果队长被删，选第一个队员为新队长
          let captain = team.captain_id === req.params.id ? (newIds[0] || null) : team.captain_id;
          if (captain) captain = String(captain);
          await conn.query(
            'UPDATE dota2_event_teams SET player_ids = ?, captain_id = ? WHERE team_id = ?',
            [JSON.stringify(newIds), captain, team.team_id]
          );
        } catch (_) { /* JSON 解析失败跳过 */ }
      }
      await conn.commit();
      conn.release();
      res.json({ success: true });
    } catch (e) {
      await safeRollback(conn, 'deletePlayer');
      conn.release();
      throw e;
    }
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/players/batch-delete', async (req, res) => {
  try {
    if (!await assertAdmin(req, res)) return;
    const { ids } = req.body;
    if (!ids || !ids.length) return res.status(400).json({ success: false, error: 'missing ids' });
    // 校验所有 id 为有效字符串
    if (!ids.every(id => typeof id === 'string' && id.length > 0)) {
      return res.status(400).json({ success: false, error: '无效的选手ID格式' });
    }
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [result] = await conn.query("UPDATE dota2_players SET status='deleted', updated_at=NOW() WHERE id IN (?) AND status = 'active'", [ids]);
      await conn.query("UPDATE dota2_event_signup SET signup_status = 0 WHERE player_id IN (?) AND signup_status = 1 AND event_id IN (SELECT event_id FROM dota2_events WHERE is_archived = 0 OR is_archived IS NULL)", [ids]);
      await conn.commit();
      conn.release();
      res.json({ success: true, deleted: result.affectedRows });
    } catch (e) {
      await safeRollback(conn, 'batchDelete');
      conn.release();
      throw e;
    }
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
      const wxNickname = (p.wxNickname || '').trim();
      const gameId = (p.gameId || '').trim();
      // 必填字段校验
      if (!wxNickname || !gameId) continue;
      const igp = Array.isArray(p.goodAtPositions) ? p.goodAtPositions.join(',') : (p.goodAtPositions || '');
      const isp = Array.isArray(p.signupPosition) ? p.signupPosition.join(',') : (p.signupPosition || '');
      // 后端统一计算段位，不信任前端传值
      const rankName = p.calibrateRankName || '';
      const rankStar = parseInt(p.calibrateRankStar) || 0;
      // 校验段位名合法性，无效视为未设置
      const validRank = RANK_OPTIONS.includes(rankName) ? rankName : '';
      const validStar = validRank && rankName !== '冠绝一世' ? Math.max(1, Math.min(5, rankStar)) : 0;
      const label = computeRankLabel(validRank, validStar);
      const sort = computeRankSort(validRank, validStar);
      const [existing] = await conn.query('SELECT id, status FROM dota2_players WHERE wx_nickname = ?', [wxNickname]);
      const mmr = p.calibrateMmr != null && p.calibrateMmr > 0 ? Number(p.calibrateMmr) : null;
      if (existing.length > 0) {
        await conn.query(
          "UPDATE dota2_players SET steam_id=?, game_id=?, calibrate_rank_name=?, calibrate_rank_star=?, calibrate_rank_label=?, calibrate_rank_sort=?, calibrate_mmr=?, good_at_positions=?, signup_position=?, avatar_url=?, status='active', updated_at=NOW() WHERE wx_nickname=?",
          [p.steamId || '', p.gameId || '', validRank, validStar, label, sort, mmr, igp, isp, p.avatarUrl || '', wxNickname]
        );
        updated++;
      } else {
        const id = genId();
        await conn.query(
          "INSERT INTO dota2_players (id, wx_nickname, steam_id, game_id, calibrate_rank_name, calibrate_rank_star, calibrate_rank_label, calibrate_rank_sort, calibrate_mmr, good_at_positions, signup_position, avatar_url, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'active',NOW(),NOW())",
          [id, wxNickname, p.steamId || '', p.gameId || '', validRank, validStar, label, sort, mmr, igp, isp, p.avatarUrl || '']
        );
        inserted++;
      }
    }
    await conn.commit();
    res.json({ success: true, imported: inserted + updated, inserted, updated });
  } catch (e) {
    await safeRollback(conn, 'importPlayers');
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
      '实际天梯分': 'calibrateMmr', 'calibrateMmr': 'calibrateMmr', 'calibratemmr': 'calibrateMmr',
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
        const mmr = row.calibrateMmr != null && row.calibrateMmr > 0 ? Number(row.calibrateMmr) : null;
        // 校验段位名合法性，无效视为未设置
        const validRank = RANK_OPTIONS.includes(rankName) ? rankName : '';
        const validStar = validRank && rankName !== '冠绝一世' ? Math.max(1, Math.min(5, rankStar)) : 0;
        const label = computeRankLabel(validRank, validStar);
        const sort = computeRankSort(validRank, validStar);
        const [existing] = await conn.query('SELECT id FROM dota2_players WHERE wx_nickname = ?', [row.wxNickname]);
        if (existing.length > 0) {
          await conn.query(
            "UPDATE dota2_players SET steam_id=?, game_id=?, calibrate_rank_name=?, calibrate_rank_star=?, calibrate_rank_label=?, calibrate_rank_sort=?, calibrate_mmr=?, good_at_positions=?, signup_position=?, status='active', updated_at=NOW() WHERE wx_nickname=?",
            [row.steamId || '', row.gameId, validRank, validStar, label, sort, mmr, gpos, spos, row.wxNickname]
          );
          updated++;
        } else {
          await conn.query(
            "INSERT INTO dota2_players (id, wx_nickname, steam_id, game_id, calibrate_rank_name, calibrate_rank_star, calibrate_rank_label, calibrate_rank_sort, calibrate_mmr, good_at_positions, signup_position, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'active',NOW(),NOW())",
            [genId(), row.wxNickname, row.steamId || '', row.gameId, validRank, validStar, label, sort, mmr, gpos, spos]
          );
          imported++;
        }
      }
      await conn.commit();
    } catch (e) {
      await safeRollback(conn, 'importXlsx');
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
    if (!assertLogin(req, res)) return;
    const workbook = xlsx.utils.book_new();
    const headers = ['微信群昵称', 'Steam ID', 'Dota2游戏昵称', '核准段位', '核准星数', '实际天梯分', '擅长游戏位置', '比赛报名位置'];
    const exampleRow = ['示例选手', '123456789', 'Dota2示例昵称', '统帅', 3, 3500, '1,2,3', '1'];
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
      { wch: 14 },  // 实际天梯分
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
    const [rows] = await pool.query("SELECT * FROM dota2_players WHERE status = 'active' ORDER BY created_at DESC");
    res.json({ success: true, data: rows.map(mapPlayer) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ============== 统计 & 文件 ==============

app.get('/api/stats/ranks', async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT IF(calibrate_rank_name = '' OR calibrate_rank_name IS NULL, '', calibrate_rank_name) as name, COUNT(*) as value FROM dota2_players WHERE status = 'active' GROUP BY name ORDER BY value DESC"
    );
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!assertLogin(req, res)) return;
    if (!req.file) return res.status(400).json({ success: false, error: 'no file' });
    res.json({ success: true, data: { url: '/uploads/' + req.file.filename } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// 权限校验工具
async function getCallerRole(openidOrReq) {
  // 从 JWT 获取 openid
  let openid;
  if (typeof openidOrReq === 'string') {
    openid = openidOrReq;
  } else if (openidOrReq && typeof openidOrReq === 'object') {
    openid = openidOrReq._openid || '';
  } else {
    openid = '';
  }
  if (!openid) return 'user';
  try {
    const [rows] = await pool.query('SELECT role FROM users WHERE openid = ?', [openid]);
    return rows.length ? rows[0].role : 'user';
  } catch (e) { return 'user'; }
}

// 断言当前请求者已登录，未登录返回 401
function assertLogin(req, res) {
  if (!req._openid) {
    res.status(401).json({ success: false, error: '请先登录' });
    return false;
  }
  return true;
}

// 断言当前请求者为管理员，非管理员直接返回 403
async function assertAdmin(req, res) {
  const openid = req._openid || '';
  if (!openid) {
    res.status(401).json({ success: false, error: '请先登录' });
    return false;
  }
  const role = await getCallerRole(openid);
  if (role !== 'admin' && role !== 'super_admin') {
    res.status(403).json({ success: false, error: '仅管理员可操作' });
    return false;
  }
  return true;
}

// 用户管理

app.get('/api/users/me', async (req, res) => {
  try {
    const openid = req._openid || '';
    if (!openid) return res.status(401).json({ success: false, error: '请先登录' });
    const [rows] = await pool.query('SELECT * FROM users WHERE openid = ?', [openid]);
    if (!rows.length) return res.json({ success: true, nickName: '', nickChangeCount: 0, role: 'user' });
    const u = mapUser(rows[0]);
    res.json({ success: true, ...u });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/users/:openid', async (req, res) => {
  try {
    // 权限校验：仅管理员或本人可查
    const openid = req._openid || '';
    const role = await getCallerRole(openid);
    const isAdmin = role === 'admin' || role === 'super_admin';
    if (!isAdmin && openid !== req.params.openid) {
      return res.status(403).json({ success: false, error: '仅可查询自己的用户信息' });
    }
    const [rows] = await pool.query('SELECT * FROM users WHERE openid = ?', [req.params.openid]);
    res.json({ success: true, data: rows[0] ? mapUser(rows[0]) : null });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/users', async (req, res) => {
  try {
    // 【权限对齐】与前端admin页面一致：仅超级管理员可查看完整用户列表
    const openid = req._openid || '';
    if (!openid) return res.status(401).json({ success: false, error: '请先登录' });
    const callerRole = await getCallerRole(openid);
    if (callerRole !== 'super_admin') {
      return res.status(403).json({ success: false, error: '仅超级管理员可查看用户列表' });
    }

    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize) || 20, 1), 200);
    const keyword = (req.query.keyword || '').trim();

    // 只返回有昵称的已注册用户
    let whereClause = "WHERE nick_name IS NOT NULL AND nick_name != ''";
    const params = [];

    if (keyword) {
      whereClause += ' AND (nick_name LIKE ? OR openid LIKE ?)';
      params.push('%' + keyword + '%', '%' + keyword + '%');
    }

    // 角色优先级排序：超管 > 管理员 > 普通用户
    const orderBy = "ORDER BY CASE role WHEN 'super_admin' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, nick_name ASC";
    const limitClause = 'LIMIT ? OFFSET ?';
    const offset = (page - 1) * pageSize;

    // 并行执行：计数 + 分页数据
    const [[countRows], [dataRows]] = await Promise.all([
      pool.query('SELECT COUNT(*) AS total FROM users ' + whereClause, params),
      pool.query('SELECT * FROM users ' + whereClause + ' ' + orderBy + ' ' + limitClause, [...params, pageSize, offset])
    ]);

    const total = countRows[0] ? countRows[0].total : 0;
    const totalPages = Math.ceil(total / pageSize);

    res.json({
      success: true,
      data: dataRows.map(mapUser),
      total,
      page,
      pageSize,
      totalPages
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/users/admins/list', async (req, res) => {
  try {
    // 所有登录用户可查看管理员列表（方便找人）
    const openid = req._openid || '';
    if (!openid) return res.status(401).json({ success: false, error: '请先登录' });
    const [rows] = await pool.query("SELECT * FROM users WHERE role IN ('admin','super_admin') ORDER BY role DESC, created_at ASC");
    res.json({ success: true, data: rows.map(mapUser) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.put('/api/users/:openid/role', async (req, res) => {
  try {
    const { role } = req.body;
    // 从 JWT 获取操作人身份
    const operatorOpenid = req._openid;
    if (!operatorOpenid) {
      return res.status(401).json({ success: false, error: '请先登录' });
    }
    // 权限校验：仅超级管理员可修改角色
    const callerRole = await getCallerRole(operatorOpenid);
    if (callerRole !== 'super_admin') {
      return res.status(403).json({ success: false, error: '仅超级管理员可修改权限' });
    }
    // 【安全】禁止超级管理员操作自己的角色（防止误操作降级导致系统失去管理）
    if (operatorOpenid === req.params.openid) {
      return res.status(400).json({ success: false, error: '不能修改自己的角色权限' });
    }
    // 【安全】校验目标角色合法性
    const validRoles = ['user', 'admin', 'super_admin'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ success: false, error: '无效的目标角色' });
    }
    const [r] = await pool.query('SELECT * FROM users WHERE openid = ?', [req.params.openid]);
    if (r.length) {
      await pool.query('UPDATE users SET role = ?, updated_at = NOW() WHERE openid = ?', [role, req.params.openid]);
    } else {
      const id = genId();
      await pool.query('INSERT INTO users (id, openid, role, nick_name, created_at, updated_at) VALUES (?,?,?,?,NOW(),NOW())', [id, req.params.openid, role, '']);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.put('/api/users/me/nickname', async (req, res) => {
  try {
    // 从 JWT 获取身份
    const openid = req._openid || '';
    const { nickName } = req.body;
    if (!openid || !nickName) return res.status(400).json({ success: false, error: '缺少参数' });

    const [dups] = await pool.query('SELECT openid FROM users WHERE nick_name = ? AND openid != ?', [nickName, openid]);
    if (dups.length) {
      return res.status(400).json({ success: false, error: '该昵称已被其他用户使用，请换一个' });
    }

    const [rows] = await pool.query('SELECT * FROM users WHERE openid = ?', [openid]);
    if (!rows.length) {
      const id = genId();
      try {
        await pool.query("INSERT INTO users (id,openid,nick_name,role,nick_change_count,created_at,updated_at) VALUES (?,?,?,'user',0,NOW(),NOW())", [id, openid, nickName]);
        res.json({ success: true, nickChangeCount: 0 });
      } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') {
          return res.status(400).json({ success: false, error: '该昵称已被其他用户使用，请换一个' });
        }
        throw e;
      }
    } else {
      const user = rows[0];
      const count = (user.nick_change_count || 0);
      const role = user.role || 'user';
      const MAX_CHANGES = 3;
      if (role !== 'admin' && role !== 'super_admin' && count >= MAX_CHANGES) {
        return res.status(400).json({ success: false, error: '修改次数已用完，请联系超级管理员重置', nickChangeCount: count });
      }
      try {
        await pool.query('UPDATE users SET nick_name=?,nick_change_count=nick_change_count+1,updated_at=NOW() WHERE openid=?', [nickName, openid]);
        res.json({ success: true, nickChangeCount: count + 1 });
      } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') {
          return res.status(400).json({ success: false, error: '该昵称已被其他用户使用，请换一个' });
        }
        throw e;
      }
    }
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.put('/api/users/:openid/reset-nickcount', async (req, res) => {
  try {
    // 权限校验：仅超级管理员可重置
    const operatorOpenid = req._openid || '';
    if (!operatorOpenid) return res.status(401).json({ success: false, error: '请先登录' });
    const callerRole = await getCallerRole(operatorOpenid);
    if (callerRole !== 'super_admin') {
      return res.status(403).json({ success: false, error: '仅超级管理员可重置修改次数' });
    }
    await pool.query('UPDATE users SET nick_change_count=0,updated_at=NOW() WHERE openid=?', [req.params.openid]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ============== 首页业务模块（首页介绍/公告/数据统计/赛事动态） ==============
// 【注意】必须在赛事模块之前注册，避免 /api/events/dynamic 被 /api/events/:eventId 拦截
require('./home-routes')(app, { pool, getCallerRole, upload });

// ============== 赛事业务模块（赛事/报名/队伍/对战/名次/章程） ==============
// 复用 pool / assertAdmin / getCallerRole，与现有代码共享连接和权限
require('./event-routes')(app, { pool, assertAdmin, getCallerRole, upload });

// ============== 统一权限中间件初始化 ==============
const auth = require('./utils/auth');
auth.init(pool, getCallerRole);

// 【调试接口】接口权限矩阵
app.get('/api/_debug/permissions', async (req, res) => {
  try {
    // 【安全修复】仅信任 JWT 验证的 openid
    const operatorOpenid = req._openid || '';
    if (!operatorOpenid) return res.status(401).json({ success: false, error: '请先登录' });
    const role = await getCallerRole(operatorOpenid);
    if (role !== 'super_admin') {
      return res.status(403).json({ success: false, error: '仅超级管理员可查看权限矩阵' });
    }
    res.json({
      success: true,
      data: {
        matrix: auth.PERMISSION_MATRIX,
        superAdminOnly: auth.getSuperAdminOnlyInterfaces(),
        statusFlow: {
          states: auth.STATUS_NAMES,
          rule: '严格正向顺序：创建中(0)→报名中(1)→报名截止(2)→分组锁定(3)→对战中(4)→已归档(5)。禁止跳跃、禁止回退。'
        }
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// === 全局错误处理（防止无效 JSON 等导致进程崩溃） ===
// body-parser 遇到非法 JSON 时会抛 SyntaxError，Express 4 默认不捕获会导致 crash
// === 全局错误处理中间件（统一错误码 + 防止 JSON 解析崩溃） ===
app.use(errorHandler);

// 未匹配路由 404
app.use((req, res) => {
  res.status(404).json({ success: false, error: '接口不存在', code: 'NOT_FOUND' });
});

// === 启动安全提示：检查是否使用了硬编码默认值（生产环境应用 env 变量覆盖） ===
if (!process.env.DB_PASSWORD) {
  console.warn('[security] ⚠ DB_PASSWORD 未设置，使用硬编码默认值。生产环境请通过 .env 文件设置。');
}
if (!process.env.WECHAT_SECRET) {
  console.warn('[security] ⚠ WECHAT_SECRET 未设置，使用硬编码默认值。生产环境请通过 .env 文件设置。');
}
if (!process.env.JWT_SECRET) {
  console.warn('[security] ⚠ JWT_SECRET 未设置，将从 WECHAT 凭据派生。生产环境建议显式设置。');
}

app.listen(PORT, () => {
  console.log(`Dota2 API running on http://localhost:${PORT}`);
});
