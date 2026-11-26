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
import { getFeeTool, type FeeResult } from '../../../src/tools/ghn/get-fee.js';
import { getOrderDetailTool } from '../../../src/tools/ghn/get-order-detail.js';
import { getShopsTool } from '../../../src/tools/ghn/get-shops.js';
import { createToolRegistry } from '../../../src/tools/registry.js';
import { parseInput } from '../../../src/utils/validator.js';
import { installMockFetch } from '../../helpers/mock-fetch.js';

const TOKEN_GIA = 'TOKEN-GIA-123';
const SHOP_ID = 999999;
const FEE_URL = `${getBaseUrl('production')}/v2/shipping-order/fee`;
const FROM_DISTRICT_ID = 1442;
const TO_DISTRICT_ID = 1444;
const TO_WARD_CODE = '20308';
const WEIGHT = 1000;

// Các khoản phí GHN khác + trường lạ: KHÔNG được lộ ra kết quả tool.
const SENTINELS_PHI = ['111111', '222222', '333333', '444444', 'GIA-TRI-LA'];

const INPUT_TOI_THIEU = {
  from_district_id: FROM_DISTRICT_ID,
  to_district_id: TO_DISTRICT_ID,
  to_ward_code: TO_WARD_CODE,
  weight: WEIGHT,
};

const PAYLOAD_TOI_THIEU = {
  ...INPUT_TOI_THIEU,
  service_type_id: 2,
  length: 20,
  width: 15,
  height: 10,
  insurance_value: 0,
  service_id: 0,
  cod_failed_to_return: 0,
  coupon: null,
};

const provider: CredentialProvider = {
  async getCredentials() {
    return { token: TOKEN_GIA, shopId: SHOP_ID, env: 'production' };
  },
};

const providerKhongShopId: CredentialProvider = {
  async getCredentials() {
    return { token: TOKEN_GIA, env: 'production' };
  },
};

function taoClient(credentials: CredentialProvider = provider) {
  return createGhnClient({ credentials, sleep: async () => {} });
}

