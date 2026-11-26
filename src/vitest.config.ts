import { defineConfig } from 'vitest/config';

// Cấu hình Vitest: chạy trong môi trường Node, chỉ gom các file test trong tests/.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Build dist/ một lần cho các test stdio (trước đây mỗi file tự build trong beforeAll).
    globalSetup: ['./tests/global-setup.ts'],
  },
});
