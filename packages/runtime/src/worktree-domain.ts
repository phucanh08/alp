import { realpathSync } from 'node:fs';
import path from 'node:path';
import { describeVerification, runVerify, verifyConfig, type Verification, type VerifyConfig } from '@anhlp/alp-core/verify';
import { recordVerification, loadTasks } from '@anhlp/alp-core/tasks';
import { checkoutFingerprint, checkoutKey, commitWorktree, linkModules, mergeWorktree, removeWorktree, type Worktree, type WorktreeChange } from './workspace.js';
import { writes } from './catalog.js';
import { nativeEnvironment } from './providers.js';
import { mainOf } from './tools.js';
import { errorData, plainObject, toolResult } from './tool-results.js';
import type { RuntimeOptions } from './contracts.js';
import type { Session, Assignment } from './session-state.js';

type WorktreeContext = {
  options: RuntimeOptions;
  releaseResult(assignmentId: string): Promise<void>;
  leases: Map<string, { assignment: string; agent: string }>;
  rootOf(sessionId: string): string;
  lineage(sessionId: string): string[];
  runLog(rootId: string, entry: Record<string, unknown>): void;
  runHooks(sessionId: string, session: Session, event: string, details?: Record<string, unknown>, taskId?: string): Promise<string | undefined>;
  touchTask(rootId: string, id: string): void;
};

