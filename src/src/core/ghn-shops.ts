/**
 * Lõi dùng chung cho tool `ghn_get_shops` và các nơi khác cần đọc danh sách shop GHN.
 *
 * Lớp `core/` chỉ phụ thuộc `zod`, KHÔNG I/O. Mọi giới hạn dữ liệu GHN (chỉ id shop, tên và mã
 * hành chính; KHÔNG trả SĐT/địa chỉ shop) nằm ở MỘT chỗ để dùng lại.
 *
 * Tên trường GHN dưới đây là GIẢ ĐỊNH theo tài liệu GHN "Get Shop" (id shop là `_id`),
 * CHƯA xác minh trên staging — sửa một chỗ ở đây nếu cần. Riêng giá trị của shop mới
 * đăng ký (`district_id: 0`, `ward_code: ""`) đã quan sát THẬT trên staging.
 */
import { z } from 'zod';

const GHN_SHOPS_FIELD = 'shops' as const;
const GHN_SHOP_ID_FIELD = '_id' as const;
const GHN_SHOP_NAME_FIELD = 'name' as const;
const GHN_DISTRICT_ID_FIELD = 'district_id' as const;
const GHN_WARD_CODE_FIELD = 'ward_code' as const;
const GHN_STATUS_FIELD = 'status' as const;

/**
 * Độ dài tối đa của `ward_code` GHN: GIẢ ĐỊNH, dùng chung cho tool đọc shop và tool
 * tính phí. Phải đồng bộ khi xác minh lại định dạng trên staging.
 */
export const GHN_WARD_CODE_MAX_LENGTH = 20;

/** `ward_code` GHN: chuỗi chữ/số 1-20 ký tự; "" được coi là null khi ánh xạ. */
const WARD_CODE_PATTERN = new RegExp(`^[A-Za-z0-9]{1,${GHN_WARD_CODE_MAX_LENGTH}}$`);

/** Nhãn thay thế khi tên shop sai kiểu hoặc rỗng sau khi làm sạch. */
const DEFAULT_SHOP_NAME = '(không tên)';

// Ký tự điều khiển (Cc: xuống dòng, tab…) và định dạng (Cf: U+202E, U+200B, U+FEFF…) bị thay
// bằng khoảng trắng để tên từ GHN không chèn điều khiển/bidi về phía AI.
const CONTROL_OR_FORMAT_PATTERN = /[\p{Cc}\p{Cf}]/gu;

/** Tên shop tối đa đưa cho AI, tính theo CODE POINT; dài hơn bị cắt để tránh chuỗi quá dài. */
const MAX_SHOP_NAME_LENGTH = 100;

/** Một shop GHN sau khi lọc allowlist. */
export interface ShopSummary {
  shop_id: number;
  name: string;
  district_id: number | null;
  ward_code: string | null;
  status: number | null;
}

// Một phần tử shop GHN. KHÔNG dùng z.record/z.any/.passthrough(): trường lạ như `phone`,
// `address`, `client_id`… bị Zod bỏ — đây chính là cơ chế allowlist.
// `_id` là trường DUY NHẤT kiểm nghiêm (và bắt buộc): phần tử không có ShopId hợp lệ là vô nghĩa
// nên cả phản hồi bị từ chối (GHN_UNEXPECTED_RESPONSE). Bốn trường còn lại nhận mọi giá trị và
// được làm sạch phòng thủ ở toShopSummary, để MỘT shop sai dạng không làm hỏng cả danh sách.
// KHÔNG dùng z.coerce: kiểu phải đúng, không ép ngầm ''/false/[] thành số.
const shopItemSchema = z.object({
  [GHN_SHOP_ID_FIELD]: z
    .number({ invalid_type_error: 'Mã shop phải là số' })
    .int('Mã shop phải là số nguyên')
    .positive('Mã shop phải lớn hơn 0')
    .refine((value) => Number.isSafeInteger(value), 'Mã shop phải là số nguyên an toàn'),
  // z.unknown() (không phải z.any) để kiểu vào = kiểu ra, khớp `GhnGateway.request<T>`.
  [GHN_SHOP_NAME_FIELD]: z.unknown(),
  [GHN_DISTRICT_ID_FIELD]: z.unknown(),
  [GHN_WARD_CODE_FIELD]: z.unknown(),
  [GHN_STATUS_FIELD]: z.unknown(),
});

