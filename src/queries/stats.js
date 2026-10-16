import { query, queryOne } from '../db.js';
import * as p from '../params.js';
import * as dto from '../dto.js';
import { resolveWindow, dayClause, fillDays, shiftDays } from '../windows.js';

/**
 * Site-wide time series, straight out of stats_daily.
 *
 * Every day in the requested window comes back, including days the rollup wrote
 * no row for. `stats_daily` is keyed by activity, not by calendar, so a silent
 * day is simply missing from it — and consumers were reading that absence as a
 * hole in the archive rather than as the zero it is. The archive stores replies,
 * not dates; no replies on a date means zero replies on that date. Filling is
 * clamped to `coverage()` so this never invents zeros outside the span the
 * rollup has actually seen.
 *
 * `notes` and `note_users` are null for days before the notes epoch. That is
 * deliberate: qbn.com does not record when a note was written, so the archive
 * only has scrape times, and 83,949 of 167,171 notes share the single instant
 * of the 2024-04-23 bulk import. A zero or an interpolated figure would read as
 * a measurement; null reads as "not known", which is the truth.
 */
export async function daily(opts = {}) {
    const win = resolveWindow(opts.window || opts.from || opts.to ? opts : { window: '30d' });
    const range = dayClause('day', win);

    const rows = await query(
        `SELECT day, replies, active_users, new_topics, new_profiles, new_nt, notes, note_users
         FROM stats_daily ${range.clause ? `WHERE ${range.clause}` : ''}
         ORDER BY day ASC`,
        range.params
    );

    const epoch = await notesEpoch();
    return {
        window: win.label,
        from: win.from,
        to: win.toExclusive,
        notes_epoch: epoch,
        data: fillDays(rows.map(row), {
            ...(await clampToCoverage(win)),
            blank: (day) => blankDay(day, epoch)
        })
    };
}

/**
 * The span the rollup actually covers, as inclusive-from / exclusive-to.
 *
 * MIN/MAX over the primary key, so it costs nothing. Intersecting the caller's
 * window with it is what keeps `fillDays` honest: a gap inside the span is a
 * day that really had no activity, while anything outside it is a day we have
 * not observed and must not report as a zero. In particular `window=all` fills
 * the whole archive, and an open-ended `from=2026-09-01` stops at the last
 * rolled-up day instead of running into the future.
 */
async function clampToCoverage({ from, toExclusive }) {
    const r = await queryOne('SELECT MIN(day) AS first_day, MAX(day) AS last_day FROM stats_daily');
    const first = dto.toDay(r?.first_day);
    const last = dto.toDay(r?.last_day);
    if (!first || !last) return { from: null, toExclusive: null };

    const start = from && from > first ? from : first;
    const coverEnd = shiftDays(last, 1);
    const end = toExclusive && toExclusive < coverEnd ? toExclusive : coverEnd;
    // Window entirely outside the archive: nothing to fill against.
    return end > start ? { from: start, toExclusive: end } : { from: null, toExclusive: null };
}

/**
 * A day the rollup wrote no row for: zero of everything.
 *
 * The note columns are the exception and stay null before the notes epoch, for
 * the same reason they are null on days that do have a row — see the comment on
 * `daily`. A zero there would read as "nobody wrote a note", which is not
 * something the archive knows about 2003.
 */
function blankDay(day, epoch) {
    const notesKnown = day >= epoch;
    return {
        day,
        replies: 0,
        active_users: 0,
        new_topics: 0,
        new_profiles: 0,
        new_nt: 0,
        notes: notesKnown ? 0 : null,
        note_users: notesKnown ? 0 : null
    };
}

function row(r) {
    return {
        day: dto.toDay(r.day),
        replies: Number(r.replies || 0),
        active_users: Number(r.active_users || 0),
        new_topics: Number(r.new_topics || 0),
        new_profiles: Number(r.new_profiles || 0),
        new_nt: Number(r.new_nt || 0),
        notes: r.notes === null ? null : Number(r.notes),
        note_users: r.note_users === null ? null : Number(r.note_users)
    };
}

