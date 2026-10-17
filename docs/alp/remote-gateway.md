# ALP remote gateway (Task 08)

> **Trạng thái beta `0.0.0-beta.1`: deferred.** `@anhlp/alp-gateway` không phát hành trong beta
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
    workspace.files}`.
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
    [--permission session.read] [--mode read-only] [--expires-in-days 90] [--json]
alp-gateway credential list
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
- Workspace được `realpath` **lúc cấp credential, trên host, bởi chủ máy**. Grant giữ cả đường
  dẫn đã nhập lẫn đường dẫn canonical.
- Permission cấp được:
  - `session.read`, `session.write`: sessions, câu hỏi, board; kèm `catalog.get`, `library.models`
    và `settings.language.get`;
  - `project.read`, `project.write`: tài nguyên khác của project: tasks, danh sách teams, danh
    sách tên entry của library, và nội dung một entry (`library.get`, chỉ đọc, đã redaction §5.7).
    Ghi library không có qua remote (§5.4).
  Quyền write kéo theo quyền read cùng họ. CLI mặc định cấp cả bốn. Không có permission quản trị
  host qua remote.
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
     (tuyệt đối, ổ đĩa, đoạn `.`/`..`/rỗng, NUL) và log `ALP_GATEWAY_FILE_OUT_OF_SCOPE`. Chỉ có tìm
     tên file: **không có method đọc nội dung file** (§10).
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
| 1003 | `outside_workspace` | `projectRoot`/`spec.cwd` không thuộc grant; `session.create` với id thuộc workspace khác |
| 1003 | `host_scope` | `team.list`/`library.list`/`library.get` thiếu `projectRoot` |
| 1003 | `spec_field` | trường `spec` không cho phép (`data.field`); agent/mode/thinking không phải tên đơn giản; `model` sai ngữ pháp model id (§5.3) |
| 1003 | `content_type` | prompt có phần không phải `text` hay `image` |
| 1003 | `image_limit` | ảnh trong prompt vượt giới hạn của gateway (§5.8; `data` nêu `maxCount`, `maxBytes`, `maxTotalBytes`) |
| 1003 | `mode` | grant có `modes` và: create/configure chọn mode ngoài danh sách, create không chọn `spec.mode`, hoặc drive/stop một tree có session chạy mode ngoài danh sách (§5.5; `data.sessionId` là session đó) |
| 1001 | — | session/question ngoài scope (giống không tồn tại); `session.status`/`log` trả tree khác tree đã kiểm tra |
| 1005 | `rate_limited`, `too_many_pending` | vượt giới hạn của connection |
| 1005 | `not_sent` | request chưa rời gateway (bộ đệm ghi tới alpd đầy); alpd chưa nhận, gửi lại an toàn |
| 1000 | `gateway_timeout` | alpd không trả lời trong `requestTimeoutMs`; **kết quả chưa xác định** |
| 1000 | `daemon_disconnected` | mất kết nối alpd trước khi có trả lời; **kết quả chưa xác định** |

Lỗi của chính alpd (`1001`, `1004 key_conflict`/`outcome_unknown`, `persistence_failed`…) được
chuyển nguyên vẹn.

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
| `question.watch` | `question.watch` (`question.watch.turns` cho `turns`) | result lọc theo tree; event (`question`, `question.resolved`, `turn.ended` của root) lọc theo session, và theo workspace đã nêu | session.read | exposed | P S R E I |
| `workspace.files.search` | `workspace.files` | `projectRoot` thuộc grant, gửi alpd bản canonical; alpd không đi theo symlink; path trả về phải tương đối thuần | project.read | exposed | P S R I |
| `board.list` | — | `projectRoot` thuộc grant | session.read | exposed | P S |
| `session.create` | — | `spec.cwd` + allowlist; id có sẵn phải trong scope; kiểm lại kết quả | session.write | exposed | P S I |
| `session.prompt` | `prompt.receipts`, `prompt.images` | session; `text` và ảnh inline trong giới hạn §5.8; **drive**: mode của session và mọi tổ tiên, tra mới | session.write | exposed | P S M I |
| `session.interrupt` | — | session; **stop**: root luôn được; assignment khi mode các requester trong grant | session.write | exposed | P S M I |
| `session.configure` | — | session; mode mới trong grant | session.write | exposed | P S M |
| `session.close` | — | session; **stop** như `interrupt` | session.write | exposed | P S M |
| `session.rename` | — | session | session.write | exposed | P S |
| `session.archive` | — | session | session.write | exposed | P S |
| `session.message` | — | session; **drive** (đánh thức hoặc steer; của assignment thì requester được báo) | session.write | exposed | P S M I |
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
| `library.save`/`delete`/`duplicate`/`rename` | `library` | library-or-project | — | denied: cấu hình lệnh chạy trên daemon host (mcp, hooks, providers, agents tham chiếu chúng); `sync` ghi mọi project | -32601 |
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
như paseo-web (patch 0015), chỉ đọc; `library.save` và các method ghi vẫn bị chặn, sẽ cần một quyền
riêng (backlog).

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
| `apps/gateway/tests/modes.test.js` | như trên | grant `read-only`: prompt, message, answer, dismiss một session full-access → `1003 mode` trước alpd; assignment read-only trong tree full-access cũng bị từ chối; mode đổi bởi client local có hiệu lực ngay (tra lại tới root); trong grant thì drive được; credential không có `modes` không bị giới hạn; dừng root luôn được, dừng assignment của requester full-access bị từ chối; get/status/log/attach/rename/archive/release không bị giới hạn; hạ mode bằng configure được, nâng thì không |
| `test/integration/gateway.test.js` | `node scripts/test.mjs integration`; lane paseo | **alpd thật + fake Codex** qua SDK WebSocket: handshake, create, prompt, stream; client rớt mà turn vẫn chạy; gateway restart trong lúc turn kết thúc → nhận `turn.ended` bằng replay; alpd restart → 4503, readyz 503→200, resume và prompt tiếp; cursor 1..n không trùng, không thiếu, không reset; mỗi prompt tới provider đúng một lần; credential khác không thấy, attach, prompt hay nhận event; `task.create/list/update`, `team.list`, `settings.language.get` qua gateway; hello có `hostname` = `os.hostname()`; credential khác không đọc/ghi được tasks của project; `library.get` của built-in `main` đọc được, projectRoot ngoài grant → 1003; `library.save` → -32601; revoke → 4401. **Mode**: credential `read-only`, session full-access do client local tạo: message lúc rảnh (wake), lúc turn chạy (steer), prompt, answer và dismiss một câu hỏi `alp_ask` thật đều → `1003 mode`, câu hỏi vẫn chờ, không marker nào tới provider; dừng root vẫn được; tree read-only của chính nó thì message đánh thức (marker tới provider) và answer cho turn chạy tiếp. **Secret**: MCP (userinfo, query, header, args, env), hook và provider có sentinel; alpd trả chúng cho client local, còn credential `project.read` qua gateway: `library.get` trả các field đó là marker (nội dung đúng từng field), `library.list` (5 kind), `team.list`, `library.models` không chứa sentinel hay đường dẫn library; model `acp:custom/vendor-model` từ `library.models` qua được `session.preview` |
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
- **Đọc nội dung file của workspace qua remote chưa có** (chờ anh quyết định). Chỉ có
  `workspace.files.search` (tên file, `project.read`). Đọc nội dung sẽ cho một token `project.read`
  đọc mọi file của workspace (`.env`, khoá, cấu hình), nhiều hơn những gì token đó thấy hôm nay
  (task, team, tên và nội dung đã redaction của entry library). Mở cần chọn: quyền riêng (ví dụ `files.read`) hay `project.read`;
  có chặn file ẩn/`.env`/file bị gitignore không; giới hạn kích thước và loại file (text). Cũng chưa
  có `.gitignore` trong tìm kiếm (alpd không chạy git cho việc này).
- **Nội dung library qua remote là bản đã redaction ở gateway** (§5.7), không phải contract của
  daemon: alpd vẫn chỉ redact giá trị `env`/`headers` (`x-alp.redacts`). Gateway không đoán secret
  bằng heuristic; nó ẩn cả field (mọi `args`, cả URL MCP, cả lệnh hook), nên client không thấy
  phần vô hại của các field đó. Văn bản tự do (`instructions`, `body`, `houseRules`,
  `description`) và tên chương trình (`command` không khoảng trắng, có thể là đường dẫn trên host)
  đi nguyên: secret người dùng tự viết vào đó sẽ tới client. Một field mới của core chỉ tới client
  sau khi được thêm vào `LIBRARY_CONTENT` trong `policy.js`.
- Ghi library qua remote chưa có (người dùng quyết ngày 2026-10-17: cần một quyền riêng, để
  backlog): chưa có chính sách tách thay đổi project-scope không thực thi (skills, teams không
  sync, agents không tham chiếu mcp/hooks/provider) khỏi phần còn lại. Marker trong `content` của
  `library.get` vì vậy chưa có nghĩa "giữ giá trị cũ" qua remote.
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
   - các method ghi library, `library.skills.set` và `settings.language.set` vẫn bị chặn;
   - test `x-alp` chạy trên schema thật.
3. Muốn expose thêm method, sửa `policy.js`:
   - `status: 'exposed'`, permission, params, scope;
   - handler trong `connection.js` (`#workspace`/`#project` cho `projectRoot`);
   - thêm ca vào `OUT_OF_SCOPE` và `IN_SCOPE` của `authorization.test.js`.
   Ứng viên tiếp theo: `library.save` cho `scope: project` với kind `skills` và `teams` không có
   `sync`, sau khi có quyết định chính sách. Agents/mcp/hooks/providers vẫn là quản trị.
4. Phía Paseo:
   - thay `readLock`/`connect` bằng luồng §8;
   - lưu token an toàn;
   - đọc `principal.workspaces` cho `spec.cwd` và `projectRoot`;
   - map `alp.tasks.*` → `task.*`, team models → `team.list` + `library.models`, ngôn ngữ →
     `settings.language.get`;
   - màn Library qua remote: danh sách (`library.list`) và nội dung đã redaction (`library.get`,
     §5.7), chỉ đọc. Plugin Paseo ở remote mode hiện vẫn tự từ chối `alp.library.get`;
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
