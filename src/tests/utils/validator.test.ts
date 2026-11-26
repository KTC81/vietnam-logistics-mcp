import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../../src/core/errors.js';
import {
  districtIdSchema,
  insuranceValueSchema,
  orderCodeSchema,
  parseInput,
  uuidSchema,
  wardCodeSchema,
  weightGramSchema,
} from '../../src/utils/validator.js';

// Gọi hàm mong đợi ném AppError rồi trả lỗi đó để kiểm tra chi tiết.
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

function messageDauTien(result: { success: boolean }): string {
  // Chỉ dùng sau khi đã biết safeParse thất bại.
  const failed = result as { success: false; error: z.ZodError };
  return failed.error.issues[0]?.message ?? '';
}

describe('orderCodeSchema', () => {
  it.each(['G8A123456', 'A1234', 'a'.repeat(20), ' ABC12 '])(
    'nhận %j và cắt khoảng trắng',
    (value) => {
      const result = orderCodeSchema.safeParse(value);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(value.trim());
      }
    },
  );

  it.each(['', 'ABCD', 'a'.repeat(21), 'G8A-123456', 'G8A 123456', 'G8A_123456'])(
    'từ chối %j',
    (value) => {
      expect(orderCodeSchema.safeParse(value).success).toBe(false);
    },
  );

  it('thông điệp tiếng Việt và không chứa giá trị nhập', () => {
    const result = orderCodeSchema.safeParse('G8A-123456');

    expect(result.success).toBe(false);
    const message = messageDauTien(result);
    expect(message).toContain('chữ và số');
    expect(message).not.toContain('G8A-123456');
  });

  it('từ chối kiểu không phải chuỗi', () => {
    const result = orderCodeSchema.safeParse(123456);

    expect(result.success).toBe(false);
    expect(messageDauTien(result)).toBe('Mã vận đơn phải là chuỗi');
  });
});

