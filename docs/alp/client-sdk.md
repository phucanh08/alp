# ALP client SDK: portable client, transports và tương thích Node

> **Trạng thái beta `0.0.1-beta.3`:** `@anhlp/alp-client` phát hành trong beta. Entry
> `@anhlp/alp-client/portable` và `/websocket` (browser, React Native) là **experimental**: không
> nằm trong acceptance gate, smoke browser/Metro/tarball chưa vào CI. React Native trên Hermes hoặc
> thiết bị thật: deferred. Kết quả ở §7 là bằng chứng lịch sử (2026-10-15, Node 26.3), không chạy
> trên bản beta. Phạm vi: [beta-scope.md](beta-scope.md) §4, §5.

Task 07 (Cross-platform Client SDK). Tách RPC client của alpd khỏi Node để Browser, React
Native và Node dùng chung một engine qua transport interface. CLI, alpd và plugin Paseo vẫn
dùng API Node cũ, không phải sửa consumer.

Wire contract vẫn là contract hiện tại (`PROTOCOL_VERSION = 1`, ALPD §3). Task 06 chưa có
artifact nào khi viết tài liệu này (nhánh `feat/protocol-v1-contract` chưa có thay đổi). SDK
không đổi handshake, lỗi, envelope, cursor hay tên method. Các điểm phải chốt với Task 06 nằm
ở §8.

## 1. Entry point

| Entry | Môi trường | Nội dung |
|---|---|---|
| `@anhlp/alp-client/portable` | Node, browser, React Native | `AlpRpcClient`, `AlpClientError`, `CLIENT_ERROR`, `isAlpClientError`, `hello`, `createReconnectingClient`, `backoffDelay`, `retryable`, `createLineDecoder`, `utf8Length`, `DEFAULT_MAX_PENDING`, `MAX_TIMER_MS`, `timerDelay`; hằng số protocol `PROTOCOL_VERSION`, `MAX_FRAME`, `AlpRpcError`, `ERROR`; type `AlpTransport`, `TransportClose`, `RequestOptions`, `ReconnectOptions`, ... |
| `@anhlp/alp-client/websocket` | Node, browser, React Native | `connectWebSocket`, `createWebSocketTransport`, `redactUrl`, `CLOSE_CODE` |
| `@anhlp/alp-client/ipc` | Node | `createSocketTransport` (Unix socket, Windows named pipe, NDJSON) |
| `@anhlp/alp-client` (`.`, `./index`) | Node | Mọi API cũ (`connect`, `AlpClient`, `ensureDaemon`, `daemonPaths`, kiểm tra IPC, lock, discovery, integration) cộng toàn bộ API portable và WebSocket, `connectSocket`, `createSocketTransport` |
| `./doctor`, `./service`, `./setup`, `./supervise`, `./render`, ... | Node | Không đổi |

Hai entry portable chỉ import `./rpc/*.js` và `@anhlp/alp-protocol` (`src/public.js` →
`src/wire.js`). Không có Node built-in, `process`, `Buffer`, `require`, `@anhlp/alp-core` hay
provider SDK. `.` vẫn là Node-only. Package không thêm điều kiện `browser`/`react-native` vào
`.`, nên một bundle web phải import rõ `./portable` và `./websocket` và không thể vô tình kéo
adapter Node vào qua barrel.

## 2. Transport interface

```ts
type AlpTransport = {
  readonly state: 'open' | 'closed';
  send(frame: string): void;                                   // một message JSON-RPC hoàn chỉnh
  onMessage(listener: (frame: string) => void): () => void;
  onClose(listener: (close: { error?: Error; code?: number; reason?: string }) => void): () => void;
  close(): void;
};
```

- **Đơn vị là message, không phải byte.** Mỗi frame là một message JSON-RPC dạng text.
  Framing thuộc adapter: NDJSON trên socket (`createLineDecoder`), một message mỗi WebSocket
  message. Giải mã byte sang text cũng thuộc adapter.
