# 🛡️ 蜀国争霸 — Dota2 赛事管理系统

微信小程序 + Node.js 后端，面向 Dota2 玩家圈子的赛事管理工具。支持选手档案管理、赛事全生命周期（创建→报名→自动分队→对战→名次→归档）、均衡分队算法、权限管理等功能。

---

## 功能概览

### 🏠 首页
- 图文介绍编辑（超管）
- 公告跑马灯（超管编辑/置顶/排序）
- 平台数据统计
- 管理员信息列表

### 👤 选手档案
- 选手列表（服务端分页，可按段位/位置筛选排序）
- 段位分布饼图
- 选手新增/编辑/软删除（管理员）
- 批量导入/导出（JSON / XLSX / CSV）
- 非管理员可自建选手档案（限一次，无修改段位权限）

### 🏆 赛事系统
- **状态流转**：`创建中→报名中→报名截止→分组锁定→对战中→已结束→已归档`
- **报名管理**：自主报名（昵称匹配） / 管理员批量添加，事务保护 + 防竞态
- **分组编队**：均衡分队算法（蛇形轮选 + 全局优化 + 位置补全），手动微调，队长设置
- **对战管理**：自动/手动配对，胜负判定（5 分钟内可撤回），多轮次，截图上传
- **名次归档**：设定 1-3 名，正式归档至 _his 表数据只读

### 📋 历史赛事
- 归档赛事只读查看（所有 Tab 可看不可改）
- 赛事克隆（复制基本信息 + 章程）

### 📜 赛事章程
- 通用章程 / 赛事绑定章程
- 创建 / 编辑 / 删除 / 版本管理

### 🔐 权限体系
- 三级角色：`super_admin` / `admin` / `user`
- 超管：所有权限 + 用户管理 + 删除赛事 + 首页编辑
- 管理员：赛事全流程 + 选手档案 CRUD
- 用户：查看 + 报名/取消 + 编辑本人基础信息

### ⚙️ 环境切换
- 一键切换测试/生产环境（`miniprogram/utils/env.js`）
- 测试环境：`https://congqin.online/test-api` → `dota2_test` 数据库

---

## 快速开始

### 前置要求
- Node.js ≥ 18
- MySQL 8.0
- 微信小程序 AppID
- 微信云开发环境（可选，用于头像迁移）

### 1. 配置环境变量
```bash
cp server/.env.example server/.env
# 编辑 server/.env 填入实际配置
```

### 2. 安装依赖 & 初始化数据库
```bash
cd server && npm install
# 执行 SQL 迁移脚本
mysql -u root -p < server/sql/001_create_event_tables.sql
mysql -u root -p < server/sql/002_create_archive_tables.sql
# ... 其他脚本按需执行
```

### 3. 启动服务
```bash
npm start          # 生产模式（端口 3000）
npm run dev        # 开发模式（nodemon 热重载）
```

### 4. 前端配置
编辑 `miniprogram/utils/env.js`：
```js
const USE_TEST = false   // false=生产, true=测试
```

用微信开发者工具打开 `miniprogram/` 目录，填入自己的 AppID 即可编译运行。

---

## 项目结构

```
├── server/                    # 后端 Express API
│   ├── index.js              # 主入口
│   ├── routes/               # 路由模块
│   │   ├── event-crud.js     # 赛事 CRUD
│   │   ├── event-signups.js  # 报名管理
│   │   ├── event-teams.js    # 队伍管理
│   │   ├── event-matches.js  # 对战管理
│   │   ├── event-ranks.js    # 名次管理
│   │   ├── event-rules.js    # 章程管理
│   │   └── event-helpers.js  # 公共工具函数
│   ├── utils/
│   │   ├── auth.js           # JWT 权限中间件
│   │   ├── team-allocation.js# 均衡分队算法
│   │   ├── rank-score.js     # MMR 等效分计算
│   │   ├── errors.js         # 统一错误码
│   │   └── helpers.js        # 公共函数
│   └── sql/                  # 数据库迁移脚本
│
├── miniprogram/              # 微信小程序前端
│   ├── app.js / app.json / app.wxss
│   ├── utils/                # API/权限/段位/弹窗/日期工具
│   ├── pages/                # 11 个页面
│   │   ├── index/            # 首页 + 选手档案 + 赛事章程 + 历史赛事
│   │   ├── event-detail/     # 赛事详情（5 个 Tab）
│   │   ├── dota2-add/        # 新增选手
│   │   ├── dota2-detail/     # 选手详情
│   │   ├── dota2-import/     # 批量导入导出
│   │   ├── ...               # 其他页面
│   └── components/modal/     # 自定义弹窗
│
├── switch-env.sh             # 一键切换测试/生产环境
├── deploy-server.js          # 一键部署脚本
└── server/.env.example       # 环境变量示例
```

---

## 部署

### 一键部署
```bash
npm run deploy
# 或部署测试环境
npm run test   # 一键切换测试环境
npm run prod   # 一键切回生产环境
```

### 环境切换
```bash
npm run test   # 同步数据库 → 重启测试服务 → 前端切测试
npm run prod   # 前端切生产 → 重启生产服务
```

---

## 技术栈

| 层 | 技术 |
|----|------|
| 前端 | 微信原生小程序（WXML + WXSS + JS） |
| 后端 | Node.js + Express 4 |
| 数据库 | MySQL 8.0（utf8mb4） |
| 认证 | 微信 jscode2session + JWT |
| 部署 | PM2 + Nginx |
| 服务器 | 阿里云 ECS / CentOS |

---

## 开源协议

MIT