/** A single month, day by day. */
export async function monthly(opts = {}) {
    const year = p.limit(opts.year, new Date().getUTCFullYear(), 2100);
    const month = p.limit(opts.month, 0, 12);
    if (year < 2001) throw new p.QueryError('Invalid year: the archive starts in 2001');

    if (!month) {
        const rows = await query(
            `SELECT DATE_FORMAT(day, '%Y-%m') AS bucket,
                    SUM(replies) AS replies, SUM(new_topics) AS new_topics,
                    SUM(new_profiles) AS new_profiles, SUM(new_nt) AS new_nt,
                    SUM(notes) AS notes
             FROM stats_daily WHERE YEAR(day) = ?
             GROUP BY bucket ORDER BY bucket ASC`,
            [year]
        );
        // Distinct users cannot be summed across days — someone active on thirty
        // days is one user — so they are counted from the per-user monthly table.
        const users = await query(
            `SELECT ym AS bucket, COUNT(*) AS active_users
             FROM stats_user_month WHERE ym LIKE ? AND replies > 0
             GROUP BY ym ORDER BY ym ASC`,
            [`${year}-%`]
        );
        const byBucket = new Map(users.map((u) => [u.bucket, Number(u.active_users)]));
        return {
            year,
            data: rows.map((r) => ({
                bucket: r.bucket,
                replies: Number(r.replies || 0),
                active_users: byBucket.get(r.bucket) || 0,
                new_topics: Number(r.new_topics || 0),
                new_profiles: Number(r.new_profiles || 0),
                new_nt: Number(r.new_nt || 0),
                notes: r.notes === null ? null : Number(r.notes)
            }))
        };
    }

    const rows = await query(
        `SELECT day, replies, active_users, new_topics, new_profiles, new_nt, notes, note_users
         FROM stats_daily WHERE YEAR(day) = ? AND MONTH(day) = ? ORDER BY day ASC`,
        [year, month]
    );
    const epoch = await notesEpoch();
    const nextYear = month === 12 ? year + 1 : year;
    const nextMonth = month === 12 ? 1 : month + 1;
    const pad = (n) => String(n).padStart(2, '0');
    const span = await clampToCoverage({
        from: `${year}-${pad(month)}-01`,
        toExclusive: `${nextYear}-${pad(nextMonth)}-01`
    });

    return {
        year,
        month,
        notes_epoch: epoch,
        data: fillDays(rows.map(row), { ...span, blank: (day) => blankDay(day, epoch) })
    };
}

/**
 * Per-year totals — what the recap notebooks are built on.
 *
 * `active_users` is a true distinct count per year, not a sum of daily counts.
 */
export async function years() {
    // 26 rows, one per year. Counting distinct users per year from
    // stats_user_month instead took 3-5s, because that is the one figure that
    // cannot be summed from a smaller table.
    const rows = await query(
        `SELECT year, replies, active_users, new_topics, new_profiles, new_nt,
                notes, first_day, last_day
         FROM stats_yearly ORDER BY year ASC`
    );

    return {
        notes_epoch: await notesEpoch(),
        data: rows.map((t) => ({
            year: t.year,
            replies: Number(t.replies || 0),
            active_users: Number(t.active_users || 0),
            new_topics: Number(t.new_topics || 0),
            new_profiles: Number(t.new_profiles || 0),
            new_nt: Number(t.new_nt || 0),
            notes: t.notes === null ? null : Number(t.notes),
            first_day: dto.toDay(t.first_day),
            last_day: dto.toDay(t.last_day)
        }))
    };
}

let epochCache = null;
export async function notesEpoch() {
    if (epochCache) return epochCache;
    const r = await queryOne("SELECT value FROM rollup_state WHERE name = 'notes_epoch'");
    epochCache = r?.value || '2024-04-24';
    return epochCache;
}

/** When the derived tables were last rebuilt. Lets callers judge freshness. */
export async function freshness() {
    const rows = await query('SELECT name, value, updated_at FROM rollup_state');
    const out = {};
    for (const r of rows) out[r.name] = { value: r.value, updated_at: dto.toIso(r.updated_at) };
    return out;
}