function taoContext(
  ghn: GhnGateway,
  credentials: ToolContext['credentials'] = {
    token: TOKEN_GIA,
    shopId: SHOP_ID,
    env: 'production',
  },
): ToolContext {
  return {
    credentials,
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

function duLieuPhiDayDu(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    total: 32000,
    service_fee: 32000,
    insurance_fee: 0,
    pick_station_fee: 111111,
    coupon_value: 222222,
    r2s_fee: 333333,
    cod_fee: 444444,
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

// Chạy parseInput như server làm; trả AppError VALIDATION_ERROR nếu đầu vào sai.
function loiValidate(input: unknown): AppError {
  try {
    parseInput(getFeeTool.inputSchema, input);
  } catch (error) {
    if (error instanceof AppError) {
      return error;
    }
    throw error;
  }
  throw new Error('Mong đợi VALIDATION_ERROR nhưng dữ liệu đã hợp lệ');
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
  registry.register(getFeeTool);
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

describe('ghn_get_fee: đầu vào', () => {
  it('tối thiểu 4 trường → payload đúng giá trị mặc định', async () => {
    const { ghn, calls } = taoGhnGia(duLieuPhiDayDu());
    const input = getFeeTool.inputSchema.parse(INPUT_TOI_THIEU);

    const result = (await getFeeTool.handler(input, taoContext(ghn))) as FeeResult;

    expect(calls).toEqual([{ endpoint: '/v2/shipping-order/fee', payload: PAYLOAD_TOI_THIEU }]);
    expect(result).toEqual({
      total_fee: 32000,
      service_fee: 32000,
      insurance_fee: 0,
      currency: 'VND',
      service_type_id: 2,
    });
  });

  it('đầy đủ trường → dùng giá trị người dùng, echo service_type_id', async () => {
    const { ghn, calls } = taoGhnGia(duLieuPhiDayDu());
    const input = getFeeTool.inputSchema.parse({
      ...INPUT_TOI_THIEU,
      weight: 2000,
      service_type_id: 5,
      length: 30,
      width: 25,
      height: 20,
      insurance_value: 5000,
    });

    const result = (await getFeeTool.handler(input, taoContext(ghn))) as FeeResult;

    expect(calls[0]?.payload).toEqual({
      from_district_id: FROM_DISTRICT_ID,
      to_district_id: TO_DISTRICT_ID,
      to_ward_code: TO_WARD_CODE,
      weight: 2000,
      service_type_id: 5,
      length: 30,
      width: 25,
      height: 20,
      insurance_value: 5000,
      service_id: 0,
      cod_failed_to_return: 0,
      coupon: null,
    });
    expect(result.service_type_id).toBe(5);
  });

  it.each([
    { nhan: 'weight 0', patch: { weight: 0 } },
    { nhan: 'weight âm', patch: { weight: -1 } },
    { nhan: 'weight thập phân', patch: { weight: 1.5 } },
    { nhan: 'weight chuỗi', patch: { weight: '1000' } },
    { nhan: 'weight NaN', patch: { weight: Number.NaN } },
    { nhan: 'from_district_id 0', patch: { from_district_id: 0 } },
    { nhan: 'from_district_id âm', patch: { from_district_id: -1 } },
    { nhan: 'from_district_id chuỗi', patch: { from_district_id: '1442' } },
    { nhan: 'from_district_id thập phân', patch: { from_district_id: 1.5 } },
    { nhan: 'to_district_id 0', patch: { to_district_id: 0 } },
    { nhan: 'to_district_id âm', patch: { to_district_id: -1 } },
    { nhan: 'to_district_id chuỗi', patch: { to_district_id: '1444' } },
    { nhan: 'to_district_id thập phân', patch: { to_district_id: 1.5 } },
    { nhan: 'to_ward_code rỗng', patch: { to_ward_code: '' } },
    { nhan: 'to_ward_code ký tự lạ', patch: { to_ward_code: '20A-3' } },
    { nhan: 'to_ward_code quá dài', patch: { to_ward_code: '2'.repeat(21) } },
    { nhan: 'to_ward_code số', patch: { to_ward_code: 20308 } },
    { nhan: 'service_type_id 0', patch: { service_type_id: 0 } },
    { nhan: 'service_type_id 1', patch: { service_type_id: 1 } },
    { nhan: 'service_type_id 3', patch: { service_type_id: 3 } },
    { nhan: 'service_type_id 2.5', patch: { service_type_id: 2.5 } },
    { nhan: 'service_type_id null', patch: { service_type_id: null } },
    { nhan: 'service_type_id chuỗi', patch: { service_type_id: '2' } },
    { nhan: 'length 0', patch: { length: 0 } },
    { nhan: 'length âm', patch: { length: -1 } },
    { nhan: 'length 201', patch: { length: 201 } },
    { nhan: 'width 0', patch: { width: 0 } },
    { nhan: 'height 201', patch: { height: 201 } },
    { nhan: 'insurance_value âm', patch: { insurance_value: -1 } },
    { nhan: 'insurance_value thập phân', patch: { insurance_value: 1.5 } },
    { nhan: 'khóa lạ to_name', patch: { to_name: 'Nguyen Van Gia' } },
  ])('đầu vào sai ($nhan) → VALIDATION_ERROR, KHÔNG gọi GHN', ({ patch }) => {
    const { calls } = taoGhnGia(duLieuPhiDayDu());

    const error = loiValidate({ ...INPUT_TOI_THIEU, ...patch });

    expect(error.code).toBe('VALIDATION_ERROR');
    expect(calls).toHaveLength(0);
  });

  it.each(['from_district_id', 'to_district_id', 'to_ward_code', 'weight'])(
    'thiếu %s → VALIDATION_ERROR',
    (field) => {
      const input: Record<string, unknown> = { ...INPUT_TOI_THIEU };
      delete input[field];

      const error = loiValidate(input);

      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.issues?.[0]?.field).toBe(field);
    },
  );

  it('thông báo lỗi không chứa giá trị người dùng nhập', () => {
    const error = loiValidate({ ...INPUT_TOI_THIEU, to_ward_code: 'GIA-TRI-LA' });

    const text = `${error.messageVi} ${error.messageEn} ${JSON.stringify(error)}`;
    expect(text).not.toContain('GIA-TRI-LA');
  });
});

describe('ghn_get_fee: cổng GHN giả', () => {
  it('allowlist: không lộ khoản phí khác hay trường lạ', async () => {
    const { ghn } = taoGhnGia(duLieuPhiDayDu());
    const input = getFeeTool.inputSchema.parse(INPUT_TOI_THIEU);

    const result = (await getFeeTool.handler(input, taoContext(ghn))) as FeeResult;
    const json = JSON.stringify(result);

    for (const sentinel of SENTINELS_PHI) {
      expect(json).not.toContain(sentinel);
    }
    expect(Object.keys(result).sort()).toEqual([
      'currency',
      'insurance_fee',
      'service_fee',
      'service_type_id',
      'total_fee',
    ]);
  });

  it('service_fee/insurance_fee vắng → null', async () => {
    const { ghn } = taoGhnGia({ total: 32000 });

    const result = (await getFeeTool.handler(
      getFeeTool.inputSchema.parse(INPUT_TOI_THIEU),
      taoContext(ghn),
    )) as FeeResult;

    expect(result.total_fee).toBe(32000);
    expect(result.service_fee).toBeNull();
    expect(result.insurance_fee).toBeNull();
  });
});

describe('ghn_get_fee: qua createGhnClient + mock-fetch', () => {
  it('POST đúng URL, header Token/JSON, thân đúng payload, kết quả allowlist', async () => {
    const mock = installMockFetch([
      { url: FEE_URL, method: 'POST', body: okBody(duLieuPhiDayDu()) },
    ]);

    const result = (await getFeeTool.handler(
      getFeeTool.inputSchema.parse(INPUT_TOI_THIEU),
      taoContext(taoClient()),
    )) as FeeResult;

    expect(result.total_fee).toBe(32000);
    const json = JSON.stringify(result);
    for (const sentinel of SENTINELS_PHI) {
      expect(json).not.toContain(sentinel);
    }
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.url).toBe(FEE_URL);
    expect(mock.calls[0]?.method).toBe('POST');
    expect(mock.calls[0]?.headers['token']).toBe(TOKEN_GIA);
    expect(mock.calls[0]?.headers['content-type']).toBe('application/json');
    expect(mock.calls[0]?.body).toEqual(PAYLOAD_TOI_THIEU);
  });

  it('cấu hình KHÔNG có ShopId → CONFIG_MISSING, KHÔNG gọi GHN', async () => {
    const mock = installMockFetch([]);
    const { ghn, calls } = taoGhnGia(duLieuPhiDayDu());

    const error = await batAppError(
      getFeeTool.handler(
        getFeeTool.inputSchema.parse(INPUT_TOI_THIEU),
        taoContext(ghn, { token: TOKEN_GIA, env: 'production' }),
      ),
    );

    expect(error.code).toBe('CONFIG_MISSING');
    expect(error.messageVi).toContain('GHN_SHOP_ID');
    const text = `${error.messageVi} ${error.messageEn} ${JSON.stringify(error)}`;
    for (const value of ['1442', '1444', '20308', '1000', String(SHOP_ID)]) {
      expect(text).not.toContain(value);
    }
    expect(calls).toHaveLength(0);
    expect(mock.calls).toHaveLength(0);
  });

  it('cấu hình CÓ ShopId thì request gửi header ShopId', async () => {
    const mock = installMockFetch([
      { url: FEE_URL, method: 'POST', body: okBody(duLieuPhiDayDu()) },
    ]);

    await getFeeTool.handler(
      getFeeTool.inputSchema.parse(INPUT_TOI_THIEU),
      taoContext(taoClient()),
    );

    expect(mock.calls[0]?.headers['shopid']).toBe(String(SHOP_ID));
  });
});

describe('ghn_get_fee: kiểu số tiền (createGhnClient + mock-fetch)', () => {
  function goiVoi(body: unknown): Promise<unknown> {
    installMockFetch([{ url: FEE_URL, method: 'POST', body }]);
    return getFeeTool.handler(
      getFeeTool.inputSchema.parse(INPUT_TOI_THIEU),
      taoContext(taoClient()),
    );
  }

  it.each([
    { nhan: 'số 0', giaTri: 0, mongDoi: 0 },
    { nhan: 'số 32000', giaTri: 32000, mongDoi: 32000 },
    { nhan: 'chuỗi "32000"', giaTri: '32000', mongDoi: 32000 },
  ])('total hợp lệ ($nhan) → $mongDoi', async ({ giaTri, mongDoi }) => {
    const result = (await goiVoi(
      okBody(duLieuPhiDayDu({ total: giaTri, service_fee: null, insurance_fee: null })),
    )) as FeeResult;

    expect(result.total_fee).toBe(mongDoi);
  });

  it.each([
    { nhan: 'thiếu', giaTri: undefined },
    { nhan: 'null', giaTri: null },
    { nhan: 'chuỗi rỗng', giaTri: '' },
    { nhan: 'false', giaTri: false },
    { nhan: 'mảng rỗng', giaTri: [] },
    { nhan: 'true', giaTri: true },
    { nhan: 'số âm', giaTri: -1 },
    { nhan: 'thập phân', giaTri: 1.5 },
    { nhan: 'vượt số nguyên an toàn', giaTri: Number.MAX_SAFE_INTEGER + 1 },
    { nhan: 'chuỗi ký tự lạ', giaTri: 'GIA-TRI-LA' },
  ])('total không hợp lệ ($nhan) → GHN_UNEXPECTED_RESPONSE', async ({ giaTri }) => {
    const error = await batAppError(
      goiVoi(okBody(duLieuPhiDayDu({ total: giaTri, service_fee: null, insurance_fee: null }))),
    );

    expect(error.code).toBe('GHN_UNEXPECTED_RESPONSE');
    const text = `${error.messageVi} ${error.messageEn} ${JSON.stringify(error)}`;
    expect(text).not.toContain('GIA-TRI-LA');
  });

  it('total Infinity (JSON 1e999) → GHN_UNEXPECTED_RESPONSE', async () => {
    const raw = '{"code":200,"data":{"total":1e999,"service_fee":32000,"insurance_fee":0}}';

    const error = await batAppError(goiVoi(raw));

    expect(error.code).toBe('GHN_UNEXPECTED_RESPONSE');
  });

  it('service_fee/insurance_fee vắng hoặc null → null; chuỗi số được đổi sang number', async () => {
    const khongCo = (await goiVoi(okBody({ total: 32000 }))) as FeeResult;
    expect(khongCo.service_fee).toBeNull();
    expect(khongCo.insurance_fee).toBeNull();

    const coChuoi = (await goiVoi(
      okBody({ total: 32000, service_fee: '32000', insurance_fee: '0' }),
    )) as FeeResult;
    expect(coChuoi.service_fee).toBe(32000);
    expect(coChuoi.insurance_fee).toBe(0);
  });

  it.each([
    { nhan: 'service_fee false', data: { total: 32000, service_fee: false } },
    { nhan: 'insurance_fee mảng', data: { total: 32000, insurance_fee: [] } },
    { nhan: 'service_fee chuỗi rỗng', data: { total: 32000, service_fee: '' } },
  ])('$nhan → GHN_UNEXPECTED_RESPONSE', async ({ data }) => {
    const error = await batAppError(goiVoi(okBody(data)));

    expect(error.code).toBe('GHN_UNEXPECTED_RESPONSE');
  });

  it.each([
    { nhan: 'null', giaTri: null },
    { nhan: 'chuỗi', giaTri: 'GIA-TRI-LA' },
    { nhan: 'mảng', giaTri: [] },
  ])('data là $nhan → GHN_UNEXPECTED_RESPONSE', async ({ giaTri }) => {
    installMockFetch([{ url: FEE_URL, method: 'POST', body: { code: 200, data: giaTri } }]);

    const error = await batAppError(
      getFeeTool.handler(getFeeTool.inputSchema.parse(INPUT_TOI_THIEU), taoContext(taoClient())),
    );

    expect(error.code).toBe('GHN_UNEXPECTED_RESPONSE');
    const text = `${error.messageVi} ${error.messageEn} ${JSON.stringify(error)}`;
    expect(text).not.toContain('GIA-TRI-LA');
  });
});

describe('ghn_get_fee: lỗi qua mock-fetch', () => {
  function taoClientTimeout() {
    return createGhnClient({ credentials: provider, sleep: async () => {}, timeoutMs: 10 });
  }

  it('401, 429, 5xx, timeout: đúng mã và retryable', async () => {
    const cases: Array<{
      nhan: string;
      routes: Parameters<typeof installMockFetch>[0];
      code: string;
      retryable: boolean;
      calls: number;
    }> = [
      {
        nhan: '401',
        routes: [{ url: FEE_URL, method: 'POST', status: 401 }],
        code: 'GHN_UNAUTHORIZED',
        retryable: false,
        calls: 1,
      },
      {
        nhan: '429',
        routes: [{ url: FEE_URL, method: 'POST', status: 429 }],
        code: 'GHN_RATE_LIMITED',
        retryable: true,
        calls: 1,
      },
      {
        nhan: '5xx hai lần',
        routes: [
          {
            url: FEE_URL,
            method: 'POST',
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
        routes: [{ url: FEE_URL, method: 'POST', hang: true }],
        code: 'GHN_TIMEOUT',
        retryable: true,
        calls: 2,
      },
    ];

    const ghn = taoClientTimeout();

    for (const item of cases) {
      const mock = installMockFetch(item.routes);
      const error = await batAppError(
        getFeeTool.handler(getFeeTool.inputSchema.parse(INPUT_TOI_THIEU), taoContext(ghn)),
      );
      mock.restore();

      expect(error.code, item.nhan).toBe(item.code);
      expect(error.retryable, item.nhan).toBe(item.retryable);
      expect(mock.countCalls(FEE_URL, 'POST'), item.nhan).toBe(item.calls);
    }
  });

  it.each([
    {
      nhan: 'route not found service',
      body: { code: 400, message: 'route not found service' },
      khongDuocLo: 'route not found service',
    },
    {
      nhan: 'SEND_WARD_IS_INVALID',
      body: { code: 400, code_message: 'SEND_WARD_IS_INVALID', message: 'to ward not found' },
      khongDuocLo: 'to ward not found',
    },
  ])(
    'GHN 400 ($nhan) → GHN_BAD_REQUEST, không lộ thông báo GHN thô',
    async ({ body, khongDuocLo }) => {
      installMockFetch([{ url: FEE_URL, method: 'POST', status: 400, body }]);

      const error = await batAppError(
        getFeeTool.handler(getFeeTool.inputSchema.parse(INPUT_TOI_THIEU), taoContext(taoClient())),
      );

      expect(error.code).toBe('GHN_BAD_REQUEST');
      const text = `${error.messageVi} ${error.messageEn} ${JSON.stringify(error)}`;
      expect(text).not.toContain(khongDuocLo);
      expect(text).not.toContain('SEND_WARD_IS_INVALID');
    },
  );
});

describe('ghn_get_fee: pipeline thật', () => {
  it('tools/list thấy đúng 3 tool; JSON Schema ghn_get_fee đúng trường và required', async () => {
    const { client } = await setupPipeline(taoClient());

    const listed = await client.listTools();

    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      'ghn_get_fee',
      'ghn_get_order_detail',
      'ghn_get_shops',
    ]);
    const feeTool = listed.tools.find((tool) => tool.name === 'ghn_get_fee');
    expect(feeTool?.description).toContain('ghn_get_shops');
    expect(feeTool?.description).toContain('Hàng nặng');
    expect(feeTool?.description).toContain('Hàng nhẹ');
    const schema = feeTool?.inputSchema as {
      type?: string;
      properties?: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
    };
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
      'from_district_id',
      'height',
      'insurance_value',
      'length',
      'service_type_id',
      'to_district_id',
      'to_ward_code',
      'weight',
      'width',
    ]);
    const properties = schema.properties as Record<
      string,
      { enum?: unknown; default?: unknown; type?: unknown }
    >;
    expect(properties['service_type_id']?.type).toBe('number');
    expect(properties['service_type_id']?.enum).toEqual([2, 5]);
    expect(properties['service_type_id']?.default).toBe(2);
    expect((schema.required ?? []).sort()).toEqual([
      'from_district_id',
      'to_district_id',
      'to_ward_code',
      'weight',
    ]);
  });

  it('tools/call thành công trả {ok, data, meta}; log không chứa mã/cân nặng/số tiền', async () => {
    installMockFetch([{ url: FEE_URL, method: 'POST', body: okBody(duLieuPhiDayDu()) }]);
    const { client, calls } = await setupPipeline(taoClient());

    const { payload, isError } = docKetQua(
      await client.callTool({ name: 'ghn_get_fee', arguments: INPUT_TOI_THIEU }),
    );

    expect(isError).toBe(false);
    expect(payload['ok']).toBe(true);
    expect(payload['data']).toEqual({
      total_fee: 32000,
      service_fee: 32000,
      insurance_fee: 0,
      currency: 'VND',
      service_type_id: 2,
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
    for (const value of ['1442', '1444', '20308', '1000', '32000']) {
      expect(logJson).not.toContain(value);
    }
  });

  it('pipeline: KHÔNG có GHN_SHOP_ID → CONFIG_MISSING, requestId trong meta, log allowlist', async () => {
    const mock = installMockFetch([]);
    const ghn = taoClient(providerKhongShopId);
    const { client, calls } = await setupPipeline(ghn, providerKhongShopId);

    const { payload, isError } = docKetQua(
      await client.callTool({ name: 'ghn_get_fee', arguments: INPUT_TOI_THIEU }),
    );

    expect(isError).toBe(true);
    expect(payload['ok']).toBe(false);
    expect(payload['error']).toMatchObject({ code: 'CONFIG_MISSING', retryable: false });
    const error = payload['error'] as { message: string };
    expect(error.message).toContain('GHN_SHOP_ID');
    const meta = payload['meta'] as { requestId: string; tookMs?: unknown };
    expect(meta.requestId).toBe('req_abcdef');
    expect(typeof meta.tookMs).toBe('number');
    expect(mock.calls).toHaveLength(0);

    expect(calls).toHaveLength(1);
    const fields = calls[0]?.fields ?? {};
    const allowed = new Set(['tool', 'code', 'ms', 'httpStatus', 'requestId', 'event']);
    for (const key of Object.keys(fields)) {
      expect(allowed.has(key)).toBe(true);
    }
    expect(fields['tool']).toBe('ghn_get_fee');
    expect(fields['code']).toBe('CONFIG_MISSING');
    expect(fields['requestId']).toBe('req_abcdef');
  });

  it.each([
    { nhan: 'weight 0', args: { ...INPUT_TOI_THIEU, weight: 0 } },
    {
      nhan: 'thiếu weight',
      args: { from_district_id: 1442, to_district_id: 1444, to_ward_code: '20308' },
    },
    { nhan: 'khóa lạ', args: { ...INPUT_TOI_THIEU, to_name: 'Nguyen Van Gia' } },
  ])('pipeline: đầu vào sai khi KHÔNG có ShopId ($nhan) → VALIDATION_ERROR', async ({ args }) => {
    const mock = installMockFetch([]);
    const { client } = await setupPipeline(taoClient(providerKhongShopId), providerKhongShopId);

    const { payload, isError } = docKetQua(
      await client.callTool({ name: 'ghn_get_fee', arguments: args }),
    );

    expect(isError).toBe(true);
    expect(payload['error']).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(mock.calls).toHaveLength(0);
  });

  it('đầu vào sai qua pipeline → isError true, VALIDATION_ERROR, KHÔNG gọi GHN', async () => {
    const mock = installMockFetch([]);
    const { client } = await setupPipeline(taoClient());

    const { payload, isError } = docKetQua(
      await client.callTool({
        name: 'ghn_get_fee',
        arguments: { ...INPUT_TOI_THIEU, weight: 0 },
      }),
    );

    expect(isError).toBe(true);
    expect(payload['error']).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(mock.calls).toHaveLength(0);
  });

  it.each([
    { nhan: 'weight 1e21', patch: { weight: 1e21 } },
    { nhan: 'insurance_value 1e30', patch: { insurance_value: 1e30 } },
  ])('pipeline: số cực lớn ($nhan) → VALIDATION_ERROR, KHÔNG gọi GHN', async ({ patch }) => {
    const mock = installMockFetch([]);
    const { client } = await setupPipeline(taoClient());

    const { payload, isError } = docKetQua(
      await client.callTool({
        name: 'ghn_get_fee',
        arguments: { ...INPUT_TOI_THIEU, ...patch },
      }),
    );

    expect(isError).toBe(true);
    expect(payload['error']).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(mock.calls).toHaveLength(0);
  });
});
