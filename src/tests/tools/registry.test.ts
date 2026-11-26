import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { StoredToolDefinition } from '../../src/core/types.js';
import { createToolRegistry } from '../../src/tools/registry.js';

function taoTool(name: string): StoredToolDefinition {
  return {
    name,
    description: `Mô tả ${name}`,
    inputSchema: z.object({}),
    tier: 'free',
    handler: async () => ({ ok: true }),
  };
}

describe('createToolRegistry', () => {
  it('đăng ký và lấy ra được tool', () => {
    const registry = createToolRegistry();
    const tool = taoTool('ghn_get_fee');

    registry.register(tool);

    expect(registry.get('ghn_get_fee')).toBe(tool);
    expect(registry.list()).toEqual([tool]);
  });

  it('tên trùng ném lỗi lập trình', () => {
    const registry = createToolRegistry();
    registry.register(taoTool('ghn_get_fee'));

    expect(() => registry.register(taoTool('ghn_get_fee'))).toThrow(/duplicate tool name/);
  });

  it.each(['Ghn_Tool', '1abc', 'has-dash', '', 'a'.repeat(65)])(
    'tên sai định dạng %j ném lỗi lập trình',
    (name) => {
      const registry = createToolRegistry();

      expect(() => registry.register(taoTool(name))).toThrow(/invalid tool name/);
    },
  );

  it('registerTools giữ thứ tự đăng ký', () => {
    const registry = createToolRegistry();
    const a = taoTool('tool_a');
    const b = taoTool('tool_b');

    registry.registerTools([a, b]);

    expect(registry.list()).toEqual([a, b]);
  });

  it('registerTools hoàn tác CẢ LÔ khi một tool lỗi', () => {
    const registry = createToolRegistry();

    expect(() =>
      registry.registerTools([taoTool('tool_a'), taoTool('Bad-Name'), taoTool('tool_c')]),
    ).toThrow(/invalid tool name/);
    expect(registry.get('tool_a')).toBeUndefined();
    expect(registry.get('tool_c')).toBeUndefined();
    expect(registry.list()).toEqual([]);
  });

  it('registerTools hoàn tác khi trùng tên trong cùng lô', () => {
    const registry = createToolRegistry();

    expect(() => registry.registerTools([taoTool('tool_a'), taoTool('tool_a')])).toThrow(
      /duplicate tool name/,
    );
    expect(registry.list()).toEqual([]);
  });

  it('list() trả bản sao mảng, sửa nó không ảnh hưởng registry', () => {
    const registry = createToolRegistry();
    registry.register(taoTool('tool_a'));

    const list = registry.list() as StoredToolDefinition[];
    list.push(taoTool('tool_b'));

    expect(registry.list()).toHaveLength(1);
    expect(registry.get('tool_b')).toBeUndefined();
  });

  it('get tên lạ trả undefined', () => {
    expect(createToolRegistry().get('khong_ton_tai')).toBeUndefined();
  });
});
