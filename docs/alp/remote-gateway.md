# ALP remote gateway (Task 08)

> **Trạng thái beta `0.0.1-beta.3`: deferred.** `@anhlp/alp-gateway` không phát hành trong beta
> (private), và chế độ remote của plugin cũng deferred. Tài liệu này mô tả mã trong repo cho phát
> triển, không phải hướng dẫn cài đặt. Phạm vi: [beta-scope.md](beta-scope.md) §2, §4.

Gateway WebSocket độc lập để client ở xa (Paseo trên máy khác, browser, React Native, Node) dùng
alpd của **một OS user** qua Protocol v1. Package `@anhlp/alp-gateway`, mã ở `apps/gateway`.

Luồng: `Client → WebSocket (TLS) → alp-gateway → @anhlp/alp-client (connectSocket) → IPC → alpd`.

Số mục (§) được code tham chiếu; giữ ổn định.

## 1. Phạm vi và quyết định chính

| Chủ đề | Quyết định |
|---|---|
| Đối tượng phục vụ | Một alpd của một OS user. Gateway chạy cùng user đó. Không multi-tenant, không account/OAuth. |
| Kết nối tới alpd | Chỉ qua client SDK (`connectSocket`: kiểm tra socket private, rồi `AlpRpcClient` + `hello`). Không dùng `DaemonServer.accept`. Không mở IPC ra mạng. Không tự khởi động alpd. |
| Kết nối upstream | **Mỗi client remote có một connection IPC riêng.** alpd gắn attach, event và vòng đời theo connection, nên response/event của client này không thể đi nhầm sang client khác. Client rời đi thì alpd xử lý như một viewer local rời đi. |
| Xác thực | Credential dài hạn chỉ gửi trong header `Authorization` tới `POST /v1/tickets`. WebSocket mở bằng **ticket một lần** đặt trong subprotocol. Không có secret trong URL (§4). |
| Phân quyền | Default deny theo bảng method (§5). Mỗi request đi qua permission rồi scope workspace/session. Result và event cũng bị lọc. |
| TLS | Đường chính: reverse proxy (Caddy) terminate TLS, gateway bind loopback. TLS trực tiếp là tùy chọn phụ (§7). |
| Trạng thái gateway | Chỉ gồm credentials (hash), ticket trong bộ nhớ và cache scope theo connection. Không có event store, không đọc/ghi ALP business state. |

## 2. Trách nhiệm

| Thành phần | Sở hữu |
|---|---|
| alpd | Sessions, tasks, configuration, event history, cursor/replay, receipts, retention |
| Gateway | Authentication, authorization, kết nối mạng, giới hạn tài nguyên, forwarding, lọc result/event |
| Client SDK | JSON-RPC engine, transport, reconnect helper (không bao giờ tự gửi lại request) |
| Client (Paseo) | Lưu credential an toàn, lấy ticket, theo dõi cursor theo root, quyết định retry |

## 3. Kết nối và Protocol v1

- **Endpoint**: `GET /v1/ws` với subprotocol `alp.v1`. Mỗi WebSocket text message là một message
  JSON-RPC (alp-json-rpc-v1 §4).
- **Handshake**: `daemon.hello` do gateway trả lời sau khi chính nó đã `hello` với alpd:
  - `protocolVersion: 1`;
  - `daemonVersion` lấy từ alpd;
  - `hostname`: tên máy của daemon host (alpd trả `os.hostname()`), để client đặt nhãn host như
    Paseo (patch 0017). Gateway cắt khoảng trắng hai đầu và chỉ chuyển khi dài 1..253 ký tự, không có
    ký tự điều khiển hay ký tự định dạng như bidi override, zero-width (`hostLabel` trong `policy.js`); nếu không thì bỏ field. Tên máy không phải
    secret nhưng là thông tin host: client nào đã qua xác thực và hello cũng thấy, như Paseo;
  - `capabilities` = capability alpd liệt kê ∩ `{attach.after, prompt.receipts, task, team,
    library, settings.language, session.list.page, question.watch, question.watch.turns,
    session.attention, workspace.files, workspace.files.read, prompt.images, library.project.write,
    workspace.git, attachments}`.
  - `attachmentLimits` khi có `attachments`: giới hạn alpd quảng bá, mỗi số không vượt `ATTACHMENTS`,
    `maxChunkBytes` hạ thêm cho vừa `limits.maxFrame` của gateway (`gatewayAttachmentLimits`, §5.14).
  - Không có `pid` và không bao giờ có `extension.methods`.
  - Trong `library` và `settings.language`, các method ghi trả `-32601 not_exposed` (§5.4).
    `library.get` đọc được, có redaction (§5.4, §5.7).
  - `protocolVersion` khác 1 → `1006 protocol_version` với `supported: [1]`.
  - Request gửi pipelined sau hello sẽ đợi hello xong.
- **Thứ tự kiểm tra** theo §5.2 của contract:
  - frame không phải JSON → `-32700`;
  - batch → `-32600 batch_unsupported`;
  - không phải JSON-RPC 2.0, hoặc method không phải chuỗi → `-32600`;
  - frame không có `method` (là response) → bị bỏ, vì gateway không gửi request nào cho client;
  - notification → bị bỏ, không chạy;
  - id không hợp lệ → `-32600 invalid_id`;
  - params không phải object → `-32602`;
  - chưa hello → `1006 hello_required`;
  - method không biết → `-32601`;
  - method có nhưng không expose → `-32601` với `data.reason: "not_exposed"`;
  - params sai schema v1 → `-32602 invalid_params`;
  - thiếu permission → `1003 grant`;
  - ngoài scope → `1001` hoặc `1003`;
  - các bước trên đều qua thì mới gửi tới alpd.
- **Correlation**: id của client được giữ nguyên trong response. Gateway dùng id riêng của SDK
  với alpd.
- **Thứ tự**: response và event đi chung một hàng đợi có thứ tự. Replay của `session.attach` vẫn
  tới trước response mang `cursor`/`reset` (contract §8.3). Event của một session gateway chưa biết
  sẽ chờ tra scope (`session.get`); trong lúc đó các frame sau nó cũng chờ, nên thứ tự không đổi.
- **Params**: chỉ forward các param có trong bảng (§5). Param lạ bị bỏ, vì alpd v1 vốn bỏ qua
  param lạ, và một nghĩa mới sau này không được tới alpd khi chưa được review. Riêng `spec` thì
  trường lạ **bị từ chối** (§5.3).

## 4. Authentication

### 4.1 Luồng

```
Client                                    Gateway                              alpd
  │ POST /v1/tickets                         │                                   │
  │ Authorization: Bearer alpgw1.<id>.<s>    │ verify hash (constant time)       │
  │ Origin: https://app (browser)            │ origin ∈ allowlist?               │
  │◀── 201 { ticket, subprotocols,           │ ticket: 30 s, một lần, gắn Origin │
  │          websocket, principal }          │                                   │
  │ GET /v1/ws  Upgrade                       │                                   │
  │ Sec-WebSocket-Protocol: alp.v1,           │ Host, TLS, Origin, ticket         │
  │   alp.ticket.<ticket>                     │ → grant; giới hạn connection      │
  │◀── 101, protocol "alp.v1"                 │ connectSocket + hello ───────────▶│
  │ daemon.hello ──────────────────────────▶  │ (đợi hello upstream)              │
```

- **Browser** đặt được `Authorization` trên `fetch`, nhưng không đặt được header tùy ý trên
  WebSocket. Vì vậy ticket đi trong subprotocol, giống `paseo.bearer.*` của Paseo, nhưng là
  ticket ngắn hạn chứ không phải secret dài hạn.
- **React Native và Node**: cùng luồng. Họ thường không gửi `Origin`; ticket xin không có Origin
  thì chỉ mở được WebSocket cũng không có Origin.
- Server chỉ echo `alp.v1`, không bao giờ echo ticket.
- Ticket bị tiêu ngay cả khi lần thử thất bại (Origin sai, hết hạn). Mỗi credential có tối đa
  16 ticket chưa dùng; toàn hệ thống tối đa 1024.
- Response của `POST /v1/tickets`:

```json
{ "ticket": "alpgwt.…", "expiresAt": "…Z", "websocket": "/v1/ws",
  "subprotocols": ["alp.v1", "alp.ticket.alpgwt.…"],
  "principal": { "id": "…", "label": "phone", "permissions": ["session.read", "session.write", "project.read", "project.write"],
                 "workspaces": ["/home/me/project"], "modes": ["read-only"],
                 "workspaceRoots": [{ "path": "/home/me/project", "canonical": "/home/me/project" }] } }
```

`principal.workspaces` cho client biết đường dẫn dùng làm `spec.cwd`. `workspaceRoots` thêm đường
dẫn canonical (`realpath` trên host) của mỗi workspace, để client nhận ra session alpd báo bằng
đường dẫn canonical (Paseo remote, [paseo-remote.md](paseo-remote.md) §3.2). Đây là API HTTP của
gateway, không phải trường mới của Protocol v1.

### 4.2 Credential: cấp, xoay, thu hồi

```sh
alp-gateway credential create --label phone --workspace /home/me/project \
    [--permission session.read] [--permission files.read] [--mode read-only] [--agent <tên-agent>] [--expires-in-days 90] [--json]
alp-gateway credential list
alp-gateway credential reissue <id> [--workspace <absolute>] [--permission <permission>] [--mode <mode>] [--label <label>] [--agent <tên-agent>] [--expires-in-days 90] [--json]
# edit is an alias; retains device id, replaces secret and only the supplied grant fields
alp-gateway credential rotate <id>     # token cũ chết ngay; connection của nó đóng 4401
alp-gateway credential revoke <id>     # vĩnh viễn; connection đóng 4401, ticket bị hủy
```

- Token có dạng `alpgw1.<id 16 hex>.<secret 32 byte base64url>`. Token chỉ in **một lần**; file
  chỉ giữ SHA-256 của secret. Secret có 256 bit ngẫu nhiên nên không cần KDF.
- File `credentials.json` nằm trong `$ALP_GATEWAY_HOME`, mặc định `$ALP_HOME/gateway`:
  - thư mục 0700, file 0600, ghi bằng một lần rename;
  - file mà user khác đọc được, hoặc thuộc user khác → gateway từ chối **mọi** credential
    (fail closed).
- Gateway đang chạy đọc lại file khi nó đổi (poll mỗi giây, hoặc `SIGHUP`):
  - credential bị thu hồi, xoay hoặc hết hạn → đóng connection với 4401;
  - grant đổi (workspace, permission, mode) → đóng với 4403;
  - hạn dùng được kiểm tra lại mỗi 15 giây.
- API thư viện `updateCredential(home, id, { workspaces?, permissions? })` (export từ
  `@anhlp/alp-gateway`) thay workspace và/hoặc permission **tại chỗ, giữ nguyên secret**:
  - token vẫn dùng được, ticket mới mang grant mới;
  - grant thật sự đổi thì connection đang mở đóng với 4403 và ticket chưa dùng bị hủy;
  - input được kiểm tra như lúc tạo (ít nhất một workspace, permission cấp được); input sai hoặc
    credential đã thu hồi → từ chối, file không đổi;
  - giữ id, label, mode, hạn dùng và epoch của principal (`scopeId`); credential cũ chưa có
    `scopeId` thì epoch suy ra từ grant nên cũng đổi. Ghi bằng một lần rename.
- Workspace được `realpath` **lúc cấp credential, trên host, bởi chủ máy**. Grant giữ cả đường
  dẫn đã nhập lẫn đường dẫn canonical.