- `send` giao frame hoặc throw đồng bộ. Throw nghĩa là frame chưa rời client; engine trả
  `send_failed` và không để lại request chờ.
- `onMessage` giao frame theo thứ tự đến. `onClose` chạy tối đa một lần, kể cả sau `close()`,
  và sau đó không còn frame nào. `close` idempotent.
- Adapter giới hạn bộ đệm ghi (`maxBufferedBytes`, mặc định `4 × MAX_FRAME`). Vượt giới hạn thì
  `send` throw thay vì để bộ nhớ tăng khi peer không đọc.
- Interface không có `socketPath`, filesystem, discovery hay khởi động daemon. Những việc đó
  nằm ở entry Node.

## 3. Engine `AlpRpcClient`

```js
const client = new AlpRpcClient(transport, { maxPending, maxFrame, timeoutMs, onListenerError });
await client.request(method, params, { signal, timeoutMs });
client.onEvent(envelope => ...);                // notification `event`
client.onNotification((method, params) => ...); // mọi notification, kể cả method chưa biết
client.onRequest((method, params) => result);   // request alpd gửi client (extension RPC, §61)
client.onClose(error => ...);
client.close();
```

- **Correlation:** id tăng dần theo connection. Response cho id không còn chờ (đã timeout hoặc
  abort) bị bỏ, cũng như error có `id: null`.
- **Frame hỏng:** frame không phải JSON hoặc không phải object thì đóng connection với lỗi
  `protocol`. Response có id nhưng thiếu cả `result` lẫn `error` thì chỉ request đó bị reject
  (`protocol`), connection vẫn mở.
- **Giới hạn:** tối đa `maxPending` (mặc định 4096) request chờ cùng lúc; vượt thì
  `overloaded` và không gửi. Request tính cả newline lớn hơn `maxFrame` bị từ chối trước khi gửi.
- **Listener ném lỗi** không chặn listener khác; lỗi đi tới `onListenerError` (mặc định ném lại
  ở tick sau như lỗi chưa bắt).
- **Kết thúc:** mọi request chờ bị reject một lần, timer và abort listener được gỡ, listener của
  client trên transport được gỡ, danh sách listener được xóa. Listener thêm sau khi kết thúc
  không được giữ.

### Lỗi

`AlpRpcError` (từ protocol) là lỗi alpd trả về: giữ `code` và `data` của wire.
`AlpClientError` là lỗi phía client, có `reason`:

| `reason` | Nghĩa | Request đã tới alpd? |
|---|---|---|
| `closed` | client bị `close()` | có thể |
| `disconnected` | transport đóng hoặc lỗi; `data` có `code`/`reason` của WebSocket nếu có | có thể; client không gửi lại |
| `protocol` | peer gửi thứ không phải ALP JSON-RPC | có thể |
| `send_failed` | transport từ chối frame, hoặc frame quá lớn | không |
| `timeout` / `aborted` | caller ngừng chờ | có thể; alpd **không** được báo |
| `overloaded` | quá `maxPending` | không |

`isAlpClientError(error, reason?)` nhận diện cả lỗi từ một bản copy khác của module (bundle có
thể chứa hai bản).

## 4. Vòng đời request và reconnect

- **Timeout/AbortSignal chỉ kết thúc việc chờ phía client.** Không có frame hủy nào được gửi.
  Integration test và browser smoke chứng minh: prompt bị abort vẫn được alpd nhận
  (`prompt.accepted`). Muốn dừng phía server thì caller gọi method của protocol (ví dụ
  `session.interrupt`).
- `timeoutMs` phải là số không âm; `Infinity` hoặc lớn hơn 2^31−1 ms nghĩa là không đặt timer.
- **Disconnect** reject mọi request chờ với `disconnected`; request mới reject ngay.
- **Không tự retry.** Engine và reconnect helper không bao giờ gửi lại request, kể cả sau
  reconnect. Idempotency (`clientMessageId` của `session.prompt`, receipt của alpd) là việc
  của caller và protocol.
