import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getBaseUrl } from '../../../src/config/env.js';
import { AppError } from '../../../src/core/errors.js';
import type {
  CredentialProvider,
  GhnGateway,
  ToolContext,
  ToolLogger,
} from '../../../src/core/types.js';
import { createGhnClient } from '../../../src/services/ghn-client.js';
import { AllowAll } from '../../../src/services/license-allow-all.js';
import { createMcpServer } from '../../../src/server.js';
import { getOrderDetailTool } from '../../../src/tools/ghn/get-order-detail.js';
import { getShopsTool, type GetShopsResult } from '../../../src/tools/ghn/get-shops.js';
import { createToolRegistry } from '../../../src/tools/registry.js';
import { installMockFetch } from '../../helpers/mock-fetch.js';

const TOKEN_GIA = 'TOKEN-GIA-123';
const SHOP_ID = 999999;
const SHOPS_URL = `${getBaseUrl('production')}/v2/shop/all`;

// Các giá trị KHÔNG được lộ ra kết quả tool/log (dữ liệu giả dễ nhận ra).
const SENTINELS = [
  '0900000000',
  '99 Duong Gia, Quan Gia',
  'CLIENT-GIA-123',
  'BANK-GIA-456',
  '203.0.113.10',
  'GIA-EMPLOYEE',
  'GIA-TRI-LA',
];

const provider: CredentialProvider = {
  async getCredentials() {
    return { token: TOKEN_GIA, shopId: SHOP_ID, env: 'production' };
  },
};

// Tình huống chính của tool: người dùng chưa biết ShopId nên chưa điền GHN_SHOP_ID.
const providerKhongShopId: CredentialProvider = {
  async getCredentials() {
    return { token: TOKEN_GIA, env: 'production' };
  },
};

function taoContext(ghn: GhnGateway): ToolContext {
  return {
    credentials: { token: TOKEN_GIA, shopId: SHOP_ID, env: 'production' },
    tier: 'all',
    requestId: 'req_abcdef',
    logger: { info() {}, warn() {}, error() {} },
    services: { ghn },
  };
}

interface GhnCall {
  endpoint: string;
  payload: Record<string, unknown>;
}

// Cổng GHN giả: ghi tham số và dùng chính responseSchema của tool để kiểm dữ liệu giả.
function taoGhnGia(data: unknown): { ghn: GhnGateway; calls: GhnCall[] } {
  const calls: GhnCall[] = [];
  const ghn: GhnGateway = {
    async request(endpoint, payload, responseSchema) {
      calls.push({ endpoint, payload: { ...payload } });
      return responseSchema.parse(data);
    },
  };
  return { ghn, calls };
}

function duLieuShopDayDu(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: SHOP_ID,
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

function okBody(data: unknown): Record<string, unknown> {
  return { code: 200, data };
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

interface FakeLogCall {
  level: 'info' | 'warn' | 'error';
  fields: Record<string, unknown>;
}

function taoFakeLogger(): { logger: ToolLogger; calls: FakeLogCall[] } {
  const calls: FakeLogCall[] = [];
  const ghi =
    (level: FakeLogCall['level']) =>
    (fields: Record<string, unknown>): void => {
      calls.push({ level, fields: { ...fields } });
    };
  return { logger: { info: ghi('info'), warn: ghi('warn'), error: ghi('error') }, calls };
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup().catch(() => undefined);
  }
});

