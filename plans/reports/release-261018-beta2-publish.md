# Beta.2 (`0.0.0-beta.2`): publish và nghiệm thu sau publish

Task t-4393.3, lead (ALP, Claude Code) theo yêu cầu của anh ngày 2026-10-17. Runbook:
`docs/alp/beta-scope.md` §7, §11.3–§11.4. Kết quả chuẩn ghi ở §11.6; báo cáo này tóm tắt và chỉ
chỗ để evidence.

## Tóm tắt

- Release SHA `1b16b14004e01eb6d5064a3e9cddb642f9d9f509` (`main`). Pack một lần trên CI:
  [release-acceptance 39081508130](https://github.com/phucanh08/alp/actions/runs/39081508130),
  `SHA256SUMS` = `916f49a91a3069c61bdb3bd6f2fdb9e27436acd33167f44891fabbed08040364`.
- Gate `publish` exit 0: H1–H5 ([CI 39081421077](https://github.com/phucanh08/alp/actions/runs/39081421077)),
  L1, S1, A5, R1, R2, R5, R7 pass; R3, R4, R6 không chặn, chưa chạy (D7).
- Tag `v0.0.0-beta.2` (annotated, trỏ `1b16b14`), GitHub prerelease với 8 tarball, `SHA256SUMS`,
  `release-manifest.json`.
- 8 package lên npm với `--tag beta`, 2026-10-18 00:34–00:49Z, không cần OTP; `dist.integrity`
  khớp manifest cả 8.
- Q1–Q3 pass; gate `latest` exit 0. Q3: `paseo plugin add npm:@anhlp/alp-paseo@beta` cài được,
  #111 đã đóng.
- Q4, Q5, chạy lại `npm deprecate alp-paseo-plugin` và bỏ draft: chưa chạy. Anh xem lại các bước do lead chấm (dưới) trước; lệnh còn lại ghi ở §11.6
  (dòng Q4, Q5, Dọn npm, Announce) và trong handoff của t-4393.3. Tới lúc đó `latest` vẫn là
  `0.0.0-beta.1` cả 8 và GitHub prerelease vẫn là draft.

## Khác với beta.1

- R5 và Q3 dùng một daemon Paseo 0.11.4 riêng (`PASEO_HOME` dưới `/tmp`, cổng 6797–6799, tắt relay)
  và `ALP_HOME` mới, vì phiên ALP chạy việc này là con của alpd `~/.alp` do Paseo của anh khởi động.
  Main duyệt. `~/.paseo`, `~/.alp`, bản cài global và alpd của anh không bị đụng.
- W3/W4 lái bằng `paseo` CLI (`run`, `stop`, `send`, `permit allow --input '{"answers":…}'`), W5/W6
  bằng Chromium headless (Playwright 1.64.1 của repo) trên `alp web`, có ảnh chụp.
- Bước cần người đọc (C5 của R1, W3–W6 của R5, nửa trình duyệt W6 của Q3) do lead chấm; ghi trong
  trường `runner` của evidence.
- Node 24.22.0 tải từ nodejs.org (đã kiểm `SHASUMS256.txt`), vì Node hệ thống là 26.3.0.
- Hai tiến trình mồ côi từ worktree `alp-beta2` đã xóa (web integration giữ cổng 7433 và alpd của
  nó, cả hai dùng `ALP_HOME` tạm) bị dừng trước R5 để trả cổng 7433.

## Quan sát, chưa sửa

- Chạy thẳng `server/dist/main.js --register` trong bản plugin Paseo cài từ `npm:` báo
  `ERR_MODULE_NOT_FOUND` `@getpaseo/plugin` (peer Paseo cung cấp khi nạp plugin). Đường có trong
  docs (`npm install -g @anhlp/alp-paseo@beta`, `alp-web-integration --register`) chạy được.
- W3 Claude: Paseo chỉ hiện cả tin nhắn khi xong (#107, known issue). Stop vẫn dừng turn (ở số 93).
- Supervisor của team Phở gửi mail nhận xét vào session sau mỗi turn trong lúc nghiệm thu (thấy trong
  Paseo/`alp web`); không ảnh hưởng kết quả.

## Evidence (trên máy anh, ngoài repo)

| Phần | Đường dẫn |
|---|---|
| Bộ tarball (chỉ đọc) và bản sao | `~/alp-release/1b16b14/v0.0.0-beta.2/`, `~/alp-release/copy-1b16b14/` |
| File evidence của gate | `~/alp-release/release-evidence-1b16b14.json` |
| Build worktree, L1, S1, A5, consumer, gate | `~/alp-release/evidence/beta2/` |
| R1, R2 | `~/alp-release/runs/1b16b14-cli-{codex,claude}/` |
| R5 (kết quả harness, log lái W3/W4, ảnh W5/W6) | `~/alp-release/runs/r5-1b16b14/` |
| R7 | `~/alp-release/runs/r7-1b16b14/` |
| Publish | `~/alp-release/evidence/beta2/publish-log-1b16b14.txt` |
| Q1–Q5 | `~/alp-release/evidence/q-1b16b14/` |
| Release notes đã đăng | `~/alp-release/release-notes-beta.2.md` |
