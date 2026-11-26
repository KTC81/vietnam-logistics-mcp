import { format, inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors.js';
import {
  EnvCredentialProvider,
  getBaseUrl,
  loadConfig,
  resolveShopId,
} from '../../src/config/env.js';

// Token giả dùng trong test; không phải token thật.
const TOKEN_GIA = 'token-gia-khong-dung-that';

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

describe('loadConfig', () => {
  it('đủ biến thì trả cấu hình đã kiểm tra, cắt khoảng trắng ở token', () => {
    const config = loadConfig({
      GHN_TOKEN: `  ${TOKEN_GIA}  `,
      GHN_SHOP_ID: '1000001',
      GHN_ENV: 'staging',
    });

    expect(config.getGhnToken()).toBe(TOKEN_GIA);
    expect(resolveShopId(config)).toBe(1000001);
    expect(config.ghnEnv).toBe('staging');
  });

  it('thiếu GHN_TOKEN thì CONFIG_MISSING, thông báo nêu tên biến', () => {
    const error = batAppError(() => loadConfig({}));

    expect(error.code).toBe('CONFIG_MISSING');
    expect(error.messageVi).toBe(
      'Thiếu cấu hình GHN_TOKEN. Hãy điền trong cấu hình AI client rồi khởi động lại.',
    );
  });

  it('GHN_TOKEN rỗng hoặc toàn khoảng trắng cũng bị coi là thiếu', () => {
    expect(batAppError(() => loadConfig({ GHN_TOKEN: '' })).code).toBe('CONFIG_MISSING');
    expect(batAppError(() => loadConfig({ GHN_TOKEN: '   ' })).code).toBe('CONFIG_MISSING');
  });

  it('GHN_SHOP_ID bỏ trống vẫn qua và resolveShopId trả undefined', () => {
    const config = loadConfig({ GHN_TOKEN: TOKEN_GIA, GHN_SHOP_ID: '   ' });

    expect(resolveShopId(config)).toBeUndefined();
  });

  it('thiếu ShopId hẳn cũng qua', () => {
    expect(resolveShopId(loadConfig({ GHN_TOKEN: TOKEN_GIA }))).toBeUndefined();
  });

  it.each(['abc', '0', '-5', '1.5', '1 000'])(
    'GHN_SHOP_ID không phải số nguyên dương (%s) thì VALIDATION_ERROR, không lộ giá trị',
    (value) => {
      const error = batAppError(() => loadConfig({ GHN_TOKEN: TOKEN_GIA, GHN_SHOP_ID: value }));

      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.issues).toEqual([{ field: 'GHN_SHOP_ID', message: 'phải là số nguyên dương' }]);
      expect(error.messageVi).toContain('GHN_SHOP_ID');
      expect(error.messageVi).not.toContain(value);
    },
  );

  it.each([
    { nhan: '30 chữ số 9', value: '9'.repeat(30) },
    { nhan: '400 chữ số 9', value: '9'.repeat(400) },
    { nhan: '9007199254740993 (lớn hơn 2^53 - 1)', value: '9007199254740993' },
  ])('GHN_SHOP_ID $nhan bị từ chối vì vượt giới hạn an toàn, không lộ giá trị', ({ value }) => {
    const error = batAppError(() => loadConfig({ GHN_TOKEN: TOKEN_GIA, GHN_SHOP_ID: value }));

    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.issues?.map((item) => item.field)).toEqual(['GHN_SHOP_ID']);
    expect(error.messageVi).toContain('GHN_SHOP_ID');
    expect(error.messageVi).not.toContain(value);
  });

  it('GHN_ENV ngoài hai giá trị hợp lệ thì lỗi nêu rõ hai giá trị đúng', () => {
    const error = batAppError(() => loadConfig({ GHN_TOKEN: TOKEN_GIA, GHN_ENV: 'ghn-prod' }));

    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.issues).toEqual([
      { field: 'GHN_ENV', message: "phải là 'production' hoặc 'staging'" },
    ]);
    expect(error.messageVi).toContain('production');
    expect(error.messageVi).toContain('staging');
    expect(error.messageVi).not.toContain('ghn-prod');
  });

  it('GHN_ENV bỏ trống hoặc không khai báo thì mặc định production', () => {
    expect(loadConfig({ GHN_TOKEN: TOKEN_GIA }).ghnEnv).toBe('production');
    expect(loadConfig({ GHN_TOKEN: TOKEN_GIA, GHN_ENV: '  ' }).ghnEnv).toBe('production');
  });

  it('liệt kê đủ biến sai định dạng trong một lỗi', () => {
    const error = batAppError(() =>
      loadConfig({ GHN_TOKEN: TOKEN_GIA, GHN_SHOP_ID: 'abc', GHN_ENV: 'ghn-prod' }),
    );

    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.issues).toEqual([
      { field: 'GHN_SHOP_ID', message: 'phải là số nguyên dương' },
      { field: 'GHN_ENV', message: "phải là 'production' hoặc 'staging'" },
    ]);
    expect(error.messageVi).toContain('GHN_SHOP_ID, GHN_ENV');
  });

  it('thiếu biến bắt buộc được báo trước lỗi định dạng', () => {
    const error = batAppError(() => loadConfig({ GHN_ENV: 'ghn-prod' }));

    expect(error.code).toBe('CONFIG_MISSING');
  });

  it('thông báo lỗi không chứa giá trị token đã nhập', () => {
    const error = batAppError(() => loadConfig({ GHN_TOKEN: TOKEN_GIA, GHN_ENV: 'ghn-prod' }));

    expect(error.messageVi).not.toContain(TOKEN_GIA);
    expect(error.messageEn).not.toContain(TOKEN_GIA);
  });
});