/** Một phần tử shop GHN đã qua schema (chỉ còn trường allowlist). */
export type ShopListItem = z.infer<typeof shopItemSchema>;

/**
 * Phần `data` của `/v2/shop/all`. Chỉ khai báo trường đã biết (allowlist); `last_offset` (phân
 * trang) hiện chưa dùng nên không khai báo — bổ sung khi cần phân trang.
 * `data` null hoặc vắng (tài khoản mới chưa có shop) là HỢP LỆ; `shops` null/vắng cũng vậy.
 * Kiểu vào = kiểu ra để khớp `GhnGateway.request<T>`.
 */
export const shopListResponseSchema = z
  .object({
    [GHN_SHOPS_FIELD]: z.array(shopItemSchema).nullish(),
  })
  .nullish();

/** Kiểu phần `data` của `/v2/shop/all` sau khi kiểm. */
export type ShopListResponse = z.infer<typeof shopListResponseSchema>;

// Làm sạch tên TRƯỚC khi cắt: thay ký tự điều khiển/định dạng bằng khoảng trắng, gộp khoảng
// trắng liên tiếp thành một và trim. KHÔNG chuẩn hoá Unicode để giữ nguyên NFC lẫn NFD.
function sanitizeShopName(name: string): string {
  return name.replace(CONTROL_OR_FORMAT_PATTERN, ' ').replace(/\s+/gu, ' ').trim();
}

// Cắt tên theo CODE POINT (không theo đơn vị UTF-16) để không cắt đôi cặp surrogate (emoji).
function clipShopName(name: string): string {
  const codePoints = Array.from(name);
  return codePoints.length <= MAX_SHOP_NAME_LENGTH
    ? name
    : codePoints.slice(0, MAX_SHOP_NAME_LENGTH).join('');
}

// Tên shop là dữ liệu từ GHN: sai kiểu hoặc rỗng sau làm sạch → nhãn dự phòng.
function toShopName(value: unknown): string {
  if (typeof value !== 'string') {
    return DEFAULT_SHOP_NAME;
  }
  const cleaned = sanitizeShopName(value);
  return cleaned === '' ? DEFAULT_SHOP_NAME : clipShopName(cleaned);
}

// district_id: chỉ nhận số nguyên không âm an toàn; 0 (shop mới) hoặc sai → null.
function toDistrictId(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return null;
  }
  return value === 0 ? null : value;
}

// ward_code: chỉ nhận chuỗi đúng mẫu; "" (shop mới) hoặc sai kiểu → null.
function toWardCode(value: unknown): string | null {
  return typeof value === 'string' && WARD_CODE_PATTERN.test(value) ? value : null;
}

// status: chỉ nhận số nguyên an toàn (cùng mức kiểm với _id); sai kiểu/định dạng → null.
function toStatus(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

/** Ánh xạ một phần tử GHN đã kiểm sang allowlist 5 trường. Hàm thuần, không I/O. */
export function toShopSummary(raw: ShopListItem): ShopSummary {
  return {
    shop_id: raw[GHN_SHOP_ID_FIELD],
    name: toShopName(raw[GHN_SHOP_NAME_FIELD]),
    district_id: toDistrictId(raw[GHN_DISTRICT_ID_FIELD]),
    ward_code: toWardCode(raw[GHN_WARD_CODE_FIELD]),
    status: toStatus(raw[GHN_STATUS_FIELD]),
  };
}

/** Ánh xạ `data` của `/v2/shop/all`; `data`/`shops` null hoặc vắng → danh sách rỗng. */
export function toShopSummaries(data: ShopListResponse): ShopSummary[] {
  if (data === null || data === undefined) {
    return [];
  }
  return (data[GHN_SHOPS_FIELD] ?? []).map(toShopSummary);
}
