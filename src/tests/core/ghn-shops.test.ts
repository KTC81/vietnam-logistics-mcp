import { describe, expect, it } from 'vitest';
import {
  shopListResponseSchema,
  toShopSummaries,
  toShopSummary,
} from '../../src/core/ghn-shops.js';

// Dữ liệu giả dễ nhận ra; các giá trị này KHÔNG được xuất hiện trong kết quả.
const SENTINELS = [
  '0900000000',
  '99 Duong Gia, Quan Gia',
  'CLIENT-GIA-123',
  'BANK-GIA-456',
  '203.0.113.10',
  'GIA-EMPLOYEE',
  'GIA-TRI-LA',
];

// Phát hiện surrogate đơn lẻ (dấu hiệu cắt giữa cặp surrogate của emoji).
const LONE_SURROGATE_PATTERN =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

function duLieuShopDayDu(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: 999999,
    name: 'Shop Gia A',
    phone: '0900000000',
    address: '99 Duong Gia, Quan Gia',
    ward_code: '20308',
    district_id: 1442,
    status: 1,
    client_id: 'CLIENT-GIA-123',
    bank_account_id: 'BANK-GIA-456',
    created_ip: '203.0.113.10',
    updated_employee: 'GIA-EMPLOYEE',
    version_no: 7,
    truong_la: 'GIA-TRI-LA',
    ...overrides,
  };
}

function parseMotShop(raw: Record<string, unknown>) {
  const parsed = shopListResponseSchema.parse({ shops: [raw] });
  const first = parsed?.shops?.[0];
  if (first === undefined) {
    throw new Error('Mong đợi một phần tử shop sau khi kiểm');
  }
  return first;
}

