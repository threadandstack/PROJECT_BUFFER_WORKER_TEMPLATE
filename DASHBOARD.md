# Buffer Analytics Dashboard — build recipe

The worker creates the **Buffer Analytics** database and keeps it current, but it
can't create chart widgets. Stand up the client's dashboard one of two ways.

## Easiest: duplicate an existing one

If you already run this for another client (or for yourself), **duplicate that
dashboard page** into the new client's workspace, then open each widget and
re-point its **data source** to the new client's *Buffer Analytics*. Nothing else
changes — the widgets below are identical for every client.

## From scratch

Create a page in the client's workspace, add a **linked view of Buffer Analytics**,
and add a **Dashboard** view with these widgets. All widgets read from the client's
Buffer Analytics data source.

### KPI row (number widgets)

| Widget | Aggregation | Filter |
| --- | --- | --- |
| Posts Published | Count | `Status` is `sent` |
| Total Impressions | Sum of `Impressions` | — |
| Total Reactions | Sum of `Reactions` | — |

### Trend

- **Impressions by Month** — line chart. Sum of `Impressions`, grouped by
  `Published At` → by **month**, ascending. Filter: `Published At` within the past
  year. Hide empty groups.

### Breakdown

- **Publishing Cadence** — column chart. Count, grouped by `Published At` → by
  **month**, ascending. Filter: past year.
- **Posts by Channel** — donut. Count, grouped by **`Channel`**. (`Channel` is a
  text property in this template — Notion groups donuts by text fine.)

### Top posts

- **Top Posts** — table. Filter: `Status` is `sent` **and** `Published At` within
  the past year. Sort by `Impressions` descending. Show `Post`, `Channel`,
  `Published At`, `Impressions`, `Reactions`, `Comments`, `Post URL`.

## Notes

- **Empty is not zero.** Networks report different metrics (LinkedIn gives
  impressions/reach/reactions/comments; X gives likes/reposts/views). A blank cell
  means that network doesn't report it — not a measured zero.
- **`Engagement Rate %`** is already a percentage (`4.67` = 4.67%). Don't format it
  as a Notion percent (that multiplies by 100).
- Filter dashboard views to **`Post` is not empty** if you ever want to hide rows
  that lack a title.
