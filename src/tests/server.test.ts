import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAppError } from '../src/core/errors.js';
import type {
  CredentialProvider,
  GhnGateway,
  LicenseChecker,
  StoredToolDefinition,
  ToolContext,
  ToolDefinition,
  ToolLogger,
} from '../src/core/types.js';
import { createMcpServer, type ServerDeps } from '../src/server.js';
import { AllowAll } from '../src/services/license-allow-all.js';
import { createToolRegistry } from '../src/tools/registry.js';
import { weightGramSchema } from '../src/utils/validator.js';

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

const credentials: CredentialProvider = {
  async getCredentials() {
    return { token: 'TOKEN-GIA-123', shopId: 999999, env: 'production' };
  },
};

// Cổng GHN giả: pipeline test không được gọi mạng.
const ghn: GhnGateway = {
  request: async () => {
    throw new Error('GhnGateway giả: không dùng trong test này');
  },
};

interface DemoInput {
  weight: number;
}

function taoDemoTool(
  handler: (input: DemoInput, ctx: ToolContext) => Promise<unknown>,
): ToolDefinition<DemoInput> {
  return {
    name: 'ghn_demo',
    description: 'Tool giả để test pipeline',
    inputSchema: z.object({ weight: weightGramSchema }),
    tier: 'free',
    handler,
  };
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup().catch(() => undefined);
  }
});

interface SetupOptions {
  tool?: StoredToolDefinition;
  deps?: Partial<ServerDeps>;
}

