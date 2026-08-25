/**
 * Parameter validation and clamping.
 *
 * Callers (HTTP routes, MCP tools) hand raw user input straight to the query
 * functions; everything is normalised here so the two front-ends cannot drift
 * in what they accept.
 */

/** A caller-fixable problem. Front-ends map this to HTTP 400 / an MCP error. */
export class QueryError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.name = 'QueryError';
        this.status = status;
    }
}

export function notFound(what) {
    return new QueryError(`${what} not found`, 404);
}

/** Clamp a limit into [1, max], defaulting when absent or unparseable. */
export function limit(value, def, max) {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n)) return def;
    return Math.min(Math.max(1, n), max);
}

/** Non-negative offset, defaulting to 0. */
export function offset(value) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

/** A positive integer id, or throw. */
export function id(value, what = 'id') {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n) || n < 1) {
        throw new QueryError(`Invalid ${what}: expected a positive integer`);
    }
    return n;
}

/**
 * A username, length-capped and nothing more.
 *
 * Deliberately NOT pattern-validated. Real QBN usernames include '#1', '.....',
 * '&hearts;' and '&#9827;' — 55 accounts were unreachable through the old API
 * because its regex only allowed [a-zA-Z0-9_-]. Injection is prevented by bound
 * parameters; a character allowlist here buys nothing and loses users.
 */
export function username(value) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new QueryError('Username is required');
    }
    if (value.length > 30) {
        throw new QueryError('Username is too long (max 30 characters)');
    }
    return value;
}

/** A YYYY-MM-DD date, returned unchanged, or throw. */
export function date(value, what = 'date') {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new QueryError(`Invalid ${what}: expected YYYY-MM-DD`);
    }
    if (Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())) {
        throw new QueryError(`Invalid ${what}: not a real date`);
    }
    return value;
}

/** One of `allowed`, defaulting when absent. */
export function oneOf(value, allowed, def, what = 'value') {
    if (value === undefined || value === null || value === '') return def;
    if (!allowed.includes(value)) {
        throw new QueryError(`Invalid ${what}: expected one of ${allowed.join(', ')}`);
    }
    return value;
}

/** A free-text search term: trimmed, length-capped, min 2 chars. */
export function search(value) {
    if (value === undefined || value === null || value === '') return null;
    const s = String(value).trim().slice(0, 200);
    if (s.length < 2) {
        throw new QueryError('Search term must be at least 2 characters');
    }
    return s;
}

/** Escape LIKE wildcards so a search for "100%" does not match everything. */
export function likeTerm(value) {
    return `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
