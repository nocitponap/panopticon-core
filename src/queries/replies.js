import { query, queryOne } from '../db.js';
import * as p from '../params.js';
import * as dto from '../dto.js';
import { resolveWindow, instantClause } from '../windows.js';

// Tombstones — 250,781 deleted replies with empty bodies and unusable
// timestamps — are not archive content. Nothing here ever returns them.
const LIVE = 200;

// The blob column `notes` is deliberately not selected. See dto.reply().
const COLS = `r.id, r.created, r.user, r.topic_id, r.topic_title,
              r.post, r.score, r.reply_number`;

/**
 * Fetch the notes for a set of replies in one round trip and group them by
 * reply. Cheaper and more accurate than the alternatives: a per-row correlated
 * subquery costs a lookup per reply, and the denormalised `replies.notes` blob
 * is a second source of truth that has already gone stale (the 2021 notes are
 * missing from it).
 */
export async function notesFor(replyIds) {
    const grouped = new Map(replyIds.map((id) => [id, []]));
    if (replyIds.length === 0) return grouped;

    const rows = await query(
        // position is where a note stood when we first saw it. Notes deleted
        // from qbn.com are kept, so this is the archive's order, not today's.
        `SELECT id, user, comment, html_comment, position, reply_id, observed_at, source
         FROM notes WHERE reply_id IN (?) ORDER BY reply_id, position ASC`,
        [replyIds]
    );
    for (const row of rows) grouped.get(row.reply_id)?.push(dto.note(row));
    return grouped;
}

async function withNotes(rows) {
    const notes = await notesFor(rows.map((r) => r.id));
    return rows.map((r) => dto.reply(r, { notes: notes.get(r.id) || [] }));
}

/**
 * List replies.
 *
 * `notes: true` attaches every reply's notes from the `notes` table — the join
 * the Observable notebooks currently do by hand, and get wrong.
 */
export async function list(opts = {}) {
    const lim = p.limit(opts.limit, 50, 200);
    const off = p.offset(opts.offset);
    const sort = p.oneOf(opts.sort, ['recent', 'oldest'], 'recent', 'sort');
    const win = resolveWindow(opts);

    const where = ['r.status = ?'];
    const params = [LIVE];

    if (opts.user !== undefined && opts.user !== null && opts.user !== '') {
        where.push('r.user = ?');
        params.push(p.username(opts.user));
    }
    if (opts.topic_id !== undefined && opts.topic_id !== null && opts.topic_id !== '') {
        where.push('r.topic_id = ?');
        params.push(p.id(opts.topic_id, 'topic_id'));
    }

    const range = instantClause('r.created', win);
    if (range.clause) { where.push(range.clause); params.push(...range.params); }

    // Without a window there is no lower bound on `created`, and the zero dates
    // that survive on a handful of live rows would sort to the front.
    if (!win.from) where.push("r.created > '2000-01-01'");

    // Fetch one extra row to answer has_more without a COUNT over 3.9M rows.
    const rows = await query(
        `SELECT ${COLS} FROM replies r
         WHERE ${where.join(' AND ')}
         ORDER BY r.created ${sort === 'oldest' ? 'ASC' : 'DESC'}
         LIMIT ? OFFSET ?`,
        [...params, lim + 1, off]
    );

    const hasMore = rows.length > lim;
    const pageRows = hasMore ? rows.slice(0, lim) : rows;
    const data = opts.notes ? await withNotes(pageRows) : pageRows.map((r) => dto.reply(r));

    return dto.page(data, { limit: lim, offset: off, has_more: hasMore, window: win.label });
}

/** A single reply with its notes. */
export async function get(rawId) {
    const id = p.id(rawId, 'reply id');
    const row = await queryOne(
        `SELECT ${COLS} FROM replies r WHERE r.id = ? AND r.status = ?`, [id, LIVE]
    );
    if (!row) throw p.notFound(`Reply ${id}`);

    const notes = await notesFor([id]);
    return dto.reply(row, { notes: notes.get(id) || [] });
}
