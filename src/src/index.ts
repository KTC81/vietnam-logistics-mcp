#!/usr/bin/env node
/**
 * Điểm vào của gói (bin: dist/index.js). Chỉ gọi `main()`; logic dựng nằm ở `main.ts`
 * để test gọi được mà không tự khởi động tiến trình.
 *
 * stdout dành riêng cho giao thức MCP của SDK — file này không ghi stdout.
 */
import { main } from './main.js';

void main().catch(() => {
  // Không in stack/token: chỉ một dòng thân thiện ra stderr.
  process.stderr.write('Không khởi động được Vietnam Logistics MCP. Vui lòng thử lại.\n');
  process.exitCode = 1;
});
