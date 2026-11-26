import { describe, expect, it, vi } from 'vitest';
import { createAppError } from '../../src/core/errors.js';
import type { LogFields } from '../../src/core/types.js';
import { createLogger, logFieldsFromError } from '../../src/utils/logger.js';

const FIXED_TIME = new Date('2026-11-18T03:00:00.000Z');

// Logger dùng `write` giả để bắt dòng log và `now` cố định để test ổn định.
function createTestLogger(level?: 'info' | 'warn' | 'error'): {
  logger: ReturnType<typeof createLogger>;
  lines: string[];
} {
  const lines: string[] = [];
  const logger = createLogger({
    level,
    write: (line) => lines.push(line),
    now: () => FIXED_TIME,
  });
  return { logger, lines };
}

function parseLine(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

describe('createLogger: định dạng', () => {
  it('mỗi lần gọi ghi đúng một dòng JSON có ts ISO và level', () => {
    const { logger, lines } = createTestLogger();

    logger.info({ event: 'tool_call' });
    logger.warn({ event: 'retry' });
    logger.error({ event: 'tool_error' });

    expect(lines).toHaveLength(3);
    const levels = ['info', 'warn', 'error'];
    for (const [index, level] of levels.entries()) {
      const line = lines[index] ?? '';
      expect(line.endsWith('\n')).toBe(true);
      const entry = parseLine(line);
      expect(entry.ts).toBe(FIXED_TIME.toISOString());
      expect(entry.level).toBe(level);
    }
  });

  it('ghi đúng giá trị các trường thuộc allowlist', () => {
    const { logger, lines } = createTestLogger();

    logger.info({
      tool: 'ghn_get_order_detail',
      code: 'GHN_TIMEOUT',
      ms: 312,
      httpStatus: 200,
      requestId: 'req_7f3a9c',
      event: 'tool_call',
    });

    expect(parseLine(lines[0] ?? '')).toEqual({
      ts: FIXED_TIME.toISOString(),
      level: 'info',
      tool: 'ghn_get_order_detail',
      code: 'GHN_TIMEOUT',
      ms: 312,
      httpStatus: 200,
      requestId: 'req_7f3a9c',
      event: 'tool_call',
    });
  });
});

describe('createLogger: allowlist và chống rò rỉ', () => {
  it('không ghi dữ liệu nhạy cảm và đếm đúng số khóa bị bỏ', () => {
    const { logger, lines } = createTestLogger();
    const sentinels = ['TOKEN-GIA-123', '0900000000', '99 Duong Gia, Quan Gia'];

    logger.info({
      token: 'TOKEN-GIA-123',
      Authorization: 'Bearer TOKEN-GIA-123',
      'X-GHN-Token': 'TOKEN-GIA-123',
      shopId: 123,
      phone: '0900000000',
      address: '99 Duong Gia, Quan Gia',
      customer_name: 'khach-gia',
      body: 'TOKEN-GIA-123',
      responseBody: 'TOKEN-GIA-123',
      stack: 'at secret',
      messageEn: 'bi mat',
      messageVi: 'bi mat',
      cause: 'TOKEN-GIA-123',
    });

    const line = lines[0] ?? '';
    for (const sentinel of sentinels) {
      expect(line).not.toContain(sentinel);
    }
    const droppedNames = [
      'token',
      'Authorization',
      'X-GHN-Token',
      'shopId',
      'phone',
      'address',
      'customer_name',
      'body',
      'responseBody',
      'stack',
      'messageEn',
      'messageVi',
      'cause',
    ];
    for (const name of droppedNames) {
      expect(line).not.toContain(name);
    }
    expect(parseLine(line).dropped).toBe(droppedNames.length);
  });

  it('bỏ trường allowlist sai định dạng và không lọt sentinel', () => {
    const { logger, lines } = createTestLogger();

    logger.info({ tool: 'TOKEN-GIA-123 x', requestId: '0900000000 abc', code: 'token=abc' });

    const line = lines[0] ?? '';
    for (const sentinel of ['TOKEN-GIA-123', '0900000000', 'token=abc']) {
      expect(line).not.toContain(sentinel);
    }

    const entry = parseLine(line);
    expect(entry.dropped).toBe(3);
    expect(entry).not.toHaveProperty('tool');
    expect(entry).not.toHaveProperty('requestId');
    expect(entry).not.toHaveProperty('code');
  });

  it('getter trên khóa lạ không bị gọi, khóa lạ vẫn được đếm', () => {
    const { logger, lines } = createTestLogger();
    let calls = 0;
    const fields = Object.defineProperty({ tool: 'ghn_get_fee' }, 'bi-mat', {
      enumerable: true,
      get() {
        calls += 1;
        return 'TOKEN-GIA-123';
      },
    });

    logger.info(fields as unknown as LogFields);

    expect(calls).toBe(0);
    const entry = parseLine(lines[0] ?? '');
    expect(entry.tool).toBe('ghn_get_fee');
    expect(entry.dropped).toBe(1);
    expect(JSON.stringify(entry)).not.toContain('TOKEN-GIA-123');
  });
});

describe('createLogger: mức log', () => {
  it('mức warn bỏ dòng info, giữ warn và error', () => {
    const { logger, lines } = createTestLogger('warn');

    logger.info({ tool: 'ghn_get_fee' });
    logger.warn({ event: 'retry' });
    logger.error({ event: 'tool_error' });

    expect(lines).toHaveLength(2);
    expect(parseLine(lines[0] ?? '').level).toBe('warn');
    expect(parseLine(lines[1] ?? '').level).toBe('error');
  });

  it('mức error chỉ giữ dòng error', () => {
    const { logger, lines } = createTestLogger('error');

    logger.info({ tool: 'ghn_get_fee' });
    logger.warn({ event: 'retry' });
    logger.error({ event: 'tool_error' });

    expect(lines).toHaveLength(1);
    expect(parseLine(lines[0] ?? '').level).toBe('error');
  });

  it.each(['debug', '', null, undefined, 123, 'INFO'])(
    'tài liệu hóa: level không hợp lệ %j được coi như info, không ghi ít hơn mặc định',
    (level) => {
      // Test này KHÔNG phân biệt được với lỗi fail-open cũ vì 'info' là mức thấp nhất:
      // hành vi đúng (coi như info) và lỗi cũ (ghi tất cả) đều ghi đủ 3 dòng.
      const { logger, lines } = createTestLogger(level as never);

      logger.info({ tool: 'ghn_get_fee' });
      logger.warn({ event: 'retry' });
      logger.error({ event: 'tool_error' });

      expect(lines).toHaveLength(3);
    },
  );

  it.each(['toString', '__proto__', 'constructor'])(
    'level %j không ném và được coi như info',
    (level) => {
      const { logger, lines } = createTestLogger(level as never);

      logger.info({ tool: 'ghn_get_fee' });
      logger.warn({ event: 'retry' });
      logger.error({ event: 'tool_error' });

      expect(lines).toHaveLength(3);
    },
  );

  it('level là object có toString ném lỗi: không ném và coi như info', () => {
    const nastyLevel = {
      toString() {
        throw new Error('toString lỗi');
      },
    };

    const { logger, lines } = createTestLogger(nastyLevel as never);
    logger.info({ tool: 'ghn_get_fee' });

    expect(lines).toHaveLength(1);
    expect(parseLine(lines[0] ?? '').level).toBe('info');
  });
});

describe('createLogger: kiểm tra giá trị số', () => {
  it.each([
    { nhan: 'ms âm', value: -1 },
    { nhan: 'ms NaN', value: Number.NaN },
    { nhan: 'ms Infinity', value: Number.POSITIVE_INFINITY },
    { nhan: 'ms -Infinity', value: Number.NEGATIVE_INFINITY },
    { nhan: 'ms chuỗi', value: '5' },
    { nhan: 'ms null', value: null },
  ])('$nhan bị bỏ và tính vào dropped', ({ value }) => {
    const { logger, lines } = createTestLogger();

    logger.info({ ms: value } as unknown as LogFields);

    const entry = parseLine(lines[0] ?? '');
    expect(entry).not.toHaveProperty('ms');
    expect(entry.dropped).toBe(1);
  });

  it.each([0, 1.5, 312])('ms hợp lệ %d được ghi', (value) => {
    const { logger, lines } = createTestLogger();

    logger.info({ ms: value });

    const entry = parseLine(lines[0] ?? '');
    expect(entry.ms).toBe(value);
    expect(entry).not.toHaveProperty('dropped');
  });

  it.each([
    { nhan: 'httpStatus 99', value: 99 },
    { nhan: 'httpStatus 600', value: 600 },
    { nhan: 'httpStatus 200.5', value: 200.5 },
    { nhan: 'httpStatus chuỗi', value: '200' },
    { nhan: 'httpStatus NaN', value: Number.NaN },
  ])('$nhan bị bỏ và tính vào dropped', ({ value }) => {
    const { logger, lines } = createTestLogger();

    logger.info({ httpStatus: value } as unknown as LogFields);

    const entry = parseLine(lines[0] ?? '');
    expect(entry).not.toHaveProperty('httpStatus');
    expect(entry.dropped).toBe(1);
  });

  it.each([100, 200, 404, 599])('httpStatus hợp lệ %d được ghi', (value) => {
    const { logger, lines } = createTestLogger();

    logger.info({ httpStatus: value });

    const entry = parseLine(lines[0] ?? '');
    expect(entry.httpStatus).toBe(value);
    expect(entry).not.toHaveProperty('dropped');
  });
});

describe('createLogger: biên định dạng', () => {
  it.each([
    { nhan: 'tool 64 ký tự', key: 'tool', value: 'a' + 'b'.repeat(63) },
    { nhan: 'code 64 ký tự', key: 'code', value: 'A' + 'B'.repeat(63) },
    { nhan: 'requestId 64 ký tự', key: 'requestId', value: 'r'.repeat(64) },
    { nhan: 'event 32 ký tự', key: 'event', value: 'e' + 'v'.repeat(31) },
  ])('$nhan được ghi', ({ key, value }) => {
    const { logger, lines } = createTestLogger();

    logger.info({ [key]: value });

    const entry = parseLine(lines[0] ?? '');
    expect(entry[key]).toBe(value);
    expect(entry).not.toHaveProperty('dropped');
  });

  it.each([
    { nhan: 'tool 65 ký tự', key: 'tool', value: 'a' + 'b'.repeat(64) },
    { nhan: 'code 65 ký tự', key: 'code', value: 'A' + 'B'.repeat(64) },
    { nhan: 'requestId 65 ký tự', key: 'requestId', value: 'r'.repeat(65) },
    { nhan: 'event 33 ký tự', key: 'event', value: 'e' + 'v'.repeat(32) },
    { nhan: 'tool có chữ hoa', key: 'tool', value: 'Ghn_Tool' },
    { nhan: 'code có chữ thường', key: 'code', value: 'ghn_error' },
    { nhan: 'tool có xuống dòng cuối', key: 'tool', value: 'abc\n' },
    { nhan: 'code có xuống dòng cuối', key: 'code', value: 'ABC\n' },
    { nhan: 'requestId có xuống dòng cuối', key: 'requestId', value: 'abc\n' },
    { nhan: 'event có xuống dòng cuối', key: 'event', value: 'abc\n' },
  ])('$nhan bị bỏ', ({ key, value }) => {
    const { logger, lines } = createTestLogger();

    logger.info({ [key]: value });

    const entry = parseLine(lines[0] ?? '');
    expect(entry).not.toHaveProperty(key);
    expect(entry.dropped).toBe(1);
  });
});

describe('createLogger: độ bền', () => {
  it('không ném với đối tượng vòng, BigInt, getter lỗi, đầu vào lạ hay write lỗi', () => {
    const { logger } = createTestLogger();

    const cyclic: Record<string, unknown> = { tool: 'ghn_get_shops' };
    cyclic['self'] = cyclic;
    expect(() => logger.info(cyclic as unknown as LogFields)).not.toThrow();

    expect(() => logger.info({ ms: 10n } as unknown as LogFields)).not.toThrow();

    const getterFields = Object.defineProperty({}, 'tool', {
      enumerable: true,
      get() {
        throw new Error('getter lỗi');
      },
    });
    expect(() => logger.info(getterFields as unknown as LogFields)).not.toThrow();

    expect(() => logger.info(null as unknown as LogFields)).not.toThrow();
    expect(() => logger.info(undefined as unknown as LogFields)).not.toThrow();
    expect(() => logger.info('chuỗi' as unknown as LogFields)).not.toThrow();

    const throwingWrite = createLogger({
      write: () => {
        throw new Error('write lỗi');
      },
    });
    expect(() => throwingWrite.error({ tool: 'ghn_get_fee' })).not.toThrow();
  });

  it('khóa __proto__/constructor/prototype không ảnh hưởng kết quả', () => {
    const { logger, lines } = createTestLogger();
    const fields = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":"x","prototype":"y","tool":"ghn_get_fee"}',
    ) as LogFields;

    logger.info(fields);

    const line = lines[0] ?? '';
    const entry = parseLine(line);
    expect(entry.tool).toBe('ghn_get_fee');
    expect(entry.dropped).toBe(3);
    expect(line).not.toContain('polluted');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('now ném lỗi: nuốt lỗi và không ghi dòng', () => {
    const lines: string[] = [];
    const logger = createLogger({
      write: (line) => lines.push(line),
      now: () => {
        throw new Error('now lỗi');
      },
    });

    expect(() => logger.info({ tool: 'ghn_get_fee' })).not.toThrow();
    expect(lines).toHaveLength(0);
  });

  it('now trả Invalid Date: nuốt lỗi và không ghi dòng', () => {
    const lines: string[] = [];
    const logger = createLogger({
      write: (line) => lines.push(line),
      now: () => new Date('sai'),
    });

    expect(() => logger.error({ tool: 'ghn_get_fee' })).not.toThrow();
    expect(lines).toHaveLength(0);
  });
});

describe('createLogger: kênh ghi', () => {
  it('không ghi ra stdout', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const { logger } = createTestLogger();
      logger.info({ tool: 'ghn_get_fee' });
      logger.error({ code: 'INTERNAL_ERROR' });

      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('mặc định ghi đúng một dòng JSON ra stderr', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const logger = createLogger({ now: () => FIXED_TIME });
      logger.info({ tool: 'ghn_get_fee' });

      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const line = String(stderrSpy.mock.calls[0]?.[0] ?? '');
      expect(line.endsWith('\n')).toBe(true);
      const entry = parseLine(line);
      expect(entry.level).toBe('info');
      expect(entry.tool).toBe('ghn_get_fee');
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

describe('logFieldsFromError', () => {
  it('chỉ trả mã của AppError', () => {
    const error = createAppError('GHN_TIMEOUT', { ms: 5000 });

    expect(logFieldsFromError(error)).toEqual({ code: 'GHN_TIMEOUT' });
  });

  it('lỗi lạ trả INTERNAL_ERROR và không lộ thông điệp gốc', () => {
    const fields = logFieldsFromError(new Error('TOKEN-GIA-123 bi mat'));

    expect(fields).toEqual({ code: 'INTERNAL_ERROR' });
    expect(JSON.stringify(fields)).not.toContain('TOKEN-GIA-123');
  });

  it('log cùng logger chỉ ghi mã lỗi', () => {
    const { logger, lines } = createTestLogger();
    const error = createAppError('GHN_UNAUTHORIZED');

    logger.error({ ...logFieldsFromError(error), event: 'tool_error', requestId: 'req_1' });

    const entry = parseLine(lines[0] ?? '');
    expect(entry).toMatchObject({
      code: 'GHN_UNAUTHORIZED',
      event: 'tool_error',
      requestId: 'req_1',
    });
    expect(JSON.stringify(entry)).not.toContain('Token GHN hết hạn');
  });
});
