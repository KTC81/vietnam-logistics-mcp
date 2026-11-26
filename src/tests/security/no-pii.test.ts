import { describe, expect, it } from 'vitest';
import {
  KHOA_PII,
  PII_GIA,
  TOKEN_GIA_SECRET,
  TOOL_FIXTURES,
  type ToolFixture,
} from '../helpers/security-fixtures.js';
import { goiTool, taoHarness, taoRegistry } from '../helpers/security-harness.js';
import { installMockFetch } from '../helpers/mock-fetch.js';

function layFixture(tenTool: string): ToolFixture {
  const fixture = TOOL_FIXTURES[tenTool];
  if (fixture === undefined) {
    throw new Error(`Thiếu fixture bảo mật cho tool ${tenTool}`);
  }
  return fixture;
}

// Duyệt toàn bộ cây kết quả: kiểm cả TÊN KHÓA lẫn GIÁ TRỊ.
function duyetKetQua(node: unknown, duongDan: string, viPham: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((value, index) => duyetKetQua(value, `${duongDan}[${index}]`, viPham));
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const key of Object.keys(node)) {
      if (key === '__proto__') {
        viPham.push(`${duongDan}.__proto__`);
      }
      if ((KHOA_PII as readonly string[]).includes(key)) {
        viPham.push(`${duongDan}.${key} (tên khóa PII)`);
      }
      duyetKetQua((node as Record<string, unknown>)[key], `${duongDan}.${key}`, viPham);
    }
    return;
  }
  if (typeof node === 'string' || typeof node === 'number') {
    const text = String(node);
    for (const pii of PII_GIA) {
      if (text.includes(pii)) {
        viPham.push(`${duongDan} chứa PII`);
      }
    }
    if (text.includes(TOKEN_GIA_SECRET)) {
      viPham.push(`${duongDan} chứa token`);
    }
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
    for (const name of names) {
      expect(TOOL_FIXTURES[name], `Thiếu fixture cho tool ${name}`).toBeDefined();
    }
  });
});

for (const tool of taoRegistry().list()) {
  describe(`tool ${tool.name}: không trả PII`, () => {
    const fixture = layFixture(tool.name);

    it('PII THỰC SỰ đi qua mock tới tool, nhưng kết quả chỉ có allowlist', async () => {
      // Chốt "xanh giả": thân phản hồi mẫu phải CHỨA PII/token/khóa PII thì phép thử mới có nghĩa.
      const bodyJson = JSON.stringify(fixture.successBody);
      for (const pii of PII_GIA) {
        expect(bodyJson, `fixture thiếu PII ${pii.slice(0, 4)}…`).toContain(pii);
      }
      expect(bodyJson).toContain(TOKEN_GIA_SECRET);
      for (const key of KHOA_PII) {
        expect(bodyJson, `fixture thiếu khóa ${key}`).toContain(`"${key}"`);
      }
      const data = fixture.successBody['data'] as Record<string, unknown>;
      expect(Object.keys(data)).toContain('__proto__');

      const mock = installMockFetch([{ method: fixture.method, body: fixture.successBody }]);
      const harness = await taoHarness();
      try {
        const { payload, isError } = await goiTool(
          harness.client,
          tool.name,
          fixture.validArguments,
        );

        // PII phải THỰC SỰ đi qua cổng GHN tới tool.
        expect(mock.calls.length).toBeGreaterThan(0);
        // Phản hồi mẫu phải thành công thì test mới có ý nghĩa.
        expect(isError).toBe(false);
        expect(payload['ok']).toBe(true);

        const viPham: string[] = [];
        duyetKetQua(payload, '$', viPham);

        expect(viPham).toEqual([]);
        const json = JSON.stringify(payload);
        for (const pii of PII_GIA) {
          expect(json).not.toContain(pii);
        }
        expect(json).not.toContain(TOKEN_GIA_SECRET);
        expect(json).not.toContain('__proto__');
      } finally {
        await harness.close();
      }
    });
  });
}
