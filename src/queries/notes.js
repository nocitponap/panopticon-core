import { query, queryOne } from '../db.js';
import * as p from '../params.js';
import * as dto from '../dto.js';

const LIVE = 200;

const COLS = `n.id, n.user, n.comment, n.html_comment, n.position, n.reply_id,
              n.observed_at, n.source, r.topic_id, r.topic_title, r.user AS reply_user`;

/**
 * List notes.
 *
 * A note has no time of its own — qbn.com does not expose when one was written
 * — so the only time it carries is `observed_at`, when the scraper saw it. Most
 * notes in the archive have no such time at all: 2.8M of them were recovered
 * from the deprecated replies.notes blob, which recorded the note but not when
 * it was read, and those carry NULL.
 *
 * As a feed this is ordered by observed_at DESC, which puts the undated
 * majority last rather than letting a 2008 note claim to be the newest thing on
 * the site. Asked for one reply's or one topic's notes it is not a feed at all,
 * so it orders by position — the order the notes appear under the reply.
 */
export async function list(opts = {}) {
    const lim = p.limit(opts.limit, 50, 200);
    const off = p.offset(opts.offset);

    const where = ['r.status = ?'];
    const params = [LIVE];

    if (opts.user) { where.push('n.user = ?'); params.push(p.username(opts.user)); }
    if (opts.reply_id) { where.push('n.reply_id = ?'); params.push(p.id(opts.reply_id, 'reply_id')); }
    if (opts.topic_id) { where.push('r.topic_id = ?'); params.push(p.id(opts.topic_id, 'topic_id')); }
    if (opts.days !== undefined && opts.days !== null && opts.days !== '') {
        const days = p.limit(opts.days, 7, 365);
        // NULL fails this comparison, so undated backfilled notes drop out of
        // any windowed query on their own. That is correct: we cannot say a
        // note was observed in the last N days when we do not know when it was.
        where.push('n.observed_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)');
        params.push(days);
    }

    // Listing one reply's or one topic's notes is a reading order, not a feed.
    const byPosition = Boolean(opts.reply_id || opts.topic_id);
    const order = byPosition
        ? 'n.reply_id ASC, n.position ASC, n.id ASC'
        : 'n.observed_at DESC, n.id DESC';

    const rows = await query(
        `SELECT ${COLS} FROM notes n JOIN replies r ON r.id = n.reply_id
         WHERE ${where.join(' AND ')}
         ORDER BY ${order}
         LIMIT ? OFFSET ?`,
        [...params, lim + 1, off]
    );

    const hasMore = rows.length > lim;
    return dto.page((hasMore ? rows.slice(0, lim) : rows).map(dto.note), {
        limit: lim, offset: off, has_more: hasMore
    });
}

export async function get(rawId) {
    const id = p.id(rawId, 'note id');
    const row = await queryOne(
        `SELECT ${COLS} FROM notes n JOIN replies r ON r.id = n.reply_id
         WHERE n.id = ? AND r.status = ?`,
        [id, LIVE]
    );
    if (!row) throw p.notFound(`Note ${id}`);
    return dto.note(row);
}
