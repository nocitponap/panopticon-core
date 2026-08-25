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

Counts here were measured against the mirror on 2026-08-25. They move: a
deletion turns a reply into a tombstone, so the archive total falls as the
tombstone total rises. Ask the API for a live figure.

## Reads the mirror, never the source

These queries run against the local mirror. The remote source of truth is read
directly by an external third-party service, and its schema and semantics are
frozen; the scraper treats the remote as the required write and the mirror as
best-effort. Nothing in this package connects to the remote database.

## The invariants this package owns

Callers get these for free and cannot opt out of them.

- **Tombstones never appear.** `status = 200` on every `replies` and `topics`
  read. The archive holds 251,122 deleted replies and 145,414 deleted topics
  with empty bodies and unusable timestamps. They are gaps, not content, and the
  real archive is 3,916,116 replies across 567,665 topics.
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

- **Deleted content is absent.** The tombstones above are excluded everywhere,
  so reply and topic IDs have gaps. A missing ID means deleted, not missing
  data. There is no route around this; the bodies were never captured.
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
