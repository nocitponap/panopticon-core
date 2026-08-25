import { query, queryOne } from '../db.js';
import * as p from '../params.js';
import * as dto from '../dto.js';

const LIVE = 200;

const COLS = `t.id AS topic_id, t.user, t.created_utc, t.date,
              pr.name, pr.location, pr.url, pr.avatar, pr.bio,
              pr.uncertified, pr.endorsement_status, pr.endorsed_by, pr.rip`;

const FROM = `topics t JOIN profiles pr ON pr.topic_id = t.id`;
const BASE = `WHERE t.topic_type = 'profile' AND t.status = ?`;

/**
 * Find profiles whose handle or display name matches a term.
 *
 * Shared by profile listing and user search, and written this way for two
 * measured reasons:
 *
 *   Two indexed lookups unioned, not one OR. `t.user LIKE ? OR pr.name LIKE ?`
 *   spans two tables, so neither index can be used and the query scans all
 *   154k profiles — 22s measured. As a UNION each branch uses its own index
 *   (topics.idx_user, profiles.idx_name).
 *
 *   Prefix first, contains only as a fallback. A leading wildcard defeats an
 *   index however the query is shaped, and nearly every real search ("who is
 *   defineipr") is a prefix.
 *
 * The two differ: `topics.user` is the handle, `profiles.name` is the display
 * name. 'defineipr' is 'Define IPR', so searching only one of them misses.
 */
export async function search(term, { limit = 20, columns = COLS } = {}) {
    const run = (pattern) => query(
        `(SELECT ${columns} FROM ${FROM} ${BASE} AND t.user LIKE ? LIMIT ?)
         UNION
         (SELECT ${columns} FROM ${FROM} ${BASE} AND pr.name LIKE ? LIMIT ?)`,
        [LIVE, pattern, limit, LIVE, pattern, limit]
    );

    const escaped = term.replace(/[\\%_]/g, (c) => `\\${c}`);
    let rows = await run(`${escaped}%`);
    if (!rows.length) rows = await run(`%${escaped}%`);

    // Exact handle first, then newest.
    return rows
        .sort((a, b) => (b.user === term) - (a.user === term) || b.topic_id - a.topic_id)
        .slice(0, limit);
}

/**
 * List profiles, newest first.
 *
 * Ordered by `t.id DESC` rather than by date: qbn.com assigns profile topic ids
 * in creation order, so this is both correct and index-ordered, where sorting
 * on created_utc would filesort.
 */
export async function list(opts = {}) {
    const lim = p.limit(opts.limit, 20, 100);
    const off = p.offset(opts.offset);
    const term = p.search(opts.search);

    if (term) {
        // Search is capped at one page: the fallback path scans, and paging
        // deep into a scan is a request to do it repeatedly.
        const rows = await search(term, { limit: lim });
        return dto.page(rows.map(dto.profile), {
            limit: lim, offset: 0, has_more: false, search: term
        });
    }

    const rows = await query(
        `SELECT ${COLS} FROM ${FROM} ${BASE} AND pr.status = ?
         ORDER BY t.id DESC LIMIT ? OFFSET ?`,
        [LIVE, LIVE, lim + 1, off]
    );

    const hasMore = rows.length > lim;
    return dto.page((hasMore ? rows.slice(0, lim) : rows).map(dto.profile), {
        limit: lim, offset: off, has_more: hasMore
    });
}

/** A profile by username or by topic id — both are how people refer to them. */
export async function get(key) {
    const numeric = /^\d+$/.test(String(key));
    const row = await queryOne(
        `SELECT ${COLS} FROM ${FROM}
         WHERE t.topic_type = 'profile' AND t.status = ? AND ${numeric ? 't.id = ?' : 't.user = ?'}
         LIMIT 1`,
        [LIVE, numeric ? p.id(key, 'topic id') : p.username(key)]
    );
    if (!row) throw p.notFound(`Profile ${key}`);
    return dto.profile(row);
}