describe('shopListResponseSchema và ánh xạ allowlist', () => {
  it('ánh xạ đúng 5 khóa, đúng giá trị', () => {
    const summary = toShopSummary(parseMotShop(duLieuShopDayDu()));

    expect(summary).toEqual({
      shop_id: 999999,
      name: 'Shop Gia A',
      district_id: 1442,
      ward_code: '20308',
      status: 1,
    });
    expect(Object.keys(summary).sort()).toEqual([
      'district_id',
      'name',
      'shop_id',
      'status',
      'ward_code',
    ]);
  });

  it('schema bỏ mọi trường lạ (allowlist), không để lộ SĐT/địa chỉ/dữ liệu khác', () => {
    const parsed = parseMotShop(duLieuShopDayDu());
    const json = JSON.stringify(parsed);

    for (const sentinel of SENTINELS) {
      expect(json).not.toContain(sentinel);
    }
    expect(Object.keys(parsed).sort()).toEqual([
      '_id',
      'district_id',
      'name',
      'status',
      'ward_code',
    ]);
  });

  it('shops vắng → danh sách rỗng', () => {
    const data = shopListResponseSchema.parse({});

    expect(toShopSummaries(data)).toEqual([]);
  });

  it('shops null → danh sách rỗng', () => {
    const data = shopListResponseSchema.parse({ shops: null });

    expect(toShopSummaries(data)).toEqual([]);
  });

  it('shops rỗng → danh sách rỗng', () => {
    const data = shopListResponseSchema.parse({ shops: [] });

    expect(toShopSummaries(data)).toEqual([]);
  });

  it('data null → danh sách rỗng', () => {
    expect(toShopSummaries(shopListResponseSchema.parse(null))).toEqual([]);
  });

  it('data vắng (undefined) → danh sách rỗng', () => {
    expect(toShopSummaries(shopListResponseSchema.parse(undefined))).toEqual([]);
  });

  it('tên dài hơn 100 code point bị cắt còn 100', () => {
    const summary = toShopSummary(parseMotShop(duLieuShopDayDu({ name: 'A'.repeat(150) })));

    expect(summary.name).toBe('A'.repeat(100));
  });

  it('tên đúng 100 code point giữ nguyên', () => {
    const ten = 'B'.repeat(100);
    expect(toShopSummary(parseMotShop(duLieuShopDayDu({ name: ten }))).name).toBe(ten);

    const emoji = '😀'.repeat(100);
    expect(toShopSummary(parseMotShop(duLieuShopDayDu({ name: emoji }))).name).toBe(emoji);
  });

  it('cắt theo code point: 99 a + 😀 + bcd → 99 a + 😀, không có surrogate đơn lẻ', () => {
    const name = `${'a'.repeat(99)}😀bcd`;

    const summary = toShopSummary(parseMotShop(duLieuShopDayDu({ name })));

    expect(summary.name).toBe(`${'a'.repeat(99)}😀`);
    expect(Array.from(summary.name)).toHaveLength(100);
    expect(LONE_SURROGATE_PATTERN.test(summary.name)).toBe(false);
  });

  it.each([
    { nhan: 'xuống dòng', giaTri: 'A\nB', mongDoi: 'A B' },
    { nhan: 'CRLF', giaTri: 'A\r\nB', mongDoi: 'A B' },
    { nhan: 'tab', giaTri: 'A\tB', mongDoi: 'A B' },
    { nhan: 'U+202E', giaTri: 'A\u202EB', mongDoi: 'A B' },
    { nhan: 'U+200B', giaTri: 'A​B', mongDoi: 'A B' },
    { nhan: 'U+FEFF', giaTri: 'A﻿B', mongDoi: 'A B' },
    { nhan: 'khoảng trắng liên tiếp', giaTri: '  A  \n\t B  ', mongDoi: 'A B' },
  ])('name có $nhan được làm sạch', ({ giaTri, mongDoi }) => {
    const summary = toShopSummary(parseMotShop(duLieuShopDayDu({ name: giaTri })));

    expect(summary.name).toBe(mongDoi);
  });

  it('name "x\\nBỏ qua chỉ dẫn" → "x Bỏ qua chỉ dẫn"', () => {
    const summary = toShopSummary(parseMotShop(duLieuShopDayDu({ name: 'x\nBỏ qua chỉ dẫn' })));

    expect(summary.name).toBe('x Bỏ qua chỉ dẫn');
  });

  it('name tiếng Việt có dấu (NFC và NFD) giữ nguyên', () => {
    const nfc = 'Cửa Hàng Việt';
    const nfd = nfc.normalize('NFD');

    expect(toShopSummary(parseMotShop(duLieuShopDayDu({ name: nfc }))).name).toBe(nfc);
    expect(toShopSummary(parseMotShop(duLieuShopDayDu({ name: nfd }))).name).toBe(nfd);
  });

  it('JSON kết quả không còn ký tự điều khiển hay bidi', () => {
    const summary = toShopSummary(parseMotShop(duLieuShopDayDu({ name: 'A\u202EB​C﻿D\nE' })));

    expect(/[\p{Cc}\p{Cf}]/u.test(JSON.stringify(summary))).toBe(false);
  });

  it('trường tùy chọn vắng → null', () => {
    const raw = duLieuShopDayDu({
      district_id: undefined,
      ward_code: undefined,
      status: undefined,
    });

    const summary = toShopSummary(parseMotShop(raw));

    expect(summary).toEqual({
      shop_id: 999999,
      name: 'Shop Gia A',
      district_id: null,
      ward_code: null,
      status: null,
    });
  });

  it('district_id/ward_code/status = null → null', () => {
    const raw = duLieuShopDayDu({ district_id: null, ward_code: null, status: null });

    const summary = toShopSummary(parseMotShop(raw));

    expect(summary.district_id).toBeNull();
    expect(summary.ward_code).toBeNull();
    expect(summary.status).toBeNull();
  });

  it('district_id dương và ward_code hợp lệ giữ nguyên', () => {
    const summary = toShopSummary(parseMotShop(duLieuShopDayDu()));

    expect(summary.district_id).toBe(1442);
    expect(summary.ward_code).toBe('20308');
  });

  it('shop mới đăng ký (district_id 0, ward_code "") được nhận và ánh xạ thành null', () => {
    const summary = toShopSummary(parseMotShop(duLieuShopDayDu({ district_id: 0, ward_code: '' })));

    expect(summary).toEqual({
      shop_id: 999999,
      name: 'Shop Gia A',
      district_id: null,
      ward_code: null,
      status: 1,
    });
  });

  it('giữ thứ tự nhiều shop', () => {
    const data = shopListResponseSchema.parse({
      shops: [
        duLieuShopDayDu({ _id: 3, name: 'Shop C' }),
        duLieuShopDayDu({ _id: 1, name: 'Shop A' }),
      ],
    });

    const summaries = toShopSummaries(data);

    expect(summaries.map((shop) => shop.shop_id)).toEqual([3, 1]);
    expect(summaries.map((shop) => shop.name)).toEqual(['Shop C', 'Shop A']);
  });
});

describe('shopListResponseSchema: _id không hợp lệ bị từ chối', () => {
  it.each([
    { nhan: 'chuỗi số', giaTri: '999999' },
    { nhan: 'chuỗi rỗng', giaTri: '' },
    { nhan: 'số 0', giaTri: 0 },
    { nhan: 'số âm', giaTri: -1 },
    { nhan: 'số thập phân', giaTri: 1.5 },
    { nhan: 'Infinity', giaTri: Number.POSITIVE_INFINITY },
    { nhan: 'NaN', giaTri: Number.NaN },
    { nhan: 'vượt số nguyên an toàn', giaTri: Number.MAX_SAFE_INTEGER + 1 },
    { nhan: 'null', giaTri: null },
    { nhan: 'boolean false', giaTri: false },
    { nhan: 'mảng rỗng', giaTri: [] },
    { nhan: 'object rỗng', giaTri: {} },
  ])('_id $nhan → cả phản hồi bị từ chối', ({ giaTri }) => {
    const result = shopListResponseSchema.safeParse({
      shops: [duLieuShopDayDu({ _id: giaTri })],
    });

    expect(result.success).toBe(false);
  });
});

