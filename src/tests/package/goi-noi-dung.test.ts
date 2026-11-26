import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PACKAGE_ROOT, donDep } from '../../scripts/chuan-bi-goi.mjs';
import { findSecrets } from '../../scripts/quet-bi-mat.mjs';

const packageRoot = PACKAGE_ROOT;
const rootRepo = fileURLToPath(new URL('../../../', import.meta.url));

interface NpmCommand {
  command: string;
  args: string[];
}

/**
 * npm đa nền tảng: ưu tiên `npm_execpath` (npm tự đặt khi chạy `npm test`), gọi qua
 * `process.execPath` để không vướng `npm.cmd` trên Windows. Không thấy thì skip kèm lý do.
 */
function timNpm(): NpmCommand | undefined {
  const execpath = process.env['npm_execpath'];
  if (execpath !== undefined && execpath !== '' && existsSync(execpath)) {
    return { command: process.execPath, args: [execpath] };
  }
  try {
    execFileSync('npm', ['--version'], { stdio: 'pipe' });
    return { command: 'npm', args: [] };
  } catch {
    return undefined;
  }
}

const npm = timNpm();
let danhSachFile: string[] = [];
let tenTgz = '';

interface PackJson {
  filename: string;
  size: number;
  unpackedSize: number;
  files: { path: string; size: number }[];
}

beforeAll(() => {
  if (npm === undefined) {
    return;
  }
  // `npm pack` tự chạy prepack (build + sao chép README/LICENSE) và postpack (dọn).
  const output = execFileSync(npm.command, [...npm.args, 'pack', '--dry-run', '--json'], {
    cwd: packageRoot,
    encoding: 'utf8',
    timeout: 240_000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const dau = output.indexOf('[');
  const cuoi = output.lastIndexOf(']');
  if (dau === -1 || cuoi <= dau) {
    throw new Error('Không đọc được JSON của `npm pack --dry-run --json`.');
  }
  const goi = (JSON.parse(output.slice(dau, cuoi + 1)) as PackJson[])[0];
  if (goi === undefined || !Array.isArray(goi.files)) {
    throw new Error('`npm pack --dry-run --json` không trả danh sách file.');
  }
  tenTgz = goi.filename;
  danhSachFile = goi.files.map((file) => file.path);
});

afterAll(() => {
  // Dọn để `git status` không còn file lạ (README/LICENSE bản sao, .tgz).
  donDep(packageRoot);
  if (tenTgz !== '') {
    rmSync(join(packageRoot, tenTgz), { force: true });
  }
});

/** Đọc nội dung một file thuộc gói; README/LICENSE lấy bản gốc nếu postpack đã dọn bản sao. */
function docNoiDung(duongDan: string): string {
  const trongGoi = join(packageRoot, duongDan);
  if (existsSync(trongGoi)) {
    return readFileSync(trongGoi, 'utf8');
  }
  return readFileSync(join(rootRepo, duongDan), 'utf8');
}

/** Mọi file .ts dưới src/src đổi đuôi thành .js — đúng những gì tsc phải sinh ra trong dist/. */
function lietKeDauRaTuSource(): string[] {
  const goc = join(packageRoot, 'src');
  const ketQua: string[] = [];
  const duyet = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        duyet(full);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        ketQua.push(relative(goc, full).split('\\').join('/').replace(/\.ts$/, '.js'));
      }
    }
  };
  duyet(goc);
  return ketQua.sort();
}

describe.skipIf(npm === undefined)('nội dung gói npm (npm pack --dry-run)', () => {
  it('chỉ gồm package.json, README, LICENSE và dist/**; đủ file bắt buộc', () => {
    expect(danhSachFile.length).toBeGreaterThan(0);

    for (const duongDan of danhSachFile) {
      const duocPhep =
        duongDan === 'package.json' ||
        duongDan === 'README.md' ||
        duongDan === 'LICENSE' ||
        duongDan.startsWith('dist/');
      expect(duocPhep, `File không được phép trong gói: ${duongDan}`).toBe(true);
    }

    for (const batBuoc of ['package.json', 'README.md', 'LICENSE', 'dist/index.js']) {
      expect(danhSachFile).toContain(batBuoc);
    }
  });

  it('không có src/, tests/, scripts/, cấu hình dev, bản đồ nguồn hay file rác', () => {
    for (const duongDan of danhSachFile) {
      expect(duongDan.startsWith('src/'), duongDan).toBe(false);
      expect(duongDan.startsWith('tests/'), duongDan).toBe(false);
      expect(duongDan.startsWith('scripts/'), duongDan).toBe(false);
      expect(duongDan.includes('node_modules'), duongDan).toBe(false);
      expect(duongDan.startsWith('.env'), duongDan).toBe(false);
      expect(duongDan.endsWith('.map'), duongDan).toBe(false);
      expect(duongDan.endsWith('.gitkeep'), duongDan).toBe(false);
      expect(duongDan.endsWith('.tgz'), duongDan).toBe(false);
      expect(duongDan.startsWith('tsconfig'), duongDan).toBe(false);
      expect(duongDan.startsWith('eslint.config'), duongDan).toBe(false);
      expect(duongDan.startsWith('vitest.config'), duongDan).toBe(false);
    }
  });

  it('không lộ bí mật: findSecrets = 0, dist/**/*.js không có đường dẫn tuyệt đối máy dev', () => {
    const files = danhSachFile.map((duongDan) => ({
      path: duongDan,
      content: docNoiDung(duongDan),
    }));

    expect(findSecrets(files)).toEqual([]);

    for (const file of files) {
      if (!file.path.startsWith('dist/') || !file.path.endsWith('.js')) {
        continue;
      }
      expect(file.content, file.path).not.toContain('/Users/');
      expect(file.content, file.path).not.toContain('C:\\Users');
    }
  });

  it('dist chỉ chứa mã biên dịch từ src/ — không thừa file rác build cũ, không thiếu', () => {
    const trongDist = danhSachFile
      .filter((duongDan) => duongDan.startsWith('dist/'))
      .map((duongDan) => duongDan.slice('dist/'.length))
      .sort();

    expect(trongDist).toEqual(lietKeDauRaTuSource());
  });

  it('gói chỉ gồm file trong danh sách cho phép: dist/** khớp nguồn + package.json, README.md, LICENSE', () => {
    const mongDoi = [
      'package.json',
      'README.md',
      'LICENSE',
      ...lietKeDauRaTuSource().map((duongDan) => `dist/${duongDan}`),
    ].sort();

    expect([...danhSachFile].sort()).toEqual(mongDoi);
  });

  it('dist/index.js có shebang đúng ở dòng 1 và kết thúc bằng xuống dòng', () => {
    const noiDung = readFileSync(join(packageRoot, 'dist', 'index.js'), 'utf8');

    expect(noiDung.split('\n')[0]).toBe('#!/usr/bin/env node');
    expect(noiDung.endsWith('\n')).toBe(true);
  });

  it('prepack/postpack đã dọn sạch bản sao trong src/ (git status không có file lạ)', () => {
    expect(existsSync(join(packageRoot, 'LICENSE'))).toBe(false);
    // README.md của gói bị xóa khỏi git; không được xuất hiện lại sau pack.
    expect(existsSync(join(packageRoot, 'README.md'))).toBe(false);
  });
});
