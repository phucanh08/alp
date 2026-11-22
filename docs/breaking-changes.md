# Thay đổi phá vỡ và khác biệt với upstream

Những chỗ ALP cố ý khác Paseo (upstream `getpaseo/paseo`) hoặc khác bản ALP trước, theo thứ tự mới
nhất trước. Mỗi mục nói cái gì đổi, ai bị ảnh hưởng, và vì sao.

## 2026-11-22: Dữ liệu Usage như Paseo; công tắc Check usage của host (t-9116)

- **`daemon.usage` thêm field** (cộng thêm, `name` cũ không đổi): `windows[].id`/`label`, `planLabel`,
  `details`, `balances`, `account`. Client cũ bỏ qua field lạ.
- **Extra usage của Claude không còn là một cửa sổ** (khác ALP trước): trước đây `extra usage` hiện như
  một thanh % (tiền overage đã tiêu trong tháng so với trần), và khi nó tới 100% thì provider bị coi là
  `limited` và việc theo dõi hạn mức của alpd coi runtime chưa được làm lại. Nay nó là một dòng
  `Extra usage: Enabled/Disabled` như Paseo, không bao giờ làm provider `limited`. Catalog mà agent thấy
  cũng không còn cửa sổ `extra_usage` (có `extraUsage: true/false`).
- **`seven_day_oauth_apps` không hiện** trong `daemon.usage` (như Paseo); alpd vẫn tính nó khi xét hạn
  mức như trước.
- **Cửa sổ theo model** (`model_scoped` của Claude SDK, như "Weekly · Fable") nay hiện, nhưng alpd không
  dùng nó để giữ runtime tạm dừng (chỉ `seven_day_opus`/`seven_day_sonnet` cũ vẫn được tính, như trước).
- **Khác Paseo**: id cửa sổ theo model là `weekly:<model>` (Paseo: `weekly_model_<model>`); gói Claude
  là `Max`, không có hạng `5x` (Paseo đọc credential OAuth; ALP không đọc file hay keychain credential,
  Claude SDK không trả hạng); Codex đọc qua app-server (`account/rateLimits/read`, `account/read`)
  thay vì API `wham/usage`, nên bucket khác mặc định được định danh bằng `limitId`
  (`limit:<limitId>:<length>`); không có `code_review` riêng. Email chỉ có trong câu trả lời cho
  dashboard của host owner (Paseo gửi email làm nhãn tài khoản, `account.label`, cho client của daemon).
- **Check usage** (`host.usage.setting.*`, như Paseo "Applies to <host> on every device"): tắt thì
  dashboard trả `{ disabled: true, providers: [] }` và không hỏi provider nào. Khác Paseo: chỉ áp
  dụng cho `alp dashboard`; bridge Paseo và việc theo dõi hạn mức của alpd không đọc công tắc.
- **Trang Usage trên web, khác Paseo**: ghim mặc định là cửa sổ 5 giờ và tuần đầu tiên (không có cờ
  `summary` của source như Paseo), nên một cửa sổ chính dài khác (ví dụ 1 ngày) mà Paseo ghim thì ALP
  không ghim; nút refresh của từng thẻ làm mới mọi provider (`daemon.usage` chỉ có một `refresh`);
  không kéo đổi thứ tự thẻ, không dự báo nhịp dùng; "Summary in sidebar" là công tắc riêng của trình
  duyệt (Settings › Sidebar của ALP không có dòng Usage).

## 2026-11-21: Sidebar như Paseo: session dưới mọi workspace, diff/PR/CI, Schedules, usage (t-ff83)

- **Mọi client**: nhóm theo Project, sidebar liệt kê session của **mọi** workspace (trước chỉ
  workspace đang mở), đọc `session.list` mỗi 15 s cho các workspace khác. Gập/mở theo từng project.
- **Facts theo workspace, không theo agent worktree** (khác Paseo): ở Paseo mỗi agent có worktree
  riêng nên mỗi hàng có diff, nhánh, PR, CI riêng. Ở ALP các session của một workspace dùng chung thư
  mục, nên `host.workspace.facts` trả theo workspace và sidebar chỉ hiện chúng **một lần, trên hàng
  session gần nhất** của workspace. Chỉ host owner thấy.
- **Schedules là wake một lần của ALP, chỉ đọc** (khác Paseo): Paseo có schedule lặp lại tạo agent
  mới; ALP có `schedule.*` mở một turn trên session gốc vào một giờ định trước. Màn Schedules chỉ liệt
  kê (trạng thái, giờ, prompt, session); không tạo, tạm dừng hay sửa. Chỉ host owner.
- **New workspace** (owner) đăng ký một thư mục của host (`host.project.register`); Paseo tạo
  workspace/worktree mới. Client không phải owner vẫn thấy New session ở trên cùng.
- Usage ở chân (owner) đọc `daemon.usage`; icon provider là glyph vẽ lại, không phải logo của hãng.
- Schedules là một mục của Settings › Sidebar › Header (owner ẩn/sắp xếp được; danh sách đã lưu
  không có nó thì được thêm vào cuối, hiện). New workspace chiếm chỗ mục "New session"; Settings ›
  Sidebar gọi nó là New workspace cho owner.
- **Show mặc định của sidebar đổi theo Paseo** (khác mặc định ALP trước đó): Branch bật, Host tắt,
  không có giờ ở cuối hàng. Trước: Branch tắt, Host bật, có giờ. Chuyển một lần: Show đã lưu mà vẫn
  đúng y mặc định cũ (người dùng chưa từng đổi; mỗi lần lưu bất kỳ preference nào, kể cả theme, ghi cả
  Show) được chuyển sang mặc định mới; Show đã đổi bất kỳ chỗ nào giữ nguyên. Sau lần chuyển, Show được
  lưu kèm `revision: 2`, nên chọn lại đúng mặc định cũ thì được giữ. Đổi ở Display preferences › Show.

## 2026-11-21: Settings bỏ Voice, Pair device, Plugins, Metadata; việc đổi host chỉ cho host owner (t-a95b)

- **Bỏ trang** (khác Paseo): Settings của app web và ALP.app không còn Voice, Pair device, Plugins và Metadata,
  cả trong nav lẫn trong code trang. ALP không có speech provider để cài trên host; ghép thiết bị là
  `alp dashboard pair` trên host; cài plugin thay đổi host và ALP không có đường cài plugin từ app;
  ALP không có tính năng sinh tiêu đề session hay tên nhánh. Ai mở Settings ở các trang đó
  (`settings-voice`, `settings-pair-device`, `settings-plugins`, `settings-metadata`) không
  còn thấy chúng.
- **Host owner** (khác Paseo, nơi app cục bộ là chủ daemon): việc đổi host trong Settings chỉ mở cho
  credential của `alp dashboard` trên kết nối loopback trực tiếp
  ([alp/remote-gateway.md](alp/remote-gateway.md) §5.19). Mọi credential của `alp-gateway` riêng, thiết
  bị Paseo qua relay, proxy có header chuyển tiếp giữ nguyên hành vi: cùng lỗi `-32601 not_exposed` như trước.
  Method đầu tiên là `daemon.usage` (trước đây denied cho mọi client của gateway).
- **Protocol**: thêm capability `host.owner`, chỉ gateway của dashboard liệt kê trong hello cho owner;
  alpd không bao giờ liệt kê nó. Client cũ bỏ qua capability lạ, nên không phá client nào.
