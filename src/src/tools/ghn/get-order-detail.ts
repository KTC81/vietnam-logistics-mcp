/**
 * Tool `ghn_get_order_detail`: tra chi tiết một đơn GHN.
 *
 * BẢO MẬT: GHN trả hàng trăm trường kèm tên/SĐT/địa chỉ người nhận, người gửi, shop.
 * Tool CHỈ trả allowlist bên dưới; `responseSchema` là `z.object` với
 * trường đã biết (Zod mặc định bỏ trường lạ) — đây chính là cơ chế allowlist.
 */
import { z } from 'zod';
import type { ToolContext, ToolDefinition } from '../../core/types.js';
import { orderCodeSchema } from '../../utils/validator.js';
import { statusToVietnamese } from './order-status.js';

// Tên trường phản hồi GHN — MỘT chỗ để sửa nhanh. Hiện là GIẢ ĐỊNH theo tài liệu GHN
// "Order Info"; CHƯA xác minh trên staging.
// `as const` khóa literal type để không gõ sai tên trường ở nơi khác.
const GHN_ORDER_CODE_FIELD = 'order_code' as const;
const GHN_STATUS_FIELD = 'status' as const;
const GHN_COD_AMOUNT_FIELD = 'cod_amount' as const;
const GHN_LEADTIME_FIELD = 'leadtime' as const;
const GHN_UPDATED_DATE_FIELD = 'updated_date' as const;

/** Kết quả allowlist trả cho AI. */
export interface OrderDetailResult {
  order_code: string;
  /** Mã trạng thái GHN, ví dụ 'delivering'. */
  status: string;
  /** Trạng thái tiếng Việt theo bảng order-status.ts. */
  status_vi: string;
  /** Tiền thu hộ (VND); 0 nếu GHN không có. */
  cod_amount: number;
  expected_delivery_time: string | null;
  shipper: { name: string; phone: string } | null;
  updated_at: string | null;
}

// Giới hạn chuỗi GHN thô: phản hồi rỗng, quá dài, có ký tự lạ/khoảng trắng/xuống dòng
// bị coi là sai định dạng — client đổi thành GHN_UNEXPECTED_RESPONSE; thông báo lỗi chỉ nêu TÊN
// trường, không nêu giá trị GHN.
const GHN_ORDER_CODE_RESPONSE_PATTERN = /^[A-Za-z0-9]{1,50}$/;
const GHN_STATUS_RESPONSE_PATTERN = /^[a-z_]{1,64}$/;

// Số tiền COD (VND) trong phản hồi: CHỈ nhận số nguyên không âm, hoặc chuỗi chỉ gồm chữ số
// chuyển được thành số nguyên an toàn. KHÔNG dùng z.coerce.number(): nó ép '', false, [], true,
// [5] thành 0/1/5 nên có thể hiển thị COD 0 đồng sai. Vắng hoặc null → 0 (xem toCodAmount).
// Không dùng .transform ở đây để kiểu vào = kiểu ra, khớp `GhnGateway.request<T>` (ZodType<T>).
const COD_AMOUNT_DIGITS_PATTERN = /^\d+$/;
const codAmountSchema = z
  .union([
    z.number().int().nonnegative(),
    z
      .string()
      .regex(COD_AMOUNT_DIGITS_PATTERN)
      .refine((value) => Number.isSafeInteger(Number(value))),
  ])
  .nullish();

// Đổi giá trị COD đã kiểm sang số; vắng/null → 0 (giữ hành vi cũ).
function toCodAmount(value: string | number | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  return typeof value === 'string' ? Number(value) : value;
}

// Schema phần `data` của phản hồi (allowlist trường): trường lạ bị Zod bỏ.
// Ngày chỉ cần chuỗi (chưa xác minh định dạng — CẦN XÁC NHẬN).
const detailResponseSchema = z.object({
  [GHN_ORDER_CODE_FIELD]: z.string().regex(GHN_ORDER_CODE_RESPONSE_PATTERN),
  [GHN_STATUS_FIELD]: z.string().regex(GHN_STATUS_RESPONSE_PATTERN),
  [GHN_COD_AMOUNT_FIELD]: codAmountSchema,
  [GHN_LEADTIME_FIELD]: z.string().min(1).nullish(),
  [GHN_UPDATED_DATE_FIELD]: z.string().min(1).nullish(),
});

const inputSchema = z.object({ order_code: orderCodeSchema }).strict();

async function handler(
  input: z.infer<typeof inputSchema>,
  ctx: ToolContext,
): Promise<OrderDetailResult> {
  const data = await ctx.services.ghn.request(
    '/v2/shipping-order/detail',
    { order_code: input.order_code },
    detailResponseSchema,
  );

  // Không có trường shipper nào được xác nhận là nhân viên GHN; tuyệt đối không lấy từ
  // to_*/from_*/return_* vì đó là dữ liệu cá nhân của khách/shop.
  return {
    order_code: data[GHN_ORDER_CODE_FIELD],
    status: data[GHN_STATUS_FIELD],
    status_vi: statusToVietnamese(data[GHN_STATUS_FIELD]),
    cod_amount: toCodAmount(data[GHN_COD_AMOUNT_FIELD]),
    expected_delivery_time: data[GHN_LEADTIME_FIELD] ?? null,
    shipper: null,
    updated_at: data[GHN_UPDATED_DATE_FIELD] ?? null,
  };
}

/** Tool tra chi tiết đơn; đăng ký vào registry ở `main.ts` (điểm vào). */
export const getOrderDetailTool: ToolDefinition<{ order_code: string }> = {
  name: 'ghn_get_order_detail',
  description:
    'Lấy chi tiết một đơn GHN theo mã vận đơn: trạng thái, tiền thu hộ (COD), dự kiến giao. ' +
    "Dùng để trả lời khách 'đơn đang ở đâu'. Không trả thông tin cá nhân của người nhận.",
  inputSchema,
  tier: 'free',
  handler,
};
