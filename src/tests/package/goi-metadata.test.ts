import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readServerInfo } from '../../src/main.js';

interface PackageJson {
  name?: string;
  version?: string;
  description?: string;
  private?: boolean;
  type?: string;
  engines?: { node?: string };
  bin?: Record<string, string>;
  files?: string[];
  keywords?: string[];
  author?: string;
  license?: string;
  repository?: { type?: string; url?: string; directory?: string };
  homepage?: string;
  bugs?: { url?: string };
  publishConfig?: { access?: string };
  scripts?: Record<string, string>;
}

const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as PackageJson;
const scripts = pkg.scripts ?? {};

// Metadata phát hành npm của gói. Không kiểm số version cụ thể:
// test chỉ so khớp giữa package.json và readServerInfo().
describe('metadata gói npm', () => {
  it('không còn private, tên gói và bin đúng chuẩn phát hành', () => {
    expect(pkg.private).toBeUndefined();
    expect(pkg.name).toBe('vietnam-logistics-mcp');
    expect(pkg.bin).toEqual({ 'vietnam-logistics-mcp': 'dist/index.js' });
    expect(pkg.type).toBe('module');
    expect(pkg.engines?.node).toBe('>=18');
    expect(pkg.license).toBe('MIT');
    expect(pkg.author).toBe('KTC81');
  });

  it('files đúng danh sách cho phép (không đưa src/, tests/, scripts/ vào gói)', () => {
    expect(pkg.files).toEqual(['dist', 'README.md', 'LICENSE']);
  });

  it('mô tả tiếng Anh một câu, không hứa quá phạm vi v1.1', () => {
    expect(typeof pkg.description).toBe('string');
    expect(pkg.description).toMatch(/^[\x20-\x7E]+$/);
    expect(pkg.description).toContain('MCP');
    expect(pkg.description).toContain('GHN');
  });

  it('keywords phục vụ tìm kiếm npm', () => {
    for (const keyword of [
      'mcp',
      'model-context-protocol',
      'ghn',
      'giaohangnhanh',
      'vietnam',
      'logistics',
      'shipping',
      'claude',
      'ai',
    ]) {
      expect(pkg.keywords).toContain(keyword);
    }
  });

  it('repository/homepage/bugs trỏ repo công khai (tổ chức ktc81), không đặt directory', () => {
    expect(pkg.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/ktc81/vietnam-logistics-mcp.git',
    });
    expect(pkg.homepage).toBe('https://github.com/ktc81/vietnam-logistics-mcp#readme');
    expect(pkg.bugs).toEqual({
      url: 'https://github.com/ktc81/vietnam-logistics-mcp/issues',
    });
    expect(pkg.publishConfig).toEqual({ access: 'public' });
  });

  it('có script đóng gói: prepack build + sao chép, postpack dọn, prepublishOnly chặn publish khi đỏ', () => {
    expect(scripts['prepack']).toContain('npm run build');
    expect(scripts['prepack']).toContain('chuan-bi-goi.mjs chuan-bi');
    expect(scripts['postpack']).toContain('chuan-bi-goi.mjs don-dep');
    expect(scripts['kiem-tra-goi']).toBeDefined();

    const prepublish = scripts['prepublishOnly'] ?? '';
    for (const buoc of ['npm run typecheck', 'npm run lint', 'npm run format:check', 'npm test']) {
      expect(prepublish).toContain(buoc);
    }
    expect(prepublish).toContain('npm run quet-bi-mat');
  });

  it('version khớp giữa package.json và readServerInfo (không hardcode số cụ thể)', () => {
    const info = readServerInfo();

    expect(info.name).toBe(pkg.name);
    expect(info.version).toBe(pkg.version);
  });
});
