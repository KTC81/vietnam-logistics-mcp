import { afterEach } from 'vitest';

/** Một phản hồi giả của GHN (dùng cho route đơn hoặc danh sách tuần tự). */
export interface MockFetchResponse {
  /** Mã trạng thái HTTP, mặc định là 200. */
  status?: number;
  /** Dữ liệu trả về: object/array sẽ được JSON.stringify, string trả nguyên văn. */
  body?: unknown;
  /** Header bổ sung của phản hồi. */
  headers?: Record<string, string>;
  /**
   * Nếu true, thân phản hồi treo cho tới khi `init.signal` bị abort rồi lỗi với `signal.reason`.
   * Không có signal thì thân treo vĩnh viễn — test phải tự đặt signal.
   */
  hangBody?: boolean;
  /** Nếu có, đọc thân phản hồi sẽ lỗi ngay với lỗi này (mô phỏng lỗi đọc thân). */
  bodyError?: Error;
}

/** Một route giả khai báo cho một URL + phương thức (hoặc theo query). */
export interface MockFetchRoute extends MockFetchResponse {
  /**
   * URL khớp chính xác với lời gọi. Bỏ trống khi chỉ khớp theo `query`, hoặc khi route
   * chỉ dùng `networkError`/`hang`.
   */
  url?: string;
  /**
   * Khớp query KHÔNG phụ thuộc thứ tự tham số: mọi cặp khai báo phải có trong query của URL.
   * Khi dùng `query`, nên đặt `url` là URL gốc không kèm query.
   */
  query?: Record<string, string | number | boolean>;
  /** Phương thức HTTP, mặc định là GET. */
  method?: string;
  /**
   * Danh sách phản hồi tuần tự: mỗi lần khớp route lấy phần tử kế tiếp.
   * Hết danh sách thì fetch giả ném lỗi rõ ràng (không lặp lại phần tử cuối).
   */
  responses?: MockFetchResponse[];
  /** Nếu có, fetch giả ném đúng lỗi này thay vì trả Response (mô phỏng lỗi mạng). */
  networkError?: Error;
  /**
   * Nếu true, fetch giả treo cho tới khi `init.signal` bị abort rồi reject với `signal.reason`.
   * Không có signal thì treo vĩnh viễn — test phải tự đặt signal (ví dụ `AbortSignal.timeout`).
   */
  hang?: boolean;
}

/** Một lời gọi đã đi qua fetch giả, dùng để kiểm tra trong test. */
export interface MockCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
  /** Signal của lời gọi (nếu có), hữu ích khi test timeout/hủy. */
  signal?: AbortSignal;
  /** Chế độ chuyển hướng đã truyền (ví dụ `'error'`). */
  redirect?: RequestRedirect;
}

/** Tay cầm của một lần lắp fetch giả. */
export interface MockFetchHandle {
  /** Toàn bộ lời gọi theo thứ tự. */
  readonly calls: MockCall[];
  /** Đếm số lần gọi, có thể lọc theo URL và phương thức. */
  countCalls(url?: string, method?: string): number;
  /** Khôi phục fetch gốc ngay lập tức (bình thường không cần gọi: tự khôi phục sau mỗi test). */
  restore(): void;
}

// Danh sách hàm khôi phục của các mock đang bật; chạy hết sau mỗi test.
const restorers: Array<() => void> = [];

afterEach(() => {
  for (const restore of restorers.splice(0)) {
    restore();
  }
});

function normalizeMethod(method?: string): string {
  return (method ?? 'GET').toUpperCase();
}

