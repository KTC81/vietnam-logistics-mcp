# Vietnam Logistics MCP

**Tiếng Việt** | [English](#english)

MCP Server cho trợ lý AI (Claude Desktop và các ứng dụng hỗ trợ MCP): hỏi đơn hàng và phí vận chuyển **Giao Hàng Nhanh (GHN)** bằng tiếng Việt, ngay trong cuộc trò chuyện với AI. Chạy ngay trên máy của bạn, token GHN không đi qua máy chủ nào của chúng tôi.

> **Trạng thái:** phiên bản **v1.1** (bản đầu tiên). Phiên bản này chỉ có **3 tool đọc dữ liệu** (xem đơn, xem shop, tính phí). Chưa có tạo đơn, hủy đơn, tra nhiều đơn và tra mã quận/phường theo tên (xem [Lộ trình](#lộ-trình)).

## Làm được gì

Bạn hỏi bằng tiếng Việt, AI tự chọn tool và trả lời:

- *"Đơn G8A123456 đang ở đâu? Có thu hộ bao nhiêu?"* → trạng thái đơn, tiền thu hộ (COD), dự kiến giao.
- *"Liệt kê các shop GHN của tôi, cho tôi ShopId."* → danh sách shop kèm ShopId.
- *"Phí ship hàng 800 gram từ quận mã 1442 tới phường mã 20110 (quận mã 1442)?"* → phí dự kiến (VND).

| Tool | Việc làm | Cần cấu hình |
|------|----------|--------------|
| `ghn_get_order_detail` | Tra chi tiết một đơn theo mã vận đơn | `GHN_TOKEN` |
| `ghn_get_shops` | Liệt kê shop/kho của tài khoản, kèm ShopId | `GHN_TOKEN` |
| `ghn_get_fee` | Tính phí vận chuyển dự kiến | `GHN_TOKEN` và `GHN_SHOP_ID` |

**Dữ liệu cá nhân:** các tool đọc **không trả tên, số điện thoại, địa chỉ** của người nhận, người gửi hay shop cho AI. Chỉ trả trạng thái, số tiền, thời gian, mã shop, tên shop và mã quận/phường.

## Cài đặt

### Bạn cần có

1. **Node.js 18 trở lên** ([nodejs.org](https://nodejs.org)). Kiểm tra: mở Terminal (macOS) hoặc Command Prompt (Windows), gõ `node --version`.
2. **Token GHN:** đăng nhập [khachhang.ghn.vn](https://khachhang.ghn.vn), vào **Quản lý Token**, lấy token bằng mã OTP gửi về SMS. Token giống mật khẩu: đừng gửi cho người khác, đừng dán vào mã nguồn hay chat.
3. **Ứng dụng AI hỗ trợ MCP**, ví dụ [Claude Desktop](https://claude.ai/download).

### Cấu hình Claude Desktop

Mở file cấu hình `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

(Trong Claude Desktop: **Settings → Developer → Edit Config**.) Thêm mục `ghn` vào `mcpServers`:

```json
{
  "mcpServers": {
    "ghn": {
      "command": "npx",
      "args": ["-y", "vietnam-logistics-mcp"],
      "env": {
        "GHN_TOKEN": "<token-ghn-cua-ban>",
        "GHN_SHOP_ID": "<shopid-cua-ban>",
        "GHN_ENV": "production"
      }
    }
  }
}
```

Thay `<token-ghn-cua-ban>` bằng token của bạn. **Thoát hẳn Claude Desktop rồi mở lại.** Nếu thấy biểu tượng tool trong ô chat là đã nối được.

> Nếu không muốn dùng `npx`, bạn có thể [chạy từ mã nguồn](#chạy-từ-mã-nguồn) ở dưới.

### Lấy ShopId (làm một lần)

Bạn chưa biết ShopId? Cấu hình trước **chỉ với `GHN_TOKEN`** (bỏ dòng `GHN_SHOP_ID`), mở lại Claude Desktop rồi hỏi: *"Liệt kê các shop GHN của tôi."* Chép ShopId của shop cần dùng vào `GHN_SHOP_ID`, lưu file, mở lại Claude Desktop. Tool `ghn_get_fee` cần ShopId này.

### Các biến cấu hình

| Biến | Bắt buộc | Giá trị |
|------|----------|---------|
| `GHN_TOKEN` | Có | Token GHN của bạn |
| `GHN_SHOP_ID` | Với `ghn_get_fee` | Số nguyên dương, ShopId của shop |
| `GHN_ENV` | Không | `production` (mặc định) hoặc `staging` (môi trường thử của GHN, cần token staging) |
| `LOG_LEVEL` | Không | `info` (mặc định), `warn`, `error` |

### Chạy từ mã nguồn

```bash
git clone https://github.com/ktc81/vietnam-logistics-mcp.git
cd vietnam-logistics-mcp/src
npm install
npm run build
```

Trong `claude_desktop_config.json`, thay `command` và `args` bằng (sửa đường dẫn cho đúng máy của bạn; trên Windows dùng dấu `\\` hoặc `/`):

```json
"command": "node",
"args": ["/duong/dan/toi/vietnam-logistics-mcp/src/dist/index.js"]
```

## Ví dụ hỏi đáp

**Tra đơn.** *"Tra đơn G8A123456 giúp tôi."*
AI trả về trạng thái (ví dụ "Đang giao hàng"), tiền thu hộ, thời gian dự kiến giao và lần cập nhật gần nhất.

**Tính phí.** Tool cần **mã** quận và phường (không phải tên). Ví dụ: *"Tính phí ship hàng 800 gram từ quận mã 1442 tới quận mã 1442, phường mã 20110."* Dịch vụ mặc định là hàng nhẹ (`service_type_id` = 2); dịch vụ hàng nặng (5) yêu cầu cân nặng lớn hơn ngưỡng của GHN. Bạn có thể thêm kích thước (cm) và giá trị bảo hiểm (VND).

**Xem shop.** *"Tôi có những shop nào trên GHN?"*

## Lỗi thường gặp

| Thông báo / hiện tượng | Nguyên nhân và cách xử lý |
|-------------------------|---------------------------|
| "Thiếu cấu hình GHN_TOKEN" | Chưa điền `GHN_TOKEN` trong `env`. Điền rồi mở lại ứng dụng. |
| "Thiếu cấu hình GHN_SHOP_ID" | Tool tính phí cần ShopId. Làm theo [Lấy ShopId](#lấy-shopid-làm-một-lần). |
| "Token GHN hết hạn, lấy token mới…" | Token sai hoặc hết hạn. Lấy token mới tại khachhang.ghn.vn. |
| "Không tìm thấy đơn …" | Sai mã vận đơn, hoặc đơn thuộc tài khoản GHN khác. |
| "GHN từ chối yêu cầu vì dữ liệu chưa hợp lệ…" | Mã quận/phường, cân nặng hoặc dịch vụ không hợp lệ, hoặc tuyến không có dịch vụ. Kiểm tra lại số liệu (câu thông báo nhắc "đơn/địa chỉ" vì dùng chung cho mọi tool). |
| "GHN đang giới hạn tần suất…", "GHN đang gặp sự cố…", "GHN phản hồi quá chậm…" | GHN bận hoặc giới hạn truy cập. Thử lại sau ít phút. |
| "Dữ liệu GHN trả về không đúng định dạng… mã yêu cầu …" | GHN trả dữ liệu khác dự kiến. Báo lỗi kèm mã yêu cầu để chúng tôi kiểm tra. |
| "Dữ liệu nhập chưa đúng…" | Câu hỏi thiếu hoặc sai thông tin (ví dụ thiếu cân nặng). AI sẽ hỏi lại hoặc bạn bổ sung. |
| Không thấy biểu tượng tool | Thoát hẳn ứng dụng rồi mở lại; kiểm tra file cấu hình đúng JSON (không thừa dấu phẩy); chạy `node --version` phải là 18 trở lên. |

Lỗi tạm thời của GHN (máy chủ bận, quá thời gian) được thử lại tự động một lần. Nếu vẫn lỗi, hãy hỏi lại sau ít phút.

## Bảo mật và quyền riêng tư

- **Chạy trên máy bạn (Local).** Token GHN nằm trong cấu hình ứng dụng AI trên máy bạn và chỉ gửi tới máy chủ của GHN. Chúng tôi không thấy token, không thấy dữ liệu của bạn.
- **Kết quả vẫn đi qua AI.** Những gì tool trả về (trạng thái đơn, số tiền, tên shop...) được gửi tới ứng dụng AI và nhà cung cấp mô hình bạn dùng, theo chính sách của họ. Vì vậy các tool **không** trả tên, số điện thoại, địa chỉ khách.
- **Không ghi log dữ liệu nhạy cảm.** Log chỉ gồm tên tool, mã lỗi, thời gian, mã HTTP và mã yêu cầu; không có token, số điện thoại, địa chỉ hay nội dung yêu cầu.
- **Đầu vào được kiểm tra chặt** (khóa lạ, chuỗi quá dài, số bất thường bị từ chối trước khi gọi GHN). Lỗi trả về không lộ chi tiết hệ thống hay thông báo thô của GHN.
- Repo có bộ test bảo mật và công cụ quét bí mật (`npm run quet-bi-mat`).

## Hỗ trợ ứng dụng AI

| Ứng dụng | Tình trạng |
|----------|------------|
| Claude Desktop | Mục tiêu hỗ trợ của v1.1 (macOS, Windows) |
| Ứng dụng khác dùng MCP qua stdio (ví dụ Cursor) | Có thể chạy được, **chưa kiểm chứng** |
| ChatGPT | **Chưa hỗ trợ** |

## Lộ trình

- **v1.1 (hiện tại):** 3 tool đọc dữ liệu GHN, chạy trên máy bạn.
- **v1.2 (dự kiến):** tra mã quận/phường theo tên (có bộ nhớ đệm), tự dò ShopId (chỉ cần dán token), gói cài một chạm cho Claude Desktop.
- **Sau đó:** cân nhắc thêm hãng vận chuyển (GHTK, Viettel Post, J&T).

Chưa có mốc ngày cố định cho v1.2.

## Phát triển

Yêu cầu: Node.js **22.12 trở lên** (công cụ dev: ESLint 10, Vitest 5). Người dùng cuối chỉ cần Node 18.

```bash
cd src
npm install
npm run typecheck && npm run build && npm run lint && npm run format:check
npm test              # unit test, có mock GHN
npm run quet-bi-mat   # quét bí mật trong file đã theo dõi
npm run perf          # build rồi đo hiệu năng (chế độ --mock không cần token)
```

Cấu trúc: `src/src/tools/` (tool), `src/src/core/` (kiểu, lỗi), `src/src/services/` (gọi GHN), `src/src/utils/` (log, kiểm tra đầu vào), `src/src/transports/` (stdio).

## Giấy phép

Mã nguồn trong repo này dùng giấy phép **MIT** ([LICENSE](LICENSE)): bạn được dùng, sửa, phân phối, kể cả thương mại, miễn là giữ thông báo bản quyền. Dự án này không liên kết với Giao Hàng Nhanh (GHN).

---

<a id="english"></a>

# Vietnam Logistics MCP (English)

[Tiếng Việt](#vietnam-logistics-mcp) | **English**

An MCP server for AI assistants (Claude Desktop and other MCP-capable apps) that lets you ask about **Giao Hàng Nhanh (GHN)** orders and shipping fees in natural language, in the middle of your conversation with the AI. It runs on your own machine; your GHN token never passes through any server of ours.

> **Status:** version **v1.1**, the first release. It has **3 read-only tools** (order detail, shop list, fee estimate). Creating and cancelling orders, multi-order tracking and district/ward lookup by name are not available (see [Roadmap](#roadmap)).

> Note: most of the product's users are Vietnamese shop owners, so the tool messages returned to the AI user are in **Vietnamese**. This English section is for developers and international users.

## What it does

| Tool | What it does | Needs |
|------|--------------|-------|
| `ghn_get_order_detail` | Look up one order by its tracking code: status, cash-on-delivery (COD) amount, expected delivery time, last update | `GHN_TOKEN` |
| `ghn_get_shops` | List the shops/warehouses of the account with their ShopId | `GHN_TOKEN` |
| `ghn_get_fee` | Estimate the shipping fee in VND | `GHN_TOKEN` and `GHN_SHOP_ID` |

**Personal data:** the read tools do **not** return names, phone numbers or addresses of recipients, senders or shops. They return statuses, amounts, times, shop IDs and names, and district/ward codes only.

## Install

### Requirements

1. **Node.js 18 or newer.**
2. **A GHN token:** sign in at [khachhang.ghn.vn](https://khachhang.ghn.vn), open **Quản lý Token** (Token management) and get the token with an SMS OTP. Treat it like a password.
3. **An MCP-capable AI app**, for example [Claude Desktop](https://claude.ai/download).

### Configure Claude Desktop

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`; Windows: `%APPDATA%\Claude\claude_desktop_config.json`; or **Settings → Developer → Edit Config**):

```json
{
  "mcpServers": {
    "ghn": {
      "command": "npx",
      "args": ["-y", "vietnam-logistics-mcp"],
      "env": {
        "GHN_TOKEN": "<your-ghn-token>",
        "GHN_SHOP_ID": "<your-shop-id>",
        "GHN_ENV": "production"
      }
    }
  }
}
```

Quit Claude Desktop completely and reopen it.

> If you prefer not to use `npx`, you can run it [from source](#run-from-source).

### Finding your ShopId (once)

Configure with **only `GHN_TOKEN`** first, restart, and ask: "List my GHN shops." Copy the ShopId you need into `GHN_SHOP_ID` and restart. `ghn_get_fee` requires it.

### Environment variables

| Variable | Required | Value |
|----------|----------|-------|
| `GHN_TOKEN` | Yes | Your GHN token |
| `GHN_SHOP_ID` | For `ghn_get_fee` | Positive integer, your shop ID |
| `GHN_ENV` | No | `production` (default) or `staging` (GHN's test environment, needs a staging token) |
| `LOG_LEVEL` | No | `info` (default), `warn`, `error` |

### Run from source

```bash
git clone https://github.com/ktc81/vietnam-logistics-mcp.git
cd vietnam-logistics-mcp/src
npm install
npm run build
```

Then use `"command": "node"` and `"args": ["/path/to/vietnam-logistics-mcp/src/dist/index.js"]` in the config above.

## Fee estimate notes

`ghn_get_fee` takes **codes**, not names: `from_district_id`, `to_district_id`, `to_ward_code`, `weight` (grams). Optional: `service_type_id` (`2` light goods, default; `5` heavy goods, which GHN accepts only above its weight threshold), `length`/`width`/`height` (cm), `insurance_value` (VND). Lookup of district/ward codes by name is not in v1.1. The result is an estimate, not a final quote.

## Security and privacy

- **Local:** your token lives in your AI app's configuration on your machine and is sent only to GHN's servers. We do not see your token or data.
- **Results still reach your AI provider:** whatever a tool returns goes to the AI app and its model provider under their policies. That is why the tools never return customer names, phones or addresses.
- **No sensitive logging:** logs contain tool name, error code, timing, HTTP status and request ID only.
- **Strict input validation** (unknown keys, oversized strings and odd numbers are rejected before any GHN call). Errors never expose stack traces or raw GHN messages.
- The repository ships a security test suite and a secret scanner (`npm run quet-bi-mat`).

## Supported AI apps

| App | Status |
|-----|--------|
| Claude Desktop | Target for v1.1 (macOS, Windows) |
| Other stdio MCP apps (for example Cursor) | May work, **not verified** |
| ChatGPT | **Not supported yet** |

## Roadmap

- **v1.1 (now):** 3 read-only GHN tools, running locally.
- **v1.2 (planned):** district/ward lookup by name (with caching), automatic ShopId discovery (paste only the token), one-click Claude Desktop extension.
- **Later:** consider more carriers (GHTK, Viettel Post, J&T).

There is no fixed date for v1.2.

## Development

Requires Node.js **22.12 or newer** (dev tooling: ESLint 10, Vitest 5). End users only need Node 18.

```bash
cd src
npm install
npm run typecheck && npm run build && npm run lint && npm run format:check
npm test
npm run quet-bi-mat
```


## License

The source code in this repository is under the **MIT** license ([LICENSE](LICENSE)): you may use, modify and distribute it, including commercially, as long as you keep the copyright notice. This project is not affiliated with Giao Hàng Nhanh (GHN).
