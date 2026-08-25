import { query, queryOne } from '../db.js';
import * as p from '../params.js';
import { QueryError } from '../params.js';
import * as dto from '../dto.js';
import { resolveWindow, dayClause, instantClause } from '../windows.js';
import { notesFor } from './replies.js';

const LIVE = 200;
const TYPES = ['thread', 'profile', 'nt'];
const SORTS = ['recent', 'oldest', 'replies', 'notes', 'users', 'active'];

const COLS = `t.id, t.title, t.date, t.created_utc, t.user, t.topic_type, t.post`;

// Windows up to this length are ranked exactly from `replies`: idx_created makes
// the range scan small, so there is no reason to approximate. Beyond it we fall
// back to the daily rollup, which can sum replies exactly but cannot recover a
// distinct-user count (a user posting on three days appears three times).
const EXACT_WINDOW_DAYS = 90;

function windowDays({ from, toExclusive }) {
    if (!from || !toExclusive) return Infinity;
    return Math.round(
        (new Date(`${toExclusive}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000
    );
}

/**
 * The ranking sub-select for a windowed sort, plus its bound parameters.
 *
 * Three metrics, three honest answers rather than one plausible-looking number:
 *
 *   replies  exact at any window length — from `replies` when the range is
 *            short, from SUM(stats_topic_day.replies) when it is long.
 *   users    exact only from the raw table, so it is offered up to
 *            EXACT_WINDOW_DAYS and refused beyond it.
 *   notes    not offered windowed at all. Half of all notes carry the
 *            2024-04-23 bulk-import timestamp, so "notes in 2015" is not a
 *            measurement. Use window=all, which counts notes per topic without
 *            reference to when they were written.
 */
function rankingSource(sort, win) {
    const days = windowDays(win);

    if (sort === 'notes') {
        throw new QueryError(
            'sort=notes is only available with window=all — note timestamps are ' +
            'scrape times and half the archive shares one bulk-import stamp, so a ' +
            'windowed note ranking would not mean anything'
        );
    }

    if (sort === 'users' && days > EXACT_WINDOW_DAYS) {
        throw new QueryError(
            `sort=users is available for windows up to ${EXACT_WINDOW_DAYS} days, or window=all. ` +
            'Longer windows cannot be answered exactly from the daily rollup.'
        );
    }

    if (days <= EXACT_WINDOW_DAYS) {
        const range = instantClause('created', win);
        const metric = sort === 'users' ? 'COUNT(DISTINCT user)' : 'COUNT(*)';
        return {
            sql: `SELECT topic_id, ${metric} AS n
                  FROM replies
                  WHERE status = ? AND topic_id IS NOT NULL AND ${range.clause}
                  GROUP BY topic_id ORDER BY n DESC LIMIT 2000`,
            params: [LIVE, ...range.params]
        };
    }

    const day = dayClause('day', win);
    return {
        sql: `SELECT topic_id, SUM(replies) AS n
              FROM stats_topic_day WHERE ${day.clause}
              GROUP BY topic_id ORDER BY n DESC LIMIT 2000`,
        params: day.params
    };
}

/**
 * List topics.
 *
 * `sort` by replies/notes/users reads `topic_stats` (lifetime, maintained by
 * the rollup job) or `stats_topic_day` (windowed). This is what replaces
 * /topics/by-post-count, /topics/by-note-count and /topics/by-user-count — the
 * last of which aggregated 1.95M rows per request and timed out after two
 * minutes.
 */
export async function list(opts = {}) {
    const lim = p.limit(opts.limit, 20, 100);
    const off = p.offset(opts.offset);
    const sort = p.oneOf(opts.sort, SORTS, 'recent', 'sort');
    const type = p.oneOf(opts.type, TYPES, null, 'type');
    const term = p.search(opts.search);
    const windowed = opts.window !== undefined || opts.from !== undefined || opts.to !== undefined;
    const win = resolveWindow(windowed ? opts : { window: 'all' });

    const where = ['t.status = ?'];
    const params = [LIVE];

    if (type) { where.push('t.topic_type = ?'); params.push(type); }
    if (opts.user !== undefined && opts.user !== null && opts.user !== '') {
        where.push('t.user = ?');
        params.push(p.username(opts.user));
    }
    if (term) { where.push('t.title LIKE ?'); params.push(p.likeTerm(term)); }

    const ranked = sort === 'replies' || sort === 'notes' || sort === 'users';

    let sql;
    let sqlParams;

    if (ranked && win.from) {
        const src = rankingSource(sort, win);
        sql = `
            SELECT ${COLS}, s.reply_count, s.note_count, s.user_count,
                   s.first_reply_at, s.last_reply_at, agg.n AS window_count
            FROM (${src.sql}) agg
            JOIN topics t ON t.id = agg.topic_id
            LEFT JOIN topic_stats s ON s.topic_id = t.id
            WHERE ${where.join(' AND ')}
            ORDER BY agg.n DESC, t.id DESC
            LIMIT ? OFFSET ?`;
        sqlParams = [...src.params, ...params, lim + 1, off];
    } else if (ranked) {
        const column = { replies: 's.reply_count', notes: 's.note_count', users: 's.user_count' }[sort];
        sql = `
            SELECT ${COLS}, s.reply_count, s.note_count, s.user_count,
                   s.first_reply_at, s.last_reply_at
            FROM topic_stats s
            JOIN topics t ON t.id = s.topic_id
            WHERE ${where.join(' AND ')}
            ORDER BY ${column} DESC, t.id DESC
            LIMIT ? OFFSET ?`;
        sqlParams = [...params, lim + 1, off];
    } else {
        const range = dayClause('DATE(t.created_utc)', win);
        if (range.clause) { where.push(range.clause); params.push(...range.params); }

        const order = {
            recent: 't.created_utc DESC',
            oldest: 't.created_utc ASC',
            active: 's.last_reply_at DESC'
        }[sort];

        sql = `
            SELECT ${COLS}, s.reply_count, s.note_count, s.user_count,
                   s.first_reply_at, s.last_reply_at
            FROM topics t
            LEFT JOIN topic_stats s ON s.topic_id = t.id
            WHERE ${where.join(' AND ')}
            ORDER BY ${order}, t.id DESC
            LIMIT ? OFFSET ?`;
        sqlParams = [...params, lim + 1, off];
    }

    const rows = await query(sql, sqlParams);
    const hasMore = rows.length > lim;
    const data = (hasMore ? rows.slice(0, lim) : rows).map((t) => dto.topic(t, { stats: t }));

    return dto.page(data, {
        limit: lim, offset: off, has_more: hasMore, sort, window: win.label
    });
}

/** A topic with a page of its replies, notes attached. */
export async function get(rawId, opts = {}) {
    const id = p.id(rawId, 'topic id');
    const lim = p.limit(opts.limit, 50, 200);
    const off = p.offset(opts.offset);

    const t = await queryOne(
        `SELECT ${COLS}, s.reply_count, s.note_count, s.user_count,
                s.first_reply_at, s.last_reply_at
         FROM topics t LEFT JOIN topic_stats s ON s.topic_id = t.id
         WHERE t.id = ? AND t.status = ?`,
        [id, LIVE]
    );
    if (!t) throw p.notFound(`Topic ${id}`);

    const where = ['r.topic_id = ?', 'r.status = ?'];
    const params = [id, LIVE];
    if (opts.user !== undefined && opts.user !== null && opts.user !== '') {
        where.push('r.user = ?');
        params.push(p.username(opts.user));
    }

    const rows = await query(
        `SELECT r.id, r.created, r.user, r.topic_id, r.topic_title,
                r.post, r.score, r.reply_number
         FROM replies r WHERE ${where.join(' AND ')}
         ORDER BY r.reply_number ASC LIMIT ? OFFSET ?`,
        [...params, lim + 1, off]
    );

    const hasMore = rows.length > lim;
    const pageRows = hasMore ? rows.slice(0, lim) : rows;
    const notes = await notesFor(pageRows.map((r) => r.id));
    const replies = pageRows.map((r) => dto.reply(r, { notes: notes.get(r.id) || [] }));

    const out = dto.topic(t, { stats: t, replies });
    out.replies_meta = { limit: lim, offset: off, count: replies.length, has_more: hasMore };
    return out;
}
