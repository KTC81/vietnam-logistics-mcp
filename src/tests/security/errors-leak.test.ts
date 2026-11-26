import { describe, expect, it } from 'vitest';
import { ERROR_CATALOG } from '../../src/core/errors.js';
import {
  DIA_CHI_GIA,
  PII_GIA,
  SDT_GIA,
  TEN_GIA,
  TOKEN_GIA_SECRET,
  TOOL_FIXTURES,
  type ToolFixture,
} from '../helpers/security-fixtures.js';
import {
  goiTool,
  taoHarness,
  taoRegistry,
  type SecurityHarness,
} from '../helpers/security-harness.js';
import { installMockFetch, type MockFetchRoute } from '../helpers/mock-fetch.js';

const SECRET_VALUES = [TOKEN_GIA_SECRET, ...PII_GIA, 'GIA-TRI-LA'];

// Dấu hiệu rò rỉ nội bộ/GHN thô: không được xuất hiện trong kết quả hay log.
const DAU_HIEU_RO_RI = [
  '    at ',
  'node_modules',
  '/Users/',
  'messageEn',
  'cause',
  'SHOP_INFO_ERROR',
  'route not found service',
  'to ward not found',
];

const SO_DONG_STACK = /\.(?:ts|js):\d+/;

interface KichBan {
  nhan: string;
  route: MockFetchRoute;
  /** Mã lỗi mong đợi RIÊNG cho tool (bảng theo tên tool). */
  maMongDoi: string;
}

function layFixture(tenTool: string): ToolFixture {
  const fixture = TOOL_FIXTURES[tenTool];
  if (fixture === undefined) {
    throw new Error(`Thiếu fixture bảo mật cho tool ${tenTool}`);
  }
  return fixture;
}

function kiemKhongRoRi(text: string, nhan: string): void {
  for (const value of SECRET_VALUES) {
    expect(text, `${nhan}: lộ giá trị ${value.slice(0, 6)}…`).not.toContain(value);
  }
  for (const marker of DAU_HIEU_RO_RI) {
    expect(text, `${nhan}: lộ dấu hiệu ${marker}`).not.toContain(marker);
  }
  expect(text, `${nhan}: lộ dòng stack`).not.toMatch(SO_DONG_STACK);
}

function kiemKhungLoi(
  payload: Record<string, unknown>,
  harness: SecurityHarness,
  maMongDoi: string,
  nhan: string,
): void {
  expect(payload['ok'], nhan).toBe(false);
  const error = payload['error'] as Record<string, unknown>;
  // So ĐÚNG mã mong đợi, không chỉ "nằm trong catalog".
  expect(Object.keys(ERROR_CATALOG), nhan).toContain(maMongDoi);
  expect(error['code'], nhan).toBe(maMongDoi);
  expect(error['retryable'], nhan).toBeTypeOf('boolean');
  expect(
    (error['message'] as string).match(/[À-ɏḀ-ỿ]/),
    `${nhan}: thông báo phải tiếng Việt`,
  ).not.toBeNull();
  const meta = payload['meta'] as { requestId?: unknown };
  expect(meta.requestId, nhan).toMatch(/^req_/);

  for (const key of Object.keys(error)) {
    expect(['code', 'message', 'retryable', 'issues'], `${nhan}: khóa lỗi lạ`).toContain(key);
  }
  kiemKhongRoRi(JSON.stringify(payload), nhan);
  for (const call of harness.logs) {
    kiemKhongRoRi(JSON.stringify(call.fields), `${nhan} (log)`);
    for (const key of Object.keys(call.fields)) {
      expect(
        ['ts', 'level', 'tool', 'code', 'ms', 'httpStatus', 'requestId', 'event', 'dropped'],
        `${nhan}: khóa log lạ`,
      ).toContain(key);
    }
  }
}

// Chốt "xanh giả": nếu registry rỗng thì chính test này đỏ (không phụ thuộc "no test found").
describe('bộ test bảo mật: registry và fixture', () => {
  it('registry có ít nhất 3 tool và khớp bảng fixture', () => {
    const names = taoRegistry()
      .list()
      .map((tool) => tool.name);

    expect(names.length).toBeGreaterThanOrEqual(3);
    expect(names.length).toBe(Object.keys(TOOL_FIXTURES).length);
    for (const name of names) {
      expect(TOOL_FIXTURES[name], `Thiếu fixture cho tool ${name}`).toBeDefined();
    }
  });
});

