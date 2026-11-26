import { inspect } from 'node:util';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { AppConfig, loadConfig } from '../../src/config/env.js';
import { AppError } from '../../src/core/errors.js';
import { createGhnClient } from '../../src/services/ghn-client.js';
import { TOKEN_GIA_SECRET } from '../helpers/security-fixtures.js';
import { installMockFetch } from '../helpers/mock-fetch.js';

const CONFIG = new AppConfig({
  ghnToken: TOKEN_GIA_SECRET,
  shopId: 999999,
  ghnEnv: 'staging',
  logLevel: 'info',
});

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

// Mọi cách đọc một AppError mà người dùng/log có thể thấy; không được chứa giá trị nhập.
function moiBieuDienLoi(error: AppError): string {
  return [
    error.message,
    String(error),
    error.stack ?? '',
    error.cause === undefined ? '' : String(error.cause),
    error.messageVi,
    error.messageEn,
    JSON.stringify(error),
  ].join('\n');
}

describe('AppConfig không lộ token', () => {
  it('JSON.stringify/String/inspect/spread/Object.keys/entries/values đều không lộ', () => {
    const bieuDien = [
      JSON.stringify(CONFIG),
      String(CONFIG),
      inspect(CONFIG, { depth: 5 }),
      JSON.stringify(Object.keys(CONFIG)),
      JSON.stringify(Object.values(CONFIG)),
      JSON.stringify(Object.entries(CONFIG)),
      JSON.stringify({ ...CONFIG }),
    ];

    for (const text of bieuDien) {
      expect(text).not.toContain(TOKEN_GIA_SECRET);
    }
    expect(JSON.parse(JSON.stringify(CONFIG))).toEqual({
      ghnToken: '[đã ẩn]',
      shopId: 999999,
      ghnEnv: 'staging',
      logLevel: 'info',
    });
  });

  it('console.log(config) không chứa token; spy thực sự bắt được lời gọi', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      console.log(CONFIG);

      // Spy phải hoạt động, nếu không phép thử sẽ xanh giả.
      expect(logSpy.mock.calls.length).toBeGreaterThan(0);
      const noiDung = logSpy.mock.calls
        .flat()
        .map((value) => (typeof value === 'string' ? value : inspect(value, { depth: 5 })))
        .join(' ');
      expect(noiDung).not.toContain(TOKEN_GIA_SECRET);
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('loadConfig: lỗi không chứa giá trị đã nhập', () => {
  it('thiếu GHN_TOKEN: CONFIG_MISSING chỉ nêu tên biến', () => {
    const error = batAppError(() => loadConfig({}));

    expect(error.code).toBe('CONFIG_MISSING');
    expect(error.messageVi).toContain('GHN_TOKEN');
    expect(moiBieuDienLoi(error)).not.toContain(TOKEN_GIA_SECRET);
  });

  it.each([
    'GIA-SHOP-ID-SAI-123456789',
    'GIA-SHOP-ID-AM-987654321',
    'GIA-SHOP-ID-QUA-DAI-123456789012345678901234567890',
  ])('GHN_SHOP_ID sai (%s) không lộ giá trị', (value) => {
    const error = batAppError(() =>
      loadConfig({ GHN_TOKEN: TOKEN_GIA_SECRET, GHN_SHOP_ID: value }),
    );

    expect(error.code).toBe('VALIDATION_ERROR');
    const text = moiBieuDienLoi(error);
    expect(text).not.toContain(value);
    expect(text).not.toContain(TOKEN_GIA_SECRET);
  });

  it('GHN_ENV sai không lộ giá trị', () => {
    const giaTriSai = 'GIA-ENV-SAI-123456789';

    const error = batAppError(() =>
      loadConfig({ GHN_TOKEN: TOKEN_GIA_SECRET, GHN_ENV: giaTriSai }),
    );

    expect(error.code).toBe('VALIDATION_ERROR');
    expect(moiBieuDienLoi(error)).not.toContain(giaTriSai);
    expect(moiBieuDienLoi(error)).not.toContain(TOKEN_GIA_SECRET);
  });
});

describe('token sai định dạng bị client chặn, không lộ giá trị', () => {
  it('token chứa khoảng trắng → CONFIG_MISSING, không gọi mạng', async () => {
    const tokenSai = `GIA-TOKEN-SAI-123456789 ${TOKEN_GIA_SECRET}`;
    const mock = installMockFetch([]);
    const ghn = createGhnClient({
      credentials: {
        async getCredentials() {
          return { token: tokenSai, env: 'staging' };
        },
      },
    });

    let error: AppError | undefined;
    try {
      await ghn.request('/v2/shop/all', {}, z.object({}));
    } catch (caught) {
      if (caught instanceof AppError) {
        error = caught;
      } else {
        throw caught;
      }
    }

    expect(error?.code).toBe('CONFIG_MISSING');
    expect(error?.messageVi).toContain('GHN_TOKEN');
    if (error === undefined) {
      throw new Error('Mong đợi AppError nhưng không có lỗi nào');
    }
    const text = moiBieuDienLoi(error);
    expect(text).not.toContain(tokenSai);
    expect(text).not.toContain(TOKEN_GIA_SECRET);
    expect(mock.calls).toHaveLength(0);
  });
});
