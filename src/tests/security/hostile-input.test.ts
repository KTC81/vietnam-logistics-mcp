import { describe, expect, it } from 'vitest';
import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { AppError } from '../../src/core/errors.js';
import { parseInput } from '../../src/utils/validator.js';
import { TOOL_FIXTURES } from '../helpers/security-fixtures.js';
import { goiTool, taoGhnDem, taoHarness, taoRegistry } from '../helpers/security-harness.js';
import { installMockFetch } from '../helpers/mock-fetch.js';

// Ngưỡng thời gian cho chuỗi 10 MB (đo thực tế vài ms; 1000 ms đủ rộng cho CI).
const NGUONG_MS = 1000;
const MARKER_DOC_HAI = 'GIA-DOC-HAI-9f3c';
const MARKER_PROTO = 'GIA-PROTO-9f3c';
const MARKER_GIA = 'MARKER-GIA-XYZ-123';

function laRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function layFixture(tenTool: string) {
  const fixture = TOOL_FIXTURES[tenTool];
  if (fixture === undefined) {
    throw new Error(`Thiếu fixture bảo mật cho tool ${tenTool}`);
  }
  return fixture;
}

function thuKieu(node: unknown, kieu: Set<string>): void {
  if (!laRecord(node)) {
    return;
  }
  const type = node['type'];
  if (typeof type === 'string') {
    kieu.add(type);
  } else if (Array.isArray(type)) {
    for (const item of type) {
      if (typeof item === 'string') {
        kieu.add(item);
      }
    }
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const branches = node[key];
    if (Array.isArray(branches)) {
      for (const branch of branches) {
        thuKieu(branch, kieu);
      }
    }
  }
}

function layTruongTuSchema(schema: unknown): { chuoi: string[]; so: string[] } {
  const ketQua = { chuoi: [] as string[], so: [] as string[] };
  if (!laRecord(schema)) {
    return ketQua;
  }
  const properties = schema['properties'];
  if (!laRecord(properties)) {
    return ketQua;
  }
  for (const [ten, node] of Object.entries(properties)) {
    const kieu = new Set<string>();
    thuKieu(node, kieu);
    if (kieu.has('string')) {
      ketQua.chuoi.push(ten);
    }
    if (kieu.has('number') || kieu.has('integer')) {
      ketQua.so.push(ten);
    }
  }
  return ketQua;
}

// JSON Schema của từng tool, tính ĐỒNG BỘ lúc thu thập test (không phụ thuộc beforeAll).
// Cùng nguồn với `tools/list` (server dùng zodToJsonSchema), nên trường tùy chọn không có
// trong `validArguments` vẫn được thử.
const TOOLS = taoRegistry()
  .list()
  .map((tool) => {
    const jsonSchema = zodToJsonSchema(tool.inputSchema as ZodTypeAny, {
      $refStrategy: 'none',
    }) as unknown;
    const truong = layTruongTuSchema(jsonSchema);
    return { tool, fixture: layFixture(tool.name), jsonSchema, truong };
  });

function layNodeThuocTinh(schema: unknown, field: string): unknown {
  if (!laRecord(schema)) {
    return undefined;
  }
  const properties = schema['properties'];
  if (!laRecord(properties)) {
    return undefined;
  }
  return properties[field];
}

// true nếu schema cho phép số 0 KHÔNG loại trừ (minimum: 0, không exclusiveMinimum: 0)
// hoặc enum có chứa 0. Dùng để đặt kỳ vọng đúng cho `-0` (>=0 hợp lệ, >0 bị từ chối).
function nhanSoAmKhong(node: unknown): boolean {
  if (!laRecord(node)) {
    return false;
  }
  if (Array.isArray(node['enum'])) {
    return node['enum'].includes(0);
  }
  let coMinimum0 = node['minimum'] === 0;
  let coExclusive0 = node['exclusiveMinimum'] === 0;
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const branches = node[key];
    if (Array.isArray(branches)) {
      for (const branch of branches) {
        if (nhanSoAmKhong(branch)) {
          return true;
        }
        if (laRecord(branch) && branch['exclusiveMinimum'] === 0) {
          coExclusive0 = true;
        }
        if (laRecord(branch) && branch['minimum'] === 0) {
          coMinimum0 = true;
        }
      }
    }
  }
  return coMinimum0 && !coExclusive0;
}

// Đếm số case test đã THỰC SỰ đăng ký, để phát hiện việc đăng ký bị bỏ qua (xanh giả).
let soCaseDaDangKy = 0;

function batAppError(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) {
      return error;
    }
    throw error;
  }
  throw new Error('Mong đợi AppError nhưng không có lỗi nào được ném ra');
}

function kiemKhongONhiem(truoc: string[]): void {
  expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  expect(Object.keys(Object.prototype).sort()).toEqual(truoc);
}

