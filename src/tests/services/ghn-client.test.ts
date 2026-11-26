import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { getBaseUrl } from '../../src/config/env.js';
import { AppError, createAppError, toToolErrorResult } from '../../src/core/errors.js';
import type {
  CredentialProvider,
  GhnCredentials,
  LogFields,
  ToolLogger,
} from '../../src/core/types.js';
import { createGhnClient, type GhnClientOptions } from '../../src/services/ghn-client.js';
import { createLogger } from '../../src/utils/logger.js';
import { installMockFetch } from '../helpers/mock-fetch.js';

const TOKEN_GIA = 'TOKEN-GIA-123';
const SHOP_ID = 999999;
const PROD = getBaseUrl('production');
const STAGING = getBaseUrl('staging');
const DETAIL_URL = `${PROD}/v2/shipping-order/detail`;
const FEE_URL = `${PROD}/v2/shipping-order/fee`;

const detailSchema = z.object({ order_code: z.string(), status: z.string() });
const feeSchema = z.object({ total: z.number() });
const shopsSchema = z.object({ shops: z.array(z.unknown()) });

function okBody(data: unknown): Record<string, unknown> {
  return { code: 200, data };
}

function taoProvider(overrides: Partial<GhnCredentials> = {}): CredentialProvider {
  return {
    async getCredentials() {
      return { token: TOKEN_GIA, shopId: SHOP_ID, env: 'production', ...overrides };
    },
  };
}

function taoClient(overrides: Partial<GhnClientOptions> = {}) {
  return createGhnClient({
    credentials: taoProvider(),
    sleep: async () => {},
    ...overrides,
  });
}

function taoLogger(): { logger: ReturnType<typeof createLogger>; lines: string[] } {
  const lines: string[] = [];
  const logger = createLogger({ write: (line) => lines.push(line) });
  return { logger, lines };
}

async function batAppError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) {
      return error;
    }
    throw error;
  }
  throw new Error('Mong đợi AppError nhưng không có lỗi nào được ném ra');
}

