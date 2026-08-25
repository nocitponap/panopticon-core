/**
 * panopticon-core — the shared query layer over the QBN archive.
 *
 * Every SQL statement in the Panopticon project lives under ./queries.
 * `panoticon-api` is HTTP routing over this package; `panopticon-mcp` is MCP
 * tool definitions over it. Neither contains SQL, because when they did, they
 * drifted.
 *
 * See README.md for the invariants this package owns.
 */
export * as replies from './queries/replies.js';
export * as topics from './queries/topics.js';
export * as users from './queries/users.js';
export * as notes from './queries/notes.js';
export * as profiles from './queries/profiles.js';
export * as nt from './queries/nt.js';
export * as homepage from './queries/homepage.js';
export * as stats from './queries/stats.js';
export * as overview from './queries/overview.js';

export { QueryError } from './params.js';
export { WINDOWS, WINDOW_NAMES, resolveWindow } from './windows.js';
export { replyUrl, topicUrl } from './dto.js';
export { getPool, closePool, query } from './db.js';
