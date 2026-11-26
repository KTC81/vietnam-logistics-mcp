import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ZodError } from 'zod';
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
import {
  getOrderDetailTool,
  type OrderDetailResult,
} from '../../../src/tools/ghn/get-order-detail.js';
import { createToolRegistry } from '../../../src/tools/registry.js';
import { installMockFetch } from '../../helpers/mock-fetch.js';

const TOKEN_GIA = 'TOKEN-GIA-123';
const SHOP_ID = 999999;
const ORDER_CODE = 'G8AGIA123';
const DETAIL_URL = `${getBaseUrl('production')}/v2/shipping-order/detail`;

const SENTINELS = ['Nguyen Van Gia', '0900000000', '99 Duong Gia'];

const provider: CredentialProvider = {
  async getCredentials() {
    return { token: TOKEN_GIA, shopId: SHOP_ID, env: 'production' };
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

function duLieuGhnDayDu(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    order_code: ORDER_CODE,
    status: 'delivering',
    cod_amount: 350000,
    leadtime: '2026-11-13T17:00:00+07:00',
    updated_date: '2026-11-12T08:15:00+07:00',
    to_name: 'Nguyen Van Gia',
    to_phone: '0900000000',
    to_address: '99 Duong Gia, Quan Gia',
    from_name: 'Nguyen Van Gia',
    from_phone: '0900000000',
    from_address: '99 Duong Gia, Quan Gia',
    return_name: 'Nguyen Van Gia',
    return_phone: '0900000000',
    return_address: '99 Duong Gia, Quan Gia',
    client_order_code: 'CLIENT-GIA-123',
    items: [{ name: 'Hang gia', quantity: 1 }],
    log: [{ status: 'delivering' }],
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

async function setupPipeline(ghn: GhnGateway): Promise<{
  client: Client;
  calls: FakeLogCall[];
}> {
  const registry = createToolRegistry();
  registry.register(getOrderDetailTool);
  const { logger, calls } = taoFakeLogger();
  const server = createMcpServer({
    registry,
    credentials: provider,
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

describe('ghn_get_order_detail: cổng GHN giả', () => {
  it('gọi đúng endpoint với order_code đã trim và trả đủ 7 khóa allowlist', async () => {
    const { ghn, calls } = taoGhnGia(duLieuGhnDayDu());
    const input = getOrderDetailTool.inputSchema.parse({ order_code: `  ${ORDER_CODE}  ` });

    const result = (await getOrderDetailTool.handler(input, taoContext(ghn))) as OrderDetailResult;

    expect(calls).toEqual([
      { endpoint: '/v2/shipping-order/detail', payload: { order_code: ORDER_CODE } },
    ]);
    expect(result).toEqual({
      order_code: ORDER_CODE,
      status: 'delivering',
      status_vi: 'Đang giao hàng',
      cod_amount: 350000,
      expected_delivery_time: '2026-11-13T17:00:00+07:00',
      shipper: null,
      updated_at: '2026-11-12T08:15:00+07:00',
    });
    expect(Object.keys(result).sort()).toEqual(
      [
        'order_code',
        'status',
        'status_vi',
        'cod_amount',
        'expected_delivery_time',
        'shipper',
        'updated_at',
      ].sort(),
    );
  });

  it('allowlist: không lộ tên/SĐT/địa chỉ hay trường lạ', async () => {
    const { ghn } = taoGhnGia(duLieuGhnDayDu());

    const result = (await getOrderDetailTool.handler(
      { order_code: ORDER_CODE },
      taoContext(ghn),
    )) as OrderDetailResult;
    const json = JSON.stringify(result);

    for (const sentinel of [...SENTINELS, 'GIA-TRI-LA', 'CLIENT-GIA-123']) {
      expect(json).not.toContain(sentinel);
    }
  });

  it('trường tùy chọn vắng: COD 0, ngày null, shipper null', async () => {
    const { ghn } = taoGhnGia({ order_code: ORDER_CODE, status: 'picking' });

    const result = (await getOrderDetailTool.handler(
      { order_code: ORDER_CODE },
      taoContext(ghn),
    )) as OrderDetailResult;

    expect(result).toEqual({
      order_code: ORDER_CODE,
      status: 'picking',
      status_vi: 'Đang lấy hàng',
      cod_amount: 0,
      expected_delivery_time: null,
      shipper: null,
      updated_at: null,
    });
  });

  it('cod_amount dạng chuỗi số được chuyển thành số', async () => {
    const { ghn } = taoGhnGia({
      order_code: ORDER_CODE,
      status: 'delivered',
      cod_amount: '350000',
    });

    const result = (await getOrderDetailTool.handler(
      { order_code: ORDER_CODE },
      taoContext(ghn),
    )) as OrderDetailResult;

    expect(result.cod_amount).toBe(350000);
  });

  it('mã trạng thái lạ vẫn trả nhãn an toàn', async () => {
    const { ghn } = taoGhnGia({ order_code: ORDER_CODE, status: 'abc_status' });

    const result = (await getOrderDetailTool.handler(
      { order_code: ORDER_CODE },
      taoContext(ghn),
    )) as OrderDetailResult;

    expect(result.status_vi).toBe('Trạng thái khác (mã GHN: abc_status)');
  });
});

describe('ghn_get_order_detail: input schema', () => {
  it.each([
    { nhan: 'rỗng', value: '' },
    { nhan: 'toàn khoảng trắng', value: '    ' },
    { nhan: 'ký tự lạ', value: 'G8A-123' },
    { nhan: 'quá ngắn', value: 'G8A1' },
    { nhan: 'quá dài', value: 'G8AGIA123456789012345' },
    { nhan: 'không phải chuỗi', value: 123456 },
  ])('mã đơn $nhan bị từ chối', ({ value }) => {
    const result = getOrderDetailTool.inputSchema.safeParse({ order_code: value });

    expect(result.success).toBe(false);
  });

  it('cắt khoảng trắng đầu cuối', () => {
    const result = getOrderDetailTool.inputSchema.parse({ order_code: `  ${ORDER_CODE}  ` });

    expect(result.order_code).toBe(ORDER_CODE);
  });

  it('strict: khóa lạ bị từ chối', () => {
    const result = getOrderDetailTool.inputSchema.safeParse({
      order_code: ORDER_CODE,
      extra: 'Nguyen Van Gia',
    });

    expect(result.success).toBe(false);
  });
});

describe('ghn_get_order_detail: qua createGhnClient + mock-fetch', () => {
  function taoClient() {
    return createGhnClient({ credentials: provider, sleep: async () => {} });
  }

  it('thành công: Zod của client cắt trường thừa, handler trả allowlist', async () => {
    installMockFetch([
      {
        url: DETAIL_URL,
        query: { order_code: ORDER_CODE },
        method: 'GET',
        body: okBody(duLieuGhnDayDu()),
      },
    ]);

    const result = (await getOrderDetailTool.handler(
      { order_code: ORDER_CODE },
      taoContext(taoClient()),
    )) as OrderDetailResult;

    expect(result.order_code).toBe(ORDER_CODE);
    expect(result.status_vi).toBe('Đang giao hàng');
    const json = JSON.stringify(result);
    for (const sentinel of SENTINELS) {
      expect(json).not.toContain(sentinel);
    }
  });

  it('thiếu order_code trong phản hồi → GHN_UNEXPECTED_RESPONSE, không lộ dữ liệu', async () => {
    installMockFetch([
      {
        url: DETAIL_URL,
        query: { order_code: ORDER_CODE },
        method: 'GET',
        body: okBody(duLieuGhnDayDu({ order_code: undefined })),
      },
    ]);

    const error = await batAppError(
      getOrderDetailTool.handler({ order_code: ORDER_CODE }, taoContext(taoClient())),
    );

    expect(error.code).toBe('GHN_UNEXPECTED_RESPONSE');
    const text = `${error.messageVi} ${error.messageEn} ${JSON.stringify(error)}`;
    for (const sentinel of SENTINELS) {
      expect(text).not.toContain(sentinel);
    }
  });

  it('thiếu status trong phản hồi → GHN_UNEXPECTED_RESPONSE', async () => {
    installMockFetch([
      {
        url: DETAIL_URL,
        query: { order_code: ORDER_CODE },
        method: 'GET',
        body: okBody(duLieuGhnDayDu({ status: undefined })),
      },
    ]);

    const error = await batAppError(
      getOrderDetailTool.handler({ order_code: ORDER_CODE }, taoContext(taoClient())),
    );

    expect(error.code).toBe('GHN_UNEXPECTED_RESPONSE');
  });

  it('data không phải object → GHN_UNEXPECTED_RESPONSE', async () => {
    installMockFetch([
      {
        url: DETAIL_URL,
        query: { order_code: ORDER_CODE },
        method: 'GET',
        body: { code: 200, data: null },
      },
    ]);

    const error = await batAppError(
      getOrderDetailTool.handler({ order_code: ORDER_CODE }, taoContext(taoClient())),
    );

    expect(error.code).toBe('GHN_UNEXPECTED_RESPONSE');
  });

  it('không tìm thấy đơn → GHN_ORDER_NOT_FOUND, nêu mã đơn, không lộ thân GHN', async () => {
    installMockFetch([
      {
        url: DETAIL_URL,
        query: { order_code: ORDER_CODE },
        method: 'GET',
        status: 400,
        body: { code: 400, message: `Đơn hàng không tồn tại ${SENTINELS.join(' ')}` },
      },
    ]);

    const error = await batAppError(
      getOrderDetailTool.handler({ order_code: ORDER_CODE }, taoContext(taoClient())),
    );

    expect(error.code).toBe('GHN_ORDER_NOT_FOUND');
    expect(error.messageVi).toContain(ORDER_CODE);
    const text = `${error.messageVi} ${error.messageEn} ${JSON.stringify(error)}`;
    for (const sentinel of [...SENTINELS, 'Đơn hàng không tồn tại']) {
      expect(text).not.toContain(sentinel);
    }
  });
});

describe('ghn_get_order_detail: dữ liệu phản hồi GHN chặt hơn', () => {
  function taoClient() {
    return createGhnClient({ credentials: provider, sleep: async () => {} });
  }

  // Gọi handler qua client thật (fetch giả) với các trường phản hồi bị ghi đè.
  function goiVoi(overrides: Record<string, unknown>): Promise<unknown> {
    installMockFetch([
      {
        url: DETAIL_URL,
        query: { order_code: ORDER_CODE },
        method: 'GET',
        body: okBody(duLieuGhnDayDu(overrides)),
      },
    ]);
    return getOrderDetailTool.handler({ order_code: ORDER_CODE }, taoContext(taoClient()));
  }

  it.each([
    { nhan: 'số 0', giaTri: 0, mongDoi: 0 },
    { nhan: 'số 350000', giaTri: 350000, mongDoi: 350000 },
    { nhan: 'chuỗi "350000"', giaTri: '350000', mongDoi: 350000 },
    { nhan: 'null', giaTri: null, mongDoi: 0 },
    { nhan: 'vắng trường', giaTri: undefined, mongDoi: 0 },
  ])('cod_amount hợp lệ ($nhan) → $mongDoi', async ({ giaTri, mongDoi }) => {
    const result = (await goiVoi({ cod_amount: giaTri })) as OrderDetailResult;

    expect(result.cod_amount).toBe(mongDoi);
  });

  it.each([
    { nhan: 'chuỗi rỗng', giaTri: '' },
    { nhan: 'chuỗi không phải số', giaTri: 'abc' },
    { nhan: 'chuỗi số âm', giaTri: '-1' },
    { nhan: 'chuỗi thập phân', giaTri: '1.5' },
    { nhan: 'boolean true', giaTri: true },
    { nhan: 'boolean false', giaTri: false },
    { nhan: 'mảng rỗng', giaTri: [] },
    { nhan: 'mảng [5]', giaTri: [5] },
    { nhan: 'object rỗng', giaTri: {} },
    { nhan: 'số âm', giaTri: -1 },
    { nhan: 'số thập phân', giaTri: 1.5 },
  ])('cod_amount không hợp lệ ($nhan) → GHN_UNEXPECTED_RESPONSE', async ({ giaTri }) => {
    const error = await batAppError(goiVoi({ cod_amount: giaTri }));

    expect(error.code).toBe('GHN_UNEXPECTED_RESPONSE');
  });

  it('cod_amount Infinity (JSON 1e999) → GHN_UNEXPECTED_RESPONSE', async () => {
    // JSON không có NaN/Infinity: 1e999 tràn số nên JSON.parse trả Infinity.
    const raw = `{"code":200,"data":{"order_code":"${ORDER_CODE}","status":"delivering","cod_amount":1e999}}`;
    installMockFetch([
      { url: DETAIL_URL, query: { order_code: ORDER_CODE }, method: 'GET', body: raw },
    ]);

    const error = await batAppError(
      getOrderDetailTool.handler({ order_code: ORDER_CODE }, taoContext(taoClient())),
    );

    expect(error.code).toBe('GHN_UNEXPECTED_RESPONSE');
  });

  it('cod_amount NaN bị schema từ chối (JSON không mang được NaN nên kiểm ở schema)', async () => {
    const { ghn } = taoGhnGia(duLieuGhnDayDu({ cod_amount: Number.NaN }));

    await expect(
      getOrderDetailTool.handler({ order_code: ORDER_CODE }, taoContext(ghn)),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it.each([
    { nhan: 'chữ hoa và số', giaTri: 'G8AGIA123XYZ' },
    { nhan: 'chữ thường và số', giaTri: 'g8agia123' },
    { nhan: 'đúng 50 ký tự', giaTri: 'A'.repeat(50) },
  ])('order_code phản hồi hợp lệ ($nhan) → thành công', async ({ giaTri }) => {
    const result = (await goiVoi({ order_code: giaTri })) as OrderDetailResult;

    expect(result.order_code).toBe(giaTri);
  });

  it.each([
    { nhan: 'rỗng', giaTri: '' },
    { nhan: 'quá 50 ký tự', giaTri: 'A'.repeat(51) },
    { nhan: 'có gạch nối', giaTri: 'G8A-123' },
    { nhan: 'có khoảng trắng', giaTri: 'G8A 123' },
    { nhan: 'có xuống dòng', giaTri: 'G8A\n123' },
    { nhan: 'không phải chuỗi', giaTri: 12345 },
  ])('order_code phản hồi không hợp lệ ($nhan) → GHN_UNEXPECTED_RESPONSE', async ({ giaTri }) => {
    const error = await batAppError(goiVoi({ order_code: giaTri }));

    expect(error.code).toBe('GHN_UNEXPECTED_RESPONSE');
  });

  it.each([
    { nhan: 'mã thường', giaTri: 'delivering' },
    { nhan: 'mã có gạch dưới', giaTri: 'money_collect_delivering' },
    { nhan: 'đúng 64 ký tự', giaTri: 'a'.repeat(64) },
  ])('status phản hồi hợp lệ ($nhan) → thành công', async ({ giaTri }) => {
    const result = (await goiVoi({ status: giaTri })) as OrderDetailResult;

    expect(result.status).toBe(giaTri);
  });

  it.each([
    { nhan: 'rỗng', giaTri: '' },
    { nhan: 'quá 64 ký tự', giaTri: 'a'.repeat(65) },
    { nhan: 'chữ hoa', giaTri: 'Delivering' },
    { nhan: 'có gạch nối', giaTri: 'status-loi' },
    { nhan: 'có khoảng trắng', giaTri: 'delivering hang' },
    { nhan: 'có xuống dòng', giaTri: 'delivering\n' },
    { nhan: 'không phải chuỗi', giaTri: 200 },
  ])('status phản hồi không hợp lệ ($nhan) → GHN_UNEXPECTED_RESPONSE', async ({ giaTri }) => {
    const error = await batAppError(goiVoi({ status: giaTri }));

    expect(error.code).toBe('GHN_UNEXPECTED_RESPONSE');
  });

  it('thông báo lỗi không chứa giá trị GHN vi phạm', async () => {
    const sentinels = ['G8A-BI-MAT', 'trang thai bi mat', 'GIA-TRI-COD-BI-MAT'];
    const cases: Array<Record<string, unknown>> = [
      { order_code: sentinels[0] },
      { status: sentinels[1] },
      { cod_amount: sentinels[2] },
    ];

    for (const overrides of cases) {
      const error = await batAppError(goiVoi(overrides));

      expect(error.code).toBe('GHN_UNEXPECTED_RESPONSE');
      const text = `${error.messageVi} ${error.messageEn} ${JSON.stringify(error)}`;
      for (const sentinel of sentinels) {
        expect(text).not.toContain(sentinel);
      }
    }
  });

  it('cấu hình không có ShopId vẫn gọi được; request không gửi header ShopId', async () => {
    const mock = installMockFetch([
      {
        url: DETAIL_URL,
        query: { order_code: ORDER_CODE },
        method: 'GET',
        body: okBody(duLieuGhnDayDu()),
      },
    ]);
    const providerKhongShopId: CredentialProvider = {
      async getCredentials() {
        return { token: TOKEN_GIA, env: 'production' };
      },
    };
    const ghn = createGhnClient({ credentials: providerKhongShopId, sleep: async () => {} });
    const ctx: ToolContext = {
      credentials: { token: TOKEN_GIA, env: 'production' },
      tier: 'all',
      requestId: 'req_abcdef',
      logger: { info() {}, warn() {}, error() {} },
      services: { ghn },
    };

    const result = (await getOrderDetailTool.handler(
      { order_code: ORDER_CODE },
      ctx,
    )) as OrderDetailResult;

    expect(result.order_code).toBe(ORDER_CODE);
    expect(mock.calls).toHaveLength(1);
    const headers = mock.calls[0]?.headers ?? {};
    expect(headers['token']).toBe(TOKEN_GIA);
    expect(Object.keys(headers)).not.toContain('shopid');
  });
});

describe('ghn_get_order_detail: pipeline thật', () => {
  function taoClient() {
    return createGhnClient({ credentials: provider, sleep: async () => {}, timeoutMs: 10 });
  }

  it('tools/list có đúng tool và JSON Schema order_code', async () => {
    const { client } = await setupPipeline(taoClient());

    const listed = await client.listTools();

    expect(listed.tools).toHaveLength(1);
    const tool = listed.tools[0];
    expect(tool?.name).toBe('ghn_get_order_detail');
    expect(tool?.description).toContain('trạng thái');
    const schema = tool?.inputSchema as {
      type?: string;
      properties?: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    expect(schema.type).toBe('object');
    expect(schema.properties).toHaveProperty('order_code');
    expect(schema.additionalProperties).toBe(false);
    const raw = JSON.stringify(tool);
    expect(raw).not.toContain('handler');
    expect(raw).not.toContain('tier');
    expect(raw).not.toContain('$schema');
  });

  it('tools/call thành công trả allowlist, log không chứa mã đơn/dữ liệu GHN', async () => {
    installMockFetch([
      {
        url: DETAIL_URL,
        query: { order_code: ORDER_CODE },
        method: 'GET',
        body: okBody(duLieuGhnDayDu()),
      },
    ]);
    const { client, calls } = await setupPipeline(taoClient());

    const { payload, isError } = docKetQua(
      await client.callTool({
        name: 'ghn_get_order_detail',
        arguments: { order_code: ORDER_CODE },
      }),
    );

    expect(isError).toBe(false);
    expect(payload['ok']).toBe(true);
    expect(payload['data']).toMatchObject({
      order_code: ORDER_CODE,
      status: 'delivering',
      status_vi: 'Đang giao hàng',
    });
    expect(payload['meta']).toMatchObject({ requestId: 'req_abcdef' });

    expect(calls).toHaveLength(1);
    const fields = calls[0]?.fields ?? {};
    const allowed = new Set(['tool', 'code', 'ms', 'httpStatus', 'requestId', 'event']);
    for (const key of Object.keys(fields)) {
      expect(allowed.has(key)).toBe(true);
    }
    const logJson = JSON.stringify(fields);
    expect(logJson).not.toContain(ORDER_CODE);
    for (const sentinel of SENTINELS) {
      expect(logJson).not.toContain(sentinel);
    }
  });

  it('mã đơn sai → VALIDATION_ERROR, KHÔNG gọi GHN', async () => {
    const mock = installMockFetch([]);
    const { client } = await setupPipeline(taoClient());

    const { payload, isError } = docKetQua(
      await client.callTool({ name: 'ghn_get_order_detail', arguments: { order_code: 'G8A-123' } }),
    );

    expect(isError).toBe(true);
    expect(payload['error']).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(mock.calls).toHaveLength(0);
  });

  it('khóa lạ kèm dữ liệu cá nhân → VALIDATION_ERROR, không lộ giá trị, không gọi GHN', async () => {
    const mock = installMockFetch([]);
    const { client } = await setupPipeline(taoClient());

    const { payload } = docKetQua(
      await client.callTool({
        name: 'ghn_get_order_detail',
        arguments: { order_code: ORDER_CODE, to_phone: '0900000000' },
      }),
    );

    expect(payload['error']).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(JSON.stringify(payload)).not.toContain('0900000000');
    expect(mock.calls).toHaveLength(0);
  });

  it('401, 429, 5xx, timeout: đúng mã và retryable', async () => {
    const { client } = await setupPipeline(taoClient());
    const cases: Array<{
      nhan: string;
      routes: Parameters<typeof installMockFetch>[0];
      code: string;
      retryable: boolean;
    }> = [
      {
        nhan: '401',
        routes: [
          { url: DETAIL_URL, query: { order_code: ORDER_CODE }, method: 'GET', status: 401 },
        ],
        code: 'GHN_UNAUTHORIZED',
        retryable: false,
      },
      {
        nhan: '429',
        routes: [
          { url: DETAIL_URL, query: { order_code: ORDER_CODE }, method: 'GET', status: 429 },
        ],
        code: 'GHN_RATE_LIMITED',
        retryable: true,
      },
      {
        nhan: '5xx hai lần',
        routes: [
          {
            url: DETAIL_URL,
            query: { order_code: ORDER_CODE },
            method: 'GET',
            responses: [
              { status: 500, body: 'lỗi' },
              { status: 500, body: 'lỗi' },
            ],
          },
        ],
        code: 'GHN_SERVER_ERROR',
        retryable: true,
      },
      {
        nhan: 'timeout',
        routes: [{ url: DETAIL_URL, query: { order_code: ORDER_CODE }, method: 'GET', hang: true }],
        code: 'GHN_TIMEOUT',
        retryable: true,
      },
    ];

    for (const item of cases) {
      const mock = installMockFetch(item.routes);
      const { payload } = docKetQua(
        await client.callTool({
          name: 'ghn_get_order_detail',
          arguments: { order_code: ORDER_CODE },
        }),
      );
      mock.restore();

      expect(payload['error'], item.nhan).toMatchObject({
        code: item.code,
        retryable: item.retryable,
      });
    }
  });
});
