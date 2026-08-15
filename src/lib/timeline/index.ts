/**
 * RiddimRoom Studio — timeline foundation barrel export.
 *
 * Re-exports the pieces of the timeline foundation (types, construction/
 * query utilities, validation, serialization) from one import path, e.g.
 * `import { createEmptyProject, validateProject } from '../lib/timeline'`.
 */

export * from '../../types/timeline';
export * from './utils';
export * from './validation';
export * from './serialization';