async function setup(options: SetupOptions = {}): Promise<{
  client: Client;
  calls: FakeLogCall[];
}> {
  const registry = createToolRegistry();
  if (options.tool !== undefined) {
    registry.register(options.tool);
  }
  const { logger, calls } = taoFakeLogger();
  const server = createMcpServer({
    registry,
    credentials,
    ghn,
    license: new AllowAll(),
    logger,
    serverInfo: { name: 'test-server', version: '0.0.0' },
    ...options.deps,
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

// Client SDK có thể trả kiểu tương thích cũ (toolResult) — đọc phòng thủ, không ép kiểu cứng.
function docKetQua(result: unknown): {
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

describe('tools/list', () => {
  it('trả name, description, JSON Schema; không lộ handler/tier/$schema', async () => {
    const { client } = await setup({ tool: taoDemoTool(async () => ({})) });

    const listed = await client.listTools();

    expect(listed.tools).toHaveLength(1);
    const item = listed.tools[0];
    expect(item?.name).toBe('ghn_demo');
    expect(item?.description).toBe('Tool giả để test pipeline');
    expect(item?.inputSchema.type).toBe('object');
    const raw = JSON.stringify(item);
    expect(raw).toContain('weight');
    expect(raw).not.toContain('handler');
    expect(raw).not.toContain('tier');
    expect(raw).not.toContain('$schema');
  });
});

describe('tools/call: thành công', () => {
  it('trả ok:true với requestId giả và tookMs theo đồng hồ giả', async () => {
    const tool = taoDemoTool(async (input) => ({ doubled: input.weight * 2 }));
    const times = [100, 250];
    const { client, calls } = await setup({
      tool,
      deps: {
        now: () => times.shift() ?? 250,
        newRequestId: () => 'req_abcdef',
      },
    });

    const result = await client.callTool({ name: 'ghn_demo', arguments: { weight: 5 } });
    const { payload, isError } = docKetQua(result);

    expect(isError).toBe(false);
    expect(payload).toEqual({
      ok: true,
      data: { doubled: 10 },
      meta: { requestId: 'req_abcdef', tookMs: 150 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.level).toBe('info');
    expect(calls[0]?.fields).toMatchObject({
      event: 'tool_call',
      tool: 'ghn_demo',
      requestId: 'req_abcdef',
      ms: 150,
    });
  });

  it('requestId mặc định đúng dạng req_ + 6-8 ký tự hex', async () => {
    const { client } = await setup({ tool: taoDemoTool(async () => ({})) });

    const { payload } = docKetQua(
      await client.callTool({ name: 'ghn_demo', arguments: { weight: 5 } }),
    );
    const meta = payload['meta'] as { requestId: string };

    expect(meta.requestId).toMatch(/^req_[0-9a-f]{6,8}$/);
  });

  it('log chỉ có khóa allowlist, không chứa đầu vào', async () => {
    const { client, calls } = await setup({ tool: taoDemoTool(async () => ({})) });
    const allowed = new Set(['tool', 'code', 'ms', 'httpStatus', 'requestId', 'event']);

    await client.callTool({ name: 'ghn_demo', arguments: { weight: 123 } });

    expect(calls).toHaveLength(1);
    const fields = calls[0]?.fields ?? {};
    for (const key of Object.keys(fields)) {
      expect(allowed.has(key)).toBe(true);
    }
    expect(fields).not.toHaveProperty('arguments');
    expect(fields).not.toHaveProperty('input');
  });

  it('tookMs làm tròn số lẻ ở nhánh thành công', async () => {
    const times = [100.0, 250.6];
    const { client } = await setup({
      tool: taoDemoTool(async () => ({})),
      deps: {
        now: () => {
          const value = times.shift();
          if (value === undefined) {
            throw new Error('Đồng hồ giả được gọi quá số lần mong đợi');
          }
          return value;
        },
      },
    });

    const { payload } = docKetQua(
      await client.callTool({ name: 'ghn_demo', arguments: { weight: 5 } }),
    );
    const meta = payload['meta'] as { tookMs: number };

    expect(meta.tookMs).toBe(151);
    expect(Number.isInteger(meta.tookMs)).toBe(true);
    expect(times).toHaveLength(0);
  });

  it.each([
    { nhan: 'undefined', value: undefined },
    { nhan: 'null', value: null },
  ])('handler trả $nhan → data chuẩn hóa thành null', async ({ value }) => {
    const { client } = await setup({ tool: taoDemoTool(async () => value) });

    const { payload, isError } = docKetQua(
      await client.callTool({ name: 'ghn_demo', arguments: { weight: 5 } }),
    );

    expect(isError).toBe(false);
    expect(payload).toHaveProperty('data', null);
  });
});

describe('tools/call: ToolContext', () => {
  it('handler nhận đúng credentials, requestId, services.ghn và logger', async () => {
    let captured: ToolContext | undefined;
    const tool = taoDemoTool(async (_input, ctx) => {
      captured = ctx;
      return {
        tier: ctx.tier,
        token: ctx.credentials.token,
        requestId: ctx.requestId,
      };
    });
    const { client } = await setup({
      tool,
      deps: { newRequestId: () => 'req_abcdef' },
    });

    const { payload } = docKetQua(
      await client.callTool({ name: 'ghn_demo', arguments: { weight: 5 } }),
    );

    if (captured === undefined) {
      throw new Error('Handler chưa được gọi nên không bắt được ToolContext');
    }
    expect(payload['data']).toEqual({
      tier: 'all',
      token: 'TOKEN-GIA-123',
      requestId: 'req_abcdef',
    });
    expect(captured.services.ghn).toBe(ghn);
    expect(typeof captured.logger.info).toBe('function');
    expect(typeof captured.logger.warn).toBe('function');
    expect(typeof captured.logger.error).toBe('function');
  });

  it("license trả tier 'free' → handler thấy ctx.tier === 'free'", async () => {
    let seenTier: string | undefined;
    const tool = taoDemoTool(async (_input, ctx) => {
      seenTier = ctx.tier;
      return {};
    });
    const license: LicenseChecker = {
      async check() {
        return { valid: true, tier: 'free' };
      },
    };
    const { client } = await setup({ tool, deps: { license } });

    await client.callTool({ name: 'ghn_demo', arguments: { weight: 5 } });

    expect(seenTier).toBe('free');
  });
});

describe('tools/call: lỗi đầu vào và tool không tồn tại', () => {
  it('đầu vào sai → VALIDATION_ERROR, handler KHÔNG chạy, isError true', async () => {
    let handlerCalls = 0;
    const tool = taoDemoTool(async () => {
      handlerCalls += 1;
      return {};
    });
    const { client, calls } = await setup({ tool });

    const result = await client.callTool({ name: 'ghn_demo', arguments: { weight: 0 } });
    const { payload, isError } = docKetQua(result);

    expect(isError).toBe(true);
    expect(payload['error']).toMatchObject({
      code: 'VALIDATION_ERROR',
      retryable: false,
      issues: [{ field: 'weight', message: 'Cân nặng phải lớn hơn 0 (gram)' }],
    });
    const error = payload['error'] as { message: string };
    expect(error.message).toBe(
      'Dữ liệu nhập chưa đúng: weight: Cân nặng phải lớn hơn 0 (gram). Vui lòng sửa rồi thử lại.',
    );
    expect(handlerCalls).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.level).toBe('warn');
    expect(calls[0]?.fields).toMatchObject({ code: 'VALIDATION_ERROR', tool: 'ghn_demo' });
  });

  it('tool không tồn tại → VALIDATION_ERROR field name, không lộ tên người dùng nhập', async () => {
    const { client, calls } = await setup();

    const result = await client.callTool({ name: 'khong_ton_tai', arguments: {} });
    const { payload } = docKetQua(result);

    expect(payload['error']).toMatchObject({
      code: 'VALIDATION_ERROR',
      issues: [{ field: 'name', message: 'Tool không tồn tại' }],
    });
    expect(JSON.stringify(payload)).not.toContain('khong_ton_tai');
    expect(calls[0]?.fields).not.toHaveProperty('tool');
    expect(calls[0]?.fields.code).toBe('VALIDATION_ERROR');
  });

  it('thiếu arguments: schema rỗng thành công, có trường bắt buộc → VALIDATION_ERROR', async () => {
    const emptyTool: ToolDefinition<Record<string, never>> = {
      name: 'ghn_empty',
      description: 'Tool schema rỗng',
      inputSchema: z.object({}),
      tier: 'free',
      handler: async () => ({ ok: true }),
    };
    const first = await setup({ tool: emptyTool });

    const emptyResult = docKetQua(await first.client.callTool({ name: 'ghn_empty' }));
    expect(emptyResult.isError).toBe(false);
    expect(emptyResult.payload['data']).toEqual({ ok: true });

    const second = await setup({ tool: taoDemoTool(async () => ({})) });
    const requiredResult = docKetQua(await second.client.callTool({ name: 'ghn_demo' }));

    expect(requiredResult.isError).toBe(true);
    expect(requiredResult.payload['error']).toMatchObject({ code: 'VALIDATION_ERROR' });
    const issues = (requiredResult.payload['error'] as { issues: Array<{ field: string }> }).issues;
    expect(issues[0]?.field).toBe('weight');
  });
});

describe('tools/call: handler ném lỗi', () => {
  it('handler ném AppError → giữ nguyên mã và thông báo tiếng Việt', async () => {
    const tool = taoDemoTool(async () => {
      throw createAppError('GHN_UNAUTHORIZED');
    });
    const { client } = await setup({ tool });

    const { payload, isError } = docKetQua(
      await client.callTool({ name: 'ghn_demo', arguments: { weight: 5 } }),
    );

    expect(isError).toBe(true);
    expect(payload['error']).toEqual({
      code: 'GHN_UNAUTHORIZED',
      message: 'Token GHN hết hạn, lấy token mới tại khachhang.ghn.vn',
      retryable: false,
    });
  });

  it('tookMs làm tròn số lẻ ở nhánh lỗi', async () => {
    const times = [100.0, 250.6];
    const tool = taoDemoTool(async () => {
      throw createAppError('GHN_UNAUTHORIZED');
    });
    const { client } = await setup({
      tool,
      deps: {
        now: () => {
          const value = times.shift();
          if (value === undefined) {
            throw new Error('Đồng hồ giả được gọi quá số lần mong đợi');
          }
          return value;
        },
      },
    });

    const { payload } = docKetQua(
      await client.callTool({ name: 'ghn_demo', arguments: { weight: 5 } }),
    );
    const meta = payload['meta'] as { tookMs: number };

    expect(meta.tookMs).toBe(151);
    expect(Number.isInteger(meta.tookMs)).toBe(true);
    expect(times).toHaveLength(0);
  });

  it.each([
    {
      nhan: 'Error',
      thrower: (): never => {
        throw new Error('TOKEN-GIA-123 bi mat');
      },
    },
    {
      nhan: 'chuỗi',
      thrower: (): never => {
        throw 'TOKEN-GIA-123';
      },
    },
    {
      nhan: 'undefined',
      thrower: (): never => {
        throw undefined;
      },
    },
    {
      nhan: 'object',
      thrower: (): never => {
        throw { message: 'TOKEN-GIA-123' };
      },
    },
  ])('handler ném $nhan → INTERNAL_ERROR, không lộ nội dung gốc', async ({ thrower }) => {
    const tool = taoDemoTool(async () => {
      thrower();
      return {};
    });
    const { client } = await setup({ tool });

    const { payload, isError } = docKetQua(
      await client.callTool({ name: 'ghn_demo', arguments: { weight: 5 } }),
    );

    expect(isError).toBe(true);
    expect(payload['error']).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(JSON.stringify(payload)).not.toContain('TOKEN-GIA-123');
    expect(JSON.stringify(payload)).not.toContain('bi mat');
  });

  it('handler trả đối tượng vòng → INTERNAL_ERROR, không ném ra ngoài', async () => {
    const tool = taoDemoTool(async () => {
      const vong: Record<string, unknown> = {};
      vong['self'] = vong;
      return vong;
    });
    const { client } = await setup({ tool });

    const { payload, isError } = docKetQua(
      await client.callTool({ name: 'ghn_demo', arguments: { weight: 5 } }),
    );

    expect(isError).toBe(true);
    expect(payload['error']).toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('handler trả BigInt → INTERNAL_ERROR, không ném ra ngoài', async () => {
    const tool = taoDemoTool(async () => ({ value: 10n }));
    const { client } = await setup({ tool });

    const { payload, isError } = docKetQua(
      await client.callTool({ name: 'ghn_demo', arguments: { weight: 5 } }),
    );

    expect(isError).toBe(true);
    expect(payload['error']).toMatchObject({ code: 'INTERNAL_ERROR' });
  });
});

describe('tools/call: license', () => {
  it('license valid=false → không chạy handler, trả lỗi đúng dạng', async () => {
    let handlerCalls = 0;
    const tool = taoDemoTool(async () => {
      handlerCalls += 1;
      return {};
    });
    const license: LicenseChecker = {
      async check() {
        return { valid: false, tier: 'free' };
      },
    };
    const { client } = await setup({ tool, deps: { license } });

    const { payload, isError } = docKetQua(
      await client.callTool({ name: 'ghn_demo', arguments: { weight: 5 } }),
    );

    expect(isError).toBe(true);
    expect(payload['error']).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(handlerCalls).toBe(0);
  });

  it('license ném AppError → trả đúng mã, không chạy handler', async () => {
    let handlerCalls = 0;
    const tool = taoDemoTool(async () => {
      handlerCalls += 1;
      return {};
    });
    const license: LicenseChecker = {
      async check() {
        throw createAppError('GHN_UNAUTHORIZED');
      },
    };
    const { client } = await setup({ tool, deps: { license } });

    const { payload } = docKetQua(
      await client.callTool({ name: 'ghn_demo', arguments: { weight: 5 } }),
    );

    expect(payload['error']).toMatchObject({ code: 'GHN_UNAUTHORIZED' });
    expect(handlerCalls).toBe(0);
  });

  it('license được kiểm TRƯỚC parseInput (đảo thứ tự sẽ làm test đỏ)', async () => {
    const license: LicenseChecker = {
      async check() {
        return { valid: false, tier: 'free' };
      },
    };
    const { client } = await setup({
      tool: taoDemoTool(async () => ({})),
      deps: { license },
    });

    const { payload } = docKetQua(
      await client.callTool({ name: 'ghn_demo', arguments: { weight: 0 } }),
    );

    // Đầu vào cũng sai, nhưng license bị chặn trước nên mã là INTERNAL_ERROR, không phải VALIDATION_ERROR.
    expect(payload['error']).toMatchObject({ code: 'INTERNAL_ERROR' });
  });
});

describe('tools/call: song song và requestId', () => {
  it('hai lời gọi song song có requestId và ctx riêng', async () => {
    let counter = 0;
    const tool = taoDemoTool(async (input, ctx) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { weight: input.weight, requestId: ctx.requestId };
    });
    const { client } = await setup({
      tool,
      deps: { newRequestId: () => `req_${String(++counter).padStart(8, '0')}` },
    });

    const [first, second] = await Promise.all([
      client.callTool({ name: 'ghn_demo', arguments: { weight: 1 } }),
      client.callTool({ name: 'ghn_demo', arguments: { weight: 2 } }),
    ]);
    const data1 = docKetQua(first).payload['data'] as {
      weight: number;
      requestId: string;
    };
    const data2 = docKetQua(second).payload['data'] as {
      weight: number;
      requestId: string;
    };

    expect(data1.weight).toBe(1);
    expect(data2.weight).toBe(2);
    expect(data1.requestId).toMatch(/^req_\d{8}$/);
    expect(data1.requestId).not.toBe(data2.requestId);
  });

  it('requestId nhất quán ở meta, message lỗi và log', async () => {
    const tool = taoDemoTool(async () => {
      throw createAppError('INTERNAL_ERROR');
    });
    const { client, calls } = await setup({
      tool,
      deps: { newRequestId: () => 'req_abcdef', now: () => 100 },
    });

    const { payload } = docKetQua(
      await client.callTool({ name: 'ghn_demo', arguments: { weight: 5 } }),
    );
    const meta = payload['meta'] as { requestId: string };
    const error = payload['error'] as { message: string };

    expect(meta.requestId).toBe('req_abcdef');
    expect(error.message).toContain('req_abcdef');
    expect(calls[0]?.fields.requestId).toBe('req_abcdef');
  });
});
