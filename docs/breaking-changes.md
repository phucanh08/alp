# Thay đổi phá vỡ và khác biệt với upstream

Những chỗ ALP cố ý khác Paseo (upstream `getpaseo/paseo`) hoặc khác bản ALP trước, theo thứ tự mới
nhất trước. Mỗi mục nói cái gì đổi, ai bị ảnh hưởng, và vì sao.

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
