/**
 * 一键部署后端到阿里云 ECS
 * 用法: node deploy-server.js
 * 前提: 已配置 SSH 密钥登录服务器
 */

const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

// ======== 服务器配置 ========
const SERVER = {
  host: process.env.SERVER_HOST || '121.41.191.80',
  port: 22,
  username: process.env.SERVER_USER || 'root',
  // 优先使用 SSH 密钥，没有则用环境变量密码
  privateKey: fs.existsSync(process.env.HOME + '/.ssh/id_rsa') 
    ? fs.readFileSync(process.env.HOME + '/.ssh/id_rsa') 
    : undefined,
  password: process.env.SERVER_PASSWORD || undefined
};

const REMOTE_DIR = '/opt/dota2-api';
const LOCAL_DIR = path.join(__dirname, 'server');

// 不需要上传的文件/目录
const SKIP_LIST = ['node_modules', '.env', 'uploads', '.git'];

function log(msg) { console.log(`[deploy] ${msg}`); }
function err(msg) { console.error(`[deploy] ❌ ${msg}`); process.exit(1); }

// 递归获取所有需要上传的文件
function getFiles(dir, base = '') {
  const results = [];
  const entries = fs.readdirSync(path.join(dir, base), { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_LIST.includes(entry.name)) continue;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const full = path.join(dir, rel);
    if (entry.isDirectory()) {
      results.push(...getFiles(dir, rel));
    } else {
      results.push({ local: full, remote: rel });
    }
  }
  return results;
}

// SSH 连接并执行命令
function execSSH(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (e, stream) => {
      if (e) return reject(e);
      let out = '', errOut = '';
      stream.on('data', d => { out += d.toString(); process.stdout.write(d); });
      stream.stderr.on('data', d => { errOut += d.toString(); process.stderr.write(d); });
      stream.on('close', (code) => {
        if (code !== 0) return reject(new Error(`命令退出码 ${code}: ${errOut}`));
        resolve(out);
      });
    });
  });
}

// SFTP 上传文件
function uploadFile(sftp, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, (e) => {
      if (e) return reject(e);
      resolve();
    });
  });
}

// 主流程
async function deploy() {
  const files = getFiles(LOCAL_DIR);
  log(`待上传 ${files.length} 个文件`);

  const conn = new Client();

  await new Promise((resolve, reject) => {
    conn.on('ready', resolve);
    conn.on('error', reject);
    conn.connect(SERVER);
  });

  log('SSH 已连接');

  try {
    // 1. 确保远程目录存在
    log('创建远程目录...');
    await execSSH(conn, `mkdir -p ${REMOTE_DIR}`);

    // 2. SFTP 上传文件
    log('上传文件中...');
    const sftp = await new Promise((resolve, reject) => {
      conn.sftp((e, sftp) => e ? reject(e) : resolve(sftp));
    });

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const remotePath = `${REMOTE_DIR}/${f.remote}`.replace(/\\/g, '/');
      // 确保远程父目录存在
      const remoteDir = path.dirname(remotePath).replace(/\\/g, '/');
      try { await execSSH(conn, `mkdir -p ${remoteDir}`); } catch (_) {}
      
      await uploadFile(sftp, f.local, remotePath);
      log(`  [${i + 1}/${files.length}] ${f.remote}`);
    }

    // 3. npm install
    log('安装依赖...');
    await execSSH(conn, `cd ${REMOTE_DIR} && npm install --production`);

    // 4. 重启服务 (PM2 入口为 /opt/dota2-api/index.js)
    log('重启服务...');
    await execSSH(conn, `pm2 restart dota2-api || pm2 start ${REMOTE_DIR}/index.js --name dota2-api`);
    await execSSH(conn, 'pm2 save');

    log('✅ 部署完成！');
  } finally {
    conn.end();
  }
}

deploy().catch(e => {
  err(e.message);
  process.exit(1);
});
