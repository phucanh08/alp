import type { SessionInboundMessage, SessionOutboundMessage } from '@getpaseo/protocol/messages';
import type { Handler } from './gateway.js';

/**
 * What the app reads by itself, all the time, for features ALP has not got yet: project icons,
 * workspace setup, a draft agent's provider features. The daemon's config is relay.ts's.
 * A refusal there would make the app retry and log errors without the user doing anything, so
 * these get the empty answer a daemon without that feature would give (ALPD §62). What the user
 * asks for by hand still answers "in development".
 */

type Inbound<T extends SessionInboundMessage['type']> = Extract<SessionInboundMessage, { type: T }>;
type Outbound = SessionOutboundMessage;

export const quietHandlers: Record<string, Handler> = {
  project_icon_request: (message: Inbound<'project_icon_request'>) =>
    ({ type: 'project_icon_response', payload: { requestId: message.requestId, cwd: message.cwd, icon: null, error: null } }) satisfies Outbound,

  workspace_setup_status_request: (message: Inbound<'workspace_setup_status_request'>) =>
    ({ type: 'workspace_setup_status_response', payload: { requestId: message.requestId, workspaceId: message.workspaceId, snapshot: null } }) satisfies Outbound,

  list_provider_features_request: (message: Inbound<'list_provider_features_request'>) =>
    ({ type: 'list_provider_features_response', payload: { requestId: message.requestId, provider: message.draftConfig.provider, features: [], error: null, fetchedAt: new Date().toISOString() } }) satisfies Outbound,
};