async function goiVoiGiaTri(
  tenTool: string,
  args: Record<string, unknown>,
): Promise<{ payload: Record<string, unknown>; isError: boolean; ms: number }> {
  const dem = taoGhnDem();
  const harness = await taoHarness({ ghn: dem.ghn });
  try {
    const started = performance.now();
    const result = await goiTool(harness.client, tenTool, args);
    const ms = performance.now() - started;
    expect(dem.soLanGoi()).toBe(0);
    return { ...result, ms };
  } finally {
    await harness.close();
  }
}

function kiemBiChan(payload: Record<string, unknown>, isError: boolean): void {
  expect(isError).toBe(true);
  expect(payload['error']).toMatchObject({ code: 'VALIDATION_ERROR' });
  const error = payload['error'] as { issues?: Array<{ message: unknown }> };
  expect(error.issues?.length ?? 0).toBeGreaterThan(0);
}

function mangLongSau(soTang: number): unknown {
  let value: unknown = 'sau';
  for (let i = 0; i < soTang; i += 1) {
    value = [value];
  }
  return value;
}

// 3 test chung (guard) — tính vào tổng số case đã đăng ký.
soCaseDaDangKy += 3;

describe('bộ test bảo mật: registry và số case đã đăng ký', () => {
  it('registry có ít nhất 3 tool và khớp bảng fixture', () => {
    const names = taoRegistry()
      .list()
      .map((tool) => tool.name);

    expect(names.length).toBeGreaterThanOrEqual(3);
    expect(names.length).toBe(Object.keys(TOOL_FIXTURES).length);
  });

  it('mọi tool có trường chuỗi/số đều thực sự có trường để thử; ghn_get_shops chủ ý 0 trường', () => {
    for (const { tool, truong } of TOOLS) {
      const tong = truong.chuoi.length + truong.so.length;
      if (tool.name === 'ghn_get_shops') {
        expect(tong, 'ghn_get_shops không có trường đầu vào (chủ ý)').toBe(0);
      } else {
        expect(
          tong,
          `tool ${tool.name} phải có ít nhất một trường chuỗi/số để thử độc hại`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('số case đã đăng ký đúng bằng số kỳ vọng tính từ JSON Schema', () => {
    // Tính kỳ vọng ĐỘC LẬP với TOOLS: đọc lại schema từ registry, để nếu danh sách trường
    // bị rỗng lúc thu thập (lỗi cũ) thì phép đếm này đỏ.
    let kyVong = 3;
    for (const tool of taoRegistry().list()) {
      const jsonSchema = zodToJsonSchema(tool.inputSchema as ZodTypeAny, {
        $refStrategy: 'none',
      }) as unknown;
      const truong = layTruongTuSchema(jsonSchema);
      kyVong += 6; // 6 test cơ bản
      if (truong.chuoi.length + truong.so.length === 0) {
        kyVong += 1; // test khẳng định "0 trường có chủ ý"
      }
      kyVong += truong.chuoi.length * 7; // 2 cỡ lớn + 5 ca ký tự điều khiển, mỗi trường
      kyVong += truong.so.length * 5; // 4 số cực trị + 1 ca -0, mỗi trường
    }

    expect(soCaseDaDangKy).toBe(kyVong);
  });
});

for (const { tool, fixture, jsonSchema, truong } of TOOLS) {
  describe(`tool ${tool.name}: đầu vào độc hại`, () => {
    const truongChuoi = truong.chuoi;
    const truongSo = truong.so;
    const truongDauTien = truongChuoi[0] ?? truongSo[0] ?? 'khoa_la';

    // SỰ THẬT ĐÃ XÁC MINH (reviewer probe qua client.callTool): khóa own "__proto__" KHÔNG bị
    // SDK chặn; Zod của SDK biến nó thành đổi prototype của object arguments (khóa biến mất),
    // request vẫn tới handler và tool vẫn gọi GHN với dữ liệu sạch; Object.prototype TOÀN CỤC
    // không bị ô nhiễm. Việc có chặn cứng hay không vẫn đang mở.
    soCaseDaDangKy += 1;
    it('khóa own __proto__: tới handler với dữ liệu sạch, không ô nhiễm, GHN gọi đúng 1 lần', async () => {
      const truoc = Object.keys(Object.prototype).sort();
      const args = { ...fixture.validArguments };
      Object.defineProperty(args, '__proto__', {
        value: { polluted: MARKER_PROTO },
        enumerable: true,
        configurable: true,
        writable: true,
      });
      const mock = installMockFetch([{ method: fixture.method, body: fixture.successBody }]);
      const harness = await taoHarness();
      try {
        const { payload } = await goiTool(harness.client, tool.name, args);

        kiemKhongONhiem(truoc);
        expect(mock.calls).toHaveLength(1);
        for (const call of mock.calls) {
          const text = `${call.url} ${JSON.stringify(call.body ?? null)}`;
          expect(text).not.toContain(MARKER_PROTO);
          expect(text).not.toContain('polluted');
        }
        expect(JSON.stringify(payload)).not.toContain(MARKER_PROTO);
        expect(JSON.stringify(payload)).not.toContain('polluted');
        expect(payload['ok']).toBe(true);
      } finally {
        await harness.close();
        mock.restore();
      }
    });

    // SỰ THẬT ĐÃ XÁC MINH: khóa "constructor" làm SDK ném McpError -32603 ở tầng giao thức;
    // handler không chạy nên GHN KHÔNG được gọi. Không bọc try/catch để assertion không bị nuốt.
    soCaseDaDangKy += 1;
    it('khóa constructor: SDK ném -32603 ở tầng giao thức, KHÔNG gọi GHN', async () => {
      const args = { ...fixture.validArguments };
      Object.defineProperty(args, 'constructor', {
        value: { polluted: MARKER_PROTO },
        enumerable: true,
        configurable: true,
        writable: true,
      });
      const dem = taoGhnDem();
      const harness = await taoHarness({ ghn: dem.ghn });
      try {
        await expect(goiTool(harness.client, tool.name, args)).rejects.toMatchObject({
          code: -32603,
        });
        expect(dem.soLanGoi()).toBe(0);
        kiemKhongONhiem(Object.keys(Object.prototype).sort());
      } finally {
        await harness.close();
      }
    });

    // SỰ THẬT ĐÃ XÁC MINH: khóa "prototype" là khóa thường, tới handler và bị inputSchema
    // .strict() từ chối → tool trả VALIDATION_ERROR, GHN không được gọi.
    soCaseDaDangKy += 1;
    it('khóa prototype: tool trả VALIDATION_ERROR (.strict()), KHÔNG gọi GHN', async () => {
      const args = { ...fixture.validArguments };
      Object.defineProperty(args, 'prototype', {
        value: { polluted: MARKER_PROTO },
        enumerable: true,
        configurable: true,
        writable: true,
      });
      const dem = taoGhnDem();
      const harness = await taoHarness({ ghn: dem.ghn });
      try {
        const { payload, isError } = await goiTool(harness.client, tool.name, args);

        kiemBiChan(payload, isError);
        expect(dem.soLanGoi()).toBe(0);
        kiemKhongONhiem(Object.keys(Object.prototype).sort());
      } finally {
        await harness.close();
      }
    });

    if (truongChuoi.length === 0 && truongSo.length === 0) {
      soCaseDaDangKy += 1;
      it('không có trường chuỗi/số (chủ ý): không có ca bơm theo trường', () => {
        expect(truongChuoi.length + truongSo.length).toBe(0);
      });
    }

    const caLon = truongChuoi.flatMap((field) => [1, 10].map((soMB) => ({ field, soMB })));
    soCaseDaDangKy += caLon.length;
    it.each(caLon)(
      'trường $field $soMB MB bị từ chối nhanh, không gọi GHN',
      async ({ field, soMB }) => {
        const { payload, isError, ms } = await goiVoiGiaTri(tool.name, {
          ...fixture.validArguments,
          [field]: 'a'.repeat(soMB * 1024 * 1024),
        });

        kiemBiChan(payload, isError);
        expect(ms, `trường ${field} ${soMB} MB`).toBeLessThan(NGUONG_MS);
      },
    );

    const caDieuKhien = truongChuoi.flatMap((field) =>
      [
        { nhan: 'NUL', giaTri: `${MARKER_DOC_HAI}\u0000` },
        { nhan: 'xuống dòng', giaTri: `${MARKER_DOC_HAI}\nb` },
        // Dùng chuỗi thoát (không chèn ký tự bidi thật vào mã nguồn — tránh cảnh báo GitHub).
        { nhan: 'bidi U+202E', giaTri: `${MARKER_DOC_HAI}\u202Eb` },
        { nhan: 'emoji', giaTri: `${MARKER_DOC_HAI}${'😀'.repeat(1000)}` },
        { nhan: 'unicode dài', giaTri: `${MARKER_DOC_HAI}${'ă'.repeat(100_000)}` },
      ].map((mau) => ({ field, ...mau })),
    );
    soCaseDaDangKy += caDieuKhien.length;
    it.each(caDieuKhien)(
      'chuỗi $nhan ở $field bị từ chối, không lặp marker trong kết quả',
      async ({ field, giaTri }) => {
        const { payload, isError } = await goiVoiGiaTri(tool.name, {
          ...fixture.validArguments,
          [field]: giaTri,
        });

        kiemBiChan(payload, isError);
        expect(JSON.stringify(payload)).not.toContain(MARKER_DOC_HAI);
      },
    );

    const caSoCucTri = truongSo.flatMap((field) =>
      [
        { nhan: '1e308', giaTri: 1e308 },
        { nhan: '-1e308', giaTri: -1e308 },
        { nhan: 'NaN', giaTri: Number.NaN },
        { nhan: 'Infinity', giaTri: Number.POSITIVE_INFINITY },
      ].map((mau) => ({ field, ...mau })),
    );
    soCaseDaDangKy += caSoCucTri.length;
    it.each(caSoCucTri)('số $nhan ở $field bị từ chối', async ({ field, giaTri }) => {
      const { payload, isError } = await goiVoiGiaTri(tool.name, {
        ...fixture.validArguments,
        [field]: giaTri,
      });

      kiemBiChan(payload, isError);
    });

    const caAmKhong = truongSo.map((field) => ({
      field,
      nhanAmKhong: nhanSoAmKhong(layNodeThuocTinh(jsonSchema, field)),
    }));
    soCaseDaDangKy += caAmKhong.length;
    it.each(caAmKhong)('số -0 ở $field (kỳ vọng theo schema)', async ({ field, nhanAmKhong }) => {
      if (!nhanAmKhong) {
        const { payload, isError } = await goiVoiGiaTri(tool.name, {
          ...fixture.validArguments,
          [field]: -0,
        });
        kiemBiChan(payload, isError);
        return;
      }

      // Trường >= 0 (ví dụ insurance_value): -0 hợp lệ và được chuẩn hóa trong payload.
      const mock = installMockFetch([{ method: fixture.method, body: fixture.successBody }]);
      const harness = await taoHarness();
      try {
        const { payload, isError } = await goiTool(harness.client, tool.name, {
          ...fixture.validArguments,
          [field]: -0,
        });

        expect(isError).toBe(false);
        expect(payload['ok']).toBe(true);
        expect(mock.calls).toHaveLength(1);
        const body = mock.calls[0]?.body;
        if (laRecord(body) && field in body) {
          expect(body[field]).toBe(0);
          expect(Object.is(body[field], -0)).toBe(false);
        }
      } finally {
        await harness.close();
        mock.restore();
      }
    });

    soCaseDaDangKy += 1;
    it('mảng lồng 10.000 tầng không tràn stack, bị từ chối', async () => {
      const { payload, isError } = await goiVoiGiaTri(tool.name, {
        ...fixture.validArguments,
        [truongDauTien]: mangLongSau(10_000),
      });

      kiemBiChan(payload, isError);
      kiemKhongONhiem(Object.keys(Object.prototype).sort());
    });

    // Lỗi getter sinh ở phía CLIENT SDK khi đọc arguments (JSON thật không có getter). Phần kiểm
    // thật của server là parseInput trực tiếp: phải thành VALIDATION_ERROR và không lộ message gốc.
    soCaseDaDangKy += 1;
    it('getter ném lỗi: parseInput trực tiếp từ chối gọn, không lộ thông điệp gốc', () => {
      const args = { ...fixture.validArguments };
      Object.defineProperty(args, truongDauTien, {
        get() {
          throw new Error('getter độc hại');
        },
        enumerable: true,
        configurable: true,
      });

      const error = batAppError(() => parseInput(tool.inputSchema, args));
      expect(error.code).toBe('VALIDATION_ERROR');
      const text = `${error.message} ${String(error)} ${error.stack ?? ''} ${
        error.messageVi
      } ${error.messageEn} ${JSON.stringify(error)}`;
      expect(text).not.toContain('getter độc hại');
      kiemKhongONhiem(Object.keys(Object.prototype).sort());
    });

    // Marker trong GIÁ TRỊ khóa lạ (và trong giá trị của trường hợp lệ) không được lặp lại
    // trong thông báo lỗi. Tên khóa lạ có thể được trích dẫn theo thiết kế của validator.
    soCaseDaDangKy += 1;
    it('giá trị chứa marker của khóa lạ/trường hợp lệ không bị lặp lại trong lỗi', async () => {
      const args: Record<string, unknown> = {
        ...fixture.validArguments,
        khoa_la: MARKER_GIA,
      };
      if (truongChuoi[0] !== undefined) {
        args[truongChuoi[0]] = `${MARKER_GIA}!`;
      } else if (truongSo[0] !== undefined) {
        args[truongSo[0]] = MARKER_GIA;
      }

      const { payload, isError } = await goiVoiGiaTri(tool.name, args);

      kiemBiChan(payload, isError);
      // Chỉ kiểm GIÁ TRỊ: giao kèo hiện tại cho phép nêu tên khóa lạ (đã làm sạch).
      expect(JSON.stringify(payload)).not.toContain(MARKER_GIA);
    });
  });
}
