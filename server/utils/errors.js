/**
 * 统一错误处理工具
 * 提供结构化错误码和便捷的错误响应生成
 */

// 错误码枚举
const ERROR_CODES = {
  VALIDATION_ERROR:  'VALIDATION_ERROR',   // 参数校验失败
  NOT_FOUND:         'NOT_FOUND',          // 资源不存在
  AUTH_ERROR:        'AUTH_ERROR',         // 认证失败（未登录/Token过期）
  PERMISSION_DENIED: 'PERMISSION_DENIED',  // 权限不足
  STATUS_ERROR:      'STATUS_ERROR',       // 赛事状态流转错误
  ARCHIVED:          'ARCHIVED',           // 赛事已归档
  DUPLICATE:         'DUPLICATE',          // 重复操作
  DB_ERROR:          'DB_ERROR',           // 数据库错误
  INTERNAL_ERROR:    'INTERNAL_ERROR',     // 服务器内部错误
};

/**
 * 生成统一错误响应
 * @param {number} status  - HTTP 状态码
 * @param {string} code    - 错误码（ERROR_CODES 之一）
 * @param {string} message - 用户可读的错误消息
 * @param {Object} [extra] - 额外的数据字段
 * @returns {Object} Express 响应对象（可直接 return 或 res.json）
 */
function error(status, code, message, extra = {}) {
  const body = { success: false, error: message, code };
  return { status, body: Object.assign(body, extra) };
}

/**
 * Express 全局错误处理中间件
 * 用法: app.use(errorHandler);
 */
function errorHandler(err, req, res, _next) {
  // 如果已经是统一格式的错误对象
  if (err._isApiError) {
    return res.status(err.status).json(err.body);
  }
  // JSON 解析错误
  if (err instanceof SyntaxError && err.type === 'entity.parse.failed') {
    return res.status(400).json({
      success: false, error: '请求 JSON 格式错误', code: ERROR_CODES.VALIDATION_ERROR
    });
  }
  // 未捕获的异常
  console.error('[UNHANDLED]', err.message || err);
  if (err.stack) console.error(err.stack);
  return res.status(500).json({
    success: false, error: '服务器内部错误', code: ERROR_CODES.INTERNAL_ERROR
  });
}

/**
 * 便捷工厂函数：生成可直接 throw 的错误对象
 */
function apiError(status, code, message, extra = {}) {
  const err = new Error(message);
  err._isApiError = true;
  err.status = status;
  err.body = { success: false, error: message, code, ...extra };
  return err;
}

module.exports = { ERROR_CODES, error, errorHandler, apiError };
