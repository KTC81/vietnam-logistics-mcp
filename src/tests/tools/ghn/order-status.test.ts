import { describe, expect, it } from 'vitest';
import { statusToVietnamese } from '../../../src/tools/ghn/order-status.js';

// Bảng chép độc lập (giả định GHN, chưa xác minh staging).
const BANG_TRANG_THAI: Array<[string, string]> = [
  ['ready_to_pick', 'Chờ lấy hàng'],
  ['picking', 'Đang lấy hàng'],
  ['money_collect_picking', 'Đang thu tiền người gửi'],
  ['picked', 'Đã lấy hàng'],
  ['storing', 'Đang lưu kho'],
  ['transporting', 'Đang luân chuyển'],
  ['sorting', 'Đang phân loại'],
  ['delivering', 'Đang giao hàng'],
  ['money_collect_delivering', 'Đang thu tiền người nhận'],
  ['delivered', 'Đã giao hàng'],
  ['delivery_fail', 'Giao không thành công'],
  ['waiting_to_return', 'Chờ xác nhận hoàn'],
  ['return', 'Đang hoàn hàng'],
  ['return_transporting', 'Đang luân chuyển hoàn'],
  ['return_sorting', 'Đang phân loại hoàn'],
  ['returning', 'Đang hoàn về shop'],
  ['return_fail', 'Hoàn không thành công'],
  ['returned', 'Đã hoàn hàng'],
  ['cancel', 'Đã hủy'],
  ['exception', 'Đơn có vấn đề'],
  ['damage', 'Hàng bị hư hỏng'],
  ['lost', 'Hàng thất lạc'],
];

describe('statusToVietnamese', () => {
  it.each(BANG_TRANG_THAI)('mã %s → %s', (code, expected) => {
    expect(statusToVietnamese(code)).toBe(expected);
  });

  it.each(['abc_status', 'status_moi', 'a'])('mã lạ an toàn %j → nhúng mã', (code) => {
    expect(statusToVietnamese(code)).toBe(`Trạng thái khác (mã GHN: ${code})`);
  });

  it('biên 40 ký tự: mã vẫn được nhúng vào nhãn', () => {
    const code = 'a'.repeat(40);

    expect(statusToVietnamese(code)).toBe(`Trạng thái khác (mã GHN: ${code})`);
  });

  it('biên 41 ký tự: mã không được nhúng vào nhãn', () => {
    expect(statusToVietnamese('a'.repeat(41))).toBe('Trạng thái khác');
  });

  it.each([
    '',
    'ABC',
    'has space',
    'a-b',
    'Mã',
    'x'.repeat(41),
    '__proto__',
    'constructor',
    'prototype',
  ])('mã lạ không an toàn %j → Trạng thái khác, không nhúng gì', (code) => {
    expect(statusToVietnamese(code)).toBe('Trạng thái khác');
  });

  it('không ném lỗi với bất kỳ chuỗi nào', () => {
    for (const code of ['', '__proto__', 'x'.repeat(1000), '😀']) {
      expect(() => statusToVietnamese(code)).not.toThrow();
    }
  });
});
