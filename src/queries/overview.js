import { query, queryOne } from '../db.js';
import * as dto from '../dto.js';
import { today } from '../windows.js';
import * as users from './users.js';
import * as homepage from './homepage.js';
import { notesEpoch, freshness } from './stats.js';

/**
 * "What is the current status of QBN?" in one round trip.
 *
 * Today's figures are counted live from `replies` and `topics` rather than read
 * from the rollups. The scraper runs every five minutes but the rollup job runs
 * hourly, so a rolled-up "today" can be an hour behind — which is exactly the
 * number someone asking "what is happening right now" is looking at. Today is a
 * small, indexed range (idx_created), so counting it costs nothing; everything
 * older comes from the rollups, which is where the savings actually are.
 *
 * This exists because answering that question used to take a client six or
 * seven requests, and because it is the first thing every Observable notebook
 * needs. Everything here reads the rollup tables or a bounded recent range, so
 * the whole composite costs about as much as one of the old list endpoints.
 */
export async function get() {
    const end = today();
    const from = (days) => {
        const d = new Date(`${end}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() - (days - 1));
        return d.toISOString().slice(0, 10);
    };

    const [live, totals, span, topUsers, topTopics, front, epoch, fresh] = await Promise.all([
        queryOne(
            `SELECT
                (SELECT COUNT(*) FROM replies
                  WHERE status = 200 AND created >= ?)                       AS replies,
                (SELECT COUNT(DISTINCT user) FROM replies
                  WHERE status = 200 AND user <> '' AND created >= ?)        AS users,
                (SELECT COUNT(*) FROM topics
                  WHERE status = 200 AND topic_type = 'thread'
                    AND created_utc >= ?)                                    AS topics,
                (SELECT COUNT(*) FROM topics
                  WHERE status = 200 AND topic_type = 'profile'
                    AND created_utc >= ?)                                    AS profiles`,
            [`${end} 00:00:00`, `${end} 00:00:00`, `${end} 00:00:00`, `${end} 00:00:00`]
        ),
        query(
            `SELECT SUM(CASE WHEN day = ? THEN replies ELSE 0 END)  AS replies_today,
                    SUM(CASE WHEN day >= ? THEN replies ELSE 0 END) AS replies_7d,
                    SUM(CASE WHEN day >= ? THEN replies ELSE 0 END) AS replies_30d,
                    SUM(CASE WHEN day = ? THEN new_topics ELSE 0 END)  AS topics_today,
                    SUM(CASE WHEN day >= ? THEN new_topics ELSE 0 END) AS topics_7d,
                    SUM(CASE WHEN day >= ? THEN new_topics ELSE 0 END) AS topics_30d,
                    SUM(CASE WHEN day >= ? THEN new_profiles ELSE 0 END) AS profiles_7d,
                    SUM(CASE WHEN day >= ? THEN new_profiles ELSE 0 END) AS profiles_30d,
                    SUM(CASE WHEN day >= ? THEN notes ELSE 0 END)   AS notes_7d,
                    SUM(CASE WHEN day >= ? THEN notes ELSE 0 END)   AS notes_30d
             FROM stats_daily WHERE day >= ?`,
            [end, from(7), from(30), end, from(7), from(30),
                from(7), from(30), from(7), from(30), from(30)]
        ),
        queryOne(
            `SELECT COUNT(DISTINCT CASE WHEN day = ? THEN user END)  AS users_today,
                    COUNT(DISTINCT CASE WHEN day >= ? THEN user END) AS users_7d,
                    COUNT(DISTINCT user) AS users_30d
             FROM stats_user_day WHERE day >= ? AND replies > 0`,
            [end, from(7), from(30)]
        ),
        users.ranking({ window: '7d', sort: 'replies', limit: 10 }),
        query(
            `SELECT d.topic_id, SUM(d.replies) AS replies, t.title, t.user
             FROM stats_topic_day d JOIN topics t ON t.id = d.topic_id
             WHERE d.day >= ? AND t.status = 200
             GROUP BY d.topic_id ORDER BY replies DESC LIMIT 10`,
            [from(7)]
        ),
        homepage.latest().catch(() => null),
        notesEpoch(),
        freshness()
    ]);

    const t = totals[0] || {};
    const n = (v) => Number(v || 0);

    return {
        generated_at: new Date().toISOString(),
        as_of: end,
        activity: {
            // Counted live — see the note above.
            today: {
                replies: n(live?.replies),
                active_users: n(live?.users),
                new_topics: n(live?.topics),
                new_profiles: n(live?.profiles)
            },
            last_7d: {
                replies: n(t.replies_7d),
                active_users: n(span?.users_7d),
                new_topics: n(t.topics_7d),
                new_profiles: n(t.profiles_7d),
                notes: n(t.notes_7d)
            },
            last_30d: {
                replies: n(t.replies_30d),
                active_users: n(span?.users_30d),
                new_topics: n(t.topics_30d),
                new_profiles: n(t.profiles_30d),
                notes: n(t.notes_30d)
            }
        },
        most_active_users_7d: topUsers.data,
        busiest_topics_7d: topTopics.map((r) => ({
            topic_id: r.topic_id,
            url: dto.topicUrl(r.topic_id),
            title: r.title,
            user: r.user,
            replies: Number(r.replies)
        })),
        front_page: front,
        notes_epoch: epoch,
        // `today` is live; the 7d/30d figures and both rankings come from the
        // rollups, so they are current as of this timestamp and no later.
        rollups_current_to: fresh.rolled_up_at?.value ?? null,
        derived_data: fresh
    };
}
