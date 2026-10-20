/** Typed registry methods for portable clients. Mutations are sent once: callers retain requestId
 * and ifRevision to reconcile a timeout by repeating the identical request. @param {{request<T = any>(method: string, params?: unknown): Promise<T>}} client */
export function workspaceRegistry(client) {
  return {
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
