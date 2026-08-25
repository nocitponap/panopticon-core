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

    test('overview is a single coherent snapshot', async () => {
        const o = await core.overview.get();
        assert.equal(typeof o.activity.last_7d.replies, 'number');
        assert.ok(o.most_active_users_7d.length > 0);
        assert.ok(o.front_page.entries.length > 0);
        assert.match(o.notes_epoch, /^\d{4}-\d{2}-\d{2}$/);
    });
});
