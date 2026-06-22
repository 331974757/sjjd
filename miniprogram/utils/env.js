/**
 * 环境配置
 * 切换方式：修改下方 USE_TEST，true=测试环境，false=生产环境
 */
const USE_TEST = true

const PROD = {
  API_BASE: 'https://congqin.online/api',
  BASE_URL: 'https://congqin.online',
}

const TEST = {
  API_BASE: 'https://congqin.online/test-api',
  BASE_URL: 'https://congqin.online',
}

const CONFIG = USE_TEST ? TEST : PROD

module.exports = {
  API_BASE: CONFIG.API_BASE,
  BASE_URL: CONFIG.BASE_URL,
  USE_TEST,
}
