// The buttons answer the main process with a navigation it stops and reads (src/install.ts confirmAction).
const nonce = new URLSearchParams(location.search).get('nonce') || '';
const answer = action => `alp-page://app/confirm?${new URLSearchParams({ action, nonce })}`;
document.getElementById('install-button').href = answer('install');
document.getElementById('cancel-button').href = answer('cancel');
