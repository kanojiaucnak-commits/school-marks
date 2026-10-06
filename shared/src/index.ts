export * from './constants.js';
export * from './permissions.js';
export * from './types.js';
export * from './utils.js';
// Schemas are also re-exported as a namespace so consumers can write either
// `import { loginSchema } from '@school/shared'` or `schemas.loginSchema`.
export * from './schemas/index.js';
export * as schemas from './schemas/index.js';