describe('uuidSchema', () => {
  const UUID = '3f6c1d2a-9b7e-4c55-8a10-0d2e5b7f9a11';

  it('nhận UUID hợp lệ và cắt khoảng trắng', () => {
    const result = uuidSchema.safeParse(` ${UUID} `);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe(UUID);
    }
  });

  it.each(['', 'khong-phai-uuid', '3f6c1d2a9b7e4c558a100d2e5b7f9a11', 123])(
    'từ chối %j',
    (value) => {
      expect(uuidSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe('districtIdSchema', () => {
  it.each([1, 1442, 1000001])('nhận %d', (value) => {
    expect(districtIdSchema.safeParse(value).success).toBe(true);
  });

  it.each([0, -1, 1.5, 2.0001])('từ chối %d', (value) => {
    expect(districtIdSchema.safeParse(value).success).toBe(false);
  });

  it('từ chối chuỗi số', () => {
    const result = districtIdSchema.safeParse('1442');

    expect(result.success).toBe(false);
    expect(messageDauTien(result)).toBe('Mã quận phải là số');
  });

  it('nhận Number.MAX_SAFE_INTEGER (số an toàn lớn nhất)', () => {
    expect(districtIdSchema.safeParse(Number.MAX_SAFE_INTEGER).success).toBe(true);
  });

  it.each([
    { nhan: '1e21', giaTri: 1e21 },
    { nhan: 'MAX_SAFE_INTEGER + 1', giaTri: Number.MAX_SAFE_INTEGER + 1 },
    { nhan: 'Infinity', giaTri: Number.POSITIVE_INFINITY },
  ])('từ chối số cực lớn ($nhan)', ({ giaTri }) => {
    expect(districtIdSchema.safeParse(giaTri).success).toBe(false);
  });

  it('số vượt giới hạn an toàn báo lỗi tiếng Việt, không chứa giá trị', () => {
    const result = districtIdSchema.safeParse(1e21);

    expect(result.success).toBe(false);
    const message = messageDauTien(result);
    expect(message).toBe('Mã quận quá lớn');
    expect(message).not.toContain('1e+21');
  });
});

describe('wardCodeSchema', () => {
  it.each(['20308', ' 20308 '])('nhận %j và cắt khoảng trắng', (value) => {
    const result = wardCodeSchema.safeParse(value);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe(value.trim());
    }
  });

  it.each(['', 'abc', '20 308', 20308])('từ chối %j', (value) => {
    expect(wardCodeSchema.safeParse(value).success).toBe(false);
  });
});

describe('weightGramSchema', () => {
  it.each([1, 500, 50000])('nhận %d', (value) => {
    expect(weightGramSchema.safeParse(value).success).toBe(true);
  });

  it.each([0, -1, 1.5, '500'])('từ chối %j', (value) => {
    expect(weightGramSchema.safeParse(value).success).toBe(false);
  });

  it('thông điệp cân nặng bằng tiếng Việt', () => {
    const result = weightGramSchema.safeParse(0);

    expect(result.success).toBe(false);
    expect(messageDauTien(result)).toBe('Cân nặng phải lớn hơn 0 (gram)');
  });

  it('nhận Number.MAX_SAFE_INTEGER (chưa có trần cân nặng GHN)', () => {
    expect(weightGramSchema.safeParse(Number.MAX_SAFE_INTEGER).success).toBe(true);
  });

  it.each([
    { nhan: '1e21', giaTri: 1e21 },
    { nhan: 'MAX_SAFE_INTEGER + 1', giaTri: Number.MAX_SAFE_INTEGER + 1 },
    { nhan: 'Infinity', giaTri: Number.POSITIVE_INFINITY },
  ])('từ chối số cực lớn ($nhan)', ({ giaTri }) => {
    expect(weightGramSchema.safeParse(giaTri).success).toBe(false);
  });

  it('số vượt giới hạn an toàn báo "Cân nặng quá lớn", không chứa giá trị', () => {
    const result = weightGramSchema.safeParse(1e21);

    expect(result.success).toBe(false);
    const message = messageDauTien(result);
    expect(message).toBe('Cân nặng quá lớn');
    expect(message).not.toContain('1e+21');
  });
});

describe('insuranceValueSchema', () => {
  it.each([0, 1, 350000])('nhận %d', (value) => {
    expect(insuranceValueSchema.safeParse(value).success).toBe(true);
  });

  it.each([-1, 1.5, '0'])('từ chối %j', (value) => {
    expect(insuranceValueSchema.safeParse(value).success).toBe(false);
  });

  it('mặc định 0 khi bỏ trống', () => {
    const result = insuranceValueSchema.safeParse(undefined);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe(0);
    }
  });

  it('nhận đúng mức trần bảo hiểm 50.000.000 VND', () => {
    expect(insuranceValueSchema.safeParse(50_000_000).success).toBe(true);
  });

  it.each([
    { nhan: 'vượt trần 1 VND', giaTri: 50_000_001 },
    { nhan: '1e21', giaTri: 1e21 },
    { nhan: '1e30', giaTri: 1e30 },
    { nhan: 'MAX_SAFE_INTEGER + 1', giaTri: Number.MAX_SAFE_INTEGER + 1 },
    { nhan: 'MAX_SAFE_INTEGER', giaTri: Number.MAX_SAFE_INTEGER },
    { nhan: 'Infinity', giaTri: Number.POSITIVE_INFINITY },
  ])('từ chối giá trị cực lớn ($nhan)', ({ giaTri }) => {
    expect(insuranceValueSchema.safeParse(giaTri).success).toBe(false);
  });

  it('vượt trần báo lỗi tiếng Việt, không chứa giá trị nhập', () => {
    const result = insuranceValueSchema.safeParse(50_000_001);

    expect(result.success).toBe(false);
    const message = messageDauTien(result);
    expect(message).toBe('Giá trị bảo hiểm không được vượt quá 50000000 VND');
    expect(message).not.toContain('50000001');
  });
});

describe('parseInput: thành công', () => {
  it('trả dữ liệu đã chuẩn hoá', () => {
    const schema = z.object({ order_code: orderCodeSchema, weight: weightGramSchema });

    const data = parseInput(schema, { order_code: ' G8A123456 ', weight: 500 });

    expect(data).toEqual({ order_code: 'G8A123456', weight: 500 });
  });

  it('không tự ép .strict(): khóa lạ bị bỏ qua nếu schema không strict', () => {
    const schema = z.object({ weight: weightGramSchema });

    expect(parseInput(schema, { weight: 500, token: 'TOKEN-GIA-123' })).toEqual({ weight: 500 });
  });
});

describe('parseInput: thất bại', () => {
  it('ném AppError VALIDATION_ERROR đúng issues, messageVi và retryable', () => {
    const schema = z.object({ order_code: orderCodeSchema, weight: weightGramSchema });

    const error = batAppError(() => parseInput(schema, { order_code: '', weight: 0 }));

    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.retryable).toBe(false);
    // Zod báo cả hai check của chuỗi rỗng (min và regex); mỗi lỗi Zod thành một issue.
    expect(error.issues).toEqual([
      { field: 'order_code', message: 'Mã vận đơn phải có ít nhất 5 ký tự' },
      { field: 'order_code', message: 'Mã vận đơn chỉ gồm chữ và số' },
      { field: 'weight', message: 'Cân nặng phải lớn hơn 0 (gram)' },
    ]);
    expect(error.messageVi).toBe(
      'Dữ liệu nhập chưa đúng: order_code: Mã vận đơn phải có ít nhất 5 ký tự. Vui lòng sửa rồi thử lại.',
    );
    expect(error.messageEn).toBe('Input validation failed: order_code, weight');
  });

  it('không lộ giá trị nhập trong issues/messageVi/messageEn', () => {
    const sentinel1 = 'TOKEN-GIA-123';
    const sentinel2 = '0900000000';
    const schema = z
      .object({
        weight: weightGramSchema,
        order_code: orderCodeSchema,
        kind: z.enum(['a', 'b']),
      })
      .strict();

    const error = batAppError(() =>
      parseInput(schema, {
        weight: sentinel1,
        order_code: `${sentinel2} x`,
        kind: sentinel1,
        token: sentinel2,
      }),
    );

    const text = `${JSON.stringify(error.issues)} ${error.messageVi} ${error.messageEn}`;
    expect(text).not.toContain(sentinel1);
    expect(text).not.toContain(sentinel2);
  });

  it('khóa lạ: nêu tên khóa, không kèm giá trị', () => {
    const schema = z.object({ weight: weightGramSchema }).strict();

    const error = batAppError(() => parseInput(schema, { weight: 500, token: 'TOKEN-GIA-123' }));

    expect(error.issues).toEqual([
      { field: '(đầu vào)', message: 'Có trường không được phép: "token"' },
    ]);
    expect(error.messageVi).not.toContain('TOKEN-GIA-123');
  });

  it('enum sai dùng thông báo chung, không lộ giá trị', () => {
    const schema = z.object({ level: z.enum(['province', 'district', 'ward']) });

    const error = batAppError(() => parseInput(schema, { level: 'TOKEN-GIA-123' }));

    expect(error.issues?.[0]?.message).toBe('Giá trị không nằm trong danh sách cho phép');
    expect(JSON.stringify(error.issues)).not.toContain('TOKEN-GIA-123');
  });

  it('cắt issues tối đa 10', () => {
    const schema = z.object({ items: z.array(z.number()) });
    const input = { items: Array.from({ length: 15 }, () => 'sai') };

    const error = batAppError(() => parseInput(schema, input));

    expect(error.issues).toHaveLength(10);
    expect(error.issues?.[0]?.field).toBe('items.0');
    expect(error.issues?.[9]?.field).toBe('items.9');
  });

  it('field lồng nhau dạng a.b.0.c', () => {
    const schema = z.object({
      a: z.object({ b: z.array(z.object({ c: z.number() })) }),
    });

    const error = batAppError(() => parseInput(schema, { a: { b: [{ c: 'sai' }] } }));

    expect(error.issues?.[0]?.field).toBe('a.b.0.c');
  });

  it.each([
    { nhan: 'undefined', input: undefined },
    { nhan: 'null', input: null },
    { nhan: 'mảng', input: [] },
    { nhan: 'số', input: 42 },
    { nhan: 'chuỗi', input: 'sai' },
  ])('đầu vào $nhan ném VALIDATION_ERROR, không crash', ({ input }) => {
    const error = batAppError(() => parseInput(z.object({ weight: weightGramSchema }), input));

    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.retryable).toBe(false);
    expect(error.messageVi).toContain('(đầu vào)');
  });

  it('schema/transform ném lỗi vẫn quy về VALIDATION_ERROR', () => {
    const schema = z.string().transform(() => {
      throw new Error('bùm');
    });

    const error = batAppError(() => parseInput(schema, 'x'));

    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.messageVi).not.toContain('bùm');
  });
});

