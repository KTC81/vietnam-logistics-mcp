/**
 * Dựng toàn bộ tiến trình MCP Local và nối stdio.
 *
 * Hàm `main()` được tách khỏi `index.ts` để test gọi với đầu vào giả, không tự khởi động.
 * stdout dành riêng cho giao thức MCP: mọi thông báo của ta đi qua stderr/logger.
 */
import { readFileSync } from 'node:fs';
import { isAppError } from './core/errors.js';
import type { McpServerHandle, ToolLogger, ToolRegistry, TransportFactory } from './core/types.js';
import { loadConfig, EnvCredentialProvider, type AppConfig, type EnvSource } from './config/env.js';
import { createGhnClient } from './services/ghn-client.js';
import { AllowAll } from './services/license-allow-all.js';
import { createMcpServer } from './server.js';
import { getOrderDetailTool } from './tools/ghn/get-order-detail.js';
import { getShopsTool } from './tools/ghn/get-shops.js';
import { getFeeTool } from './tools/ghn/get-fee.js';
import { createToolRegistry } from './tools/registry.js';
import { createStdioTransport } from './transports/stdio.js';
import { createLogger } from './utils/logger.js';

/** Tùy chọn cho `main`, chủ yếu để test thay đầu ra/hành vi tiến trình. */
export interface MainOptions {
  /** Nguồn biến môi trường; mặc định `process.env`. */
  env?: EnvSource;
  /** Ghi một dòng thông báo lỗi; mặc định `process.stderr.write`. */
  writeStderr?: (line: string) => void;
  /** Thoát tiến trình; mặc định `process.exit`. */
  exit?: (code: number) => void;
  /** Transport; mặc định stdio. */
  transport?: TransportFactory;
  /** Đăng ký tool vào registry (3 tool được cắm ở đây). */
  registerTools?: (registry: ToolRegistry) => void;
  /** Đồng hồ đo thời gian, chuyển cho server (test). */
  now?: () => number;
  /** Sinh requestId, chuyển cho server (test). */
  newRequestId?: () => string;
  /** Đăng ký handler tín hiệu; mặc định `process.once` (test có thể bắt handler). */
  onSignal?: (signal: 'SIGINT' | 'SIGTERM', handler: () => void) => void;
  /** Cài handler `unhandledRejection`/`uncaughtException`; mặc định true (test tắt để không đụng tiến trình). */
  installProcessHandlers?: boolean;
}

/** Tay cầm sau khi server chạy, để test kiểm tra/đóng. */
export interface MainHandle {
  logger: ToolLogger;
  server: McpServerHandle;
  transport: TransportFactory;
  /** Dừng transport (idempotent). */
  stop: () => Promise<void>;
}

// EPIPE khi stderr bị đóng phát sự kiện 'error'; không có listener thì tiến trình sập.
// Cài một lần cho cả tiến trình (nhiều lần gọi main trong test không thêm listener).
let stderrErrorGuardInstalled = false;

function installStderrErrorGuard(): void {
  if (stderrErrorGuardInstalled) {
    return;
  }
  stderrErrorGuardInstalled = true;
  process.stderr.on('error', () => {
    // Nuốt EPIPE: không thể báo lỗi qua chính stderr đang hỏng.
  });
}

/** Đọc name/version từ package.json tại lúc dựng (một nguồn duy nhất, không hardcode). */
export function readServerInfo(): { name: string; version: string } {
  const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
  if (typeof parsed.name !== 'string' || typeof parsed.version !== 'string') {
    throw new Error('main: package.json is missing name/version');
  }
  return { name: parsed.name, version: parsed.version };
}

/**
 * Dựng logger, client GHN, license AllowAll, registry, server MCP và nối transport.
 * Lỗi cấu hình: ghi MỘT dòng tiếng Việt (chỉ tên biến, không giá trị), thoát mã 1.
 */
export async function main(options: MainOptions = {}): Promise<MainHandle | undefined> {
  installStderrErrorGuard();

  const writeStderr = options.writeStderr ?? ((line: string) => process.stderr.write(line));
  const exit = options.exit ?? ((code: number) => process.exit(code));

  let config: AppConfig;
  try {
    config = loadConfig(options.env);
  } catch (error) {
    // Chỉ in messageVi (chỉ tên biến thiếu/sai), tuyệt đối không in giá trị hay stack.
    const message = isAppError(error)
      ? error.messageVi
      : 'Không đọc được cấu hình. Kiểm tra biến môi trường rồi khởi động lại.';
    writeStderr(`${message}\n`);
    exit(1);
    return undefined;
  }

  const logger = createLogger({ level: config.logLevel });
  const credentials = new EnvCredentialProvider(config);
  const ghn = createGhnClient({ credentials, logger });
  const license = new AllowAll();
  // 3 tool được đăng ký tại đây.
  const registry = createToolRegistry();
  registry.register(getOrderDetailTool);
  registry.register(getShopsTool);
  registry.register(getFeeTool);
  options.registerTools?.(registry);

  const server = createMcpServer({
    registry,
    credentials,
    ghn,
    license,
    logger,
    serverInfo: readServerInfo(),
    now: options.now,
    newRequestId: options.newRequestId,
  });

  const transport = options.transport ?? createStdioTransport();
  await transport.start(server);

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    await transport.stop();
  };

  const onSignal =
    options.onSignal ??
    ((signal: 'SIGINT' | 'SIGTERM', handler: () => void): void => {
      process.once(signal, handler);
    });

  const shutdown = (): void => {
    void stop()
      .then(() => exit(0))
      .catch(() => exit(1));
  };
  onSignal('SIGINT', shutdown);
  onSignal('SIGTERM', shutdown);

  if (options.installProcessHandlers !== false) {
    // Chỉ ghi mã lỗi + nhãn sự kiện: không in stack, không in nội dung lỗi (có thể chứa token).
    process.on('unhandledRejection', () => {
      logger.error({ event: 'unhandled_rejection', code: 'INTERNAL_ERROR' });
      exit(1);
    });
    process.on('uncaughtException', () => {
      logger.error({ event: 'uncaught_exception', code: 'INTERNAL_ERROR' });
      exit(1);
    });
  }

  return { logger, server, transport, stop };
}
