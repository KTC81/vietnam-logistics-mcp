import { describe, expect, it } from 'vitest';
import { installMockFetch } from './mock-fetch.js';

describe('mock-fetch: phản hồi tuần tự', () => {
  it('mỗi lần gọi lấy phần tử kế tiếp; hết danh sách thì ném lỗi rõ ràng', async () => {
    const mock = installMockFetch([
      {
        url: 'https://mock.local/seq',
        method: 'GET',
        responses: [
          { status: 500, body: 'lỗi một' },
          { status: 200, body: { ok: true } },
        ],
      },
    ]);

    const first = await fetch('https://mock.local/seq');
    const second = await fetch('https://mock.local/seq');

    expect(first.status).toBe(500);
    await expect(first.text()).resolves.toBe('lỗi một');
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual({ ok: true });
    expect(mock.countCalls('https://mock.local/seq')).toBe(2);

    await expect(fetch('https://mock.local/seq')).rejects.toThrow(/hết danh sách responses/);
  });
});

describe('mock-fetch: khớp query', () => {
  it('khớp không phụ thuộc thứ tự tham số', async () => {
    installMockFetch([
      {
        url: 'https://mock.local/detail',
        method: 'GET',
        query: { order_code: 'G8A123456', offset: 0, last: true },
        body: { ok: true },
      },
    ]);

    const response = await fetch(
      'https://mock.local/detail?last=true&offset=0&order_code=G8A123456',
    );

    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it('thiếu cặp khai báo trong query thì không khớp', async () => {
    installMockFetch([
      { url: 'https://mock.local/detail', query: { order_code: 'X' }, body: { ok: true } },
    ]);

    await expect(fetch('https://mock.local/detail?order_code=Y')).rejects.toThrow(
      /chưa khai báo phản hồi/,
    );
  });
});

describe('mock-fetch: lỗi mạng và treo', () => {
  it('networkError: fetch ném đúng lỗi đã khai báo', async () => {
    const networkError = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ENOTFOUND' },
    });
    const mock = installMockFetch([{ url: 'https://mock.local/net', networkError }]);

    await expect(fetch('https://mock.local/net')).rejects.toBe(networkError);
    expect(mock.countCalls('https://mock.local/net')).toBe(1);
  });

  it('hang: kết thúc khi AbortSignal.timeout hủy lời gọi', async () => {
    installMockFetch([{ url: 'https://mock.local/hang', hang: true }]);

    await expect(
      fetch('https://mock.local/hang', { signal: AbortSignal.timeout(20) }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('hang: reject với đúng signal.reason khi hủy thủ công', async () => {
    installMockFetch([{ url: 'https://mock.local/hang2', hang: true }]);
    const controller = new AbortController();
    const lyDo = new Error('hủy vì lý do giả');

    const promise = fetch('https://mock.local/hang2', { signal: controller.signal });
    controller.abort(lyDo);

    await expect(promise).rejects.toBe(lyDo);
  });
});

describe('mock-fetch: đọc thân', () => {
  it('hangBody: đọc thân treo tới khi abort', async () => {
    installMockFetch([{ url: 'https://mock.local/hang-body', hangBody: true }]);

    const response = await fetch('https://mock.local/hang-body', {
      signal: AbortSignal.timeout(20),
    });

    await expect(response.text()).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('bodyError: đọc thân lỗi ngay với lỗi đã khai báo', async () => {
    const loi = new Error('lỗi đọc thân giả');
    installMockFetch([{ url: 'https://mock.local/body-error', bodyError: loi }]);

    const response = await fetch('https://mock.local/body-error');

    await expect(response.text()).rejects.toBe(loi);
  });

  it('ghi lại redirect của lời gọi', async () => {
    const mock = installMockFetch([{ url: 'https://mock.local/redirect', body: { ok: true } }]);

    await fetch('https://mock.local/redirect', { redirect: 'error' });

    expect(mock.calls[0].redirect).toBe('error');
  });
});
