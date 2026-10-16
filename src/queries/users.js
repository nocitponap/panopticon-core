import { query, queryOne } from '../db.js';
import * as p from '../params.js';
import * as dto from '../dto.js';
import { resolveWindow, dayClause, today } from '../windows.js';
import { search as searchProfiles } from './profiles.js';

const LIVE = 200;
const METRICS = { replies: 'replies', topics: 'topics', notes: 'notes', score: 'score' };

/**
 * The ranking this whole redesign exists for:
 *
 *     "What user has been the most active in the past week?"
 *
 * Reads stats_user_day, so a 7-day window is a scan of seven days' worth of
 * rows rather than an aggregate over 3.9M replies.
 *
 * `sort=notes` is refused for windows that start before the notes epoch:
 * 83,949 of 167,171 notes share the 2024-04-23 bulk-import timestamp, so a note
 * ranking over earlier days would rank by when the scraper ran.
 */
export async function ranking(opts = {}) {
    const lim = p.limit(opts.limit, 20, 200);
    const off = p.offset(opts.offset);
    const sort = p.oneOf(opts.sort, Object.keys(METRICS), 'replies', 'sort');
    const win = resolveWindow(opts);

    if (sort === 'notes' && (!win.from || win.from < await notesEpoch())) {
        throw new p.QueryError(
            `sort=notes is only meaningful from ${await notesEpoch()} onward — earlier note ` +
            'timestamps are scrape times, half of them from a single bulk import'
        );
    }

    const order = {
        replies: 'SUM(replies)', topics: 'SUM(topics)',
        notes: 'SUM(notes)', score: 'SUM(score_sum)'
    }[sort];

    // All-time rankings read the lifetime table (~20k rows). Windowed ones read
    // the daily table, where the date range keeps the scan small. Aggregating
    // stats_user_day for window=all instead took 7.0s.
    const rows = win.from
        ? await (async () => {
            const day = dayClause('day', win);
            return query(
                `SELECT user,
                        SUM(replies)   AS replies,
                        SUM(topics)    AS topics,
                        SUM(notes)     AS notes,
                        SUM(score_sum) AS score,
                        COUNT(*)       AS active_days,
                        MIN(day)       AS first_day,
                        MAX(day)       AS last_day
                 FROM stats_user_day
                 ${day.clause ? `WHERE ${day.clause}` : ''}
                 GROUP BY user
                 HAVING ${order} > 0
                 ORDER BY ${order} DESC, user ASC
                 LIMIT ? OFFSET ?`,
                [...day.params, lim + 1, off]
            );
        })()
        : await query(
            `SELECT user, replies, topics, notes, score_sum AS score,
                    active_days, first_day, last_day
             FROM stats_user
             WHERE ${{ replies: 'replies', topics: 'topics', notes: 'notes', score: 'score_sum' }[sort]} > 0
             ORDER BY ${{ replies: 'replies', topics: 'topics', notes: 'notes', score: 'score_sum' }[sort]} DESC, user ASC
             LIMIT ? OFFSET ?`,
            [lim + 1, off]
        );

    const hasMore = rows.length > lim;
    const data = (hasMore ? rows.slice(0, lim) : rows).map((r, i) => ({
        rank: off + i + 1,
        user: r.user,
        replies: Number(r.replies || 0),
        topics: Number(r.topics || 0),
        notes: r.notes === null ? null : Number(r.notes),
        score: Number(r.score || 0),
        active_days: Number(r.active_days || 0),
        first_active: dto.toDay(r.first_day),
        last_active: dto.toDay(r.last_day)
    }));

    return dto.page(data, {
        limit: lim, offset: off, has_more: hasMore, sort, window: win.label,
        from: win.from, to: win.toExclusive
    });
}

let epochCache = null;
async function notesEpoch() {
    if (epochCache) return epochCache;
    const row = await queryOne("SELECT value FROM rollup_state WHERE name = 'notes_epoch'");
    epochCache = row?.value || '2024-04-24';
    return epochCache;
}

