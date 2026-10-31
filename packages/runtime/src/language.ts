/**
 * What ALP itself writes for the user, in the user's language (ALPD §54): approvals,
 * permission and trust questions, and notices. Vietnamese and English are written
 * out; any other language gets English from ALP while agents write in it.
 */

export const isVietnamese = (language: string) => /^(vi|vie|vietnamese|tiếng việt|tieng viet)$/i.test(language.trim());

const en = {
  approve: 'Approve',
  reject: 'Reject',
  answerLine: (agent: string) => `Answer Approve or Reject; any other answer goes back to ${agent} as feedback.`,
  skill: (agent: string, replacing: boolean, file: string, roles: string, lessons: string[]) =>
    `${agent} proposes a skill distilled from its lessons${replacing ? ', replacing the skill of that name' : ''}. ` +
    `Approve to save it as ${file}. Roles that get it: ${roles}.` +
    (lessons.length ? ` These lessons move into it and leave the lessons files:\n${lessons.map(lesson => `- ${lesson}`).join('\n')}` : ''),
  issue: (agent: string, create: boolean, issue: number | undefined, where: string) =>
    `${agent} wants to ${create ? `open an issue in ${where}` : `comment on issue #${issue} in ${where}`}. ` +
    'It is posted with your GitHub account, and anyone who can see the repository can read it.',
  issueTitle: 'Title',
  skillRetire: (agent: string, name: string, file: string, retired: string, roles: string, reason: string) =>
    `${agent} proposes to retire the skill ${name} (${file}): ${reason}\n` +
    `Approve to move it to ${retired}, where it is kept and can be restored, and remove it from ${roles ? `the roles that have it: ${roles}` : 'role-skills.json (no role has it)'}. Nothing else changes.`,
  lessonCurate: (agent: string, changes: string) =>
    `${agent} proposes to curate the lessons files. Approve to apply every change below at once; nothing else changes.\n\n${changes}`,
  lessonRemove: 'Remove',
  lessonAdd: 'Add',
  lessonScope: (scope: string, file: string) => `${scope === 'user' ? 'User lessons' : 'Project lessons'} (${file})`,
  issueLabels: 'Labels',
  trust: (project: string, names: string) => `This project's hooks run shell commands from ${project} on your machine: ${names}. ` +
    'Trust this workspace\'s hooks? ALP asks once: after you agree, its hooks run without asking, including hooks added or changed later.',
  trustYes: 'Trust this workspace',
  trustNo: 'Not now',
  allowOnce: 'Allow once',
  alwaysAllow: 'Always allow',
  deny: 'Deny',
  permission: (agent: string, what: string, byRule: boolean, profile: string | undefined, mode: string, always: string | undefined) =>
    `${agent} wants to ${what}. ` +
    (byRule ? `Its permission profile ${profile} asks you each time.` : `Its ${mode} mode does not allow that.`) +
    (always ? ` Always allow adds ${always} to profile ${profile}.` : ''),
  limitReached: (runtime: string, resetsAt: string | undefined, other: string | undefined, autoResume: boolean, kind: string) =>
    `${runtime} usage limit reached${resetsAt ? `; it resets ${resetsAt}` : ''}. ALP paused delegation to ${runtime} agents and parked their assignments${other ? `; ${other} agents keep working` : ''}. ${autoResume ? `ALP asks ${runtime} every minute and resumes it as soon as the limit lifts.` : `ALP asks ${runtime} every minute and tells you when the limit lifts; then run alp resume ${kind}.`}`,
  limitLifted: (runtime: string, kind: string) => `${runtime} says its usage limit has lifted. Run alp resume ${kind} to continue its work.`,
  compacted: (native: boolean) => `Main's context was compacted${native ? '' : ' into a fresh conversation'}; it keeps its checkpoint and carries on.`,
  compactFailed: (reason: string) => `Compacting main's context failed (${reason}); ALP tries again later.`,
  usageWarning: (runtime: string, used: string, resetsAt: string | undefined) => `${runtime} has used ${used} of a usage window${resetsAt ? ` that resets ${resetsAt}` : ''}.`,
  /** The web app's answer to a Paseo feature ALP has not got yet (ALPD §62). */
  inDevelopment: 'This feature is in development',
  resumed: (what: string, by: string, parked: boolean) => `${what} resumed by ${by}.${parked ? ' Parked assignments continue.' : ''}`,
  diskFull: (reason: string) => `Disk full: ${reason}. ALP paused its work and parked running assignments; it keeps answering. Free some space (alp doctor lists leftover worktrees); ALP checks every minute and continues by itself, or run alp resume.`,
  diskLow: (free: string) => `Disk space is low: ${free} free. Free some space before it fills (alp doctor lists leftover worktrees); when it is full, ALP pauses its work.`,
  paused: (what: string, reason: string | undefined, runtime: string | undefined, now: boolean) =>
    `${what} paused by the user${reason ? `: ${reason}` : ''}. Delegation${runtime ? ` to ${runtime} agents` : ''} waits${now ? ', and running assignments park where they are' : '; running turns finish'}. alp resume continues.`,
};