- Permission cấp được:
  - `session.read`, `session.write`: sessions, câu hỏi, board; kèm `catalog.get`, `library.models`
    và `settings.language.get`;
  - `project.read`, `project.write`: tài nguyên khác của project: tasks, danh sách teams, danh
    sách tên entry của library, và nội dung một entry (`library.get`, chỉ đọc, đã redaction §5.7).
    Ghi instruction project cần quyền riêng `library.write` (policy #118);
  - `library.write`: project-only agents/skills theo policy `project-data`, bao hàm `project.read`;
  - `files.read`: xem danh sách thư mục và đọc nội dung file text của workspace
    (`workspace.files.list`, `workspace.files.read`, §5.10); cùng với `project.read`, xem nội dung
    diff Git (`workspace.git.diff`, §5.13). Trạng thái Git (`workspace.git.status`: nhánh, danh sách
    file thay đổi) chỉ cần `project.read`;
  - `attachments.write`: tải file lên kho attachment của alpd và gửi chúng trong prompt (§5.14). Dùng
    cùng `session.write` (`get` cùng `session.read`); không kéo theo quyền nào, không là mặc định:
    `--permission session.read,session.write,attachments.write`.
  - `session.write` cũng cho phép fork và rewind **hội thoại** của một root (`session.fork` cần thêm
    `session.read` vì nó đọc hội thoại nguồn; §5.15). Không có quyền riêng: cả hai không bao giờ đổi
    file, chỉ đổi hội thoại mà runtime tiếp tục.
    `session.write` cũng cho phép reload một root (`session.reload`: khởi động lại process native trên
    chính hội thoại và cấu hình của nó; §5.16). `session.resumeCommand` (lệnh `alp attach <id>` để copy)
    chỉ cần `session.read`.
    `session.write` cũng cho phép đổi **model và effort** của một root đang sống (`session.configure`
    với `model`/`thinking`, trong các mode của grant; §5.17).
  - `session.team.write`: đổi **team** của một root đang sống (`session.configure { team }`, §5.17).
    Dùng cùng `session.write`; không kéo theo quyền nào, không bao giờ là mặc định:
    `--permission session.read,session.write,session.team.write`.
  - `terminal.exec`: mở **terminal thật** (một shell) trên máy chạy alpd, **với quyền của tài khoản
    chạy alpd**: mọi file tài khoản đó đọc/ghi được, mọi chương trình, mạng (§5.18). Workspace chỉ chọn
    thư mục shell bắt đầu; **không phải sandbox**. Không bao giờ là mặc định, không kéo theo quyền nào và
    không quyền nào kéo theo nó (kể cả `session.write`): `--permission terminal.exec`. alpd còn cần công
    tắc riêng của chủ máy (`alp terminal allow --yes`). CLI in cảnh báo này khi cấp hoặc cấp lại quyền.
  Quyền write kéo theo quyền read cùng họ. `files.read` không kéo theo quyền nào và không quyền nào
  kéo theo nó. Không có `--permission`, CLI cấp bốn quyền `session.*` và `project.*`, **không bao
  giờ** cấp `files.read`: chủ máy phải ghi rõ `--permission files.read` cho từng credential được đọc
  file (ví dụ `--permission session.read,session.write,project.read,files.read`). Dùng `credential reissue`
  để sửa grant giữ device id, và nêu đủ danh sách quyền muốn giữ; `rotate` chỉ thay secret.
  `library.write` cũng cần explicit opt-in, không có trong default grant. Không có permission quản trị host qua remote.
- Credential cho agent (`--agent <tên>`, t-53aa, t-1c59): chủ máy cấp riêng một credential cho client mà một ALP
  agent dùng. Mọi connection của credential đó được gateway đánh dấu `principal.agent` trên chính
  connection alpd của nó **trước khi trả lời hello**, bất kể client khai gì; alpd giữ dấu đó và từ
  chối những việc chỉ người dùng được làm (human gate, đóng task còn gate, `question.answer`,
  terminal; xem "Who decides a human gate" trong `team-workflow.md`). Không đánh dấu được thì gateway
  đóng client (1011, fail closed).
  - Dấu chỉ **bớt** quyền, không thêm: credential không có `--agent` (mọi credential cũ, và credential
    `alp web pair` tạo) vẫn là của người dùng, y như trước; client của nó vẫn có thể tự khai
    `principal.agent`.
  - Một chiều: `reissue --agent` thêm dấu cho credential của người dùng (connection của nó đóng và
    nối lại có dấu); không lệnh nào gỡ dấu, `reissue` với `agent: false` bị từ chối. Cần credential
    cho người dùng thì tạo cái mới.
  - Danh tính theo agent (t-1c59): `--agent <tên>` bắt buộc có tên (chữ thường, số, gạch nối đơn,
    bắt đầu bằng chữ, tối đa 64 ký tự, không phải `true`/`false`). `--agent` trống bị từ chối với thông
    báo rõ và không tạo gì. Gateway gửi tên đó trong hello đánh dấu tới alpd
    (`capabilities: ["principal.agent"], principal: { agent: "<tên>" }`); alpd giữ tên đầu tiên của
    connection và ghi log `ALP_AGENT_CONNECTION` kèm tên, nên log biết **agent nào** đã nối. Tên lấy
    từ credential, không bao giờ từ client: `principal` client gửi qua gateway bị bỏ qua. Tên chỉ là
    nhãn, không cấp thêm quyền; hello có `principal.agent` luôn là của agent.
  - Tên cố định suốt đời credential: `rotate`/`update`/`reissue` giữ nguyên; `reissue --agent <tên>`
    được đặt tên cho credential agent chưa có tên (hoặc đánh dấu credential của người dùng), nhưng không
    đổi tên một credential đã có tên. `credential list` hiện `agent <tên>`.
  - Không tự cấp, không tự hết hạn: chỉ người dùng tạo credential bằng tay; alpd và gateway không bao giờ
    tự phát credential. Không có hạn mặc định; `--expires-in-days` vẫn tùy chọn như trước.
  - Chỉ người dùng quản lý credential: tạo, `rotate`, `reissue`/`edit`, `revoke` chỉ có ở CLI cục bộ;
    gateway và alpd không có RPC nào về credential (connection, agent hay không, gọi `credential.*` nhận
    -32601). CLI từ chối các lệnh đổi credential khi `ALP_AGENT_SESSION` có giá trị (tiến trình do ALP
    agent chạy); `list` vẫn được.
  - Trong file: `"agent": true` và, khi có tên, `"agentName": "<tên>"`. `agent` khác `true`, hoặc
    `agentName` sai dạng hay không có `agent: true` → credential đó không dùng được (fail closed).
    Credential cũ (không dấu, hoặc `agent: true` không tên) giữ nguyên grant, fingerprint và epoch;
    gateway cũ đọc file mới vẫn đánh dấu (bỏ qua tên).
  - Giới hạn (cùng OS user): kiểm tra `ALP_AGENT_SESSION` chỉ chặn tiến trình agent không cố lách; một
    agent chạy cùng OS user có thể xóa biến đó, sửa trực tiếp `credentials.json`, hay đọc token người
    dùng từ nơi client lưu, và vào như người dùng. Socket alpd cục bộ cũng tin `principal.agent` client
    tự khai (chỉ làm bớt quyền). Chỉ tách OS user hoặc sandbox mới chặn được những việc đó.
- Thu hồi khẩn cấp: `credential revoke`. Nếu file credentials hỏng hoặc bị lộ: dừng gateway
  (`systemctl --user stop alp-gateway`). alpd vẫn chạy bình thường.

### 4.3 Bí mật không lọt ra ngoài

- Log dùng logger redaction của `@anhlp/alp-core/log`, thêm một lượt scrub token, ticket và
  subprotocol (`src/log.js`).
- Field log dùng `principal` (id credential), không bao giờ dùng secret.
- Lỗi trả về client không chứa token.
- Cấu hình library có thể chứa secret mà alpd không redact (token trong URL MCP, args, lệnh hook,
  args và `params` của provider). Gateway chỉ chuyển nội dung entry qua `projectLibraryContent`
  (§5.7): field liệt kê mới đi, mọi field có thể chứa secret thành marker `{ "$secret": "keep" }`.
  Các dòng của `library.list`, `team.list`, `library.models` chỉ giữ các field liệt kê trong
  `policy.js`. Test E2E đặt sentinel vào các chỗ đó và kiểm tra không cái nào tới client (§9).
- Test xác nhận log không chứa secret: `apps/gateway/tests/{credentials,gateway}.test.js` và
  `test/integration/gateway.test.js`.
- Proxy không được log header `Authorization` hay `Sec-WebSocket-Protocol` (xem `deploy/`).

## 5. Authorization

### 5.1 Quy tắc

1. **Default deny.** Chỉ method có `status: 'exposed'` trong `apps/gateway/src/policy.js`
   (`MATRIX`) mới được forward. Một capability alpd liệt kê **không** cấp quyền remote.
2. **Workspace**: so khớp **nguyên chuỗi** với đường dẫn đã nhập hoặc đường dẫn canonical của grant.
   - Không so tiền tố.
   - Không `realpath` chuỗi client gửi (tránh oracle filesystem).
   - Thư mục con, `a/`, `a/../a` đều bị từ chối.
   - `spec.cwd` được thay bằng đường dẫn canonical trước khi gửi alpd.
3. **Session**: `session.get` trên chính connection của client, đi ngược `parentId` tới root (tối
   đa 32 cấp).
   - Mọi node trên đường đi phải nằm trong một workspace được cấp.
   - Session ngoài scope trả `1001`, giống id không tồn tại, để không lộ sự tồn tại.
   - Kết quả được cache theo connection; grant đổi thì connection bị đóng. Kiểm tra mode (§5.5)
     không dùng cache: mỗi lần tra lại từ session tới root.
4. **Kết quả**:
   - `session.list` và `question.list` gọi alpd không kèm `projectRoot`, rồi lọc theo grant.
   - `session.list` gửi alpd `projectRoots`: path và canonical của mọi workspace được cấp (chỉ
     workspace `projectRoot` nêu, nếu có), nên trang, cursor và kết quả tìm của alpd không bao giờ
     chạm workspace khác; từng dòng vẫn được kiểm tra như trên. Grant có hơn 1024 chuỗi như vậy thì
     gateway đọc cả danh sách, không phân trang, và tự tìm: alpd không nhận `query`, `limit`, `cursor`.
   - `session.list` có `limit`: gateway đọc các trang của alpd với phần `limit` còn thiếu, tới khi
     đủ trang, alpd hết, hoặc đã đọc 8 trang. Trang client nhận có thể ít hơn `limit` mà vẫn có
     `nextCursor`: chỉ khi không có `nextCursor` mới là hết.
   - `nextCursor` client nhận là cursor của gateway: cursor của alpd (nêu id và `updatedAt` của dòng
     alpd đọc sau cùng, có thể là dòng grant bỏ) được niêm phong bằng AES-256-GCM với khoá của tiến
     trình gateway, gắn với credential. Cursor gateway không cấp cho credential đó (của credential
     khác, của alpd, hoặc từ trước khi gateway khởi động lại) → `-32602`, không tới alpd.
   - Một question `question.watch` mang tới từ session ngoài grant: session đó được nhớ (tối đa
     10 000) để không tra lại, và chỉ log ở mức debug.
   - `question.watch` gọi alpd không kèm `projectRoot` (alpd so chuỗi, mà một workspace có hai
     chuỗi). Kết quả lọc như `question.list`. Sau đó mỗi `question`/`question.resolved` đi qua bộ
     lọc event theo session như mọi event (`E`); một envelope không có `cursor`, thuộc tree mà
     client không attach, chỉ đi ra khi thuộc workspace `projectRoot` đã nêu (không nêu: mọi
     workspace của grant).
   - `question.watch { turns: true }`: gateway chỉ gửi alpd `{ turns: true }`. `turn.ended` của root
     mà alpd mang tới đi qua đúng bộ lọc trên như `question` (session trong grant, workspace đã nêu
     hoặc tree đã attach; session ngoài grant được nhớ, log mức debug).
   - `workspace.files.search` cần `project.read`; `projectRoot` phải khớp nguyên chuỗi một workspace
     được cấp và được thay bằng đường dẫn canonical trước khi gửi alpd. alpd chỉ đọc **tên** file dưới
     đường dẫn thật đó, không đi theo symlink nào (không liệt kê, không đi vào), có giới hạn độ sâu,
     số mục và thời gian (protocol §12.3). Gateway bỏ mọi đường dẫn trả về không phải tương đối thuần
     (tuyệt đối, ổ đĩa, đoạn `.`/`..`/rỗng, NUL) và log `ALP_GATEWAY_FILE_OUT_OF_SCOPE`. Tìm tên
     file vẫn chỉ cần `project.read`; đọc nội dung là `workspace.files.read`, cần `files.read` (§5.10).
     - Rủi ro còn lại: alpd kiểm tra mỗi thư mục trước và sau khi đọc (thư mục thật, không phải
       symlink, đúng đường dẫn thật, cùng device/inode). Một symlink được đổi vào rồi đổi ra giữa hai
       lần kiểm tra, do một tiến trình ghi đang chạy đua bên trong workspace, vẫn có thể lộ **tên**
       file của thư mục mà nó trỏ tới (không lộ nội dung).
     - alpd `realpath` đường dẫn canonical lúc nhận request. Nếu sau khi cấp credential, chính
       workspace (hoặc thư mục cha) bị thay bằng symlink, alpd đi theo đích mới, như mọi method
       dùng `cwd`. Ai đổi được thư mục đó đã có quyền ghi trên host.
   - `question.answer` chỉ nhận **id đầy đủ**. alpd nhận prefix duy nhất, nên một prefix có thể
     khớp câu hỏi ở workspace khác.
   - `session.status`/`session.log` phải trả về đúng tree của root đã kiểm tra, và mọi session
     trong `status` phải thuộc grant; nếu không → `1001` và log `ALP_GATEWAY_TREE_OUT_OF_SCOPE` (§5.6).
   - Dòng của `library.list`, `team.list`, `library.models` chỉ giữ field trong
     `LIBRARY_ROW_FIELDS`, `TEAM_ROW_FIELDS`, `MODEL_ROW_FIELDS`. Field alpd thêm sau này bị bỏ cho
     tới khi được xem xét. `error` của một team thay bằng câu cố định, vì lỗi alpd nêu đường dẫn
     file trên host và trích nội dung file.
5. **Event và replay**: alpd chỉ gửi event của tree mà connection đã attach, và gateway chỉ attach
   tree đã kiểm tra. Ngoài ra mỗi envelope còn được kiểm tra lại:
   - session đã biết → gửi;
   - child mở trong tree đã biết → gửi;
   - còn lại → tra scope. Ngoài scope thì **bỏ** và log `ALP_GATEWAY_EVENT_OUT_OF_SCOPE`. Không
     tra được (alpd lỗi) thì đóng 1011 để client replay lại.
6. **Không tin client**: không nhận đường dẫn ngoài `cwd`/`projectRoot` đã khớp grant, không nhận
   identity do client tự khai, `principal` chỉ lấy từ ticket.
7. Không kiểm chứng được scope → từ chối. Ví dụ: `assignment.recall` nhận `assignmentId`/`taskId`
   mà gateway không thể gắn với workspace trước lời gọi.

### 5.2 Mã lỗi gateway

`1003 forbidden` và `1005 unavailable` là mã chính thức của contract §5.1. alpd dùng chúng cho
`unsafe_path` và `busy`, gateway dùng cho các lần từ chối của chính nó. Client không biết mã thì
coi là `failed`.

| code | `data.reason` | Khi nào |
|---|---|---|
| -32601 | `not_exposed` | method có nhưng không expose qua gateway |
| 1003 | `grant` | credential thiếu permission (`data.permission`) |
| 1003 | `outside_workspace` | `projectRoot`/`spec.cwd` không thuộc grant; `session.create` với id thuộc workspace khác; `session.fork` với `workspaceId`/`newSessionId` ngoài grant, hay alpd trả root mới ngoài grant hoặc ngoài đích đã hỏi (§5.15) |
| 1003 | `host_scope` | `team.list`/`library.list`/`library.get` thiếu `projectRoot` |
| 1003 | `spec_field` | trường `spec` không cho phép (`data.field`); agent/mode/thinking không phải tên đơn giản; `model` sai ngữ pháp model id (§5.3) |
| 1003 | `content_type` | prompt có phần không phải `text`, `image` hay `attachment` (hoặc `attachment` khi alpd không có capability `attachments`) |
| -32602 | `invalid_data` | `attachment.chunk` có dữ liệu giải mã quá `attachmentLimits.maxChunkBytes`; gateway từ chối trước alpd (§5.14) |
| 1003 | `blocked_path` | `workspace.files.list`/`read` hay `workspace.git.diff` với đường dẫn trong block list (`.git`, `.env*`, `.alp`, file khoá/credential); gateway từ chối trước alpd (§5.10, §5.13) |
| -32602 | `invalid_cursor` | `workspace.git.diff` với cursor trang mà connection này không cấp, hoặc cho phép so sánh khác (§5.13) |
| 1003 | `image_limit` | ảnh trong prompt vượt giới hạn của gateway (§5.8; `data` nêu `maxCount`, `maxBytes`, `maxTotalBytes`) |
| 1003 | `not_root` | `session.fork`/`session.rewind` với một session con (assignment): chỉ hội thoại của root được fork hay rewind (§5.15) |
| 1003 | `mode` | grant có `modes` và: create/configure chọn mode ngoài danh sách, create không chọn `spec.mode`, hoặc drive/stop một tree có session chạy mode ngoài danh sách (§5.5; `data.sessionId` là session đó) |
| 1001 | — | session/question ngoài scope (giống không tồn tại); `session.status`/`log` trả tree khác tree đã kiểm tra |
| 1005 | `rate_limited`, `too_many_pending` | vượt giới hạn của connection |
| 1005 | `not_sent` | request chưa rời gateway (bộ đệm ghi tới alpd đầy); alpd chưa nhận, gửi lại an toàn |
| 1000 | `gateway_timeout` | alpd không trả lời trong `requestTimeoutMs`; **kết quả chưa xác định** |
| 1000 | `daemon_disconnected` | mất kết nối alpd trước khi có trả lời; **kết quả chưa xác định** |

Lỗi của chính alpd (`1001`, `1004 key_conflict`/`outcome_unknown`, `persistence_failed`…) được
chuyển nguyên vẹn, trừ các method đọc file của host (§5.7, §5.10) và fork/rewind hội thoại (§5.15):
ở đó chỉ mã và `data.reason` (cùng số liệu an toàn) đi qua, message là câu cố định của gateway.

### 5.3 `session.create` / `session.preview`

- Trường `spec` được phép: `cwd`, `agent`, `model`, `mode`, `thinking`, `persist`, `workflow`. Mọi
  trường khác (`env`, `mcpServers`, `workdir`, `writeRoot`, `copy`, `copyOf`, `restore`,
  `systemPrompt`, `keepThread`, …) → `1003 spec_field`. Một số trường trong đó chạy lệnh trên daemon
  host hoặc chọn đường dẫn. `workflow` (team: `pho`, `cafe`, team của library/project) theo quy tắc
  tên như `agent`; alpd chỉ chọn team đã có, không đọc đường dẫn.
- Không có `sessionId`: **gateway tự đặt** `ses_<16 hex>`, nên event tạo root (có thể tới trước
  response) được biết là trong scope.
- Có `sessionId`:
  - id đã tồn tại trong scope → resume hoặc attach;
  - id đã tồn tại ở workspace khác → `1003 outside_workspace`, alpd không nhận gì;
  - id chưa tồn tại → tạo mới.
  Sau khi tạo, root được kiểm tra lại. Nếu do race nó nằm ngoài scope, gateway `session.release`
  rồi từ chối.
- `model` theo ngữ pháp model id của alpd (`isModelId` trong `policy.js`, đối chiếu
  `packages/runtime/src/resolve.ts`), không theo quy tắc tên agent. Tối đa 256 ký tự:
  - `codex:<id>`, `claude:<id>`, `antigravity:<id>`; `<id>` là ký tự nhìn thấy được, không
    khoảng trắng, không ký tự điều khiển (vd. `claude:claude-opus-4-8[1m]`);
  - `acp:<provider>` hoặc `acp:<provider>/<model>`: `<provider>` là tên file provider
    (`[\w.-]`, không phải `.`/`..`), `<model>` là id provider liệt kê (không khoảng trắng, có thể
    có `/` hoặc `:`);
  - id trần của catalogue (`[A-Za-z0-9][\w.@[\]-]*`).
  Mọi id `library.models` trả về đều qua được (test E2E với provider ACP thật trong library).
  Model id không phải đường dẫn: nó chọn provider theo tên và được chuyển cho provider.
- Grant có `modes`: create phải chọn `spec.mode` trong danh sách, vì mặc định của main là
  `full-access`. Resume root đã lưu dùng `spec.mode` đó; attach root đang chạy không drive gì.
  `configure` chỉ được đặt mode trong danh sách (hạ một session xuống mode được cấp là được phép).
  Prompt, message, answer và stop: xem §5.5.
- Prompt qua gateway chạy agent trên daemon host theo mode của session. Đó là chức năng chính,
  được cấp qua `session.write`. Muốn giới hạn thì cấp `modes`.

### 5.4 Method exposure matrix

Nguồn sự thật là `MATRIX` trong `apps/gateway/src/policy.js`. Test:

- mọi method v1 phải được phân loại;
- mọi method exposed phải có ca vượt scope trong `authorization.test.js`;
- matrix không được mâu thuẫn với `x-alp` của schema khi có (§11).

Cột Test dùng các mã sau:

- `P`: thiếu permission → `1003`, alpd không nhận;
- `S`: vượt scope → từ chối trước alpd;
- `R`: lọc result;
- `E`: lọc event, giữ thứ tự replay;
- `M`: giới hạn mode (§5.5);
- `F`: dòng chỉ giữ field liệt kê;
- `T`: answer phải là đúng tree đã kiểm tra (§5.6);
- `I`: E2E với alpd thật.

| Method | Capability | Resource scope | Permission | Trạng thái | Test |
|---|---|---|---|---|---|
| `daemon.hello` | — | connection | — | gateway tự trả lời | handshake, I |
| `catalog.get` | — | không (catalogue tĩnh) | session.read | exposed | P |
| `session.list` | (`session.list.page` cho `limit`/`cursor`/`query`) | result lọc theo grant; `projectRoot` phải thuộc grant; trang đọc tiếp tới khi đủ | session.read | exposed | P S R I |
| `session.get` | — | session (tree) | session.read | exposed | P S I |
| `session.status` | — | session; answer phải là tree của root đã kiểm tra, mọi session thuộc grant. Có đường dẫn host của tree (§5.6) | session.read | exposed | P S T |
| `session.log` | — | session; answer phải là run log của root đã kiểm tra. Entry có thể nêu đường dẫn host của tree | session.read | exposed | P S T |
| `session.attach` | `attach.after` | session; event/replay lọc | session.read | exposed | P S E I |
| `session.release` | — | session | session.read | exposed | P S |
| `session.preview` | — | `spec.cwd` + allowlist spec | session.read | exposed | P S |
| `question.list` | — | result lọc theo tree | session.read | exposed | P S R |
| `question.watch` | `question.watch` (`question.watch.turns` cho `turns`, `session.attention` cho `attention`) | result (`questions`, `attention`) lọc theo tree; event (`question`, `question.resolved`, `turn.ended` của root, `attention`) lọc theo session, và theo workspace đã nêu; `message` của attention qua safeErrorText như lỗi của `turn.ended` | session.read | exposed | P S R E I |
| `session.attention.clear` | `session.attention` | session; báo đã xem attention của root cho mọi client. Là mutation nhưng chỉ cần session.read: một cái nhìn là đọc, như `session.release` | session.read | exposed | P S |
| `workspace.files.search` | `workspace.files` | `projectRoot` thuộc grant, gửi alpd bản canonical; alpd không đi theo symlink; path trả về phải tương đối thuần | project.read | exposed | P S R I |
| `workspace.files.list` | `workspace.files.read` | `projectRoot` thuộc grant, gửi bản canonical; `path` tương đối thuần, không bị chặn (gateway kiểm tra trước alpd); entry trả về phải là con trực tiếp của `path`, tương đối thuần, không bị chặn; lỗi alpd thay bằng câu cố định (§5.10) | files.read | exposed | P S R I |
| `workspace.files.read` | `workspace.files.read` | như `workspace.files.list`; answer phải đúng `path` đã hỏi và ≤ 1 MiB; lỗi alpd thay bằng câu cố định (§5.10) | files.read | exposed | P S R I |
| `workspace.git.status` | `workspace.git` | `workspaceId` của registry, thư mục khớp nguyên chuỗi grant (kể cả managed worktree); chỉ đọc; answer chiếu theo allow-list, dòng có path không tương đối thuần hay bị chặn bị bỏ và đếm vào `hiddenCount`, remote cục bộ → `null`; lỗi alpd thay bằng câu cố định (§5.13) | project.read | exposed | P S R I |
| `workspace.git.diff` | `workspace.git` | như `workspace.git.status`; `compare` dựng lại từ `mode`, `baseRef`, `ignoreWhitespace`; `path` tương đối thuần, không bị chặn (kiểm tra trước alpd); file quá `WORKSPACE_GIT` → từ chối cả answer; trang cắt cho vừa frame (§5.13) | project.read + files.read | exposed | P S R I |
| `workspace.git.facts` | `workspace.git.facts` (không forward) | host: đường dẫn host bất kỳ, không theo grant; answer chứa đường dẫn host; chỉ owner cục bộ | — | prohibited | -32601 |
| `board.list` | — | `projectRoot` thuộc grant | session.read | exposed | P S |
| `session.create` | — | `spec.cwd` + allowlist; id có sẵn phải trong scope; kiểm lại kết quả | session.write | exposed | P S I |
| `session.prompt` | `prompt.receipts`, `prompt.images`, `attachments` | session; `text`, ảnh inline trong giới hạn §5.8 và attachment chỉ bằng `attachmentId` (cần thêm `attachments.write`; alpd giải theo principal, epoch, project được phép và đúng session; runtime không đọc được (snapshot không có `promptAttachments`) thì `1005 attachment_unsupported`, §5.14); **drive**: mode của session và mọi tổ tiên, tra mới | session.write | exposed | P S M I |
| `attachment.begin` | `attachments` | `sessionId` thuộc grant (tra mới); alpd gắn upload với credential, grant epoch, project canonical (một trong `authorizedRoots`) và session; context principal do gateway đặt, không bao giờ của client; answer chiếu theo allow-list (§5.14) | attachments.write + session.write | exposed | P S R I |
| `attachment.chunk` | `attachments` | upload: alpd kiểm lại binding mỗi chunk, upload của người khác trả như id không tồn tại; dữ liệu ≤ `maxChunkBytes` (gateway kiểm trước alpd) | attachments.write + session.write | exposed | P S I |
| `attachment.commit` | `attachments` | như `attachment.chunk`; alpd kiểm SHA-256 mọi byte rồi mới công bố; answer chiếu `projectAttachment` | attachments.write + session.write | exposed | P S R I |
| `attachment.abort` | `attachments` | như `attachment.chunk` | attachments.write + session.write | exposed | P S |
| `attachment.get` | `attachments` | chỉ attachment của chính credential (alpd kiểm binding); chỉ metadata, không byte, không path | attachments.write + session.read | exposed | P S R I |
| `attachment.delete` | `attachments` | như `attachment.get`; attachment còn được tham chiếu → `1004 attachment_referenced` | attachments.write + session.write | exposed | P S I |
| `terminal.create` | `terminal` | workspace: `workspaceId` của registry mà grant nêu chính xác (tra mới); alpd chọn shell, env, thư mục; gắn terminal với credential, grant epoch và `authorizedRoots`; không pid/đường dẫn trong answer (§5.18) | terminal.exec | exposed | P R B |
| `terminal.list` | `terminal` | chỉ terminal của chính credential, epoch và roots (alpd lọc); `workspaceId` kiểm như create | terminal.exec | exposed | P B |
| `terminal.attach` | `terminal` | terminal của chính credential (alpd kiểm binding); chỉ `terminal.event` của terminal đã attach trên kết nối này, chiếu theo schema | terminal.exec | exposed | P B |
| `terminal.input` | `terminal` | như attach, từ đúng kết nối đã attach; ≤ `maxInputBytes`; không log | terminal.exec | exposed | P B |
| `terminal.resize` | `terminal` | như `terminal.input` | terminal.exec | exposed | P B |
| `terminal.close` | `terminal` | như attach | terminal.exec | exposed | P B |
| `terminal.revoke` | `terminal` | gateway tự gọi khi credential đổi; không bao giờ expose | — | prohibited | — |
| `session.interrupt` | — | session; **stop**: root luôn được; assignment khi mode các requester trong grant | session.write | exposed | P S M I |
| `session.configure` | — (mode); `session.configure.live` (model, thinking, team) | session; mode mới trong grant. Với `model`/`thinking`/`team`: root thuộc grant (tra mới; con → `1003 not_root`), grant có `modes` chỉ đổi root mà cả tree chạy trong các mode đó và mode mà preview nói nó sẽ chạy cũng phải trong đó; `team` cần thêm `session.team.write`; `requestId` theo credential; answer và `configured` được chiếu; lỗi alpd thành câu cố định giữ code, reason và `action` (§5.17) | session.write (team: + session.team.write) | exposed | P S R M I |
| `session.configure.preview` | `session.configure.live` | root thuộc grant (tra mới); chỉ đọc; answer chiếu `projectConfigurePreview` (tên, boolean, số đếm; MCP chỉ tên và loại, không lệnh hay đường dẫn; message cố định theo reason) | session.read | exposed | P S R |
| `session.close` | — | session; **stop** như `interrupt` | session.write | exposed | P S M |
| `session.rename` | — | session | session.write | exposed | P S |
| `session.archive` | — | session | session.write | exposed | P S |
| `session.message` | — | session; **drive** (đánh thức hoặc steer; của assignment thì requester được báo) | session.write | exposed | P S M I |
| `session.fork` | `session.fork` | root nguồn thuộc grant (tra mới; con → `1003 not_root`); `workspaceId` đích là registry workspace mà grant nêu đúng thư mục, không có thì ở workspace của nguồn; `newSessionId` không thuộc workspace khác; context principal do gateway đặt; `requestId` theo credential; root mới được kiểm lại trước khi trả; `forkedFrom` chỉ khi nguồn thuộc grant (§5.15). Không đổi file | session.write + session.read | exposed | P S R I |
| `session.rewind` | `session.rewind` | root thuộc grant (tra mới); chỉ 4 param; cùng session id, không đổi file, các turn sau thành branch phục hồi được bằng `session.fork { branchId }`; answer chiếu (§5.15); `history.reset` tới connection đang attach | session.write | exposed | P S R E |
| `session.reload` | `session.reload` | root thuộc grant (tra mới; con → `1003 not_root`); grant có `modes` chỉ reload root mà cả tree chạy trong các mode đó (như prompt); chỉ 3 param; `requestId` theo credential; answer phải là đúng root đó, chiếu; lỗi alpd thành câu cố định giữ code và reason (§5.16) | session.write | exposed | P S R M |
| `session.resumeCommand` | `session.resumeCommand` | session (root của tree và chính nó) thuộc grant; gateway dựng lại lệnh từ session id (`resumeCommandOf`) và chỉ trả khi alpd trả đúng như vậy: không path, env, credential hay lệnh của runtime native (§5.16) | session.read | exposed | P S R |
| `session.commands` | `session.commands` | session (root của tree và chính nó) thuộc grant; gateway chỉ trả `name`, `description`, `argumentHint`, `kind` của mỗi mục, có giới hạn độ dài và tối đa 1000 mục: không path (t-f628) | session.read | exposed | P S R |
| `question.answer` | — | id đầy đủ, tree trong scope; **drive** session đang hỏi (cả `dismiss`) | session.write | exposed | P S M I |
| `task.list` | `task` | `projectRoot` thuộc grant | project.read | exposed | P S I |
| `task.create` | `task` | `projectRoot`; param danh tính bị bỏ. `requestId` chỉ dedupe trong một process alpd, 10 phút: sau `1000` hoặc restart thì đọc `task.list` trước khi gửi lại | project.write | exposed | P S I |
| `task.update`, `task.gate.resolve` | `task` | `projectRoot`; không idempotent, dùng `ifRev` | project.write | exposed | P S I |
| `team.list` | `team` | `projectRoot` **bắt buộc**; có thêm dòng của layer library/built-in như `session.preview`; `TEAM_ROW_FIELDS`, `error` thay bằng câu cố định | project.read | exposed | P S F I |
| `library.list` | `library` | `projectRoot` **bắt buộc**; `LIBRARY_ROW_FIELDS` (tên, nguồn, mô tả, `usedBy`), gồm cả layer library/built-in; **không có nội dung** | project.read | exposed | P S F I |
| `library.models` | `library` | không (id và nhãn model); `MODEL_ROW_FIELDS` | session.read | exposed | P F I |
| `library.get` | `library` | `projectRoot` **bắt buộc**; entry áp dụng (project, rồi library, rồi built-in), hoặc một `scope`; chỉ đọc. Kết quả: `LIBRARY_ENTRY_FIELDS`, `content` qua `projectLibraryContent`, `secrets` do gateway tính lại (§5.7) | project.read | exposed | P S R I |
| `settings.language.get` | `settings.language` | không (ngôn ngữ người dùng đọc) | session.read | exposed | P I |
| `daemon.status` | — | host (pid, persistence, đếm mọi workspace) | — | denied (dùng `/readyz`) | -32601 |
| `daemon.usage` | — | host; `refresh` spawn probe | — | denied | -32601 |
| `assignment.recall` | — | không kiểm chứng được; gọi model | — | denied | -32601 |
| `daemon.pause`/`resume`/`pauses` | — | host.admin | — | denied | -32601 |
| `daemon.shutdown` | — | host | — | prohibited | -32601 |
| `extension.register`/`unregister` | `extension.methods` | host | — | prohibited | -32601 |
| `library.save`/`delete`/`duplicate`/`rename` | `library.project.write` | project | `library.write` | agents/skills project-only, policy `project-data`; no host/builtin collision, executable config or sidecars | 1003 / 1005 for old daemon |
| `library.skills.set` | `library` | host | — | denied: ghi host | -32601 |
| `settings.language.set` | `settings.language` | host | — | denied: ghi host | -32601 |

### 5.5 Grant có `modes`: drive và stop

Một credential có `modes` chỉ được **drive** tree chạy trong các mode đó. Drive là bắt đầu hoặc
tiếp tục công việc:

| Request | Vì sao là drive |
|---|---|
| `session.prompt` | bắt đầu một turn |
| `session.message` | runtime `post` → `deliver`: đánh thức session rảnh (turn mới), steer turn đang chạy, hoặc trả cho tool đang chờ; của assignment thì requester được báo (`tellRequester`) và có thể chạy tiếp |
| `question.answer` (cả `dismiss`) | turn đang hỏi chạy tiếp |

Quy tắc:

- Gateway tra lại `session.get` **từ session đó tới root**, không dùng cache. Mode do client local
  đổi có hiệu lực ngay.
- Mọi session trên đường đi phải có mode trong `modes`. Runtime giữ mode của assignment không quá
  mode requester (`Child cannot exceed parent permissions`), nên root có mode rộng nhất của tree.
  Một assignment read-only trong tree full-access vẫn bị từ chối, vì message hay answer của nó đánh
  thức requester full-access.
- Supervisor luôn chạy `read-only` (`openSupervisor`), không mở đường nào khác.
- **Stop** (`session.interrupt`, `session.close`): root luôn được dừng, vì không có requester nào
  được báo. Với assignment, các requester (tổ tiên) phải có mode trong grant, vì việc dừng được
  báo cho requester và nó có thể chạy tiếp.
- Không phải drive, không kiểm tra mode: `get`, `list`, `status`, `log`, `attach`, `release`,
  `rename`, `archive`, `preview`, `question.list`, và `session.create` attach vào root đang chạy.
- Từ chối luôn xảy ra **trước** request tới alpd. Test: `apps/gateway/tests/modes.test.js`
  (fake daemon, đếm request) và E2E với alpd thật: message lúc rảnh, lúc steer, prompt, answer và
  dismiss đều bị từ chối, không marker nào tới provider; tree read-only của chính credential thì
  message đánh thức được và answer cho turn chạy tiếp.

### 5.6 Một tree, một workspace; đường dẫn host

- Spec của assignment kế thừa `cwd` của requester (`packages/runtime/src/runtime.ts`,
  `const { restore: _restore, ...inherited } = session.spec`), supervisor cũng vậy, và
  `projectRoot` được suy ra từ `cwd`. `workdir`/`writeRoot` chỉ đổi thư mục làm việc, không đổi
  `projectRoot`. Vì vậy một tree nằm trọn trong một workspace.
- Gateway không dựa hẳn vào điều đó: `session.status` chỉ được trả khi `rootId` là root đã kiểm
  tra và **mọi** session trong đó thuộc grant; `session.log` khi `rootId` là root đó. Sai thì
  `1001` (test `T`).
- Câu trả lời vẫn chứa đường dẫn trên daemon host **của chính tree đó**, schema bắt buộc nên
  gateway không viết lại:
  - `status.sessions[].workdir`: worktree hoặc bản copy của assignment (dưới `$ALP_HOME`), hoặc
    `writeRoot`, có thể nằm ngoài workspace;
  - `status.leases[].checkout`, `status.worktrees[]` (branch, file), `status.claims[]`
    (đường dẫn tương đối hoặc tuyệt đối);
  - entry của `session.log` (run log) có thể có `cwd` và đường dẫn tương tự.
  Credential có `session.read` một workspace thấy được các đường dẫn này. Chúng không chứa
  credential, nhưng lộ bố cục thư mục của host (§10).

### 5.8 Ảnh trong prompt (t-7679.11)

`session.prompt` qua gateway nhận phần `text` và phần `image` **inline** (base64), không gì khác:

- Schema v1 chỉ cho ảnh các trường `type`, `mimeType` (`image/png`, `image/jpeg`, `image/gif`,
  `image/webp`), `data` (base64) và `name`; `path`, `url` hay trường lạ bị từ chối `-32602` trước
  khi tới handler. Phần có type khác (`localImage`, `file`, `resource`…) bị `1003 content_type`.
  Vì vậy client từ xa không thể trỏ tới một file trên host: alpd tự dựng data URL từ `data`.
- Giới hạn của gateway (`GATEWAY_PROMPT_IMAGES` trong `policy.js`), chặt hơn của alpd (8 ảnh,
  5 MiB mỗi ảnh): tối đa **4** ảnh, mỗi ảnh tối đa **2 MiB** sau giải mã, tổng tối đa **2,5 MiB**,
  để dạng base64 vừa frame mặc định 4 MiB (`limits.maxFrame`, §7.3). Với `limits.maxFrame` nhỏ hơn,
  `promptImageLimits(maxFrame)` hạ cả hai mức xuống `(maxFrame − 64 KiB) × 3/4`, nên ảnh trong giới
  hạn không bao giờ bị cắt bởi frame (đóng socket). Vượt thì `1003 image_limit`, không gửi gì tới
  alpd. Kích thước tính từ độ dài base64, không giải mã.
- alpd tự giới hạn 8 ảnh, 5 MiB mỗi ảnh, 11 MiB tổng (vừa `MAX_FRAME` 16 MiB).
- Gateway không ghi nội dung prompt vào log; dữ liệu ảnh chỉ đi qua.
- Capability `prompt.images` được chuyển tiếp; snapshot session mang `promptImages: true` khi
  runtime của nó nhận ảnh (Codex, Claude, ACP có `promptCapabilities.image`). Web app chỉ hiện nút
  đính kèm khi có cờ này.

### 5.7 `library.get`: quyền và redaction

Quyết định của người dùng ngày 2026-10-17 (t-7679.14): web xem được nội dung Library trong Settings
như paseo-web (patch 0015). `project.read` chỉ đọc; project instruction editing cần quyền riêng `library.write` (xem #118 bên dưới).

- **Quyền**: `project.read`, cùng quyền với `library.list` và `team.list`. Ba method này đều đọc
  cấu hình mà session của project sẽ dùng: layer project, rồi library và built-in mà project kế
  thừa (`x-alp` của schema: `scope.kind: project`, `reads: [builtin, library]`). `projectRoot` bắt
  buộc và phải là workspace của grant, nên không có lần đọc "cả library của host" không gắn project.
  Không tạo quyền host-level mới: v1 không có quyền quản trị host qua remote (§4.2). Với `scope`
  (`project` hoặc `library`, được chuyển đi), client đọc được bản của một layer kể cả khi project
  ghi đè nó: tức mọi entry của layer library và built-in, đúng tập mà `library.list` đã cho thấy tên.
- **Lỗi**: lỗi alpd trả cho `library.get` được viết lại, chỉ giữ `code` và `data.reason`: file entry
  không parse được làm alpd báo đường dẫn trên host kèm đoạn trích file (V8 trích nội dung, có thể
  có secret). Không tìm thấy → `No <kind> entry '<name>'`; lỗi khác → `<kind> '<name>' cannot be read
  on the daemon host`. Cùng quy tắc (t-70c4, helper `opaqueDaemonError`) cho các method khác đọc file
  của host: `library.list`, `team.list`, `library.models`, `settings.language.get` viết lại mọi lỗi
  alpd thành message cố định, giữ `code` và `data.reason`. `session.preview`, `session.create`,
  `session.configure` (resolve team, agent, provider từ library) giữ nguyên lỗi có `data.reason` của
  hợp đồng. Lỗi không có reason (exception thô) và reason `invalid_entry`, `unreadable`,
  `unsafe_path`, `persistence_failed` được thay bằng message cố định theo loại (`SESSION_FAULTS`):
  team hoặc agent không có (`... is not available on the daemon host`), file cấu hình team, agent
  hoặc provider không đọc được (`... has a configuration the daemon host cannot read`), CLI chưa cài
  (`The <runtime> CLI is not installed on the daemon host`). Message của alpd chỉ dùng để chọn mẫu;
  tên trong mẫu lấy từ params client gửi (`spec.workflow`, `spec.agent`, `spec.model`) và phải là
  tên đơn giản, nếu không thì bỏ tên. Lỗi khác → `<method> failed on the daemon host; the daemon
  log there may have details`. Đổi lại, client remote mất các message cụ thể khác (ví dụ session
  đã mở). Với mọi method khác, lỗi có một trong bốn reason trên thành `<method> failed on the daemon
  host` (`#errorOf`), vì `persistence_failed` của `session.prompt`, `rename`, `archive` nêu thư mục
  state; kể cả `unsafe_path` của `task.*` vốn chỉ nêu đường dẫn trong workspace (chấp nhận mất message
  đó cho quy tắc đơn giản). `task.list` giữ `unreadable[].file` (đường dẫn tương đối với projectRoot) nhưng `error`
  thành `This task file cannot be read on the daemon host`.
- **Kết quả**: chỉ `kind`, `name`, `source`, `overrides`, `revision` (opaque, HMAC theo tiến trình
  alpd), `usedBy`, `librarySkills` (`LIBRARY_ENTRY_FIELDS`); field khác alpd trả (đường dẫn...) bị
  bỏ. `content` do `projectLibraryContent` dựng lại; `secrets` liệt kê JSON Pointer của mọi giá
  trị đã ẩn, thay danh sách của alpd.
- **Redaction** (allow-list theo kind; field không liệt kê bị bỏ, giá trị sai kiểu bị bỏ):

  | Kind | Đi nguyên | Thành marker `{ "$secret": "keep" }` |
  |---|---|---|
  | `agents` | `instructions` (AGENT.md); `config`: `description`, `provider`, `model`, `thinking`, `mode`, `context`, `autocompact`, `skills`, `mcp`, `hooks` | — |
  | `skills` | `body` (SKILL.md) | — |
  | `mcp` | `server.command` nếu không có khoảng trắng | `server.args[*]`, giá trị `server.env.*`, `server.headers.*` (giữ tên key), `server.url`, `server.cwd`; `command` có khoảng trắng |
  | `hooks` | `hook`: `description`, `event`, `blocking`, `timeoutSec`, `match.agent`, `match.label` | `hook.command` (dòng shell) |
  | `teams` | `team`: `label`, `description`, `main`, `members.*.{role,model,thinking}`, `delegation`, `maxPeers`, `supervisor` (`false` hoặc `{agent,model,thinking}`), `oracleModels`, `oracleThinking`, `modelSetup.{mode,preset}`; `houseRules` | — |
  | `providers` | `provider`: `kind`, `label`, `description`, `enabled`, `readOnlyMode`, `models[*]`/`additionalModels[*]` `{id,label,description}`; `command` nếu không có khoảng trắng | `provider.args[*]`, giá trị `provider.env.*`, `provider.params`; `command` có khoảng trắng |

  Kind gateway không biết trả `content: {}`. `$schema` luôn bị bỏ. URL MCP ẩn cả, vì token có thể
  nằm ở userinfo, query hoặc path (ví dụ URL MCP kiểu `/s/<secret>/mcp`).
- **Còn đi nguyên**: văn bản tự do (`instructions`, `body`, `houseRules`, `description`) và tên
  chương trình (`command` không khoảng trắng, có thể là đường dẫn trên host). Nếu người dùng tự viết
  secret vào các chỗ đó thì client thấy (§10).

### 5.9 Token usage của session (t-7679.12)

- Event `usage` (toàn bộ `SessionUsage` mới nhất: context đã dùng, cửa sổ context, token của phản
  hồi gần nhất, chi phí session nếu runtime có) và trường `usage` trong snapshot session đi qua
  như mọi event/snapshot của session trong grant (lọc `E`/`R` như cũ); gateway không cần đổi code.
  Không có secret, đường dẫn hay dữ liệu tài khoản trong đó (docs/protocol/alp-json-rpc-v1.md §8.5).
- `daemon.usage` và `daemon.status` **vẫn denied**: context meter chỉ cần usage của chính session.
  `daemon.usage` là usage cả tài khoản (mọi workspace, gói, cửa sổ hạn mức) và `refresh` của nó
  khởi chạy probe provider trên host; `daemon.status` mang `pid` và số đếm mọi workspace (§10). Vì
  vậy web không có các thẻ usage tài khoản trong hover card như Paseo.

### 5.10 Đọc file của workspace (t-7679.18)

Anh quyết ngày 2026-10-17: cho web mở file (command center ⌘P, panel Files, link tới file trong chat)
như Paseo, nhưng chỉ đọc, với một quyền riêng.

- **Quyền `files.read`**, không bao giờ cấp mặc định (§4.2). Một token chỉ có các quyền mặc định gọi
  `workspace.files.list`/`read` nhận `1003 grant` (`data.permission: "files.read"`), alpd không nhận
  gì. `workspace.files.search` (tên file) giữ `project.read`.
- **Phạm vi**: `projectRoot` phải khớp nguyên chuỗi một workspace của grant (`outside_workspace`),
  được thay bằng đường dẫn canonical trước khi gửi alpd. `path` phải tương đối thuần (không `/` đầu,
  ổ đĩa, `\`, NUL, đoạn `.`/`..`/rỗng; sai → `-32602 invalid_path`).
- **Block list** (`blockedFilePath` của `@anhlp/alp-protocol`, protocol §12.4): `.git` (thư mục hay
  file), `.alp`, `.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, `.docker`, `gcloud` ở bất kỳ cấp nào;
  tên bắt đầu bằng `.env`, `id_` (khoá SSH với mọi tên: `id_rsa`, `id_work`…) hay `service-account`,
  tên kết thúc bằng `_history` hay `.tfstate.backup`; `token.json`; `.netrc`, `.npmrc`, `.pypirc`, `.pgpass`, `.git-credentials`,
  `.mcp.json`, `auth.json`, `settings.local.json`, `.vault-token`,
  `application_default_credentials.json`, `gh/hosts.yml`…; `credential(s).*`, `secret(s).*` (file
  hay thư mục; trừ file mã nguồn như `src/credentials.ts`, không bao giờ trừ định dạng dữ liệu/cấu
  hình như json, yaml, toml, txt); đuôi `pem`, `key`, `p12`, `pfx`, `p8`, `jks`, `keystore`, `ppk`,
  `der`, `gpg`, `pgp`, `asc`, `kdbx`, `ovpn`, `tfstate`, `tfvars`. So khớp không phân biệt hoa
  thường. Gateway từ chối (`1003 blocked_path`) **trước** alpd, và alpd cũng tự từ chối (hai lớp: một
  alpd cũ hay lỗi vẫn không trả file bị chặn qua gateway). alpd còn từ chối mọi file có nội dung chứa
  private key (header PEM/OpenSSH `-----BEGIN … PRIVATE KEY-----`, khoá PuTTY), bất kể tên, kể cả file
  mã nguồn được miễn. Entry bị chặn mà alpd lỡ trả trong `list` thì gateway bỏ và log
  `ALP_GATEWAY_FILE_OUT_OF_SCOPE`. `.alp` bị chặn vì cấu hình library của project giữ giá trị `env`
  của MCP/provider mà `library.get` trả bản đã redaction (§5.7). Danh sách cố ý chặn thừa một số file
  thường (`id_card.md`, thư mục `secrets/` của mã nguồn, `auth.json` của i18n, AsciiDoc `.asc`).
- **`.gitignore`**: mặc định file/thư mục bị ignore không được liệt kê và bị từ chối
  (`1003 ignored`); client gửi `includeIgnored: true` để xem. alpd hỏi chính Git
  (`git check-ignore --no-index --stdin -z`, một process mỗi request), nên luật đúng như Git. Git chạy
  trong khung hẹp: chỉ lấy `git` từ các mục PATH tuyệt đối và chạy bằng đường dẫn tuyệt đối (không bao
  giờ chạy một `git` nằm trong workspace), argv, không shell, cwd là đường dẫn thật của workspace, tên
  file qua stdin dạng `./<path>` (không bao giờ là tham số hay pathspec magic), bỏ biến `GIT_*` của
  alpd, tắt `core.fsmonitor`, tối đa 4 process cùng lúc (hàng đợi 64), tối đa 2 s rồi kill cả process
  group. Timeout, lỗi, hàng đợi đầy hoặc câu trả lời lạ → coi là bị ignore (fail closed). Không có Git,
  hoặc workspace không có `.git` ở nó hay thư mục cha → không ẩn gì theo `.gitignore`, chỉ còn block
  list (protocol §12.4). Đây là
  mặc định hiển thị, **không phải ranh giới bảo mật**: ranh giới là block list và quyền `files.read`.
- **Chỉ file text, tối đa 1 MiB** (`WORKSPACE_FILES.maxReadBytes`): file lớn hơn → `1000 too_large`,
  file nhị phân hay không phải UTF-8 → `1000 binary`. Gateway kiểm tra lại: answer phải nêu đúng
  `path` đã hỏi, `content` là chuỗi ≤ 1 MiB (đo UTF-8), nếu không thì từ chối `1000`. `size` gateway
  tự tính. `list` tối đa 1000 entry, chỉ giữ `name`, `path`, `kind`, `size`, `modifiedAt`.
- **Không đi theo link** (alpd, protocol §12.4): mọi thư mục trên đường đi phải là thư mục thật, đúng
  đường dẫn thật, cùng device/inode trước và sau khi đọc; file phải là file thường **một tên**
  (`nlink` 1, nên hard link tới file ngoài workspace bị từ chối), mở với `O_NOFOLLOW | O_NONBLOCK`,
  kiểm tra lại qua handle. Vi phạm → `1003 linked`.
- **Lỗi không lộ host** (t-70c4): với mọi lỗi của alpd, chỉ mã và `data.reason` (chuỗi đơn giản) đi
  qua; message là câu cố định của gateway theo reason (`FILE_REFUSALS` trong `connection.js`), lỗi
  không có reason thành câu chung. Không có đường dẫn host hay trích nội dung file trong lỗi.
- **Mối đe doạ còn lại**:
  - Block list là mức sàn: file khác vẫn có thể chứa secret (ví dụ `config/prod.yml`). Vì vậy quyền
    này không mặc định; ai có token `files.read` đọc được mọi file text còn lại của workspace.
  - Một tiến trình ghi chạy đua bên trong workspace (agent, tiến trình của chính user) đổi một thư
    mục trên đường đi thành symlink rồi đổi lại đúng giữa các lần kiểm tra có thể khiến alpd đọc một
    file ngoài workspace (Node không có `openat`). Tiến trình đó vốn đã tự đọc được file ấy; một
    client remote chỉ có `files.read` không tạo được symlink.
  - Nội dung file đi qua TLS như mọi frame; gateway không log nội dung, chỉ log method và thời gian.
  - Git cho `.gitignore` (protocol §12.4): một client có `files.read` có thể chiếm hết 4 slot và hàng
    đợi bằng request chậm (ví dụ `.gitignore` là FIFO, mỗi lần 2 s); khi đó `.gitignore` của các
    request khác fail closed (file bị ẩn, không bao giờ lộ). Nếu alpd chết đúng lúc một git đang bị
    chặn trên FIFO, process đó có thể còn lại (tối đa 4). Workspace nằm ở filesystem khác bên dưới
    một repo (git dừng ở ranh giới filesystem) thì mọi path bị coi là ignore, trừ khi
    `includeIgnored`.

### 5.11 Chi tiết tool call có kiểu (t-7679.13)

- Item `tool_call` giờ có `detail` theo loại: `read`, `edit`, `write`, `search`, `fetch`, `sub_agent`,
  `plan`, `plain_text` bên cạnh `shell` và `unknown` (docs/protocol/alp-json-rpc-v1.md §8.6). Chúng đi
  qua như mọi event của session trong grant: gateway chuyển nguyên envelope (`#event` trong
  `apps/gateway/src/connection.js`, chỉ cho session đã biết thuộc grant hoặc session con của tree
  trong grant), không đổi code, không viết lại hay lọc detail.
- **Cùng loại thông tin đã đi qua trước đây.** Output của `shell` (lệnh agent chạy, kể cả `cat` một
  file), detail `unknown` của tool, và command `Name {json}` của Claude (ví dụ
  `Edit {"file_path":…,"old_string":…,"new_string":…}`) đã mang đường dẫn agent đụng tới, trích đoạn
  file và nội dung sửa. Detail có kiểu mang lại đúng những thứ đó, có cấu trúc: `filePath` (thường là
  đường dẫn tuyệt đối trên host, có thể **ngoài workspace** khi session ở full-access), nội dung tool
  Read trả về, `oldString`/`newString`/`unifiedDiff`, kết quả Grep/Glob, URL và kết quả fetch.
- **Luồng mới, cùng loại.** Item gốc của Codex trước đây bị bỏ, giờ đi qua: `fileChange` (diff của
  file Codex sửa), `webSearch` (câu truy vấn), `mcpToolCall` (input và kết quả của tool MCP, không
  giới hạn kích thước như `unknown`), `collabAgentToolCall` (prompt của sub-agent). Đây là luồng mới
  của cùng loại dữ liệu mà credential có `session.read` vốn đã thấy qua output shell.
- **Không cần `files.read`.** Không file nào được đọc để điền detail: nội dung là những gì chính tool
  đã trả hay được đưa, như output shell. `files.read` (§5.10) vẫn chỉ gác `workspace.files.list`/`read`.
- Không có redaction: gateway không lọc nội dung detail, như không lọc output shell. Giới hạn kích
  thước do runtime đặt (mỗi chuỗi của detail có kiểu ≤ 65.536 ký tự, ≤ 200 đường dẫn, ≤ 50 kết quả
  web); `shell` và `unknown` như cũ.

### 5.12 Text lỗi của runtime, provider và alpd (t-d27c)

Text lỗi của runtime, của provider (CLI Codex/Claude, ACP) và của store alpd có thể nêu đường dẫn
host (EACCES trên `$ALP_HOME/state`, chỗ cài CLI, worktree), kéo theo stack trace hay stderr của CLI,
và trích file không parse được (V8). Gateway áp một quy tắc chung (`safeErrorText`, `safeAlpError`
trong `apps/gateway/src/policy.js`):

- **Giữ**: mã lỗi (số JSON-RPC và `data` như cũ; `code` chuỗi của `AlpError`/`SessionError` nếu là
  định danh đơn giản `[A-Za-z0-9_.-]{1,64}`), và dòng đầu của message.
- **Bỏ**: mọi dòng sau dòng đầu (`\n`, `\r`, U+0085, U+2028/2029: stack, stderr, code frame); các field
  khác của object lỗi; message không phải chuỗi (trừ số, boolean) thành rỗng.
- **Thay**: trích của V8 (`"…" is not valid JSON`) → `"<file content>"`; đường dẫn tuyệt đối trong
  workspace của grant (path hoặc canonical) → tương đối với workspace, chính gốc workspace →
  `<workspace>`, đường dẫn leo ra ngoài bằng `..` → `<host path>`; mọi đường dẫn tuyệt đối khác (POSIX,
  `C:\`/`C:/`, UNC, `~/`, URL `file:` với số `/` bất kỳ và ổ đĩa (`file:` trong câu văn thì không), thư mục home của host gateway) → `<host path>`;
  một đường dẫn được nhận ra khi đứng đầu text hoặc sau khoảng trắng, dấu nháy, ngoặc, `=` `,` `;` `|`
  `:` `@` (vậy `PATH=/a:/b`, `cfg:/x` đều bị thay). URL khác (http, https...) giữ nguyên. Tối đa
  1000 ký tự; text vào bị cắt ở 4000 ký tự trước khi dò.
- Text không có những thứ trên (rate limit, mã HTTP, URL của provider) đi qua nguyên vẹn.

Áp ở đâu (mọi field/event mang text lỗi đi qua gateway):

| Bề mặt | Field |
|---|---|
| Lỗi JSON-RPC của mọi method forward (`#errorOf`), trừ lỗi của gateway và lỗi đã viết lại theo t-70c4 (§5.7) | `error.message` (ví dụ `session.attach` khi đọc timeline lỗi; `session.interrupt`, `close`, `message`, `prompt`... với message thô của runtime) |
| `session.get`, `session.list`, `session.attach`, `session.rename`, `session.archive`, `session.create`, `session.configure` | `session(s).lastError` (`safeAlpError`), `session(s).parked` |
| `session.status` | `status.sessions[].parked` (và `lastError` nếu có); `workdir` vẫn như §5.6 |
| `session.prompt` (receipt) | `error` |
| Event `session.failed`, `prompt.failed`, `turn.ended` (kể cả bản sao không cursor của `question.watch` turns) | `error` |
| Event `session.opened`, `session.updated` | `session.lastError`, `session.parked` |
| Item `notice` | `text` (giữ mọi dòng, chỉ thay đường dẫn) |

Không áp: item `tool_call` (`error`, `detail`) là kết quả tool của agent, cùng loại với output shell
(§5.11); `session.log`, `session.status` (`workdir`, leases, worktrees) như §5.6; `data` của lỗi alpd
(đã xử lý theo reason ở §5.7). Giới hạn: phát hiện đường dẫn dựa trên ký tự, nên đường dẫn ngoài
workspace có khoảng trắng chỉ bị thay tới khoảng trắng đầu (phần sau, một mảnh tên, còn lại) trừ khi
nó nằm dưới home của host; đường dẫn dính liền sau ký tự khác (ví dụ `x#/a`, `a*/b`) không được nhận ra,
để glob và JSON pointer (`src/**/*.ts`, `#/properties/x`) giữ nguyên; trích file dạng khác V8 trên cùng dòng đầu (YAML, TOML) không được nhận ra.
Test sentinel: `apps/gateway/tests/authorization.test.js` (các test `t-d27c`).

### 5.13 Git status và diff của workspace (issue #121, G1)

Phần chỉ đọc của panel Changes/Diff của Paseo (protocol §12.5, capability `workspace.git`). Không có
commit, push, pull, merge, checkout, switch, stash hay thao tác Git nào khác qua remote.

- **Quyền**: `workspace.git.status` (nhánh, upstream, ahead/behind, danh sách file thay đổi, không có
  nội dung) cần `project.read`. `workspace.git.diff` trả hunk, tức nội dung file (cả dòng đã xoá và
  nội dung lịch sử), nên cần **cả** `project.read` và `files.read` (`alsoRequires` trong
  `policy.js`; thiếu cái nào thì `1003 grant` nêu đúng `data.permission` đó, alpd không nhận gì).
  `files.read` không bao giờ là mặc định (§4.2).
- **Phạm vi**: `workspaceId` phải là workspace của registry mà thư mục khớp nguyên chuỗi một grant
  (`#registryWorkspace`, như `workspace.get`; managed worktree của credential được tính). Không có
  hay ngoài grant → `1003 outside_workspace`, method Git không chạy.
- **Params**: schema từ chối key lạ (`-32602`), gateway vẫn chỉ gửi `workspaceId`, `compare`
  (dựng lại từ `mode`, `baseRef`, `ignoreWhitespace`), `path`, `cursor`. `path` kiểm tra như §5.10:
  không tương đối thuần → `-32602 invalid_path`, bị chặn → `1003 blocked_path`, trước alpd.
- **Answer** (`projectGitStatus`, `projectGitDiff` trong `policy.js`): chỉ các field của schema, mỗi
  field kiểm kiểu. Dòng status hay file diff có `path`/`oldPath` không tương đối thuần (tuyệt đối, ổ
  đĩa, `\`, `.`/`..`) hoặc bị chặn bị bỏ, cộng vào `hiddenCount`, log `ALP_GATEWAY_FILE_OUT_OF_SCOPE`;
  khi hỏi một `path`, file không có bên nào là `path` đó cũng bị bỏ. `remoteUrl` chỉ đi qua khi là URL
  http(s)/ssh/git không có user, mật khẩu, query, fragment hoặc dạng `host:path`; đường dẫn cục bộ hay
  `file:` → `null`. Kind khác `text` không mang hunk. Status tối đa `WORKSPACE_GIT.maxStatusFiles` dòng.
- **Kích thước**: nội dung dòng của một file quá `WORKSPACE_GIT.maxFileBytes` (1 MiB), hoặc vượt
  `maxTotalBytes` (2 MiB) của cả trang, → file đó vẫn được liệt kê nhưng thành `too_large`, không có
  hunk (log `ALP_GATEWAY_GIT_OVERSIZE`); alpd đo cùng nội dung đã giải mã nên đây là lớp chặn dự
  phòng. Field sai kiểu → gateway từ chối cả answer (`1000 git_failed`, log `ALP_GATEWAY_GIT_REFUSED`). Để vừa frame của client (`limits.maxFrame`, và nửa `maxBufferedBytes`),
  gateway hạ giới hạn: một trang alpd quá lớn được cắt, phần còn lại tiếp tục bằng cursor của chính
  connection (`alp-gateway-page:…`, tối đa 64 cái, mất khi đóng connection) — gateway hỏi lại alpd
  đúng trang đó và bỏ qua phần đã gửi; snapshot đổi → `1004 stale_snapshot`; cursor không phải của
  connection này hay cho so sánh khác → `-32602 invalid_cursor`. Một file không vừa một frame trả
  `kind: too_large` không hunk (giữ số dòng thêm/xoá). Cursor của alpd đi qua nguyên vẹn.
- **Lỗi**: chỉ mã và `data.reason` (`not_repository`, `unknown_ref`, `invalid_compare`,
  `stale_snapshot`, `invalid_cursor`, `git_unavailable`, `git_failed`…) đi qua; message là câu cố định
  (`GIT_REFUSALS` trong `connection.js`). Không có đường dẫn host hay text Git.
- **Rủi ro còn lại**: diff cho thấy nội dung file đã xoá và lịch sử so với base, mà `workspace.files.read`
  không cho xem; block list vẫn là mức sàn như §5.10. Tên nhánh, upstream và `baseRef` là metadata của
  repo, đi qua như text (không ký tự điều khiển, ≤ 1024 ký tự).
Test: `apps/gateway/tests/git.test.js`.

### 5.14 Attachment không phải ảnh (issue #121, I)

Kho object bất biến của alpd (protocol §12.6, capability `attachments`): client tải file theo chunk
bằng id mờ, rồi gửi `{ type: 'attachment', attachmentId }` trong `session.prompt`. Không có tải
xuống, giải nén, chạy file hay render HTML qua remote.

- **Quyền**: `attachments.write` (không mặc định, không kéo theo gì) **và** `session.write` cho
  `begin`, `chunk`, `commit`, `abort`, `delete`; `attachments.write` và `session.read` cho `get`
  (`alsoRequires`). `get` chỉ trả attachment của chính credential, nên credential không có
  `attachments.write` cũng không có gì để đọc. Prompt có phần `attachment` cần thêm
  `attachments.write` (`1003 grant`, trước alpd). Thiếu quyền → `1003 grant` nêu đúng
  `data.permission`, alpd không nhận gì.
- **Binding**: gateway gửi kèm mọi lời gọi `principalId` (id credential), `principalEpoch` (scope của
  grant: `credential reissue` tạo epoch mới) và `authorizedRoots` (workspace canonical của grant);
  field cùng tên của client bị bỏ (không có trong `params` của matrix). alpd gắn upload với
  principal + epoch, project canonical và session; mỗi `chunk`, `commit`, `get`, `delete` và prompt
  kiểm lại cả binding, và id của principal, epoch, project hay session khác trả **giống hệt** id
  không tồn tại (`1001 not_found`). `begin` còn kiểm session thuộc grant ngay ở gateway (tra mới):
  ngoài grant → `1001` như session không tồn tại.
- **Giới hạn**: `attachmentLimits` trong hello (§3). Chunk quá `maxChunkBytes` giải mã → `-32602
  invalid_data` trước alpd; frame vẫn bị chặn bởi `limits.maxFrame`, rate và `maxPending` như mọi
  request (không buffer vô hạn). Quota (2 upload đang dở, 200 MiB mỗi principal, 1 GiB mỗi daemon,
  tính cả object còn được tham chiếu) do alpd giữ: `1005 quota_exceeded` với `data.limit`.
- **Answer**: `projectUploadBegun`, `projectAttachment` trong `policy.js` chỉ giữ field của schema,
  kiểm từng field (id, tên hiển thị ≤ 255 byte không ký tự điều khiển hay dấu phân cách đường dẫn,
  MIME, kích thước, SHA-256, thời điểm); không bao giờ có đường dẫn host. Field sai → `1000`.
- **Lỗi**: message cố định theo `data.reason` (`ATTACHMENT_REFUSALS` trong `connection.js`); chỉ mã,
  `reason` và số liệu client cần để tiếp tục (`received`, `size`, `max`, `limit`, `maxPerPrompt`,
  `maxPromptBytes`) đi qua. Không đường dẫn kho, không text lỗi hệ thống.
- **Thu hồi giữa chừng**: `credential revoke` (hay `rotate`/`reissue`) đóng connection ngay (4401);
  token cũ không lấy được ticket, nên không chunk hay commit nào nữa tới alpd. Request đã chuyển tới
  alpd trước đó vẫn có thể xong. Upload dở hết hạn sau `uploadTimeoutMs` (1 giờ) và được thu hồi;
  credential reissue là epoch khác nên không tiếp tục được upload cũ: `begin` đầu tiên của một epoch
  khác bỏ ngay các upload dở của epoch trước đó (giải phóng quota). Attachment đã commit của epoch cũ vẫn tính
  vào quota của principal tới khi được thu dọn (không tham chiếu: sau `unreferencedRetentionMs`) hoặc
  được nhả tham chiếu.
- **Runtime** (nhánh J, t-15b0.15): Codex và Claude đọc attachment qua bản sao chỉ-đọc alpd stage
  trong `<ALP_HOME>/state/staged` (snapshot `promptAttachments: ["file.path"]`, alp-json-rpc-v1 §12.6
  *Runtimes*); ACP và Antigravity không đọc được: prompt có attachment bị từ chối thật thà
  `1005 attachment_unsupported` trước khi gửi gì, file vẫn được giữ. `user_message.attachments` chỉ
  mang id, tên hiển thị, kiểu và kích thước; mọi event runtime phát ra hiện thư mục stage là
  `<alp-attachments>`, nên client remote không thấy đường dẫn host của bản sao.
Test: `apps/gateway/tests/attachments.test.js`, `test/integration/gateway.test.js` (alpd thật).

### 5.15 Fork và rewind hội thoại (issue #121, C)

Protocol §12.7, capability `session.fork` và `session.rewind` (gateway chỉ chuyển tiếp capability khi
alpd liệt kê). Cả hai chỉ đổi **hội thoại** mà runtime tiếp tục: **không file nào bị đổi, chép hay
khôi phục**. Rewind giữ nguyên session id; các turn bị bỏ qua thành một branch (`branches[]`), không
bao giờ bị xoá, phục hồi được thành session mới bằng `session.fork { branchId }`.

- **Quyền**: cả hai cần `session.write`; `session.fork` cần thêm `session.read` (`alsoRequires`) vì
  nó đọc hội thoại nguồn. Không có quyền mới (CLI luôn kèm `session.read` với `session.write`; kiểm
  `alsoRequires` là phòng thủ cho file credential sửa tay). Thiếu quyền → `1003 grant` nêu
  `data.permission`, alpd không nhận gì. Grant có `modes` giới hạn fork/rewind như `session.prompt`
  (kiểm **drive**, §5.5): mode của root nguồn và cả tree của nó, tra mới, phải nằm trong `modes` của
  grant, vì cả hai lái hội thoại tương lai của session (fork thừa hưởng cấu hình của nguồn); ngoài đó →
  `1003 mode` trước alpd. Grant `read-only` vì thế không fork hay rewind được một root full-access.
- **Scope nguồn**: `sessionId` phải là **root** thuộc grant, tra mới ở mỗi request. Ngoài grant hay
  không tồn tại → `1001`; session con (assignment) → `1003 not_root`. Cả hai trước alpd.
- **Đích của fork**: không có `workspaceId` thì root mới ở workspace của nguồn. Có `workspaceId` thì
  nó phải là registry workspace mà grant nêu đúng thư mục (như `session.create`, kiểm realpath);
  ngoài grant → `1003 outside_workspace` trước alpd. `newSessionId` đang thuộc workspace khác →
  `1003 outside_workspace` trước alpd (như `session.create` với id có sẵn); `title` chỉ qua schema.
- **Principal**: gateway gửi `principalId`, `principalEpoch`, `authorizedRoots` của chính nó (như
  attachment), không bao giờ của client (field đó của client bị bỏ ở `session.fork`; `session.rewind`
  không có chúng trong schema nên bị `-32602`). alpd cấp lại quyền dùng attachment của nguồn cho
  principal đó (`attachment_forbidden` nếu không được).
- **requestId**: gateway đổi thành `gw:<sha256(credential, requestId)>` như mutation registry: gửi lại
  đúng request thì được kết quả đầu (`duplicate: true`), còn credential khác dùng cùng `requestId` không
  bao giờ nhận kết quả của credential này.
- **Answer của fork**: root mới phải là root (không `parentId`), khác nguồn, thuộc grant và đúng đích
  đã hỏi (và đúng `newSessionId` nếu có); nếu không → `1003 outside_workspace`, gateway ghi log
  `ALP_GATEWAY_FORK_OUT_OF_SCOPE` và không trả gì về root đó (root mới đóng, không attach, nên không
  có gì để release). `forkedFrom` của answer phải nêu đúng nguồn đã kiểm, nếu không → `1000
  outcome_unknown` (đọc lại session trước khi thử lại).
- **Answer của rewind**: `session` phải là đúng root đã kiểm, thuộc grant; `generation` 32 hex;
  `branch` qua `projectBranch`. Sai → `1000 outcome_unknown`.
- **Summary ở mọi nơi** (`session.get/list/attach/create/configure/rename/archive/status`, answer
  fork/rewind, event `session.opened`/`session.updated`, item của `session.history`): `conversation`
  chỉ giữ `fork`, `rewind`, `reason` đã biết; `branches[]` chỉ giữ `branchId`, `beforeTurnId`,
  `turns`, `at` (mục sai bị bỏ); `forkedFrom` chỉ giữ field của schema và **chỉ khi session nguồn
  thuộc grant**: gateway tra nguồn (một lần mỗi connection, nhớ cả kết quả ngoài grant); nguồn ngoài
  grant, đã xoá hay không tra được → **bỏ cả field** (không bao giờ lộ id session ngoài grant; bỏ
  thay vì từ chối để fork do client local tạo từ workspace khác vẫn xem được). Event cần tra nguồn
  giữ chỗ trong hàng đợi nên thứ tự event không đổi.
- **`history.reset`**: event live `{ type: 'history.reset', generation, reason: 'rewind', branchId }`
  không có cursor, alpd chỉ gửi tới connection đang attach root; gateway chuyển nguyên vẹn sau kiểm
  scope như mọi event. Client bỏ history đã cache, tải tail mới và attach lại với `generation` mới.
- **Lỗi**: message cố định theo `data.reason` (`CONVERSATION_REFUSALS` trong `connection.js`:
  `session_busy`, `stale_generation`, `turn_not_found`, `turn_in_progress`, `empty_prefix`,
  `boundary_unmapped`, `runtime_unsupported`, `native_refused`, `branch_not_found`,
  `attachment_forbidden`, `key_conflict`, `outcome_unknown`, `workspace_mismatch`…; reason lạ giữ
  reason với câu chung). Chỉ mã, `reason`, `generation` (32 hex) và số nguyên không âm đi qua; không
  text của alpd hay runtime (đường dẫn thread native, stderr của CLI).
Test: `apps/gateway/tests/conversation.test.js`.

### 5.16 Reload agent và lệnh resume (issue #121, G2)

`session.reload { sessionId, requestId, ifGeneration }` (docs/protocol/alp-json-rpc-v1.md §12.8) khởi
động lại process native của một root trên **chính hội thoại** nó đang chạy, với cấu hình của nó, cùng
session id; timeline, history generation, receipt và viewer không đổi. Gateway: cần `session.write`; root
thuộc grant, tra mới mỗi lần (session con → `1003 not_root`); grant giới hạn `modes` chỉ reload root mà
cả tree nằm trong các mode đó, như `session.prompt` (`1003 mode`); `requestId` được namespace theo
credential như fork/rewind; answer phải là đúng root đó, được chiếu như mọi summary (`conversation.reload`
đi qua `projectConversation`). Lỗi của alpd (`session_busy`, `session_closed`, `no_history`,
`native_refused`, `runtime_unsupported`, `stale_generation`, `outcome_unknown`…) tới client thành câu cố
định của gateway giữ code và reason: không stderr, đường dẫn hay thread id nào của runtime lọt ra.

`session.resumeCommand { sessionId }` trả `{ argv, posix, windows, display, platform }` của lệnh
`alp attach <sessionId>`; chỉ để copy vào clipboard, client không bao giờ chạy nó. Cần `session.read`,
session trong grant. Gateway dựng lại lệnh từ session id đã kiểm (`resumeCommandOf` của
`@anhlp/alp-protocol`, theo `platform` mà alpd trả, chỉ `posix` hoặc `windows`) và chỉ trả khi câu trả lời
của alpd đúng y như vậy; khác đi (lệnh `codex resume`/`claude --resume`, thêm `env`, `ALP_HOME`, đường
dẫn) là `1000`, có log `ALP_GATEWAY_RESUME_COMMAND_REFUSED`. Lệnh không mang `ALP_HOME`: host có alpd chạy
với home khác thì người dùng tự đặt home đó khi chạy.

### 5.17 Đổi model, effort hoặc team của phiên đang sống (issue #121, D)

`session.configure { sessionId, model?, thinking?, team?, mode?, requestId, ifGeneration }`
(docs/protocol/alp-json-rpc-v1.md §12.9, capability `session.configure.live`) đổi cấu hình của một root
**ở ranh giới idle của cả cây**, bằng cách khởi động lại process native **trên chính hội thoại**, cùng
session id; alpd chỉ ghi cấu hình mới sau khi runtime đã nhận (Codex phải trả lại đúng model), nếu không
thì giữ cấu hình cũ và trả `1005 native_refused`. Không bao giờ chuyển sang runtime khác
(`1005 runtime_mismatch`, `data.action: "session.create"`: tạo phiên mới) và không bao giờ thêm quyền
(`1003 permission_escalation`: mode vượt profile hoặc cao hơn, hook hay MCP stdio mới).

Gateway:
- `model`/`thinking`: cần `session.write`; root thuộc grant, tra mới mỗi lần (con → `1003 not_root`);
  grant giới hạn `modes` chỉ đổi root mà cả tree chạy trong các mode đó, như `session.prompt`
  (`1003 mode`), và gateway hỏi `session.configure.preview` trước: mode mà alpd sẽ chạy sau thay đổi
  cũng phải thuộc grant, nên một thay đổi không bao giờ đưa session ra ngoài credential.
- `team`: cần thêm `session.team.write` (opt-in, không mặc định, không kéo theo quyền nào; thiếu →
  `1003 grant` nêu `permission`), trước khi alpd biết tới request. Team chỉ là **id** của team mà host
  định nghĩa (built-in, library, project); client không gửi được đường dẫn hay cấu hình nào.
- `requestId` được namespace theo credential như fork/rewind/reload; param lạ bị bỏ, không tới alpd.
- Answer phải là đúng root đó; summary chiếu như mọi summary (`conversation.configure` qua
  `projectConversation`), `configured` qua `projectConfigured` (`effective`: tên, boolean, số đếm; MCP
  chỉ `{ name, kind }`, không lệnh, đường dẫn hay instruction).
- Lỗi alpd (`session_busy`, `session_closed`, `runtime_mismatch`, `agent_mismatch`,
  `permission_escalation`, `team_not_found`, `native_refused`, `stale_generation`, `key_conflict`,
  `outcome_unknown`…) tới client thành câu cố định giữ code, reason và `action: "session.create"`.

`session.configure.preview { sessionId, model?, thinking?, team?, mode? }` chỉ đọc, cần `session.read`,
root thuộc grant: trả cấu hình hiện tại và cấu hình sau thay đổi, những gì đổi, có phải khởi động lại
không, alpd có nhận **bây giờ** không và vì sao, cùng danh sách team; message là câu cố định theo
reason. `session.configure` chỉ đổi mode thì giữ nguyên hành vi cũ (§5.x bảng trên).

### 5.18 Terminal (issue #121, H)

Quyết định của người dùng (2026-10-20): terminal chạy trên host **như tài khoản chạy alpd**, chỉ bật khi
**cả hai** điều kiện: chủ máy bật `allowRemoteTerminal` (mặc định tắt) **và** credential có quyền riêng
`terminal.exec`. **Cwd không phải sandbox**; quyền này không bao giờ suy ra từ `session.write`.
Contract: docs/protocol/alp-json-rpc-v1.md §12.10.

- **Công tắc của chủ máy**: `<ALP_HOME>/terminal.json` `{ "version": 1, "allowRemoteTerminal": true }`,
  file thường của chính user chạy alpd, không có quyền group/other (không thì coi như tắt). Ghi bằng
  `alp terminal allow --yes` (in rõ quyền mà nó cấp), tắt bằng `alp terminal deny`; `alp terminal status`.
  Không RPC nào sửa nó, backup không mang nó. alpd đọc lại ít nhất mỗi 5 giây: tắt → mọi terminal bị
  kết thúc (`exit` reason `disabled`). Chỉ khi bật (macOS, Linux qua native owner; Windows best-effort qua `node-pty`/ConPTY khi module nạp được) alpd mới
  liệt kê capability `terminal` và `terminalLimits`; gateway chuyển tiếp chúng.
- **Quyền**: mọi method `terminal.*` cần `terminal.exec` (thiếu → `1003 grant`, trước alpd).
  `terminal.create` và `terminal.list { workspaceId }` cần workspace registry mà grant nêu chính xác (tra
  mới, `1003 outside_workspace`). Client không gửi được shell, lệnh, args, env, cwd hay pid (schema từ
  chối); principal context (`principalId`, `principalEpoch`, `authorizedRoots`) do gateway đặt, thứ client
  gửi bị bỏ. alpd gắn terminal với credential, grant epoch và workspace; terminal của người khác, epoch
  khác hay ngoài roots đều trả `1001 not_found` như id không tồn tại.
- **Luồng**: `terminal.attach` phát lại output (`terminal.event`) trước câu trả lời; gateway chỉ chuyển
  `terminal.event` của terminal mà chính kết nối này đã attach, chiếu theo schema (`projectTerminalEvent`),
  trong cùng hàng đợi có thứ tự. `terminal.input` ≤ `maxInputBytes` (gateway kiểm trước alpd), chỉ từ kết
  nối đã attach; không bao giờ ghi log. Output event ≤ `maxOutputFrameBytes`, hạ xuống cho vừa frame.
  Client chậm: gateway đóng 4431, alpd tách luồng; client attach lại với `after` = seq cuối và thấy `gap`
  nếu ring 1 MiB đã trôi. Mất kết nối: terminal chạy tiếp 60 giây chờ attach lại của cùng credential và
  epoch; input không bao giờ phát lại.
- **Thu hồi**: credential bị thu hồi, xoay, hết hạn **hoặc đổi grant** → gateway đóng kết nối và gọi
  `terminal.revoke { principalId }` trên kết nối riêng của nó tới alpd: mọi terminal của credential bị
  kết thúc ngay, cả cây process (process group, job nền, process double-fork còn giữ terminal). Nếu lúc
  đó không hỏi được alpd, alpd tự kết thúc chúng khi hết 60 giây chờ attach lại. `terminal.revoke`
  không bao giờ được expose cho client.
- **Giới hạn** (`TERMINAL`, alpd quảng bá `terminalLimits`; chủ máy hạ được trong `terminal.json` `limits`,
  gateway chỉ hạ): 4 terminal mỗi credential, 16 mỗi daemon, input 64 KiB mỗi lần, output 64 KiB mỗi
  event, ring phát lại 1 MiB, 30 phút không hoạt động, tối đa 8 giờ, 60 giây chờ attach lại.
- **Audit**: alpd ghi vòng đời (`ALPD_TERMINAL_CREATED/ATTACHED/DETACHED/ENDED/REVOKED`) với credential,
  terminal id và workspace id; không bao giờ ghi phím gõ, output hay env.
- **Paseo app**: thiết bị Paseo ghép qua relay là owner và không có `terminal.exec`, nên bridge chỉ mở
  terminal khi `terminal.json` có thêm `"allowPaseoTerminal": true` (`alp terminal allow --paseo --yes`).
- **Không hỗ trợ**: Windows (capability không bao giờ được liệt kê); chụp màn hình phía server, đổi tên
  terminal, lệnh hay profile do client chọn.

## 6. Streaming và recovery

### 6.1 Thuật toán client (theo contract §8.3)

- Giữ cursor cuối của mỗi root, lấy từ envelope có `cursor`.
- Khi reconnect: lấy ticket mới, `daemon.hello`, rồi `session.attach { sessionId, after: last }`.
- Buffer event của root trong lúc attach chờ trả lời.
- `reset: true` → xóa projection rồi áp dụng buffer.
- `1001` khi attach → tree đã mất; bỏ cache, không tạo lại.
- Gateway không có event store: replay luôn là replay của alpd.

### 6.2 Sự cố

| Sự cố | Điều xảy ra | Client làm gì |
|---|---|---|
| Client mất mạng hoặc tự đóng | Gateway đóng connection IPC của client. alpd detach: root bận vẫn chạy; root rảnh không ai xem thì được **đóng** (vẫn resume được), **không hủy** gì | Reconnect, attach `after` |
| Client chậm đọc | Đóng `4431`; client khác không bị ảnh hưởng | Reconnect, attach `after` |
| Gateway restart (`1001`) | Mọi connection IPC đóng như trên. Session và event vẫn ở alpd | Reconnect (ticket mới), attach `after` |
| alpd restart hoặc mất (`4503`) | Request đang chờ trả `1000 daemon_disconnected`, sau đó đóng 4503. `/readyz` → 503 | Backoff, reconnect. Root đã đóng thì `session.create { sessionId, resume: true }` |
| Credential bị thu hồi/xoay/hết hạn (`4401`) hoặc đổi grant (`4403`) | Đóng ngay; ticket bị hủy | Xin ticket mới; bị 401 thì dừng |

- **Không retry mutation**: gateway và SDK không bao giờ gửi lại request.
  - `gateway_timeout` hoặc `daemon_disconnected` = kết quả chưa xác định. Client đọc state
    (`session.get`, timeline) trước khi gửi lại.
  - `session.prompt` an toàn khi gửi lại với **cùng** `clientMessageId` và cùng nội dung, khi có
    `prompt.receipts`.
  - Request hủy phía client (timeout/abort của SDK) không hủy trên alpd. Muốn dừng thì gọi
    `session.interrupt`.

### 6.3 Close codes

| Code | Nghĩa | Retry? |
|---|---|---|
| 1001 | gateway tắt | có, backoff |
| 1009 | message vượt `maxFrame` | không, lỗi client |
| 1011 | không kiểm tra được event | có, attach `after` |
| 4003 | message binary | không |
| 4401 | credential thu hồi/xoay/hết hạn | xin ticket mới; 401 thì dừng |
| 4403 | grant đổi | xin ticket mới |
| 4408 | không có `daemon.hello` trong `handshakeMs` | có |
| 4429 | tiếp tục gửi sau khi đã bị rate limit | có, chậm lại |
| 4431 | client đọc chậm (slow consumer) | có, attach `after` |
| 4503 | không kết nối được hoặc mất alpd | có, backoff |

Upgrade bị từ chối trả HTTP (không có WebSocket):

- `400`: thiếu `alp.v1`;
- `401`: ticket sai, đã dùng hoặc hết hạn;
- `403`: Origin, hoặc không phải TLS;
- `421`: Host lạ;
- `429`: quá nhiều lần auth sai, hoặc quá số connection của credential;
- `503`: quá `maxConnections` hoặc gateway đang tắt.

## 7. Triển khai và vận hành

### 7.1 Mặc định an toàn

- Bind `127.0.0.1:7434`.
- Bind địa chỉ không phải loopback mà không có TLS → **từ chối khởi động**, trừ khi có
  `allowInsecure`.
- Request đi từ ngoài loopback mà không qua TLS (trực tiếp, hoặc qua proxy tin cậy với
  `X-Forwarded-Proto: https`) → `403 tls_required`.
- **Host** phải nằm trong `hosts` hoặc là dạng loopback với đúng port (chống DNS rebinding).
- **Origin**: không có Origin (Node, RN) → được phép. Có Origin → phải nằm trong `origins`
  (khớp tuyệt đối, chỉ gồm scheme, host và port).
- Gateway không tự deploy, không sửa cấu hình máy và không khởi động alpd.
- `alp web` không dùng gateway này: service `alp-web` của CLI chạy gateway nhúng riêng trên
  `127.0.0.1:<web.port>` (mặc định 7433), cùng origin với app, với kho credential riêng
  `<home>/web/credentials.json`. `alp-gateway credential list/create/revoke` (đọc `<home>/gateway`)
  không thấy credential đó; thay token của nó bằng `alp web rotate` ([web.md](web.md) §3.1).

### 7.2 Đường TLS chính: reverse proxy

`apps/gateway/deploy/Caddyfile` (chính) hoặc `nginx.conf`. Caddy lấy chứng chỉ tự động, giữ
`Host`, đặt `X-Forwarded-For`/`-Proto`, proxy WebSocket không đặt read timeout, và **không log
header**.

`gateway.json` (xem `deploy/gateway.example.json`):

```json
{ "host": "127.0.0.1", "port": 7434, "hosts": ["alp.example.com"],
  "origins": ["https://app.example.com"], "trustProxy": ["127.0.0.1", "::1"] }
```

- `trustProxy`: chỉ khi peer TCP nằm trong danh sách này thì `X-Forwarded-For`,
  `X-Forwarded-Proto` và `X-Forwarded-Host` mới có hiệu lực. Địa chỉ client được lấy từ phần tử
  `X-Forwarded-For` ngoài cùng bên phải không thuộc `trustProxy`.
- Proxy phải đặt `X-Forwarded-Proto` và giữ Host. Request qua proxy mà không phải `https` → 403.

**TLS trực tiếp** (phương án phụ): `alp-gateway serve --host 0.0.0.0 --tls-cert cert.pem --tls-key
key.pem --public-host alp.example.com:7434`. Chủ máy tự gia hạn chứng chỉ; gateway đọc chứng chỉ
lúc khởi động.

Chạy như dịch vụ user: `deploy/alp-gateway.service` (systemd `--user`; `ExecReload` gửi `SIGHUP`).

### 7.3 Giới hạn (`limits` trong config)

| Khóa | Mặc định | Vượt thì |
|---|---|---|
| `maxFrame` | 4 MiB (≤ `MAX_FRAME`) | đóng 1009 |
| `maxConnections` / `maxConnectionsPerCredential` | 64 / 8 | HTTP 503 / 429 |
| `maxPending` (mỗi connection) | 32 | `1005 too_many_pending` |
| `rate` / `burst` (request/giây) | 20 / 40 | `1005 rate_limited`; sau `maxStrikes` (100) lần bị từ chối **liên tiếp** thì đóng 4429 |
| `handshakeMs` | 10 s | đóng 4408 |
| `requestTimeoutMs` | 120 s | `1000 gateway_timeout` (kết quả chưa xác định) |
| `maxBufferedBytes` / `maxQueue` | 8 MiB / 10 000 frame | đóng 4431 |
| `heartbeatMs` | 30 s ping; không có pong thì terminate | — |
| `ticketTtlMs` | 30 s | 401 |
| `authFailures` / `authWindowMs` | 20 lần / 5 phút cho mỗi địa chỉ | 429 kèm `Retry-After` |

Mỗi client có hàng đợi riêng và connection IPC riêng, nên một client chậm hoặc lỗi không chặn
client khác (có test).

### 7.4 Health, readiness, log

- `GET /healthz` → `200 {"live":true}` khi process sống.
- `GET /readyz` → `200` chỉ khi connection monitor riêng (SDK `createReconnectingClient`) nói
  chuyện được với alpd **và** `daemon.status.health.ready` là true. Ngược lại trả `503` với
  `checks[0].code`:
  - `ALP_GATEWAY_DAEMON_UNREACHABLE`;
  - `ALP_GATEWAY_DAEMON_NOT_READY`;
  - `ALP_GATEWAY_STARTING`.
  Không trả pid hay chi tiết nội bộ.
- `createGateway({ …, serveStatic })` (tùy chọn): hook `(request, response)` trả lời `GET`/`HEAD`
  cho path **ngoài** các route của gateway (`/healthz`, `/readyz`, `/v1` và mọi path dưới `/v1/`
  không bao giờ tới hook), **sau** kiểm tra Host và TLS như mọi route. Hook tự ghi response; trả
  `false` mà chưa ghi → `404`, ném lỗi → `500` (log `ALP_GATEWAY_STATIC_FAILED`). Không có hook thì
  path lạ vẫn là `404`.
- Log là JSON trên stderr, `component: "alp-gateway"`, mỗi connection có field `connection`,
  `principal` và `ip`. Các code chính:
  - `ALP_GATEWAY_LISTENING`, `ALP_GATEWAY_CONNECTED`, `ALP_GATEWAY_DISCONNECTED` (kèm `closeCode`);
  - `ALP_GATEWAY_AUTH_FAILED`, `ALP_GATEWAY_UPGRADE_REFUSED`, `ALP_GATEWAY_TICKET`;
  - `ALP_GATEWAY_CREDENTIAL_CHANGED`, `ALP_GATEWAY_CREDENTIALS_UNREADABLE`;
  - `ALP_GATEWAY_DAEMON_UNAVAILABLE`, `ALP_GATEWAY_DAEMON_DISCONNECTED`;
  - `ALP_GATEWAY_SLOW_CONSUMER`, `ALP_GATEWAY_EVENT_OUT_OF_SCOPE`, `ALP_GATEWAY_CREATE_OUT_OF_SCOPE`,
    `ALP_GATEWAY_TREE_OUT_OF_SCOPE`.
  `ALP_LOG_LEVEL=debug` thêm một dòng cho mỗi request (method, ms), không bao giờ có params.

## 8. Tích hợp client (Paseo, browser, RN, Node)

```js
import { createReconnectingClient, hello } from '@anhlp/alp-client/portable';
import { connectWebSocket } from '@anhlp/alp-client/websocket';

const base = 'https://alp.example.com';
const cursors = new Map();                         // root → cursor cuối
class Unauthorized extends Error {}
async function open() {
  const response = await fetch(`${base}/v1/tickets`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  if (response.status === 401) throw new Unauthorized('credential no longer valid');   // dừng, hỏi lại người dùng
  if (response.status !== 201) throw new Error(`ticket refused: ${response.status}`);   // 429/503: thử lại sau
  const { websocket, subprotocols } = await response.json();
  return connectWebSocket(`${base.replace(/^http/, 'ws')}${websocket}`, { protocols: subprotocols });
}
const alp = createReconnectingClient({
  connect: open,
  onConnect: async client => {
    await hello(client, { name: 'paseo', version });
    for (const [sessionId, after] of cursors) {
      const { reset } = await client.request('session.attach', { sessionId, after });
      if (reset) cursors.set(sessionId, 0);       // xóa projection của root đó
    }
  },
  // Sau 4401/4403 helper kết nối lại; lần xin ticket kế tiếp trả 401 nếu credential đã chết.
  shouldRetry: error => !(error instanceof Unauthorized),
});
alp.onEvent(envelope => { /* áp dụng; nếu envelope.cursor có thì cập nhật cursor của root */ });
```

- Node: dùng `ws` (`connectWebSocket(url, { WebSocket, protocols })`) và `fetch` của Node (Node 22.12+ hoặc 24 với các package beta).
  RN: WebSocket và fetch có sẵn.
- Lưu token ở keychain/secure storage, không lưu trong URL hay localStorage chung.
- Tạo session: `spec.cwd` là một trong `principal.workspaces`. Chỉ đặt `cwd`, `agent`, `model`,
  `mode`, `thinking`, `persist`, `workflow`. `model` lấy từ `library.models` hoặc `catalog.get`.
- `principal.modes` có giá trị: chỉ hiện nút prompt/message/answer cho tree mà mọi session trong
  đó chạy các mode này; gateway từ chối phần còn lại với `1003 mode`.
- Prompt: luôn có `clientMessageId` duy nhất. Gặp `1000 gateway_timeout`/`daemon_disconnected`
  thì gửi lại **cùng** id và nội dung (alpd trả kết quả đầu với `duplicate: true`), hoặc đọc
  timeline trước.
- Không gọi `daemon.status`; dùng `/readyz` nếu cần.

## 9. Kiểm thử

| Bộ test | Chạy bằng | Nội dung |
|---|---|---|
| `apps/gateway/tests/credentials.test.js` | `npm test --workspace=@anhlp/alp-gateway`; lane core | hash, token in một lần, xoay/thu hồi/hết hạn, file không private → fail closed, ticket một lần/TTL/Origin, log không có secret |
| `apps/gateway/tests/gateway.test.js` | như trên (fake daemon) | healthz/readyz theo alpd, ticket flow, CORS, Host/DNS rebinding, proxy tin cậy, chặn bind không TLS, các kiểm tra §5.2, binary 4003, quá lớn 1009, hello timeout 4408, rate/pending, slow consumer 4431 không ảnh hưởng client khác, hai client đồng thời, revoke/rotate 4401, mất alpd 4503 + request chờ `daemon_disconnected` không gửi lại, alpd không chạy, tắt gateway 1001 không hủy gì |
| `apps/gateway/tests/authorization.test.js` | như trên | matrix đủ, mọi method không expose → -32601 không tới alpd (kể cả ghi library), credential thiếu permission → 1003 `grant` cho **mọi** method ngoài quyền của nó, **mọi method expose có ca vượt scope** (không tới alpd), tasks/teams/library trong project, host scope bị chặn, param danh tính bị bỏ, đường dẫn chỉ khớp tuyệt đối, param lạ bị bỏ, lọc list, `question.answer` không nhận prefix, allowlist spec và tên agent, ngữ pháp model id (ACP `acp:<provider>/<model>`, id có `[1m]`; id sai bị từ chối), gateway đặt id root, race create ngoài scope → release, chỉ prompt text, giới hạn mode khi create/configure, lọc event có giữ thứ tự, replay đứng trước response attach, đối chiếu `x-alp`; `library.get` qua `projectLibraryContent` cho cả sáu kind (sentinel ở mọi field có thể chứa secret, field lạ, kiểu sai, pointer cần escape, kind lạ), kết quả chỉ giữ `LIBRARY_ENTRY_FIELDS`, param lạ bị bỏ, các method ghi library → -32601 không tới alpd; `hostname` của hello qua `hostLabel` (ký tự điều khiển, quá dài → bỏ); dòng library/team/model chỉ giữ field liệt kê, lỗi team không nêu đường dẫn; `session.status`/`log` trả tree khác → 1001 |
| `apps/gateway/tests/conversation.test.js` | như trên (fake daemon) | `session.fork`/`session.rewind`: matrix và capability; thiếu `session.write`/`session.read` → 1003 trước alpd; nguồn ngoài grant, session con, đích và `newSessionId` ngoài grant, param lạ → từ chối trước alpd; context principal và `requestId` của gateway thắng của client; root mới ngoài grant/đích, nguồn khác → không trả; `forkedFrom` có nguồn ngoài grant bị bỏ trong get/list/event/history (giữ thứ tự event); `branches`/`conversation` chiếu; `history.reset` tới connection attach nguyên vẹn; lỗi alpd thành câu cố định; grant `modes` chỉ fork/rewind được root có tree chạy trong đó, tra mới (`1003 mode` trước alpd) |
| `apps/gateway/tests/modes.test.js` | như trên | grant `read-only`: prompt, message, answer, dismiss một session full-access → `1003 mode` trước alpd; assignment read-only trong tree full-access cũng bị từ chối; mode đổi bởi client local có hiệu lực ngay (tra lại tới root); trong grant thì drive được; credential không có `modes` không bị giới hạn; dừng root luôn được, dừng assignment của requester full-access bị từ chối; get/status/log/attach/rename/archive/release không bị giới hạn; hạ mode bằng configure được, nâng thì không |
| `test/integration/gateway.test.js` | `node scripts/test.mjs integration`; lane paseo | **alpd thật + fake Codex** qua SDK WebSocket: handshake, create, prompt, stream; client rớt mà turn vẫn chạy; gateway restart trong lúc turn kết thúc → nhận `turn.ended` bằng replay; alpd restart → 4503, readyz 503→200, resume và prompt tiếp; cursor 1..n không trùng, không thiếu, không reset; mỗi prompt tới provider đúng một lần; credential khác không thấy, attach, prompt hay nhận event; event `usage` và `session.get().session.usage` tới đúng credential của session, credential khác không nhận, `daemon.usage` vẫn -32601; `task.create/list/update`, `team.list`, `settings.language.get` qua gateway; hello có `hostname` = `os.hostname()`; credential khác không đọc/ghi được tasks của project; `library.get` của built-in `main` đọc được, projectRoot ngoài grant → 1003; `library.save` without `library.write` → 1003 grant; revoke → 4401. **Mode**: credential `read-only`, session full-access do client local tạo: message lúc rảnh (wake), lúc turn chạy (steer), prompt, answer và dismiss một câu hỏi `alp_ask` thật đều → `1003 mode`, câu hỏi vẫn chờ, không marker nào tới provider; dừng root vẫn được; tree read-only của chính nó thì message đánh thức (marker tới provider) và answer cho turn chạy tiếp. **Secret**: MCP (userinfo, query, header, args, env), hook và provider có sentinel; alpd trả chúng cho client local, còn credential `project.read` qua gateway: `library.get` trả các field đó là marker (nội dung đúng từng field), `library.list` (5 kind), `team.list`, `library.models` không chứa sentinel hay đường dẫn library; model `acp:custom/vendor-model` từ `library.models` qua được `session.preview` |
| `scripts/gateway-smoke.mjs` | `npm run test:gateway:smoke`; lane packages | cài từ tarball protocol/core/client/gateway vào project rỗng, **không có Paseo hay React**; chạy `alp-gateway` đã cài với alpd thật: credential, serve, readyz, ticket, create và prompt, `task.create`/`task.list` qua SDK đã cài, `daemon.shutdown` bị chặn, log không có token |
| `tsconfig.gateway.json` | lane core | type-check JSDoc (`// @ts-check`) của `apps/gateway/src` |

## 10. Giới hạn đã biết

- Một alpd của một OS user. Gateway phải chạy cùng user đó (socket 0600).
- Workspace = project root, khớp tuyệt đối. Thư mục con trong project hoặc monorepo nhiều project
  cần cấp từng project. Cũng chưa có chính sách đường dẫn client ↔ daemon cho Paseo desktop
  (09A §6.3).
- Disconnect làm alpd đóng root rảnh không ai xem (hành vi sẵn có của alpd). Client cần
  `session.create { resume: true }` trước khi prompt lại. Gateway không giữ connection hộ client.
- `daemon.status` không expose: result schema bắt buộc có `pid` và các con số trải qua mọi
  workspace. Muốn bản rút gọn cần contract riêng.
- **Đọc file qua remote chỉ đọc, chỉ text ≤ 1 MiB, cần `files.read`** (§5.10): không có sửa, tạo,
  xoá, tải file nhị phân hay xem ảnh. Block list là mức sàn, không bảo đảm file còn lại không có
  secret. `workspace.files.search`, `list` và `read` đều hỏi Git (`--no-index`:
  file đã track mà khớp luật cũng bị ẩn).
- **Git qua remote chỉ đọc** (§5.13): status với `project.read`, diff với `project.read` +
  `files.read`. Không có commit/push/pull/merge/switch; cursor trang mà gateway tự cắt chỉ sống trong
  một connection.
- **Fork/rewind qua remote** (§5.15): chỉ hội thoại của root, không bao giờ file; `forkedFrom` của
  fork có nguồn ngoài grant bị bỏ hẳn. Mỗi lần nguồn được tra là một `session.get` tới alpd (một lần
  mỗi connection cho mỗi nguồn).
- **Attachment qua remote** (§5.14): chỉ tải lên, xem metadata và xoá file của chính credential;
  không tải xuống. Codex và Claude đọc được attachment (nhánh J); ACP và Antigravity trả
  `attachment_unsupported`. Thu hồi credential không huỷ request đã chuyển tới alpd trước đó.
- **Nội dung library qua remote là bản đã redaction ở gateway** (§5.7), không phải contract của
  daemon: alpd vẫn chỉ redact giá trị `env`/`headers` (`x-alp.redacts`). Gateway không đoán secret
  bằng heuristic; nó ẩn cả field (mọi `args`, cả URL MCP, cả lệnh hook), nên client không thấy
  phần vô hại của các field đó. Văn bản tự do (`instructions`, `body`, `houseRules`,
  `description`) và tên chương trình (`command` không khoảng trắng, có thể là đường dẫn trên host)
  đi nguyên: secret người dùng tự viết vào đó sẽ tới client. Một field mới của core chỉ tới client
  sau khi được thêm vào `LIBRARY_CONTENT` trong `policy.js`.
- Ghi instruction project cần explicit `library.write` và daemon `library.project.write` (#118):
  agents/skills project-only thuần dữ liệu, không executable references, sidecars hoặc host fallback.
  Marker secret không được chấp nhận trong nội dung ghi của policy này.
- `library.list` và `team.list` vẫn trả tên, mô tả, source và `usedBy` của layer library và
  built-in của host, như `session.preview`. Mô tả là chữ người dùng tự viết trong file cấu hình;
  gateway không lọc nội dung của nó. Muốn chặt hơn thì lọc theo `source` ở gateway.
- **Đường dẫn host trong `session.status`/`session.log`** (§5.6): `workdir`, `leases[].checkout`,
  worktree, claims và entry run log nêu đường dẫn trên daemon host của tree đó. Schema bắt buộc
  `workdir`/`checkout`, nên gateway không viết lại. Không phải credential, nhưng lộ bố cục thư mục.
  Muốn ẩn cần contract cho phép (vd. đường dẫn tương đối với workspace).
- **Mode grant** (§5.5) là tập mode, không phải bậc: grant `["workspace-write"]` không drive được
  tree read-only. Mỗi lần drive/stop tốn thêm một `session.get` cho mỗi cấp của tree (tối đa 32).
  Gateway không xét nội dung message/answer, chỉ xét mode.
- `project.*` và `session.*` là hai họ quyền thô. Chưa có quyền theo từng task hay theo kind
  library.
- Task không có event trong v1. Client poll `task.list` và so `revision`.
- Ticket nằm trong bộ nhớ, nên gateway restart làm mất ticket chưa dùng. Client xin ticket mới;
  ticket chỉ sống 30 giây.
- Chưa đo trên Hermes/thiết bị RN thật, cũng chưa chạy Caddy/nginx thật trong CI. Hai file
  `deploy/` là mẫu: cú pháp Caddy đã đối chiếu tài liệu Caddy, nginx chưa chạy.
- Windows: chưa thử. SDK kết nối được named pipe, nhưng test E2E dùng fake Codex là script Node
  nên bị bỏ qua trên Windows, và chưa có lane Windows nào chạy gateway.
- Không có rate limit toàn cục theo credential cho request, chỉ có rate limit theo connection
  nhân với tối đa 8 connection.

## 11. Checklist tích hợp cho 09B-2 (Paseo thin client)

09B-2 đã làm theo checklist này: [paseo-remote.md](paseo-remote.md) (ma trận hoàn thành, giới hạn).

1. Đã merge: `feat/remote-gateway` (PR #95, `3b472a3`). Bản sửa sau review
   (`fix/gateway-review-findings`): mode drive/stop, chặn `library.get`, allowlist field của dòng,
   ngữ pháp model id, kiểm tra tree của `status`/`log`. File chung khi gateway vào main:
   - root `package.json` (workspace `apps/gateway`, script `test:gateway:smoke`);
   - `package-lock.json` (entry `apps/gateway` và link `node_modules/@anhlp/alp-gateway`);
   - `scripts/test-lib.mjs` (`packages`, `locations`, `buildAll` build gateway);
   - `scripts/build-workspace.mjs` (`locations`);
   - `scripts/check-boundaries.mjs` (`@anhlp/alp-gateway` → client/core/protocol);
   - `scripts/validate.mjs` (tsc gateway ở lane core, `gateway-smoke` ở lane packages);
   - file mới `tsconfig.gateway.json`.
   CI không cần sửa: các lane đã gọi `validate:*`.
2. 09B-1 đã được tích hợp:
   - `team.list`, `task.*`, `library.list/models`, `settings.language.get` đã expose, có test
     authorization, test fake và E2E với alpd thật;
   - `library.get` ban đầu bị chặn; từ t-7679.14 đọc được với `project.read`, qua redaction của
     gateway (§5.7);
   - project-only agents/skills CRUD có qua `library.write` + `library.project.write`;
     host `library.skills.set` và `settings.language.set` vẫn bị chặn;
   - test `x-alp` chạy trên schema thật.
3. Muốn expose thêm method, sửa `policy.js`:
   - `status: 'exposed'`, permission, params, scope;
   - handler trong `connection.js` (`#workspace`/`#project` cho `projectRoot`);
   - thêm ca vào `OUT_OF_SCOPE` và `IN_SCOPE` của `authorization.test.js`.
   #118 expose project-only agents/skills với authoritative policy `project-data`;
   teams/mcp/hooks/providers và executable reference vẫn là quản trị.
4. Phía Paseo:
   - thay `readLock`/`connect` bằng luồng §8;
   - lưu token an toàn;
   - đọc `principal.workspaces` cho `spec.cwd` và `projectRoot`;
   - map `alp.tasks.*` → `task.*`, team models → `team.list` + `library.models`, ngôn ngữ →
     `settings.language.get`;
   - màn Library qua remote: danh sách (`library.list`) và nội dung đã redaction (`library.get`,
     §5.7), chỉ đọc. Plugin Paseo ở remote mode mở nội dung JSON chỉ đọc qua `alp.library.get`; không có form sửa hoặc Test;
   - với `principal.modes`: chỉ bật prompt/message/answer cho tree trong các mode đó (§5.5); xử lý
     `1003 mode` (`data.sessionId`);
   - xử lý close code §6.3;
   - theo dõi cursor theo root;
   - `resume: true` sau 4503.
5. Daemon (ngoài gateway): contract redaction cho `library.get` (URL userinfo/query, `args`,
   `command`, hook, provider) nếu cần sửa entry từ xa (gateway hiện tự redaction để xem, §5.7); contract đường dẫn tương đối
   cho `session.status` nếu cần ẩn bố cục host.
6. Task 06: quyết định có đưa `principal` vào `daemon.hello` không. Gateway hiện trả principal qua
   `POST /v1/tickets`.
7. Triển khai thật (người dùng tự làm):
   - tạo `gateway.json`;
   - chạy Caddy/nginx theo `deploy/`;
   - `alp-gateway credential create`;
   - bật `alp-gateway.service`;
   - kiểm tra `curl https://alp.example.com/readyz`.


### #118: grant reissue, project instruction writes, negotiated images and ignored search

`credential reissue <id>` (`edit` alias) retains `id` and `createdAt`, rotates the secret and
persists the replacement grant atomically. Supplied workspace/permission/mode lists replace
whole lists; omitted fields retain their values. A revoked credential cannot be restored.
Old tokens, outstanding tickets and active connections lose authorization when the running gateway
reloads (default poll 1 second, same as rotation). Install the newly printed token on the device.
For example, grant file access while retaining session/project writes with
`alp-gateway credential reissue <id> --permission session.write,project.write,files.read`.

`library.write` is opt-in, absent from default grants and never implied by `project.write`.
It implies `project.read` so the client can inspect entries, never `files.read`.
Gateway mutations require daemon capability `library.project.write`; older daemons get no
mutation (1005). The gateway requires project scope and a granted canonical projectRoot,
and injects `policy: project-data` independently of client input.

The authoritative core preflight, inside the daemon's mutation queue, supports save/delete/duplicate/
rename for **project-only agents and skills**. Skills accept `{body}`; agents accept
`{instructions, config?}`, with only description/model/thinking/context/autocompact configuration.
Models must be explicit `codex:<id>` or `claude:<id>`. Provider/mode/skills/MCP/hooks references and
unknown fields are refused. Source and target cannot collide with library/built-in names, so writes
cannot shadow or reveal host fallback configuration. Existing entries must contain only regular
AGENT.md/agent.json or SKILL.md files: no sidecars, links or hardlinks. This also guards an
instruction-only save over unsafe existing content. Revisions, in-use and destination collision checks
still apply. MCP/hooks/providers/teams, known-projects sync, host `library.skills.set` (role-skills.json)
and administrative settings remain denied. Instruction text carries **prompt authority** over future
agents; this policy excludes automatically executable configuration, not instructions asking agents
to use tools. Preflight shares the existing safe-path boundary: it does not sandbox malicious
concurrent same-user processes. Settings exposes a project JSON instruction editor with create,
save, duplicate, rename and delete only for an opted-in credential and capable daemon. Inherited
entries remain read-only; unsafe entries fail with an error rather than silently losing fields.

Gateway `daemon.hello` optionally returns
`promptImageLimits: {maxCount,maxBytes,maxTotalBytes}` when it advertises `prompt.images`.
These limits come from `promptImageLimits(limits.maxFrame)`; bytes are decoded bytes. Web uses them
for reads, attachment merges, sends and retries, refreshing on reconnect. An older peer without this
field retains compatible defaults when it advertises the image capability. Malformed offers or no
capability disable image admission. Frames smaller than 64 KiB advertise zero byte limits.

Search uses shared hardened `gitIgnored` in one batch per BFS level, prunes ignored directories
before descent and filters before ranking/limit under the existing 3-second deadline. IgnoreUnknown
returns an empty truncated list, never partial unverified names. Truly missing Git or a true nonrepo
retain the existing fallback; a resolved binary that fails to spawn, diagnostics and inconsistent
exit/output fail closed. Silent clean exit1 remains Git's valid 'none ignored' result.

### Scheduled continuations exposure

| Methods | Exposure | Reason |
|---|---|---|
| `schedule.create`, `schedule.list`, `schedule.get`, `schedule.cancel` | prohibited | local daemon jobs can wake a future session; no remote scheduling grant in v1 |

See [scheduled continuations](schedules.md) for the local CLI and main tool.

### Registry and shared pins (`workspace.registry`)

`project.list`, `workspace.list` and `workspace.get` require `project.read`. Registering a project,
unregistering it or updating a workspace requires **explicit `workspace.write`**. This permission
is absent from defaults; `project.write` does not imply it. For example the owner can issue a
credential with `--workspace /existing/project --permission session.read,session.write,project.read,workspace.write`.
To use another directory, the owner first changes the credential's local grants. The web Add project
picker only offers granted directories; no remote method browses parents, creates directories or
expands grants. Missing permission is explained in the web UI.

The gateway checks exact canonical existing directory grants, including each workspace's own
directory (a legacy workspace can differ from its project's root). Retargeted grant links fail
closed. Lists filter before pagination and counts. Mutations reauthorize before durable replay;
request IDs are namespaced to the credential. Removing a project checks archived workspace
directories too, changes metadata only, and an identical retry can address the removed record.
Responses project only reviewed metadata; owner canonical/placement/receipt data and host storage
errors never pass through. `registry.owner` is prohibited.

Pins are daemon metadata shared across browser contexts, observed by the normal sidebar refresh
and retained after daemon restart. A pin is shown as saved only after the mutation succeeds.
A CAS conflict asks the client to refresh and retry; transport uncertainty is never silently retried.