/** A user: profile if they have one, lifetime totals, and recent activity. */
export async function get(rawName) {
    const name = p.username(rawName);

    const [[prof], [life], [recent]] = await Promise.all([
        query(
            `SELECT t.id AS topic_id, t.user, t.created_utc, t.title,
                    pr.name, pr.location, pr.url, pr.avatar, pr.bio,
                    pr.uncertified, pr.endorsement_status, pr.endorsed_by, pr.rip
             FROM topics t JOIN profiles pr ON pr.topic_id = t.id
             WHERE t.topic_type = 'profile' AND t.user = ? AND t.status = ?
             LIMIT 1`,
            [name, LIVE]
        ),
        query(
            `SELECT replies, topics, notes, score_sum AS score, active_days, first_day, last_day
             FROM stats_user WHERE user = ?`,
            [name]
        ),
        query(
            `SELECT SUM(day >= ?) AS days_7,
                    SUM(CASE WHEN day >= ? THEN replies ELSE 0 END) AS replies_7,
                    SUM(CASE WHEN day >= ? THEN replies ELSE 0 END) AS replies_30,
                    SUM(CASE WHEN day >= ? THEN replies ELSE 0 END) AS replies_365
             FROM stats_user_day WHERE user = ? AND day >= ?`,
            [ago(7), ago(7), ago(30), ago(365), name, ago(365)]
        )
    ]);

    if (!prof && !Number(life?.active_days || 0)) throw p.notFound(`User ${name}`);

    return {
        user: name,
        profile: prof ? dto.profile({ ...prof, topic_id: prof.topic_id, user: name }) : null,
        totals: {
            replies: Number(life?.replies || 0),
            topics: Number(life?.topics || 0),
            notes: life?.notes === null ? null : Number(life?.notes || 0),
            score: Number(life?.score || 0),
            active_days: Number(life?.active_days || 0),
            first_active: dto.toDay(life?.first_day),
            last_active: dto.toDay(life?.last_day)
        },
        recent: {
            replies_7d: Number(recent?.replies_7 || 0),
            replies_30d: Number(recent?.replies_30 || 0),
            replies_365d: Number(recent?.replies_365 || 0),
            active_days_7d: Number(recent?.days_7 || 0)
        }
    };
}