export type Words = typeof en;

/** ALP's permission requests start with an English verb; these are the ones it writes. */
const viWhat = (what: string) => what.replace(/^run /, 'chạy ').replace(/^change files under /, 'sửa file trong ').replace(/^change files/, 'sửa file').replace(/^use /, 'dùng ');

const vi: Words = {
  approve: 'Duyệt',
  reject: 'Từ chối',
  answerLine: agent => `Chọn Duyệt hoặc Từ chối; câu trả lời khác sẽ được gửi lại cho ${agent} làm góp ý.`,
  skill: (agent, replacing, file, roles, lessons) =>
    `${agent} đề xuất một skill đúc kết từ các bài học${replacing ? ', thay cho skill cùng tên' : ''}. ` +
    `Duyệt để lưu thành ${file}. Các vai được dùng: ${roles}.` +
    (lessons.length ? ` Các bài học sau chuyển vào skill và rời khỏi file bài học:\n${lessons.map(lesson => `- ${lesson}`).join('\n')}` : ''),
  issue: (agent, create, issue, where) =>
    `${agent} muốn ${create ? `mở một issue trong ${where}` : `bình luận vào issue #${issue} trong ${where}`}. ` +
    'Nội dung được đăng bằng tài khoản GitHub của bạn, ai xem được repository đều đọc được.',
  issueTitle: 'Tiêu đề',
  skillRetire: (agent, name, file, retired, roles, reason) =>
    `${agent} đề xuất cho skill ${name} (${file}) nghỉ: ${reason}\n` +
    `Duyệt để chuyển nó sang ${retired}, nơi nó vẫn được giữ và có thể khôi phục, và bỏ nó khỏi ${roles ? `các vai đang dùng: ${roles}` : 'role-skills.json (không vai nào dùng)'}. Không thay đổi gì khác.`,
  lessonCurate: (agent, changes) =>
    `${agent} đề xuất rà soát file bài học. Duyệt để áp dụng cùng lúc mọi thay đổi dưới đây; không thay đổi gì khác.\n\n${changes}`,
  lessonRemove: 'Bỏ',
  lessonAdd: 'Thêm',
  lessonScope: (scope, file) => `${scope === 'user' ? 'Bài học của người dùng' : 'Bài học của project'} (${file})`,
  issueLabels: 'Nhãn',
  trust: (project, names) => `Các hook của project này chạy lệnh shell từ ${project} trên máy của bạn: ${names}. ` +
    'Tin cậy các hook của workspace này? ALP chỉ hỏi một lần: khi bạn đồng ý, các hook chạy mà không hỏi lại, kể cả hook thêm hoặc sửa sau này.',
  trustYes: 'Tin cậy workspace này',
  trustNo: 'Để sau',
  allowOnce: 'Cho phép lần này',
  alwaysAllow: 'Luôn cho phép',
  deny: 'Từ chối',
  permission: (agent, what, byRule, profile, mode, always) =>
    `${agent} muốn ${viWhat(what)}. ` +
    (byRule ? `Hồ sơ quyền ${profile} của nó yêu cầu hỏi bạn mỗi lần.` : `Chế độ ${mode} của nó không cho phép việc này.`) +
    (always ? ` Luôn cho phép sẽ thêm ${always} vào hồ sơ ${profile}.` : ''),
  limitReached: (runtime, resetsAt, other, autoResume, kind) =>
    `${runtime} đã hết hạn mức sử dụng${resetsAt ? `; hạn mức đặt lại lúc ${resetsAt}` : ''}. ALP tạm dừng giao việc cho các agent ${runtime} và tạm giữ việc của chúng${other ? `; các agent ${other} vẫn làm tiếp` : ''}. ${autoResume ? `ALP hỏi ${runtime} mỗi phút và tự chạy lại ngay khi có hạn mức.` : `ALP hỏi ${runtime} mỗi phút và báo khi có hạn mức trở lại; khi đó chạy alp resume ${kind}.`}`,
  limitLifted: (runtime, kind) => `${runtime} báo đã có hạn mức trở lại. Chạy alp resume ${kind} để làm tiếp việc của nó.`,
  compacted: native => `Context của main đã được compact${native ? '' : ' sang một cuộc hội thoại mới'}; main giữ checkpoint và làm tiếp.`,
  compactFailed: reason => `Compact context của main thất bại (${reason}); ALP sẽ thử lại sau.`,
  usageWarning: (runtime, used, resetsAt) => `${runtime} đã dùng ${used} hạn mức của kỳ này${resetsAt ? `, kỳ đặt lại lúc ${resetsAt}` : ''}.`,
  inDevelopment: 'Tính năng đang phát triển',
  resumed: (what, by, parked) => `${what} đã chạy lại, bởi ${by}.${parked ? ' Các việc đang tạm giữ được làm tiếp.' : ''}`,
  diskFull: reason => `Đĩa đầy: ${reason === 'the disk is full' ? 'đĩa hết dung lượng' : reason === 'the disk is read-only' ? 'đĩa chỉ đọc' : reason}. ALP đã tạm dừng công việc và tạm giữ các việc đang chạy; ALP vẫn trả lời. Hãy giải phóng dung lượng (alp doctor liệt kê các worktree còn sót); ALP kiểm tra mỗi phút và tự làm tiếp, hoặc chạy alp resume.`,
  diskLow: free => `Đĩa sắp đầy: còn ${free} trống. Hãy giải phóng dung lượng trước khi đầy (alp doctor liệt kê các worktree còn sót); khi đĩa đầy, ALP sẽ tạm dừng công việc.`,
  paused: (what, reason, runtime, now) =>
    `${what} đã bị người dùng tạm dừng${reason ? `: ${reason}` : ''}. Việc giao${runtime ? ` cho các agent ${runtime}` : ''} phải chờ${now ? ', các việc đang chạy được tạm giữ tại chỗ' : '; các lượt đang chạy vẫn chạy hết'}. Chạy alp resume để tiếp tục.`,
};

export function words(language: string): Words {
  return isVietnamese(language) ? vi : en;
}

/** Every label a choice may be answered with, in any language ALP writes. */
export const CHOICES = {
  trust: [en.trustYes, vi.trustYes].map(label => label.toLowerCase()),
  allowOnce: [en.allowOnce, vi.allowOnce].map(label => label.toLowerCase()),
  alwaysAllow: [en.alwaysAllow, vi.alwaysAllow].map(label => label.toLowerCase()),
  deny: [en.deny, vi.deny].map(label => label.toLowerCase()),
};

/** The line every agent reads about the user's language. */
export function languageInstruction(language: string, agent: string, main: boolean) {
  return main
    ? `The user reads ${language}. Write in ${language} everything the user reads: your replies, questions you ask with alp_ask (and their options), approval requests and what you say about them, gate notes, and the titles and descriptions of tasks you create. Briefs, handoffs and mail between agents may use any language. GitHub issues and comments follow the repository's language; tell the user about them in ${language}.`
    : agent === 'supervisor'
      ? `The user reads ${language}: main must write everything the user reads in ${language}.`
      : `The user reads ${language}. A question you put to the user with alp_ask, and its options, must be in ${language}; briefs, handoffs and mail between agents may use any language.`;
}
