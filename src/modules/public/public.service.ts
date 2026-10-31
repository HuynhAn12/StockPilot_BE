import { prisma } from '../../config/db';
import { CreateLeadInput } from './public.schema';
import { LeadService } from '../leads/lead.service';

export class PublicService {
  private readonly leadService = new LeadService();

  async createLead(input: CreateLeadInput) {
    return this.leadService.submit(input);
  }

  async getPlatformStats() {
    const [realStoresCount, realProductsCount, realOrdersCount] = await Promise.all([
      prisma.store.count({ where: { isActive: true } }),
      prisma.stockItem.count({ where: { isActive: true } }),
      prisma.order.count(),
    ]);

    return {
      activeBusinessesDisplay: Math.max(realStoresCount, 1500) + '+',
      totalProductsManaged: Math.max(realProductsCount, 250000) + '+',
      ordersProcessedMonthly: Math.max(realOrdersCount, 120000) + '+',
      uptime: '99.98%',
      supportResponseTime: '< 15 phút',
      metrics: {
        stores: realStoresCount,
        products: realProductsCount,
        orders: realOrdersCount,
      },
    };
  }

  async getPricingPlans() {
    return [
      {
        id: 'starter',
        name: 'Gói Khởi Nghiệp',
        tagline: 'Dành cho tiệm tạp hóa, shop nhỏ & cá nhân mới kinh doanh',
        monthlyPrice: 190000,
        billingCycle: 'tháng',
        popular: false,
        features: [
          'Quản lý 1 cửa hàng / chi nhánh',
          'Không giới hạn đơn hàng & sản phẩm',
          'POS bán hàng đa thiết bị (máy tính, tablet, điện thoại)',
          'Quản lý kho hàng & cảnh báo tồn kho',
          'Báo cáo doanh thu & lợi nhuận cơ bản',
          'Hỗ trợ kỹ thuật giờ hành chính',
        ],
        ctaText: 'Dùng thử ngay',
      },
      {
        id: 'professional',
        name: 'Gói Chuyên Nghiệp',
        tagline: 'Tối ưu nhất cho các cửa hàng bán lẻ, thời trang, F&B tăng trưởng',
        monthlyPrice: 320000,
        billingCycle: 'tháng',
        popular: true,
        features: [
          'Tất cả tính năng của gói Khởi Nghiệp',
          'Tích hợp AI Pilot gợi ý nhập hàng thông minh',
          'Dynamic Pricing - Đề xuất giá bán tối ưu theo nhu cầu thị trường',
          'Hỗ trợ 3 tài khoản nhân viên phân quyền chi tiết',
          'Quét mã vạch camera điện thoại siêu tốc',
          'Quản lý công nợ khách hàng & nhà cung cấp',
          'Hỗ trợ kỹ thuật ưu tiên 24/7',
        ],
        ctaText: 'Bắt đầu dùng thử ngay',
      },
      {
        id: 'enterprise',
        name: 'Gói Chuỗi Doanh Nghiệp',
        tagline: 'Giải pháp toàn diện cho chuỗi nhiều chi nhánh & tổng kho phân phối',
        monthlyPrice: 650000,
        billingCycle: 'tháng',
        popular: false,
        features: [
          'Tất cả tính năng của gói Chuyên Nghiệp',
          'Quản lý không giới hạn chi nhánh & kho hàng',
          'Điều chuyển kho nội bộ tự động hóa',
          'Phân tích dự báo chuỗi cung ứng AI cao cấp',
          'Tên miền con riêng biệt (yourshop.stockpilot.pro.vn)',
          'API mở tích hợp sàn TMĐT (Shopee, Lazada, TikTok Shop)',
          'Chuyên viên hỗ trợ triển khai riêng 1-on-1',
        ],
        ctaText: 'Liên hệ tư vấn VIP',
      },
    ];
  }
}
