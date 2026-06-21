#!/bin/bash
# 一键切换环境
# 用法: bash switch-env.sh [prod|test]

MODE=${1:-test}
SERVER="root@121.41.191.80"

if [ "$MODE" = "test" ]; then
  echo "=== 切到测试环境 ==="
  
  # 1. 同步数据库（生产→测试）
  echo "[1/3] 同步数据库..."
  ssh $SERVER "mysqldump -u root -p'Dota2Migrate@2026' dota2 2>/dev/null | mysql -u root -p'Dota2Migrate@2026' dota2_test 2>/dev/null"
  echo "数据库已同步"
  
  # 2. 重启测试服务
  echo "[2/3] 重启测试服务..."
  ssh $SERVER "pm2 restart dota2-api-test 2>&1 | tail -1"
  
  # 3. 前端切到测试环境
  echo "[3/3] 前端切到测试..."
  sed -i 's/const USE_TEST = false/const USE_TEST = true/' miniprogram/utils/env.js
  echo "前端已切到测试环境（env.js: USE_TEST=true）"

elif [ "$MODE" = "prod" ]; then
  echo "=== 切到生产环境 ==="
  
  # 1. 前端切回生产
  echo "[1/2] 前端切到生产..."
  sed -i 's/const USE_TEST = true/const USE_TEST = false/' miniprogram/utils/env.js
  echo "前端已切到生产环境（env.js: USE_TEST=false）"
  
  # 2. 重启生产服务
  echo "[2/2] 重启生产服务..."
  ssh $SERVER "pm2 restart dota2-api 2>&1 | tail -1"

else
  echo "用法: bash switch-env.sh [prod|test]"
fi

echo "=== 当前环境 ==="
grep "USE_TEST" miniprogram/utils/env.js
ssh $SERVER "pm2 list | grep dota2" 2>/dev/null