describe('cấu hình an toàn khi in', () => {
  it('JSON.stringify và String không lộ token', () => {
    const config = loadConfig({
      GHN_TOKEN: TOKEN_GIA,
      GHN_SHOP_ID: '1000001',
      GHN_ENV: 'staging',
    });

    expect(JSON.stringify(config)).not.toContain(TOKEN_GIA);
    expect(String(config)).not.toContain(TOKEN_GIA);
    expect(JSON.stringify(config)).toContain('[đã ẩn]');
    expect(JSON.stringify(config)).toContain('1000001');
    expect(JSON.stringify(config)).toContain('staging');
  });

  it('util.inspect, util.format, spread và liệt kê thuộc tính không lộ token', () => {
    // Token giả đặc trưng để chắc chắn mọi đầu ra đều không chứa nó.
    const token = 'sentinel-token-gia';
    const config = loadConfig({ GHN_TOKEN: token, GHN_SHOP_ID: '1000001' });

    const outputs = [
      inspect(config, { showHidden: true }),
      format('%o %j', config, config),
      JSON.stringify({ ...config }),
      Object.keys(config).join(','),
      Object.getOwnPropertyNames(config).join(','),
      Object.entries(config)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(','),
    ];

    for (const output of outputs) {
      expect(output).not.toContain(token);
    }
  });
});

describe('getBaseUrl', () => {
  it('trả host đúng cho hai môi trường', () => {
    expect(getBaseUrl('production')).toBe('https://online-gateway.ghn.vn/shiip/public-api');
    expect(getBaseUrl('staging')).toBe('https://dev-online-gateway.ghn.vn/shiip/public-api');
  });
});

describe('EnvCredentialProvider', () => {
  it('trả credentials từ cấu hình đã nạp', async () => {
    const config = loadConfig({
      GHN_TOKEN: TOKEN_GIA,
      GHN_SHOP_ID: '1000001',
      GHN_ENV: 'staging',
    });

    const credentials = await new EnvCredentialProvider(config).getCredentials();

    expect(credentials).toEqual({ token: TOKEN_GIA, shopId: 1000001, env: 'staging' });
  });

  it('không có ShopId thì credentials không có shopId', async () => {
    const config = loadConfig({ GHN_TOKEN: TOKEN_GIA });

    const credentials = await new EnvCredentialProvider(config).getCredentials();

    expect(credentials.token).toBe(TOKEN_GIA);
    expect(credentials.shopId).toBeUndefined();
  });
});

describe('LOG_LEVEL', () => {
  it('bỏ trống hoặc không khai báo thì mặc định info', () => {
    expect(loadConfig({ GHN_TOKEN: TOKEN_GIA }).logLevel).toBe('info');
    expect(loadConfig({ GHN_TOKEN: TOKEN_GIA, LOG_LEVEL: '   ' }).logLevel).toBe('info');
  });

  it.each(['info', 'warn', 'error'])('nhận giá trị %s', (level) => {
    expect(loadConfig({ GHN_TOKEN: TOKEN_GIA, LOG_LEVEL: level }).logLevel).toBe(level);
  });

  it.each(['debug', 'verbose', 'INFO'])('giá trị lạ %j coi như info, không ném lỗi', (level) => {
    expect(loadConfig({ GHN_TOKEN: TOKEN_GIA, LOG_LEVEL: level }).logLevel).toBe('info');
  });

  it('giá trị lạ không làm hỏng các biến khác', () => {
    const config = loadConfig({
      GHN_TOKEN: TOKEN_GIA,
      GHN_SHOP_ID: '1000001',
      LOG_LEVEL: 'debug',
    });

    expect(config.logLevel).toBe('info');
    expect(resolveShopId(config)).toBe(1000001);
  });

  it('cấu hình in ra có logLevel, vẫn che token', () => {
    const json = JSON.stringify(loadConfig({ GHN_TOKEN: TOKEN_GIA, LOG_LEVEL: 'warn' }));

    expect(json).toContain('"logLevel":"warn"');
    expect(json).not.toContain(TOKEN_GIA);
  });
});
