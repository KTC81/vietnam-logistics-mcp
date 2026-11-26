import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DIA_CHI_GIA, SDT_GIA, TEN_GIA, TOKEN_GIA_SECRET } from '../helpers/security-fixtures.js';
import { taoRegistry } from '../helpers/security-harness.js';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const distEntry = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

function taoEnv(token: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GHN_ENV: 'staging', GHN_SHOP_ID: '999999' };
  if (token !== undefined) {
    env['GHN_TOKEN'] = token;
  }
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
// Timeout cứng để không treo và không để tiến trình mồ côi.
function chayServer(lines: string[], token: string | undefined): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [distEntry], {
      cwd: packageRoot,
      env: taoEnv(token),
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
    child.stdin.on('error', (error) => {
      // Chỉ fail khi ta CÓ ghi dữ liệu; tiến trình thoát sớm (thiếu token) là hành vi đúng.
      if (lines.length > 0) {
        clearTimeout(timer);
        child.kill('SIGKILL');
        reject(new Error(`Ghi stdin thất bại: ${error.message}\nstderr:\n${stderr}`));
      }
    });

    for (const line of lines) {
      child.stdin.write(`${line}\n`);
    }
    child.stdin.end();
  });
}

function tinNhan(lines: string[]): string[] {
  return [
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'security-stdio-test', version: '1.0.0' },
      },
    }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    ...lines,
  ];
}

// Chỉ chấp nhận các dòng cảnh báo Node ĐÃ BIẾT ngoài log JSON của ta; mọi dòng khác (stack,
// "Error: ...", chữ rác) phải làm test đỏ.
function laCanhBaoNodeDaBiet(dong: string): boolean {
  const text = dong.trim();
  if (text === '') {
    return true;
  }
  return /^\(node:\d+\) /.test(text) || /^\(Use `node --trace-warnings/.test(text);
}

function laDongJson(dong: string): boolean {
  const text = dong.trim();
  return text.startsWith('{') && text.endsWith('}');
}

describe('bộ lọc dòng stderr', () => {
  it.each([
    '(node:12345) ExperimentalWarning: feature is experimental',
    '(Use `node --trace-warnings ...` to show where the warning was created)',
    '',
    '   ',
  ])('chấp nhận cảnh báo Node/dòng trống: %j', (dong) => {
    expect(laCanhBaoNodeDaBiet(dong)).toBe(true);
  });

  it.each(['    at Object.<anonymous> (/Users/may/a.ts:1:1)', 'Error: boom', 'rác'])(
    'coi %j là VI PHẠM',
    (dong) => {
      expect(laCanhBaoNodeDaBiet(dong)).toBe(false);
    },
  );

  it('nhận diện dòng JSON log của ta', () => {
    expect(laDongJson('{"ts":"x","level":"info"}')).toBe(true);
    expect(laDongJson('không phải json')).toBe(false);
  });
});

describe('stdio thật: không lộ token/PII', () => {
  // dist/ được build MỘT lần bởi tests/global-setup.ts (vitest globalSetup), không build song song.

  // Chốt "xanh giả": registry rỗng thì chính test này đỏ.
  it('registry có ít nhất 3 tool để kiểm stdio', () => {
    expect(taoRegistry().list().length).toBeGreaterThanOrEqual(3);
  });

  it('initialize/tools/list/tools/call sai: stdout chỉ JSON-RPC, không lộ token', async () => {
    const goiSai = taoRegistry()
      .list()
      .map((tool, index) =>
        JSON.stringify({
          jsonrpc: '2.0',
          id: 10 + index,
          method: 'tools/call',
          params: { name: tool.name, arguments: { khoa_la_doc_hai: 'gia-tri-la' } },
        }),
      );

    const result = await chayServer(tinNhan(goiSai), TOKEN_GIA_SECRET);

    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    for (const text of [result.stdout, result.stderr]) {
      expect(text).not.toContain(TOKEN_GIA_SECRET);
      expect(text).not.toContain(TEN_GIA);
      expect(text).not.toContain(SDT_GIA);
      expect(text).not.toContain(DIA_CHI_GIA);
    }

    const stdoutLines = result.stdout.split('\n').filter((line) => line.trim() !== '');
    expect(stdoutLines.length).toBeGreaterThanOrEqual(2 + goiSai.length);
    for (const line of stdoutLines) {
      const message = JSON.parse(line) as { jsonrpc?: unknown };
      expect(message.jsonrpc).toBe('2.0');
    }

    // stderr có thể có cảnh báo Node ĐÃ BIẾT (ExperimentalWarning...): chỉ bỏ qua đúng các mẫu
    // đó; mọi dòng khác phải là JSON log hợp lệ, nếu không test đỏ. Vẫn kiểm token trên TOÀN BỘ.
    for (const line of result.stderr.split('\n').filter((item) => item.trim() !== '')) {
      if (laDongJson(line)) {
        const entry = JSON.parse(line) as Record<string, unknown>;
        expect(entry['ts']).toBeTypeOf('string');
        expect(['info', 'warn', 'error']).toContain(entry['level']);
        continue;
      }
      expect(laCanhBaoNodeDaBiet(line), `stderr có dòng không được phép: ${line}`).toBe(true);
    }
    expect(result.stderr).not.toContain('    at ');
  }, 30_000);

  it('thiếu GHN_TOKEN: thoát mã khác 0, chỉ nêu tên biến, không stack/giá trị', async () => {
    const result = await chayServer([], undefined);

    expect(result.code).not.toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).toContain('GHN_TOKEN');
    expect(result.stderr).not.toContain(TOKEN_GIA_SECRET);
    expect(result.stderr).not.toContain('    at ');
    expect(result.stderr).not.toContain('/Users/');
    expect(result.stderr).not.toContain('node_modules');
  }, 20_000);
});
