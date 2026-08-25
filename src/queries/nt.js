import { query, queryOne } from '../db.js';
import * as p from '../params.js';
import * as dto from '../dto.js';

const LIVE = 200;

const COLS = `t.id AS topic_id, t.title, t.user, t.post, t.created_utc,
              n.url AS nt_url, n.thumbnail`;

const FROM = `topics t JOIN nt n ON n.topic_id = t.id`;

/** List newsthread posts, newest first. */
export async function list(opts = {}) {
    const lim = p.limit(opts.limit, 20, 100);
    const off = p.offset(opts.offset);

    const rows = await query(
        `SELECT ${COLS} FROM ${FROM} WHERE t.status = ?
         ORDER BY t.id DESC LIMIT ? OFFSET ?`,
        [LIVE, lim + 1, off]
    );

    const hasMore = rows.length > lim;
    return dto.page((hasMore ? rows.slice(0, lim) : rows).map(dto.nt), {
        limit: lim, offset: off, has_more: hasMore
    });
}

export async function get(rawId) {
    const id = p.id(rawId, 'topic id');
    const row = await queryOne(
        `SELECT ${COLS} FROM ${FROM} WHERE t.id = ? AND t.status = ?`, [id, LIVE]
    );
    if (!row) throw p.notFound(`NT post ${id}`);
    return dto.nt(row);
}