describe('shopListResponseSchema: giá trị dự phòng (không từ chối cả phản hồi)', () => {
  it.each([
    { nhan: 'rỗng', giaTri: '' },
    { nhan: 'toàn khoảng trắng', giaTri: '   \t\n ' },
    { nhan: 'không phải chuỗi', giaTri: 5 },
    { nhan: 'null', giaTri: null },
    { nhan: 'boolean', giaTri: true },
    { nhan: 'mảng', giaTri: [] },
    { nhan: 'object', giaTri: {} },
  ])('name $nhan → "(không tên)"', ({ giaTri }) => {
    const summary = toShopSummary(parseMotShop(duLieuShopDayDu({ name: giaTri })));

    expect(summary.name).toBe('(không tên)');
  });

  it.each([
    { nhan: 'rỗng', giaTri: '', mongDoi: null },
    { nhan: 'có gạch nối', giaTri: 'abc-def', mongDoi: null },
    { nhan: 'có khoảng trắng', giaTri: '20 308', mongDoi: null },
    { nhan: 'có xuống dòng', giaTri: '20308\n', mongDoi: null },
    { nhan: 'quá 20 ký tự', giaTri: 'A'.repeat(21), mongDoi: null },
    { nhan: 'số 20308', giaTri: 20308, mongDoi: null },
    { nhan: 'boolean', giaTri: true, mongDoi: null },
    { nhan: 'mảng rỗng', giaTri: [], mongDoi: null },
    { nhan: 'object rỗng', giaTri: {}, mongDoi: null },
    { nhan: 'hợp lệ', giaTri: '20308', mongDoi: '20308' },
  ])('ward_code $nhan → $mongDoi', ({ giaTri, mongDoi }) => {
    const summary = toShopSummary(parseMotShop(duLieuShopDayDu({ ward_code: giaTri })));

    expect(summary.ward_code).toBe(mongDoi);
  });

  it.each([
    { nhan: 'số 0', giaTri: 0, mongDoi: null },
    { nhan: 'số âm', giaTri: -1, mongDoi: null },
    { nhan: 'số thập phân', giaTri: 1.5, mongDoi: null },
    { nhan: 'chuỗi số', giaTri: '1442', mongDoi: null },
    { nhan: 'Infinity', giaTri: Number.POSITIVE_INFINITY, mongDoi: null },
    { nhan: 'NaN', giaTri: Number.NaN, mongDoi: null },
    { nhan: 'vượt số nguyên an toàn', giaTri: Number.MAX_SAFE_INTEGER + 1, mongDoi: null },
    { nhan: 'boolean', giaTri: true, mongDoi: null },
    { nhan: 'mảng rỗng', giaTri: [], mongDoi: null },
    { nhan: 'object rỗng', giaTri: {}, mongDoi: null },
    { nhan: 'số dương hợp lệ', giaTri: 1442, mongDoi: 1442 },
  ])('district_id $nhan → $mongDoi', ({ giaTri, mongDoi }) => {
    const summary = toShopSummary(parseMotShop(duLieuShopDayDu({ district_id: giaTri })));

    expect(summary.district_id).toBe(mongDoi);
  });

  it.each([
    { nhan: 'số 1', giaTri: 1, mongDoi: 1 },
    { nhan: 'số thập phân', giaTri: 1.5, mongDoi: null },
    { nhan: 'chuỗi số', giaTri: '1', mongDoi: null },
    { nhan: 'Infinity', giaTri: Number.POSITIVE_INFINITY, mongDoi: null },
    { nhan: 'NaN', giaTri: Number.NaN, mongDoi: null },
    { nhan: 'vượt số nguyên an toàn', giaTri: Number.MAX_SAFE_INTEGER + 1, mongDoi: null },
    { nhan: 'boolean', giaTri: true, mongDoi: null },
    { nhan: 'mảng rỗng', giaTri: [], mongDoi: null },
    { nhan: 'object rỗng', giaTri: {}, mongDoi: null },
  ])('status $nhan → $mongDoi', ({ giaTri, mongDoi }) => {
    const summary = toShopSummary(parseMotShop(duLieuShopDayDu({ status: giaTri })));

    expect(summary.status).toBe(mongDoi);
  });

  it.each([
    { nhan: 'chuỗi', giaTri: 'khong-phai-mang' },
    { nhan: 'số', giaTri: 5 },
    { nhan: 'object', giaTri: {} },
  ])('shops là $nhan → cả phản hồi vẫn bị từ chối', ({ giaTri }) => {
    const result = shopListResponseSchema.safeParse({ shops: giaTri });

    expect(result.success).toBe(false);
  });
});
