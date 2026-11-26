/**
 * Tool `ghn_get_fee`: tính phí vận chuyển GHN dự kiến (VND).
 *
 * Thiết kế: MỘT lời gọi GHN duy nhất tới `POST /v2/shipping-order/fee` với `service_type_id`
 * (mặc định 2). KHÔNG gọi `available-services` (cần ShopId, thêm một vòng mạng, khó đạt
 * ngưỡng phản hồi nhanh).
 *
 * BẢO MẬT: phản hồi chỉ trả các khoản phí; mọi trường GHN khác bị Zod bỏ (allowlist).
 */
import { z } from 'zod';
import { createAppError } from '../../core/errors.js';
import { GHN_WARD_CODE_MAX_LENGTH } from '../../core/ghn-shops.js';
import type { ToolContext, ToolDefinition } from '../../core/types.js';
import {
  districtIdSchema,
  insuranceValueSchema,
  wardCodeSchema,
  weightGramSchema,
} from '../../utils/validator.js';

// Tên trường phản hồi GHN — MỘT chỗ để sửa nhanh. Hiện là GIẢ ĐỊNH theo tài liệu GHN
// "Calculate Fee" (`data.total`, `service_fee`, `insurance_fee`), CHƯA xác minh trên staging.
const GHN_TOTAL_FIELD = 'total' as const;
const GHN_SERVICE_FEE_FIELD = 'service_fee' as const;
const GHN_INSURANCE_FEE_FIELD = 'insurance_fee' as const;

// Giá trị cố định theo mẫu v1.0 — đặt tên để không dùng số trần.
const GHN_FIXED_SERVICE_ID = 0;
const GHN_FIXED_COD_FAILED_TO_RETURN = 0;

/** Đơn vị tiền của kết quả (GHN trả VND). */
const CURRENCY_VND = 'VND' as const;

// Giá trị mặc định theo mẫu v1.0.
const DEFAULT_SERVICE_TYPE_ID = 2;
const DEFAULT_LENGTH_CM = 20;
const DEFAULT_WIDTH_CM = 15;
const DEFAULT_HEIGHT_CM = 10;
const DEFAULT_INSURANCE_VALUE = 0;
/** Trần kích thước mỗi cạnh (GIẢ ĐỊNH, chưa xác minh giới hạn GHN). */
const MAX_DIMENSION_CM = 200;

/** Kết quả tool: chỉ các khoản phí, không trường nào khác của GHN. */
export interface FeeResult {
  total_fee: number;
  service_fee: number | null;
  insurance_fee: number | null;
  currency: 'VND';
  /** Dịch vụ đã dùng (2 hoặc 5), lấy từ đầu vào. */
  service_type_id: number;
}

// Số tiền: số nguyên không âm an toàn, hoặc chuỗi chỉ gồm chữ số chuyển được thành số nguyên
// an toàn. KHÔNG dùng z.coerce (tránh ép ''/false/[] thành 0). Không dùng .transform để
// kiểu vào = kiểu ra, khớp `GhnGateway.request<T>`; đổi chuỗi sang số ở toVnd.
const MONEY_DIGITS_PATTERN = /^\d+$/;
const moneySchema = z.union([
  z
    .number({ invalid_type_error: 'Số tiền phải là số' })
    .int('Số tiền phải là số nguyên')
    .nonnegative('Số tiền không được âm')
    .refine((value) => Number.isSafeInteger(value), 'Số tiền phải là số nguyên an toàn'),
  z
    .string()
    .regex(MONEY_DIGITS_PATTERN, 'Số tiền dạng chuỗi phải gồm các chữ số')
    .refine((value) => Number.isSafeInteger(Number(value)), 'Số tiền phải là số nguyên an toàn'),
]);

// Schema phần `data` của phản hồi (allowlist trường): trường lạ bị Zod bỏ.
// `total` bắt buộc; thiếu/sai kiểu → GHN_UNEXPECTED_RESPONSE. Hai khoản còn lại vắng/null → null;
// có mà sai kiểu vẫn là phản hồi sai dạng (tiền: KHÔNG tự đổi sai thành 0).
const feeResponseSchema = z.object({
  [GHN_TOTAL_FIELD]: moneySchema,
  [GHN_SERVICE_FEE_FIELD]: moneySchema.nullish(),
  [GHN_INSURANCE_FEE_FIELD]: moneySchema.nullish(),
});

// wardCodeSchema dùng chung chưa có trần độ dài; trần đồng bộ với core/ghn-shops.ts.
const toWardCodeSchema = wardCodeSchema.max(
  GHN_WARD_CODE_MAX_LENGTH,
  `Mã phường không được dài quá ${GHN_WARD_CODE_MAX_LENGTH} ký tự`,
);

// Kích thước mỗi cạnh: số nguyên dương (cm), tối đa 200. Max 200 cũng bảo đảm số an toàn.
const dimensionSchema = z
  .number({ invalid_type_error: 'Kích thước phải là số' })
  .int('Kích thước phải là số nguyên (cm)')
  .positive('Kích thước phải lớn hơn 0 (cm)')
  .max(MAX_DIMENSION_CM, `Kích thước không được vượt quá ${MAX_DIMENSION_CM} cm`);

