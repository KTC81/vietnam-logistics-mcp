import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BIEN_BAT_BUOC_THAT,
  doLuong,
  ketLuanTool,
  kiemTraCauHinhThat,
  phanTichThamSo,
  taoCongGhnGia,
  taoKeHoachDo,
  thongTinGiaMock,
  tinhMaThoat,
  tinhThongKe,
  xayDungBaoCao,
  type KetQuaGoiTool,
  type KetQuaToolDo,
} from '../../scripts/hieu-nang-lib.mjs';

// Một mục kết quả đo giả: thống kê dựng từ mảng mẫu cố định, không đo thời gian thật.
function taoMuc(
  tool: string,
  threshold: number | null,
  values: readonly number[],
  errorCount = 0,
  firstErrorCode: string | null = null,
): KetQuaToolDo {
  return {
    tool,
    threshold,
    statsTook: tinhThongKe(values),
    statsRoundTrip: tinhThongKe(values.map((value) => value + 0.5)),
    errorCount,
    firstErrorCode,
  };
}

function moiTruongHopLe(ghiDe: Record<string, string> = {}): Record<string, string> {
  return {
    GHN_TOKEN: 'TOKEN-GIA-123',
    GHN_SHOP_ID: '999999',
    GHN_ENV: 'staging',
    ORDER_CODE: 'G8A000000001',
    FROM_DISTRICT: '1442',
    TO_DISTRICT: '1443',
    TO_WARD: '20110',
    ...ghiDe,
  };
}

describe('tinhThongKe', () => {
  it('trung vị số mẫu lẻ (dữ liệu lệch: trung vị KHÁC trung bình), p95, nhỏ nhất/lớn nhất', () => {
    // Trung bình = 34.33 nhưng trung vị = 2: phân biệt trung vị với trung bình.
    expect(tinhThongKe([1, 2, 100])).toEqual({ n: 3, median: 2, p95: 100, min: 1, max: 100 });
  });

  it('trung vị số mẫu chẵn là trung bình hai phần tử giữa', () => {
    expect(tinhThongKe([1, 2, 3, 100])).toEqual({
      n: 4,
      median: 2.5,
      p95: 100,
      min: 1,
      max: 100,
    });
  });

  it('p95 = phần tử thứ ceil(0.95 × n) sau khi sắp xếp (n = 20 → phần tử thứ 19)', () => {
    const values = Array.from({ length: 20 }, (_item, index) => index + 1);

    const stats = tinhThongKe(values);

    expect(stats.p95).toBe(19);
    expect(stats.max).toBe(20);
  });

  it('giá trị trùng lặp', () => {
    expect(tinhThongKe([5, 5, 5])).toEqual({ n: 3, median: 5, p95: 5, min: 5, max: 5 });
  });

  it('mảng rỗng không ném lỗi, trả n = 0 và null', () => {
    expect(tinhThongKe([])).toEqual({ n: 0, median: null, p95: null, min: null, max: null });
  });

  it('một phần tử', () => {
    expect(tinhThongKe([7])).toEqual({ n: 1, median: 7, p95: 7, min: 7, max: 7 });
  });
});

describe('ketLuanTool', () => {
  it('ngưỡng 500: 499 ĐẠT, 500 KHÔNG ĐẠT', () => {
    expect(ketLuanTool(taoMuc('ghn_get_order_detail', 500, [499]))).toBe('ĐẠT');
    expect(ketLuanTool(taoMuc('ghn_get_order_detail', 500, [500]))).toBe('KHÔNG ĐẠT');
  });

  it('ngưỡng 800: 799 ĐẠT, 800 KHÔNG ĐẠT', () => {
    expect(ketLuanTool(taoMuc('ghn_get_fee', 800, [799]))).toBe('ĐẠT');
    expect(ketLuanTool(taoMuc('ghn_get_fee', 800, [800]))).toBe('KHÔNG ĐẠT');
  });

  it('chế độ mock: ngưỡng nội bộ 50, 49 ĐẠT, 50 KHÔNG ĐẠT', () => {
    expect(ketLuanTool(taoMuc('ghn_get_shops', 50, [49]))).toBe('ĐẠT');
    expect(ketLuanTool(taoMuc('ghn_get_shops', 50, [50]))).toBe('KHÔNG ĐẠT');
  });

  it('có lần lỗi → KHÔNG HỢP LỆ, nêu số lần và mã lỗi đầu tiên, không kết luận', () => {
    const ketLuan = ketLuanTool(taoMuc('ghn_get_fee', 800, [10, 20], 3, 'GHN_TIMEOUT'));

    expect(ketLuan).toBe('KHÔNG HỢP LỆ: có 3 lần lỗi (mã lỗi đầu tiên: GHN_TIMEOUT)');
    expect(ketLuan).not.toContain('ĐẠT');
  });

  it('ngưỡng null (ghn_get_shops chế độ thật) → chỉ báo cáo', () => {
    expect(ketLuanTool(taoMuc('ghn_get_shops', null, [10]))).toBe('— (chỉ báo cáo)');
  });
});

