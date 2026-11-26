import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectTrackedFiles,
  collectTrackedNames,
  findForbiddenTrackedNames,
  findSecrets,
  isProbablyBinary,
  quetThuMuc,
} from '../../scripts/quet-bi-mat.mjs';

// Token "trông như thật" dùng cho fixture (KHÔNG phải bí mật thật).
const TOKEN_TRONG_NHU_THAT = 'abcdef0123456789abcdef0123456789';
const UUID_MAU = '3f6c1d2a-9b7e-4c55-8a10-0d2e5b7f9a11';

const thuMucTam: string[] = [];

// Thư mục tạm nằm TRONG dự án (tests/security) để không ghi file ra ngoài thư mục dự án.
function taoThuMucTam(prefix = '.tmp-quet-'): string {
  const base = dirname(fileURLToPath(import.meta.url));
  const dir = mkdtempSync(join(base, prefix));
  thuMucTam.push(dir);
  return dir;
}

let coGit = true;
try {
  execFileSync('git', ['--version'], { stdio: 'pipe' });
} catch {
  coGit = false;
}
const itGit = coGit ? it : it.skip;

afterEach(() => {
  while (thuMucTam.length > 0) {
    const dir = thuMucTam.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('findSecrets', () => {
  it('phát hiện token gán vào biến, không trả nội dung', () => {
    const findings = findSecrets([
      { path: 'a.ts', content: `const GHN_TOKEN = ${TOKEN_TRONG_NHU_THAT};` },
    ]);

    expect(findings).toEqual([{ path: 'a.ts', line: 1, kind: 'ghn_token' }]);
    expect(JSON.stringify(findings)).not.toContain(TOKEN_TRONG_NHU_THAT);
  });

  it.each([
    { nhan: 'khóa JSON có nháy kép', content: `"GHN_TOKEN": "${TOKEN_TRONG_NHU_THAT}"` },
    { nhan: 'khóa JSON token thường', content: `"token": "${TOKEN_TRONG_NHU_THAT}"` },
    { nhan: 'khóa có nháy đơn', content: `'Token': '${TOKEN_TRONG_NHU_THAT}'` },
  ])('phát hiện dạng JSON $nhan (claude_desktop_config.json)', ({ content }) => {
    expect(findSecrets([{ path: 'config.json', content }])).toEqual([
      { path: 'config.json', line: 1, kind: 'ghn_token' },
    ]);
  });

  it.each([
    {
      nhan: 'tiền tố giả + đuôi thật (env)',
      content: `GHN_TOKEN=token-gia-khong-dung-that.${TOKEN_TRONG_NHU_THAT}`,
    },
    {
      nhan: 'tiền tố giả + đuôi thật (JSON)',
      content: `"GHN_TOKEN": "token-gia-khong-dung-that.${TOKEN_TRONG_NHU_THAT}"`,
    },
    {
      nhan: 'TOKEN-GIA + đuôi thật',
      content: `GHN_TOKEN=TOKEN-GIA-SECRET-123456.${TOKEN_TRONG_NHU_THAT}`,
    },
    {
      nhan: 'UUID mẫu + đuôi thật',
      content: `token = '${UUID_MAU}.${TOKEN_TRONG_NHU_THAT}'`,
    },
  ])('allowlist không bị lách: $nhan phải bị báo', ({ content }) => {
    expect(findSecrets([{ path: 'lach.env', content }])).toEqual([
      { path: 'lach.env', line: 1, kind: 'ghn_token' },
    ]);
  });

  it.each([
    { nhan: 'Authorization JSON', content: `"Authorization": "Bearer ${TOKEN_TRONG_NHU_THAT}"` },
    {
      nhan: 'Authorization trong object JS',
      content: `headers: { Authorization: "Bearer ${TOKEN_TRONG_NHU_THAT}" }`,
    },
    { nhan: 'khóa token với Bearer', content: `{"token":"Bearer ${TOKEN_TRONG_NHU_THAT}"}` },
    {
      nhan: 'authorization/bearer chữ thường',
      content: `authorization: bearer ${TOKEN_TRONG_NHU_THAT}`,
    },
    { nhan: 'BEARER chữ hoa', content: `Authorization: BEARER ${TOKEN_TRONG_NHU_THAT}` },
  ])('phát hiện Bearer $nhan', ({ content }) => {
    expect(findSecrets([{ path: 'bearer.json', content }])).toEqual([
      { path: 'bearer.json', line: 1, kind: 'bearer_token' },
    ]);
  });

  it.each([
    { nhan: 'YAML GHN_TOKEN', content: `GHN_TOKEN: ${TOKEN_TRONG_NHU_THAT}` },
    { nhan: '.env export có nháy', content: `export GHN_TOKEN='${TOKEN_TRONG_NHU_THAT}'` },
    { nhan: 'khóa x-ghn-token', content: `"x-ghn-token": "${TOKEN_TRONG_NHU_THAT}"` },
  ])('không hồi quy: vẫn bắt $nhan', ({ content }) => {
    expect(findSecrets([{ path: 'cu.env', content }])).toEqual([
      { path: 'cu.env', line: 1, kind: 'ghn_token' },
    ]);
  });

  it('phát hiện Token: header, Bearer, khóa riêng, PAT GitHub và sk- hiện đại', () => {
    // Ghép chuỗi lúc chạy để chính file test không chứa mẫu bí mật literal (máy quét không báo nhầm).
    const khoaRiengGia = `-----BEGIN ${'RSA'} PRIVATE KEY-----`;
    const githubPatGia = `github_pat_${'a'.repeat(30)}`;
    const githubGhpGia = `ghp_${'b'.repeat(30)}`;
    const skAntGia = `sk-ant-api03-${'c'.repeat(20)}`;
    const skProjGia = `sk-proj-${'d'.repeat(20)}`;
    const findings = findSecrets([
      {
        path: 'b.txt',
        content: [
          `Token: ${TOKEN_TRONG_NHU_THAT}`,
          `Authorization: Bearer ${TOKEN_TRONG_NHU_THAT}`,
          khoaRiengGia,
          githubPatGia,
          githubGhpGia,
          skAntGia,
          skProjGia,
        ].join('\n'),
      },
    ]);

    expect(findings.map((item) => item.kind).sort()).toEqual([
      'bearer_token',
      'ghn_token',
      'github_ghp',
      'github_pat',
      'openai_sk',
      'openai_sk',
      'private_key',
    ]);
    expect(findings.every((item) => item.line >= 1 && item.line <= 7)).toBe(true);
  });

  it('file được theo dõi vẫn quét dù đường dẫn có dist/', () => {
    expect(
      findSecrets([{ path: 'pkg/dist/bi-mat.js', content: `GHN_TOKEN=${TOKEN_TRONG_NHU_THAT}` }]),
    ).toEqual([{ path: 'pkg/dist/bi-mat.js', line: 1, kind: 'ghn_token' }]);
  });

  it.each([
    { nhan: 'token giả TOKEN-GIA', content: 'GHN_TOKEN=TOKEN-GIA-123' },
    { nhan: 'token giả có SECRET', content: `GHN_TOKEN=${'TOKEN-GIA-SECRET-123456'}` },
    { nhan: 'giá trị mẫu .env.example', content: 'GHN_TOKEN=token-gia-khong-dung-that' },
    { nhan: 'dấu ...', content: 'GHN_TOKEN=...' },
    { nhan: 'xxx', content: "token = 'xxx'" },
    { nhan: 'chỗ điền <token>', content: 'Token: <token>' },
    { nhan: 'UUID mẫu uuidSchema', content: `token = '${UUID_MAU}'` },
    {
      nhan: 'UUID mẫu viết hoa (so không phân biệt hoa thường)',
      content: `token = '${UUID_MAU.toUpperCase()}'`,
    },
    { nhan: 'câu hướng dẫn your-token', content: 'GHN_TOKEN=your-token' },
  ])('không báo nhầm $nhan', ({ content }) => {
    expect(findSecrets([{ path: 'mau.txt', content }])).toEqual([]);
  });

  it('TOKEN-GIA neo chặt: đuôi dài bất thường vẫn bị báo', () => {
    const valueGia = `TOKEN-GIA-${'A'.repeat(41)}`;

    expect(findSecrets([{ path: 'nghi.txt', content: `GHN_TOKEN=${valueGia}` }])).toEqual([
      { path: 'nghi.txt', line: 1, kind: 'ghn_token' },
    ]);
  });

  it.each([
    { nhan: 'process.env.X', content: 'GHN_TOKEN=process.env.RATE_LIMIT_TEST_TOKEN' },
    { nhan: 'this.#config.getGhnToken()', content: 'token: this.#config.getGhnToken()' },
    { nhan: 'template `Token: ${TOKEN}`', content: 'Token: `${TOKEN}`' },
  ])('không báo giá trị là biểu thức code: $nhan', ({ content }) => {
    expect(findSecrets([{ path: 'bieu-thuc.ts', content }])).toEqual([]);
  });

  it('vẫn báo token literal dù dòng có chữ process.env (sau token)', () => {
    // Giá trị sau dấu = là token literal; "process.env" chỉ nằm trong chú thích cuối dòng.
    const content = `GHN_TOKEN=${TOKEN_TRONG_NHU_THAT} # process.env`;

    expect(findSecrets([{ path: 'chu-thich.env', content }])).toEqual([
      { path: 'chu-thich.env', line: 1, kind: 'ghn_token' },
    ]);
  });

  it('dòng rất dài 20000 ký tự vẫn được quét, token ở cuối dòng không bị bỏ lọt', () => {
    const content = `${'x'.repeat(20_000)} GHN_TOKEN=${TOKEN_TRONG_NHU_THAT}`;

    expect(findSecrets([{ path: 'dong-dai.txt', content }])).toEqual([
      { path: 'dong-dai.txt', line: 1, kind: 'ghn_token' },
    ]);
  });

  it('quét dòng 1 MB xong trong dưới 2000 ms (không treo)', () => {
    const content = `${'a'.repeat(1_000_000)} ${'token '.repeat(170_000)}`;
    const batDau = performance.now();

    const findings = findSecrets([{ path: 'dong-rat-dai.txt', content }]);

    const thoiGian = performance.now() - batDau;
    expect(findings).toEqual([]);
    expect(thoiGian).toBeLessThan(2000);
  });
});

describe('isProbablyBinary', () => {
  it('nhận file nhị phân có byte NUL, file văn bản thì không', () => {
    expect(isProbablyBinary(Buffer.from([0x61, 0x00, 0x62]))).toBe(true);
    expect(isProbablyBinary(Buffer.from('nội dung văn bản tiếng Việt'))).toBe(false);
  });
});

describe('quetThuMuc', () => {
  it('quét file văn bản, bỏ node_modules/dist và file nhị phân', () => {
    const dir = taoThuMucTam();
    writeFileSync(join(dir, 'co-token.txt'), `GHN_TOKEN=${TOKEN_TRONG_NHU_THAT}\n`);
    writeFileSync(join(dir, 'sach.txt'), 'GHN_TOKEN=TOKEN-GIA-123\n');
    writeFileSync(
      join(dir, 'nhi-phan.dat'),
      Buffer.from([0x00, ...Buffer.from(TOKEN_TRONG_NHU_THAT)]),
    );
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules', 'x.js'), `const t = '${TOKEN_TRONG_NHU_THAT}';\n`);
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist', 'y.js'), `const t = '${TOKEN_TRONG_NHU_THAT}';\n`);

    expect(quetThuMuc(dir)).toEqual([{ path: 'co-token.txt', line: 1, kind: 'ghn_token' }]);
  });

  it('tên file có khoảng trắng và Unicode vẫn được quét', () => {
    const dir = taoThuMucTam();
    const tenFile = 'tên file có dấu cách.txt';
    writeFileSync(join(dir, tenFile), `GHN_TOKEN=${TOKEN_TRONG_NHU_THAT}\n`);

    expect(quetThuMuc(dir)).toEqual([{ path: tenFile, line: 1, kind: 'ghn_token' }]);
  });
});

describe('findForbiddenTrackedNames', () => {
  it.each([
    { path: '.env', reason: 'file .env' },
    { path: 'src/.env.local', reason: 'file .env' },
    { path: 'certs/server.pem', reason: 'khóa riêng' },
    { path: 'certs/server.key', reason: 'khóa riêng' },
    { path: 'secrets/token.txt', reason: 'thư mục secrets/' },
  ])('báo $path', ({ path, reason }) => {
    expect(findForbiddenTrackedNames([path])).toEqual([{ path, reason }]);
  });

  it.each(['.env.example', 'src/.env.example', '.env.mau', 'src/.env.test.mau', 'tai-lieu/a.txt'])(
    'không báo %s',
    (path) => {
      expect(findForbiddenTrackedNames([path])).toEqual([]);
    },
  );
});

describe('file đã theo dõi nhưng đã xóa khỏi đĩa', () => {
  itGit('collectTrackedFiles bỏ qua ENOENT, collectTrackedNames vẫn báo .pem nhị phân', () => {
    const dir = taoThuMucTam('.tmp-git-');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    writeFileSync(join(dir, 'con-tren-dia.txt'), 'noi dung\n');
    writeFileSync(join(dir, 'da-xoa.txt'), 'noi dung\n');
    writeFileSync(join(dir, 'cert.pem'), Buffer.from([0x00, 0x01, 0x02]));
    const tenUnicode = 'tên file có dấu cách.txt';
    writeFileSync(join(dir, tenUnicode), 'noi dung\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    rmSync(join(dir, 'da-xoa.txt'));

    const names = collectTrackedNames(dir);
    expect(names.sort()).toEqual(['cert.pem', 'con-tren-dia.txt', 'da-xoa.txt', tenUnicode].sort());
    expect(findForbiddenTrackedNames(names)).toEqual([{ path: 'cert.pem', reason: 'khóa riêng' }]);

    // Không ném ENOENT; .pem nhị phân và file đã xóa đều bị bỏ khỏi danh sách đọc nội dung.
    const files = collectTrackedFiles(dir);
    expect(files.map((file) => file.path).sort()).toEqual(['con-tren-dia.txt', tenUnicode].sort());
  });
});

// Tìm gốc repo bằng git; máy không có git/repo thì skip kèm lý do.
let gocRepo: string | undefined;
try {
  gocRepo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
} catch {
  gocRepo = undefined;
}

if (gocRepo === undefined) {
  it.skip('bỏ qua quét repo thật: máy không có git hoặc không phải git repo', () => {});
} else {
  const root = gocRepo;
  describe('repo thật: file đã theo dõi', () => {
    it('không có bí mật trong file đã theo dõi', () => {
      const files = collectTrackedFiles(root);

      expect(files.length).toBeGreaterThan(0);
      expect(findSecrets(files)).toEqual([]);
    });

    it('không theo dõi file cấm (.env, *.pem, *.key, secrets/) — kiểm trên TOÀN BỘ tên', () => {
      // Dùng collectTrackedNames, KHÔNG lọc nhị phân/kích thước: .pem nhị phân vẫn phải bị báo.
      const names = collectTrackedNames(root);

      expect(names.length).toBeGreaterThan(0);
      expect(findForbiddenTrackedNames(names)).toEqual([]);
    });
  });
}
