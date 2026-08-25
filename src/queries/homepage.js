import { query, queryOne } from '../db.js';
import * as p from '../params.js';
import * as dto from '../dto.js';
import { resolveWindow, instantClause } from '../windows.js';

const LIVE = 200;

/**
 * The identity of a snapshot is `homepage.snapshot_id`, and its time is
 * `homepage.scraped_at`.
 *
 * Deliberately not `homepage_snapshots`: that table's `id` is a local
 * AUTO_INCREMENT that diverged from the remote database whenever a best-effort
 * mirror write was dropped, so backfilled snapshots carry ids newer than
 * snapshots that are chronologically older. Ordering on the id would return a
 * stale front page. `homepage.scraped_at` is a real instant on both sides.
 */
const LATEST = `SELECT snapshot_id AS id, scraped_at
                FROM homepage ORDER BY scraped_at DESC LIMIT 1`;

const ENTRY_COLS = `h.position, h.score, h.notes_count, h.reply_id,
                    r.id, r.created, r.user, r.topic_id, r.topic_title, r.post,
                    r.score AS reply_score, r.reply_number`;

async function entriesFor(snapshotId) {
    const rows = await query(
        `SELECT ${ENTRY_COLS}
         FROM homepage h LEFT JOIN replies r ON r.id = h.reply_id AND r.status = ?
         WHERE h.snapshot_id = ? ORDER BY h.position ASC`,
        [LIVE, snapshotId]
    );
    return rows.map(dto.homepageEntry);
}

/** The current front page, or the snapshot nearest a given instant. */
export async function latest(opts = {}) {
    let snap;
    if (opts.at) {
        const at = p.date(opts.at, 'at');
        snap = await queryOne(
            `SELECT snapshot_id AS id, scraped_at FROM homepage
             WHERE scraped_at < ? ORDER BY scraped_at DESC LIMIT 1`,
            [`${at} 23:59:59`]
        );
    } else {
        snap = await queryOne(LATEST);
    }
    if (!snap) throw p.notFound('Homepage snapshot');

    return {
        snapshot_id: snap.id,
        scraped_at: dto.toIso(snap.scraped_at),
        entries: await entriesFor(snap.id)
    };
}

/**
 * Snapshot history — always the same shape.
 *
 * The old endpoint returned two entirely different item shapes from one path
 * depending on whether `reply_id` was passed. A reply's front-page career is a
 * different question, so it is a different function: `forReply`.
 */
export async function history(opts = {}) {
    const lim = p.limit(opts.limit, 50, 500);
    const off = p.offset(opts.offset);
    const win = resolveWindow(opts.window || opts.from || opts.to ? opts : { window: '7d' });
    const range = instantClause('scraped_at', win);

    const rows = await query(
        `SELECT snapshot_id AS id, MIN(scraped_at) AS scraped_at, COUNT(*) AS entry_count
         FROM homepage ${range.clause ? `WHERE ${range.clause}` : ''}
         GROUP BY snapshot_id ORDER BY scraped_at DESC LIMIT ? OFFSET ?`,
        [...range.params, lim + 1, off]
    );

    const hasMore = rows.length > lim;
    const data = (hasMore ? rows.slice(0, lim) : rows).map((r) => ({
        snapshot_id: r.id,
        scraped_at: dto.toIso(r.scraped_at),
        entry_count: Number(r.entry_count)
    }));

    return dto.page(data, { limit: lim, offset: off, has_more: hasMore, window: win.label });
}

/** How long a reply stayed on the front page, and at what position. */
export async function forReply(rawId, opts = {}) {
    const id = p.id(rawId, 'reply id');
    const lim = p.limit(opts.limit, 500, 5000);

    const rows = await query(
        `SELECT scraped_at, position, score, notes_count
         FROM homepage WHERE reply_id = ? ORDER BY scraped_at ASC LIMIT ?`,
        [id, lim]
    );
    if (!rows.length) throw p.notFound(`Reply ${id} on the front page`);

    return {
        reply_id: id,
        url: dto.replyUrl(id),
        first_seen: dto.toIso(rows[0].scraped_at),
        last_seen: dto.toIso(rows[rows.length - 1].scraped_at),
        snapshots: rows.length,
        best_position: Math.min(...rows.map((r) => r.position)),
        data: rows.map((r) => ({
            scraped_at: dto.toIso(r.scraped_at),
            position: r.position,
            score: r.score,
            notes_count: r.notes_count
        }))
    };
}
