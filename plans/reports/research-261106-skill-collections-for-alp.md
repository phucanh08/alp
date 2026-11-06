# Research: bộ skill công khai đáng học cho ALP

Ngày: 2026-11-06. Phạm vi: chỉ nghiên cứu, không sửa code/skill.
Phương pháp: đọc 15 core skill + 7 pack skill của ALP, `docs/alp/skill-system.md`,
`role-skills.md`, `scripts/skill-eval.mjs`, `test/evals/skills/triggers.json`; clone nông
(`--depth 1`) 7 repo công khai rồi đọc SKILL.md/LICENSE; metadata (sao, ngày push, license)
lấy từ GitHub search API ngày 2026-11-06.

## 1. Hiện trạng ALP (tóm tắt)

- 15 core skill (`templates/skills/`), 7 pack skill (`templates/packs/*`), theo
  [Agent Skills spec](https://agentskills.io/specification). Level 0 = name+description (clip
  400 ký tự), SKILL.md ngắn (34–105 dòng), `references/` theo nhu cầu, 1 script duy nhất
  (`feature-architecture/scripts/check-boundaries.mjs`).
- Validator mạnh (`alp skill check --strict`), đo disclosure (`skill-eval.mjs disclosure`).
- Eval trigger: chỉ **15 scenario** (7 positive, 3 negative, 2 ambiguous, 2 role, 1 multi);
  `--live` chỉ hỏi model "sẽ mở skill nào", **không có eval hành vi** (skill có làm agent làm
  đúng hơn baseline không).
- Reviewer chỉ có `security-review`, `release-readiness` → **không có skill review code chung**.
- `compact`, `curate` viết tiếng Việt, 13 skill còn lại tiếng Anh → trigger không đồng nhất.
- Không có skill nào cho: TDD, xác minh trước khi báo xong, nhận review, viết plan
  (sequence-execution-plan chỉ sắp thứ tự), brainstorm/thiết kế trước khi code, xử lý CI đỏ,
  AGENTS.md/CLAUDE.md, quét bảo mật skill.

## 2. Bảng tổng hợp bộ sưu tập

