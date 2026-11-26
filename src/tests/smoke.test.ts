import { describe, expect, it } from 'vitest';
import { installMockFetch } from './helpers/mock-fetch.js';

// Giữ bản fetch gốc để kiểm tra việc tự khôi phục sau mỗi test.
const fetchGoc = globalThis.fetch;

describe('mock-fetch', () => {
  it('trả đúng phản hồi đã khai báo và đếm số lần gọi', async () => {
    const mock = installMockFetch([
      {
        url: 'https://mock.local/orders/1',
        method: 'GET',
        status: 200,
        body: { code: 'G8A123456' },
      },
    ]);

    const response = await fetch('https://mock.local/orders/1');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ code: 'G8A123456' });
    expect(mock.countCalls('https://mock.local/orders/1')).toBe(1);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.method).toBe('GET');
  });

  it('phân biệt phản hồi theo phương thức và đếm đúng từng URL', async () => {
    const mock = installMockFetch([
      { url: 'https://mock.local/orders', method: 'POST', status: 201, body: { ok: true } },
      { url: 'https://mock.local/orders', method: 'GET', status: 200, body: { items: [] } },
    ]);

    const created = await fetch('https://mock.local/orders', {
      method: 'POST',
      body: JSON.stringify({ a: 1 }),
    });
    const listed = await fetch('https://mock.local/orders');

    expect(created.status).toBe(201);
    expect(listed.status).toBe(200);
    expect(mock.countCalls('https://mock.local/orders', 'POST')).toBe(1);
    expect(mock.countCalls('https://mock.local/orders', 'GET')).toBe(1);
    expect(mock.calls[0]?.body).toEqual({ a: 1 });
  });

  it('báo lỗi rõ ràng khi gọi URL chưa khai báo', async () => {
    installMockFetch([]);

    await expect(fetch('https://mock.local/khong-ton-tai')).rejects.toThrow(
      'Mock fetch: chưa khai báo phản hồi cho GET https://mock.local/khong-ton-tai',
    );
  });

  it('tự khôi phục fetch gốc sau mỗi test', () => {
    // Test này chạy sau các test trên: nếu fetch chưa được khôi phục thì sẽ khác bản gốc.
    expect(globalThis.fetch).toBe(fetchGoc);
  });
});