/** Checkout mutation and verification retain one shared queue per checkout. */
export function createWorktreeDomain({ options, leases, releaseResult, rootOf, lineage, runLog, runHooks, touchTask }: WorktreeContext) {
  const merging = new Map<string, Promise<unknown>>();

  /** Commits a finished isolated assignment's work and keeps it for the requester to merge. */
  async function settleWorktree(parentId: string, parent: Session, assignment: Assignment) {
    const worktree = assignment.worktree!;
    try {
      const change = await commitWorktree(worktree, `alp: ${assignment.agent} assignment ${assignment.id}`);
      if (!change.files.length) {
        await removeWorktree(worktree, { deleteBranch: true });
        await releaseResult(assignment.id);
        return { branch: worktree.branch, files: [], note: 'No changes; the worktree was removed' };
      }
      const described = { branch: worktree.branch, base: worktree.base, commit: change.commit, files: change.files, stat: change.stat };
      if (parent.closed) {
        await removeWorktree(worktree);
        runLog(rootOf(parentId), { event: 'worktree.kept', assignmentId: assignment.id, branch: worktree.branch });
        return { ...described, note: 'The requester closed; the change stays on the branch' };
      }
      parent.worktrees.set(assignment.id, { agent: assignment.agent, worktree, change, ...(assignment.taskId ? { taskId: assignment.taskId } : {}) });
      return { ...described, next: 'Apply it with alp_merge, or drop it with alp_discard' };
    } catch (error) {
      await removeWorktree(worktree).catch(() => {});
      return { branch: worktree.branch, error: errorData(error).message };
    }
  }

  async function worktreeTool(sessionId: string, session: Session, args: unknown, action: 'merge' | 'discard') {
    if (!plainObject(args, ['assignmentId', 'skipVerify']) || typeof args.assignmentId !== 'string' ||
      (args.skipVerify !== undefined && (action !== 'merge' || typeof args.skipVerify !== 'string' || !args.skipVerify.trim()))) {
      return toolResult(false, { error: action === 'merge' ? 'assignmentId is required; skipVerify, when given, says why to merge without verification' : 'assignmentId is required' });
    }
    const pending = session.worktrees.get(args.assignmentId);
    if (!pending) {
      return toolResult(false, { error: session.assignments.has(args.assignmentId) ? 'The assignment is still running; wait for its result' : 'No unmerged worktree change with that assignment id' });
    }
    const { worktree, change } = pending;
    if (action === 'discard') {
      session.worktrees.delete(args.assignmentId);
      await removeWorktree(worktree, { deleteBranch: true });
      await releaseResult(args.assignmentId);
      runLog(rootOf(sessionId), { event: 'worktree.discarded', assignmentId: args.assignmentId, branch: worktree.branch });
      return toolResult(true, { discarded: args.assignmentId, branch: worktree.branch });
    }
    if (!writes(session.mapping.mode)) return toolResult(false, { error: 'Merging needs workspace-write or full-access' });
    if ([...session.assignments.values()].some(assignment => assignment.mode !== 'read-only' && assignment.isolation === 'shared')) {
      return toolResult(false, { error: 'A writer assignment is working in this checkout; merge after its result' });
    }
    // Claimed before any await, so a repeated call cannot merge it twice.
    session.worktrees.delete(args.assignmentId);
    const checkout = await checkoutKey(session.mapping.workdir);
    const holder = leases.get(checkout);
    if (holder && !lineage(sessionId).includes(holder.assignment)) {
      session.worktrees.set(args.assignmentId, pending);
      return toolResult(false, { error: `${holder.agent} in another session is writing this checkout; merge after it finishes` });
    }
    const project = session.mapping.agent.projectRoot;
    const rootId = rootOf(sessionId);
    let config: VerifyConfig | undefined;
    try { config = await verifyConfig(project); }
    catch (error) {
      session.worktrees.set(args.assignmentId, pending);
      return toolResult(false, { error: errorData(error).message });
    }
    let verified: Verification | undefined;
    if (config && args.skipVerify === undefined) {
      const verification = verified = await verifyIn(project, worktreeDirectory(worktree, project), config);
      noteVerification(rootId, project, pending.taskId, args.assignmentId, 'worktree', verification);
      if (!verification.passed) {
        session.worktrees.set(args.assignmentId, { ...pending, verification });
        return toolResult(false, {
          assignmentId: args.assignmentId,
          error: `${describeVerification(verification)} in the assignment's worktree; nothing was applied`,
          verification: verificationResult(verification),
          branch: worktree.branch,
          next: verification.skipped
            ? 'The check could not run, which says nothing about the change; call alp_merge again, or alp_merge it with skipVerify saying why'
            : `Delegate again with continueFrom "${args.assignmentId}"${pending.taskId ? ` and taskId ${pending.taskId}` : ''} to fix it in a worktree that starts from this change; or alp_discard it; or alp_merge it with skipVerify saying why`,
        });
      }
    } else if (config && pending.taskId) {
      await recordVerification(project, pending.taskId, { passed: false, skipped: args.skipVerify }, session.mapping.agent.name).catch(() => {});
      runLog(rootId, { event: 'verify', assignmentId: args.assignmentId, where: 'worktree', skipped: args.skipVerify });
    }
    // A blocking merge hook can refuse the change before anything is applied.
    const refused = await runHooks(sessionId, session, 'merge', { assignment: args.assignmentId, branch: worktree.branch }, pending.taskId);
    if (refused) {
      session.worktrees.set(args.assignmentId, pending);
      return toolResult(false, { assignmentId: args.assignmentId, error: `A merge hook refused it; nothing was applied:\n${refused}`, branch: worktree.branch, next: `Fix what it reports in a new assignment with continueFrom "${args.assignmentId}", or alp_discard it` });
    }
    let merged: Awaited<ReturnType<typeof mergeWorktree>>;
    let moved = false;
    try {
      ({ merged, moved } = await inCheckout(checkout, async () => {
        const before = await checkoutFingerprint(worktree.checkout).catch(() => undefined);
        return { merged: await mergeWorktree(worktree, change), moved: !worktree.fingerprint || before !== worktree.fingerprint };
      }));
    } catch (error) {
      session.worktrees.set(args.assignmentId, pending);
      return toolResult(false, { error: errorData(error).message, branch: worktree.branch, next: 'Merge the branch yourself, or alp_discard it' });
    }
    // A conflicted change keeps its branch for reference.
    await removeWorktree(worktree, { deleteBranch: merged.status !== 'conflicts' });
    if (merged.status !== 'conflicts') await releaseResult(args.assignmentId);
    runLog(rootId, { event: 'worktree.merged', assignmentId: args.assignmentId, branch: worktree.branch, ...merged });
    // The checkout changed since the assignment started, so the worktree's check says little about the result: check the checkout too.
    let checked: Verification | undefined;
    if (config && args.skipVerify === undefined && merged.status === 'applied' && moved) {
      checked = await inCheckout(checkout, () => verifyIn(project, session.mapping.workdir, config!));
      noteVerification(rootId, project, pending.taskId, args.assignmentId, 'checkout', checked);
    }
    return toolResult(true, {
      assignmentId: args.assignmentId,
      ...merged,
      ...(merged.status === 'conflicts' ? { branch: worktree.branch } : {}),
      ...(verified ? { verification: verificationResult(checked ?? verified), ...(checked ? { verifiedIn: 'your checkout, which changed since the assignment started' } : {}) } : {}),
      ...(args.skipVerify !== undefined && config ? { verification: { skipped: args.skipVerify } } : {}),
      next: merged.status === 'conflicts' ? `Resolve the conflict markers in the listed files, then verify${config ? ' with alp_verify' : ''}`
        : checked && !checked.passed ? `The change passed in its worktree but ${describeVerification(checked)} in your checkout, which changed meanwhile; fix it, then run alp_verify`
        : 'Review the applied change; it is not committed',
    });
  }

  /** Work on a checkout, one at a time: merges and the verify runs that check them. */
  function inCheckout<T>(checkout: string, work: () => Promise<T>): Promise<T> {
    const previous = merging.get(checkout) ?? Promise.resolve();
    const attempt = previous.catch(() => {}).then(work);
    merging.set(checkout, attempt);
    void attempt.finally(() => { if (merging.get(checkout) === attempt) merging.delete(checkout); }).catch(() => {});
    return attempt;
  }

  /** The directory in a worktree that corresponds to the project root. */
  function worktreeDirectory(worktree: Worktree, project: string) {
    let real = project;
    try { real = realpathSync(project); } catch {}
    return path.join(worktree.path, path.relative(worktree.checkout, real));
  }

  /** Runs the project's verify commands in `directory`; a worktree borrows the project's node_modules for the run. */
  async function verifyIn(project: string, directory: string, config: VerifyConfig) {
    const same = path.resolve(directory) === path.resolve(project);
    const unlinkModules = same ? async () => {} : await linkModules(project, directory).catch(() => async () => {});
    try {
      return await runVerify(directory, config, { env: nativeEnvironment(options) });
    } finally {
      await unlinkModules();
    }
  }

  /** What an agent sees of a verification: each step's exit code and time, and the end of a failed step's output. */
  function verificationResult(verification: Verification | { passed: boolean; commands: Array<Record<string, any>>; cwd?: string; skipped?: string }) {
    const failed = verification.commands.find(command => command.exitCode !== 0);
    return {
      passed: verification.passed,
      ...(verification.skipped ? { skipped: verification.skipped } : {}),
      steps: verification.commands.map(({ step, command, exitCode, ms, timedOut, idle }) => ({ step, command, exitCode, ms, ...(timedOut ? { timedOut } : {}), ...(idle ? { idle } : {}) })),
      ...(failed?.output ? { output: failed.output } : {}),
    };
  }

  /** Logs a verification, and records it on the task it counts for. */
  function noteVerification(rootId: string, project: string, taskId: string | undefined, assignmentId: string | undefined, where: 'worktree' | 'checkout', verification: Verification) {
    runLog(rootId, { event: 'verify', ...(assignmentId ? { assignmentId } : {}), ...(taskId ? { taskId } : {}), where, passed: verification.passed, detail: describeVerification(verification) });
    if (taskId) void recordVerification(project, taskId, { ...verification, where }, 'alpd').then(() => touchTask(rootId, taskId), () => {});
  }

  /** The start of the brief of an assignment that continues an earlier worktree change. */
  function continuedBrief(from: string, continued: { agent: string; change: WorktreeChange; verification?: Verification }) {
    const failed = continued.verification?.commands.find(command => command.exitCode !== 0);
    return `Your worktree starts from the change of ${continued.agent}'s assignment ${from}, committed on your branch (${continued.change.files.length} files: ${continued.change.files.slice(0, 20).join(', ')}). Build on it rather than starting over.` +
      (continued.verification && !continued.verification.passed
        ? ` The project's checks failed on it: ${describeVerification(continued.verification)}, running \`${failed?.command}\`. The end of its output:\n${failed?.output.slice(-1500) ?? ''}`
        : '');
  }

  async function verifyTool(sessionId: string, session: Session, args: unknown) {
    if (!plainObject(args, ['taskId']) || (args.taskId !== undefined && typeof args.taskId !== 'string')) return toolResult(false, { error: 'alp_verify takes only taskId' });
    if (args.taskId !== undefined && (session.parent || session.mapping.agent.name !== mainOf(session.mapping))) return toolResult(false, { error: 'Only main records a verification on a task; call alp_verify without taskId' });
    const project = session.mapping.agent.projectRoot;
    let config: VerifyConfig | undefined;
    try { config = await verifyConfig(project); } catch (error) { return toolResult(false, { error: errorData(error).message }); }
    if (!config) return toolResult(false, { error: 'This project has no verify commands (verify in .alp/settings.json); run its checks yourself' });
    if (args.taskId !== undefined) {
      const task = (await loadTasks(project)).tasks.find(entry => entry.id === args.taskId);
      if (!task) return toolResult(false, { error: `No task ${args.taskId}` });
      if (task.status === 'closed') return toolResult(false, { error: `${args.taskId} is closed` });
    }
    const checkout = await checkoutKey(session.mapping.workdir);
    const verification = await inCheckout(checkout, () => verifyIn(project, session.mapping.workdir, config!));
    noteVerification(rootOf(sessionId), project, args.taskId, undefined, 'checkout', verification);
    return toolResult(true, { ...verificationResult(verification), summary: describeVerification(verification), ...(args.taskId ? { recordedOn: args.taskId } : {}) });
  }

  return { settleWorktree, worktreeTool, inCheckout, verifyIn, verificationResult, noteVerification, continuedBrief, verifyTool };
}
