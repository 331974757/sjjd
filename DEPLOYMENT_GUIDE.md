# 🏆 蜀国争霸 Dota2 赛事系统 — 第9轮全局整合 + 部署说明书

> 更新时间：2026-06-16  
> 服务器：阿里云 ECS 121.41.191.80  
> 后端：Node.js Express 4 + PM2  
> 前端：微信原生小程序  
> 数据库：MySQL 8.0

---

## 一、接口权限对照表

### 1.1 超级管理员(super_admin)独有接口

这些接口 admin 和 user 均不可调用，返回 403：

| 方法 | 路径 | 说明 |
|------|------|------|
| PUT | `/api/users/:openid/role` | 修改用户角色 |
| PUT | `/api/users/:openid/reset-nickcount` | 重置改名次数 |
| DELETE | `/api/events/:eventId` | 删除未归档赛事 |
| GET | `/api/_debug/permissions` | 调试：查看权限矩阵 |

### 1.2 admin 与 super_admin 权限完全一致的接口

以下模块两类管理员操作权限**完全相同**，无任何差异：

#### 选手档案模块

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/players` | 新增选手 |
| PUT | `/api/players/:id` | 编辑选手（管理员可改段位，普通用户仅限本人改非段位字段） |
| DELETE | `/api/players/:id` | 删除选手 |
| POST | `/api/players/batch-delete` | 批量删除 |
| POST | `/api/players/import` | JSON批量导入 |
| POST | `/api/players/import/xlsx` | XLSX批量导入 |
| GET | `/api/players/export/all` | 导出全部选手 |
| POST | `/api/upload` | 头像上传 |

#### 赛事章程模块

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/rules` | 创建章程 |
| PUT | `/api/rules/:ruleId` | 编辑章程 |
| DELETE | `/api/rules/:ruleId` | 删除章程 |

#### 赛事管理（写操作）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/events` | 创建赛事 |
| PUT | `/api/events/:eventId` | 编辑赛事（归档拦截） |
| PUT | `/api/events/:eventId/status` | 状态变更（严格顺序） |

#### 报名管理

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/events/:eventId/signups/admin` | 管理员添加报名 |
| POST | `/api/events/:eventId/signups/batch` | 批量添加报名 |

#### 队伍管理

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/events/:eventId/teams/batch` | 批量保存编组 |
| POST | `/api/events/:eventId/allocate-teams` | 自动分队 |
| POST | `/api/events/:eventId/lock-teams` | 开赛锁定（3→4） |
| DELETE | `/api/events/:eventId/teams/:teamId` | 删除队伍 |

#### 对战管理

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/events/:eventId/matches/generate` | 生成对战 |
| PUT | `/api/events/:eventId/matches/:matchId/judge` | 判定胜负 |
| DELETE | `/api/events/:eventId/matches/:matchId` | 删除对战（未判定） |
| POST | `/api/events/:eventId/next-round` | 进入下一轮 |
| POST | `/api/events/:eventId/end-battle` | 结束比赛 |

#### 名次 & 归档

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/events/:eventId/ranks/batch` | 批量保存名次 |
| POST | `/api/events/:eventId/ranks` | 设置单个名次 |
| PUT | `/api/events/:eventId/ranks/:rankId` | 更新名次 |
| DELETE | `/api/events/:eventId/ranks/:rankId` | 删除名次 |
| POST | `/api/events/:eventId/archive` | 正式归档 |

### 1.3 普通用户(user)可调用接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/events` | 赛事列表 |
| GET | `/api/events/archived` | 已归档赛事列表 |
| GET | `/api/events/:eventId` | 赛事详情 |
| GET | `/api/events/:eventId/full` | 全量历史数据 |
| GET | `/api/events/:eventId/signups` | 报名列表（仅看有效报名） |
| GET | `/api/events/:eventId/my-signup` | 我的报名状态 |
| POST | `/api/events/:eventId/signups` | 自主报名（开放报名时） |
| DELETE | `/api/events/:eventId/signups/:signupId` | 取消自己的报名 |
| GET | `/api/events/:eventId/teams` | 队伍+自由选手 |
| GET | `/api/events/:eventId/matches` | 对战列表 |
| GET | `/api/events/:eventId/matches/rounds` | 轮次汇总 |
| GET | `/api/events/:eventId/ranks` | 名次列表 |
| GET | `/api/rules` | 章程列表（仅看已发布） |
| GET | `/api/rules/:ruleId` | 章程详情 |
| GET | `/api/events/:eventId/rules` | 赛事绑定章程 |
| GET | `/api/players` | 选手列表 |
| GET | `/api/players/:id` | 选手详情 |
| PUT | `/api/players/:id` | 编辑本人信息（非段位/昵称字段） |
| GET | `/api/search/players` | 选手搜索 |
| GET | `/api/users/me` | 当前用户信息 |
| PUT | `/api/users/me/nickname` | 修改昵称 |