| Bộ | Sao / push cuối | License | Đáng học |
|---|---|---|---|
| [obra/superpowers](https://github.com/obra/superpowers) | 313k / 2026-11-03 | MIT | verification-before-completion, receiving-code-review, requesting-code-review, writing-plans, TDD, systematic-debugging, writing-skills (TDD cho skill, pressure test), brainstorming |
| [mattpocock/skills](https://github.com/mattpocock/skills) | 315k / 2026-11-05 | MIT | tdd (38 dòng + `tests.md`, `mocking.md`), diagnosing-bugs, code-review 2 trục (Standards + Spec), handoff, writing-for-agents, grill-me; `agents/openai.yaml` |
| [anthropics/skills](https://github.com/anthropics/skills) | 188k / 2026-10-28 | per-skill: phần lớn Apache-2.0; docx/pdf/pptx/xlsx **source-available, cấm copy** | skill-creator (eval with-skill vs baseline, grader/comparator agents, `improve_description.py`, `run_loop.py`), mcp-builder, webapp-testing, frontend-design, doc-coauthoring |
| [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) | 114k / 2026-11-01 | MIT | doubt-driven-development (review đối kháng fresh-context), incremental-implementation, code-review-and-quality, context-engineering, source-driven-development, deprecation-and-migration, using-agent-skills |
| [openai/skills](https://github.com/openai/skills) | 28.5k / 2026-10-28 | per-skill Apache-2.0/MIT; figma-* LICENSE riêng (kiểm trước) | gh-fix-ci, gh-address-comments, define-goal, security-threat-model, skill-creator; quy ước `agents/openai.yaml` (display_name, short_description, default_prompt) |
| [getsentry/skills](https://github.com/getsentry/skills) | 1.1k / 2026-11-05 | Apache-2.0 | skill-writer (`SPEC.md` + `SOURCES.md` + `EVAL.md` + AXIS evals), skill-scanner (quét skill độc hại, `scan_skill.py`), iterate-pr, agents-md, find-bugs, code-review, gha-security-review |
| [trailofbits/skills](https://github.com/trailofbits/skills) | 8k / 2026-11-05 | **CC-BY-SA-4.0** (share-alike → không copy vào Apache) | differential-review (blast radius, git blame), sharp-edges, second-opinion (review chéo Codex/Gemini), property-based-testing, skill-improver (vòng review-fix có ledger) |
| [wshobson/agents](https://github.com/wshobson/agents) | 42k / 2026-11-05 | MIT | plugin chia nhỏ theo domain, đa runtime (Claude/Codex/Cursor/OpenCode) — mẫu đóng gói pack |
| [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) / [-community](https://github.com/anthropics/claude-plugins-community) | 46k / 4.8k | Apache-2.0 | định dạng marketplace/plugin; ALP đã sinh plugin per-session — có thể xuất pack thành marketplace |
| [agentskills/agentskills](https://github.com/agentskills/agentskills) | 27k / 2026-11-04 | Apache-2.0 | spec + `skills-ref validate` → dùng làm oracle đối chiếu `alp skill check` |
| [affaan-m/ECC](https://github.com/affaan-m/ECC) | 298k / 2026-11-02 | MIT | rất lớn, nhiều "instincts/memory"; chỉ tham khảo ý tưởng học lesson → skill (gần `curate`) |
| [OthmanAdi/planning-with-files](https://github.com/OthmanAdi/planning-with-files) | 28k / 2026-11-04 | MIT | plan bền vững trên file cho task dài (gần `compact` + plan) |

Bỏ qua: [multica-ai/andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills)
(chỉ 1 CLAUDE.md, không license), [ComposioHQ/awesome-claude-skills](https://github.com/ComposioHQ/awesome-claude-skills)
(danh sách, không license), [hesreallyhim/awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code)
(NOASSERTION; chỉ dùng để khám phá), bộ domain hẹp (marketing, science, gamedev).

## 3. Pattern đáng mượn (xuyên bộ)

1. **Iron law + bảng "rationalization"** (superpowers): skill kỷ luật (verify, TDD, debug) có
   1 luật in đậm, bảng "Lý do bào chữa → Thực tế", danh sách red flag ("should", "probably",
   "Done!"). ALP hiện viết văn xuôi lịch sự → dễ bị lách khi agent vội.
2. **"Match the form to the failure"** (superpowers writing-skills): lỗi bỏ qua luật → cấm +
   red flags; lỗi thiếu trường trong output → slot bắt buộc trong template, không phải lời nhắc.
   Rất hợp với output handoff của ALP.
3. **Eval hành vi with-skill vs baseline** (anthropic skill-creator, superpowers
   testing-skills-with-subagents, sentry AXIS): chạy cùng task có/không skill, chấm bằng
   assertion + LLM judge, so sánh. ALP chỉ eval trigger.
4. **Tối ưu description tự động** (anthropic `improve_description.py`/`run_loop.py`): sinh
   ~20 query should/should-not trigger, tách train/held-out, lặp đề xuất description. Lưu ý
   bài [dev.to](https://dev.to/danielsogl/skills-without-evals-are-just-markdown-and-hope-3a71):
   có lúc description gốc thắng → phải giữ held-out.
5. **SPEC.md / SOURCES.md / EVAL.md cho maintainer** (sentry): ý đồ, nguồn, eval nằm cạnh
   skill nhưng **không link từ SKILL.md** → không tốn context runtime, vẫn có provenance.
   ALP đang để provenance trong `plans/` → khó theo dõi theo từng skill.
6. **Skill đọc fresh-context / đối kháng** (addy doubt-driven, trailofbits second-opinion):
   giao 1 reviewer không thấy lập luận gốc. ALP có sẵn role reviewer/oracle → hợp tự nhiên.
7. **Metadata hiển thị theo runtime** (openai `agents/openai.yaml`): display_name,
   short_description, default_prompt. ALP chạy Codex → có thể sinh file này khi link skill.
8. **Quét bảo mật skill** (sentry skill-scanner): prompt injection, exfil, script nguy hiểm,
   tải từ mạng. ALP có `alp_skill` (main đề xuất skill từ lesson) + `alp skill cp` từ nguồn
   ngoài → nên có kiểm tra này trong `alp skill check`.
9. **Skill ngắn + references** (mattpocock tdd 38 dòng): ALP đã làm tốt; đừng chạy theo
   superpowers 300+ dòng.

## 4. Gap so với 15 skill ALP

| Gap | Có ở | ALP gần nhất | Kết luận |
|---|---|---|---|
| Verify trước khi báo xong | superpowers verification-before-completion | rải rác trong từng skill ("Verification") | **Thiếu – ưu tiên cao**; ALP nhiều tầng handoff (peer→lead→main), mỗi tầng tin báo cáo dưới |
| Review code chung (correctness, spec) | mattpocock code-review, sentry code-review/find-bugs, addy code-review-and-quality | security-review (chỉ bảo mật) | **Thiếu**; reviewer role chỉ có 2 skill |
| Nhận/xử lý review feedback | superpowers receiving-code-review, openai gh-address-comments | không | Thiếu; lead nhận reject từ reviewer cần quy trình |
| TDD | superpowers, mattpocock, addy | test-strategy (thiết kế test), bug-loop (regression) | Thiếu kỷ luật red-green; nên là reference/mode của test-strategy hoặc skill nhỏ |
| Viết plan triển khai chi tiết | superpowers writing-plans, addy planning-and-task-breakdown | sequence-execution-plan (thứ tự + ownership) | Một phần; thêm template task nhỏ có lệnh verify |
| Brainstorm / thiết kế trước khi code | superpowers brainstorming, addy idea-refine/spec-driven | goal-griller (làm rõ goal) | Đủ phần lớn; thêm bước "2–3 phương án + trade-off" vào feature-architecture |
| CI đỏ / iterate PR | openai gh-fix-ci, sentry iterate-pr | bug-loop | Thiếu; hợp pack `operations` hoặc pack mới `github` |
| AGENTS.md / CLAUDE.md / ALP.md | sentry agents-md, addy context-engineering, mattpocock writing-for-agents | không | Thiếu; ALP dùng ALP.md → skill maintain file chỉ dẫn dự án |
| Debug có hệ thống | superpowers systematic-debugging, mattpocock diagnosing-bugs | bug-loop | **Đã có, tốt**; chỉ nâng cấp (mục 5) |
| Refactor / simplify | addy code-simplification, sentry code-simplifier | safe-refactor | Đã có |
| Handoff / compact | mattpocock handoff, planning-with-files | compact | Đã có |
| Threat model | openai security-threat-model, trailofbits sharp-edges | security-review | Thêm reference threat-model vào security-review |
| Migration / deprecation | addy deprecation-and-migration | safe-refactor + databases | Thêm reference, không cần skill mới |
| Song song nhiều agent | superpowers dispatching-parallel-agents, subagent-driven-development | prompt-leverage + sequence-execution-plan + runtime team | ALP đã có ở tầng runtime; không cần |
| Git worktree, finishing branch | superpowers | smart-commits | Bỏ qua; ALP quản lý workspace ở runtime |
| Frontend/design/MCP | anthropic frontend-design, mcp-builder, webapp-testing | packs frontend/design/integration/quality | Đã có pack; đối chiếu nội dung |

## 5. Khuyến nghị ưu tiên (top 10)

Effort: S ≤ 1 ngày, M 2–4 ngày, L ≥ 1 tuần.

### R1. Skill mới `verify-before-done` — S
- Nguồn: [superpowers/verification-before-completion](https://github.com/obra/superpowers/tree/main/skills/verification-before-completion) (MIT).
- Nội dung: gate 5 bước (xác định lệnh chứng minh → chạy mới → đọc output/exit code → so với
  claim → mới báo), bảng "Claim → Cần → Không đủ", red flags. Bổ sung kiểu ALP: **không tin
  báo cáo của agent cấp dưới** — lead kiểm diff/lệnh của peer trước khi handoff lên main.
- Role: main, lead, peer, reviewer. Có thể thay cho đoạn "Verification" lặp ở các skill
  (giảm trùng). Cân nhắc: nếu muốn index nhỏ, gộp thành rule trong instructions chung thay vì skill.

### R2. Eval hành vi with-skill vs baseline trong `skill-eval.mjs` — L
- Nguồn: [anthropic skill-creator](https://github.com/anthropics/skills/tree/main/skills/skill-creator)
  (Apache-2.0: `run_eval.py`, `agents/grader.md`, `comparator.md`), [superpowers testing-skills-with-subagents](https://github.com/obra/superpowers/blob/main/skills/writing-skills/references/testing-skills-with-subagents.md) (MIT),
  [sentry skill-writer EVAL.md + AXIS](https://github.com/getsentry/skills/tree/main/skills/skill-writer) (Apache-2.0).
- Thêm lệnh `skill-eval.mjs behavior --live`: mỗi skill 2–3 task fixture, chạy agent có/không
  skill (ALP đã chạy được Claude Code & Codex), chấm bằng assertion file/lệnh + judge rubric,
  ghi `test/evals/skills/results/*.json`. Viết lại bằng Node (.mjs) theo quy ước ALP; chỉ
  mượn ý tưởng/schema.
- Mở rộng triggers.json từ 15 → ~3–5 scenario/skill (≈60–80), có held-out.

### R3. Skill mới `code-review` cho reviewer (+ lead) — M
- Nguồn: [mattpocock/code-review](https://github.com/mattpocock/skills/tree/main/skills/engineering/code-review) (MIT: 2 trục Standards + Spec, review từ merge-base),
  [sentry find-bugs](https://github.com/getsentry/skills/tree/main/skills/find-bugs) (Apache-2.0), ý tưởng
  blast radius từ [trailofbits differential-review](https://github.com/trailofbits/skills/tree/main/plugins/differential-review) (CC-BY-SA → **chỉ viết lại ý**).
- Trục: correctness, spec/brief (so với brief của prompt-leverage), conventions (ALP.md, architecture
  docs), test coverage; finding có severity + bằng chứng `file:line`; bảo mật → chuyển security-review.
- Reviewer được read-only → khớp. Hiện reviewer chỉ có 2 skill là lỗ hổng rõ nhất.

### R4. Skill mới `review-response` (nhận review/reject) — S
- Nguồn: [superpowers/receiving-code-review](https://github.com/obra/superpowers/tree/main/skills/receiving-code-review) (MIT), [openai gh-address-comments](https://github.com/openai/skills/tree/main/skills/.curated/gh-address-comments) (Apache-2.0).
- Đọc hết → diễn đạt lại → kiểm với code thật → đồng ý có lý do hoặc phản biện kỹ thuật →
  sửa từng mục, test từng mục; mục không rõ thì dừng hỏi trước khi sửa bất kỳ mục nào.
- Role: lead, peer (nhận reject từ reviewer/lead). Có thể là reference của R3 nếu muốn ít skill.

### R5. Nâng `skill-authoring`: "form theo failure", SPEC/SOURCES, tối ưu description — M
- Nguồn: [superpowers writing-skills](https://github.com/obra/superpowers/tree/main/skills/writing-skills) (MIT; `bulletproofing.md`, "Match the Form to the Failure"),
  [anthropic skill-creator Description Optimization](https://github.com/anthropics/skills/tree/main/skills/skill-creator) (Apache-2.0), [sentry skill-writer](https://github.com/getsentry/skills/tree/main/skills/skill-writer) (Apache-2.0).
- Thêm: (a) bước baseline trước khi viết (agent làm sai gì khi không có skill?); (b) phân loại
  skill: kỷ luật / kỹ thuật / pattern / reference và cách test mỗi loại; (c) quy ước file
  maintainer `SPEC.md`, `SOURCES.md` (provenance + license từng nguồn) không link từ SKILL.md
  — cần validator cho phép/biết bỏ qua; (d) script `improve-description.mjs` với train/held-out.

### R6. Nâng `bug-loop` + `test-strategy`: TDD và chống lách — S
- Nguồn: [superpowers systematic-debugging](https://github.com/obra/superpowers/tree/main/skills/systematic-debugging) (MIT: `root-cause-tracing.md`, `condition-based-waiting.md`, `find-polluter.sh`),
  [mattpocock tdd](https://github.com/mattpocock/skills/tree/main/skills/engineering/tdd) (MIT: `tests.md`, `mocking.md`), [mattpocock diagnosing-bugs](https://github.com/mattpocock/skills/tree/main/skills/engineering/diagnosing-bugs) (MIT).
- bug-loop: thêm reference root-cause tracing (lần ngược stack tới nguồn), flaky/condition-based
  waiting, script tìm test làm ô nhiễm (viết lại bằng .mjs); luật "3 lần sửa thất bại → dừng,
  nghi ngờ kiến trúc, báo lên".
- test-strategy: thêm reference `tdd.md` (red-green-refactor, test hành vi qua interface công
  khai, mock chỉ ở ranh giới) thay vì skill TDD riêng — giữ index nhỏ.

### R7. Kiểm tra bảo mật skill trong `alp skill check` — M
- Nguồn: [sentry skill-scanner](https://github.com/getsentry/skills/tree/main/skills/skill-scanner) (Apache-2.0, `scan_skill.py`).
- Cảnh báo: chỉ dẫn kiểu prompt injection ("ignore previous", "do not tell the user"), URL tải
  script/`curl | sh`, đọc `~/.ssh`/token, ký tự ẩn/Unicode bidi, script gọi mạng. Áp cho
  `alp skill cp` từ nguồn ngoài, `alp_skill` proposal, `alp pack install`. Viết lại bằng TS
  trong validator (không copy Python).

### R8. Skill mới `agent-instructions` (ALP.md / AGENTS.md / CLAUDE.md) — S
- Nguồn: [sentry agents-md](https://github.com/getsentry/skills/tree/main/skills/agents-md) (Apache-2.0), [mattpocock writing-for-agents](https://github.com/mattpocock/skills/tree/main/skills/productivity/writing-for-agents) (MIT), [addy context-engineering](https://github.com/addyosmani/agent-skills/tree/main/skills/context-engineering) (MIT).
- Viết/cập nhật file chỉ dẫn dự án ngắn, dựa bằng chứng (lệnh build/test thật, quy ước), tránh
  trùng README; main + lead. Có thể gộp với `curate` nếu muốn ít skill (curate đã lo lesson).

### R9. Pack mới `github` (hoặc thêm vào `operations`): `fix-ci`, `iterate-pr` — M
- Nguồn: [openai gh-fix-ci](https://github.com/openai/skills/tree/main/skills/.curated/gh-fix-ci) (Apache-2.0), [sentry iterate-pr](https://github.com/getsentry/skills/tree/main/skills/iterate-pr) (Apache-2.0).
- Lấy log check thất bại → tái hiện local → sửa nhỏ nhất → đẩy → chờ → lặp; dừng khi chỉ còn
  lỗi không actionable. Phụ thuộc `gh` → khai báo `compatibility`. Pack optional, không core.

### R10. Review fresh-context (đối kháng) cho quyết định lớn — S
- Nguồn ý tưởng: [addy doubt-driven-development](https://github.com/addyosmani/agent-skills/tree/main/skills/doubt-driven-development) (MIT), [trailofbits second-opinion](https://github.com/trailofbits/skills/tree/main/plugins/second-opinion) (CC-BY-SA → viết lại).
- Không cần skill mới: thêm reference vào `prompt-leverage` — cách viết brief cho reviewer/oracle
  **không kèm lập luận của tác giả**, chỉ artefact + câu hỏi "chỗ nào sai?". Tận dụng ALP chạy
  cả Claude lẫn Codex → review chéo runtime.

### Phụ (nhỏ, S)
- Đồng nhất ngôn ngữ description: `compact`, `curate` sang tiếng Anh (hoặc song ngữ keyword)
  để trigger ổn định trên mọi model; đo lại bằng triggers `--live`.
- Sinh `agents/openai.yaml` (display_name, short_description) khi link skill cho Codex — theo
  [openai/skills](https://github.com/openai/skills); kiểm Codex hiện đọc file này chưa.
- Chạy [`skills-ref validate`](https://github.com/agentskills/agentskills/tree/main/skills-ref)
  trong CI như oracle so với `alp skill check --strict`.
- feature-architecture: thêm bước "2–3 phương án + trade-off, chọn 1" trước design ngắn
  (ý từ [superpowers brainstorming](https://github.com/obra/superpowers/tree/main/skills/brainstorming)).
- security-review: thêm reference threat-model (trust boundary, asset, attacker, abuse path) ý
  từ [openai security-threat-model](https://github.com/openai/skills/tree/main/skills/.curated/security-threat-model) (Apache-2.0).
- Xuất pack ALP thành Claude Code plugin marketplace (`.claude-plugin/marketplace.json`) để
  người không dùng ALP cũng cài được — kênh phân phối, không ảnh hưởng runtime.

### Thứ tự đề xuất
R1 → R3 → R4 (vá lỗ hổng reviewer/handoff, effort nhỏ) → R6 → R5 → R2 (eval hành vi, nền
tảng để đo các skill mới) → R7 → R8 → R10 → R9.
Lưu ý index: thêm R1+R3+R4+R8 ≈ +4 skill cho main (~+300 token ước tính); ưu tiên biến thành
reference khi có thể (R6, R10, threat-model).

## 6. License

| Nguồn | License | Được làm gì trong ALP (Apache-2.0) |
|---|---|---|
| obra/superpowers, mattpocock/skills, addyosmani/agent-skills, wshobson/agents, ECC, planning-with-files | MIT | Copy/adapt được; giữ copyright + MIT notice trong `THIRD-PARTY-NOTICES.txt`/`NOTICE` |
| anthropics/skills (trừ docx/pdf/pptx/xlsx), openai/skills (đa số), getsentry/skills, agentskills | Apache-2.0 | Copy/adapt được; giữ LICENSE, ghi rõ đã sửa (Apache §4b), cập nhật NOTICE |
| anthropics/skills docx/pdf/pptx/xlsx | Source-available, Anthropic proprietary | **Không copy**, không phân phối lại |
| openai/skills `figma-*` (LICENSE.TXT riêng), notion-*/vercel-deploy (MIT) | kiểm từng file | Đọc LICENSE từng skill trước khi dùng |
| trailofbits/skills | CC-BY-SA-4.0 | **Không copy** vào Apache (share-alike lây); chỉ viết lại ý tưởng |
| andrej-karpathy-skills, awesome-claude-skills, cc-marketplace | không license | Mặc định all rights reserved → chỉ đọc lấy ý |
| hesreallyhim/awesome-claude-code, Imbad0202/... | NOASSERTION | Chỉ dùng để khám phá |

Khuyến nghị chung: kể cả nguồn MIT/Apache, **viết lại** theo giọng ALP (role, handoff,
read-only, không tool riêng runtime) như v2 đã làm; ghi provenance theo skill (R5 `SOURCES.md`).
Nếu copy nguyên đoạn: thêm `license:` trong frontmatter hoặc mục NOTICE.

## 7. Câu hỏi chưa giải quyết

1. Ngân sách index Level 0: chấp nhận thêm bao nhiêu skill core cho main (hiện 15, ~5.5k ký tự)?
   Hay chuyển verify-before-done thành rule trong instructions chung?
2. Eval hành vi (R2) chạy model thật tốn tiền: chạy định kỳ ở CI (có credential) hay chỉ thủ công
   trước release?
3. Validator có chấp nhận file maintainer (`SPEC.md`, `SOURCES.md`, `EVAL.md`) không được link
   từ SKILL.md không, và có loại chúng khỏi bundle/disclosure không?
4. Codex hiện có đọc `agents/openai.yaml` trong skill do ALP link không (chưa kiểm trên Codex thật)?
5. Ngôn ngữ chuẩn của skill: tiếng Anh cho mọi skill, hay hỗ trợ skill tiếng Việt chính thức?
6. Số sao lấy từ GitHub search API; một số repo (mattpocock 315k, ECC 298k) có mức sao bất
   thường — không ảnh hưởng khuyến nghị (đánh giá dựa nội dung), nhưng không nên dùng làm tín
   hiệu chất lượng duy nhất.
7. Chưa đọc trực tiếp tài liệu best-practices chính thức mới nhất của Anthropic (chỉ spec
   agentskills.io + repo skill-creator); số liệu "tối ưu description" từ bài thứ cấp.
