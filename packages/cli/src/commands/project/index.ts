// The project group as the package's `./projects` subpath exports it; each command has its own file
// (alp config, in config.ts, was never part of that subpath).
export { project } from './init.js';
export { permissionsCommand } from './permissions.js';
export { trustCommand } from './trust.js';
export { language } from './language.js';
export { verify } from './verify.js';
export { doctor } from './doctor.js';
