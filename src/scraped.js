/**
 * Which rows of `replies` are archive content.
 *
 * `status` is the HTTP status of the LAST fetch of a reply, not a record of
 * whether it was ever captured, and those are different facts:
 *
 *   - Never scraped. The reply was already gone the first time the scraper
 *     asked, so the row is an id and a status and nothing else. A gap.
 *   - Scraped, then deleted. A later re-check got a 404 and the scraper changed
 *     the status only, deliberately keeping the body, the date and the notes.
 *     Content, and after the deletion content that exists nowhere else.
 *   - Scraped, then unreachable. A re-check that hit a 500 is recorded the same
 *     way. The reply is very likely still there.
 *
 * Reading `status = 200` alone treated all three as gaps. A reply is content if
 * it is live or has a body: every row the old filter returned is still
 * returned, and the rows that were captured before they changed status join
 * them. `deleted` on the reply says which those are.
 *
 * This applies to replies only. Nothing ever re-checks a topic, so a topic's
 * status is still exactly "was it captured", and the topic queries keep it.
 *
 * The predicate below is for reads that already have the row in hand: a lookup
 * by id, or a join from a note or a front-page slot. It must NOT be used to
 * choose a page of a listing. `post` is a LONGTEXT outside every index, so
 * testing it makes InnoDB read the whole row, body included, for every row the
 * scan passes: measured on the mirror, page 4,000 of a long thread went from
 * 27ms to 18 seconds. Listings go through pageIds() instead.
 *
 * Counts are a separate matter. The rollup tables are built by the scraping
 * service from live rows, so everything in this package that COUNTS replies
 * still counts live ones, to agree with them. Only reads of content use this.
 */
export const LIVE = 200;
export const GONE = 404;

/** SQL predicate: this reply was captured. `alias` is the replies table alias. */
export const scraped = (alias = 'r') => `(${alias}.status = ${LIVE} OR ${alias}.post <> '')`;

/**
 * The inner query of a paged listing: SQL selecting the `id`s of one page of
 * captured replies, in order, to be joined back to `replies` for the columns.
 *
 * `where` and `params` are the caller's own filters on alias `r`, without any
 * status test. `key` is the column the listing is ordered by. `limit` is the
 * number of rows wanted, including the caller's has_more probe.
 *
 * Captured-then-deleted replies are rare: a few hundred in four million. So
 * the listing is asked first whether it holds any, which is a status-equality
 * probe that touches only those few rows. For almost every listing it does
 * not, and the page is then chosen exactly as it always was — `status = 200`,
 * answered from the index alone. Only a listing that does hold one pays for
 * merging two ordered branches, each still narrowed by status in the index
 * before a single body is read.
 *
 * The probe relies on being able to find dated 404 rows without walking the
 * live ones. With a user filter idx_user_status_created does that; without
 * one it needs idx_status_created (status, created) — see the README.
 */
export async function pageIds(query, { where = [], params = [], key, dir = 'ASC', limit, offset = 0 }) {
    const filters = where.length ? ` AND ${where.join(' AND ')}` : '';
    const live = `r.status = ${LIVE}${filters}`;
    const gone = `r.status = ${GONE}${filters} AND r.post <> ''`;

    const [held] = await query(`SELECT 1 AS held FROM replies r WHERE ${gone} LIMIT 1`, params);

    if (!held) {
        return {
            sql: `SELECT r.id FROM replies r WHERE ${live} ORDER BY r.${key} ${dir} LIMIT ? OFFSET ?`,
            params: [...params, limit, offset]
        };
    }

    // Each branch can contribute at most the rows up to the end of the page, so
    // that is all either is asked for; the merge then skips to the page.
    const upto = offset + limit;
    const branch = (pred) => `(SELECT r.id, r.${key} AS k FROM replies r
                               WHERE ${pred} ORDER BY r.${key} ${dir} LIMIT ?)`;
    return {
        sql: `SELECT u.id FROM (${branch(live)} UNION ALL ${branch(gone)}) u
              ORDER BY u.k ${dir}, u.id ${dir} LIMIT ? OFFSET ?`,
        params: [...params, upto, ...params, upto, limit, offset]
    };
}