- **`createReconnectingClient`**:
  - `connect({ attempt, signal })` mở transport mới;
  - `onConnect(client, { attempt, reconnect, signal })` là hook để caller handshake, reattach,
    replay theo protocol. Listener sự kiện được gắn trước hook, nên event replay tới được
    listener;
  - backoff mũ có jitter (`initialMs` 250, `factor` 2, `maxMs` 10 000, `jitter` 0.2),
    `maxAttempts`, `shouldRetry` (mặc định dừng khi alpd từ chối handshake với
    `ERROR.protocol`); bộ đếm chỉ reset khi connection đã sống ít nhất `stableMs` (mặc định 5 giây);
  - `stop()` hủy timer, hủy connect đang chạy (transport đến muộn bị đóng), đóng connection kể cả khi đang handshake,
    reject `ready()` đang chờ;
  - `ready({ signal })`, `request`, `onEvent`, `onNotification`, `onState`
    (`connecting | open | waiting | stopped`).

Ví dụ reattach theo contract **hiện tại** (ALPD §66: `session.attach { after }`, `cursor`
trong envelope). Contract này chưa vào schema; Task 06 chốt (§8):

```js
let cursor;
const alp = createReconnectingClient({
  connect: ({ signal }) => connectWebSocket(url, { signal }),
  onConnect: async client => {
    await hello(client, { name: 'my-app', version: '1.0.0' });
    await client.request('session.attach', cursor === undefined ? { sessionId } : { sessionId, after: cursor });
  },
});
alp.onEvent(envelope => { if (envelope.cursor !== undefined) cursor = envelope.cursor; render(envelope); });
```

## 5. Adapter

### Node IPC (`./ipc`, `.`)

- `createSocketTransport(socket, { maxFrame, maxBufferedBytes })` nhận socket đã nối hoặc
  đang nối (Node xếp hàng các lần ghi lúc đang nối, như `new AlpClient(net.createConnection(p))`
  vẫn làm).
- `connectSocket(socketPath)` chạy `assertPrivateSocket` (thư mục 0700, socket 0600, cùng
  owner, tổ tiên an toàn, theo dõi symlink) trước khi nối, rồi trả transport chưa handshake.
  `connect(socketPath, client, options)` là `connectSocket` + `hello`, trả `AlpClient`.
- Windows: named pipe như trước; mode bit không mô tả ACL của pipe, vẫn là giả định triển khai.
- `ensureDaemon`, `findDaemonEntry`, lock, `supervise`, `doctor`, `service`, `setup`,
  integration discovery: không đổi, vẫn Node-only.

### WebSocket (`./websocket`)

- `connectWebSocket(url, { WebSocket, protocols, createSocket, signal, timeoutMs, maxFrame, maxBufferedBytes })`:
  dùng `createSocket` nếu có, không thì `WebSocket` được inject, cuối cùng `globalThis.WebSocket`.
  Không có thì `TypeError` rõ ràng. Không import `ws`.
- Socket kiểu `addEventListener` (browser, `ws`) và kiểu `on<type>` (một số implementation)
  đều dùng được; listener được gỡ khi kết thúc.
- Một message có thể chứa nhiều dòng NDJSON. Message binary bị đóng với 4003, quá `maxFrame`
  đóng với 4009.
- Lỗi chỉ ghi URL đã bỏ credentials, query và fragment (`redactUrl`), vì token có thể nằm ở đó.
- **Xác thực không thiết kế ở đây (Task 08).** `url` và `protocols` đi qua nguyên vẹn. SDK
  không giả định browser đặt được header tùy ý. Node có thể dùng `createSocket` để tạo `ws`
  kèm header nếu gateway cần.

## 6. API cũ → entry mới