function docDong(lines: string[]): Array<Record<string, unknown>> {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

interface FakeLogCall {
  level: 'info' | 'warn' | 'error';
  fields: Record<string, unknown>;
}

// Logger giả ghi lại NGUYÊN đối tượng nhận được (không dựa vào createLogger để lọc).
function taoFakeLogger(): { logger: ToolLogger; calls: FakeLogCall[] } {
  const calls: FakeLogCall[] = [];
  const ghi =
    (level: FakeLogCall['level']) =>
    (fields: LogFields): void => {
      calls.push({ level, fields: { ...fields } as Record<string, unknown> });
    };
  return { logger: { info: ghi('info'), warn: ghi('warn'), error: ghi('error') }, calls };
}

const SENTINEL_SDT = '0900000000';
const SENTINEL_SHOP = '999999';
const SENTINEL_DIA_CHI = '99 Duong Gia, Quan Gia';

// Kiểm mọi bề mặt có thể rò dữ liệu: trường AppError, inspect sâu, kết quả tool và log thô.
function kiemTraKhongRoiRi(
  error: AppError,
  calls: FakeLogCall[],
  sentinels: readonly string[],
): void {
  const text = [
    error.code,
    error.messageVi,
    error.messageEn,
    JSON.stringify(error.issues ?? []),
    inspect(error, { showHidden: true, depth: 5 }),
    JSON.stringify(toToolErrorResult(error, 'req_1')),
    JSON.stringify(calls),
  ].join(' ');
  for (const sentinel of sentinels) {
    expect(text).not.toContain(sentinel);
  }
}

describe('dựng lời gọi', () => {
  it('detail là GET, query order_code, header Token/ShopId, không Content-Type', async () => {
    const mock = installMockFetch([
      {
        url: `${DETAIL_URL}?order_code=G8A123456`,
        method: 'GET',
        body: okBody({ order_code: 'G8A123456', status: 'delivering' }),
      },
    ]);

    const data = await taoClient().request(
      '/v2/shipping-order/detail',
      { order_code: 'G8A123456' },
      detailSchema,
    );

    expect(data).toEqual({ order_code: 'G8A123456', status: 'delivering' });
    expect(mock.calls).toHaveLength(1);
    const call = mock.calls[0];
    expect(call.method).toBe('GET');
    expect(call.body).toBeUndefined();
    expect(call.headers['token']).toBe(TOKEN_GIA);
    expect(call.headers['shopid']).toBe(String(SHOP_ID));
    expect(call.headers['content-type']).toBeUndefined();
  });

  it('fee là POST JSON có Content-Type', async () => {
    const mock = installMockFetch([
      { url: FEE_URL, method: 'POST', body: okBody({ total: 32000 }) },
    ]);

    const data = await taoClient().request(
      '/v2/shipping-order/fee',
      { weight: 500, to_district_id: 1442 },
      feeSchema,
    );

    expect(data).toEqual({ total: 32000 });
    const call = mock.calls[0];
    expect(call.method).toBe('POST');
    expect(call.body).toEqual({ weight: 500, to_district_id: 1442 });
    expect(call.headers['content-type']).toBe('application/json');
  });

  it('không có shopId thì không gửi header ShopId', async () => {
    const mock = installMockFetch([
      {
        url: `${DETAIL_URL}?order_code=G8A123456`,
        method: 'GET',
        body: okBody({ order_code: 'G8A123456', status: 'ok' }),
      },
    ]);
    const client = taoClient({ credentials: taoProvider({ shopId: undefined }) });

    await client.request('/v2/shipping-order/detail', { order_code: 'G8A123456' }, detailSchema);

    expect(mock.calls[0].headers['shopid']).toBeUndefined();
  });

  it.each([
    { env: 'production' as const, base: PROD },
    { env: 'staging' as const, base: STAGING },
  ])('env $env dùng đúng host', async ({ env, base }) => {
    installMockFetch([{ url: `${base}/v2/shop/all`, method: 'GET', body: okBody({ shops: [] }) }]);
    const client = taoClient({ credentials: taoProvider({ env }) });

    const data = await client.request('/v2/shop/all', {}, shopsSchema);

    expect(data).toEqual({ shops: [] });
  });

  it('getCredentials được gọi mỗi lời gọi; token đổi thì header đổi', async () => {
    let token = TOKEN_GIA;
    let callCount = 0;
    const provider: CredentialProvider = {
      async getCredentials() {
        callCount += 1;
        return { token, shopId: SHOP_ID, env: 'production' };
      },
    };
    const mock = installMockFetch([
      {
        url: `${DETAIL_URL}?order_code=A12345`,
        method: 'GET',
        responses: [
          { body: okBody({ order_code: 'A12345', status: 'a' }) },
          { body: okBody({ order_code: 'A12345', status: 'b' }) },
        ],
      },
    ]);
    const client = createGhnClient({ credentials: provider, sleep: async () => {} });

    await client.request('/v2/shipping-order/detail', { order_code: 'A12345' }, detailSchema);
    token = 'TOKEN-GIA-456';
    await client.request('/v2/shipping-order/detail', { order_code: 'A12345' }, detailSchema);

    expect(callCount).toBe(2);
    expect(mock.calls[0].headers['token']).toBe(TOKEN_GIA);
    expect(mock.calls[1].headers['token']).toBe('TOKEN-GIA-456');
  });

  it('GET nhận string/number/boolean vào query theo thứ tự khóa', async () => {
    const mock = installMockFetch([
      {
        url: `${PROD}/v2/shop/all`,
        query: { client_phone: '0900000000', offset: 0, last_offset: true },
        method: 'GET',
        body: okBody({ shops: [] }),
      },
    ]);

    await taoClient().request(
      '/v2/shop/all',
      { client_phone: '0900000000', offset: 0, last_offset: true },
      shopsSchema,
    );

    expect(mock.calls[0].url).toBe(
      `${PROD}/v2/shop/all?client_phone=0900000000&offset=0&last_offset=true`,
    );
  });

  it('GET gặp object/mảng/null trong payload ném INTERNAL_ERROR, không gọi mạng', async () => {
    const mock = installMockFetch([]);
    const client = taoClient();

    for (const bad of [{ a: { b: 1 } }, { a: [1] }, { a: null }]) {
      const error = await batAppError(
        client.request('/v2/shop/all', bad as Record<string, unknown>, shopsSchema),
      );
      expect(error.code).toBe('INTERNAL_ERROR');
    }
    expect(mock.calls).toHaveLength(0);
  });
});

describe('thành công và kiểm schema', () => {
  it('trả data đã parse và loại trường lạ (allowlist của Zod)', async () => {
    installMockFetch([
      {
        url: `${DETAIL_URL}?order_code=G8A123456`,
        method: 'GET',
        body: okBody({
          order_code: 'G8A123456',
          status: 'delivering',
          to_phone: '0900000000',
          to_address: '99 Duong Gia, Quan Gia',
        }),
      },
    ]);

    const data = await taoClient().request(
      '/v2/shipping-order/detail',
      { order_code: 'G8A123456' },
      detailSchema,
    );

    expect(data).toEqual({ order_code: 'G8A123456', status: 'delivering' });
    expect(JSON.stringify(data)).not.toContain('0900000000');
    expect(JSON.stringify(data)).not.toContain('99 Duong Gia');
  });

  it('schema không khớp → GHN_UNEXPECTED_RESPONSE, không lộ giá trị dữ liệu', async () => {
    const sentinel = 'DU-LIEU-BI-MAT-123';
    installMockFetch([
      {
        url: `${DETAIL_URL}?order_code=G8A123456`,
        method: 'GET',
        body: okBody({ order_code: 'G8A123456', status: sentinel }),
      },
    ]);

    const error = await batAppError(
      taoClient().request(
        '/v2/shipping-order/detail',
        { order_code: 'G8A123456' },
        z.object({ order_code: z.string(), status: z.number() }),
      ),
    );

    expect(error.code).toBe('GHN_UNEXPECTED_RESPONSE');
    expect(error.messageEn).toContain('status');
    const text = `${error.messageVi} ${error.messageEn} ${JSON.stringify(error)}`;
    expect(text).not.toContain(sentinel);
  });

  it('thân rỗng → GHN_UNEXPECTED_RESPONSE', async () => {
    installMockFetch([{ url: `${DETAIL_URL}?order_code=G8A123456`, method: 'GET' }]);

    const error = await batAppError(
      taoClient().request('/v2/shipping-order/detail', { order_code: 'G8A123456' }, detailSchema),
    );

    expect(error.code).toBe('GHN_UNEXPECTED_RESPONSE');
  });

  it('thân không phải JSON → GHN_UNEXPECTED_RESPONSE', async () => {
    installMockFetch([
      { url: `${DETAIL_URL}?order_code=G8A123456`, method: 'GET', body: '<html>lỗi</html>' },
    ]);

    const error = await batAppError(
      taoClient().request('/v2/shipping-order/detail', { order_code: 'G8A123456' }, detailSchema),
    );

    expect(error.code).toBe('GHN_UNEXPECTED_RESPONSE');
  });

  it('HTTP 200 với code 400 trong thân → GHN_BAD_REQUEST', async () => {
    installMockFetch([
      {
        url: `${DETAIL_URL}?order_code=G8A123456`,
        method: 'GET',
        body: { code: 400, message: 'yêu cầu sai' },
      },
    ]);

    const error = await batAppError(
      taoClient().request('/v2/shipping-order/detail', { order_code: 'G8A123456' }, detailSchema),
    );

    expect(error.code).toBe('GHN_BAD_REQUEST');
    expect(error.messageEn).toContain('400');
  });
});

describe('thử lại và timeout', () => {
  it('5xx rồi 200: thành công sau đúng 2 lần gọi, chờ đúng retryDelayMs', async () => {
    const { logger, lines } = taoLogger();
    const sleepCalls: number[] = [];
    const mock = installMockFetch([
      {
        url: `${DETAIL_URL}?order_code=G8A123456`,
        method: 'GET',
        responses: [
          { status: 502, body: '<html>lỗi máy chủ</html>' },
          { status: 200, body: okBody({ order_code: 'G8A123456', status: 'ok' }) },
        ],
      },
    ]);
    const client = taoClient({
      logger,
      retryDelayMs: 123,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });

    const data = await client.request(
      '/v2/shipping-order/detail',
      { order_code: 'G8A123456' },
      detailSchema,
    );

    expect(data.status).toBe('ok');
    expect(mock.calls).toHaveLength(2);
    expect(sleepCalls).toEqual([123]);
    const entries = docDong(lines);
    expect(entries.map((entry) => entry.event)).toEqual(['ghn_retry', 'ghn_call']);
    expect(entries[0]?.level).toBe('warn');
    expect(entries[0]?.code).toBe('GHN_SERVER_ERROR');
    expect(entries[0]?.httpStatus).toBe(502);
    expect(entries[1]?.level).toBe('info');
  });

  it('5xx hai lần (502 thân HTML) → GHN_SERVER_ERROR sau đúng 2 lần gọi', async () => {
    const mock = installMockFetch([
      {
        url: `${DETAIL_URL}?order_code=G8A123456`,
        method: 'GET',
        responses: [
          { status: 502, body: '<html>lỗi máy chủ</html>' },
          { status: 502, body: '<html>lỗi máy chủ</html>' },
        ],
      },
    ]);

    const error = await batAppError(
      taoClient().request('/v2/shipping-order/detail', { order_code: 'G8A123456' }, detailSchema),
    );

    expect(error.code).toBe('GHN_SERVER_ERROR');
    expect(mock.calls).toHaveLength(2);
  });

  it('timeout rồi 200: thành công sau 2 lần gọi', async () => {
    let attempts = 0;
    const fetchImpl: typeof fetch = (_input, init) => {
      attempts += 1;
      if (attempts === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        });
      }
      return Promise.resolve(
        new Response(JSON.stringify(okBody({ order_code: 'G8A123456', status: 'ok' })), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    };
    const client = createGhnClient({
      credentials: taoProvider(),
      fetch: fetchImpl,
      timeoutMs: 20,
      sleep: async () => {},
    });

    const data = await client.request(
      '/v2/shipping-order/detail',
      { order_code: 'G8A123456' },
      detailSchema,
    );

    expect(data.status).toBe('ok');
    expect(attempts).toBe(2);
  });

  it('timeout hai lần → GHN_TIMEOUT sau 2 lần gọi, messageEn có số ms', async () => {
    const mock = installMockFetch([
      { url: `${DETAIL_URL}?order_code=G8A123456`, method: 'GET', hang: true },
    ]);

    const error = await batAppError(
      taoClient({ timeoutMs: 20 }).request(
        '/v2/shipping-order/detail',
        { order_code: 'G8A123456' },
        detailSchema,
      ),
    );

    expect(error.code).toBe('GHN_TIMEOUT');
    expect(error.messageEn).toContain('20 ms');
    expect(mock.calls).toHaveLength(2);
  });

  it('lỗi mạng → GHN_NETWORK, 1 lần gọi, errno lấy từ cause.code', async () => {
    const networkError = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ENOTFOUND' },
    });
    const mock = installMockFetch([
      { url: `${DETAIL_URL}?order_code=G8A123456`, method: 'GET', networkError },
    ]);

    const error = await batAppError(
      taoClient().request('/v2/shipping-order/detail', { order_code: 'G8A123456' }, detailSchema),
    );

    expect(error.code).toBe('GHN_NETWORK');
    expect(error.messageEn).toContain('ENOTFOUND');
    expect(mock.calls).toHaveLength(1);
  });

  it('errno lạ/dài/chứa URL → unknown, không lộ URL', async () => {
    const networkError = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'https://bi-mat.example/TOKEN-GIA-123' },
    });
    installMockFetch([{ url: `${DETAIL_URL}?order_code=G8A123456`, method: 'GET', networkError }]);

    const error = await batAppError(
      taoClient().request('/v2/shipping-order/detail', { order_code: 'G8A123456' }, detailSchema),
    );

    expect(error.code).toBe('GHN_NETWORK');
    expect(error.messageEn).toContain('unknown');
    expect(error.messageEn).not.toContain('https://');
  });

  it('401 → GHN_UNAUTHORIZED, 1 lần gọi, không chờ', async () => {
    const sleep = vi.fn(async () => {});
    const mock = installMockFetch([
      { url: `${DETAIL_URL}?order_code=G8A123456`, method: 'GET', status: 401 },
    ]);

    const error = await batAppError(
      taoClient({ sleep }).request(
        '/v2/shipping-order/detail',
        { order_code: 'G8A123456' },
        detailSchema,
      ),
    );

    expect(error.code).toBe('GHN_UNAUTHORIZED');
    expect(mock.calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('429 → GHN_RATE_LIMITED, 1 lần gọi, không chờ', async () => {
    const sleep = vi.fn(async () => {});
    installMockFetch([{ url: `${DETAIL_URL}?order_code=G8A123456`, method: 'GET', status: 429 }]);

    const error = await batAppError(
      taoClient({ sleep }).request(
        '/v2/shipping-order/detail',
        { order_code: 'G8A123456' },
        detailSchema,
      ),
    );

    expect(error.code).toBe('GHN_RATE_LIMITED');
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('ánh xạ lỗi nghiệp vụ', () => {
  it('detail HTTP 400 message "không tồn tại" → GHN_ORDER_NOT_FOUND kèm mã đơn', async () => {
    installMockFetch([
      {
        url: `${DETAIL_URL}?order_code=G8A123456`,
        method: 'GET',
        status: 400,
        body: { code: 400, message: 'Lỗi gọi API: Đơn hàng không tồn tại' },
      },
    ]);

    const error = await batAppError(
      taoClient().request('/v2/shipping-order/detail', { order_code: 'G8A123456' }, detailSchema),
    );

    expect(error.code).toBe('GHN_ORDER_NOT_FOUND');
    expect(error.messageVi).toContain('G8A123456');
  });

  it('cùng thân "không tồn tại" ở fee → GHN_BAD_REQUEST', async () => {
    installMockFetch([
      {
        url: FEE_URL,
        method: 'POST',
        status: 400,
        body: { code: 400, message: 'Đơn hàng không tồn tại' },
      },
    ]);

    const error = await batAppError(
      taoClient().request('/v2/shipping-order/fee', { weight: 500 }, feeSchema),
    );

    expect(error.code).toBe('GHN_BAD_REQUEST');
  });

  it('HTTP 403 → GHN_BAD_REQUEST', async () => {
    installMockFetch([
      {
        url: `${DETAIL_URL}?order_code=G8A123456`,
        method: 'GET',
        status: 403,
        body: { code: 403, message: 'không có quyền' },
      },
    ]);

    const error = await batAppError(
      taoClient().request('/v2/shipping-order/detail', { order_code: 'G8A123456' }, detailSchema),
    );

    expect(error.code).toBe('GHN_BAD_REQUEST');
    expect(error.messageEn).toContain('403');
  });

  it('400 với code_message CLIENT_NOT_OWNER_OF_SHOP → GHN_BAD_REQUEST', async () => {
    installMockFetch([
      {
        url: `${DETAIL_URL}?order_code=G8A123456`,
        method: 'GET',
        status: 400,
        body: { code: 400, code_message: 'CLIENT_NOT_OWNER_OF_SHOP' },
      },
    ]);

    const error = await batAppError(
      taoClient().request('/v2/shipping-order/detail', { order_code: 'G8A123456' }, detailSchema),
    );

    expect(error.code).toBe('GHN_BAD_REQUEST');
  });

  it('"route not found service" (HTTP 400) → GHN_BAD_REQUEST', async () => {
    installMockFetch([
      {
        url: FEE_URL,
        method: 'POST',
        status: 400,
        body: { code: 400, message: 'route not found service' },
      },
    ]);

    const error = await batAppError(
      taoClient().request('/v2/shipping-order/fee', { weight: 500 }, feeSchema),
    );

    expect(error.code).toBe('GHN_BAD_REQUEST');
  });
});

describe('chống rò rỉ dữ liệu', () => {
  const rawMessage = `Lỗi lấy thông tin shop ${SENTINEL_SHOP}, SĐT ${SENTINEL_SDT}, ${SENTINEL_DIA_CHI}`;
  const sentinels = [SENTINEL_SDT, SENTINEL_SHOP, SENTINEL_DIA_CHI, rawMessage];

  it('fee POST 400 SHOP_INFO_ERROR: không lộ message thô/SĐT/mã shop/địa chỉ', async () => {
    installMockFetch([
      {
        url: FEE_URL,
        method: 'POST',
        status: 400,
        body: { code: 400, code_message: 'SHOP_INFO_ERROR', message: rawMessage },
      },
    ]);
    const { logger, calls } = taoFakeLogger();

    const error = await batAppError(
      taoClient({ logger }).request('/v2/shipping-order/fee', { weight: 500 }, feeSchema),
    );

    expect(error.code).toBe('GHN_BAD_REQUEST');
    kiemTraKhongRoiRi(error, calls, sentinels);
  });

  it('5xx thân HTML chứa sentinel ở cả hai lần thử: không lộ, vẫn có log retry', async () => {
    installMockFetch([
      {
        url: `${DETAIL_URL}?order_code=G8A123456`,
        method: 'GET',
        responses: [
          { status: 502, body: `<html>${rawMessage}</html>` },
          { status: 502, body: `<html>${rawMessage}</html>` },
        ],
      },
    ]);
    const { logger, calls } = taoFakeLogger();

    const error = await batAppError(
      taoClient({ logger }).request(
        '/v2/shipping-order/detail',
        { order_code: 'G8A123456' },
        detailSchema,
      ),
    );

    expect(error.code).toBe('GHN_SERVER_ERROR');
    expect(calls.map((call) => call.fields.event)).toEqual(['ghn_retry', 'ghn_call']);
    kiemTraKhongRoiRi(error, calls, sentinels);
  });

  it('HTTP 200 + code 400 có message chứa sentinel: không lộ', async () => {
    installMockFetch([
      {
        url: `${DETAIL_URL}?order_code=G8A123456`,
        method: 'GET',
        body: { code: 400, message: rawMessage },
      },
    ]);
    const { logger, calls } = taoFakeLogger();

    const error = await batAppError(
      taoClient({ logger }).request(
        '/v2/shipping-order/detail',
        { order_code: 'G8A123456' },
        detailSchema,
      ),
    );

    expect(error.code).toBe('GHN_BAD_REQUEST');
    kiemTraKhongRoiRi(error, calls, sentinels);
  });

  it('detail không tìm thấy với message chứa sentinel: không lộ', async () => {
    installMockFetch([
      {
        url: `${DETAIL_URL}?order_code=G8A123456`,
        method: 'GET',
        status: 400,
        body: { code: 400, message: `Đơn hàng không tồn tại. ${rawMessage}` },
      },
    ]);
    const { logger, calls } = taoFakeLogger();

    const error = await batAppError(
      taoClient({ logger }).request(
        '/v2/shipping-order/detail',
        { order_code: 'G8A123456' },
        detailSchema,
      ),
    );

    expect(error.code).toBe('GHN_ORDER_NOT_FOUND');
    expect(error.messageVi).toContain('G8A123456');
    kiemTraKhongRoiRi(error, calls, sentinels);
  });

  it('HTTP 403 có message chứa sentinel: không lộ', async () => {
    installMockFetch([
      {
        url: `${DETAIL_URL}?order_code=G8A123456`,
        method: 'GET',
        status: 403,
        body: { code: 403, message: rawMessage },
      },
    ]);
    const { logger, calls } = taoFakeLogger();

    const error = await batAppError(
      taoClient({ logger }).request(
        '/v2/shipping-order/detail',
        { order_code: 'G8A123456' },
        detailSchema,
      ),
    );

    expect(error.code).toBe('GHN_BAD_REQUEST');
    kiemTraKhongRoiRi(error, calls, sentinels);
  });

  it('schema mismatch với sentinel nằm trong data: không lộ, chỉ nêu tên trường', async () => {
    installMockFetch([
      {
        url: `${DETAIL_URL}?order_code=G8A123456`,
        method: 'GET',
        body: okBody({ order_code: 'G8A123456', status: rawMessage }),
      },
    ]);
    const { logger, calls } = taoFakeLogger();

    const error = await batAppError(
      taoClient({ logger }).request(
        '/v2/shipping-order/detail',
        { order_code: 'G8A123456' },
        z.object({ order_code: z.string(), status: z.number() }),
      ),
    );

    expect(error.code).toBe('GHN_UNEXPECTED_RESPONSE');
    expect(error.messageEn).toContain('status');
    kiemTraKhongRoiRi(error, calls, sentinels);
  });

  it('token không lộ khi lỗi fetch chứa token trong message/cause và hostname', async () => {
    const leaky = Object.assign(new TypeError(`fetch failed for ${TOKEN_GIA}`), {
      cause: { code: 'ENOTFOUND', message: `https://host.example?token=${TOKEN_GIA}` },
    });
    installMockFetch([
      { url: `${DETAIL_URL}?order_code=G8A123456`, method: 'GET', networkError: leaky },
    ]);
    const { logger, calls } = taoFakeLogger();

    const error = await batAppError(
      taoClient({ logger }).request(
        '/v2/shipping-order/detail',
        { order_code: 'G8A123456' },
        detailSchema,
      ),
    );

    const text = [
      error.message,
      error.messageVi,
      error.messageEn,
      inspect(error, { showHidden: true, depth: 5 }),
      JSON.stringify(toToolErrorResult(error, 'req_1')),
      JSON.stringify(calls),
      error.cause === undefined ? '' : inspect(error.cause, { depth: 5 }),
    ].join(' ');
    expect(text).not.toContain(TOKEN_GIA);
    expect(text).not.toContain('host.example');
  });

  it('token có \\n bị chặn TRƯỚC khi gọi fetch, lỗi không chứa token', async () => {
    const mock = installMockFetch([]);
    const provider = taoProvider({ token: 'TOKEN-GIA\n123' });

    const error = await batAppError(
      taoClient({ credentials: provider }).request(
        '/v2/shipping-order/detail',
        { order_code: 'G8A123456' },
        detailSchema,
      ),
    );

    expect(error.code).toBe('CONFIG_MISSING');
    expect(error.messageVi).toContain('GHN_TOKEN');
    expect(mock.calls).toHaveLength(0);
    const text = [
      error.messageVi,
      error.messageEn,
      inspect(error, { showHidden: true, depth: 5 }),
      JSON.stringify(toToolErrorResult(error, 'req_1')),
    ].join(' ');
    expect(text).not.toContain('TOKEN-GIA');
  });

  it.each([
    { nhan: 'ShopId 0', shopId: 0 },
    { nhan: 'ShopId âm', shopId: -1 },
    { nhan: 'ShopId số thực', shopId: 1.5 },
    { nhan: 'ShopId NaN', shopId: Number.NaN },
  ])('$nhan bị chặn TRƯỚC khi gọi fetch', async ({ shopId }) => {
    const mock = installMockFetch([]);
    const provider = taoProvider({ shopId });

    const error = await batAppError(
      taoClient({ credentials: provider }).request(
        '/v2/shipping-order/detail',
        { order_code: 'G8A123456' },
        detailSchema,
      ),
    );

    expect(error.code).toBe('CONFIG_MISSING');
    expect(error.messageVi).toContain('GHN_SHOP_ID');
    expect(mock.calls).toHaveLength(0);
  });

  it('token không lộ trong lỗi, kết quả tool hay log (mạng, timeout, 401)', async () => {
    const scenarios: Array<() => Promise<AppError>> = [];

    const networkError = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ENOTFOUND' },
    });
    scenarios.push(async () => {
      const mock = installMockFetch([
        { url: `${DETAIL_URL}?order_code=G8A123456`, method: 'GET', networkError },
      ]);
      const { logger, calls } = taoFakeLogger();
      const error = await batAppError(
        taoClient({ logger }).request(
          '/v2/shipping-order/detail',
          { order_code: 'G8A123456' },
          detailSchema,
        ),
      );
      kiemTraKhongRoiRi(error, calls, [TOKEN_GIA]);
      mock.restore();
      return error;
    });

    scenarios.push(async () => {
      const mock = installMockFetch([
        { url: `${DETAIL_URL}?order_code=G8A123456`, method: 'GET', status: 401 },
      ]);
      const { logger, calls } = taoFakeLogger();
      const error = await batAppError(
        taoClient({ logger }).request(
          '/v2/shipping-order/detail',
          { order_code: 'G8A123456' },
          detailSchema,
        ),
      );
      kiemTraKhongRoiRi(error, calls, [TOKEN_GIA]);
      mock.restore();
      return error;
    });

    scenarios.push(async () => {
      const mock = installMockFetch([
        { url: `${DETAIL_URL}?order_code=G8A123456`, method: 'GET', hang: true },
      ]);
      const { logger, calls } = taoFakeLogger();
      const error = await batAppError(
        taoClient({ logger, timeoutMs: 10 }).request(
          '/v2/shipping-order/detail',
          { order_code: 'G8A123456' },
          detailSchema,
        ),
      );
      kiemTraKhongRoiRi(error, calls, [TOKEN_GIA]);
      mock.restore();
      return error;
    });

    // Chạy TUẦN TỰ: mỗi kịch bản lắp một mock fetch toàn cục, chạy song song sẽ đè lên nhau.
    const errors: AppError[] = [];
    for (const run of scenarios) {
      errors.push(await run());
    }
    expect(errors.map((error) => error.code)).toEqual([
      'GHN_NETWORK',
      'GHN_UNAUTHORIZED',
      'GHN_TIMEOUT',
    ]);
  });
});

describe('thân phản hồi và timeout khi đọc thân', () => {
  it('thân treo lần 1 rồi thành công: thử lại, 2 lần gọi', async () => {
    const mock = installMockFetch([
      {
        url: `${DETAIL_URL}?order_code=G8A123456`,
        method: 'GET',
        responses: [
          { status: 200, hangBody: true },
          { status: 200, body: okBody({ order_code: 'G8A123456', status: 'ok' }) },
        ],
      },
    ]);

    const data = await taoClient({ timeoutMs: 20 }).request(
      '/v2/shipping-order/detail',
      { order_code: 'G8A123456' },
      detailSchema,
    );

    expect(data.status).toBe('ok');
    expect(mock.calls).toHaveLength(2);
  });

  it('thân treo cả hai lần → GHN_TIMEOUT, 2 lần gọi', async () => {
    const mock = installMockFetch([
      {
        url: `${DETAIL_URL}?order_code=G8A123456`,
        method: 'GET',
        responses: [
          { status: 200, hangBody: true },
          { status: 200, hangBody: true },
        ],
      },
    ]);

    const error = await batAppError(
      taoClient({ timeoutMs: 20 }).request(
        '/v2/shipping-order/detail',
        { order_code: 'G8A123456' },
        detailSchema,
      ),
    );

    expect(error.code).toBe('GHN_TIMEOUT');
    expect(error.messageEn).toContain('20 ms');
    expect(mock.calls).toHaveLength(2);
  });

  it('đọc thân lỗi thường (không timeout) → GHN_UNEXPECTED_RESPONSE', async () => {
    installMockFetch([
      {
        url: `${DETAIL_URL}?order_code=G8A123456`,
        method: 'GET',
        bodyError: new Error('lỗi đọc thân'),
      },
    ]);

    const error = await batAppError(
      taoClient().request('/v2/shipping-order/detail', { order_code: 'G8A123456' }, detailSchema),
    );

    expect(error.code).toBe('GHN_UNEXPECTED_RESPONSE');
  });

  it('hủy thân chưa đọc ở 5xx (cả hai lần thử)', async () => {
    let cancels = 0;
    const fetchImpl: typeof fetch = () => {
      const stream = new ReadableStream<Uint8Array>({
        cancel() {
          cancels += 1;
        },
      });
      return Promise.resolve(new Response(stream, { status: 500 }));
    };
    const client = createGhnClient({
      credentials: taoProvider(),
      fetch: fetchImpl,
      sleep: async () => {},
    });

    const error = await batAppError(
      client.request('/v2/shipping-order/detail', { order_code: 'G8A123456' }, detailSchema),
    );

    expect(error.code).toBe('GHN_SERVER_ERROR');
    expect(cancels).toBe(2);
  });
});

describe('redirect', () => {
  it("truyền redirect: 'error' cho fetch", async () => {
    const mock = installMockFetch([
      {
        url: `${DETAIL_URL}?order_code=G8A123456`,
        method: 'GET',
        body: okBody({ order_code: 'G8A123456', status: 'ok' }),
      },
    ]);

    await taoClient().request(
      '/v2/shipping-order/detail',
      { order_code: 'G8A123456' },
      detailSchema,
    );

    expect(mock.calls[0].redirect).toBe('error');
  });
});

describe('code trong thân GHN', () => {
  it("code '200' dạng chuỗi + data hợp lệ → thành công", async () => {
    installMockFetch([
      {
        url: `${DETAIL_URL}?order_code=G8A123456`,
        method: 'GET',
        body: { code: '200', data: { order_code: 'G8A123456', status: 'ok' } },
      },
    ]);

    const data = await taoClient().request(
      '/v2/shipping-order/detail',
      { order_code: 'G8A123456' },
      detailSchema,
    );

    expect(data.status).toBe('ok');
  });

  it.each([
    { nhan: 'code null', body: { code: null, data: {} } },
    { nhan: 'thiếu code', body: { data: {} } },
  ])('$nhan ở 2xx → GHN_UNEXPECTED_RESPONSE', async ({ body }) => {
    installMockFetch([{ url: `${DETAIL_URL}?order_code=G8A123456`, method: 'GET', body }]);

    const error = await batAppError(
      taoClient().request('/v2/shipping-order/detail', { order_code: 'G8A123456' }, detailSchema),
    );

    expect(error.code).toBe('GHN_UNEXPECTED_RESPONSE');
  });

  it("code '400' dạng chuỗi → GHN_BAD_REQUEST", async () => {
    installMockFetch([
      {
        url: `${DETAIL_URL}?order_code=G8A123456`,
        method: 'GET',
        body: { code: '400', message: 'yêu cầu sai' },
      },
    ]);

    const error = await batAppError(
      taoClient().request('/v2/shipping-order/detail', { order_code: 'G8A123456' }, detailSchema),
    );

    expect(error.code).toBe('GHN_BAD_REQUEST');
  });

  it.each([
    { nhan: "chuỗi '0900000000'", code: '0900000000' },
    { nhan: "chuỗi 'abc'", code: 'abc' },
    { nhan: 'số 99999', code: 99999 },
    { nhan: 'null', code: null },
  ])('code $nhan ở HTTP 400 → code unknown, không lộ chuỗi', async ({ code }) => {
    installMockFetch([
      {
        url: `${DETAIL_URL}?order_code=G8A123456`,
        method: 'GET',
        status: 400,
        body: { code, message: 'lỗi' },
      },
    ]);

    const error = await batAppError(
      taoClient().request('/v2/shipping-order/detail', { order_code: 'G8A123456' }, detailSchema),
    );

    expect(error.code).toBe('GHN_BAD_REQUEST');
    expect(error.messageEn).toContain('code unknown');
    if (typeof code === 'string') {
      expect(error.messageEn).not.toContain(code);
    }
  });

  it("code '400' dạng chuỗi ở HTTP 400 → hiển thị 400", async () => {
    installMockFetch([
      {
        url: `${DETAIL_URL}?order_code=G8A123456`,
        method: 'GET',
        status: 400,
        body: { code: '400', message: 'lỗi' },
      },
    ]);

    const error = await batAppError(
      taoClient().request('/v2/shipping-order/detail', { order_code: 'G8A123456' }, detailSchema),
    );

    expect(error.messageEn).toContain('code 400');
  });
});

describe('"không tìm thấy đơn" với HTTP 200 + code 400', () => {
  it('endpoint detail → GHN_ORDER_NOT_FOUND', async () => {
    installMockFetch([
      {
        url: `${DETAIL_URL}?order_code=G8A123456`,
        method: 'GET',
        body: { code: 400, message: 'Đơn hàng không tồn tại' },
      },
    ]);

    const error = await batAppError(
      taoClient().request('/v2/shipping-order/detail', { order_code: 'G8A123456' }, detailSchema),
    );

    expect(error.code).toBe('GHN_ORDER_NOT_FOUND');
    expect(error.messageVi).toContain('G8A123456');
  });

  it('endpoint khác (fee) → GHN_BAD_REQUEST', async () => {
    installMockFetch([
      {
        url: FEE_URL,
        method: 'POST',
        body: { code: 400, message: 'Đơn hàng không tồn tại' },
      },
    ]);

    const error = await batAppError(
      taoClient().request('/v2/shipping-order/fee', { weight: 500 }, feeSchema),
    );

    expect(error.code).toBe('GHN_BAD_REQUEST');
  });
});

describe('kiểm tra bổ sung theo review', () => {
  it('order_code không phải chuỗi → GHN_ORDER_NOT_FOUND với (không rõ)', async () => {
    installMockFetch([
      {
        url: `${DETAIL_URL}?order_code=123`,
        method: 'GET',
        status: 400,
        body: { code: 400, message: 'Đơn hàng không tồn tại' },
      },
    ]);

    const error = await batAppError(
      taoClient().request(
        '/v2/shipping-order/detail',
        { order_code: 123 } as unknown as Record<string, unknown>,
        detailSchema,
      ),
    );

    expect(error.code).toBe('GHN_ORDER_NOT_FOUND');
    expect(error.messageVi).toContain('(không rõ)');
  });

  it.each([
    { nhan: 'null', body: null },
    { nhan: 'mảng', body: [] },
    { nhan: 'chuỗi JSON', body: '"chuỗi"' },
  ])('thân 2xx là $nhan → GHN_UNEXPECTED_RESPONSE', async ({ body }) => {
    installMockFetch([{ url: `${DETAIL_URL}?order_code=G8A123456`, method: 'GET', body }]);

    const error = await batAppError(
      taoClient().request('/v2/shipping-order/detail', { order_code: 'G8A123456' }, detailSchema),
    );

    expect(error.code).toBe('GHN_UNEXPECTED_RESPONSE');
  });

  it('data undefined → GHN_UNEXPECTED_RESPONSE', async () => {
    installMockFetch([
      { url: `${DETAIL_URL}?order_code=G8A123456`, method: 'GET', body: { code: 200 } },
    ]);

    const error = await batAppError(
      taoClient().request('/v2/shipping-order/detail', { order_code: 'G8A123456' }, detailSchema),
    );

    expect(error.code).toBe('GHN_UNEXPECTED_RESPONSE');
  });

  it('sleep ném lỗi → INTERNAL_ERROR, không crash', async () => {
    installMockFetch([
      {
        url: `${DETAIL_URL}?order_code=G8A123456`,
        method: 'GET',
        responses: [
          { status: 502, body: 'lỗi' },
          { status: 200, body: okBody({ order_code: 'G8A123456', status: 'ok' }) },
        ],
      },
    ]);
    const client = taoClient({
      sleep: async () => {
        throw new Error('sleep lỗi');
      },
    });

    const error = await batAppError(
      client.request('/v2/shipping-order/detail', { order_code: 'G8A123456' }, detailSchema),
    );

    expect(error.code).toBe('INTERNAL_ERROR');
  });

  it('getCredentials ném CONFIG_MISSING đi qua nguyên vẹn, không gọi mạng', async () => {
    const mock = installMockFetch([]);
    const provider: CredentialProvider = {
      async getCredentials() {
        throw createAppError('CONFIG_MISSING', {
          'tên biến': 'GHN_TOKEN',
          name: 'GHN_TOKEN',
        });
      },
    };

    const error = await batAppError(
      taoClient({ credentials: provider }).request(
        '/v2/shipping-order/detail',
        { order_code: 'G8A123456' },
        detailSchema,
      ),
    );

    expect(error.code).toBe('CONFIG_MISSING');
    expect(mock.calls).toHaveLength(0);
  });

  it('responseSchema ném lỗi bất ngờ → INTERNAL_ERROR', async () => {
    installMockFetch([
      {
        url: `${DETAIL_URL}?order_code=G8A123456`,
        method: 'GET',
        body: okBody({ order_code: 'G8A123456', status: 'ok' }),
      },
    ]);
    // Schema giả ném lỗi ngay trong safeParse (không phải lỗi kiểm dữ liệu của Zod).
    const badSchema = {
      safeParse() {
        throw new Error('bùm schema');
      },
    } as unknown as z.ZodType<string>;

    const error = await batAppError(
      taoClient().request('/v2/shipping-order/detail', { order_code: 'G8A123456' }, badSchema),
    );

    expect(error.code).toBe('INTERNAL_ERROR');
  });

  it('5xx rồi timeout: ghn_call cuối là GHN_TIMEOUT, KHÔNG mang httpStatus cũ', async () => {
    let attempts = 0;
    const fetchImpl: typeof fetch = (_input, init) => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.resolve(new Response('lỗi', { status: 502 }));
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
          once: true,
        });
      });
    };
    const { logger, calls } = taoFakeLogger();
    const client = createGhnClient({
      credentials: taoProvider(),
      fetch: fetchImpl,
      timeoutMs: 10,
      sleep: async () => {},
      logger,
    });

    const error = await batAppError(
      client.request('/v2/shipping-order/detail', { order_code: 'G8A123456' }, detailSchema),
    );

    expect(error.code).toBe('GHN_TIMEOUT');
    const finalCall = calls.find((call) => call.level === 'error');
    expect(finalCall?.fields.code).toBe('GHN_TIMEOUT');
    expect(finalCall?.fields).not.toHaveProperty('httpStatus');
  });

  it('query Unicode/ký tự đặc biệt được mã hóa % đúng', async () => {
    const giaTri = 'Địa chỉ 1&2';
    const mock = installMockFetch([
      {
        url: `${PROD}/v2/shop/all`,
        query: { q: giaTri },
        method: 'GET',
        body: okBody({ shops: [] }),
      },
    ]);

    await taoClient().request('/v2/shop/all', { q: giaTri }, shopsSchema);

    const url = new URL(mock.calls[0].url);
    expect(url.searchParams.get('q')).toBe(giaTri);
    expect(mock.calls[0].url).not.toContain(giaTri);
    expect(mock.calls[0].url).toContain('%');
  });

  it.each([
    { nhan: 'khóa rỗng', payload: { '': 'x' } },
    { nhan: 'số NaN', payload: { q: Number.NaN } },
    { nhan: 'số Infinity', payload: { q: Number.POSITIVE_INFINITY } },
  ])('query có $nhan → INTERNAL_ERROR, không gọi mạng', async ({ payload }) => {
    const mock = installMockFetch([]);

    const error = await batAppError(taoClient().request('/v2/shop/all', payload, shopsSchema));

    expect(error.code).toBe('INTERNAL_ERROR');
    expect(mock.calls).toHaveLength(0);
  });
});

