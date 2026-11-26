/**
 * Test hiệu năng pipeline nội bộ: gọi 3 tool qua server MCP thật
 * với cổng GHN giả trả tức thì, 50 lần mỗi tool, trung vị tookMs phải dưới 50 ms.
 *
 * Ngưỡng 50 ms rộng cho CI chậm; KHÔNG dùng ngưỡng khắt khe hơn để tránh
 * test chập chờn.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/server.js';
import { AllowAll } from '../../src/services/license-allow-all.js';
import { getFeeTool } from '../../src/tools/ghn/get-fee.js';
import { getOrderDetailTool } from '../../src/tools/ghn/get-order-detail.js';
import { getShopsTool } from '../../src/tools/ghn/get-shops.js';
import { createToolRegistry } from '../../src/tools/registry.js';
import { taoCongGhnGia, thongTinGiaMock, tinhThongKe } from '../../scripts/hieu-nang-lib.mjs';

const SO_LAN_MOI_TOOL = 50;

const LOGGER_RONG = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

let client: Client;
let server: ReturnType<typeof createMcpServer>;

beforeAll(async () => {
  const registry = createToolRegistry();
  registry.register(getOrderDetailTool);
  registry.register(getShopsTool);
  registry.register(getFeeTool);

  server = createMcpServer({
    registry,
    credentials: {
      async getCredentials() {
        return {
          token: thongTinGiaMock.token,
          shopId: thongTinGiaMock.shopId,
          env: 'staging',
        };
      },
    },
    ghn: taoCongGhnGia(),
    license: new AllowAll(),
    logger: LOGGER_RONG,
    serverInfo: { name: 'test-perf', version: '0.0.0' },
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'test-perf-client', version: '0.0.0' });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close().catch(() => undefined);
  await server.close().catch(() => undefined);
});

// Gọi một tool và trả đúng dữ liệu cần cho thống kê; không in nội dung phản hồi.
async function goiTool(
  ten: string,
  args: Readonly<Record<string, unknown>>,
): Promise<{ ok: boolean; tookMs: number }> {
  const result = await client.callTool({ name: ten, arguments: args });
  const content = result.content as Array<{ type?: string; text?: string }> | undefined;
  const first = content?.[0];
  if (first === undefined || first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error(`Kết quả ${ten} không có nội dung text`);
  }
  const payload = JSON.parse(first.text) as { ok?: boolean; meta?: { tookMs?: number } };
  return { ok: payload.ok === true, tookMs: payload.meta?.tookMs ?? -1 };
}

const CAC_TOOL = [
  {
    nhan: 'ghn_get_order_detail',
    args: { order_code: thongTinGiaMock.orderCode },
  },
  {
    nhan: 'ghn_get_fee',
    args: { from_district_id: 1442, to_district_id: 1443, to_ward_code: '20110', weight: 500 },
  },
  {
    nhan: 'ghn_get_shops',
    args: {},
  },
];

describe('pipeline nội bộ với cổng GHN giả tức thì', () => {
  it.each(CAC_TOOL)('$nhan: 50 lần đều ok, trung vị tookMs dưới 50 ms', async ({ nhan, args }) => {
    const tookMs: number[] = [];
    let soLanOk = 0;

    for (let lan = 0; lan < SO_LAN_MOI_TOOL; lan += 1) {
      const ketQua = await goiTool(nhan, args);
      if (ketQua.ok) {
        soLanOk += 1;
        tookMs.push(ketQua.tookMs);
      }
    }

    expect(soLanOk).toBe(SO_LAN_MOI_TOOL);
    const median = tinhThongKe(tookMs).median;
    expect(median).not.toBeNull();
    expect(median as number).toBeLessThan(50);
  });
});