describe('tinhMaThoat', () => {
  it('mọi tool ĐẠT (kể cả tool không ngưỡng) → 0', () => {
    expect(
      tinhMaThoat([
        taoMuc('ghn_get_order_detail', 500, [499]),
        taoMuc('ghn_get_fee', 800, [799]),
        taoMuc('ghn_get_shops', null, [10]),
      ]),
    ).toBe(0);
  });

  it('có tool KHÔNG ĐẠT, không lỗi → 2', () => {
    expect(tinhMaThoat([taoMuc('ghn_get_order_detail', 500, [500])])).toBe(2);
  });

  it('có lần lỗi → 1', () => {
    expect(tinhMaThoat([taoMuc('ghn_get_fee', 800, [10], 1, 'GHN_TIMEOUT')])).toBe(1);
  });

  it('vừa có lỗi vừa có tool KHÔNG ĐẠT → 1 (lỗi thắng)', () => {
    expect(
      tinhMaThoat([
        taoMuc('ghn_get_order_detail', 500, [500]),
        taoMuc('ghn_get_fee', 800, [10], 2, 'GHN_TIMEOUT'),
      ]),
    ).toBe(1);
  });

  it('danh sách rỗng → 0', () => {
    expect(tinhMaThoat([])).toBe(0);
  });

  it('tool không hợp lệ (không có mẫu hợp lệ) → 1', () => {
    expect(tinhMaThoat([taoMuc('ghn_get_fee', 800, [])])).toBe(1);
  });
});

describe('taoCongGhnGia', () => {
  it('dữ liệu giả đúng schema thì qua và trả dữ liệu đã parse', async () => {
    const cong = taoCongGhnGia();

    const duLieu = await cong.request(
      '/v2/shipping-order/fee',
      {},
      z.object({ total: z.number(), service_fee: z.number(), insurance_fee: z.number() }),
    );

    expect(duLieu).toEqual({ total: 35000, service_fee: 32000, insurance_fee: 3000 });
  });

  it('schema sai thì ném lỗi (cổng giả vẫn kiểm bằng responseSchema)', async () => {
    const cong = taoCongGhnGia();

    await expect(
      cong.request('/v2/shipping-order/detail', {}, z.object({ khong_ton_tai: z.string() })),
    ).rejects.toThrow();
    await expect(cong.request('/v2/shop/all', {}, z.string())).rejects.toThrow();
  });
});

