import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors.js';
import { parseInput } from '../../src/utils/validator.js';
import { TOOL_FIXTURES, type ToolFixture } from '../helpers/security-fixtures.js';
import {
  docKetQua,
  goiTool,
  taoGhnDem,
  taoHarness,
  taoRegistry,
} from '../helpers/security-harness.js';
import { installMockFetch } from '../helpers/mock-fetch.js';

function layFixture(tenTool: string): ToolFixture {
  const fixture = TOOL_FIXTURES[tenTool];
  if (fixture === undefined) {
    throw new Error(`Thiếu fixture bảo mật cho tool ${tenTool}`);
  }
  return fixture;
}

function batAppError(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) {
      return error;
    }
    throw error;
  }
  throw new Error('Mong đợi AppError nhưng không có lỗi nào được ném ra');
}

function laRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Duyệt JSON Schema (kể cả anyOf/oneOf/allOf, type dạng mảng), ghi lại các trường kiểu string
// KHÔNG có biên: không pattern/maxLength/enum/const và không có nhánh con nào.
function kiemChuoiCoBien(node: unknown, duongDan: string, loi: string[]): void {
  if (!laRecord(node)) {
    return;
  }
  const kieu = new Set<string>();
  const type = node['type'];
  if (typeof type === 'string') {
    kieu.add(type);
  } else if (Array.isArray(type)) {
    for (const item of type) {
      if (typeof item === 'string') {
        kieu.add(item);
      }
    }
  }

  const nhanh: unknown[] = [];
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const value = node[key];
    if (Array.isArray(value)) {
      nhanh.push(...value);
    }
  }

  const coBien =
    typeof node['pattern'] === 'string' ||
    typeof node['maxLength'] === 'number' ||
    Array.isArray(node['enum']) ||
    Object.hasOwn(node, 'const');
  if (kieu.has('string') && !coBien && nhanh.length === 0) {
    loi.push(duongDan);
  }

  const properties = node['properties'];
  if (laRecord(properties)) {
    for (const [key, value] of Object.entries(properties)) {
      kiemChuoiCoBien(value, `${duongDan}.${key}`, loi);
    }
  }
  if (node['items'] !== undefined) {
    kiemChuoiCoBien(node['items'], `${duongDan}[]`, loi);
  }
  for (const branch of nhanh) {
    kiemChuoiCoBien(branch, duongDan, loi);
  }
}

describe('kiemChuoiCoBien (đơn vị)', () => {
  function kiem(schema: unknown): string[] {
    const loi: string[] = [];
    kiemChuoiCoBien(schema, 'x', loi);
    return loi;
  }

  it.each([
    { nhan: 'string không biên', schema: { type: 'string' }, loi: ['x'] },
    { nhan: 'có pattern', schema: { type: 'string', pattern: '^a$' }, loi: [] },
    { nhan: 'có maxLength', schema: { type: 'string', maxLength: 5 }, loi: [] },
    { nhan: 'nullable không biên', schema: { type: ['string', 'null'] }, loi: ['x'] },
    {
      nhan: 'nullable có maxLength',
      schema: { type: ['string', 'null'], maxLength: 5 },
      loi: [],
    },
    { nhan: 'enum', schema: { type: 'string', enum: ['a', 'b'] }, loi: [] },
    { nhan: 'const', schema: { type: 'string', const: 'a' }, loi: [] },
    {
      nhan: 'anyOf đều có biên',
      schema: { anyOf: [{ type: 'string', pattern: '^a$' }, { type: 'null' }] },
      loi: [],
    },
    {
      nhan: 'anyOf có nhánh string không biên',
      schema: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      loi: ['x'],
    },
    {
      nhan: 'object lồng nhau',
      schema: { type: 'object', properties: { y: { type: 'string' } } },
      loi: ['x.y'],
    },
  ])('$nhan', ({ schema, loi }) => {
    expect(kiem(schema)).toEqual(loi);
  });
});

describe('bộ test bảo mật: fixture cho mọi tool', () => {
  it('registry có ít nhất 3 tool và mọi tool đều có mục trong bảng fixture', () => {
    const names = taoRegistry()
      .list()
      .map((tool) => tool.name);

    expect(names.length).toBeGreaterThanOrEqual(3);
    expect(names.length).toBe(Object.keys(TOOL_FIXTURES).length);
    for (const name of names) {
      expect(TOOL_FIXTURES[name], `Thiếu fixture cho tool mới: ${name}`).toBeDefined();
    }
  });
});

for (const tool of taoRegistry().list()) {
  describe(`tool ${tool.name}: Zod chặt và JSON Schema`, () => {
    const fixture = layFixture(tool.name);

    it('khóa lạ trong đầu vào bị từ chối, KHÔNG gọi GHN', async () => {
      const dem = taoGhnDem();
      const harness = await taoHarness({ ghn: dem.ghn });
      try {
        const { payload, isError } = await goiTool(harness.client, tool.name, {
          ...fixture.validArguments,
          khoa_la_ngau_nhien: 'gia-tri-la',
        });

        expect(isError).toBe(true);
        expect(payload['error']).toMatchObject({ code: 'VALIDATION_ERROR' });
        expect(dem.soLanGoi()).toBe(0);
      } finally {
        await harness.close();
      }
    });

    it('tools/list có additionalProperties false và type object', async () => {
      const harness = await taoHarness();
      try {
        const listed = await harness.client.listTools();
        const found = listed.tools.find((item) => item.name === tool.name);
        const schema = found?.inputSchema as {
          type?: string;
          additionalProperties?: boolean;
        };

        expect(schema.type).toBe('object');
        expect(schema.additionalProperties).toBe(false);
      } finally {
        await harness.close();
      }
    });

    it.each([
      { nhan: 'null', giaTri: null },
      { nhan: 'mảng', giaTri: [] },
      { nhan: 'chuỗi', giaTri: 'sai' },
      { nhan: 'số', giaTri: 42 },
    ])('parseInput từ chối đầu vào $nhan', ({ giaTri }) => {
      const error = batAppError(() => parseInput(tool.inputSchema, giaTri));

      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.issues?.[0]?.message).toBeTruthy();
    });

    it('thiếu arguments: không crash; schema quyết định hợp lệ hay VALIDATION_ERROR', async () => {
      // Tool không có trường bắt buộc (ghn_get_shops) hợp lệ với {} — cần phản hồi GHN mẫu.
      installMockFetch([{ method: fixture.method, body: fixture.successBody }]);
      const harness = await taoHarness();
      try {
        const schemaChapNhanRong = tool.inputSchema.safeParse({}).success;
        const { payload, isError } = docKetQua(await harness.client.callTool({ name: tool.name }));

        if (schemaChapNhanRong) {
          expect(isError).toBe(false);
          expect(payload['ok']).toBe(true);
        } else {
          expect(isError).toBe(true);
          expect(payload['error']).toMatchObject({ code: 'VALIDATION_ERROR' });
        }
      } finally {
        await harness.close();
      }
    });

    it('mọi trường chuỗi trong JSON Schema đều có biên (pattern hoặc maxLength)', async () => {
      const harness = await taoHarness();
      try {
        const listed = await harness.client.listTools();
        const found = listed.tools.find((item) => item.name === tool.name);
        const loi: string[] = [];

        kiemChuoiCoBien(found?.inputSchema, tool.name, loi);

        expect(loi).toEqual([]);
      } finally {
        await harness.close();
      }
    });
  });
}
