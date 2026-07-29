# Buffer Worker — client template

A reusable Notion + Buffer content-operations worker. A client writes and approves
social posts in Notion; the worker publishes them through Buffer and pulls
performance data back. Deploy one worker **per client** — each gets their own
Notion databases, Buffer account and (optional) Google Drive.

Built on Notion's Workers platform (`ntn` CLI) and the Buffer GraphQL API.

## What it does

- **Publish from Notion.** Set a row's `Status` and the worker sends it to Buffer:
  - **Publish Now** — immediately
  - **Publish at Time** — at the row's `Publish At` (needs a date **and** time)
  - **Publish to Queue** — next free Buffer queue slot
  - **Next Buffer Slot** — jump to the top of the queue
- **Any channels, zero config.** Channels are labelled automatically from Buffer
  (`Acme Corp (LinkedIn)`). Curate the labels only if you want to — see
  [`src/config.ts`](src/config.ts).
- **Media** in `Post's Media` is re-hosted to Google Drive and attached (optional).
- **Analytics come back on their own** — current metrics per post, dated history
  snapshots, and an age-based polling schedule so it stays cheap.
- **Instant trigger** via a Notion webhook automation, with a 5-minute sweep as a
  safety net. Publishing is idempotent — it never double-posts.

## The three databases

| Database | Created by | Holds |
| --- | --- | --- |
| **Buffer Publishing** | `setupClient` tool | The client's authored posts. They write here. |
| **Buffer Analytics** | worker, on first deploy | One row per post Buffer knows about + current metrics. |
| **Performance Snapshots** | worker, on first deploy | Dated metric history. |

## Onboarding a new client

Prerequisites: the client has a **Buffer** account with their channels connected,
and a **Notion** workspace. You'll need Node ≥ 22 and the `ntn` CLI (`ntn login`).

1. **Copy the template** and install:
   ```sh
   cp -R PROJECT_BUFFER_WORKER_TEMPLATE PROJECT_<CLIENT>_BUFFER
   cd PROJECT_<CLIENT>_BUFFER && npm install
   ```

2. **Create the worker** (writes its own `workers.json`):
   ```sh
   ntn workers create --name <client>-buffer
   ```

3. **Set credentials.** Create a Notion internal integration at
   <https://www.notion.so/profile/integrations> (read + update content), and a
   Buffer API token at <https://publish.buffer.com/settings/api>:
   ```sh
   ntn workers env set BUFFER_ACCESS_TOKEN=… BUFFER_ORG_ID=… NOTION_API_TOKEN=…
   ```
   (Optional, for media: `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` from a Google
   Cloud OAuth app with the Drive API enabled.) See [`.env.example`](.env.example).

4. **Deploy** — this creates Buffer Analytics + Performance Snapshots:
   ```sh
   ntn workers deploy
   ```

5. **Provision the Publishing database.** Share the client's target Notion page
   with the integration, then:
   ```sh
   ntn workers exec setupClient -d '{"parentPageId":"<notion-page-id>"}'
   ```
   This reads the client's Buffer channels, creates **Buffer Publishing** seeded
   with those channels, and prints its data-source id.

6. **Wire the last env vars and sharing:**
   ```sh
   ntn workers env set BUFFER_PUBLISHING_DATA_SOURCE_ID=<from step 5> \
                       BUFFER_ANALYTICS_DATA_SOURCE_ID=<from showDatabases>
   ```
   Share all three databases with the Notion integration. (Run
   `ntn workers exec showDatabases` to get the Analytics id.)

7. **Add the publish trigger.** In Buffer Publishing → **Automations** → new
   automation → *When `Status` is set to any of Publish Now / Publish at Time /
   Publish to Queue / Next Buffer Slot* → **Send webhook** → paste the URL from:
   ```sh
   ntn workers webhooks list
   ```

8. **Optional — media & dashboard.**
   - Authorise Drive: `ntn workers oauth start googleDriveAuth` (after registering
     the redirect URL from `ntn workers oauth show-redirect-url`).
   - Duplicate the **Buffer Analytics Dashboard** template into the client's
     workspace and re-point its widgets at their Buffer Analytics data source.

9. **Seed history:**
   ```sh
   ntn workers sync trigger analyticsBackfill
   ```

Done. The client sets a `Status` and their post goes out.

## Per-client customisation

- **Channel labels** — [`src/config.ts`](src/config.ts) `CHANNEL_OVERRIDES`. Leave
  empty for auto-labels; add entries keyed `service:displayName` to curate.
- **Drive folder name** — `DRIVE_FOLDER_NAME` in the same file.
- Everything else is environment variables. **No other code edits per client.**

## Operational notes

- **Never** run `ntn workers sync state reset analyticsBackfill` on a populated
  Analytics database — on a database that already has rows a reset makes the sync
  create a fresh generation of rows instead of updating in place, orphaning the
  old ones as duplicates. Only reset when it's empty.
- If a deploy doesn't seem to take effect, **deploy again** (occasional stale
  upload); confirm with `ntn workers exec syncHealth`.
- Buffer enforces a **24-hour** request ceiling as well as a per-minute one. The
  worker paces itself and caches the channel list; if you hit
  `RATE_LIMIT_EXCEEDED (window 24h)`, wait for it to reset.
- `Publish at Time` needs a **time**, not just a date — a date-only value is
  midnight (in the past) and will publish immediately.

## The worker's tools

`setupClient` (onboarding), `listChannels`, `checkQueue`, `syncHealth`,
`publishNow`, `previewMetrics`, `showDatabases`. The last five can be attached to
a prompt-only Notion Custom Agent for on-demand publishing and diagnostics.