describe('parseInput: thông điệp không bị hai dấu chấm', () => {
  it.each([
    { nhan: 'sai kiểu', schema: z.object({ x: z.number() }), input: { x: 'sai' } },
    { nhan: 'quá nhỏ', schema: z.object({ x: z.number().min(10) }), input: { x: 1 } },
    { nhan: 'quá lớn', schema: z.object({ x: z.number().max(1) }), input: { x: 5 } },
    { nhan: 'định dạng', schema: z.object({ x: z.string().email() }), input: { x: 'sai' } },
    { nhan: 'khóa lạ', schema: z.object({ x: z.number() }).strict(), input: { x: 1, y: 2 } },
    { nhan: 'mặc định', schema: z.object({ x: z.literal('a') }), input: { x: 'b' } },
  ])('$nhan: messageVi không có ".." và kết thúc đúng mẫu', ({ schema, input }) => {
    const error = batAppError(() => parseInput(schema, input));

    expect(error.messageVi).not.toContain('..');
    expect(error.messageVi.endsWith(' Vui lòng sửa rồi thử lại.')).toBe(true);
  });
});

describe('parseInput: làm sạch tên khóa do người dùng đặt', () => {
  const schemaCoWeight = z.object({ weight: weightGramSchema }).strict();

  it('khóa lạ có khoảng trắng/tiếng Việt/tên dài được làm sạch và cắt', () => {
    const spaceKey = 'TOKEN-GIA-123 0900000000';
    const longKey = 'x'.repeat(200);
    const vietnameseKey = '99 Duong Gia, Quan Gia';

    const error = batAppError(() =>
      parseInput(schemaCoWeight, {
        weight: 500,
        [spaceKey]: 1,
        [longKey]: 2,
        [vietnameseKey]: 3,
      }),
    );

    const text = `${JSON.stringify(error.issues)} ${error.messageVi} ${error.messageEn}`;
    expect(text).not.toContain(spaceKey);
    expect(text).not.toContain(longKey);
    expect(text).not.toContain(vietnameseKey);

    const message = error.issues?.[0]?.message ?? '';
    expect(message).toContain('…');
    const listed = message
      .replace('Có trường không được phép: ', '')
      .split(', ')
      .map((name) => name.replace(/^"|"$/g, ''));
    expect(listed).toHaveLength(3);
    for (const name of listed) {
      expect(name.length).toBeLessThanOrEqual(40);
      expect(name).not.toMatch(/\s/);
    }
  });

  it('khóa tên {fields}/{trường} không phá mẫu thông báo', () => {
    const error = batAppError(() =>
      parseInput(schemaCoWeight, { weight: 500, '{fields}': 1, '{trường}': 2 }),
    );

    expect(error.issues?.[0]?.message).toBe('Có trường không được phép: "?fields?", "?tr??ng?"');
    expect(error.messageVi).not.toContain('{');
    expect(error.messageEn).not.toContain('{');
  });

  it('8 khóa lạ chỉ liệt kê 5 khóa và số còn lại', () => {
    const keys = Array.from({ length: 8 }, (_, index) => `khoa_la_${index}`);
    const input: Record<string, unknown> = { weight: 500 };
    for (const key of keys) {
      input[key] = 1;
    }

    const error = batAppError(() => parseInput(schemaCoWeight, input));

    expect(error.issues?.[0]?.message).toBe(
      'Có trường không được phép: "khoa_la_0", "khoa_la_1", "khoa_la_2", "khoa_la_3", "khoa_la_4" và 3 khóa khác',
    );
  });

  it('field từ z.record được làm sạch và cắt', () => {
    const shortKey = 'TOKEN-GIA-123 0900000000';
    const longKey = 'y'.repeat(200);
    const schema = z.record(z.number());

    const error = batAppError(() => parseInput(schema, { [shortKey]: 'sai', [longKey]: 'sai' }));

    const fields = error.issues?.map((issue) => issue.field) ?? [];
    expect(fields[0]).toBe('TOKEN-GIA-123?0900000000');
    expect(fields[0]).not.toContain(' ');
    expect(fields[1]).toHaveLength(40);
    expect(fields[1]?.endsWith('…')).toBe(true);
    expect(error.messageVi).not.toContain(shortKey);
    expect(error.messageVi).not.toContain(longKey);
    expect(error.messageEn).not.toContain(shortKey);
    expect(error.messageEn).not.toContain(longKey);
  });

  it('khóa lạ Unicode/emoji được làm sạch, cắt và không lộ nguyên văn', () => {
    const vietnameseKey = 'Địa chỉ nhà khách';
    const emojiKey = '😀'.repeat(30);

    const error = batAppError(() =>
      parseInput(schemaCoWeight, { weight: 500, [vietnameseKey]: 1, [emojiKey]: 2 }),
    );

    const message = error.issues?.[0]?.message ?? '';
    expect(message).not.toContain(vietnameseKey);
    expect(message).not.toContain(emojiKey);
    expect(message).toContain('…');

    const listed = message
      .replace('Có trường không được phép: ', '')
      .split(', ')
      .map((name) => name.replace(/^"|"$/g, ''));
    expect(listed).toHaveLength(2);
    for (const name of listed) {
      expect(name.length).toBeLessThanOrEqual(40);
      expect(name).toMatch(/^[A-Za-z0-9_.?…-]*$/);
    }
  });

  it('khóa số dạng chuỗi giữ nguyên trong field', () => {
    const schema = z.record(z.number());

    const error = batAppError(() => parseInput(schema, { '123': 'sai' }));

    expect(error.issues?.[0]?.field).toBe('123');
  });

  it('khóa rỗng dùng nhãn (rỗng), không hở khoảng trống cạnh dấu hai chấm', () => {
    const schema = z.object({ a: z.number() }).strict();

    const error = batAppError(() => parseInput(schema, { a: 1, '': 1 }));

    expect(error.issues).toEqual([
      { field: '(đầu vào)', message: 'Có trường không được phép: "(rỗng)"' },
    ]);
    expect(error.messageVi).toContain('(rỗng)');
    expect(error.messageVi).not.toContain(': .');
  });

  it("path [''] (z.record) cho field (rỗng)", () => {
    const schema = z.record(z.number());

    const error = batAppError(() => parseInput(schema, { '': 'sai' }));

    expect(error.issues?.[0]?.field).toBe('(rỗng)');
    expect(error.messageVi).toContain('(rỗng)');
    expect(error.messageVi).not.toContain(': .');
  });

  it.each(['abc.', '...', 'a..', '.'])('khóa lạ %j giữ nguyên dấu chấm trong nháy', (key) => {
    const schema = z.object({ a: z.number() }).strict();

    const error = batAppError(() => parseInput(schema, { a: 1, [key]: 1 }));

    const expectedMessage = `Có trường không được phép: "${key}"`;
    expect(error.issues).toEqual([{ field: '(đầu vào)', message: expectedMessage }]);
    expect(error.messageVi).toBe(
      `Dữ liệu nhập chưa đúng: (đầu vào): ${expectedMessage}. Vui lòng sửa rồi thử lại.`,
    );
    expect(error.messageVi).not.toContain(': .');

    // Chỉ cho phép '..' nằm trong tên khóa (trong nháy); chỗ nối với mẫu không được thành '..'.
    const ngoaiNhay = error.messageVi.replace(/"[^"]*"/g, '""');
    expect(ngoaiNhay).not.toContain('..');
  });
});

