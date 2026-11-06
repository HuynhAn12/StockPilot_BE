#!/bin/bash
# ==============================================================================
# StockPilot Production Deployment Script (VPS Vietnix)
# Domain: https://stockpilot.name.vn
# ==============================================================================

set -e

echo "=================================================================="
echo "🚀 [$(date '+%Y-%m-%d %H:%M:%S')] BẮT ĐẦU TRIỂN KHAI STOCKPILOT"
echo "🌐 Domain mục tiêu: https://stockpilot.name.vn"
echo "=================================================================="

# 1. Thư mục dự án
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Nếu script nằm trong backend/, lên thư mục cha nếu có docker-compose.yml ở cha, hoặc chạy tại chỗ
if [ -f "$PROJECT_DIR/../docker-compose.yml" ]; then
    cd "$PROJECT_DIR/.."
    PROJECT_DIR="$(pwd)"
else
    cd "$PROJECT_DIR"
fi

echo "📂 Thư mục làm việc: $PROJECT_DIR"

# 2. Kéo mã nguồn mới nhất từ nhánh main
echo "📥 [1/5] Đang cập nhật mã nguồn từ GitHub (git pull origin main)..."
if [ -d ".git" ]; then
    git fetch origin main
    git reset --hard origin/main
    echo "✅ Đã đồng bộ mã nguồn Backend mới nhất."
fi

# Nếu frontend là submodule hoặc thư mục git riêng
if [ -d "frontend/.git" ]; then
    echo "📥 Đang cập nhật mã nguồn Frontend..."
    cd frontend
    git fetch origin main
    git reset --hard origin/main
    cd "$PROJECT_DIR"
    echo "✅ Đã đồng bộ mã nguồn Frontend mới nhất."
fi

# 3. Kiểm tra biến môi trường
if [ ! -f "backend/.env" ] && [ -f "backend/.env.example" ]; then
    echo "⚠️ Chưa tìm thấy backend/.env, tự động tạo từ .env.example..."
    cp backend/.env.example backend/.env
fi

# 4. Build và khởi chạy Docker Containers
echo "🐳 [2/5] Đang build và khởi động Docker Containers..."
if command -v docker &> /dev/null; then
    docker compose up -d --build --remove-orphans
    echo "✅ Các container đã khởi chạy thành công."
else
    echo "❌ Lỗi: Docker chưa được cài đặt trên máy chủ!"
    exit 1
fi

# 5. Chờ Database sẵn sàng & chạy Prisma Migration
echo "🗄️ [3/5] Đang kiểm tra và cập nhật Schema Database (Prisma Migrate)..."
sleep 5
docker compose exec -T backend npx prisma migrate deploy || {
    echo "⚠️ Chạy migration qua Docker container thất bại, thử lại sau 5s..."
    sleep 5
    docker compose exec -T backend npx prisma migrate deploy
}
echo "✅ Database schema đã sẵn sàng và cập nhật mới nhất."

# 6. Dọn dẹp Docker Images cũ để tiết kiệm dung lượng ổ cứng VPS (32GB)
echo "🧹 [4/5] Dọn dẹp cache và Docker images rác..."
docker image prune -f
echo "✅ Đã giải phóng dung lượng đĩa."

# 7. Kiểm tra sức khỏe hệ thống (Health Check)
echo "🩺 [5/5] Kiểm tra phản hồi của hệ thống..."
sleep 3
HEALTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5000/api/v1/health/live || true)

if [ "$HEALTH_STATUS" = "200" ]; then
    echo "=================================================================="
    echo "🎉 TRIỂN KHAI THÀNH CÔNG RỰC RỠ!"
    echo "🌐 Trang web: https://stockpilot.name.vn"
    echo "🔌 API:       https://stockpilot.name.vn/api/v1"
    echo "⏱️ Thời gian: $(date '+%Y-%m-%d %H:%M:%S')"
    echo "=================================================================="
else
    echo "⚠️ Cảnh báo: API trả về mã HTTP $HEALTH_STATUS. Đang kiểm tra log container:"
    docker compose logs --tail=30 backend
fi