for (const tool of taoRegistry().list()) {
  describe(`tool ${tool.name}: lỗi không lộ thông tin`, () => {
    const fixture = layFixture(tool.name);
    const laToolTraDon = tool.name === 'ghn_get_order_detail';
    const bodyCoPii = {
      code: 400,
      message: `${TOKEN_GIA_SECRET} ${TEN_GIA} ${SDT_GIA} ${DIA_CHI_GIA}`,
      code_message: 'SHOP_INFO_ERROR',
    };

    const scenarios: KichBan[] = [
      {
        nhan: '401',
        route: { method: fixture.method, status: 401 },
        maMongDoi: 'GHN_UNAUTHORIZED',
      },
      {
        nhan: '403',
        route: { method: fixture.method, status: 403, body: { message: TEN_GIA } },
        maMongDoi: 'GHN_BAD_REQUEST',
      },
      {
        nhan: '429',
        route: { method: fixture.method, status: 429 },
        maMongDoi: 'GHN_RATE_LIMITED',
      },
      {
        nhan: '500 JSON',
        route: {
          method: fixture.method,
          status: 500,
          body: { code: 500, message: `${TOKEN_GIA_SECRET} ${SDT_GIA}` },
        },
        maMongDoi: 'GHN_SERVER_ERROR',
      },
      {
        nhan: '500 HTML',
        route: {
          method: fixture.method,
          status: 500,
          body: `<html><body>${DIA_CHI_GIA}</body></html>`,
          headers: { 'content-type': 'text/html' },
        },
        maMongDoi: 'GHN_SERVER_ERROR',
      },
      {
        nhan: '502',
        route: { method: fixture.method, status: 502 },
        maMongDoi: 'GHN_SERVER_ERROR',
      },
      {
        nhan: '400 không tồn tại',
        route: {
          method: fixture.method,
          status: 400,
          body: { code: 400, message: `Đơn hàng không tồn tại ${TOKEN_GIA_SECRET}` },
        },
        // Chỉ endpoint detail nhận ra "không tồn tại"; tool khác rơi vào GHN_BAD_REQUEST.
        maMongDoi: laToolTraDon ? 'GHN_ORDER_NOT_FOUND' : 'GHN_BAD_REQUEST',
      },
      {
        nhan: '400 PII',
        route: { method: fixture.method, status: 400, body: bodyCoPii },
        maMongDoi: 'GHN_BAD_REQUEST',
      },
      {
        nhan: 'thân không phải JSON',
        route: {
          method: fixture.method,
          body: `<html><body>${SDT_GIA}</body></html>`,
          headers: { 'content-type': 'text/html' },
        },
        maMongDoi: 'GHN_UNEXPECTED_RESPONSE',
      },
      {
        nhan: 'data sai kiểu',
        route: { method: fixture.method, body: { code: 200, data: 'sai' } },
        maMongDoi: 'GHN_UNEXPECTED_RESPONSE',
      },
      {
        nhan: 'timeout',
        route: { method: fixture.method, hang: true },
        maMongDoi: 'GHN_TIMEOUT',
      },
      {
        nhan: 'lỗi mạng',
        route: {
          method: fixture.method,
          networkError: new Error(`${TOKEN_GIA_SECRET} ${TEN_GIA}`),
        },
        maMongDoi: 'GHN_NETWORK',
      },
      {
        nhan: '200 thiếu trường',
        route: { method: fixture.method, body: fixture.missingFieldBody },
        maMongDoi: 'GHN_UNEXPECTED_RESPONSE',
      },
    ];

    it('mọi tình huống lỗi: mock được gọi, ĐÚNG mã mong đợi, không lộ bí mật/stack/thân GHN', async () => {
      for (const scenario of scenarios) {
        const mock = installMockFetch([scenario.route]);
        const harness = await taoHarness({ timeoutMs: 20 });
        try {
          const { payload, isError } = await goiTool(
            harness.client,
            tool.name,
            fixture.validArguments,
          );

          expect(isError, scenario.nhan).toBe(true);
          // Đường lỗi phải thực sự đi qua mock-fetch, không phải xanh giả.
          expect(mock.calls.length, `${scenario.nhan}: mock không được gọi`).toBeGreaterThan(0);
          kiemKhungLoi(payload, harness, scenario.maMongDoi, `${tool.name} ${scenario.nhan}`);
        } finally {
          await harness.close();
          mock.restore();
        }
      }
    }, 30_000);

    const throwers: Array<{ nhan: string; tao: () => unknown }> = [
      {
        nhan: 'Error có stack',
        tao: () => {
          const error = new Error(`bí mật ${TOKEN_GIA_SECRET}`);
          error.stack = `Error: ${TEN_GIA}\n    at /Users/may/bi-mat.ts:12:3`;
          return error;
        },
      },
      { nhan: 'chuỗi', tao: () => TOKEN_GIA_SECRET },
      { nhan: 'object có token', tao: () => ({ token: TOKEN_GIA_SECRET, message: TEN_GIA }) },
    ];

    it.each(throwers)('cổng GHN giả ném $nhan → INTERNAL_ERROR, không lộ', async ({ tao }) => {
      const harness = await taoHarness({
        ghn: {
          async request() {
            throw tao();
          },
        },
      });
      try {
        const { payload, isError } = await goiTool(
          harness.client,
          tool.name,
          fixture.validArguments,
        );

        expect(isError).toBe(true);
        expect(payload['error']).toMatchObject({ code: 'INTERNAL_ERROR' });
        kiemKhungLoi(payload, harness, 'INTERNAL_ERROR', `${tool.name} ném lỗi`);
      } finally {
        await harness.close();
      }
    });
  });
}
