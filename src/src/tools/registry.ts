/**
 * Nơi đăng ký tool.
 *
 * Registry chỉ giữ danh sách tool: KHÔNG biết transport, SDK, license hay biến môi trường.
 * Việc kiểm tier/chạy handler nằm ở `server.ts`.
 */
import type { StoredToolDefinition, ToolRegistry } from '../core/types.js';

// Tên tool: chữ thường, số, gạch dưới; bắt đầu bằng chữ.
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

function assertValidName(tool: StoredToolDefinition): void {
  if (!TOOL_NAME_PATTERN.test(tool.name)) {
    // Lỗi lập trình lúc khởi động (không phải AppError): tên tool do nhà phát triển đặt.
    throw new Error(`ToolRegistry: invalid tool name "${tool.name}"`);
  }
}

/** Tạo registry rỗng. */
export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, StoredToolDefinition>();

  return {
    register(tool: StoredToolDefinition): void {
      assertValidName(tool);
      if (tools.has(tool.name)) {
        throw new Error(`ToolRegistry: duplicate tool name "${tool.name}"`);
      }
      tools.set(tool.name, tool);
    },

    registerTools(batch: readonly StoredToolDefinition[]): void {
      // Kiểm tra TOÀN BỘ trước khi thêm: nếu một tool lỗi thì không tool nào trong lô được
      // đăng ký (hoàn tác cả lô), tránh trạng thái nửa vời sau lỗi lúc khởi động.
      const names = new Set<string>();
      for (const tool of batch) {
        assertValidName(tool);
        if (tools.has(tool.name) || names.has(tool.name)) {
          throw new Error(`ToolRegistry: duplicate tool name "${tool.name}"`);
        }
        names.add(tool.name);
      }
      for (const tool of batch) {
        tools.set(tool.name, tool);
      }
    },

    list(): readonly StoredToolDefinition[] {
      // Trả mảng mới: người gọi sửa mảng không ảnh hưởng registry.
      return [...tools.values()];
    },

    get(name: string): StoredToolDefinition | undefined {
      return tools.get(name);
    },
  };
}
