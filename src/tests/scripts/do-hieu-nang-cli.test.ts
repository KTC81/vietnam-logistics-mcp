import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { BIEN_BAT_BUOC_THAT } from '../../scripts/hieu-nang-lib.mjs';

// Chạy script thật trong tiến trình con (sau khi globalSetup đã build dist/).
const packageRoot = fileURLToPath(new URL('../../', import.meta.url));

function chayScript(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, ['scripts/do-hieu-nang.mjs', ...argv], {
    cwd: packageRoot,
    encoding: 'utf8',
    env,
    timeout: 120_000,
  });
}

// Môi trường sạch: bỏ hết biến của chế độ thật để test không phụ thuộc máy chạy.
function moiTruongSach(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const ten of [...BIEN_BAT_BUOC_THAT, 'WEIGHT']) {
    delete env[ten];
  }
  return env;
}

// Thư mục tạm nằm TRONG dự án (tests/scripts) để không ghi file ra ngoài; dọn sau mỗi test.
const thuMucTam: string[] = [];

function taoThuMucTam(): string {
  const dir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.tmp-out-'));
  thuMucTam.push(dir);
  return dir;
}

afterEach(() => {
  while (thuMucTam.length > 0) {
    const dir = thuMucTam.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('do-hieu-nang.mjs --mock (chạy đầu-cuối)', () => {
  it('thoát mã 0, in đủ 3 tool và không lộ token/ShopId/mã đơn giả', () => {
    const ketQua = chayScript(['--mock', '--runs', '5', '--warmup', '1'], moiTruongSach());

    expect(ketQua.status).toBe(0);
    expect(ketQua.stdout).toContain('ghn_get_order_detail');
    expect(ketQua.stdout).toContain('ghn_get_fee');
    expect(ketQua.stdout).toContain('ghn_get_shops');
    expect(ketQua.stdout).toContain('ĐẠT');
    expect(ketQua.stdout).not.toContain('TOKEN-GIA-123');
    // Khớp NGUYÊN TỪ: số thực thời gian có thể chứa chuỗi số '999999' do sai số dấu phẩy động.
    expect(ketQua.stdout).not.toMatch(/\b999999\b/);
    expect(ketQua.stdout).not.toContain('G8A123456789');
  });

  it('--json in thêm JSON thô an toàn (không có ngữ cảnh nhạy cảm)', () => {
    const ketQua = chayScript(
      ['--mock', '--runs', '3', '--warmup', '0', '--json'],
      moiTruongSach(),
    );

    expect(ketQua.status).toBe(0);
    expect(ketQua.stdout).toContain('"mode": "mock"');
    expect(ketQua.stdout).not.toContain('TOKEN-GIA-123');
    expect(ketQua.stdout).not.toMatch(/\b999999\b/);
  });
});

describe('do-hieu-nang.mjs chế độ thật (không có token)', () => {
  it('thiếu biến môi trường: liệt kê tên biến, thoát mã 1, không stack', () => {
    const ketQua = chayScript([], moiTruongSach());

    expect(ketQua.status).toBe(1);
    for (const ten of BIEN_BAT_BUOC_THAT) {
      expect(ketQua.stderr).toContain(ten);
    }
    expect(ketQua.stderr).toMatch(/Thiếu biến môi trường/);
    expect(ketQua.stderr).not.toMatch(/^\s+at /m);
    expect(ketQua.stdout).toBe('');
  });

  it('GHN_ENV khác staging: từ chối bằng tiếng Việt, không in giá trị biến', () => {
    const env = moiTruongSach();
    env.GHN_TOKEN = 'TOKEN-GIA-123';
    env.GHN_SHOP_ID = '999999';
    env.GHN_ENV = 'production';
    env.ORDER_CODE = 'G8A000000001';
    env.FROM_DISTRICT = '1442';
    env.TO_DISTRICT = '1443';
    env.TO_WARD = '20110';

    const ketQua = chayScript([], env);

    expect(ketQua.status).toBe(1);
    expect(ketQua.stderr).toContain('staging');
    expect(ketQua.stderr).not.toContain('TOKEN-GIA-123');
    expect(ketQua.stdout).toBe('');
  });
});

describe('do-hieu-nang.mjs --out (không ghi đè im lặng)', () => {
  const THAM_SO_MOCK = ['--mock', '--runs', '2', '--warmup', '0'];

  it('đích mới: ghi báo cáo và thoát 0', () => {
    const dir = taoThuMucTam();
    const dich = join(dir, 'bao-cao.md');

    const ketQua = chayScript([...THAM_SO_MOCK, '--out', dich], moiTruongSach());

    expect(ketQua.status).toBe(0);
    expect(readFileSync(dich, 'utf8')).toContain('# Báo cáo đo hiệu năng');
  });

  it('đích đã tồn tại, không --force: từ chối, giữ nguyên nội dung cũ, thoát 1', () => {
    const dir = taoThuMucTam();
    const dich = join(dir, 'bao-cao.md');
    writeFileSync(dich, 'NOI DUNG CU\n', 'utf8');

    const ketQua = chayScript([...THAM_SO_MOCK, '--out', dich], moiTruongSach());

    expect(ketQua.status).toBe(1);
    expect(ketQua.stderr).toContain('File đã tồn tại. Thêm --force để ghi đè.');
    expect(readFileSync(dich, 'utf8')).toBe('NOI DUNG CU\n');
    expect(ketQua.stdout).toBe('');
  });

  it('có --force: ghi đè file đã tồn tại, thoát 0', () => {
    const dir = taoThuMucTam();
    const dich = join(dir, 'bao-cao.md');
    writeFileSync(dich, 'NOI DUNG CU\n', 'utf8');

    const ketQua = chayScript([...THAM_SO_MOCK, '--out', dich, '--force'], moiTruongSach());

    expect(ketQua.status).toBe(0);
    expect(readFileSync(dich, 'utf8')).toContain('# Báo cáo đo hiệu năng');
  });

  it('đích là thư mục: từ chối kể cả khi có --force, thoát 1', () => {
    const dir = taoThuMucTam();
    const thuMucDich = join(dir, 'la-thu-muc');
    mkdirSync(thuMucDich);

    const ketQua = chayScript([...THAM_SO_MOCK, '--out', thuMucDich, '--force'], moiTruongSach());

    expect(ketQua.status).toBe(1);
    expect(ketQua.stderr).toContain('thư mục');
  });

  it('đích là symlink, không --force: từ chối, không ghi qua symlink', () => {
    const dir = taoThuMucTam();
    const dichThat = join(dir, 'dich-that.md');
    const lienKet = join(dir, 'lien-ket.md');
    writeFileSync(dichThat, 'NOI DUNG GOC\n', 'utf8');
    symlinkSync(dichThat, lienKet);

    const ketQua = chayScript([...THAM_SO_MOCK, '--out', lienKet], moiTruongSach());

    expect(ketQua.status).toBe(1);
    expect(ketQua.stderr).toContain('symlink');
    expect(readFileSync(dichThat, 'utf8')).toBe('NOI DUNG GOC\n');
  });
});
