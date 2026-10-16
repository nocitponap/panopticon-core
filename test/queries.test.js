import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Integration tests against the local mirror.
 *
 * Skipped unless DB_HOST is set, so `npm test` still runs the pure-function
 * suite on a machine with no database. On the Pi:
 *
 *   set -a; . ~/.config/panopticon/api.env; set +a; npm test
 */
const HAVE_DB = Boolean(process.env.DB_HOST);

describe('queries', { skip: HAVE_DB ? false : 'DB_HOST not set' }, () => {
    let core;

    before(async () => { core = await import('../src/index.js'); });
    after(async () => { await core.closePool(); });

    test('the design brief: most active user in the past week', async () => {
        const r = await core.users.ranking({ window: '7d', sort: 'replies', limit: 5 });
        assert.ok(r.data.length > 0, 'expected somebody to have posted this week');
        assert.equal(r.meta.window, '7d');
        assert.equal(r.data[0].rank, 1);
        // Ranked, and every row is inside the window it claims.
        for (let i = 1; i < r.data.length; i++) {
            assert.ok(r.data[i - 1].replies >= r.data[i].replies, 'not sorted by replies');
        }
        for (const u of r.data) {
            assert.ok(u.last_active >= r.meta.from, `${u.user} last active outside the window`);
        }
    });

    test('all-time rankings agree with a user lookup', async () => {
        const top = (await core.users.ranking({ window: 'all', sort: 'replies', limit: 1 })).data[0];
        const user = await core.users.get(top.user);
        assert.equal(user.totals.replies, top.replies);
        assert.equal(user.user, top.user);
    });

    test('rollups agree with the source for topic reply counts', async () => {
        const t = (await core.topics.list({ sort: 'replies', window: 'all', limit: 1 })).data[0];
        const [{ n }] = await core.query(
            'SELECT COUNT(*) AS n FROM replies WHERE topic_id = ? AND status = 200', [t.id]
        );
        assert.equal(t.reply_count, Number(n), `topic_stats disagrees with replies for ${t.id}`);
    });

    test('tombstones are excluded everywhere', async () => {
        const [{ n }] = await core.query(
            "SELECT COUNT(*) AS n FROM replies WHERE status = 404 AND post = ''"
        );
        assert.ok(Number(n) > 100000, 'expected the archive to contain tombstones to exclude');

        const list = await core.replies.list({ limit: 50, sort: 'oldest' });
        for (const r of list.data) {
            assert.ok(r.post !== '' && r.post !== null, `tombstone leaked: reply ${r.id}`);
            assert.ok(r.created !== null, `undated reply leaked: ${r.id}`);
        }
    });

    test('a reply carries its notes, never the duplicated blob', async () => {
        const [row] = await core.query(
            `SELECT reply_id FROM notes GROUP BY reply_id HAVING COUNT(*) > 2 LIMIT 1`
        );
        const reply = await core.replies.get(row.reply_id);
        assert.ok(reply.notes.length > 2);
        assert.equal(typeof reply.notes[0].comment, 'string');
        assert.ok(!('notes_text' in reply), 'the blob must not be exposed');
    });

    test('questions the data cannot answer are refused, not guessed', async () => {
        await assert.rejects(
            () => core.topics.list({ sort: 'notes', window: '7d' }),
            (e) => e instanceof core.QueryError && /window=all/.test(e.message)
        );
        await assert.rejects(
            () => core.users.ranking({ sort: 'notes', window: 'all' }),
            (e) => e instanceof core.QueryError
        );
    });

    test('missing things 404 rather than returning empty', async () => {
        await assert.rejects(() => core.replies.get(999999999), (e) => e.status === 404);
        await assert.rejects(() => core.users.get('nosuchuser12345'), (e) => e.status === 404);
    });

    test('user search finds a handle by its display name', async () => {
        // topics.user is the handle, profiles.name is what the person typed.
        const [row] = await core.query(
            `SELECT t.user, pr.name FROM topics t JOIN profiles pr ON pr.topic_id = t.id
             WHERE t.topic_type = 'profile' AND t.status = 200
               AND pr.name <> '' AND pr.name <> t.user LIMIT 1`
        );
        const byName = await core.users.find(row.name.slice(0, 8));
        assert.ok(byName.data.some((u) => u.user === row.user),
            `searching "${row.name}" did not find handle "${row.user}"`);
    });

    test('per-year totals cover the whole archive', async () => {
        const years = await core.stats.years();
        const total = years.data.reduce((n, y) => n + y.replies, 0);
        const [{ n }] = await core.query(
            "SELECT COUNT(*) AS n FROM replies WHERE status = 200 AND user <> '' AND created > '2000-01-01'"
        );
        assert.equal(total, Number(n));
        assert.equal(years.data[0].year, 2001);
    });

    test('the daily series has no calendar gaps', async () => {
        // stats_daily is keyed by activity, so silent days are absent rows.
        // The series must still hand the caller every day, or a dashboard
        // reads the absence as a hole and draws straight over it.
        const d = await core.stats.daily({ from: '2026-06-17', to: '2026-06-24' });
        const days = d.data.map((r) => r.day);
        assert.deepEqual(days, [
            '2026-06-17', '2026-06-18', '2026-06-19', '2026-06-20',
            '2026-06-21', '2026-06-22', '2026-06-23', '2026-06-24'
        ]);

        // 2026-06-20: qbn.com served 502s for 27 hours. A real zero, not a gap
        // — the qbn-assigned reply ids run 4164911 -> 4164912 straight through.
        const outage = d.data.find((r) => r.day === '2026-06-20');
        assert.equal(outage.replies, 0);
        assert.equal(outage.active_users, 0);
        assert.equal(outage.notes, 0, 'after the notes epoch a silent day is a real zero');
        const [{ n }] = await core.query(
            "SELECT COUNT(*) AS n FROM replies WHERE status = 200 AND created >= '2026-06-20' AND created < '2026-06-21'"
        );
        assert.equal(Number(n), 0, 'the archive really does have nothing that day');
    });

    test('filling never runs past the days the rollup covers', async () => {
        const [{ last_day: last }] = await core.query('SELECT MAX(day) AS last_day FROM stats_daily');
        const lastDay = new Date(last).toISOString().slice(0, 10);

        // A window reaching into the future stops at the last rolled-up day
        // rather than inventing zeros for days nobody has scraped yet.
        const d = await core.stats.daily({ from: lastDay, to: '2099-12-31' });
        assert.equal(d.data[d.data.length - 1].day, lastDay);

        // And 'all' fills the archive without running off either end.
        const all = await core.stats.daily({ window: 'all' });
        assert.equal(all.data[all.data.length - 1].day, lastDay);
        assert.equal(all.data[0].year, undefined);
        for (let i = 1; i < all.data.length; i++) {
            const prev = new Date(`${all.data[i - 1].day}T00:00:00Z`);
            const cur = new Date(`${all.data[i].day}T00:00:00Z`);
            assert.equal(cur - prev, 86400000, `not contiguous at ${all.data[i].day}`);
        }
    });

    test('replied topics agree with the replies they count', async () => {
        const top = (await core.users.ranking({ window: '30d', sort: 'replies', limit: 1 })).data[0];
        const r = await core.users.repliedTopics(top.user, { limit: 5 });
        assert.ok(r.data.length > 0, `${top.user} replied this month but in no topic`);
        for (let i = 1; i < r.data.length; i++) {
            assert.ok(r.data[i - 1].last_reply_at >= r.data[i].last_reply_at, 'not most recent first');
        }
        // The smallest count is the cheapest to check exhaustively.
        const t = r.data.reduce((a, b) => (b.replies < a.replies ? b : a));
        const listed = await core.replies.list({ user: top.user, topic_id: t.id, window: 'all', limit: 200 });
        if (!listed.meta.has_more) assert.equal(listed.data.length, t.replies);
        assert.equal(listed.data[0].created, t.last_reply_at);

        const word = t.title.trim().split(/\s+/).find((w) => w.length >= 3);
        if (word) {
            const found = await core.users.repliedTopics(top.user, { search: word, limit: 100 });
            assert.ok(found.data.every((x) => x.title.toLowerCase().includes(word.toLowerCase())));
        }
    });

    test('a deep page of one user is the same rows as a shallow one', async () => {
        const top = (await core.users.ranking({ window: 'all', sort: 'replies', limit: 1 })).data[0];
        const wide = await core.replies.list({ user: top.user, window: 'all', limit: 10, offset: 1000 });
        const narrow = await core.replies.list({ user: top.user, window: 'all', limit: 5, offset: 1005 });
        assert.deepEqual(narrow.data.map((r) => r.created), wide.data.slice(5).map((r) => r.created));
    });

    test('overview is a single coherent snapshot', async () => {
        const o = await core.overview.get();
        assert.equal(typeof o.activity.last_7d.replies, 'number');
        assert.ok(o.most_active_users_7d.length > 0);
        assert.ok(o.front_page.entries.length > 0);
        assert.match(o.notes_epoch, /^\d{4}-\d{2}-\d{2}$/);
    });
});