describe('tinhThongKe qua doLuong', () => {
  it('warmup không vào thống kê; tookMs và khứ hồi thống kê trên các lần tính', async () => {
    let soLanGoi = 0;
    let tick = 0;
    const now = (): number => {
      tick += 5;
      return tick;
    };
    // Dữ liệu lệch (20, 100, 200): trung vị 100 KHÁC trung bình 106.67.
    const cacTookMs = [10, 20, 100, 200];
    const goi = async (): Promise<KetQuaGoiTool> => {
      const tookMs = cacTookMs[soLanGoi] ?? 0;
      soLanGoi += 1;
      return { ok: true, tookMs };
    };

    const ketQua = await doLuong({
      goi,
      keHoach: [{ tool: 'ghn_demo', args: {}, threshold: 100 }],
      runs: 3,
      warmup: 1,
      now,
    });

    expect(soLanGoi).toBe(4);
    expect(ketQua[0]?.statsTook).toEqual({ n: 3, median: 100, p95: 200, min: 20, max: 200 });
    expect(ketQua[0]?.statsRoundTrip).toEqual({ n: 3, median: 5, p95: 5, min: 5, max: 5 });
    expect(ketQua[0]?.errorCount).toBe(0);
    expect(ketQua[0]?.firstErrorCode).toBeNull();
  });

  it('lần lỗi bị loại khỏi thống kê thời gian, đếm riêng và giữ mã lỗi đầu tiên', async () => {
    // Lần 2 lỗi; ba mẫu hợp lệ 10/100/400 lệch để trung vị (100) khác trung bình (170).
    const cacTookMs = [10, null, 100, 400];
    let soLanGoi = 0;
    const goi = async (): Promise<KetQuaGoiTool> => {
      const tookMs = cacTookMs[soLanGoi];
      soLanGoi += 1;
      if (tookMs === null || tookMs === undefined) {
        return { ok: false, errorCode: 'GHN_TIMEOUT' };
      }
      return { ok: true, tookMs };
    };

    const ketQua = await doLuong({
      goi,
      keHoach: [{ tool: 'ghn_demo', args: {}, threshold: 100 }],
      runs: 4,
      warmup: 0,
    });

    expect(ketQua[0]?.statsTook).toMatchObject({ n: 3, median: 100, min: 10, max: 400 });
    expect(ketQua[0]?.statsRoundTrip.n).toBe(3);
    expect(ketQua[0]?.errorCount).toBe(1);
    expect(ketQua[0]?.firstErrorCode).toBe('GHN_TIMEOUT');
  });

  it('lỗi ở lần khởi động vẫn tính là lỗi (dù không vào thống kê)', async () => {
    let soLanGoi = 0;
    const goi = async (): Promise<KetQuaGoiTool> => {
      soLanGoi += 1;
      if (soLanGoi === 1) {
        return { ok: false, errorCode: 'GHN_UNAUTHORIZED' };
      }
      return { ok: true, tookMs: 7 };
    };

    const ketQua = await doLuong({
      goi,
      keHoach: [{ tool: 'ghn_demo', args: {}, threshold: 100 }],
      runs: 1,
      warmup: 1,
    });

    expect(ketQua[0]?.statsTook).toMatchObject({ n: 1, median: 7 });
    expect(ketQua[0]?.errorCount).toBe(1);
    expect(ketQua[0]?.firstErrorCode).toBe('GHN_UNAUTHORIZED');
  });

  it('ngoại lệ từ hàm gọi cũng là lần lỗi, không lộ nội dung lỗi', async () => {
    const goi = async (): Promise<KetQuaGoiTool> => {
      throw new Error('nội dung nhạy cảm không được lọt vào thống kê');
    };

    const ketQua = await doLuong({
      goi,
      keHoach: [{ tool: 'ghn_demo', args: {}, threshold: 100 }],
      runs: 1,
      warmup: 0,
    });

    expect(ketQua[0]?.errorCount).toBe(1);
    expect(ketQua[0]?.firstErrorCode).toBe('INTERNAL_ERROR');
    expect(ketQua[0]?.statsTook).toEqual({ n: 0, median: null, p95: null, min: null, max: null });
  });

  it('mã lỗi lạ (có xuống dòng/ký tự lạ) bị thay bằng INTERNAL_ERROR', async () => {
    const goi = async (): Promise<KetQuaGoiTool> => ({
      ok: false,
      errorCode: 'GHN_TIMEOUT\n| giả mạo',
    });

    const ketQua = await doLuong({
      goi,
      keHoach: [{ tool: 'ghn_demo', args: {}, threshold: 100 }],
      runs: 1,
      warmup: 0,
    });

    expect(ketQua[0]?.firstErrorCode).toBe('INTERNAL_ERROR');
  });
});

