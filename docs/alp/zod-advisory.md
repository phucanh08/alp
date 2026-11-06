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

## Ràng buộc cho người viết schema: bản vá chỉ bao ba loại collection (t-5294.4)

Bản vá 4.6.6 chỉ kiểm `.max()` trước khi đọc phần tử cho **`z.array`, `z.map`, `z.set`**. Không có
loại nào khác được bao, và điều đáng chú ý nhất là:

> **`z.record` KHÔNG được bao.** Một `z.record` dù có khai giới hạn vẫn bị zod đọc từng phần tử và
> giữ một issue cho mỗi phần tử sai, đúng hành vi mà advisory này nói tới.

Vì vậy, khi viết một field mới nhận đầu vào từ bên ngoài:

- Giới hạn một collection thì dùng `z.array` (hoặc `map`/`set`) kèm `.max()`. Đổi một field đang là
  array có `.max()` sang `z.record` là **mất** lớp bảo vệ, kể cả khi vẫn khai giới hạn.
- Nếu thật cần một record có giới hạn, phải chặn kích thước **trước** khi zod parse, bằng
  `bounded()` trong `packages/runtime/src/claude-transport.ts` (nó đo kích thước trong
  `z.preprocess` rồi mới cho schema chạy). `vars` của `alp_pour` là đúng mẫu này.
- Field nào dựa vào `.max()` của array thì nên có test ghim **cả hình dạng** chứ không chỉ con số,
  để lần sau ai đổi sang record thì test kêu. Hai ví dụ:
  `packages/runtime/tests/zod-security.test.js` (tool schema Claude) và
  `integrations/paseo/tests/compact-schema.test.js` (`alp.agent.compact.sessions`, max 4).

Rà toàn repo ngày 2026-11-06 (t-5294.4, mục 3) — **không có** `z.record` nào có giới hạn mà chưa qua
`bounded()`. Bốn chỗ dùng `z.record`, và đây là trạng thái của từng chỗ:

| Chỗ dùng | Đầu vào hay đầu ra | Giới hạn | Trạng thái |
| --- | --- | --- | --- |
| `packages/runtime/src/claude-transport.ts:138` (`alp_pour.vars`) | đầu vào | có | đã qua `bounded()` — đúng mẫu |
| `integrations/paseo/shared/library.ts:68` (`alp.library.save.content`) | đầu vào | không | không khai giới hạn (giá trị là `z.unknown()`, zod không parse sâu); t-32c1 chặn kích thước ở tầng trước |
| `integrations/paseo/shared/library.ts:46` (`alp.library.get.content`) | đầu ra | không | dữ liệu do ALP tạo, không phải đầu vào ngoài |
| `integrations/paseo/shared/tasks.ts:48` (`alp.tasks.list.sessions`) | đầu ra | không | dữ liệu do ALP tạo, không phải đầu vào ngoài |

## Phần còn lại, chưa sửa (t-ffe4.3)

Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) khai `zod` là peerDependency (`^4.0.0`), nên các
schema ALP tự đăng ký chạy trên bản zod ALP cài (4.6.7). Nhưng SDK còn **nhúng sẵn bản zod riêng**
trong `sdk.mjs`, `bridge.mjs` và `browser-sdk.js`, và ALP không build lại được các file này:

| SDK | Zod nhúng trong `sdk.mjs` / `bridge.mjs` / `browser-sdk.js` | Trong diện advisory |
| --- | --- | --- |
| 0.3.292 (bản ALP đang cài) | 4.5.4 | có |
| 0.3.318 (latest, kiểm ngày 2026-11-06) | 4.6.2 | có |

Vì vậy artifact phát hành của ALP vẫn **chứa một bản zod nằm trong diện advisory**, bên trong SDK.
ALP không sửa, viết lại hay vendor các file minified đó.

Ngày 2026-11-06 người dùng chấp nhận rủi ro còn lại này (bản zod nhúng trong SDK vẫn chưa được vá) và
t-ffe4.3 được đóng ở trạng thái wontfix (quyết định p-3f3a8f96 trên board).

**Hai điều kiện mở lại, chỉ cần một là đủ:**

1. Anthropic phát hành SDK nhúng zod ≥4.6.6 (hoặc dùng hẳn peer zod như SDK đã khai). Khi đó: nâng
   SDK, build và pack lại 8 package, quét lại các bản nhúng đã cài, chạy lại regression và lane
   consumer, review ở đúng SHA.
2. Tìm ra một đường chạy thật mà kẻ tấn công điều khiển được đầu vào đi tới các parser zod nhúng
   trong SDK. Khi đó việc này thành **P1** và sự chấp nhận rủi ro ở trên **hết hiệu lực** — không
   còn là residual nữa.

Sự chấp nhận này chỉ bao các bản zod nhúng bên trong SDK. zod mà ALP tự khai vẫn phải ≥4.6.6, và đây
không phải waiver cho advisory nào khác, cũng không phải lý do bỏ audit.

## Rủi ro được nói đúng mức

Rủi ro đã xác nhận là: **artifact phát hành có chứa bản zod dễ tổn thương**. Chưa có bằng chứng về
exploit: chưa tìm ra đường chạy nào trong ALP cho kẻ tấn công điều khiển đầu vào đi tới các parser zod
nhúng trong SDK (một `toolResult` bình thường của ALP là một chuỗi đã serialize), và chưa có bằng chứng
về listener công khai không xác thực nào bị khai thác được. Giới hạn kích thước chung cho đầu vào không
bị chặn trên (ngoài phạm vi advisory này) thuộc t-32c1.
