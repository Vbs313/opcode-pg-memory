/**
 * Plugin entry point — re-exports from src/index.ts
 * 
 * OpenCode loads plugins from `dist/index.js`.
 * The actual plugin logic lives in `src/index.ts`.
 */
export * from './src/index';
export { default } from './src/index';