---

## 二、赛事状态流转规则

### 2.1 状态枚举

```
0 = 创建中      — 赛事基本信息可编辑，等待开启报名
1 = 报名中      — 选手可自主报名/取消报名，管理员可管理报名
2 = 报名截止    — 停止报名，管理员可进行队伍编排
3 = 分组锁定    — 队伍编排完成，等待开赛
4 = 对战中      — 比赛进行中，管理员可编排对战/判定胜负
5 = 已归档(未归档) — 比赛结束，管理员可设定名次/正式归档
5 + is_archived=1 — 正式归档，全部只读
```

### 2.2 流转规则

```
创建中(0) ──→ 报名中(1) ──→ 报名截止(2) ──→ 分组锁定(3) ──→ 对战中(4) ──→ 已归档(5)
                                                       ↓
                                              正式归档(is_archived=1)
```

**严格限制：**
- ✗ 禁止跳跃：不允许 0→3、1→4 等非连续跳转
- ✗ 禁止回退：不允许 5→4、4→3 等逆向操作
- ✗ 禁止重复：已在某状态，不可再次推进到同一状态

### 2.3 各状态下允许的操作

| 操作 \\ 状态 | 0 创建中 | 1 报名中 | 2 报名截止 | 3 分组锁定 | 4 对战中 | 5 已归档(未归档) | 5 已归档(正式) |
|---|---|---|---|---|---|---|---|
| 编辑赛事信息 | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| 选手自主报名 | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| 取消报名 | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| 管理添加报名 | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| 队伍编排 | ❌ | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ |
| 自动分队 | ❌ | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ |
| 锁定开赛 | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| 编排对战 | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ |
| 判定胜负 | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ |
| 结束比赛 | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ |
| 设定名次 | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| 正式归档 | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| 删除赛事 | ✅(超管) | ✅(超管) | ✅(超管) | ✅(超管) | ✅(超管) | ✅(超管) | ❌ |

---

## 三、数据隔离机制

### 3.1 强制规则

所有业务表携带 `event_id` 外键，所有业务接口按 `event_id` 过滤：

| 表名 | 外键字段 | 说明 |
|---|---|---|
| `dota2_event_signup` | `event_id` | 报名记录 |
| `dota2_event_teams` | `event_id` | 队伍数据 |
| `dota2_event_matches` | `event_id` | 对战记录 |
| `dota2_event_ranks` | `event_id` | 名次记录 |
| `dota2_event_rules_binding` | `event_id` | 赛事章程绑定 |

### 3.2 隔离实现方式

**后端层面**（三重保障）：
1. **路由参数**：所有业务接口路径含 `:eventId`，从 URL 提取
2. **SQL WHERE 条件**：每条查询强制 `WHERE event_id = ?`
3. **跨赛事操作拦截**：名次、对战、队伍等操作的 ID 通过子查询/联表校验归属

**前端层面**：通过 URL 参数 `eventId` 传递，页面 onLoad 时绑定，接口调用时自动带上。

---

## 四、新增代码文件说明

### 4.1 后端新增

| 文件 | 说明 |
|---|---|
| `server/utils/auth.js` | 统一权限/状态/归档中间件（含完整接口权限矩阵） |

核心能力：
- **Express 中间件**：`requireAdmin`、`requireSuperAdmin`、`requireSignupOpen`、`requireTeamEditable`、`requireBattleActive`、`requireNotArchived`、`requireAdminNotArchived`、`requireAdminSignupManage`、`requireAdminCanSetRank`
- **手动调用版**：`isAdmin()`、`isSuperAdmin()`、`validateNotArchived()`、`validateSignupEvent()`、`validateTeamEditable()`、`validateBattleEvent()`、`validateStatusTransition()`
- **文档数据**：`PERMISSION_MATRIX`（完整接口权限矩阵）、`getSuperAdminOnlyInterfaces()`、`getAdminEqualInterfaces()`

### 4.2 前端修改

| 文件 | 变更 |
|---|---|
| `miniprogram/utils/permission.js` | 新增 `checkAction()`、`checkActions()`、`flattenActions()` + `EVENT_STATUS`/`STATUS_NAMES` 常量 |
| `miniprogram/pages/event-team-edit/event-team-edit.js` | 修复 `perm.requireRole` → `perm.getRole`（之前不存在此方法） |