| API cũ (`@anhlp/alp-client` hoặc `/index`) | Còn dùng được? | Tương đương mới |
|---|---|---|
| `connect(socketPath, client)` | Có, nay nhận thêm `options` | `new AlpRpcClient(await connectSocket(path))` + `hello(client, info)` |
| `new AlpClient(socket)` | Có; `AlpClient extends AlpRpcClient` | `new AlpRpcClient(createSocketTransport(socket))` |
| `client.request/onEvent/onRequest/onClose/close/closed` | Có, cùng ngữ nghĩa | như cũ, thêm `onNotification`, `pendingCount`, `{ signal, timeoutMs }` |
| `PROTOCOL_VERSION`, `MAX_FRAME`, `AlpRpcError`, `encodeFrame` | Có | `@anhlp/alp-client/portable` (trừ `encodeFrame`: dùng `@anhlp/alp-protocol`) |
| `alpHome`, `daemonPaths`, `assertPrivateDirectory`, `assertPrivateSocket`, lock, `ensureDaemon`, `findDaemonEntry`, `discoverIntegration`, `startIntegration` | Có, Node-only | không có bản portable (không thuộc remote) |
| `startIntegration({ name, entry, home, args })` | Mới: `entry` chạy script đó với `--service` rồi `args`, bỏ qua descriptor/biến môi trường/PATH. `web` (alp-web của CLI) không bao giờ được discover nên cần `entry`; `web.enabled: false` chỉ chặn `web` | không truyền `entry` thì như cũ, trừ `web`. `ALP_WEB_INTEGRATION` chỉ còn áp cho `paseo` (sau `ALP_PASEO_INTEGRATION`), trong một bản phát hành |
| `createIntegrationLock(home, name)` | Mới, Node-only: `@anhlp/alp-client/integration-lock` (chuyển từ plugin Paseo) | khóa `integrations/<name>.lock`, guard `<name>.lock.reclaim` |
| `./supervise`, `./doctor`, `./service`, `./setup`, `./render`, `./command`, `./prompt`, probes | Có, Node-only | không đổi |

Khác biệt hành vi nhỏ của `AlpClient`, đều đã chạy qua test của alpd, CLI và plugin:
- request chờ bị reject bằng `AlpClientError` (vẫn là `Error`, giữ message
  `ALP daemon connection closed`, `ALP daemon frame exceeds size limit`,
  `Invalid frame from ALP daemon`). Lỗi socket gốc (ví dụ `ECONNRESET`) nằm ở `cause`, message
  được giữ;
- tối đa 4096 request chờ (trước đây không giới hạn) và request lớn hơn `MAX_FRAME` bị từ chối
  trước khi gửi;
- response thiếu cả `result` lẫn `error` bị reject (`protocol`) thay vì resolve `undefined`.

### Ví dụ migration

```js
// Node, như cũ:
import { connect } from '@anhlp/alp-client';
const client = await connect(socketPath, { name: 'cli', version });

// Node, transport tường minh (ví dụ để dùng reconnect helper):
import { connectSocket, createReconnectingClient, hello } from '@anhlp/alp-client';
const alp = createReconnectingClient({ connect: () => connectSocket(socketPath), onConnect: c => hello(c, info) });

// Browser / React Native:
import { AlpRpcClient, hello } from '@anhlp/alp-client/portable';
import { connectWebSocket } from '@anhlp/alp-client/websocket';
const client = new AlpRpcClient(await connectWebSocket(gatewayUrl, { protocols }));
await hello(client, { name: 'web', version });
```

## 7. Kiểm thử và xác minh

