# Contract kiến trúc

Đọc khi project đã có `docs/architecture/contract.json`, hoặc muốn có các quy tắc phụ thuộc
mà một công cụ kiểm thay vì để reviewer phải nhớ.

## Ưu tiên công cụ của chính project

Nếu project đã thực thi ranh giới sẵn (một quy tắc boundaries hay import của ESLint,
dependency-cruiser, Nx module boundaries, import-linter cho Python, ArchUnit cho Java,
hay một script riêng như `scripts/check-boundaries.mjs` của chính nó), hãy dùng nó và
dừng ở đây. Contract dưới đây là phương án dự phòng cho các repository JavaScript/TypeScript
chưa có gì. Việc nhận nó là quyết định của project: hãy đề xuất, đừng tự thêm vào.

## Định dạng

```json
{
  "description": "Layers of the orders service",
  "modules": {
    "api": ["src/api/**"],
    "app": ["src/app/**"],
    "domain": ["src/domain/**"],
    "shared": ["src/shared/**"]
  },
  "allow": {
    "api": ["app", "shared"],
    "app": ["domain", "shared"],
    "domain": ["shared"],
    "shared": []
  },
  "denyPackages": { "domain": ["express", "pg", "node:fs"] },
  "ignore": ["**/*.test.ts", "**/__fixtures__/**"],
  "exceptions": [
    { "file": "src/domain/legacy-report.ts", "import": "src/api/**",
      "reason": "Report export predates the layering; removed by #412", "approvedBy": "main, 2026-11-05",
      "expires": "2027-03-31" }
  ]
}
```

- `modules`: tên -> các glob trên đường dẫn POSIX tương đối với repository (`**`, `*`, `?`).
  Một file thuộc module đầu tiên có glob khớp; file không thuộc module nào thì không bị kiểm.
- `allow`: một module được liệt kê chỉ được import chính nó và các module được nêu tên. Module
  không có trong `allow` thì không bị hạn chế, nên hãy liệt kê mọi module bạn muốn ràng buộc.
- `denyPackages`: tên package trần (hoặc builtin `node:`) mà một module không được import.
- `ignore`: các file không bao giờ bị kiểm.
- `exceptions`: bản ghi của việc chuyển lên. Mỗi mục cần `file` (một file, không dùng pattern),
  `import` (một glob trên file bị import, hoặc một tên package; đừng bao giờ dùng `**`),
  `reason` và `approvedBy`, và có thể có `expires` (YYYY-MM-DD; sau ngày đó nó không miễn gì
  nữa). Chỉ thêm một mục sau khi quyết định đã được người sở hữu quy tắc đó đưa ra, đừng bao
  giờ thêm để tự mình làm một phép kiểm đang fail lọt qua. Bộ kiểm sẽ liệt kê các exception
  không ai cần.

## Thay đổi contract thì phải được review

Làm yếu contract (thêm một exception, nới `allow`, bỏ một package bị cấm, thêm một `ignore`,
đổi một module) sẽ làm mọi phép kiểm pass, nên đó là một quyết định giống như một exception.
Với `--base <git-ref>`, bộ kiểm so contract với bản ở ref đó và fail (thoát mã 1) với mọi chỗ
nới lỏng nó tìm thấy, nêu tên từng chỗ, cho tới khi lần chạy nói ra ai đã review
nó: `--approved-by "main, 2026-11-05"`. Siết chặt thì không cần review. Các gate chạy với
`--base` (`main` cho nhánh của một việc được giao, `origin/main` trong CI) và không bao giờ với
`--approved-by`; reviewer chạy cờ đó sau khi đã quyết.

## Bộ kiểm thấy những gì

`node <skill dir>/scripts/check-boundaries.mjs --root <repo> [--contract FILE] [--base REF [--approved-by NAME]] [--json]`

- Đọc `import ... from`, `export ... from`, `import '...'` dạng side-effect, `import('...')`
  động và `require('...')`, bỏ qua comment, trong các file `.js .jsx .mjs .cjs .ts
  .tsx .mts .cts` (bỏ qua `.d.ts`, `node_modules`, `dist`, `build`, `coverage`).
- Phân giải các specifier tương đối theo cách Node và TypeScript làm (phần mở rộng, `index.*`,
  `./x.js` cho `./x.ts`). Alias đường dẫn (`@/x`, `paths` trong tsconfig) và specifier được
  tính ra lúc chạy thì không được phân giải: project dùng alias cần công cụ riêng của nó.
- Thoát mã 0 là sạch, 1 là có vi phạm (`file:line  from -> to (specifier): rule`) hoặc có một
  chỗ nới lỏng chưa được review, 2 là contract, tham số hay base không hợp lệ. Nó chỉ đọc file
  (và `git show <base>:<contract>`).

## Thực thi nó

Chỉ những quy tắc bộ kiểm xác minh được một cách đáng tin mới thuộc về một gate cứng.

- CI: thêm câu lệnh vào CI hoặc script test của project, với script được sao vào chính
  repository (ví dụ `tools/check-boundaries.mjs`) để CI không cần thư viện ALP.
- ALP: một hook dạng blocking sẽ chặn một handoff, một lần đóng task hay một lần merge khi phép
  kiểm còn fail; phần cuối output của nó là lý do agent đọc được. Một hook áp dụng cho các
  agent nêu tên nó, nên người dùng (không phải agent) định nghĩa hook và cấp cho họ:

```sh
alp hook add architecture --project --event handoff --command "node tools/check-boundaries.mjs --base main" --blocking --timeout 120
alp agent edit peer --project --hooks architecture
alp hook test architecture --project
```

Dùng `--event task.close` (trên main hoặc lead) hay `--event merge` cho các gate còn lại.
Hook của project chỉ chạy khi người dùng đã tin workspace (`alp trust`).
