#!/bin/bash
# ==============================================================================
# StockPilot Production Deployment Script (VPS Vietnix)
# Domain: https://stockpilot.name.vn
#
# Cấu trúc thư mục trên VPS:
#   /var/www/stockpilot/
#   ├── backend/            git clone StockPilot_BE  (có backend/.env, xem production.env.example)
#   ├── frontend/           git clone StockPilot_FE
#   └── docker-compose.yml  tự chép từ backend/docker-compose.yml mỗi lần deploy
# Chạy: bash /var/www/stockpilot/backend/deploy.sh
# ==============================================================================

set -euo pipefail

# Bọc toàn bộ trong { ... }: bash đọc hết khối trước khi chạy, nên việc git reset cập nhật
# chính file này giữa chừng không làm script chạy lệch.
{

BRANCH="${DEPLOY_BRANCH:-main}"
BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$BACKEND_DIR/.." && pwd)"
FRONTEND_DIR="$ROOT_DIR/frontend"
ENV_FILE="$BACKEND_DIR/.env"

echo "=================================================================="
echo "🚀 [$(date '+%Y-%m-%d %H:%M:%S')] BẮT ĐẦU TRIỂN KHAI STOCKPILOT (nhánh $BRANCH)"
echo "📂 Thư mục gốc: $ROOT_DIR"
echo "=================================================================="

# 1. Kiểm tra điều kiện trước khi đụng vào hệ thống đang chạy
command -v docker >/dev/null 2>&1 || { echo "❌ Docker chưa được cài đặt trên máy chủ."; exit 1; }
[ -d "$FRONTEND_DIR" ] || { echo "❌ Không thấy $FRONTEND_DIR. Hãy git clone StockPilot_FE vào đó."; exit 1; }
if [ ! -f "$ENV_FILE" ]; then
    echo "❌ Chưa có $ENV_FILE."
    echo "   Tạo từ mẫu rồi điền khóa bí mật thật: cp $BACKEND_DIR/production.env.example $ENV_FILE"
    exit 1
fi
for key in MYSQL_ROOT_PASSWORD MYSQL_PASSWORD JWT_SECRET JWT_REFRESH_SECRET PAYMENT_CONFIG_ENCRYPTION_KEY; do
    if ! grep -Eq "^${key}=.+" "$ENV_FILE"; then
        echo "❌ $ENV_FILE thiếu giá trị cho $key."
        exit 1
    fi
done

# 2. Cập nhật mã nguồn backend và frontend (mỗi thư mục là một repo git riêng)
update_repo() {
    local dir="$1" name="$2"
    if [ -d "$dir/.git" ]; then
        echo "📥 Cập nhật $name từ origin/$BRANCH..."
        git -C "$dir" fetch origin "$BRANCH"
        git -C "$dir" reset --hard "origin/$BRANCH"
        echo "✅ $name: $(git -C "$dir" log --oneline -1)"
    else
        echo "⚠️ $dir không phải repo git, bỏ qua cập nhật $name."
    fi
}
update_repo "$BACKEND_DIR" "Backend"
update_repo "$FRONTEND_DIR" "Frontend"

# 3. Dùng docker-compose.yml mới nhất từ repo backend
cp "$BACKEND_DIR/docker-compose.yml" "$ROOT_DIR/docker-compose.yml"
cd "$ROOT_DIR"
COMPOSE=(docker compose --env-file "$ENV_FILE")

# 4. Build và khởi chạy các container
echo "🐳 [1/4] Build và khởi động container..."
"${COMPOSE[@]}" up -d --build --remove-orphans

# 5. Cập nhật schema cơ sở dữ liệu
echo "🗄️ [2/4] Chạy Prisma migrate deploy..."
for attempt in 1 2 3; do
    if "${COMPOSE[@]}" exec -T backend npx prisma migrate deploy; then
        break
    fi
    if [ "$attempt" -eq 3 ]; then
        echo "❌ Migration thất bại sau 3 lần thử."
        "${COMPOSE[@]}" logs --tail=50 backend
        exit 1
    fi
    echo "⚠️ Migration chưa chạy được (lần $attempt), thử lại sau 5 giây..."
    sleep 5
done

# 6. Dọn image cũ cho đỡ tốn dung lượng
echo "🧹 [3/4] Dọn Docker image không dùng..."
docker image prune -f >/dev/null

# 7. Kiểm tra sức khỏe: API trực tiếp và qua container frontend (đường đi thật của người dùng)
echo "🩺 [4/4] Kiểm tra hệ thống..."
check() {
    local url="$1" code
    for _ in $(seq 1 10); do
        code=$(curl -s -o /dev/null -w "%{http_code}" "$url" || true)
        [ "$code" = "200" ] && { echo "   ✅ $url → 200"; return 0; }
        sleep 3
    done
    echo "   ❌ $url → ${code:-không phản hồi}"
    return 1
}
if check "http://127.0.0.1:5000/api/v1/health/live" && check "http://127.0.0.1:3000/api/v1/health/live"; then
    echo "=================================================================="
    echo "🎉 TRIỂN KHAI THÀNH CÔNG"
    echo "🌐 https://stockpilot.name.vn   (API: /api/v1)"
    echo "=================================================================="
else
    echo "❌ Hệ thống chưa phản hồi đúng. Log backend:"
    "${COMPOSE[@]}" logs --tail=50 backend
    exit 1
fi

exit 0
}
