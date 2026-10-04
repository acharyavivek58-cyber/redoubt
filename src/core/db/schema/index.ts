/**
 * Schema barrel. Every table the application knows about is exported here so
 * Drizzle's migration generator sees a single, complete schema graph.
 */

export * from './core.js';
export * from './moderation.js';
export * from './economy.js';
export * from './features.js';
export * from './modules.js';