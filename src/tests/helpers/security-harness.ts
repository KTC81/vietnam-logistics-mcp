/**
 * Harness dùng chung cho bộ test bảo mật.
 *
 * Dựng pipeline THẬT như `main.ts`: registry đăng ký đủ 3 tool, `createMcpServer`,
 * `InMemoryTransport` và SDK `Client`; cổng GHN thật `createGhnClient` (test dùng mock-fetch)
 * và logger bắt được từng dòng. Danh sách tool luôn lấy từ `registry.list()`.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type {
  CredentialProvider,
  GhnGateway,
  ToolLogger,
  ToolRegistry,
} from '../../src/core/types.js';
import { createGhnClient } from '../../src/services/ghn-client.js';
import { AllowAll } from '../../src/services/license-allow-all.js';
import { createMcpServer } from '../../src/server.js';
import { getFeeTool } from '../../src/tools/ghn/get-fee.js';
import { getOrderDetailTool } from '../../src/tools/ghn/get-order-detail.js';
import { getShopsTool } from '../../src/tools/ghn/get-shops.js';
import { createToolRegistry } from '../../src/tools/registry.js';
import { SHOP_ID_GIA, TOKEN_GIA_SECRET } from './security-fixtures.js';

/** Thông tin đăng nhập giả đầy đủ (token + ShopId). */
export const providerGia: CredentialProvider = {
  async getCredentials() {
    return { token: TOKEN_GIA_SECRET, shopId: SHOP_ID_GIA, env: 'staging' };
  },
};

/** Registry đăng ký ĐÚNG 3 tool, giống `main.ts`. */
export function taoRegistry(): ToolRegistry {
  const registry = createToolRegistry();
  registry.register(getOrderDetailTool);
  registry.register(getShopsTool);
  registry.register(getFeeTool);
  return registry;
}

export interface FakeLogCall {
  level: 'info' | 'warn' | 'error';
  fields: Record<string, unknown>;
}

/** Logger giả bắt các trường đã ghi (không ghi ra stdout/stderr). */
export function taoLoggerBat(): { logger: ToolLogger; calls: FakeLogCall[] } {
  const calls: FakeLogCall[] = [];
  const ghi =
    (level: FakeLogCall['level']) =>
    (fields: Record<string, unknown>): void => {
      calls.push({ level, fields: { ...fields } });
    };
  return { logger: { info: ghi('info'), warn: ghi('warn'), error: ghi('error') }, calls };
}

export interface SecurityHarnessOptions {
  /** Nguồn thông tin đăng nhập; mặc định token + ShopId giả. */
  credentials?: CredentialProvider;
  /** Cổng GHN tùy biến (ví dụ cổng giả ném lỗi); mặc định `createGhnClient`. */
  ghn?: GhnGateway;
  /** Logger thật cần bắt dòng (logs-leak); mặc định logger giả trong `harness.logs`. */
  logger?: ToolLogger;
  /** Thời gian chờ mỗi lần gọi GHN; mặc định 100 ms (test timeout dùng số nhỏ hơn). */
  timeoutMs?: number;
  now?: () => number;
  newRequestId?: () => string;
}

export interface SecurityHarness {
  client: Client;
  registry: ToolRegistry;
  /** Các lời gọi logger giả; rỗng khi truyền `logger` thật. */
  logs: FakeLogCall[];
  close: () => Promise<void>;
}

/** Dựng pipeline thật và kết nối client trong bộ nhớ. */
export async function taoHarness(options: SecurityHarnessOptions = {}): Promise<SecurityHarness> {
  const registry = taoRegistry();
  const credentials = options.credentials ?? providerGia;
  const batLog = taoLoggerBat();
  const logger = options.logger ?? batLog.logger;
  const ghn =
    options.ghn ??
    createGhnClient({
      credentials,
      sleep: async () => {},
      timeoutMs: options.timeoutMs ?? 100,
      // Mặc định cũng bơm logger bắt log cho client để errors-leak kiểm cả dòng ghn_call/ghn_retry.
      logger: options.logger ?? batLog.logger,
    });

  const server = createMcpServer({
    registry,
    credentials,
    ghn,
    license: new AllowAll(),
    logger,
    serverInfo: { name: 'security-test-server', version: '0.0.0' },
    now: options.now ?? (() => 100),
    newRequestId: options.newRequestId ?? (() => 'req_abcdef'),
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'security-test-client', version: '0.0.0' });
  await client.connect(clientTransport);

  return {
    client,
    registry,
    logs: batLog.calls,
    async close(): Promise<void> {
      await client.close();
      await server.close();
    },
  };
}

/** Đọc kết quả tool (khung `{ ok, data|error, meta }`) từ phản hồi MCP. */
export function docKetQua(result: unknown): {
  payload: Record<string, unknown>;
  isError: boolean;
} {
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

/** Gọi một tool qua pipeline và trả khung kết quả đã đọc. */
export async function goiTool(
  client: Client,
  name: string,
  args?: Record<string, unknown>,
): Promise<{ payload: Record<string, unknown>; isError: boolean }> {
  return docKetQua(await client.callTool({ name, arguments: args }));
}

/** Cổng GHN giả chỉ đếm lời gọi (dùng khi muốn chắc tool không gọi GHN). */
export function taoGhnDem(): { ghn: GhnGateway; soLanGoi: () => number } {
  let calls = 0;
  const ghn: GhnGateway = {
    async request() {
      calls += 1;
      throw new Error('Cổng GHN giả: không được gọi trong test này');
    },
  };
  return { ghn, soLanGoi: () => calls };
}