### 4.3 服务端修改

| 文件 | 变更 |
|---|---|
| `server/index.js` | 新增 auth 模块初始化 + `/api/_debug/permissions` 调试接口 |

---

## 五、阿里云 ECS 部署步骤

### 5.1 环境确认

```bash
# SSH 登录服务器
ssh root@121.41.191.80

# 确认目录结构
ls /opt/dota2-api/
# 应包含：index.js, event-routes.js, utils/, uploads/, package.json

# 确认 PM2 进程
pm2 list
# 应有 dota2-api 进程，状态 online

# 确认 MySQL 服务
systemctl status mysql
```

### 5.2 部署后端代码

```bash
# 方式一：一键部署（在本地项目根目录执行）
npm run deploy

# 方式二：手动部署
# 上传文件
scp server/index.js root@121.41.191.80:/opt/dota2-api/index.js
scp server/event-routes.js root@121.41.191.80:/opt/dota2-api/event-routes.js
scp -r server/utils/ root@121.41.191.80:/opt/dota2-api/utils/

# 重启服务
ssh root@121.41.191.80 "pm2 reload dota2-api"

# 查看日志
ssh root@121.41.191.80 "pm2 logs dota2-api --lines 50"
```

### 5.3 数据库脚本执行（如有新增）

```bash
# 上传SQL文件
scp server/sql/*.sql root@121.41.191.80:/opt/dota2-api/sql/

# 执行迁移脚本
ssh root@121.41.191.80 "mysql -u root -p'Dota2Migrate@2026' dota2 < /opt/dota2-api/sql/002_archive_migration.sql"
```

### 5.4 前端小程序部署

1. 在微信开发者工具中打开项目
2. 确认 `project.config.json` 中 appid 为 `wxecea6e915b217430`
3. 点击「上传」→ 填写版本号和描述
4. 登录 MP 后台 → 版本管理 → 提交审核

### 5.5 常见问题排查

| 问题 | 排查方法 |
|---|---|
| 接口返回 500 | `pm2 logs dota2-api --err` 查看错误日志 |
| 数据库连接失败 | `mysql -u dota2 -p'Yang8728135@' dota2 -e "SELECT 1"` |
| 接口跨域 | 确认 `server/index.js` 中有 `app.use(cors())` |
| 权限校验异常 | 调用 `/api/users/me?openid=xxx` 确认角色 |
| PM2 进程崩溃 | `pm2 restart dota2-api`，检查 `.env` 文件是否存在 |
| 上传目录无权限 | `chmod 755 /opt/dota2-api/uploads` |

---

## 六、全流程验收清单

按以下步骤逐一测试，验证系统完整性：

### 阶段1：基础功能验证

- [ ] 1.1 选手档案列表正常加载，搜索筛选正常
- [ ] 1.2 新增/编辑/删除选手正常，权限校验生效
- [ ] 1.3 JSON/XLSX 批量导入正常
- [ ] 1.4 头像上传正常

### 阶段2：赛事全流程验证

- [ ] 2.1 **创建赛事** → 填写赛事名称/时间/描述 → 状态变为「创建中」
- [ ] 2.2 **状态推进** → 创建中→报名中（状态流转严格顺序）
- [ ] 2.3 **选手报名** → 普通用户用匹配昵称报名 → 报名列表可见
- [ ] 2.4 **管理员添加** → admin 手动添加报名人员
- [ ] 2.5 **取消报名** → 选手自主取消 → 管理员取消他人
- [ ] 2.6 **状态推进** → 报名中→报名截止

### 阶段3：队伍编排验证

- [ ] 3.1 **自动分队** → 均衡分队算法分配 → 队伍均衡度统计展示
- [ ] 3.2 **拖拽编组** → 点击选手→点击队伍放入 → 移出队伍
- [ ] 3.3 **队长设置** → 点击👑设置队长 → 取消队长
- [ ] 3.4 **新建/删除队伍** → 删除时队员释放回自由区
- [ ] 3.5 **状态推进** → 报名截止→分组锁定
- [ ] 3.6 **锁定开赛** → 队伍永久锁定 → 状态→对战中

### 阶段4：对战管理验证

- [ ] 4.1 **生成对战** → 自动配对/手动编排 → 对战列表展示
- [ ] 4.2 **判定胜负** → 选择胜方→二次确认 → 对战结果更新
- [ ] 4.3 **进入下一轮** → 本轮全部完成 → 生成下一轮对战
- [ ] 4.4 **结束比赛** → 全部对战完成 → 状态→已归档

