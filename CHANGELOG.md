# Lịch sử thay đổi / Changelog

Tiếng Việt | [English](#english)

Định dạng theo [Keep a Changelog](https://keepachangelog.com/vi/1.1.0/); phiên bản theo [SemVer](https://semver.org/lang/vi/).

## [1.1.0] - 2026-11-27

Bản đầu tiên: MCP Server đọc dữ liệu **Giao Hàng Nhanh (GHN)** bằng tiếng Việt, chạy trên máy của bạn.

### Thêm mới

- **`ghn_get_order_detail`**: tra chi tiết một đơn theo mã vận đơn. Trả trạng thái (có tên tiếng Việt), tiền thu hộ (COD), thời gian dự kiến giao, lần cập nhật gần nhất.
- **`ghn_get_shops`**: liệt kê shop/kho của tài khoản kèm ShopId, tên và mã quận/phường.
- **`ghn_get_fee`**: tính phí vận chuyển dự kiến (tổng phí, phí dịch vụ, phí bảo hiểm) từ mã quận gửi/nhận, mã phường nhận, cân nặng; tùy chọn dịch vụ (hàng nhẹ hoặc hàng nặng), kích thước, giá trị bảo hiểm.
- Chạy bằng Node.js 18 trở lên qua stdio; cấu hình bằng `GHN_TOKEN`, `GHN_SHOP_ID`, `GHN_ENV` (`production` hoặc `staging`), `LOG_LEVEL`.
- Thông báo lỗi tiếng Việt, rõ nguyên nhân; tự thử lại một lần khi GHN báo lỗi máy chủ hoặc quá thời gian.
- README song ngữ Việt + Anh, hướng dẫn cài đặt cho Claude Desktop.
- Giấy phép MIT.

### Bảo mật và quyền riêng tư

- Token chỉ đọc từ biến môi trường, chỉ gửi tới máy chủ GHN; không ghi log.
- Các tool **không trả tên, số điện thoại, địa chỉ** của người nhận, người gửi hay shop.
- Log chỉ có tên tool, mã lỗi, thời gian, mã HTTP và mã yêu cầu.
- Đầu vào được kiểm tra chặt trước khi gọi GHN; lỗi không lộ chi tiết hệ thống hay thông báo thô của GHN.
- Có bộ test bảo mật và công cụ quét bí mật (`npm run quet-bi-mat`).

### Giới hạn đã biết

- Chỉ có **3 tool đọc dữ liệu**; chưa tra được mã quận/phường theo tên.
- `ghn_get_fee` cần **`GHN_SHOP_ID`** và nhận **mã** quận/phường, không nhận tên.
- `ghn_get_shops` mới lấy **trang đầu** danh sách shop của GHN; tài khoản có rất nhiều shop có thể chưa thấy đủ.
- Dịch vụ hàng nặng (`service_type_id` = 5) chỉ nhận cân nặng lớn hơn ngưỡng của GHN.
- Kết quả phí là **ước tính**, không phải báo giá cuối.
- **ChatGPT chưa được hỗ trợ**. Ứng dụng khác dùng MCP qua stdio (ví dụ Cursor) có thể chạy nhưng chưa kiểm chứng.
- Dự án không liên kết với Giao Hàng Nhanh (GHN).

### Nâng cấp

Đây là bản đầu tiên, không có bước nâng cấp.

---

<a id="english"></a>

# Changelog (English)

[Tiếng Việt](#lịch-sử-thay-đổi--changelog) | **English**

## [1.1.0] - 2026-11-27

First release: an MCP server that reads **Giao Hàng Nhanh (GHN)** data in natural language, running on your own machine.

### Added

- **`ghn_get_order_detail`**: look up one order by tracking code. Returns the status (with a Vietnamese label), cash-on-delivery (COD) amount, expected delivery time and last update.
- **`ghn_get_shops`**: list the account's shops/warehouses with ShopId, name and district/ward codes.
- **`ghn_get_fee`**: estimate the shipping fee (total, service fee, insurance fee) from sender/receiver district codes, receiver ward code and weight; optional service type (light or heavy goods), dimensions and insurance value.
- Runs on Node.js 18 or newer over stdio; configured with `GHN_TOKEN`, `GHN_SHOP_ID`, `GHN_ENV` (`production` or `staging`), `LOG_LEVEL`.
- Clear Vietnamese error messages; one automatic retry on GHN server errors or timeouts.
- Bilingual (Vietnamese + English) README and Claude Desktop setup guide.
- MIT license.

### Security and privacy

- The token is read from environment variables only and sent only to GHN's servers; it is never logged.
- The tools **do not return names, phone numbers or addresses** of recipients, senders or shops.
- Logs contain tool name, error code, timing, HTTP status and request ID only.
- Strict input validation before any GHN call; errors never expose system details or raw GHN messages.
- A security test suite and a secret scanner (`npm run quet-bi-mat`) are included.

### Known limitations

- Only **3 read-only tools**; district/ward codes cannot be looked up by name yet.
- `ghn_get_fee` needs **`GHN_SHOP_ID`** and takes district/ward **codes**, not names.
- `ghn_get_shops` returns only the **first page** of GHN's shop list; accounts with very many shops may not see all of them.
- The heavy-goods service (`service_type_id` = 5) only accepts weights above GHN's threshold.
- Fee results are **estimates**, not final quotes.
- **ChatGPT is not supported**. Other stdio MCP apps (for example Cursor) may work but are not verified.
- This project is not affiliated with Giao Hàng Nhanh (GHN).

### Upgrading

This is the first release; there is nothing to upgrade.
