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
 * Counts are a separate matter. The rollup tables are built by the scraping
 * service from live rows, so everything in this package that COUNTS replies
 * still counts live ones, to agree with them. Only reads of content use this.
 */
export const LIVE = 200;
export const GONE = 404;

/** SQL predicate: this reply was captured. `alias` is the replies table alias. */
export const scraped = (alias = 'r') => `(${alias}.status = ${LIVE} OR ${alias}.post <> '')`;
