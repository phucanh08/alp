/** Typed registry methods for portable clients. Mutations are sent once: callers retain requestId
 * and ifRevision to reconcile a timeout by repeating the identical request. @param {{request<T = any>(method: string, params?: unknown): Promise<T>}} client */
export function workspaceRegistry(client) {
  return {
    /** @param {string} workspaceId @returns {Promise<import('@anhlp/alp-protocol').RpcMethodMap['workspace.worktree.options']['result']>} */
    worktreeOptions: workspaceId => client.request('workspace.worktree.options', { workspaceId }),
    /** @param {import('@anhlp/alp-protocol').RpcMethodMap['workspace.worktree.create']['params']} params @returns {Promise<import('@anhlp/alp-protocol').RpcMethodMap['workspace.worktree.create']['result']>} */
    createWorktree: params => client.request('workspace.worktree.create', params),
    /** @param {import('@anhlp/alp-protocol').RpcMethodMap['workspace.worktree.remove']['params']} params @returns {Promise<import('@anhlp/alp-protocol').RpcMethodMap['workspace.worktree.remove']['result']>} */
    removeWorktree: params => client.request('workspace.worktree.remove', params),
    /** Read-only Git status of a registry workspace (capability `workspace.git`, §12.5). @param {string} workspaceId @returns {Promise<import('@anhlp/alp-protocol').RpcMethodMap['workspace.git.status']['result']>} */
    gitStatus: workspaceId => client.request('workspace.git.status', { workspaceId }),
    /** One page of a read-only Git diff; pass `nextCursor` back as `cursor` with the same comparison and path. @param {import('@anhlp/alp-protocol').RpcMethodMap['workspace.git.diff']['params']} params @returns {Promise<import('@anhlp/alp-protocol').RpcMethodMap['workspace.git.diff']['result']>} */
    gitDiff: params => client.request('workspace.git.diff', params),
    /** @param {import('@anhlp/alp-protocol').RpcMethodMap['project.list']['params']} [params] @returns {Promise<import('@anhlp/alp-protocol').RpcMethodMap['project.list']['result']>} */
    projects: (params = {}) => client.request('project.list', params),
    /** @param {import('@anhlp/alp-protocol').RpcMethodMap['workspace.list']['params']} [params] @returns {Promise<import('@anhlp/alp-protocol').RpcMethodMap['workspace.list']['result']>} */
    workspaces: (params = {}) => client.request('workspace.list', params),
    /** @param {string} workspaceId @returns {Promise<import('@anhlp/alp-protocol').RpcMethodMap['workspace.get']['result']>} */
    get: workspaceId => client.request('workspace.get', { workspaceId }),
    /** @param {import('@anhlp/alp-protocol').RpcMethodMap['project.register']['params']} params @returns {Promise<import('@anhlp/alp-protocol').RpcMethodMap['project.register']['result']>} */
    register: params => client.request('project.register', params),
    /** @param {import('@anhlp/alp-protocol').RpcMethodMap['project.remove']['params']} params @returns {Promise<import('@anhlp/alp-protocol').RpcMethodMap['project.remove']['result']>} */
    remove: params => client.request('project.remove', params),
    /** @param {import('@anhlp/alp-protocol').RpcMethodMap['workspace.update']['params']} params @returns {Promise<import('@anhlp/alp-protocol').RpcMethodMap['workspace.update']['result']>} */
    update: params => client.request('workspace.update', params),
  };
}
