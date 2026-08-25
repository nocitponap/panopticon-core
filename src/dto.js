/**
 * Row → response object.
 *
 * The only place qbn.com URLs are built and the only place database column
 * names become public field names. Keeping it here is what stops the HTTP API
 * and the MCP server from drifting in what they return, which is exactly what
 * happened when each maintained its own field lists.
 */

export const replyUrl = (id) => `https://www.qbn.com/reply/${id}/`;
export const topicUrl = (id) => `https://www.qbn.com/topics/${id}/`;

/**
 * A DATETIME/TIMESTAMP as an ISO-8601 UTC string, or null.
 *
 * mysql2 hands back Date objects (the pool parses as UTC and pins the session to
 * UTC, so the instant is correct regardless of host). MySQL's zero date arrives
 * as null or an invalid Date; both become null rather than '0000-00-00', which
 * is not a time.
 */
export function toIso(value) {
    if (value === null || value === undefined) return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** A DATE column as YYYY-MM-DD. */
export function toDay(value) {
    const iso = toIso(value);
    return iso === null ? null : iso.slice(0, 10);
}

/**
 * A reply.
 *
 * `r.notes` — the mediumtext JSON blob that duplicates the `notes` table — is
 * deliberately absent. Two sources of truth for the same data is how the
 * Observable notebooks ended up with no notes at all for 2021. Callers that
 * want notes get them from the table, attached as `notes`.
 */
export function reply(r, { notes = undefined } = {}) {
    const out = {
        id: r.id,
        url: replyUrl(r.id),
        created: toIso(r.created),
        user: r.user,
        topic_id: r.topic_id,
        topic_title: r.topic_title,
        topic_url: r.topic_id ? topicUrl(r.topic_id) : null,
        post: r.post,
        score: r.score,
        reply_number: r.reply_number
    };
    if (notes !== undefined) {
        out.notes_count = notes.length;
        out.notes = notes;
    }
    return out;
}

/**
 * A note.
 *
 * `observed_at` is named for what it is: when the scraper saw the note, not
 * when it was written. It is null for the 2.8M notes recovered from the
 * replies.notes blob — we know they exist, not when they were first read.
 * `source` says which: 'live' was watched arriving, 'blob' and 'crawl' were
 * caught up with later.
 */
export function note(n) {
    return {
        id: n.id,
        user: n.user,
        comment: n.comment,
        // '' means the markup was never captured — true of every note taken from
        // the legacy blob, which stored plain text only. null says that; an
        // empty string would read as a note with no content.
        html_comment: n.html_comment || null,
        position: n.position,
        reply_id: n.reply_id,
        reply_url: n.reply_id ? replyUrl(n.reply_id) : null,
        observed_at: toIso(n.observed_at),
        source: n.source,
        ...(n.topic_id !== undefined ? {
            topic_id: n.topic_id,
            topic_title: n.topic_title,
            topic_url: n.topic_id ? topicUrl(n.topic_id) : null,
            reply_user: n.reply_user
        } : {})
    };
}

/**
 * A topic.
 *
 * `created` comes from the pre-parsed `topics.created_utc` column, not from the
 * raw `topics.date` string. `date_raw` is passed through because QBN emitted a
 * fixed -0800 offset for every row before 2024 regardless of DST, so `created`
 * can be up to an hour late for pre-2024 rows and the original is worth keeping
 * visible.
 */
export function topic(t, { stats = undefined, replies = undefined } = {}) {
    const out = {
        id: t.id,
        url: topicUrl(t.id),
        title: t.title,
        created: toIso(t.created_utc),
        date_raw: t.date ?? undefined,
        user: t.user,
        type: t.topic_type,
        post: t.post
    };
    if (stats) {
        out.reply_count = stats.reply_count ?? 0;
        out.note_count = stats.note_count ?? 0;
        out.user_count = stats.user_count ?? 0;
        out.first_reply_at = toIso(stats.first_reply_at);
        out.last_reply_at = toIso(stats.last_reply_at);
    }
    if (replies !== undefined) out.replies = replies;
    return out;
}

/** A profile, which is a topic of type 'profile' joined to its profile row. */
export function profile(p) {
    return {
        topic_id: p.topic_id,
        url: topicUrl(p.topic_id),
        username: p.user,
        name: p.name,
        created: toIso(p.created_utc),
        location: p.location,
        homepage: p.url,
        avatar: p.avatar,
        bio: p.bio,
        uncertified: p.uncertified === null ? null : Boolean(p.uncertified),
        endorsement_status: p.endorsement_status || null,
        endorsed_by: p.endorsed_by || null,
        rip: p.rip || null
    };
}

/** An NT (newsthread) post. */
export function nt(n) {
    return {
        topic_id: n.topic_id,
        url: topicUrl(n.topic_id),
        title: n.title,
        created: toIso(n.created_utc),
        user: n.user,
        post: n.post,
        link: n.nt_url,
        thumbnail: n.thumbnail
    };
}

/** One slot on a front-page snapshot. */
export function homepageEntry(e) {
    return {
        position: e.position,
        score: e.score,
        notes_count: e.notes_count,
        reply: e.id ? reply(e) : { id: e.reply_id, url: replyUrl(e.reply_id) }
    };
}

/** The standard list envelope. */
export function page(data, { limit, offset, total = undefined, ...rest }) {
    return {
        data,
        meta: {
            limit,
            offset,
            count: data.length,
            ...(total !== undefined ? { total } : {}),
            ...rest
        }
    };
}