function ago(days, now = new Date()) {
    const d = new Date(`${today(now)}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (days - 1));
    return d.toISOString().slice(0, 10);
}

/** A user's activity as a time series. Straight out of stats_user_day. */
export async function timeline(rawName, opts = {}) {
    const name = p.username(rawName);
    const bucket = p.oneOf(opts.bucket, ['day', 'month', 'year'], 'month', 'bucket');
    const win = resolveWindow(opts.window || opts.from || opts.to ? opts : { window: 'all' });

    // Month and year buckets read stats_user_month, which is already grouped
    // the right way — that is what it is for. Only a day-by-day series needs
    // the daily table.
    const monthly = bucket !== 'day';
    const range = monthly
        ? monthClause(win)
        : dayClause('day', win);

    const key = { day: 'day', month: 'ym', year: 'LEFT(ym, 4)' }[bucket];
    const where = ['user = ?', ...(range.clause ? [range.clause] : [])];

    const rows = await query(
        `SELECT ${key} AS bucket,
                SUM(replies) AS replies, SUM(topics) AS topics,
                SUM(notes) AS notes, SUM(score_sum) AS score
         FROM ${monthly ? 'stats_user_month' : 'stats_user_day'}
         WHERE ${where.join(' AND ')}
         GROUP BY bucket ORDER BY bucket ASC`,
        [name, ...range.params]
    );

    return {
        user: name,
        bucket,
        window: win.label,
        data: rows.map((r) => ({
            bucket: bucket === 'day' ? dto.toDay(r.bucket) : String(r.bucket),
            replies: Number(r.replies || 0),
            topics: Number(r.topics || 0),
            notes: r.notes === null ? null : Number(r.notes),
            score: Number(r.score || 0)
        }))
    };
}

/** The same bounds as dayClause, against the CHAR(7) `ym` key. */
function monthClause({ from, toExclusive }) {
    const parts = [];
    const params = [];
    if (from) { parts.push('ym >= ?'); params.push(from.slice(0, 7)); }
    if (toExclusive) { parts.push('ym <= ?'); params.push(toExclusive.slice(0, 7)); }
    return { clause: parts.length ? parts.join(' AND ') : '', params };
}

/**
 * The topics a user has replied in, most recently replied first.
 *
 * Not the topics they started — that is topics.list({ user }). A user who
 * opened three threads may have posted in three thousand, and "where has this
 * person been talking" is the second question, not the first.
 *
 * The aggregate is read from idx_user_status_created alone (sql/007): without it
 * each reply is a lookup into the wide clustered row, 7.2s for the heaviest
 * user, which no autocomplete can wait for. `search` matches topics.title, the
 * canonical title; replies.topic_title is a per-reply copy.
 */
export async function repliedTopics(rawName, opts = {}) {
    const name = p.username(rawName);
    const lim = p.limit(opts.limit, 20, 100);
    const off = p.offset(opts.offset);
    const term = p.search(opts.search);

    const where = ['t.status = ?'];
    const params = [name, LIVE, LIVE];
    if (term) { where.push('t.title LIKE ?'); params.push(p.likeTerm(term)); }

    const rows = await query(
        `SELECT t.id, t.title, t.topic_type, agg.n, agg.first_at, agg.last_at
         FROM (SELECT topic_id, COUNT(*) AS n, MIN(created) AS first_at, MAX(created) AS last_at
               FROM replies WHERE user = ? AND status = ? AND topic_id IS NOT NULL
               GROUP BY topic_id) agg
         JOIN topics t ON t.id = agg.topic_id
         WHERE ${where.join(' AND ')}
         ORDER BY agg.last_at DESC, t.id DESC
         LIMIT ? OFFSET ?`,
        [...params, lim + 1, off]
    );

    const hasMore = rows.length > lim;
    const data = (hasMore ? rows.slice(0, lim) : rows).map((r) => ({
        id: r.id,
        url: dto.topicUrl(r.id),
        title: r.title,
        type: r.topic_type,
        replies: Number(r.n),
        first_reply_at: dto.toIso(r.first_at),
        last_reply_at: dto.toIso(r.last_at)
    }));

    return dto.page(data, {
        limit: lim, offset: off, has_more: hasMore, user: name, ...(term ? { search: term } : {})
    });
}

/** Notes written by a user. */
export async function notes(rawName, opts = {}) {
    const name = p.username(rawName);
    const lim = p.limit(opts.limit, 50, 200);
    const off = p.offset(opts.offset);

    const rows = await query(
        // observed_at DESC puts the notes we watched arrive first and the
        // undated backfilled ones last, rather than letting a 2008 note sort as
        // this user's most recent.
        `SELECT n.id, n.user, n.comment, n.html_comment, n.position, n.reply_id,
                n.observed_at, n.source, r.topic_id, r.topic_title, r.user AS reply_user
         FROM notes n JOIN replies r ON r.id = n.reply_id
         WHERE n.user = ? AND r.status = ?
         ORDER BY n.observed_at DESC, n.id DESC
         LIMIT ? OFFSET ?`,
        [name, LIVE, lim + 1, off]
    );

    const hasMore = rows.length > lim;
    return dto.page((hasMore ? rows.slice(0, lim) : rows).map(dto.note), {
        limit: lim, offset: off, has_more: hasMore
    });
}

/**
 * Find users by handle or display name.
 *
 * Searches both because they differ: topics.user is the handle ('defineipr')
 * and profiles.name is what the person typed ('Define IPR').
 */
export async function find(rawTerm, opts = {}) {
    const term = p.search(rawTerm);
    if (!term) throw new p.QueryError('A search term is required');
    const lim = p.limit(opts.limit, 20, 100);

    // One implementation of profile matching, in profiles.js — see the comment
    // there for why it is a UNION of prefix lookups rather than an OR.
    const rows = await searchProfiles(term, {
        limit: lim,
        columns: 't.user, pr.name, t.id AS topic_id, t.created_utc, pr.avatar, pr.location'
    });

    const stats = new Map();
    if (rows.length) {
        const found = await query(
            `SELECT user, replies, last_day FROM stats_user WHERE user IN (?)`,
            [rows.map((r) => r.user)]
        );
        for (const s of found) stats.set(s.user, s);
    }

    return {
        query: term,
        data: rows.map((r) => {
            const s = stats.get(r.user);
            return {
                user: r.user,
                name: r.name,
                url: dto.topicUrl(r.topic_id),
                avatar: r.avatar,
                location: r.location,
                replies: Number(s?.replies || 0),
                last_active: dto.toDay(s?.last_day),
                joined: dto.toIso(r.created_utc)
            };
        }).sort((a, b) => b.replies - a.replies)
    };
}