describe('phanTichThamSo', () => {
  it('mặc định: chế độ thật, 20 lần, 2 lần khởi động, không --json/--force', () => {
    expect(phanTichThamSo([])).toEqual({
      mode: 'real',
      runs: 20,
      warmup: 2,
      out: undefined,
      json: false,
      force: false,
    });
  });

  it('nhận --mock, --runs, --warmup, --out, --json, --force', () => {
    expect(
      phanTichThamSo([
        '--mock',
        '--runs',
        '5',
        '--warmup',
        '1',
        '--out',
        '/tmp/bao-cao.md',
        '--json',
        '--force',
      ]),
    ).toEqual({
      mode: 'mock',
      runs: 5,
      warmup: 1,
      out: '/tmp/bao-cao.md',
      json: true,
      force: true,
    });
  });

  it('--warmup 0 hợp lệ', () => {
    expect(phanTichThamSo(['--warmup', '0']).warmup).toBe(0);
  });

  it('cận trên: --runs 1000 và --warmup 100 được nhận', () => {
    expect(phanTichThamSo(['--runs', '1000']).runs).toBe(1000);
    expect(phanTichThamSo(['--warmup', '100']).warmup).toBe(100);
  });

  it.each(['0', '-1', 'abc', '2.5', '1e9', '1001', '99999999999999999999'])(
    '--runs %s bị từ chối bằng tiếng Việt nêu cận',
    (value) => {
      expect(() => phanTichThamSo(['--runs', value])).toThrow(/--runs phải từ 1 đến 1000/);
    },
  );

  it.each(['-1', 'abc', '1.5', '101'])(
    '--warmup %s bị từ chối bằng tiếng Việt nêu cận',
    (value) => {
      expect(() => phanTichThamSo(['--warmup', value])).toThrow(/--warmup phải từ 0 đến 100/);
    },
  );

  it.each([
    ['--runs', '3', '--runs', '4'],
    ['--warmup', '1', '--warmup', '2'],
    ['--out', 'a.md', '--out', 'b.md'],
  ])('cờ bị lặp phải báo lỗi: %s %s %s %s', (...argv) => {
    expect(() => phanTichThamSo(argv)).toThrow(/cờ bị lặp/i);
  });

  it('cờ boolean bị lặp cũng báo lỗi', () => {
    expect(() => phanTichThamSo(['--mock', '--mock'])).toThrow(/cờ bị lặp/i);
    expect(() => phanTichThamSo(['--force', '--force'])).toThrow(/cờ bị lặp/i);
  });

  it('tham số thiếu giá trị hoặc không nhận diện được → lỗi rõ ràng', () => {
    expect(() => phanTichThamSo(['--runs'])).toThrow(/cần một giá trị/);
    expect(() => phanTichThamSo(['--out'])).toThrow(/cần một giá trị/);
    expect(() => phanTichThamSo(['--khong-co'])).toThrow(/không hợp lệ/);
    expect(() => phanTichThamSo(['thua'])).toThrow(/không hợp lệ/);
  });
});

describe('kiemTraCauHinhThat', () => {
  it('liệt kê đúng tên biến thiếu, không nêu giá trị', () => {
    const ketQua = kiemTraCauHinhThat({ GHN_TOKEN: 'TOKEN-GIA-123' });

    expect(ketQua.missing).toEqual(BIEN_BAT_BUOC_THAT.filter((ten) => ten !== 'GHN_TOKEN'));
    expect(ketQua.error).toBeUndefined();
  });

  it('mọi biến đều thiếu khi môi trường rỗng', () => {
    expect(kiemTraCauHinhThat({}).missing).toEqual([...BIEN_BAT_BUOC_THAT]);
  });

  it('GHN_ENV khác staging bị từ chối ở chế độ thật', () => {
    const ketQua = kiemTraCauHinhThat(moiTruongHopLe({ GHN_ENV: 'production' }));

    expect(ketQua.missing).toEqual([]);
    expect(ketQua.error).toContain('staging');
    expect(ketQua.args).toBeUndefined();
  });

  it.each([' staging', 'staging '])(
    'GHN_ENV %j bị từ chối vì so chuỗi GỐC (không trim)',
    (value) => {
      const ketQua = kiemTraCauHinhThat(moiTruongHopLe({ GHN_ENV: value }));

      expect(ketQua.missing).toEqual([]);
      expect(ketQua.error).toContain('staging');
      expect(ketQua.args).toBeUndefined();
    },
  );

  it('môi trường hợp lệ: WEIGHT mặc định 500; có WEIGHT thì dùng giá trị đó', () => {
    const macDinh = kiemTraCauHinhThat(moiTruongHopLe());
    expect(macDinh.args).toEqual({
      orderCode: 'G8A000000001',
      fromDistrict: 1442,
      toDistrict: 1443,
      toWard: '20110',
      weight: 500,
    });

    const coCanNang = kiemTraCauHinhThat(moiTruongHopLe({ WEIGHT: '750' }));
    expect(coCanNang.args?.weight).toBe(750);
  });

  it('biến số sai định dạng: chỉ nêu TÊN biến, không nêu giá trị', () => {
    const ketQua = kiemTraCauHinhThat(moiTruongHopLe({ FROM_DISTRICT: 'khong-phai-so' }));

    expect(ketQua.error).toContain('FROM_DISTRICT');
    expect(ketQua.error).not.toContain('khong-phai-so');
    expect(ketQua.args).toBeUndefined();
  });
});