| Môi trường | Cách | Kết quả (2026-10-15, macOS arm64, Node 26.3) |
|---|---|---|
| Fake transport | `packages/client/tests/{rpc-client,framing,reconnect,websocket}.test.js` | correlation, notification, frame hỏng, send failure, timeout/abort không gửi hủy, disconnect, cleanup listener/timer, giới hạn pending, request từ daemon, reconnect không resend, stop, backoff |
| Node IPC | `packages/client/tests/ipc.test.js` với fake alpd trên socket/named pipe; test của alpd, CLI, plugin | qua; kiểm tra quyền socket/thư mục với `connect` và `connectSocket` (Unix; Windows bỏ qua vì ACL pipe) |
| alpd thật, IPC + WebSocket | `test/integration/client-sdk.test.js`: cùng kịch bản qua IPC, `ws` inject, WebSocket global của Node; cầu nối WS chỉ cho test | qua 5/5 lần: handshake, `daemon.status`, session + event stream, abort cục bộ alpd vẫn nhận, disconnect có close code, reconnect resend 0 frame và cursor liên tục |
| Bundle | integration test (esbuild `browser` và `neutral` + `react-native`), `tests/portable-imports.test.js` (đồ thị import) | chỉ 9 module portable; không `node:`, `process.`, `Buffer`, `require(`; bundle `.` cho browser thất bại như mong đợi |
| Browser thật | `node scripts/client-sdk-smoke.mjs browser` (Playwright từ `$ALP_PASEO_SRC`, `ALP_SMOKE_BROWSER` mặc định `chrome`) | Chrome 155 headless: page không có `process`/`Buffer`; handshake, request, stream event, abort, disconnect 4000 đều qua. Chromium 1208 trong cache Playwright local cài thiếu framework nên không chạy được |
| React Native / Metro | `node scripts/client-sdk-smoke.mjs metro` | Metro 0.83.8 resolve và bundle `ios`/`android` qua package exports; bundle chạy trong VM context trần (không `process`, `Buffer`, `require`) với WebSocket double. **Chưa chạy Hermes hay thiết bị**: repo không có `@react-native/babel-preset` và runtime RN. Private class field (`#x`) cần preset RN như mọi app RN |
| Tarball | `node scripts/client-sdk-smoke.mjs tarball` | pack protocol/core/client, cài offline vào project rỗng; mọi entry import được; bundle browser từ package đã cài chỉ có module portable; `.d.ts` type-check với project chỉ có DOM (không `@types/node`) và project Node, cả `bundler` lẫn `node16` |

Chạy: `npm test --workspace=@anhlp/alp-client`; `node scripts/test.mjs integration`;
`node scripts/client-sdk-smoke.mjs [browser|metro|tarball]` sau
`node scripts/build-workspace.mjs client && node scripts/build-core.mjs`. Smoke dùng
`ALP_HOME` tạm, không đọc hay ghi `~/.alp`.

## 8. Phụ thuộc còn mở

**Task 06 (protocol):**
- `daemon.hello`: result mở rộng (`daemonVersion`, `capabilities`, `principal`, 09A §5.1).
  `hello()` chỉ gửi params hiện tại và trả result nguyên vẹn; thêm trường mới không cần sửa SDK.
- Mã lỗi và `data.reason` chuẩn (ví dụ `unknown_session`). `retryable()` hiện chỉ dừng với
  `ERROR.protocol` (1006).
- Replay: `cursor` trong envelope, `session.attach { after }`, `reset` (09A §5.2). Khi schema
  chốt, có thể thêm helper theo dõi cursor theo root vào `./portable`; hiện caller làm qua
  `onConnect` như §4.
- Hủy tường minh qua protocol (nếu Task 06 thêm `$/cancel` hoặc tương đương):
  `RequestOptions` sẽ cần cờ `cancel: true` riêng; mặc định vẫn chỉ hủy phía client.
- Idempotency/`requestId` cho method tạo mới: SDK không tự sinh hay replay.
- Sau khi 06 chốt: chạy fixtures/conformance của 06 qua `AlpRpcClient` + fake transport và qua
  cả hai adapter.

**Task 08 (gateway):** URL, xác thực (subprotocol, token, pairing), close code của gateway,
principal. Cầu nối WS trong test chỉ chuyển frame và không xác thực; không phải gateway.

