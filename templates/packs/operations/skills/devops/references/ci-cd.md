# Pipeline CI/CD

Đọc khi sửa các stage của pipeline, việc cache, phiên bản action hay công cụ, token và quyền,
hoặc tính tái lập của build.

## Các stage

Thứ tự thường gặp; hãy giữ tên stage và cách chia stage đang có của dự án:

1. Checkout và setup (ghim phiên bản runtime và công cụ).
2. Cài phụ thuộc từ lockfile ở chế độ frozen.
3. Kiểm tra tĩnh: format, lint, kiểm kiểu. Nhanh, fail sớm.
4. Test: unit, rồi integration; các bộ nặng hơn thì chặn sau cổng hoặc chạy song song.
5. Build artifact và image, gắn tag bằng một định danh bất biến.
6. Các kiểm tra bảo mật và giấy phép mà dự án đã dùng.
7. Publish artifact (chỉ trên các branch được bảo vệ hoặc trên tag).
8. Deploy tự động lên môi trường không phải production nếu dự án làm vậy; production thì đặt sau một
   bước chấp thuận thủ công hoặc một môi trường được bảo vệ.

- Mỗi job làm một việc và nêu rõ đầu vào, đầu ra của nó.
- Fail sớm: kiểm tra rẻ trước kiểm tra đắt; hủy những lần chạy đã bị thay thế trên cùng branch.
- Các kiểm tra bắt buộc trên branch mặc định phải khớp với những job thực sự chạy.

## Cache

- Cache phần tải phụ thuộc với key gồm hash của lockfile cộng với OS và phiên bản runtime.
- Chỉ cache output build khi công cụ hỗ trợ việc vô hiệu cache đúng đắn.
- Không bao giờ cache secret, thông tin đăng nhập hay output của deploy.
- Cache là một tối ưu: pipeline phải pass được với cache nguội. Nếu không, thì cái
  cache đó đang che một bug.
- Theo dõi kích thước cache và thời gian khôi phục; một cache quá lớn có thể còn chậm hơn cài lại.

## Ghim phiên bản

- Ghim action, orb hay plugin của bên thứ ba vào một SHA commit đầy đủ hoặc một phiên bản bất biến, kèm
  phiên bản người đọc được trong một comment, theo quy ước của dự án.
- Ghim image của runner, runtime ngôn ngữ và công cụ CLI vào những phiên bản tường minh.
- Ghim các base image container được dùng trong job.
- Cập nhật các mốc ghim một cách có chủ ý (qua công cụ cập nhật phụ thuộc của dự án nếu có) và hãy review
  những thay đổi từ thượng nguồn.

## Token theo nguyên tắc đặc quyền tối thiểu

- Đặt quyền mặc định của token thành chỉ đọc ở cấp workflow; chỉ cấp phạm vi ghi cho từng job
  ở nơi thực sự cần (ví dụ publish package, comment lên PR).
- Ưu tiên thông tin đăng nhập liên kết, sống ngắn (OIDC) hơn là khóa cloud sống lâu, ở nơi nền tảng
  hỗ trợ; giới hạn sự tin cậy theo repository, branch và môi trường.
- Lưu secret trong kho secret của nền tảng, giới hạn theo từng môi trường; secret của production thì chỉ
  nằm trong những môi trường được bảo vệ có người review bắt buộc.
- Không bao giờ echo secret ra; tránh những lệnh in biến môi trường. Hãy che các giá trị suy ra từ chúng.
- Workflow được kích hoạt bởi fork hay PR không tin được thì không được nhận secret hay token ghi. Hãy
  cẩn thận với những trigger chạy với đặc quyền cao trên nội dung của PR.
- Coi tiêu đề PR, tên branch và nội dung commit là dữ liệu nhập không tin được; không nội suy chúng
  trực tiếp vào lệnh shell.

## Build tái lập được

- Cùng commit, cùng đầu vào, cùng đầu ra: lockfile được commit, cài ở chế độ frozen, công cụ được ghim.
- Tránh tải những tài nguyên không ghim phiên bản từ mạng trong lúc build (`curl | sh`, tải bản `latest`).
- Ghi lại nguồn gốc của build: SHA commit, ID lần chạy pipeline, phiên bản công cụ, trong metadata của artifact.
- Build một lần, rồi đưa chính artifact đó đi qua các môi trường; không build lại cho từng môi trường.
- Cấu hình khác nhau theo từng môi trường thì được tiêm vào lúc deploy, không nướng sẵn vào bản build.

## Job chập chờn

- Không thêm retry tràn lan để che các lần fail. Hãy cách ly một test đã biết là chập chờn, kèm người sở hữu và
  tham chiếu tới issue, theo quy ước của dự án.
- Ghi lại runner, thời gian và seed với những lần fail không đều; dùng bug-loop để chẩn đoán.

## Sửa pipeline một cách an toàn

- Validate cú pháp bằng linter hay schema của nền tảng nếu có ở cục bộ.
- Thử chạy thay đổi đó trên một branch hoặc bằng một lần chạy kích hoạt thủ công khi được phép; push để kích hoạt
  CI thì cần sự cho phép của việc được giao.
- Giữ diff nhỏ; tách việc refactor pipeline khỏi những thay đổi hành vi.
- Kiểm cả đường thành công và đường thất bại (một test fail thì phải làm job fail).
- Ghi lại mọi thay đổi với các kiểm tra bắt buộc hay với bảo vệ branch; những thiết lập đó là quyết định của chủ sở hữu.

## Checklist review

- Phiên bản đã ghim; quyền mặc định là chỉ đọc; secret có giới hạn phạm vi và không lộ ra cho fork.
- Key cache có bao gồm lockfile; pipeline pass được khi cache nguội.
- Artifact được gắn tag bất biến và được đưa lên môi trường sau, không build lại.
- Deploy production bị chặn bởi một bước chấp thuận hoặc một môi trường được bảo vệ.