async function setupPipeline(
  ghn: GhnGateway,
  credentials: CredentialProvider = provider,
): Promise<{ client: Client; calls: FakeLogCall[] }> {
  const registry = createToolRegistry();
  registry.register(getOrderDetailTool);
  registry.register(getShopsTool);
  const { logger, calls } = taoFakeLogger();
  const server = createMcpServer({
    registry,
    credentials,
    ghn,
    license: new AllowAll(),
    logger,
    serverInfo: { name: 'test-server', version: '0.0.0' },
    now: () => 100,
    newRequestId: () => 'req_abcdef',
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, calls };
}

function docKetQua(result: unknown): { payload: Record<string, unknown>; isError: boolean } {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  const first = content?.[0];
  if (first === undefined || first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error('Mong đợi nội dung text trong kết quả tool');
  }
  return {
    payload: JSON.parse(first.text) as Record<string, unknown>,
    isError: (result as { isError?: boolean }).isError === true,
  };
}

function taoClient(credentials: CredentialProvider = provider) {
  return createGhnClient({ credentials, sleep: async () => {} });
}

describe('ghn_get_shops: cổng GHN giả', () => {
  it('gọi đúng endpoint /v2/shop/all với payload rỗng, trả đúng hợp đồng', async () => {
    const { ghn, calls } = taoGhnGia({ shops: [duLieuShopDayDu()] });
    const input = getShopsTool.inputSchema.parse({});

    const result = (await getShopsTool.handler(input, taoContext(ghn))) as GetShopsResult;

    expect(calls).toEqual([{ endpoint: '/v2/shop/all', payload: {} }]);
    expect(result).toEqual({
      shops: [
        {
          shop_id: SHOP_ID,
          name: 'Shop Gia A',
          district_id: 1442,
          ward_code: '20308',
          status: 1,
        },
      ],
    });
  });

  it('allowlist: không lộ SĐT, địa chỉ hay trường lạ', async () => {
    const { ghn } = taoGhnGia({ shops: [duLieuShopDayDu()] });

    const result = (await getShopsTool.handler(
      getShopsTool.inputSchema.parse({}),
      taoContext(ghn),
    )) as GetShopsResult;

    const json = JSON.stringify(result);
    for (const sentinel of SENTINELS) {
      expect(json).not.toContain(sentinel);
    }
    expect(Object.keys(result.shops[0] ?? {}).sort()).toEqual([
      'district_id',
      'name',
      'shop_id',
      'status',
      'ward_code',
    ]);
  });

  it('danh sách rỗng là kết quả hợp lệ', async () => {
    const { ghn } = taoGhnGia({ shops: [] });

    const result = (await getShopsTool.handler(
      getShopsTool.inputSchema.parse({}),
      taoContext(ghn),
    )) as GetShopsResult;

    expect(result).toEqual({ shops: [] });
  });
});

describe('ghn_get_shops: qua createGhnClient + mock-fetch', () => {
  it('GET đúng URL, gửi header Token, kết quả chỉ có allowlist', async () => {
    const mock = installMockFetch([
      {
        url: SHOPS_URL,
        method: 'GET',
        body: okBody({ shops: [duLieuShopDayDu()] }),
      },
    ]);

    const result = (await getShopsTool.handler(
      getShopsTool.inputSchema.parse({}),
      taoContext(taoClient()),
    )) as GetShopsResult;

    expect(result.shops).toHaveLength(1);
    const json = JSON.stringify(result);
    for (const sentinel of SENTINELS) {
      expect(json).not.toContain(sentinel);
    }
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.url).toBe(SHOPS_URL);
    expect(mock.calls[0]?.method).toBe('GET');
    expect(mock.calls[0]?.headers['token']).toBe(TOKEN_GIA);
  });

  it('shops vắng hoặc null → { shops: [] }', async () => {
    for (const data of [{}, { shops: null }]) {
      const mock = installMockFetch([{ url: SHOPS_URL, method: 'GET', body: okBody(data) }]);

      const result = (await getShopsTool.handler(
        getShopsTool.inputSchema.parse({}),
        taoContext(taoClient()),
      )) as GetShopsResult;

      expect(result).toEqual({ shops: [] });
      mock.restore();
    }
  });

  it('nhiều shop: giữ đúng thứ tự GHN trả', async () => {
    installMockFetch([
      {
        url: SHOPS_URL,
        method: 'GET',
        body: okBody({
          shops: [
            duLieuShopDayDu({ _id: 3, name: 'Shop C' }),
            duLieuShopDayDu({ _id: 1, name: 'Shop A' }),
            duLieuShopDayDu({ _id: 2, name: 'Shop B' }),
          ],
        }),
      },
    ]);

    const result = (await getShopsTool.handler(
      getShopsTool.inputSchema.parse({}),
      taoContext(taoClient()),
    )) as GetShopsResult;

    expect(result.shops.map((shop) => shop.name)).toEqual(['Shop C', 'Shop A', 'Shop B']);
  });

  it('shop mới đăng ký (district_id 0, ward_code "") vẫn nhận, 2 shop đều trả về', async () => {
    installMockFetch([
      {
        url: SHOPS_URL,
        method: 'GET',
        body: okBody({
          shops: [
            duLieuShopDayDu({
              _id: 1000001,
              name: 'Shop Moi',
              district_id: 0,
              ward_code: '',
            }),
            duLieuShopDayDu({
              _id: 1000002,
              name: 'Shop Du',
              district_id: 1442,
              ward_code: '20308',
            }),
          ],
        }),
      },
    ]);

    const result = (await getShopsTool.handler(
      getShopsTool.inputSchema.parse({}),
      taoContext(taoClient()),
    )) as GetShopsResult;

    expect(result.shops).toEqual([
      { shop_id: 1000001, name: 'Shop Moi', district_id: null, ward_code: null, status: 1 },
      {
        shop_id: 1000002,
        name: 'Shop Du',
        district_id: 1442,
        ward_code: '20308',
        status: 1,
      },
    ]);
    const json = JSON.stringify(result);
    expect(json).not.toContain('0900000000');
    expect(json).not.toContain('99 Duong Gia, Quan Gia');
  });

  it('shop sai dạng không làm hỏng danh sách: 3 shop, giá trị dự phòng đúng', async () => {
    installMockFetch([
      {
        url: SHOPS_URL,
        method: 'GET',
        body: okBody({
          shops: [
            duLieuShopDayDu({ _id: 1000001, name: '', status: 1.5, ward_code: 123 }),
            duLieuShopDayDu({
              _id: 1000002,
              name: 'Shop Du',
              district_id: 1442,
              ward_code: '20308',
              status: 1,
            }),
            duLieuShopDayDu({ _id: 1000003, name: 'Shop Moi', district_id: 0, ward_code: '' }),
          ],
        }),
      },
    ]);

    const result = (await getShopsTool.handler(
      getShopsTool.inputSchema.parse({}),
      taoContext(taoClient()),
    )) as GetShopsResult;

    expect(result.shops).toEqual([
      {
        shop_id: 1000001,
        name: '(không tên)',
        district_id: 1442,
        ward_code: null,
        status: null,
      },
      {
        shop_id: 1000002,
        name: 'Shop Du',
        district_id: 1442,
        ward_code: '20308',
        status: 1,
      },
      { shop_id: 1000003, name: 'Shop Moi', district_id: null, ward_code: null, status: 1 },
    ]);
    const json = JSON.stringify(result);
    expect(json).not.toContain('0900000000');
    expect(json).not.toContain('99 Duong Gia, Quan Gia');
  });

  it('một phần tử _id sai ("abc") → cả phản hồi GHN_UNEXPECTED_RESPONSE', async () => {
    installMockFetch([
      {
        url: SHOPS_URL,
        method: 'GET',
        body: okBody({
          shops: [
            duLieuShopDayDu({ _id: 1000001, name: 'Shop A' }),
            duLieuShopDayDu({ _id: 'abc', name: 'Shop B' }),
            duLieuShopDayDu({ _id: 1000003, name: 'Shop C' }),
          ],
        }),
      },
    ]);

    const error = await batAppError(
      getShopsTool.handler(getShopsTool.inputSchema.parse({}), taoContext(taoClient())),
    );

    expect(error.code).toBe('GHN_UNEXPECTED_RESPONSE');
    expect(error.messageEn).toContain('shops.1._id');
    expect(error.messageEn).not.toContain('abc');
  });

  it('cấu hình KHÔNG có ShopId vẫn gọi được; request không gửi header ShopId', async () => {
    const mock = installMockFetch([
      { url: SHOPS_URL, method: 'GET', body: okBody({ shops: [duLieuShopDayDu()] }) },
    ]);

    const result = (await getShopsTool.handler(
      getShopsTool.inputSchema.parse({}),
      taoContext(taoClient(providerKhongShopId)),
    )) as GetShopsResult;

    expect(result.shops).toHaveLength(1);
    expect(mock.calls).toHaveLength(1);
    expect(Object.keys(mock.calls[0]?.headers ?? {})).not.toContain('shopid');
  });

  it('cấu hình CÓ ShopId thì request gửi header ShopId', async () => {
    const mock = installMockFetch([
      { url: SHOPS_URL, method: 'GET', body: okBody({ shops: [duLieuShopDayDu()] }) },
    ]);

    await getShopsTool.handler(getShopsTool.inputSchema.parse({}), taoContext(taoClient()));

    expect(mock.calls[0]?.headers['shopid']).toBe(String(SHOP_ID));
  });

  it('thiếu token (chuỗi rỗng) → CONFIG_MISSING, không gọi mạng', async () => {
    const mock = installMockFetch([]);
    const providerKhongToken: CredentialProvider = {
      async getCredentials() {
        return { token: '', env: 'production' };
      },
    };

    const error = await batAppError(
      getShopsTool.handler(
        getShopsTool.inputSchema.parse({}),
        taoContext(taoClient(providerKhongToken)),
      ),
    );

    expect(error.code).toBe('CONFIG_MISSING');
    expect(error.messageVi).toContain('GHN_TOKEN');
    expect(mock.calls).toHaveLength(0);
  });

  it('data null hoặc vắng → { shops: [] }, không phải lỗi', async () => {
    for (const body of [{ code: 200, data: null }, { code: 200 }]) {
      const mock = installMockFetch([{ url: SHOPS_URL, method: 'GET', body }]);

      const result = (await getShopsTool.handler(
        getShopsTool.inputSchema.parse({}),
        taoContext(taoClient()),
      )) as GetShopsResult;

      expect(result).toEqual({ shops: [] });
      mock.restore();
    }
  });

  it.each([
    { nhan: 'chuỗi', giaTri: 'GIA-TRI-LA' },
    { nhan: 'số', giaTri: 5 },
    { nhan: 'mảng', giaTri: [] },
  ])('data là $nhan → GHN_UNEXPECTED_RESPONSE, không lộ giá trị GHN', async ({ giaTri }) => {
    installMockFetch([{ url: SHOPS_URL, method: 'GET', body: { code: 200, data: giaTri } }]);

    const error = await batAppError(
      getShopsTool.handler(getShopsTool.inputSchema.parse({}), taoContext(taoClient())),
    );

    expect(error.code).toBe('GHN_UNEXPECTED_RESPONSE');
    const text = `${error.messageVi} ${error.messageEn} ${JSON.stringify(error)}`;
    expect(text).not.toContain('GIA-TRI-LA');
  });

  it.each([
    { nhan: 'chuỗi', giaTri: 'GIA-TRI-LA' },
    { nhan: 'số', giaTri: 5 },
    { nhan: 'object', giaTri: {} },
  ])('shops là $nhan → GHN_UNEXPECTED_RESPONSE, không lộ giá trị GHN', async ({ giaTri }) => {
    installMockFetch([{ url: SHOPS_URL, method: 'GET', body: okBody({ shops: giaTri }) }]);

    const error = await batAppError(
      getShopsTool.handler(getShopsTool.inputSchema.parse({}), taoContext(taoClient())),
    );

    expect(error.code).toBe('GHN_UNEXPECTED_RESPONSE');
    const text = `${error.messageVi} ${error.messageEn} ${JSON.stringify(error)}`;
    expect(text).not.toContain('GIA-TRI-LA');
  });
});

