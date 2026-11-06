# Zod GHSA-mrhx-c7xc-m3w5: phần ALP đã sửa và phần còn lại

Advisory: [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), mức HIGH,
"Zod can exhaust memory while validating oversized constrained collections", ảnh hưởng `zod <4.6.6`,
bản vá `4.6.6`. Issue: [#235](https://github.com/phucanh08/alp/issues/235). Task: t-d676 (phần ALP),
t-ffe4.3 (phần còn lại trong Claude Agent SDK).

## Lỗi là gì

Trước 4.6.6, `$ZodArray` (và map, set) parse từng phần tử rồi mới kiểm `.max()`, và giữ một issue cho
mỗi phần tử sai. Một danh sách quá dài nên vì thế tốn bộ nhớ theo độ dài của nó, dù schema đã đặt giới
hạn. Từ 4.6.6, danh sách vượt giới hạn bị từ chối ngay ở giới hạn đó, trước khi đọc phần tử nào.

## Phần ALP đã sửa (t-d676)

- Bốn manifest ALP tự khai (`package.json`, `packages/runtime`, `packages/daemon`,
  `integrations/paseo`) và `package-lock.json` đều ghim `zod` **4.6.7**. 4.6.7 là `latest` trên npm và
  là bản `npm audit` đề xuất; mã của nó giống hệt 4.6.6, chỉ khác chuỗi version.
- `npm audit --audit-level=high` của repo: 0 lỗ hổng.
- Các bundle ALP tự build (alpd, CLI, plugin Paseo) lấy zod từ `node_modules`, nên khi build lại sẽ
  nhúng bản 4.6.7.
- Regression: `packages/runtime/tests/zod-security.test.js` kiểm bản zod cài đặt, hành vi của
  array/set/map có `.max()`, mọi danh sách có giới hạn trong tool schema Claude của ALP
  (`claude-transport.ts`, `toolShapes`) và hai danh sách lồng trong `verdict` của `alp_handoff`. Với
  zod 4.4.3 cả 4 test fail; với 4.6.7 cả 4 pass.

## Phần còn lại, chưa sửa (t-ffe4.3)

Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) khai `zod` là peerDependency (`^4.0.0`), nên các
schema ALP tự đăng ký chạy trên bản zod ALP cài (4.6.7). Nhưng SDK còn **nhúng sẵn bản zod riêng**
trong `sdk.mjs`, `bridge.mjs` và `browser-sdk.js`, và ALP không build lại được các file này:

| SDK | Zod nhúng trong `sdk.mjs` / `bridge.mjs` / `browser-sdk.js` | Trong diện advisory |
| --- | --- | --- |
| 0.3.292 (bản ALP đang cài) | 4.5.4 | có |
| 0.3.318 (latest, kiểm ngày 2026-11-06) | 4.6.2 | có |

Vì vậy artifact phát hành của ALP vẫn **chứa một bản zod nằm trong diện advisory**, bên trong SDK.
ALP không sửa, viết lại hay vendor các file minified đó. Điều kiện đóng t-ffe4.3: SDK phát hành bản nhúng
zod ≥4.6.6 (hoặc dùng hẳn peer zod), rồi ALP nâng SDK, build và pack lại, quét lại các bản nhúng.

Ngày 2026-11-06 người dùng chấp nhận rủi ro còn lại này (bản zod nhúng trong SDK vẫn chưa được vá) và
t-ffe4.3 được đóng ở trạng thái wontfix; điều kiện mở lại nằm trong task t-ffe4.3 và quyết định
p-3f3a8f96 trên board.

## Rủi ro được nói đúng mức

Rủi ro đã xác nhận là: **artifact phát hành có chứa bản zod dễ tổn thương**. Chưa có bằng chứng về
exploit: chưa tìm ra đường chạy nào trong ALP cho kẻ tấn công điều khiển đầu vào đi tới các parser zod
nhúng trong SDK (một `toolResult` bình thường của ALP là một chuỗi đã serialize), và chưa có bằng chứng
về listener công khai không xác thực nào bị khai thác được. Giới hạn kích thước chung cho đầu vào không
bị chặn trên (ngoài phạm vi advisory này) thuộc t-32c1.
