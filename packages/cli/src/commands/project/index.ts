// The project group as the package's `./projects` subpath exports it; each command has its own file
// (alp config, in config.ts, was never part of that subpath).
export { project } from './init.ts';
export { permissionsCommand } from './permissions.ts';
export { trustCommand } from './trust.ts';
export { language } from './language.ts';
export { verify } from './verify.ts';
export { doctor } from './doctor.ts';
