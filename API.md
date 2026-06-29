# Dota2 赛事管理系统 — API 接口文档

## 通用说明

- **Base URL**: `https://congqin.online/api`
- **认证**: `Authorization: Bearer <JWT_TOKEN>`
- **响应格式**:
  ```json
  { "success": true|false, "data": {...}, "error": "错误信息" }
  ```
- **分页响应**:
  ```json
  { "success": true, "data": [...], "total": 100, "page": 1, "pageSize": 20 }
  ```

---

## 一、认证与用户

### POST /auth/login — 微信登录
| 参数 | 类型 | 说明 |
|------|------|------|
| code | string | wx.login() 返回的 code |

返回: `{ success, token, openid, role, nickName }`

### GET /api/users/me — 获取当前用户信息
| 请求头 | 值 |
|--------|-----|
| Authorization | Bearer token |

返回: `{ success, openid, nickName, role, nickChangeCount, hasCreatedPlayer }`

### PUT /api/users/me/nickname — 修改昵称
| 参数 | 类型 | 说明 |
|------|------|------|
| nickName | string | 新昵称 |

### GET /api/users — 用户列表（超管）
| 参数 | 默认 | 说明 |
|------|------|------|
| page | 1 | 页码 |
| pageSize | 20 | 每页条数 |

返回: 分页的用户列表

### GET /api/users/admins/list — 管理员列表
返回: 所有 admin / super_admin 用户（全员可看）

### PUT /api/users/:openid/role — 修改角色（超管）
| 参数 | 类型 | 说明 |
|------|------|------|
| role | string | user / admin / super_admin |

### PUT /api/users/:openid/reset-nick-count — 重置修改次数
无参数

---

## 二、选手档案

### GET /api/players — 选手列表
| 参数 | 默认 | 说明 |
|------|------|------|
| page | 1 | 页码 |
| pageSize | 20 | 每页条数 |
| keyword | - | 昵称/SteamID/游戏ID 模糊搜索 |
| rank | - | 段位名称筛选 |
| position | - | 擅长位置筛选 (1-5) |
| sortBy | rank | 排序字段 |
| sortOrder | desc | 排序方向 asc/desc |

### GET /api/players/:id — 选手详情
### POST /api/players — 新增选手（管理员）
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| wxNickname | string | ✅ | 微信群昵称 |
| steamId | string | - | Steam ID |
| gameId | string | - | 游戏内昵称 |
| calibrateRankName | string | - | 核准段位（仅管理员） |
| calibrateRankStar | number | - | 星级（仅管理员） |
| calibrateMmr | number | - | 实际天梯分 |
| goodAtPositions | string | - | 擅长位置 逗号分隔 |
| signupPosition | string | - | 报名位置 逗号分隔 |
| avatarUrl | string | - | 头像URL |

> 非管理员用户创建条件：昵称与本人一致、无同名选手、未创建过

### PUT /api/players/:id — 编辑选手
参数: 同 POST，非管理员不可修改段位/MMR

### DELETE /api/players/:id — 软删除选手（管理员）
级联：清退未归档赛事报名、清理队伍 player_ids

### POST /api/players/batch-delete — 批量删除（超管）
| 参数 | 类型 | 说明 |
|------|------|------|
| ids | string[] | 选手ID数组 |

### GET /api/players/template/xlsx — 下载导入模板
### POST /api/players/import/xlsx — 上传 XLSX 导入
### GET /api/search/players — 搜索选手
| 参数 | 说明 |
|------|------|
| keyword | 按昵称模糊搜索 |

### GET /api/stats/ranks — 段位分布统计
返回: `[{ name: "传奇", value: 15 }]`

---

## 三、赛事

### GET /api/events — 进行中赛事列表
| 参数 | 默认 | 说明 |
|------|------|------|
| page | 1 | 页码 |
| pageSize | 20 | 每页条数 |
| keyword | - | 赛事名称搜索 |
| status | - | 状态筛选 (0-6) |
| archived | 0 | 是否归档 |

### GET /api/events/archived — 归档赛事列表
参数: 同 GET /api/events
返回含: `signup_count`, 前三名 `topRanks`

### GET /api/events/:eventId — 赛事详情
### POST /api/events — 创建赛事
| 参数 | 类型 | 说明 |
|------|------|------|
| eventName | string | 赛事名称 |
| startTime | timestamp | 开始时间 |
| eventDesc | string | 赛事描述 |
| signupLimit | number | 报名人数上限 |

