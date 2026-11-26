/**
 * Dựng server MCP và pipeline cho MỖI lời gọi tool.
 *
 * Pipeline cố định: sinh requestId → tìm tool → license → credentials → parseInput → handler
 * → bọc kết quả `{ok, data|error, meta}` → đo tookMs → ghi đúng MỘT dòng log.
 *
 * Dùng API cấp thấp `Server` + `setRequestHandler` (KHÔNG dùng McpServer.registerTool) để đầu
 * vào đi qua `parseInput` của ta: thông báo tiếng Việt và `issues` đúng hợp đồng kết quả.
 */
import { randomBytes } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { ENFORCE_TIERS } from './config/tiers.js';
import { createAppError, toToolErrorResult } from './core/errors.js';
import type {
  CredentialProvider,
  GhnGateway,
  LicenseChecker,
  McpServerHandle,
  StoredToolDefinition,
  ToolContext,
  ToolFailure,
  ToolLogger,
  ToolRegistry,
  ToolResult,
} from './core/types.js';
import { parseInput } from './utils/validator.js';

/** Phụ thuộc của server, tất cả truyền qua tham số (không đọc biến môi trường). */
export interface ServerDeps {
  registry: ToolRegistry;
  /** Nguồn thông tin đăng nhập GHN (mặc định `EnvCredentialProvider`). */
  credentials: CredentialProvider;
  /** Cổng GHN (`createGhnClient`). */
  ghn: GhnGateway;
  /** Cổng kiểm tra quyền (mặc định `AllowAll`). */
  license: LicenseChecker;
  logger: ToolLogger;
  serverInfo: { name: string; version: string };
  /** Đồng hồ đo thời gian; mặc định `performance.now()` (test truyền bản giả). */
  now?: () => number;
  /** Hàm sinh requestId; mặc định `req_` + 8 ký tự hex ngẫu nhiên (test truyền bản giả). */
  newRequestId?: () => string;
}

function defaultNewRequestId(): string {
  return `req_${randomBytes(4).toString('hex')}`;
}

// Đổi schema Zod của tool thành JSON Schema cho `tools/list`, bỏ `$schema`.
function toInputJsonSchema(schema: ZodTypeAny): Tool['inputSchema'] {
  const jsonSchema = zodToJsonSchema(schema, { $refStrategy: 'none' }) as Record<string, unknown>;
  delete jsonSchema['$schema'];
  // Ép kiểu có chủ đích: JSON Schema do zod-to-json-schema sinh; tool dùng ZodObject nên
  // luôn có type 'object' như SDK yêu cầu.
  return jsonSchema as Tool['inputSchema'];
}

/**
 * Dựng server MCP (chưa nối transport). Trả `McpServerHandle` mỏng để `core/` không phụ thuộc SDK.
 */
export function createMcpServer(deps: ServerDeps): McpServerHandle {
  const now = deps.now ?? (() => performance.now());
  const newRequestId = deps.newRequestId ?? defaultNewRequestId;

  const sdkServer = new Server(
    { name: deps.serverInfo.name, version: deps.serverInfo.version },
    { capabilities: { tools: {} } },
  );

  sdkServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: deps.registry.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: toInputJsonSchema(tool.inputSchema),
    })),
  }));

  async function handleToolCall(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<CallToolResult> {
    const startedAt = now();
    const requestId = newRequestId();
    // Tên tool chỉ đưa vào log khi tool CÓ trong registry (tên do registry kiểm định dạng);
    // tên người dùng nhập cho tool không tồn tại không được log.
    let toolName: string | undefined;

    try {
      const tool: StoredToolDefinition | undefined = deps.registry.get(params.name);
      if (tool === undefined) {
        // Chưa có mã TOOL_NOT_FOUND trong catalog: dùng VALIDATION_ERROR, ghi báo cáo.
        throw createAppError(
          'VALIDATION_ERROR',
          { trường: 'name', 'lý do': 'Tool không tồn tại', fields: 'name' },
          { issues: [{ field: 'name', message: 'Tool không tồn tại' }] },
        );
      }
      toolName = tool.name;

      const verdict = await deps.license.check({ requestId, logger: deps.logger });
      if (!verdict.valid) {
        // Danh mục lỗi chưa có mã riêng cho trường hợp này: dùng INTERNAL_ERROR.
        throw createAppError('INTERNAL_ERROR');
      }

      if (ENFORCE_TIERS) {
        // Điểm kiểm nhóm sử dụng theo config/tiers.ts; hiện ENFORCE_TIERS = false nên bỏ qua.
      }

      const credentials = await deps.credentials.getCredentials();
      const ctx: ToolContext = {
        credentials,
        tier: verdict.tier,
        requestId,
        logger: deps.logger,
        services: { ghn: deps.ghn },
      };

      const input = parseInput(tool.inputSchema, params.arguments ?? {});
      // Registry đã xóa kiểu đầu vào (handler nhận never); parseInput ở trên đã kiểm dữ liệu.
      const data = await tool.handler(input as never, ctx);

      const tookMs = Math.round(now() - startedAt);
      // Handler trả undefined thì JSON.stringify sẽ BỎ khóa "data"; chuẩn hóa thành null để
      // kết quả luôn cùng dạng { ok, data, meta }.
      const success: ToolResult<unknown> = {
        ok: true,
        data: data ?? null,
        meta: { requestId, tookMs },
      };
      // JSON.stringify có thể ném nếu handler trả đối tượng vòng/BigInt → catch bên dưới.
      const text = JSON.stringify(success);
      deps.logger.info({ event: 'tool_call', tool: tool.name, requestId, ms: tookMs });
      return { content: [{ type: 'text', text }], isError: false };
    } catch (error) {
      const tookMs = Math.round(now() - startedAt);
      const failure = toToolErrorResult(error, requestId);
      const result: ToolFailure = { ok: false, error: failure.error, meta: { requestId, tookMs } };
      const text = JSON.stringify(result);

      const fields = {
        event: 'tool_call',
        requestId,
        ms: tookMs,
        code: failure.error.code,
        ...(toolName !== undefined ? { tool: toolName } : {}),
      };
      // Lỗi đầu vào là chuyện thường gặp của người dùng → warn; còn lại là error.
      if (failure.error.code === 'VALIDATION_ERROR') {
        deps.logger.warn(fields);
      } else {
        deps.logger.error(fields);
      }
      return { content: [{ type: 'text', text }], isError: true };
    }
  }

  sdkServer.setRequestHandler(CallToolRequestSchema, async (request) =>
    handleToolCall({ name: request.params.name, arguments: request.params.arguments }),
  );

  return {
    async connect(transport: unknown): Promise<void> {
      // Ép kiểu tại ĐÚNG ranh giới SDK: transport do tầng transports cung cấp (kiểu mỏng ở core
      // để core không phụ thuộc SDK).
      await sdkServer.connect(transport as Transport);
    },
    async close(): Promise<void> {
      await sdkServer.close();
    },
  };
}
