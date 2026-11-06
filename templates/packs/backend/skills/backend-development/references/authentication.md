# Authentication và authorization

Đọc khi chạm vào login, session, token, OAuth/OIDC, lưu trữ password, hoặc
kiểm tra quyền.

Dùng library hoặc provider auth hiện có của dự án. Tự viết mật mã, xử lý session, hay
parse token bằng tay là ngoài phạm vi; thay vào đó hãy đề xuất một library đã được
thẩm định cho owner. Thay đổi về auth xứng đáng có một lượt security-review.

## Session so với token

| | Session phía server | Token tự chứa (ví dụ JWT) |
| --- | --- | --- |
| Trạng thái | Bản ghi session trong một store; cookie giữ ID | Claim nằm trong token; xác minh bằng chữ ký |
| Thu hồi | Xóa bản ghi | Khó; cần hạn ngắn, deny list, hoặc xoay refresh token |
| Phù hợp | App trình duyệt trên một site | Service-to-service, API dùng bởi nhiều client |

- Session trình duyệt: cookie với `HttpOnly`, `Secure`, `SameSite=Lax` hoặc `Strict`,
  thời hạn có giới hạn, và một session ID mới sau khi login hay đổi đặc quyền.
- Request làm thay đổi trạng thái mà authenticate bằng cookie cần bảo vệ CSRF
  (SameSite cộng một token hoặc kiểm tra origin, theo quy ước của dự án).
- Token: xác minh chữ ký, thuật toán (đừng bao giờ nhận `none` hay một thuật toán
  ngoài dự kiến), issuer, audience, và hạn dùng ở mọi request. Giữ access token
  sống ngắn; xoay refresh token và phát hiện việc dùng lại.
- Đừng lưu token ở những nơi script bị tiêm có thể đọc, nếu dự án có thể dùng cookie
  HttpOnly thay thế.

## Lưu trữ password

- Hash bằng một hàm hash password chậm, có salt: Argon2id, scrypt, hay bcrypt, qua
  library hiện có của dự án. Đừng bao giờ dùng hash nhanh (MD5, SHA-1, SHA-256
  thuần), đừng bao giờ dùng mã hóa có thể giải ngược.
- So sánh bằng hàm verify của library (thời gian hằng).
- Hash lại khi login nếu tham số đã được nâng.
- Giới hạn tần suất cho endpoint login và reset; trả cùng một response cho user không
  tồn tại và cho sai password.
- Token reset: ngẫu nhiên, dùng một lần, hạn ngắn, lưu dạng đã hash.

## OAuth 2.0 và OIDC (mức tổng quan)

- Đăng nhập web và mobile: authorization code flow với PKCE. Validate `state` (CSRF)
  và, với OIDC, `nonce`. Đừng dùng implicit flow.
- Service-to-service: client credentials flow với credential có scope lấy từ config.
- ID token của OIDC định danh user với client; access token cho phép gọi API. Đừng
  dùng ID token làm access token cho API.
- Đăng ký redirect URI chính xác; đừng bao giờ nhận một đích redirect từ input của
  user mà không có allowlist.
- Map danh tính bên ngoài sang user nội bộ theo subject ID ổn định của provider cộng
  issuer, không chỉ theo email.

## Đặt authorization ở đâu

- Authenticate ở biên (middleware hoặc tương đương) và gắn một danh tính vào context
  của request.
- Authorize tại nơi đã biết resource: sau khi load nó, kiểm tra người gọi được phép
  tác động lên chính bản ghi đó (chủ sở hữu, tenant, role, hay policy). Chỉ kiểm tra
  role ở mức route thì không chặn được việc truy cập bản ghi của user khác (IDOR).
- Giới hạn truy vấn theo tenant hoặc chủ sở hữu ngay trong lớp truy cập dữ liệu khi
  dự án là multi-tenant, để một lần quên kiểm tra vẫn fail an toàn.
- Mặc định từ chối. Endpoint mới không có policy tường minh thì phải không tới được.
- Giữ việc kiểm tra policy ở một chỗ mà dự án đã dùng (một module policy, decorator,
  hay guard) thay vì rải rác các câu điều kiện.
- Background job và lời gọi nội bộ hành động với một danh tính hoặc service account
  tường minh; ghi lại nó trong audit log ở nơi dự án lưu chúng.

## Secret và config

- Khóa ký, client secret, và giá trị pepper đến từ cơ chế secret của dự án. Đừng đọc,
  in, hay commit giá trị của chúng; test dùng khóa test riêng hoặc fake.
- Đừng bao giờ log credential, token, session ID, hay link reset.

## Những kiểm tra cần thêm

- Request chưa authenticate bị từ chối (401).
- User đã authenticate nhưng không có quyền bị từ chối (403 hoặc 404).
- User A không đọc hay sửa được resource của user B.
- Token hết hạn, bị sửa, hay sai audience bị từ chối.
- Logout hoặc thu hồi thực sự kết thúc quyền truy cập.
