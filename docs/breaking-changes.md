# Thay đổi phá vỡ và khác biệt với upstream

Những chỗ ALP cố ý khác Paseo (upstream `getpaseo/paseo`) hoặc khác bản ALP trước, theo thứ tự mới
nhất trước. Mỗi mục nói cái gì đổi, ai bị ảnh hưởng, và vì sao.

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
  bị Paseo qua relay, proxy hay tunnel giữ nguyên hành vi: cùng lỗi `-32601 not_exposed` như trước.
  Method đầu tiên là `daemon.usage` (trước đây denied cho mọi client của gateway).
- **Protocol**: thêm capability `host.owner`, chỉ gateway của dashboard liệt kê trong hello cho owner;
  alpd không bao giờ liệt kê nó. Client cũ bỏ qua capability lạ, nên không phá client nào.
