import { QueryError, date as parseDate } from './params.js';

/**
 * Time windows.
 *
 * The whole point of the redesign: the questions people actually ask are
 * time-bounded ("who was most active in the past week"), while the old API only
 * offered all-time rankings that had to aggregate the entire 3.9M-row archive on
 * every request. Windows resolve to UTC day bounds because replies.created is
 * UTC and the rollup tables are keyed by UTC day.
 */
export const WINDOWS = {
    '24h': 1,
    '7d': 7,
    '30d': 30,
    '90d': 90,
    '1y': 365,
    all: null
};

export const WINDOW_NAMES = Object.keys(WINDOWS);

/** Today's UTC date as YYYY-MM-DD. */
export function today(now = new Date()) {
    return now.toISOString().slice(0, 10);
}

function shiftDays(isoDate, days) {
    const d = new Date(`${isoDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

/**
 * Resolve a window into inclusive-from / exclusive-to UTC dates.
 *
 * Explicit `from`/`to` win over a named `window`. `to` is supplied by the caller
 * as an INCLUSIVE date (people say "up to the 5th" and mean it) and comes back
 * exclusive, so query code can use a half-open range and stay index-friendly.
 *
 * Returns { from, toExclusive, label }, where from/toExclusive may be null
 * meaning unbounded.
 */
export function resolveWindow({ window, from, to } = {}, now = new Date()) {
    if (from !== undefined && from !== null && from !== '') {
        const f = parseDate(from, 'from');
        const t = (to !== undefined && to !== null && to !== '')
            ? shiftDays(parseDate(to, 'to'), 1)
            : null;
        if (t !== null && t <= f) {
            throw new QueryError('Invalid range: `to` must be on or after `from`');
        }
        return { from: f, toExclusive: t, label: t ? `${f}..${to}` : `${f}..` };
    }

    if (to !== undefined && to !== null && to !== '') {
        const t = shiftDays(parseDate(to, 'to'), 1);
        return { from: null, toExclusive: t, label: `..${to}` };
    }

    const name = window === undefined || window === null || window === '' ? '30d' : window;
    if (!(name in WINDOWS)) {
        throw new QueryError(
            `Invalid window: expected one of ${WINDOW_NAMES.join(', ')}, or an explicit from/to`
        );
    }

    const days = WINDOWS[name];
    if (days === null) return { from: null, toExclusive: null, label: 'all' };

    const end = today(now);
    return { from: shiftDays(end, -(days - 1)), toExclusive: shiftDays(end, 1), label: name };
}

/**
 * Build a `WHERE` fragment for a day-keyed rollup column.
 * Returns { clause, params } — clause is '' when the window is unbounded.
 */
export function dayClause(column, { from, toExclusive }) {
    const parts = [];
    const params = [];
    if (from) { parts.push(`${column} >= ?`); params.push(from); }
    if (toExclusive) { parts.push(`${column} < ?`); params.push(toExclusive); }
    return { clause: parts.length ? parts.join(' AND ') : '', params };
}

/**
 * Same, for a DATETIME column. The bounds are dates, so the exclusive end
 * covers the whole final day.
 */
export function instantClause(column, { from, toExclusive }) {
    const parts = [];
    const params = [];
    if (from) { parts.push(`${column} >= ?`); params.push(`${from} 00:00:00`); }
    if (toExclusive) { parts.push(`${column} < ?`); params.push(`${toExclusive} 00:00:00`); }
    return { clause: parts.length ? parts.join(' AND ') : '', params };
}
