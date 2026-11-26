import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../src/utils/logger.js';
import {
  PII_GIA,
  TOKEN_GIA_SECRET,
  TOOL_FIXTURES,
  giaTriDauVao,
  type ToolFixture,
} from '../helpers/security-fixtures.js';
import { goiTool, taoHarness, taoRegistry } from '../helpers/security-harness.js';
import { installMockFetch } from '../helpers/mock-fetch.js';

const KHOA_LOG_AN_TOAN = new Set([
  'ts',
  'level',
  'tool',
  'code',
  'ms',
  'httpStatus',
  'requestId',
  'event',
  'dropped',
]);

function layFixture(tenTool: string): ToolFixture {
  const fixture = TOOL_FIXTURES[tenTool];
  if (fixture === undefined) {
    throw new Error(`Thiếu fixture bảo mật cho tool ${tenTool}`);
  }
  return fixture;
}

// So khóa/giá trị của một dòng log, BỎ `ms` (số đo thời gian, không suy ra từ đầu vào).
function kiemDongLog(line: string, giaTriCam: readonly string[]): void {
  const entry = JSON.parse(line) as Record<string, unknown>;
  expect(entry['ts']).toBeTypeOf('string');
  expect(['info', 'warn', 'error']).toContain(entry['level']);
  for (const key of Object.keys(entry)) {
    expect(KHOA_LOG_AN_TOAN.has(key), `khóa log lạ: ${key}`).toBe(true);
  }

  const khongCoMs = { ...entry };
  delete khongCoMs['ms'];
  const text = JSON.stringify(khongCoMs);
  for (const value of [...giaTriCam, TOKEN_GIA_SECRET, ...PII_GIA, '32000', '350000']) {
    expect(text, 'log lộ giá trị đầu vào/dữ liệu').not.toContain(value);
  }
}

// Chốt "xanh giả": registry rỗng thì chính test này đỏ.
describe('bộ test bảo mật: registry và fixture', () => {
  it('registry có ít nhất 3 tool và khớp bảng fixture', () => {
    const names = taoRegistry()
      .list()
      .map((tool) => tool.name);

    expect(names.length).toBeGreaterThanOrEqual(3);
    expect(names.length).toBe(Object.keys(TOOL_FIXTURES).length);
  });
});

for (const tool of taoRegistry().list()) {
  describe(`tool ${tool.name}: log an toàn`, () => {
    const fixture = layFixture(tool.name);
    const giaTriCam = giaTriDauVao(fixture).map(String);

    it('log thành công, lỗi GHN và đầu vào sai: JSON hợp lệ, chỉ khóa allowlist, không lộ dữ liệu', async () => {
      const lines: string[] = [];
      const logger = createLogger({
        write: (line) => lines.push(line),
        now: () => new Date('2026-01-01T00:00:00.000Z'),
      });
      const harness = await taoHarness({ logger });
      try {
        // 1) Thành công
        let mock = installMockFetch([{ method: fixture.method, body: fixture.successBody }]);
        let result = await goiTool(harness.client, tool.name, fixture.validArguments);
        mock.restore();
        expect(result.isError).toBe(false);

        // 2) Lỗi GHN (5xx, client thử lại một lần)
        mock = installMockFetch([{ method: fixture.method, status: 500 }]);
        result = await goiTool(harness.client, tool.name, fixture.validArguments);
        mock.restore();
        expect(result.isError).toBe(true);

        // 3) Đầu vào sai
        result = await goiTool(harness.client, tool.name, {
          ...fixture.validArguments,
          khoa_la: 'gia-tri-la',
        });
        expect(result.isError).toBe(true);
      } finally {
        await harness.close();
      }

      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line.endsWith('\n')).toBe(true);
        kiemDongLog(line.trimEnd(), giaTriCam);
      }

      // Có log của ghn-client (client nhận cùng logger) với khóa allowlist.
      const events = lines.map((line) => (JSON.parse(line) as Record<string, unknown>)['event']);
      expect(events).toContain('ghn_call');
    });

    it('logger MẶC ĐỊNH ghi stderr (được gọi) và KHÔNG ghi stdout', async () => {
      installMockFetch([{ method: fixture.method, body: fixture.successBody }]);
      const stderrLines: string[] = [];
      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation((chunk: unknown): boolean => {
          stderrLines.push(String(chunk));
          return true;
        });
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      // Không tiêm `write`: dùng đúng đường mặc định (stderr) của createLogger.
      const logger = createLogger();
      const harness = await taoHarness({ logger });
      try {
        const result = await goiTool(harness.client, tool.name, fixture.validArguments);

        expect(result.isError).toBe(false);
        // Spy phải THỰC SỰ bắt được dòng log, nếu không test sẽ xanh giả.
        expect(stderrSpy.mock.calls.length).toBeGreaterThan(0);
        expect(stdoutSpy).not.toHaveBeenCalled();
        expect(stderrLines.join('')).not.toContain(TOKEN_GIA_SECRET);
        for (const line of stderrLines) {
          for (const part of line.split('\n').filter((item) => item.trim() !== '')) {
            kiemDongLog(part, giaTriCam);
          }
        }
      } finally {
        await harness.close();
        stderrSpy.mockRestore();
        stdoutSpy.mockRestore();
      }
    });
  });
}

describe('logger: khóa lạ và giá trị nhạy cảm không được ghi', () => {
  it('chỉ ghi khóa allowlist, đếm số khóa bị bỏ, không đọc giá trị lạ', () => {
    const lines: string[] = [];
    const logger = createLogger({ write: (line) => lines.push(line) });

    logger.info({
      tool: 'ghn_get_fee',
      event: 'tool_call',
      order_code: 'G8AGIA123',
      token: TOKEN_GIA_SECRET,
      phone: '0900000000',
    });

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(entry).toMatchObject({
      level: 'info',
      tool: 'ghn_get_fee',
      event: 'tool_call',
      dropped: 3,
    });
    expect(lines[0]).not.toContain(TOKEN_GIA_SECRET);
    expect(lines[0]).not.toContain('G8AGIA123');
    expect(lines[0]).not.toContain('0900000000');
  });
});
