# panopticon-core

The shared query layer over the archive of a design and creative community.
**Every SQL statement in the Panopticon project lives here, exactly once.**
`panopticon-api` is HTTP routing over this package;
[`panopticon-mcp`](https://github.com/nocitponap/panopticon-mcp) is MCP tool
definitions over this package. Neither contains SQL.

That rule exists because the previous arrangement kept the same queries in three
places: a Node API, a PHP port, and the MCP tools. Nothing held them in sync.
Every fix had to be made three times, and by the time anyone noticed they had
already drifted. The PHP port has been retired.

Counts here were measured against the mirror on 2026-08-25. They move: the
rollups count live replies, so a deletion lowers the totals even though the
reply itself is kept and still served. Ask the API for a live figure.

## Reads the mirror, never the source

These queries run against the local mirror. The remote source of truth is read
directly by an external third-party service, and its schema and semantics are
frozen; the scraper treats the remote as the required write and the mirror as
best-effort. Nothing in this package connects to the remote database.

## The invariants this package owns

Callers get these for free and cannot opt out of them.

- **Rows that were never captured never appear.** The archive holds some 251k
  replies and 145k topics that were already gone the first time the scraper
  asked: an id, a status, an empty body and an unusable timestamp. They are
  gaps, not content.

  *Revised 2026-11-19.* Previously stated here as "tombstones never appear:
  `status = 200` on every read". That was wrong for replies. `status` is the
  result of the *last* fetch, and the scraper re-checks replies: one that was
  captured and then deleted keeps its body, date and notes and only changes
  status. Filtering on status hid those, and also hid any reply whose re-check
  happened to hit a 500. Replies are now read through
  [`src/scraped.js`](./src/scraped.js) — live, or has a body — and carry
  `deleted: true` when their last check was a 404.

  Listings do not test the body row by row, because `post` is in no index and
  doing so cost seconds on deep pages. `pageIds()` first asks whether a listing
  holds any deleted reply at all, and pages it the old index-only way when it
  does not. That probe needs one index the mirror did not have:

  ```sql
  CREATE INDEX idx_status_created ON replies (status, created);
  ```

  Without it an unfiltered listing has no cheap way to find the few hundred
  dated 404 rows among four million, so **create the index before deploying
  this version.** It is a mirror-only index, like `idx_user_status_created`.

  Two things did not change. Topics still read `status = 200`: nothing re-checks
  a topic, so its status still means "was it captured", and a topic deleted from
  qbn.com cannot yet be told from a live one. And everything that *counts*
  replies still counts live ones, to agree with the rollup tables, which the
  scraping service builds. A thread's `reply_count` can therefore be smaller
  than the number of replies returned for it until the rollups follow.
- **Times go out as ISO-8601 UTC.** `replies.created` is already UTC.
  `topics.date` is a `varchar(255)` carrying an offset, so it is read through
  the pre-parsed `topics.created_utc` column the rollup job maintains.
- **The `replies.notes` blob is never returned.** Notes come from the `notes`
  table. Two sources of truth is why one earlier consumer showed no notes at
  all for 2021.

  *Revised 2026-08-25.* Previously stated here as "it duplicates the `notes`
  table". It did not. The blob was the back catalogue: it held 2,808,856 notes
  the table never had, because the archive had been scraped for notes all along
  and the results written to the wrong column. A migration moved them across,
  which is why note coverage now reaches 2002 rather than 2023. The blob is
  still not a source of truth and is still never returned.
- **Usernames are not pattern-validated.** Real handles include `#1`, `.....`,
  `&hearts;` and `&#9827;`. An `[a-zA-Z0-9_-]` check made 55 accounts
  unreachable through the old API. Injection is prevented by bound parameters,
  which is where it belongs.

## Derived data

Rankings and time series read rollup tables rather than aggregating the archive
on every request. Every expensive question here is an aggregate over history
that will never change again, so it is computed once and refreshed hourly.

| Table | Rows | Answers |
|---|---|---|
| `stats_user_day` | 1.28M | windowed user rankings, user timelines |
| `stats_user_month` | 358k | per-month and per-year distinct user counts |
| `stats_user` | 21k | all-time rankings, a user's lifetime totals |
| `stats_daily` | 9.1k | site-wide time series |
| `stats_topic_day` | 539k | busiest threads in a window |
| `topic_stats` | 225k | all-time thread rankings |

Distinct-user counts cannot be summed across days. Someone active on thirty days
is one user, not thirty, which is why `stats_user_month` exists rather than
being derived from the daily table.

The rollup tables are built by the scraping service, which is not public. This
package reads them and does not create them.

## Getting the source

`panopticon-api` and `panopticon-mcp` depend on this package through a `file:`
path, which npm resolves as a symlink. Clone the repositories as siblings under
one parent directory, or `npm install` fails to resolve the dependency.

```
panopticon/
  panopticon-core/
  panopticon-api/
  panopticon-mcp/
```

Editing this package then takes effect in both consumers immediately, with no
reinstall. That is the property the layout exists to preserve.

```bash
npm install
npm test          # pure-function tests, no database required
```

## What this cannot tell you

- **What was gone before the scraper arrived is absent.** Those rows are
  excluded everywhere, so reply and topic IDs have gaps. A missing ID means it
  was deleted before it could be read, not missing data. There is no route
  around this; the bodies were never captured. A reply deleted *after* it was
  captured is different: it is served, with `deleted: true`.
- **Note coverage runs the whole archive; note activity does not.** A note has
  no timestamp of its own. The only time it carries is `notes.observed_at`,
  when the scraper saw it, and 2,808,856 of the 2,972,813 notes have none: they
  came from the blob migration above, which recovered the note without
  recovering when it was read. Totals and per-thread or per-user counts are
  sound for all of history. Daily counts are real only from 2024-04-24, cover
  the 163,354 notes watched arriving, and are `null` before that date, never
  `0`. There is no route around this; the timestamps were never recorded.
  `notes.created_at` means when the row was written and nothing time-based
  reads it.
- **Topic times before 2024 may be up to an hour late.** The source stamped
  every topic `-0800` regardless of daylight saving until then. Reply times are
  unaffected and are the finer-grained signal in the same thread.
- **Score is one net number.** Up and down votes are not stored separately and
  cannot be recovered.

## Licence

MIT. Copyright (c) 2026 Anthony Lazaro. See [`LICENSE`](./LICENSE).

The licence covers this code and not the archive. Those posts were written by
the members of a community that never chose a licence for them, and this
repository claims nothing over them.
