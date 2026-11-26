import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { TransportFactory } from '../src/core/types.js';
import { main, readServerInfo } from '../src/main.js';

describe('main', () => {
  it('thiếu GHN_TOKEN: thoát mã khác 0, một dòng tiếng Việt chỉ nêu tên biến, không stack', async () => {
    const lines: string[] = [];
    const exits: number[] = [];

    const handle = await main({
      env: {},
      writeStderr: (line) => lines.push(line),
      exit: (code) => exits.push(code),
      installProcessHandlers: false,
    });

    expect(handle).toBeUndefined();
    expect(exits).toEqual([1]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('GHN_TOKEN');
    const text = lines.join('');
    expect(text).not.toContain('\n    at ');
    expect(text).not.toContain('Error:');
    expect(text).not.toContain('TOKEN-GIA');
  });

  it('stderr bị đóng (EPIPE) không làm sập tiến trình', async () => {
    await main({
      env: {},
      writeStderr: () => {},
      exit: () => {},
      installProcessHandlers: false,
    });

    expect(() => process.stderr.emit('error', new Error('EPIPE'))).not.toThrow();
  });

  it('tín hiệu dừng gọi stop() đúng một lần rồi thoát mã 0', async () => {
    let stops = 0;
    const handlers: Partial<Record<'SIGINT' | 'SIGTERM', () => void>> = {};
    const exits: number[] = [];
    const transport: TransportFactory = {
      name: 'stdio',
      async start() {},
      async stop() {
        stops += 1;
      },
    };

    const handle = await main({
      env: { GHN_TOKEN: 'TOKEN-GIA-123' },
      writeStderr: () => {},
      exit: (code) => exits.push(code),
      transport,
      onSignal: (signal, handler) => {
        handlers[signal] = handler;
      },
      installProcessHandlers: false,
    });

    expect(handle).toBeDefined();
    handlers['SIGTERM']?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stops).toBe(1);
    expect(exits).toEqual([0]);

    await handle?.stop();
    expect(stops).toBe(1);
  });

  it('readServerInfo khớp name/version trong package.json', () => {
    const info = readServerInfo();
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const pkg = JSON.parse(raw) as { name: string; version: string };

    expect(info).toEqual({ name: pkg.name, version: pkg.version });
  });

  it('index.ts có shebang cho bin', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

    expect(source.startsWith('#!/usr/bin/env node\n')).toBe(true);
  });

  it('unhandledRejection/uncaughtException: chỉ log code/event, exit 1, không lộ nội dung gốc', async () => {
    const beforeRejection = new Set(process.listeners('unhandledRejection'));
    const beforeException = new Set(process.listeners('uncaughtException'));
    const stderrChunks: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((
      chunk: string | Uint8Array,
    ): boolean => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write);
    const exits: number[] = [];
    const transport: TransportFactory = {
      name: 'stdio',
      async start() {},
      async stop() {},
    };

    try {
      await main({
        env: { GHN_TOKEN: 'TOKEN-GIA-123' },
        writeStderr: () => {},
        exit: (code) => exits.push(code),
        transport,
        onSignal: () => {},
        installProcessHandlers: true,
      });

      const newRejection = process
        .listeners('unhandledRejection')
        .filter((listener) => !beforeRejection.has(listener));
      const newException = process
        .listeners('uncaughtException')
        .filter((listener) => !beforeException.has(listener));
      expect(newRejection.length).toBeGreaterThan(0);
      expect(newException.length).toBeGreaterThan(0);

      const loi = new Error('TOKEN-GIA-123 bi mat');
      for (const listener of newRejection) {
        (listener as (reason: unknown, promise: Promise<unknown>) => void)(loi, Promise.resolve());
      }
      // Mỗi sự kiện chỉ được gọi exit đúng 1 lần.
      expect(exits).toEqual([1]);

      for (const listener of newException) {
        (listener as (error: Error, origin: string) => void)(loi, 'uncaughtException');
      }
      expect(exits).toEqual([1, 1]);
    } finally {
      stderrSpy.mockRestore();
      // Gỡ listener main vừa thêm, kể cả khi test lỗi giữa chừng.
      for (const listener of process.listeners('unhandledRejection')) {
        if (!beforeRejection.has(listener)) {
          process.removeListener('unhandledRejection', listener);
        }
      }
      for (const listener of process.listeners('uncaughtException')) {
        if (!beforeException.has(listener)) {
          process.removeListener('uncaughtException', listener);
        }
      }
    }

    expect(exits).toEqual([1, 1]);
    const text = stderrChunks.join('');
    expect(text).not.toContain('TOKEN-GIA-123');
    expect(text).not.toContain('bi mat');
    expect(text).toContain('INTERNAL_ERROR');
    expect(text).toContain('unhandled_rejection');
    expect(text).toContain('uncaught_exception');
  });
});