const inputSchema = z
  .object({
    from_district_id: districtIdSchema,
    to_district_id: districtIdSchema,
    to_ward_code: toWardCodeSchema,
    weight: weightGramSchema,
    // Chỉ nhận 2 (Ecom) hoặc 5 (Truyền thống), mặc định 2.
    // Union literal để JSON Schema ở tools/list có enum [2, 5]. Giá trị khác bị từ chối với
    // thông báo tiếng Việt chung của parseInput (không chứa giá trị người dùng nhập).
    service_type_id: z.union([z.literal(2), z.literal(5)]).default(DEFAULT_SERVICE_TYPE_ID),
    length: dimensionSchema.default(DEFAULT_LENGTH_CM),
    width: dimensionSchema.default(DEFAULT_WIDTH_CM),
    height: dimensionSchema.default(DEFAULT_HEIGHT_CM),
    insurance_value: insuranceValueSchema,
  })
  .strict();

// Đổi số tiền đã kiểm sang number; chuỗi đã được refine là số nguyên an toàn.
function toVnd(value: string | number): number {
  return typeof value === 'string' ? Number(value) : value;
}

// Khoản phí tùy chọn: vắng/null → null; có giá trị đã kiểm → number.
function toOptionalVnd(value: string | number | null | undefined): number | null {
  return value === null || value === undefined ? null : toVnd(value);
}

// Kiểu ĐẦU VÀO của schema: các trường có `.default()` là tùy chọn ở kiểu vào (server luôn áp
// default khi parse, nhưng handler tự resolve để an toàn cả khi được gọi trực tiếp).
type FeeToolInput = z.input<typeof inputSchema>;

async function handler(input: FeeToolInput, ctx: ToolContext): Promise<FeeResult> {
  // Thăm dò GHN staging 2026-11-19: gọi fee KHÔNG có header ShopId bị GHN trả
  // 400 SHOP_INFO_ERROR (shop mặc định của tài khoản chưa có địa chỉ). Chặn SỚM để người dùng
  // biết điền GHN_SHOP_ID thay vì gọi GHN vô ích rồi nhận GHN_BAD_REQUEST. Chỉ kiểm có/không;
  // tính hợp lệ của số do client kiểm khi gọi. Khi có cơ chế tự xác định ShopId, bỏ kiểm này.
  if (ctx.credentials.shopId === undefined) {
    throw createAppError('CONFIG_MISSING', {
      'tên biến': 'GHN_SHOP_ID',
      name: 'GHN_SHOP_ID',
    });
  }

  const serviceTypeId = input.service_type_id ?? DEFAULT_SERVICE_TYPE_ID;
  const length = input.length ?? DEFAULT_LENGTH_CM;
  const width = input.width ?? DEFAULT_WIDTH_CM;
  const height = input.height ?? DEFAULT_HEIGHT_CM;
  const insuranceValue = input.insurance_value ?? DEFAULT_INSURANCE_VALUE;

  // Payload theo mẫu v1.0: các trường cố định service_id/cod_failed_to_return/coupon.
  // Không gửi trường thừa.
  const payload = {
    from_district_id: input.from_district_id,
    to_district_id: input.to_district_id,
    to_ward_code: input.to_ward_code,
    weight: input.weight,
    service_type_id: serviceTypeId,
    length,
    width,
    height,
    insurance_value: insuranceValue,
    service_id: GHN_FIXED_SERVICE_ID,
    cod_failed_to_return: GHN_FIXED_COD_FAILED_TO_RETURN,
    coupon: null,
  };

  // Client tự dùng POST cho /v2/shipping-order/fee (theo bảng endpoint của client).
  const data = await ctx.services.ghn.request('/v2/shipping-order/fee', payload, feeResponseSchema);

  return {
    total_fee: toVnd(data[GHN_TOTAL_FIELD]),
    service_fee: toOptionalVnd(data[GHN_SERVICE_FEE_FIELD]),
    insurance_fee: toOptionalVnd(data[GHN_INSURANCE_FEE_FIELD]),
    currency: CURRENCY_VND,
    service_type_id: serviceTypeId,
  };
}

/** Tool tính phí; đăng ký vào registry ở `main.ts`. */
export const getFeeTool: ToolDefinition<FeeToolInput> = {
  name: 'ghn_get_fee',
  description:
    'Tính phí vận chuyển GHN dự kiến (VND). Cần mã quận gửi, mã quận và mã phường nhận, ' +
    'cân nặng (gram). Nếu chỉ biết tên quận/phường thì chưa tra mã được trong phiên bản này, ' +
    'hãy hỏi người dùng mã quận/phường. Kết quả là phí dự kiến, không phải báo giá cuối. ' +
    'Cần cấu hình GHN_SHOP_ID; nếu chưa biết ShopId hãy gọi ghn_get_shops để lấy. ' +
    'service_type_id: 2 = Hàng nhẹ (mặc định), 5 = Hàng nặng (cần cân nặng lớn; GHN từ chối hàng nhẹ).',
  inputSchema,
  tier: 'free',
  handler,
};