### PUT /api/events/:eventId — 编辑赛事
### PUT /api/events/:eventId/status — 推进状态
| 参数 | 类型 | 说明 |
|------|------|------|
| eventStatus | number | 目标状态 (0-6) |

状态校验：严格顺序逐步推进

### POST /api/events/:eventId/clone — 克隆赛事
复制基本信息 + 章程

### DELETE /api/events/:eventId — 删除赛事（超管）

### GET /api/events/dynamic — 赛事动态
返回: 进行中赛事简要列表

---

## 四、报名

### GET /api/events/:eventId/signups — 报名列表
| 参数 | 默认 | 说明 |
|------|------|------|
| page | 1 | 页码 |
| pageSize | 20 | 每页条数 |
| status | 1 | 报名状态筛选 |

### GET /api/events/:eventId/my-signup — 我的报名状态
返回: `{ signed, data: { signupId, playerId, signupStatus, isActive } }`

### POST /api/events/:eventId/signups — 自主报名（事务保护 + FOR UPDATE）
### POST /api/events/:eventId/signups/batch — 管理员批量添加（事务保护）
| 参数 | 类型 | 说明 |
|------|------|------|
| playerIds | string[] | 选手ID数组 |

### DELETE /api/events/:eventId/signups/:signupId — 取消/剔除报名

---

## 五、队伍

### GET /api/events/:eventId/teams — 队伍列表+自由选手
返回: `{ teams: [team], freePlayers: [player] }`
队伍含: `teamId, teamName, captainId, members, totalMmr, avgMmr`

### POST /api/events/:eventId/teams/batch — 批量保存队伍
| 参数 | 类型 | 说明 |
|------|------|------|
| teams | object[] | 队伍数组 |
| teams[].teamName | string | 队伍名 |
| teams[].captainId | string | 队长ID |
| teams[].playerIds | string[] | 队员ID数组 |

### POST /api/events/:eventId/allocate-teams — 自动分队
| 参数 | 类型 | 说明 |
|------|------|------|
| teamCount | number | 队伍数 |

### POST /api/events/:eventId/lock-teams — 锁定编组（事务 + FOR UPDATE）
### PUT /api/events/:eventId/teams/:teamId/name — 重命名队伍
| 参数 | 类型 | 说明 |
|------|------|------|
| teamName | string | 新队名 |

### GET /api/events/:eventId/teams/scoreboard — 积分榜

---

## 六、对战

### GET /api/events/:eventId/matches — 对战列表（按轮次分组）
### POST /api/events/:eventId/matches/generate — 生成对战（事务保护）
### PUT /api/events/:eventId/matches/:matchId — 编辑对战
### PUT /api/events/:eventId/matches/:matchId/judge — 判定胜负
| 参数 | 类型 | 说明 |
|------|------|------|
| winnerId | string | 胜方队伍ID |
| confirmed | bool | 二次确认 |

### PUT /api/events/:eventId/matches/:matchId/revoke — 撤回判定（5分钟内）
### POST /api/events/:eventId/matches/:matchId/screenshot — 上传截图
### DELETE /api/events/:eventId/matches/:matchId — 删除对战（仅未开始）

---

## 七、名次与归档

### GET /api/events/:eventId/ranks — 名次列表
### POST /api/events/:eventId/ranks/batch — 批量保存名次
### PUT /api/events/:eventId/ranks/:rankId — 更新名次
### DELETE /api/events/:eventId/ranks/:rankId — 删除名次
### POST /api/events/:eventId/archive — 赛事归档（事务迁移）

---

## 八、首页与公告

### GET /api/home/intro — 首页介绍
返回: `{ data: [...blocks], updatedAt: "..." }`

### PUT /api/home/intro — 编辑介绍（超管）
### GET /api/announcements — 公告列表
### POST /api/announcements — 新增公告（超管）
### PUT /api/announcements/:id — 编辑公告（超管）
### DELETE /api/announcements/:id — 删除公告（超管）

### GET /api/stats/platform — 平台统计
返回: `{ registeredPlayers, totalEvents, activeEvents, finishedEvents }`

---

## 九、赛事章程

### GET /api/rules — 章程列表
| 参数 | 说明 |
|------|------|
| eventId | 选填，赛事绑定 |
| status | 选填，发布状态 |

### POST /api/rules — 创建章程（管理员）
### PUT /api/rules/:ruleId — 编辑章程
### DELETE /api/rules/:ruleId — 删除章程

---

## 十、调试

### GET /api/_debug/permissions — 权限矩阵（超管）
返回: 所有路由的权限配置
