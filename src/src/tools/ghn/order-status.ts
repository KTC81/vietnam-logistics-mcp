/**
 * Bảng mã trạng thái GHN → tiếng Việt cho tool đọc.
 *
 * Bảng hiện là GIẢ ĐỊNH, chưa xác minh đầy đủ trên staging — CẦN XÁC NHẬN.
 * Mã lạ KHÔNG làm hỏng tool: trả nhãn "Trạng thái khác" (chỉ nhúng mã nếu an toàn).
 */
const STATUS_VI: Readonly<Record<string, string>> = {
  ready_to_pick: 'Chờ lấy hàng',
  picking: 'Đang lấy hàng',
  money_collect_picking: 'Đang thu tiền người gửi',
  picked: 'Đã lấy hàng',
  storing: 'Đang lưu kho',
  transporting: 'Đang luân chuyển',
  sorting: 'Đang phân loại',
  delivering: 'Đang giao hàng',
  money_collect_delivering: 'Đang thu tiền người nhận',
  delivered: 'Đã giao hàng',
  delivery_fail: 'Giao không thành công',
  waiting_to_return: 'Chờ xác nhận hoàn',
  return: 'Đang hoàn hàng',
  return_transporting: 'Đang luân chuyển hoàn',
  return_sorting: 'Đang phân loại hoàn',
  returning: 'Đang hoàn về shop',
  return_fail: 'Hoàn không thành công',
  returned: 'Đã hoàn hàng',
  cancel: 'Đã hủy',
  exception: 'Đơn có vấn đề',
  damage: 'Hàng bị hư hỏng',
  lost: 'Hàng thất lạc',
};

// Mã trạng thái lạ chỉ được nhúng vào thông báo khi khớp mẫu an toàn này.
const SAFE_STATUS_CODE_PATTERN = /^[a-z_]{1,40}$/;
// Khóa đặc biệt của object: không bao giờ nhúng vào thông báo dù khớp mẫu chữ.
const RESERVED_STATUS_CODES = new Set(['__proto__', 'constructor', 'prototype']);

/** Chuyển mã trạng thái GHN sang tiếng Việt; mã lạ không ném lỗi. */
export function statusToVietnamese(code: string): string {
  // Object.hasOwn để không lấy nhầm thuộc tính kế thừa từ prototype. Sau khi đã xác nhận
  // có khóa riêng, giá trị luôn là chuỗi trong bảng nên không cần nhánh dự phòng.
  if (Object.hasOwn(STATUS_VI, code)) {
    return STATUS_VI[code];
  }
  if (RESERVED_STATUS_CODES.has(code) || !SAFE_STATUS_CODE_PATTERN.test(code)) {
    return 'Trạng thái khác';
  }
  return `Trạng thái khác (mã GHN: ${code})`;
}