describe('parseInput: message của schema tự đặt', () => {
  it.each(['Sai rồi.', '... ', 'Quá ngắn...'])('cắt dấu chấm cuối của %j', (message) => {
    const schema = z.object({ x: z.number() }).refine(() => false, { message });

    const error = batAppError(() => parseInput(schema, { x: 1 }));

    expect(error.messageVi).not.toContain('..');
    expect(error.issues?.[0]?.message?.endsWith('.')).toBe(false);
    expect(error.messageVi.endsWith(' Vui lòng sửa rồi thử lại.')).toBe(true);
  });

  it('giữ dấu chấm ở giữa message', () => {
    const schema = z
      .object({ x: z.number() })
      .refine(() => false, { message: 'Giá trị a.b không hợp lệ' });

    const error = batAppError(() => parseInput(schema, { x: 1 }));

    expect(error.issues?.[0]?.message).toBe('Giá trị a.b không hợp lệ');
    expect(error.messageVi).toContain('Giá trị a.b không hợp lệ');
  });

  it('message 100.000 dấu chấm + x xử lý dưới 500 ms (tuyến tính)', () => {
    const schema = z.number().refine(() => false, { message: `${'.'.repeat(100_000)}x` });

    const start = performance.now();
    const error = batAppError(() => parseInput(schema, 1));
    const elapsed = performance.now() - start;

    expect(error.code).toBe('VALIDATION_ERROR');
    expect(elapsed).toBeLessThan(500);
  });

  it('message 100.000 dấu chấm xử lý dưới 500 ms và dùng câu chung', () => {
    const schema = z.number().refine(() => false, { message: '.'.repeat(100_000) });

    const start = performance.now();
    const error = batAppError(() => parseInput(schema, 1));
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(500);
    expect(error.issues?.[0]?.message).toBe('Dữ liệu nhập chưa hợp lệ');
  });

  it('cắt message schema dài còn 200 ký tự kèm …', () => {
    const schema = z.number().refine(() => false, { message: 'a'.repeat(300) });

    const error = batAppError(() => parseInput(schema, 1));

    const normalized = error.issues?.[0]?.message ?? '';
    expect(normalized).toHaveLength(200);
    expect(normalized.endsWith('…')).toBe(true);
    expect(error.messageVi).not.toContain('..');
  });
});

