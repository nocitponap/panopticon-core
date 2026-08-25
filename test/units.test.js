import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as p from '../src/params.js';
import * as dto from '../src/dto.js';
import { resolveWindow, dayClause, instantClause } from '../src/windows.js';

const NOW = new Date('2026-08-20T09:00:00Z');

test('limit clamps and defaults', () => {
    assert.equal(p.limit(undefined, 20, 100), 20);
    assert.equal(p.limit('nonsense', 20, 100), 20);
    assert.equal(p.limit('5000', 20, 100), 100);
    assert.equal(p.limit('0', 20, 100), 1);
    assert.equal(p.limit('37', 20, 100), 37);
});

test('offset never goes negative', () => {
    assert.equal(p.offset(undefined), 0);
    assert.equal(p.offset('-9'), 0);
    assert.equal(p.offset('40'), 40);
});

test('usernames that the old regex rejected are accepted', () => {
    // These are real QBN accounts. The previous API's /^[a-zA-Z0-9_-]{1,30}$/
    // made 55 of them unreachable.
    for (const name of ['#1', '.....', '&hearts;', '&#9827;', 'b3lo&#153;']) {
        assert.equal(p.username(name), name);
    }
    assert.throws(() => p.username(''), p.QueryError);
    assert.throws(() => p.username('x'.repeat(31)), p.QueryError);
});

test('LIKE wildcards in a search term are escaped', () => {
    assert.equal(p.likeTerm('100%'), '%100\\%%');
    assert.equal(p.likeTerm('a_b'), '%a\\_b%');
});

test('named windows resolve to inclusive-from / exclusive-to UTC days', () => {
    assert.deepEqual(resolveWindow({ window: '7d' }, NOW), {
        from: '2026-08-14', toExclusive: '2026-08-21', label: '7d'
    });
    assert.deepEqual(resolveWindow({ window: '24h' }, NOW), {
        from: '2026-08-20', toExclusive: '2026-08-21', label: '24h'
    });
    assert.deepEqual(resolveWindow({ window: 'all' }, NOW), {
        from: null, toExclusive: null, label: 'all'
    });
});

test('an explicit `to` is inclusive for the caller, exclusive in SQL', () => {
    const w = resolveWindow({ from: '2025-01-01', to: '2025-01-31' }, NOW);
    assert.equal(w.from, '2025-01-01');
    assert.equal(w.toExclusive, '2025-02-01');
});

test('bad windows and inverted ranges are rejected', () => {
    assert.throws(() => resolveWindow({ window: 'last-tuesday' }, NOW), p.QueryError);
    assert.throws(() => resolveWindow({ from: '2025-13-01' }, NOW), p.QueryError);
    assert.throws(() => resolveWindow({ from: '2025-06-01', to: '2025-05-01' }, NOW), p.QueryError);
});

test('day and instant clauses bind the same bounds differently', () => {
    const w = resolveWindow({ window: '7d' }, NOW);
    assert.deepEqual(dayClause('day', w), {
        clause: 'day >= ? AND day < ?', params: ['2026-08-14', '2026-08-21']
    });
    assert.deepEqual(instantClause('r.created', w), {
        clause: 'r.created >= ? AND r.created < ?',
        params: ['2026-08-14 00:00:00', '2026-08-21 00:00:00']
    });
});

test("MySQL's zero date becomes null, not a fake instant", () => {
    assert.equal(dto.toIso(null), null);
    assert.equal(dto.toIso(new Date('0000-00-00')), null);
    assert.equal(dto.toIso(new Date('2026-08-20T03:02:16Z')), '2026-08-20T03:02:16.000Z');
    assert.equal(dto.toDay(new Date('2026-08-20T03:02:16Z')), '2026-08-20');
});

test('the duplicated notes blob is never in a reply payload', () => {
    const row = {
        id: 4167279, created: new Date('2026-08-20T03:02:16Z'), user: '_niko',
        topic_id: 780417, topic_title: 'a thread', post: '<p>hi</p>',
        score: 3, reply_number: 12,
        notes: '[{"comment":"or 1, you only get 1","user":"_niko"}]'  // the blob
    };
    const out = dto.reply(row);
    assert.equal(out.notes, undefined);
    assert.equal(out.url, 'https://www.qbn.com/reply/4167279/');
    assert.equal(out.topic_url, 'https://www.qbn.com/topics/780417/');

    const withNotes = dto.reply(row, { notes: [{ user: 'x', comment: 'y' }] });
    assert.equal(withNotes.notes_count, 1);
    assert.deepEqual(withNotes.notes, [{ user: 'x', comment: 'y' }]);
});

test('list envelope reports what the caller needs to page', () => {
    const out = dto.page([1, 2, 3], { limit: 3, offset: 6, has_more: true });
    assert.deepEqual(out.meta, { limit: 3, offset: 6, count: 3, has_more: true });
});