describe('ghn_get_shops: pipeline thật', () => {
  it('tools/list thấy đúng 2 tool; JSON Schema ghn_get_shops là object rỗng, không thêm khóa', async () => {
    const { client } = await setupPipeline(taoClient());

    const listed = await client.listTools();

    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      'ghn_get_order_detail',
      'ghn_get_shops',
    ]);
    const shopsTool = listed.tools.find((tool) => tool.name === 'ghn_get_shops');
    const schema = shopsTool?.inputSchema as {
      type?: string;
      properties?: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties ?? {})).toEqual([]);
  });

  it('tools/call thành công trả {ok, data.shops, meta}; log không chứa tên shop/SĐT/địa chỉ', async () => {
    installMockFetch([
      { url: SHOPS_URL, method: 'GET', body: okBody({ shops: [duLieuShopDayDu()] }) },
    ]);
    const { client, calls } = await setupPipeline(taoClient());

    const { payload, isError } = docKetQua(
      await client.callTool({ name: 'ghn_get_shops', arguments: {} }),
    );

    expect(isError).toBe(false);
    expect(payload['ok']).toBe(true);
    expect(payload['data']).toEqual({
      shops: [
        {
          shop_id: SHOP_ID,
          name: 'Shop Gia A',
          district_id: 1442,
          ward_code: '20308',
          status: 1,
        },
      ],
    });
    expect(payload['meta']).toMatchObject({ requestId: 'req_abcdef' });
    expect(typeof (payload['meta'] as { tookMs?: unknown }).tookMs).toBe('number');

    expect(calls).toHaveLength(1);
    const fields = calls[0]?.fields ?? {};
    const allowed = new Set(['tool', 'code', 'ms', 'httpStatus', 'requestId', 'event']);
    for (const key of Object.keys(fields)) {
      expect(allowed.has(key)).toBe(true);
    }
    const logJson = JSON.stringify(fields);
    expect(logJson).not.toContain('Shop Gia A');
    for (const sentinel of SENTINELS) {
      expect(logJson).not.toContain(sentinel);
    }
  });

  it('pipeline: không có ShopId vẫn chạy được, request không gửi header ShopId', async () => {
    const mock = installMockFetch([
      { url: SHOPS_URL, method: 'GET', body: okBody({ shops: [duLieuShopDayDu()] }) },
    ]);
    const { client } = await setupPipeline(taoClient(providerKhongShopId), providerKhongShopId);

    const { payload, isError } = docKetQua(
      await client.callTool({ name: 'ghn_get_shops', arguments: {} }),
    );

    expect(isError).toBe(false);
    expect(payload['ok']).toBe(true);
    expect(Object.keys(mock.calls[0]?.headers ?? {})).not.toContain('shopid');
  });

  it('pipeline: shop mới đăng ký (district_id 0, ward_code "") trả ok:true', async () => {
    installMockFetch([
      {
        url: SHOPS_URL,
        method: 'GET',
        body: okBody({
          shops: [
            duLieuShopDayDu({
              _id: 1000001,
              name: 'Shop Moi',
              district_id: 0,
              ward_code: '',
            }),
          ],
        }),
      },
    ]);
    const { client } = await setupPipeline(taoClient());

    const { payload, isError } = docKetQua(
      await client.callTool({ name: 'ghn_get_shops', arguments: {} }),
    );

    expect(isError).toBe(false);
    expect(payload['ok']).toBe(true);
    expect(payload['data']).toEqual({
      shops: [
        { shop_id: 1000001, name: 'Shop Moi', district_id: null, ward_code: null, status: 1 },
      ],
    });
  });

  it('khóa lạ trong đầu vào ({"shop_id": 1}) → VALIDATION_ERROR, KHÔNG gọi GHN', async () => {
    const mock = installMockFetch([]);
    const { client } = await setupPipeline(taoClient());

    const { payload, isError } = docKetQua(
      await client.callTool({ name: 'ghn_get_shops', arguments: { shop_id: 1 } }),
    );

    expect(isError).toBe(true);
    expect(payload['error']).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(mock.calls).toHaveLength(0);
  });
});