describe('parseInput: khóa lồng nhau', () => {
  it('khóa rỗng ở cấp hai cho field a.(rỗng)', () => {
    const schema = z.object({ a: z.object({ '': z.number() }).strict() });

    const error = batAppError(() => parseInput(schema, { a: { '': 'sai' } }));

    expect(error.issues?.[0]?.field).toBe('a.(rỗng)');
  });

  it('khóa Unicode/emoji ở cấp hai được làm sạch theo TỪNG đoạn', () => {
    const key = `${'Địa chỉ '.repeat(10)}${'😀'.repeat(20)}`;
    const schema = z.object({ a: z.record(z.number()) });

    const error = batAppError(() => parseInput(schema, { a: { [key]: 'sai' } }));

    const field = error.issues?.[0]?.field ?? '';
    const segments = field.split('.');
    expect(segments[0]).toBe('a');
    const name = segments[1] ?? '';
    // Cắt 40 ký tự áp dụng cho TỪNG đoạn đường dẫn, không phải cả đường dẫn.
    expect(name.length).toBeLessThanOrEqual(40);
    expect(name.endsWith('…')).toBe(true);
    expect(name).toMatch(/^[A-Za-z0-9_.?…-]*$/);
    expect(field).not.toContain(key);
  });

  it('chỉ số mảng lồng items.2.name giữ nguyên số', () => {
    const schema = z.object({ items: z.array(z.object({ name: z.string() })) });
    const input = { items: [{ name: 'ok' }, { name: 'ok' }, { name: 123 }] };

    const error = batAppError(() => parseInput(schema, input));

    expect(error.issues?.[0]?.field).toBe('items.2.name');
  });
});