## 9. File dùng chung cần merge cẩn thận

- `packages/client/package.json`: thêm `./ipc`, `./portable`, `./websocket` vào `exports`, đổi
  `description`.
- `packages/client/src/index.js`: `AlpClient` thành lớp con của `AlpRpcClient`; thêm
  `connectSocket`, `export *` từ `./portable.js`.
- `test/integration/client-sdk.test.js` (mới, chạy cùng `node scripts/test.mjs integration`).
- `scripts/client-sdk-smoke.mjs` (mới). Task 04B đang sửa `scripts/tarball-consumer.mjs`,
  `scripts/validate.mjs`, `scripts/pack-check.mjs` và `.github/workflows/ci.yml`; nhánh này
  không đụng các file đó. Đưa `client-sdk-smoke.mjs tarball`/`metro` vào CI (và `browser` vào
  job đang chạy `web-app-smoke`) là việc tích hợp sau 04B.
- Không đổi root `package.json` hay lockfile: `ws`, `esbuild`, `metro`, `typescript` đã là
  devDependency/hoisted ở root.

`workspaceRegistry(client)` is available from the portable and Node entries. Its typed
`projects`, `workspaces`, `get`, `register`, `remove` and `update` methods use the daemon registry
contract (`workspace.registry`). Updates require the last registry `revision` as `ifRevision` and
a caller-retained `requestId`. The helper sends once; an uncertain result is reconciled with the
identical ID/payload/precondition. Remote registry writes require explicit `workspace.write`.

`conversation(client)` is available from the portable and Node entries. It wraps the conversation
methods of docs/protocol/alp-json-rpc-v1.md §12.7–§12.9; offer each one only when the host lists its
capability and the root's summary allows it (`conversation.fork`, `rewind`, `reload`, `configure`):

| Method | Sends | Capability |
|---|---|---|
| `fork(params)` | `session.fork`: a new closed root with the conversation through or before a turn (`boundary`), or a branch a rewind set aside (`branchId`); open it with `session.create { sessionId, resume: true }` | `session.fork` |
| `rewind(params)` | `session.rewind`: the root continues from before `beforeTurnId` under the same id; the later turns stay a branch | `session.rewind` |
| `reload(params)` | `session.reload`: a live root's native process restarts on its own conversation | `session.reload` |
| `resumeCommand(params)` | `session.resumeCommand`: the `alp attach` command for the clipboard, never to run | `session.resumeCommand` |
| `configure(params)` | `session.configure` with `model`, `thinking` or `team` (plus `requestId` and `ifGeneration`): a restart on the same conversation | `session.configure.live` |
| `configurePreview(params)` | `session.configure.preview`: what a change would run with, and whether it would be taken now; reads only | `session.configure.live` |

Only the conversation changes: no file is copied, restored or changed. Each mutation is sent once
and never retried by the helper. Keep `requestId` (and `ifGeneration`): after a lost answer (timeout,
disconnect) or `persistence_failed`, send the identical request again, and alpd answers the first result with
`duplicate: true`. Any other answer means a new attempt takes a new `requestId`; never repeat one after
`outcome_unknown`. `ifGeneration` is the history generation the client read (`session.history`);
`1004 stale_generation` means read the history again. After a rewind, connections attached to the
tree get `history.reset { generation, reason: 'rewind', branchId }`: drop the cached history, fetch a
new tail and attach again with that generation. Principal fields of `fork` are set by a trusted
gateway on its own connection, never by a remote client.

```js
import { conversation } from '@anhlp/alp-client/portable';
const alp = conversation(client);
const { generation } = await client.request('session.history', { sessionId, limit: 1 });
const { session } = await alp.fork({ sessionId, requestId, ifGeneration: generation, boundary: { throughTurnId } });
await client.request('session.create', { sessionId: session.id, spec: { cwd }, resume: true });
```