describe('taoKeHoachDo', () => {
  it('chế độ thật: ngưỡng 500/800, ghn_get_shops không ngưỡng', () => {
    const keHoach = taoKeHoachDo({
      mode: 'real',
      args: {
        orderCode: 'G8A000000001',
        fromDistrict: 1442,
        toDistrict: 1443,
        toWard: '20110',
        weight: 500,
      },
    });

    expect(keHoach.map((muc) => muc.tool)).toEqual([
      'ghn_get_order_detail',
      'ghn_get_fee',
      'ghn_get_shops',
    ]);
    expect(keHoach.map((muc) => muc.threshold)).toEqual([500, 800, null]);
    expect(keHoach[0]?.args).toEqual({ order_code: 'G8A000000001' });
    expect(keHoach[1]?.args).toEqual({
      from_district_id: 1442,
      to_district_id: 1443,
      to_ward_code: '20110',
      weight: 500,
    });
  });

  it('chế độ mock: ngưỡng nội bộ 50 cho cả 3 tool, mã đơn giả cố định', () => {
    const keHoach = taoKeHoachDo({ mode: 'mock' });

    expect(keHoach.map((muc) => muc.threshold)).toEqual([50, 50, 50]);
    expect(keHoach[0]?.args).toEqual({ order_code: thongTinGiaMock.orderCode });
  });

  it('chế độ thật thiếu args → lỗi lập trình rõ ràng', () => {
    expect(() => taoKeHoachDo({ mode: 'real' })).toThrow(/cần args/);
  });
});

describe('xayDungBaoCao', () => {
  function dungBaoCao(): string {
    return xayDungBaoCao({
      mode: 'real',
      generatedAt: '2026-11-22T03:00:00.000Z',
      nodeVersion: 'v26.13.1',
      os: 'darwin 25.5.0',
      commit: '803b3c5',
      runs: 20,
      warmup: 2,
      tools: [
        taoMuc('ghn_get_order_detail', 500, [499]),
        taoMuc('ghn_get_fee', 800, [800]),
        taoMuc('ghn_get_shops', null, [10]),
      ],
      // Chuỗi giả cố định: báo cáo TUYỆT ĐỐI không được chứa các giá trị này.
      nguCanhNhayCam: {
        token: 'TOKEN-GIA-123',
        shopId: 999999,
        orderCode: 'G8A123456789',
      },
    });
  }

  it('đủ cột bảng và thông tin môi trường', () => {
    const baoCao = dungBaoCao();

    expect(baoCao).toContain(
      '| Tool | n | Trung vị (ms) | p95 (ms) | Nhỏ nhất (ms) | Lớn nhất (ms) | Ngưỡng (ms) | Kết quả |',
    );
    expect(baoCao).toContain('| ghn_get_order_detail | 1 | 499 |');
    expect(baoCao).toContain('2026-11-22T03:00:00.000Z');
    expect(baoCao).toContain('staging (T_tool, gồm thời gian GHN)');
    expect(baoCao).toContain('v26.13.1');
    expect(baoCao).toContain('803b3c5');
    expect(baoCao).toContain('20 (khởi động không tính: 2)');
  });

  it('ĐẠT/KHÔNG ĐẠT theo ngưỡng; tool không ngưỡng chỉ báo cáo', () => {
    const baoCao = dungBaoCao();

    expect(baoCao).toContain('| 499 |');
    expect(baoCao).toContain('ĐẠT');
    expect(baoCao).toContain('KHÔNG ĐẠT');
    expect(baoCao).toContain('— (chỉ báo cáo)');
  });

  it('có lần lỗi → KHÔNG HỢP LỆ kèm mã lỗi đầu tiên, không kết luận', () => {
    const baoCao = xayDungBaoCao({
      mode: 'mock',
      generatedAt: '2026-11-22T03:00:00.000Z',
      nodeVersion: 'v26.13.1',
      os: 'darwin 25.5.0',
      commit: 'không rõ',
      runs: 3,
      warmup: 0,
      tools: [taoMuc('ghn_get_fee', 50, [10], 2, 'GHN_TIMEOUT')],
    });

    expect(baoCao).toContain('KHÔNG HỢP LỆ: có 2 lần lỗi (mã lỗi đầu tiên: GHN_TIMEOUT)');
  });

  it('không chứa token, ShopId hay mã đơn đầy đủ dù ngữ cảnh nhạy cảm được đưa vào', () => {
    const baoCao = dungBaoCao();

    expect(baoCao).not.toContain('TOKEN-GIA-123');
    expect(baoCao).not.toContain('999999');
    expect(baoCao).not.toContain('G8A123456789');
  });

  it('ghi chú cố định về staging và p95', () => {
    const baoCao = dungBaoCao();

    expect(baoCao).toContain(
      'staging khác production, số đo staging chưa chứng minh production đạt.',
    );
    expect(baoCao).toContain('p95 báo cáo để tham khảo, điều kiện đạt dùng trung vị.');
  });
});
