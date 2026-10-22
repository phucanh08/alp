// alpd's building blocks, for embedding and tests; src/daemon/main.ts is the daemon itself.
export { createDaemonServer, ERROR } from './server.js';
export type { DaemonConnection, DaemonServer, SessionSummary } from './server.js';
export { createStore } from './store.js';
export type { SessionRecord, SessionStatus, Store } from './store.js';
export { createScheduleStore, PROMPT_CHARS, SCHEDULE_ID, SCHEDULE_VERSION } from './schedules.js';
export type { ScheduleRecord, ScheduleStore } from './schedules.js';
export { createScheduler, duration, renderPrompt, SCHEDULE_GRACE_MS, SCHEDULE_TICK_MS } from './scheduler.js';
export type { ScheduleDelivery, Scheduler } from './scheduler.js';
export { attachmentLimits, attachmentName, createAttachmentStore, readAttachmentConfig, sniffMimeType } from './attachments.js';
export type { AttachmentReader, AttachmentRuntime, AttachmentStore, Principal } from './attachments.js';
