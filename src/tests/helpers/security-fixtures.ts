/**
 * Dữ liệu giả dùng chung cho bộ test bảo mật.
 *
 * MỌI giá trị ở đây đều là GIẢ, dễ tìm bằng grep, không phải dữ liệu thật:
 * token `TOKEN-GIA-SECRET-123456`, tên `Nguyen Van Gia`, SĐT `0900000000`,
 * địa chỉ `99 Duong Gia, Quan Gia`, mã đơn `G8AGIA123`, shop id `999999`.
 */

export const TOKEN_GIA_SECRET = 'TOKEN-GIA-SECRET-123456';
export const SHOP_ID_GIA = 999999;
export const ORDER_CODE_GIA = 'G8AGIA123';
export const TEN_GIA = 'Nguyen Van Gia';
export const SDT_GIA = '0900000000';
export const DIA_CHI_GIA = '99 Duong Gia, Quan Gia';

/** Giá trị PII giả: không được xuất hiện trong kết quả tool hay log. */
export const PII_GIA = [TEN_GIA, SDT_GIA, DIA_CHI_GIA] as const;

/**
 * Tên khóa PII KHÔNG được xuất hiện trong kết quả tool.
 * Không gồm `name` vì tên shop là trường hợp lệ của ghn_get_shops.
 */
export const KHOA_PII = [
  'to_name',
  'to_phone',
  'to_address',
  'from_name',
  'from_phone',
  'from_address',
  'return_name',
  'return_phone',
  'return_address',
  'phone',
  'address',
  'client_phone',
  'email',
  'note',
  'items',
] as const;

// Gắn khóa own "__proto__" (object literal thường sẽ đổi prototype thay vì tạo khóa).
function themProto<T extends Record<string, unknown>>(obj: T): T {
  Object.defineProperty(obj, '__proto__', {
    value: { polluted: TEN_GIA },
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return obj;
}

/** Dữ liệu PII giả nhét thừa vào mọi phản hồi GHN để kiểm allowlist. */
function piiThua(): Record<string, unknown> {
  return {
    token: TOKEN_GIA_SECRET,
    to_name: TEN_GIA,
    to_phone: SDT_GIA,
    to_address: DIA_CHI_GIA,
    from_name: TEN_GIA,
    from_phone: SDT_GIA,
    from_address: DIA_CHI_GIA,
    return_name: TEN_GIA,
    return_phone: SDT_GIA,
    return_address: DIA_CHI_GIA,
    phone: SDT_GIA,
    address: DIA_CHI_GIA,
    client_phone: SDT_GIA,
    note: 'GIA-NOTE',
    email: 'gia@example.test',
    items: [{ name: TEN_GIA }],
    shop: { phone: SDT_GIA, address: DIA_CHI_GIA, name: 'Shop Gia A' },
    truong_la: { sau: { sau_nua: TEN_GIA } },
  };
}

/** Một tool cần dữ liệu mẫu để bộ test bảo mật duyệt tự động. */
export interface ToolFixture {
  /** Phương thức HTTP của endpoint tool gọi (để mock-fetch khớp). */
  method: 'GET' | 'POST';
  /** Đầu vào hợp lệ tối thiểu để tool chạy tới cổng GHN. */
  validArguments: Record<string, unknown>;
  /** Thân phản hồi GHN thành công, chứa đầy PII giả để kiểm allowlist. */
  successBody: Record<string, unknown>;
  /** Thân 200 nhưng thiếu trường bắt buộc của tool (để kiểm GHN_UNEXPECTED_RESPONSE). */
  missingFieldBody: Record<string, unknown>;
}

/**
 * Bảng fixture theo TÊN tool. Test coverage sẽ đỏ nếu registry có tool chưa có mục ở đây,
 * nhờ vậy tool thêm vào sau này sẽ buộc phải khai báo dữ liệu kiểm bảo mật.
 */
export const TOOL_FIXTURES: Readonly<Record<string, ToolFixture>> = {
  ghn_get_order_detail: {
    method: 'GET',
    validArguments: { order_code: ORDER_CODE_GIA },
    successBody: {
      code: 200,
      data: themProto({
        order_code: ORDER_CODE_GIA,
        status: 'delivering',
        cod_amount: 350000,
        leadtime: '2026-11-20T17:00:00+07:00',
        updated_date: '2026-11-20T08:00:00+07:00',
        ...piiThua(),
      }),
    },
    missingFieldBody: { code: 200, data: { status: 'delivering' } },
  },
  ghn_get_shops: {
    method: 'GET',
    validArguments: {},
    successBody: {
      code: 200,
      data: themProto({
        shops: [
          themProto({
            _id: SHOP_ID_GIA,
            name: 'Shop Gia A',
            district_id: 1442,
            ward_code: '20308',
            status: 1,
            ...piiThua(),
          }),
        ],
      }),
    },
    missingFieldBody: { code: 200, data: { shops: 'sai' } },
  },
  ghn_get_fee: {
    method: 'POST',
    validArguments: {
      from_district_id: 1442,
      to_district_id: 1444,
      to_ward_code: '20308',
      weight: 1000,
    },
    successBody: {
      code: 200,
      data: themProto({
        total: 32000,
        service_fee: 32000,
        insurance_fee: 0,
        ...piiThua(),
      }),
    },
    missingFieldBody: { code: 200, data: { service_fee: 1 } },
  },
};

/** Các giá trị nguyên thủy của đầu vào mẫu (dùng để kiểm log không chứa đầu vào). */
export function giaTriDauVao(fixture: ToolFixture): Array<string | number> {
  const values: Array<string | number> = [];
  for (const value of Object.values(fixture.validArguments)) {
    if (typeof value === 'string' || typeof value === 'number') {
      values.push(value);
    }
  }
  return values;
}

/** Tên các trường đầu vào theo kiểu (dùng để bơm đầu vào độc hại). */
export function tenTruongTheoKieu(fixture: ToolFixture, kieu: 'string' | 'number'): string[] {
  return Object.entries(fixture.validArguments)
    .filter(([, value]) => typeof value === kieu)
    .map(([key]) => key);
}
