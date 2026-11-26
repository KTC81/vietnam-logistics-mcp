import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { McpServerHandle } from '../../src/core/types.js';
import { createStdioTransport } from '../../src/transports/stdio.js';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const distEntry = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

// Env tối thiểu cho tiến trình con: không kế thừa GHN_SHOP_ID/LOG_LEVEL hay biến lạ của máy chạy.
function taoEnvToiThieu(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    GHN_TOKEN: 'TOKEN-GIA-123',
    GHN_ENV: 'staging',
  };
  // Node/OS có thể cần PATH, HOME (macOS/Linux) hoặc USERPROFILE (Windows).
  for (const key of ['PATH', 'HOME', 'USERPROFILE'] as const) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

// Chạy tiến trình thật `node dist/index.js`, gửi các dòng JSON-RPC rồi đóng stdin.
// Có timeout cứng để test không treo nếu tiến trình con không thoát.
function chayServer(lines: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [distEntry], {
      cwd: packageRoot,
      env: taoEnvToiThieu(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Tiến trình con không thoát sau 10 giây'));
    }, 10_000);

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, signal });
    });

    // EPIPE khi tiến trình con chết sớm không được làm sập worker; phải fail test rõ ràng.
    child.stdin.on('error', (error) => {
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(
        new Error(
          `Ghi stdin cho tiến trình con thất bại: ${error.message}\nstderr đã thu:\n${stderr}`,
        ),
      );
    });

    for (const line of lines) {
      child.stdin.write(`${line}\n`);
    }
    child.stdin.end();
  });
}

describe('createStdioTransport', () => {
  it("name là 'stdio'; start/stop không ném và stop idempotent", async () => {
    const factory = createStdioTransport();
    const transports: unknown[] = [];
    const server: McpServerHandle = {
      async connect(transport: unknown): Promise<void> {
        transports.push(transport);
      },
      async close(): Promise<void> {},
    };

    expect(factory.name).toBe('stdio');
    await expect(factory.start(server)).resolves.toBeUndefined();
    expect(transports).toHaveLength(1);

    await expect(factory.stop()).resolves.toBeUndefined();
    await expect(factory.stop()).resolves.toBeUndefined();
  });

  it('không ghi byte nào ra stdout khi start/stop', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const factory = createStdioTransport();
      const server: McpServerHandle = {
        async connect(): Promise<void> {},
        async close(): Promise<void> {},
      };

      await factory.start(server);
      await factory.stop();

      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});

describe('stdio thật: spawn node dist/index.js', () => {
  // dist/ được build một lần bởi tests/global-setup.ts (vitest globalSetup).
  it('stdout chỉ JSON-RPC, stderr chỉ log JSON, thoát gọn, không lộ token', async () => {
    const initialize = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'stdio-test', version: '1.0.0' },
      },
    });
    const initialized = JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    const list = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const callUnknown = JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'khong_ton_tai', arguments: {} },
    });

    const result = await chayServer([initialize, initialized, list, callUnknown]);

    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).not.toContain('TOKEN-GIA-123');
    expect(result.stderr).not.toContain('TOKEN-GIA-123');

    const stdoutLines = result.stdout.split('\n').filter((line) => line.trim() !== '');
    expect(stdoutLines.length).toBeGreaterThanOrEqual(3);
    for (const line of stdoutLines) {
      const message = JSON.parse(line) as { jsonrpc?: unknown };
      expect(message.jsonrpc).toBe('2.0');
    }
    const ids = stdoutLines.map((line) => (JSON.parse(line) as { id?: number }).id);
    expect(ids).toContain(1);
    expect(ids).toContain(2);
    expect(ids).toContain(3);

    const stderrLines = result.stderr.split('\n').filter((line) => line.trim() !== '');
    for (const line of stderrLines) {
      const entry = JSON.parse(line) as Record<string, unknown>;
      expect(entry['ts']).toBeDefined();
      expect(entry['level']).toBeDefined();
      expect(entry['event']).toBeDefined();
    }
  }, 20_000);
});