describe('ghn_get_shops: lỗi qua pipeline (mock-fetch)', () => {
  function taoClientTimeout() {
    return createGhnClient({ credentials: provider, sleep: async () => {}, timeoutMs: 10 });
  }

  it('401, 403, 429, 5xx, timeout: đúng mã và retryable', async () => {
    const { client } = await setupPipeline(taoClientTimeout());
    const cases: Array<{
      nhan: string;
      routes: Parameters<typeof installMockFetch>[0];
      code: string;
      retryable: boolean;
      calls: number;
    }> = [
      {
        nhan: '401',
        routes: [{ url: SHOPS_URL, method: 'GET', status: 401 }],
        code: 'GHN_UNAUTHORIZED',
        retryable: false,
        calls: 1,
      },
      {
        nhan: '403',
        routes: [{ url: SHOPS_URL, method: 'GET', status: 403 }],
        code: 'GHN_BAD_REQUEST',
        retryable: false,
        calls: 1,
      },
      {
        nhan: '429',
        routes: [{ url: SHOPS_URL, method: 'GET', status: 429 }],
        code: 'GHN_RATE_LIMITED',
        retryable: true,
        calls: 1,
      },
      {
        nhan: '5xx hai lần',
        routes: [
          {
            url: SHOPS_URL,
            method: 'GET',
            responses: [
              { status: 500, body: 'lỗi' },
              { status: 500, body: 'lỗi' },
            ],
          },
        ],
        code: 'GHN_SERVER_ERROR',
        retryable: true,
        calls: 2,
      },
      {
        nhan: 'timeout',
        routes: [{ url: SHOPS_URL, method: 'GET', hang: true }],
        code: 'GHN_TIMEOUT',
        retryable: true,
        calls: 2,
      },
    ];

    for (const item of cases) {
      const mock = installMockFetch(item.routes);
      const { payload } = docKetQua(
        await client.callTool({ name: 'ghn_get_shops', arguments: {} }),
      );
      mock.restore();

      expect(payload['error'], item.nhan).toMatchObject({
        code: item.code,
        retryable: item.retryable,
      });
      expect(mock.countCalls(SHOPS_URL, 'GET'), item.nhan).toBe(item.calls);
    }
  });
});
