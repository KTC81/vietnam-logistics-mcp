/**
 * Vitest globalSetup: build `dist/` MỘT lần cho cả lượt chạy test.
 *
 * Trước đây mỗi file stdio tự build trong `beforeAll`, hai file chạy song song có thể cùng ghi
 * `dist/`. Chuyển về đây để build một lần; vẫn hoạt động khi chạy riêng một file test.
 * Gọi thẳng tsc bằng node (không qua npm/shell) để chạy được cả trên Windows.
 *
 * LƯU Ý: lỗi tsc ở BẤT KỲ file nào sẽ chặn toàn bộ lượt test — Vitest có thể in
 * "No test files found" TRƯỚC thông báo lỗi build thật; tsc vẫn sinh một phần `dist/` dù lỗi.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const tscEntry = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));

export default function setup(): void {
  try {
    execFileSync(process.execPath, [tscEntry, '-p', 'tsconfig.json'], {
      cwd: packageRoot,
      stdio: 'pipe',
    });
  } catch (error) {
    const loi = error as { message?: string; stdout?: Buffer | string; stderr?: Buffer | string };
    throw new Error(
      [
        `Build bằng tsc thất bại: ${loi.message ?? 'không rõ lỗi'}`,
        `stdout:\n${String(loi.stdout ?? '')}`,
        `stderr:\n${String(loi.stderr ?? '')}`,
      ].join('\n'),
    );
  }
}