// Đọc body của lời gọi: cố phân tích JSON, không được thì giữ nguyên chuỗi.
function readBody(body: RequestInit['body']): unknown {
  if (typeof body !== 'string') {
    return undefined;
  }
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

// Tách URL gốc và query; URL tương đối (hiếm) thì coi như không có query.
function parseCallUrl(url: string): { base: string; params: URLSearchParams } {
  try {
    const parsed = new URL(url);
    return { base: `${parsed.origin}${parsed.pathname}`, params: parsed.searchParams };
  } catch {
    return { base: url, params: new URLSearchParams() };
  }
}

// Route khớp khi đúng phương thức và đúng URL (chính xác hoặc theo query không phụ thuộc thứ tự).
function matchesRoute(route: MockFetchRoute, callUrl: string, method: string): boolean {
  if (normalizeMethod(route.method) !== method) {
    return false;
  }

  const { base, params } = parseCallUrl(callUrl);
  if (route.query !== undefined) {
    if (route.url !== undefined && route.url !== callUrl && route.url !== base) {
      return false;
    }
    return Object.entries(route.query).every(([key, value]) => params.get(key) === String(value));
  }

  // Không có `url` lẫn `query`: khớp mọi URL cùng phương thức (dùng cho networkError/hang).
  if (route.url === undefined) {
    return true;
  }
  return route.url === callUrl;
}

// Lấy phản hồi kế tiếp của route; hết danh sách `responses` thì báo lỗi rõ ràng.
function resolveResponse(
  route: MockFetchRoute,
  index: number,
  callUrl: string,
  method: string,
): MockFetchResponse {
  if (route.responses === undefined) {
    // Trả chính route để giữ cả hangBody/bodyError (route kế thừa MockFetchResponse).
    return route;
  }
  const next = route.responses[index];
  if (next === undefined) {
    throw new Error(
      `Mock fetch: hết danh sách responses cho ${method} ${callUrl} (lần gọi thứ ${index + 1})`,
    );
  }
  return next;
}

// Dựng Response thật từ khai báo giả; thân có thể treo hoặc lỗi ngay (để test đọc thân).
function buildResponse(response: MockFetchResponse, signal: AbortSignal | undefined): Response {
  const responseHeaders = new Headers(response.headers);

  if (response.hangBody === true) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (signal === undefined) {
          return; // Không có signal: thân treo vĩnh viễn; test phải tự tránh.
        }
        const fail = (): void => controller.error(signal.reason);
        if (signal.aborted) {
          fail();
        } else {
          signal.addEventListener('abort', fail, { once: true });
        }
      },
    });
    return new Response(stream, { status: response.status ?? 200, headers: responseHeaders });
  }

  if (response.bodyError !== undefined) {
    const loi = response.bodyError;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(loi);
      },
    });
    return new Response(stream, { status: response.status ?? 200, headers: responseHeaders });
  }

  let payload: string | null = null;
  if (typeof response.body === 'string') {
    payload = response.body;
  } else if (response.body !== undefined) {
    payload = JSON.stringify(response.body);
    if (!responseHeaders.has('content-type')) {
      responseHeaders.set('content-type', 'application/json');
    }
  }
  return new Response(payload, { status: response.status ?? 200, headers: responseHeaders });
}

/**
 * Thay globalThis.fetch bằng bản giả trong phạm vi một test.
 * Mọi lời gọi không khai báo trong routes sẽ ném lỗi để test hỏng rõ ràng (không gọi mạng thật).
 * Hỗ trợ: phản hồi tuần tự (`responses`), khớp query không phụ thuộc thứ tự (`query`),
 * lỗi mạng giả (`networkError`), treo đến khi bị hủy (`hang`).
 */
export function installMockFetch(routes: MockFetchRoute[]): MockFetchHandle {
  const originalFetch = globalThis.fetch;
  const calls: MockCall[] = [];
  // Đếm số lần mỗi route đã khớp, phục vụ `responses` tuần tự.
  const routeCalls = new Map<MockFetchRoute, number>();

  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // Lấy URL và phương thức từ các dạng đầu vào mà fetch thật chấp nhận.
    let url: string;
    let method = init?.method;
    if (input instanceof Request) {
      url = input.url;
      method = method ?? input.method;
    } else {
      url = typeof input === 'string' ? input : input.toString();
    }
    const normalizedMethod = normalizeMethod(method);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);

    const headers: Record<string, string> = {};
    if (init?.headers !== undefined) {
      new Headers(init.headers).forEach((value, key) => {
        headers[key] = value;
      });
    }

    calls.push({
      url,
      method: normalizedMethod,
      body: readBody(init?.body),
      headers,
      signal,
      redirect: init?.redirect,
    });

    const route = routes.find((item) => matchesRoute(item, url, normalizedMethod));
    if (route === undefined) {
      throw new Error(`Mock fetch: chưa khai báo phản hồi cho ${normalizedMethod} ${url}`);
    }

    const index = routeCalls.get(route) ?? 0;
    routeCalls.set(route, index + 1);

    if (route.networkError !== undefined) {
      throw route.networkError;
    }

    if (route.hang === true) {
      return await new Promise<Response>((_resolve, reject) => {
        if (signal === undefined) {
          // Không có signal: treo vĩnh viễn; test phải tự tránh trường hợp này.
          return;
        }
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }

    return buildResponse(resolveResponse(route, index, url, normalizedMethod), signal);
  };

  globalThis.fetch = fakeFetch as typeof fetch;

  let restored = false;
  const restore = (): void => {
    if (restored) {
      return;
    }
    restored = true;
    // Chỉ khôi phục nếu fetch hiện tại vẫn là bản giả của mình (tránh đè mock của test khác).
    if (globalThis.fetch === (fakeFetch as typeof fetch)) {
      globalThis.fetch = originalFetch;
    }
  };
  restorers.push(restore);

  return {
    calls,
    countCalls(url?: string, method?: string): number {
      return calls.filter(
        (call) =>
          (url === undefined || call.url === url) &&
          (method === undefined || call.method === normalizeMethod(method)),
      ).length;
    },
    restore,
  };
}