### 阶段5：名次与归档验证

- [ ] 5.1 **设定名次** → 1/2/3名队伍选择 → 保存成功
- [ ] 5.2 **正式归档** → 二次确认 → is_archived=1
- [ ] 5.3 **归档后只读** → 编辑/报名/编组/对战操作全部拦截
- [ ] 5.4 **历史赛事列表** → 已归档赛事出现在「历史赛事」Tab

### 阶段6：权限边界验证（关键！）

- [ ] 6.1 **admin 操作选手档案** → 增删改查均正常
- [ ] 6.2 **admin 操作赛事管理** → 全流程均正常
- [ ] 6.3 **admin 操作章程** → 增删改正常
- [ ] 6.4 **admin 操作用户管理** → 返回403（超管独有）
- [ ] 6.5 **admin 删除赛事** → 返回403（超管独有）
- [ ] 6.6 **user 查看公开信息** → 所有查询类接口正常
- [ ] 6.7 **user 编辑选手** → 非管理员禁止修改段位/昵称
- [ ] 6.8 **user 管理操作** → 全部返回403

### 阶段7：数据隔离验证

- [ ] 7.1 **创建两场赛事** → 分别报名不同选手
- [ ] 7.2 **交叉查询** → 赛事A的接口看不到赛事B的数据
- [ ] 7.3 **跨赛事操作** → 无法用赛事A的team_id操作赛事B

### 阶段8：搜索与分页

- [ ] 8.1 **历史赛事搜索** → 按名称模糊搜索正常
- [ ] 8.2 **历史赛事分页** → 加载更多正常
- [ ] 8.3 **历史赛事卡片** → 显示参赛人数 + 前三名

---

## 七、前端按钮灰化使用示例

### 7.1 在页面的 onLoad/onShow 中调用

```javascript
const perm = require('../../utils/permission.js')

onLoad() {
  // 获取角色
  perm.getRole().then(role => {
    // 批量检查允许的操作
    const btns = perm.checkActions([
      'signup', 'cancel_signup', 'manage_teams', 
      'manage_matches', 'archive_event', 'delete_event'
    ], {
      eventStatus: this.data.event.event_status,
      isArchived: this.data.event.is_archived,
      userRole: role
    })
    
    // 展平到 data 中，方便 WXML 使用
    this.setData({
      userRole: role,
      ...perm.flattenActions(btns)
    })
  })
}
```

### 7.2 在 WXML 中使用

```html
<!-- 示例：报名按钮（仅状态允许且角色允许时显示） -->
<button 
  wx:if="{{signup_allowed}}" 
  bindtap="doSignup"
>
  我要报名
</button>
<view wx:else class="btn-disabled">
  {{signup_reason}}
</view>

<!-- 示例：管理按钮组 -->
<view class="admin-actions">
  <button wx:if="{{manage_teams_allowed}}" bindtap="goTeamEdit">队伍编排</button>
  <button wx:if="{{manage_matches_allowed}}" bindtap="goMatchEdit">对战管理</button>
  <button wx:if="{{archive_event_allowed}}" bindtap="doArchive">归档赛事</button>
  
  <!-- 灰化按钮（显示原因） -->
  <button wx:if="{{!manage_teams_allowed}}" disabled>
    队伍编排（{{manage_teams_reason}}）
  </button>
</view>
```

---

## 八、测试用 API 调用示例

```bash
# 1. 获取权限矩阵（需超管 openid）
curl "https://congqin.online/api/_debug/permissions?openid=<SUPER_ADMIN_OPENID>"

# 2. 测试归档列表
curl "https://congqin.online/api/events/archived?page=1&pageSize=5"

# 3. 测试全量数据
curl "https://congqin.online/api/events/19ece66bd6372cf0f59/full"

# 4. 测试搜索历史赛事
curl "https://congqin.online/api/events/archived?keyword=蜀国"

# 5. 测试权限拦截（普通用户访问超管接口）
curl -X DELETE "https://congqin.online/api/events/xxx?openid=<USER_OPENID>"
# 预期返回：{"success":false,"error":"仅超级管理员可操作"}

# 6. 测试状态校验（报名截止后报名）
curl -X POST "https://congqin.online/api/events/<EVENT_STATUS_2>/signups?openid=xxx" \
  -H "Content-Type: application/json" \
  -d '{"playerId":"xxx"}'
# 预期返回：{"success":false,"error":"报名已截止"}
```