describe('cấu hình createGhnClient', () => {
  it.each([
    { nhan: 'NaN', value: Number.NaN },
    { nhan: 'âm', value: -1 },
    { nhan: '0', value: 0 },
    { nhan: 'Infinity', value: Number.POSITIVE_INFINITY },
  ])('timeoutMs $nhan bị từ chối sớm', ({ value }) => {
    expect(() => createGhnClient({ credentials: taoProvider(), timeoutMs: value })).toThrow(
      /timeoutMs/,
    );
  });

  it.each([
    { nhan: 'NaN', value: Number.NaN },
    { nhan: 'âm', value: -1 },
    { nhan: 'Infinity', value: Number.POSITIVE_INFINITY },
  ])('retryDelayMs $nhan bị từ chối sớm', ({ value }) => {
    expect(() => createGhnClient({ credentials: taoProvider(), retryDelayMs: value })).toThrow(
      /retryDelayMs/,
    );
  });
});

describe('log', () => {
  const ALLOWED_LOG_KEYS = new Set([
    'ts',
    'level',
    'tool',
    'code',
    'ms',
    'httpStatus',
    'requestId',
    'event',
    'dropped',
  ]);

  it('thành công có đúng một dòng ghn_call, chỉ khóa allowlist', async () => {
    const { logger, lines } = taoLogger();
    installMockFetch([
      {
        url: `${DETAIL_URL}?order_code=G8A123456`,
        method: 'GET',
        body: okBody({ order_code: 'G8A123456', status: 'ok' }),
      },
    ]);

    await taoClient({ logger }).request(
      '/v2/shipping-order/detail',
      { order_code: 'G8A123456' },
      detailSchema,
    );

    const entries = docDong(lines);
    expect(entries).toHaveLength(1);
    const entry = entries[0] ?? {};
    expect(entry.event).toBe('ghn_call');
    expect(entry.level).toBe('info');
    for (const key of Object.keys(entry)) {
      expect(ALLOWED_LOG_KEYS.has(key)).toBe(true);
    }
    expect(entry).not.toHaveProperty('tool');
    expect(entry).not.toHaveProperty('requestId');
    expect(entry).not.toHaveProperty('dropped');
  });

  it('không có logger thì không lỗi', async () => {
    installMockFetch([
      {
        url: `${DETAIL_URL}?order_code=G8A123456`,
        method: 'GET',
        body: okBody({ order_code: 'G8A123456', status: 'ok' }),
      },
    ]);

    await expect(
      taoClient().request('/v2/shipping-order/detail', { order_code: 'G8A123456' }, detailSchema),
    ).resolves.toEqual({ order_code: 'G8A123456', status: 'ok' });
  });

  it('logger giả: mọi lần gọi chỉ có khóa event/ms/httpStatus/code', async () => {
    const allowed = new Set(['event', 'ms', 'httpStatus', 'code']);

    const success = taoFakeLogger();
    const successMock = installMockFetch([
      {
        url: `${DETAIL_URL}?order_code=G8A123456`,
        method: 'GET',
        body: okBody({ order_code: 'G8A123456', status: 'ok' }),
      },
    ]);
    await taoClient({ logger: success.logger }).request(
      '/v2/shipping-order/detail',
      { order_code: 'G8A123456' },
      detailSchema,
    );
    successMock.restore();

    const retry = taoFakeLogger();
    const retryMock = installMockFetch([
      {
        url: `${DETAIL_URL}?order_code=G8A123456`,
        method: 'GET',
        responses: [
          { status: 502, body: 'lỗi' },
          { status: 200, body: okBody({ order_code: 'G8A123456', status: 'ok' }) },
        ],
      },
    ]);
    await taoClient({ logger: retry.logger }).request(
      '/v2/shipping-order/detail',
      { order_code: 'G8A123456' },
      detailSchema,
    );
    retryMock.restore();

    const failure = taoFakeLogger();
    const failureMock = installMockFetch([
      { url: `${DETAIL_URL}?order_code=G8A123456`, method: 'GET', status: 401 },
    ]);
    await batAppError(
      taoClient({ logger: failure.logger }).request(
        '/v2/shipping-order/detail',
        { order_code: 'G8A123456' },
        detailSchema,
      ),
    );
    failureMock.restore();

    const allCalls = [...success.calls, ...retry.calls, ...failure.calls];
    expect(allCalls.length).toBeGreaterThan(0);
    for (const call of allCalls) {
      for (const key of Object.keys(call.fields)) {
        expect(allowed.has(key)).toBe(true);
      }
    }
  });

  it('lỗi cuối ghi level error kèm code và httpStatus', async () => {
    const { logger, calls } = taoFakeLogger();
    installMockFetch([{ url: `${DETAIL_URL}?order_code=G8A123456`, method: 'GET', status: 401 }]);

    await batAppError(
      taoClient({ logger }).request(
        '/v2/shipping-order/detail',
        { order_code: 'G8A123456' },
        detailSchema,
      ),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe('error');
    expect(calls[0].fields).toMatchObject({
      event: 'ghn_call',
      code: 'GHN_UNAUTHORIZED',
      httpStatus: 401,
    });
  });

  it('ghn_retry sau timeout mang code GHN_TIMEOUT, không httpStatus', async () => {
    const { logger, calls } = taoFakeLogger();
    installMockFetch([{ url: `${DETAIL_URL}?order_code=G8A123456`, method: 'GET', hang: true }]);

    await batAppError(
      taoClient({ logger, timeoutMs: 10 }).request(
        '/v2/shipping-order/detail',
        { order_code: 'G8A123456' },
        detailSchema,
      ),
    );

    expect(calls.map((call) => call.fields.event)).toEqual(['ghn_retry', 'ghn_call']);
    expect(calls[0].fields).toMatchObject({ code: 'GHN_TIMEOUT' });
    expect(calls[0].fields).not.toHaveProperty('httpStatus');
    expect(calls[1].level).toBe('error');
    expect(calls[1].fields.code).toBe('GHN_TIMEOUT');
    expect(calls[1].fields).not.toHaveProperty('httpStatus');
  });

  it('logger ném lỗi ở mọi mức không làm đổi kết quả', async () => {
    const throwingLogger: ToolLogger = {
      info() {
        throw new Error('info lỗi');
      },
      warn() {
        throw new Error('warn lỗi');
      },
      error() {
        throw new Error('error lỗi');
      },
    };

    const successMock = installMockFetch([
      {
        url: `${DETAIL_URL}?order_code=G8A123456`,
        method: 'GET',
        body: okBody({ order_code: 'G8A123456', status: 'ok' }),
      },
    ]);
    await expect(
      taoClient({ logger: throwingLogger }).request(
        '/v2/shipping-order/detail',
        { order_code: 'G8A123456' },
        detailSchema,
      ),
    ).resolves.toEqual({ order_code: 'G8A123456', status: 'ok' });
    successMock.restore();

    const retryMock = installMockFetch([
      {
        url: `${DETAIL_URL}?order_code=G8A123456`,
        method: 'GET',
        responses: [
          { status: 502, body: 'lỗi' },
          { status: 200, body: okBody({ order_code: 'G8A123456', status: 'ok' }) },
        ],
      },
    ]);
    await expect(
      taoClient({ logger: throwingLogger }).request(
        '/v2/shipping-order/detail',
        { order_code: 'G8A123456' },
        detailSchema,
      ),
    ).resolves.toEqual({ order_code: 'G8A123456', status: 'ok' });
    retryMock.restore();

    const failureMock = installMockFetch([
      { url: `${DETAIL_URL}?order_code=G8A123456`, method: 'GET', status: 401 },
    ]);
    const error = await batAppError(
      taoClient({ logger: throwingLogger }).request(
        '/v2/shipping-order/detail',
        { order_code: 'G8A123456' },
        detailSchema,
      ),
    );
    expect(error.code).toBe('GHN_UNAUTHORIZED');
    failureMock.restore();
  });
});
