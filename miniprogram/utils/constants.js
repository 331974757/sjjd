// utils/constants.js - 全局常量

// 分页
const PAGE_SIZE = 20
const MORE_PAGE_SIZE = 10

// 昵称
const NICK_CHANGE_LIMIT = 3

// 数字补零
const pad = n => String(n).padStart(2, '0')

module.exports = {
  PAGE_SIZE,
  MORE_PAGE_SIZE,
  NICK_CHANGE_LIMIT,
  pad
}
