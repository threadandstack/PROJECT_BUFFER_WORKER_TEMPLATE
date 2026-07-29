import type { Client } from "@notionhq/client";
import { Worker, WebhookVerificationError } from "@notionhq/workers";
import * as Builder from "@notionhq/workers/builder";
import * as Schema from "@notionhq/workers/schema";
import { j } from "@notionhq/workers/schema-builder";
import { CHANNEL_OVERRIDES, DRIVE_FOLDER_NAME } from "./config.js";

const worker = new Worker();
export default worker;

// ─── Configuration ──────────────────────────────────────────────────────────

const BUFFER_API = "https://api.buffer.com/graphql";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Age-based polling policy, from the Buffer Publishing & Analytics Worker PRD.
 * Buffer refreshes metrics roughly daily, so polling everything every cycle
 * spends requests to learn nothing; engagement also front-loads, so fresh posts
 * earn frequent checks and settled ones taper off.
 *
 * Bands are contiguous and non-overlapping — `maxAgeDays` is the upper edge, the
 * previous tier's is the lower — so each post belongs to exactly one tier.
 * Anything past the final tier stops being polled altogether.
 */
const POLL_TIERS = [
	// Windowed on createdAt, not dueAt: a post published with shareNow has no
	// dueAt at all, so a dueAt window silently excludes every post this worker
	// publishes immediately. createdAt is non-nullable in Buffer's schema, so
	// this tier is what guarantees just-published posts get picked up.
	{ key: "justPublished", maxAgeDays: 1, intervalMs: 30 * 60 * 1000, by: "createdAt" },
	// The rest window on dueAt, which is the meaningful "when did this go out"
	// timestamp for scheduled and network-backfilled posts.
	{ key: "fresh", maxAgeDays: 1, intervalMs: 30 * 60 * 1000, by: "dueAt" },
	{ key: "recent", maxAgeDays: 14, intervalMs: DAY_MS, by: "dueAt" },
	{ key: "mid", maxAgeDays: 30, intervalMs: 3 * DAY_MS, by: "dueAt" },
	{ key: "settled", maxAgeDays: 90, intervalMs: 7 * DAY_MS, by: "dueAt" },
] as const;

type PollTier = (typeof POLL_TIERS)[number];

/** The dueAt band a tier covers, as an ISO range. */
function tierWindow(tier: PollTier, now: number): { start: string; end: string } {
	const sameBasis = POLL_TIERS.filter((t) => t.by === tier.by);
	const index = sameBasis.indexOf(tier);
	const lowerEdgeDays = index === 0 ? 0 : sameBasis[index - 1]!.maxAgeDays;
	return {
		start: new Date(now - tier.maxAgeDays * DAY_MS).toISOString(),
		end: new Date(now - lowerEdgeDays * DAY_MS).toISOString(),
	};
}

function tierIsDue(tier: PollTier, lastRun: Record<string, string>, now: number): boolean {
	const previous = lastRun[tier.key];
	return !previous || Date.parse(previous) + tier.intervalMs <= now;
}

/**
 * Posts fetched per Buffer API call. Deliberately below the ~100 the sync guide
 * suggests: the `metrics` resolver fans out to each social network, so large
 * pages are slow. Raise only if backfill cycles prove comfortably fast.
 */
const PAGE_SIZE = 25;

function getBufferToken(): string {
	const token = process.env.BUFFER_ACCESS_TOKEN;
	if (!token) {
		throw new Error(
			"BUFFER_ACCESS_TOKEN not set. Create a token at https://publish.buffer.com/settings/api, then:\n" +
				"  ntn workers env set BUFFER_ACCESS_TOKEN=<token>",
		);
	}
	return token;
}

function getBufferOrgId(): string {
	const orgId = process.env.BUFFER_ORG_ID;
	if (!orgId) {
		throw new Error(
			"BUFFER_ORG_ID not set. Find it under Buffer → Settings, then:\n" +
				"  ntn workers env set BUFFER_ORG_ID=<id>",
		);
	}
	return orgId;
}

// ─── Pacer ──────────────────────────────────────────────────────────────────
//
// Buffer does not publish a rate limit for the GraphQL API. This is a
// deliberately conservative budget shared by every sync; the server apportions
// it evenly. Revisit if runs start showing pacer-induced slowness.
const bufferApi = worker.pacer("bufferApi", { allowedRequests: 30, intervalMs: 60_000 });

// Google Drive v3's per-user quota is generous; this is conservative.
const driveApi = worker.pacer("driveApi", { allowedRequests: 10, intervalMs: 1000 });

// ─── Google Drive (media re-hosting) ────────────────────────────────────────
//
// Buffer fetches media by URL and cannot read Notion-hosted files, whose URLs
// are short-lived signed links. So attachments are re-hosted: downloaded from
// Notion, uploaded to an app-owned Drive folder, made link-readable, and handed
// to Buffer as a direct-download URL.
//
// Needs a Google Cloud OAuth app with the Drive API enabled (client id/secret in
// env). Optional — without it, posts still publish and attachments are skipped.
// After deploy, register the worker's redirect URL with the Google OAuth app:
//   ntn workers oauth show-redirect-url
const googleDriveAuth = worker.oauth("googleDriveAuth", {
	name: "google-drive-buffer",
	authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
	tokenEndpoint: "https://oauth2.googleapis.com/token",
	scope: "https://www.googleapis.com/auth/drive.file",
	clientId: process.env.GOOGLE_CLIENT_ID ?? "",
	clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
	authorizationParams: { access_type: "offline", prompt: "consent" },
});

// ─── Channels ───────────────────────────────────────────────────────────────
//
// Channels are labelled automatically from Buffer, so the worker works for any
// client with no per-client code. A channel named "Acme Corp" on LinkedIn
// becomes "Acme Corp (LinkedIn)". Clients who want curated names (e.g. to make
// personal vs company unmistakable) add a CHANNEL_OVERRIDES entry in config.ts.
//
// Everything is keyed on `service:displayName` rather than Buffer's channel id,
// because that pairing survives a channel being disconnected and reconnected
// (which mints a new id), and it keeps two same-named channels on different
// networks distinct (e.g. one name on both LinkedIn and Google Business).

/** Buffer service id → a human-friendly platform name used in channel labels. */
const SERVICE_LABELS: Record<string, string> = {
	linkedin: "LinkedIn",
	twitter: "X",
	bluesky: "Bluesky",
	googlebusiness: "Google Business",
	facebook: "Facebook",
	instagram: "Instagram",
	threads: "Threads",
	tiktok: "TikTok",
	youtube: "YouTube",
	pinterest: "Pinterest",
	mastodon: "Mastodon",
	startPage: "Start Page",
};

/** Stable key for a channel: `service:displayName` as Buffer reports it. */
function channelKey(channel: BufferChannel): string {
	return `${channel.service}:${channel.displayName ?? channel.name}`;
}

/**
 * The label for a channel: a curated override from config.ts if present,
 * otherwise auto-generated as "Display Name (Platform)".
 */
function channelLabel(channel: BufferChannel): string {
	const key = channelKey(channel);
	if (CHANNEL_OVERRIDES[key]) return CHANNEL_OVERRIDES[key];
	const name = channel.displayName ?? channel.name;
	return `${name} (${SERVICE_LABELS[channel.service] ?? channel.service})`;
}

/** Buffer's `Service` enum, complete — safe to enumerate. */
const SERVICE_OPTIONS = [
	"linkedin",
	"twitter",
	"facebook",
	"instagram",
	"threads",
	"tiktok",
	"youtube",
	"pinterest",
	"mastodon",
	"bluesky",
	"googlebusiness",
	"startPage",
] as const;

// ─── Databases ──────────────────────────────────────────────────────────────

/**
 * Every post Buffer knows about, however it was published — including posts
 * written natively on the network and backfilled by Buffer (`Posted Via` =
 * "network"), which never pass through Notion at all.
 *
 * Every row here is Buffer-owned, which is what makes replace mode safe for the
 * backfill sync. The publishing database below is emphatically not.
 */
const analytics = worker.database("analytics", {
	type: "managed",
	initialTitle: "Buffer Analytics",
	primaryKeyProperty: "Buffer Post ID",
	schema: {
		properties: {
			Post: Schema.title(),
			"Buffer Post ID": Schema.richText(),
			// Text, not select: channels differ per client and aren't known at
			// deploy time, and a select would need its options declared here. Notion
			// charts group by a text property fine, so the by-channel donut still works.
			Channel: Schema.richText(),
			Service: Schema.select(SERVICE_OPTIONS.map((name) => ({ name }))),
			Status: Schema.select([
				{ name: "sent", color: "green" },
				{ name: "scheduled", color: "blue" },
				{ name: "draft", color: "gray" },
				{ name: "error", color: "red" },
				{ name: "sending", color: "yellow" },
				{ name: "needs_approval", color: "orange" },
			]),
			"Published At": Schema.date("DD/MM/YYYY"),
			"Post Text": Schema.richText(),
			"Post URL": Schema.url(),
			"Posted Via": Schema.select([
				{ name: "buffer", color: "blue" },
				{ name: "network", color: "gray" },
				{ name: "api", color: "purple" },
			]),
			Impressions: Schema.number(),
			Reach: Schema.number(),
			Reactions: Schema.number(),
			Likes: Schema.number(),
			Comments: Schema.number(),
			Shares: Schema.number(),
			Reposts: Schema.number(),
			Saves: Schema.number(),
			Clicks: Schema.number(),
			Follows: Schema.number(),
			Views: Schema.number(),
			// Plain number, not Schema.number("percent"): Buffer sends 4.67 to mean
			// 4.67% (verified 2026-07-22), and Notion's percent format multiplies by
			// 100, so formatting it would display that as 467%. The name carries the unit.
			"Engagement Rate %": Schema.number(),
			"Metrics Updated": Schema.date("DD/MM/YYYY"),
			// Descriptive, not authoritative: it shows when this post is next due
			// under the polling policy, but scheduling is actually driven by the
			// per-tier timestamps in the delta sync's state. Writing it per row
			// keeps the policy visible in Notion without an N+1 read to enforce it.
			"Next Check At": Schema.date("DD/MM/YYYY"),
		},
	},
});

/**
 * Dated metric history — one row per post per genuine change.
 *
 * The primary key is `<postId>:<metricsUpdatedAt>`, which is what enforces the
 * PRD's "never create an unchanged snapshot" rule: if Buffer has not refreshed a
 * post's metrics, the key is unchanged and the upsert lands on the same row
 * instead of appending a duplicate. No read-back required.
 *
 * Declared after `analytics` so its relation points at an already-declared
 * database — the reverse fails deploy (see the note on `publishing` below).
 */
const snapshots = worker.database("snapshots", {
	type: "managed",
	initialTitle: "Performance Snapshots",
	primaryKeyProperty: "Snapshot ID",
	schema: {
		properties: {
			Snapshot: Schema.title(),
			"Snapshot ID": Schema.richText(),
			// Required as well as useful: a sync writing across databases via
			// `targetDatabaseKey` is still typed against the schema of the database
			// it is bound to, so every change must carry `analytics`' primary key.
			"Buffer Post ID": Schema.richText(),
			"Captured At": Schema.date("DD/MM/YYYY"),
			Impressions: Schema.number(),
			Reach: Schema.number(),
			Reactions: Schema.number(),
			Likes: Schema.number(),
			Comments: Schema.number(),
			Shares: Schema.number(),
			Reposts: Schema.number(),
			Saves: Schema.number(),
			Clicks: Schema.number(),
			Follows: Schema.number(),
			Views: Schema.number(),
			"Engagement Rate %": Schema.number(),
			"Social Post": Schema.relation("analytics", {
				twoWay: true,
				relatedPropertyName: "Snapshots",
			}),
		},
	},
});

// NOTE: Buffer Publishing is deliberately NOT a worker.database().
//
// Managed databases are read-only synced mirrors: Notion rejects every write to
// them that does not come through the declarative sync path, with "Rows in
// read-only synced databases can only be added, removed, or moved by the sync"
// — including writes from the worker's own token (verified 2026-07-22). That
// makes them unusable as an authoring surface, since you could not type a
// Caption and the worker could not write a status back.
//
// So Buffer Publishing is an ordinary Notion database that you own, which the
// worker reads and writes over the API. Its data source is supplied by
// BUFFER_PUBLISHING_DATA_SOURCE_ID. Analytics and Snapshots stay managed,
// which is correct — they are worker-owned mirrors that nobody edits by hand.

// ─── Buffer API ─────────────────────────────────────────────────────────────

interface BufferMetric {
	type: string;
	value: number;
	unit: string;
}

interface BufferPost {
	id: string;
	status: string;
	text: string;
	dueAt: string | null;
	sentAt: string | null;
	createdAt: string;
	updatedAt: string;
	channelId: string;
	channelService: string;
	via: string;
	externalLink: string | null;
	metricsUpdatedAt: string | null;
	metrics: BufferMetric[] | null;
}

interface BufferChannel {
	id: string;
	name: string;
	displayName: string | null;
	service: string;
}

/**
 * Single entry point for Buffer's GraphQL API. Paces itself, so callers never
 * need their own `bufferApi.wait()`.
 */
/**
 * Pacers are only attached to sync capabilities — `createSyncCapability` takes
 * the pacer declarations, tools get none — so `wait()` throws with "Pacer not
 * found" when called from a tool. Syncs, which do the bulk fetching, stay paced;
 * tools make a handful of calls by hand and proceed unpaced.
 */
async function pace(pacer: { wait(): Promise<void> } = bufferApi): Promise<void> {
	try {
		await pacer.wait();
	} catch {
		// Not running inside a sync — no pacer available.
	}
}

async function bufferGraphQL<T>(query: string, variables: Record<string, unknown>): Promise<T> {
	await pace();

	const res = await fetch(BUFFER_API, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${getBufferToken()}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ query, variables }),
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Buffer API ${res.status}: ${body.slice(0, 500)}`);
	}

	const json = (await res.json()) as {
		data?: T;
		errors?: Array<{ message: string }>;
	};

	if (json.errors?.length) {
		throw new Error(`Buffer API error: ${json.errors.map((e) => e.message).join("; ")}`);
	}
	if (!json.data) {
		throw new Error("Buffer API returned no data");
	}
	return json.data;
}

const POST_FIELDS = `
	id
	status
	text
	dueAt
	sentAt
	createdAt
	updatedAt
	channelId
	channelService
	via
	externalLink
	metricsUpdatedAt
	metrics { type value unit }
`;

/**
 * Channels change rarely but were being re-fetched on every `execute` — that is
 * once per *page*, not once per cycle, which roughly doubled the API calls of
 * every sync. Buffer enforces a 24-hour request ceiling as well as a burst
 * limit (hit for real on 2026-07-22: RATE_LIMIT_EXCEEDED, window "24h"), so the
 * saving is the difference between comfortable and throttled.
 *
 * Cached per warm worker instance; a cold start re-fetches, which is often
 * enough to notice a newly connected channel.
 */
let cachedChannels: { at: number; channels: BufferChannel[] } | null = null;
const CHANNEL_CACHE_MS = 30 * 60 * 1000;

async function fetchChannels(): Promise<BufferChannel[]> {
	if (cachedChannels && Date.now() - cachedChannels.at < CHANNEL_CACHE_MS) {
		return cachedChannels.channels;
	}
	const fresh = await fetchChannelsUncached();
	cachedChannels = { at: Date.now(), channels: fresh };
	return fresh;
}

async function fetchChannelsUncached(): Promise<BufferChannel[]> {
	const data = await bufferGraphQL<{ channels: BufferChannel[] }>(
		`query Channels($input: ChannelsInput!) {
			channels(input: $input) { id name displayName service }
		}`,
		{ input: { organizationId: getBufferOrgId() } },
	);
	return data.channels;
}

interface PostsPage {
	posts: BufferPost[];
	endCursor: string | null;
	hasNextPage: boolean;
}

/**
 * One page of posts. `dueAtRange` narrows to a rolling window for the delta
 * sync; omit it to walk the entire history for the backfill.
 */
async function fetchPostsPage(
	after: string | undefined,
	window?: { start: string; end: string },
	windowOn: "dueAt" | "createdAt" = "dueAt",
): Promise<PostsPage> {
	const data = await bufferGraphQL<{
		posts: {
			edges: Array<{ cursor: string; node: BufferPost }> | null;
			pageInfo: { hasNextPage: boolean; endCursor: string | null };
		};
	}>(
		`query Posts($input: PostsInput!, $first: Int!, $after: String) {
			posts(first: $first, after: $after, input: $input) {
				edges { cursor node { ${POST_FIELDS} } }
				pageInfo { hasNextPage endCursor }
			}
		}`,
		{
			first: PAGE_SIZE,
			after,
			input: {
				organizationId: getBufferOrgId(),
				filter: {
					status: ["sent"],
					...(window ? { [windowOn]: window } : {}),
				},
				sort: [{ field: windowOn, direction: "desc" }],
			},
		},
	);

	return {
		posts: (data.posts.edges ?? []).map((e) => e.node),
		endCursor: data.posts.pageInfo.endCursor,
		hasNextPage: data.posts.pageInfo.hasNextPage,
	};
}

// ─── Mapping ────────────────────────────────────────────────────────────────

/**
 * Buffer metric type → Notion column. Unlisted types are ignored.
 *
 * Networks report different subsets: LinkedIn returns only reactions, comments,
 * impressions, reach and engagementRate (verified 2026-07-22), while X reports
 * likes, reposts and views instead. Every column is kept so one database can
 * hold every channel — the unreported ones simply stay empty.
 */
const METRIC_COLUMNS: Record<string, string> = {
	impressions: "Impressions",
	reach: "Reach",
	reactions: "Reactions",
	likes: "Likes",
	comments: "Comments",
	shares: "Shares",
	reposts: "Reposts",
	saves: "Saves",
	clicks: "Clicks",
	follows: "Follows",
	views: "Views",
	engagementRate: "Engagement Rate %",
};

/**
 * Only the metrics Buffer actually returned. Absent keys stay `undefined` rather
 * than defaulting to 0, so that "this network does not report saves" is visibly
 * different from "this post got zero saves".
 */
function metricValues(metrics: BufferMetric[] | null): Record<string, number | undefined> {
	const out: Record<string, number | undefined> = {};
	for (const metric of metrics ?? []) {
		const column = METRIC_COLUMNS[metric.type];
		if (column) out[column] = metric.value;
	}
	return out;
}

/** Empty cell for an unreported metric; a number for a reported one. */
function metricCell(value: number | undefined) {
	return value === undefined ? [] : Builder.number(value);
}

/** The label to record for a post's channel; "Unknown channel" if Buffer has no record. */
function channelOption(channelId: string, channels: Map<string, BufferChannel>): string {
	const channel = channels.get(channelId);
	return channel ? channelLabel(channel) : "Unknown channel";
}

function dateOnly(iso: string | null): string | undefined {
	return iso?.split("T")[0];
}

/**
 * When this post next falls due, given its age. `undefined` past the last tier —
 * posts older than ~90 days stop being polled, since their metrics have settled.
 */
function nextCheckAt(post: BufferPost, now: number): string | undefined {
	const reference = post.sentAt ?? post.dueAt;
	if (!reference) return undefined;
	const ageDays = (now - Date.parse(reference)) / DAY_MS;
	const tier = POLL_TIERS.find((t) => ageDays <= t.maxAgeDays);
	return tier ? new Date(now + tier.intervalMs).toISOString() : undefined;
}

/**
 * Truncates safely for Notion, which rejects a whole batch with "Invalid data
 * format: ... unsupported characters" if any value contains malformed Unicode.
 *
 * Two traps, both hit for real on 2026-07-22:
 *  1. `String.prototype.slice` counts UTF-16 code units, so cutting mid-emoji
 *     leaves an unpaired surrogate — invalid Unicode. `Array.from` iterates by
 *     code point, so slicing that never splits a pair.
 *  2. Values must stay under Notion's 2000-character rich-text limit; a value
 *     sitting exactly on it is refused.
 *
 * A single emoji-bearing LinkedIn post wedged the entire backfill this way: its
 * batch failed, the cursor never advanced, and the sync retried forever.
 */
function clampText(text: string, limit = 1900): string {
	const cleaned = text
		// Control characters, excluding tab/newline/carriage return.
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
		// Lone surrogates that were already malformed upstream.
		.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "")
		.replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");

	const codePoints = Array.from(cleaned);
	if (codePoints.length <= limit) return cleaned;
	return `${codePoints.slice(0, limit - 1).join("")}…`;
}

function mapPost(post: BufferPost, channels: Map<string, BufferChannel>, now: number) {
	const m = metricValues(post.metrics);
	const publishedAt = dateOnly(post.sentAt ?? post.dueAt);
	const nextCheck = nextCheckAt(post, now);
	const metricsUpdated = dateOnly(post.metricsUpdatedAt);
	const text = post.text?.trim() ?? "";
	const service = (SERVICE_OPTIONS as readonly string[]).includes(post.channelService)
		? post.channelService
		: "linkedin";

	return {
		Post: Builder.title(text ? clampText(text, 80) : "(no text)"),
		"Buffer Post ID": Builder.richText(post.id),
		Channel: Builder.richText(channelOption(post.channelId, channels)),
		Service: Builder.select(service),
		Status: Builder.select(post.status),
		"Published At": publishedAt ? Builder.date(publishedAt) : [],
		"Post Text": Builder.richText(clampText(text)),
		"Post URL": post.externalLink ? Builder.url(post.externalLink) : [],
		"Posted Via": Builder.select(post.via),
		Impressions: metricCell(m.Impressions),
		Reach: metricCell(m.Reach),
		Reactions: metricCell(m.Reactions),
		Likes: metricCell(m.Likes),
		Comments: metricCell(m.Comments),
		Shares: metricCell(m.Shares),
		Reposts: metricCell(m.Reposts),
		Saves: metricCell(m.Saves),
		Clicks: metricCell(m.Clicks),
		Follows: metricCell(m.Follows),
		Views: metricCell(m.Views),
		"Engagement Rate %": metricCell(m["Engagement Rate %"]),
		"Metrics Updated": metricsUpdated ? Builder.date(metricsUpdated) : [],
		"Next Check At": nextCheck ? Builder.date(nextCheck.split("T")[0]) : [],
		// `Content` and `Snapshots` are deliberately absent: both are back-properties
		// created by two-way relations declared on the other database, so they are
		// not part of this schema and are populated from that side.
	};
}

// ─── Syncs ──────────────────────────────────────────────────────────────────

type BackfillState = { cursor?: string };

/**
 * Walks the entire Buffer history. Replace mode is safe here and only here —
 * every row in this database comes from Buffer — and its mark-and-sweep is what
 * reaps posts deleted upstream, since Buffer has no delete feed.
 *
 * Manual by design: re-run after connecting a channel or adding a metric column.
 *   ntn workers sync state reset analyticsBackfill && ntn workers sync trigger analyticsBackfill
 */
worker.sync("analyticsBackfill", {
	database: analytics,
	mode: "replace",
	schedule: "manual",
	execute: async (state: BackfillState | undefined) => {
		const channels = new Map((await fetchChannels()).map((c) => [c.id, c]));
		const { posts, endCursor, hasNextPage } = await fetchPostsPage(state?.cursor);

		console.log(
			`[analyticsBackfill] ${posts.length} posts, hasMore=${hasNextPage}, cursor=${state?.cursor ?? "start"}`,
		);

		return {
			changes: posts.map((post) => ({
				type: "upsert" as const,
				key: post.id,
				properties: mapPost(post, channels, Date.now()),
				upstreamUpdatedAt: post.updatedAt,
			})),
			hasMore: hasNextPage,
			nextState: hasNextPage && endCursor ? { cursor: endCursor } : {},
		};
	},
});

type DeltaState = {
	/** Tier key → ISO timestamp of the last completed pass. */
	tierLastRun?: Record<string, string>;
	/** Set only while paginating a tier. */
	activeTier?: string;
	cursor?: string;
};

/**
 * Refreshes metrics on posts that are due under the polling policy, and records a
 * dated snapshot whenever Buffer reports genuinely new numbers.
 *
 * These are rolling re-reads rather than a monotonic cursor, because Buffer's
 * `posts` query has no `updatedAt` filter (only dueAt / createdAt / status /
 * tags) and a post's metrics keep moving for days after it sends. The failure
 * mode to design against is therefore staleness, not skipped records — which is
 * also why there is no consistency buffer here.
 *
 * One tier is processed per cycle. `activeTier` + `cursor` mean "mid-pagination,
 * resume"; their absence means "pick the next due tier". `tierLastRun` is what
 * makes a tier stop being due, so the loop always terminates.
 *
 * Writes to two databases in one pass via `targetDatabaseKey` — the analytics row
 * carries current values, the snapshot row preserves history.
 */
worker.sync("analyticsDelta", {
	database: analytics,
	mode: "incremental",
	// Matches the shortest tier: anything longer and "fresh" could not be honoured.
	schedule: "30m",
	execute: async (state: DeltaState | undefined) => {
		const now = Date.now();
		const tierLastRun = { ...(state?.tierLastRun ?? {}) };

		// Resume a tier mid-pagination, otherwise take the next one that is due.
		const resuming = state?.activeTier
			? POLL_TIERS.find((t) => t.key === state.activeTier)
			: undefined;
		const tier = resuming ?? POLL_TIERS.find((t) => tierIsDue(t, tierLastRun, now));

		if (!tier) {
			console.log("[analyticsDelta] no tiers due");
			return { changes: [], hasMore: false, nextState: { tierLastRun } };
		}

		const cursor = resuming ? state?.cursor : undefined;
		const channels = new Map((await fetchChannels()).map((c) => [c.id, c]));
		const { posts, endCursor, hasNextPage } = await fetchPostsPage(
			cursor,
			tierWindow(tier, now),
			tier.by,
		);

		console.log(
			`[analyticsDelta] tier=${tier.key} posts=${posts.length} hasMore=${hasNextPage}`,
		);

		// Snapshots are NOT emitted here. `targetDatabaseKey` does not route: changes
		// land in the sync's bound database regardless, so cross-database writes
		// created junk rows in analytics keyed `postId:timestamp` while the
		// snapshots database stayed empty (verified 2026-07-22). The dedicated
		// snapshotsDelta sync below owns that database instead.
		const changes = posts.map((post) => ({
			type: "upsert" as const,
			key: post.id,
			properties: mapPost(post, channels, now),
			upstreamUpdatedAt: post.metricsUpdatedAt ?? post.updatedAt,
		}));

		if (hasNextPage && endCursor) {
			return {
				changes,
				hasMore: true,
				nextState: { tierLastRun, activeTier: tier.key, cursor: endCursor },
			};
		}

		// Tier finished — stamp it so it stops being due, then see if another is.
		tierLastRun[tier.key] = new Date(now).toISOString();
		const moreDue = POLL_TIERS.some((t) => tierIsDue(t, tierLastRun, now));

		return { changes, hasMore: moreDue, nextState: { tierLastRun } };
	},
});

// ─── Diagnostic tools ───────────────────────────────────────────────────────
//
// Part of the Social Syncer agent's surface, and the fastest way to answer
// "is Buffer wired up correctly?" without writing anything to Notion.

worker.tool("listChannels", {
	title: "List Buffer Channels",
	description:
		"Lists the social channels connected to the Buffer organisation, with their IDs and " +
		"services. Use to confirm credentials work and to get the channel names that the " +
		"Channel property expects.",
	// Notion agents call these no-argument tools inconsistently — sometimes `{}`,
	// sometimes `{ name: ... }` (the agent's cached tool schema lags deploys). The
	// builder can't mark a property optional (every property is forced into
	// `required`), so accept BOTH shapes with anyOf. The handler ignores the input.
	schema: j.anyOf(j.object({}), j.object({ name: j.string().nullable() })),
	execute: async () => {
		const channels = await fetchChannels();
		if (!channels.length) return "No channels connected to this Buffer organisation.";
		return channels
			.map((c) => `${c.displayName ?? c.name} — ${c.service} — id: ${c.id}`)
			.join("\n");
	},
});

worker.tool("showDatabases", {
	title: "Show Worker Databases",
	description:
		"Reports the Notion database and data-source IDs plus URLs for Buffer Publishing, " +
		"Buffer Analytics and Performance Snapshots. Worker-managed databases are not visible " +
		"to other integrations' search, so this is the reliable way to obtain their IDs.",
	// Notion agents call these no-argument tools inconsistently — sometimes `{}`,
	// sometimes `{ name: ... }` (the agent's cached tool schema lags deploys). The
	// builder can't mark a property optional (every property is forced into
	// `required`), so accept BOTH shapes with anyOf. The handler ignores the input.
	schema: j.anyOf(j.object({}), j.object({ name: j.string().nullable() })),
	execute: async (_input, { notion }) => {
		const titles = ["Buffer Publishing", "Buffer Analytics", "Performance Snapshots"];
		const lines: string[] = [];

		for (const title of titles) {
			const results = await notion.search({
				query: title,
				filter: { property: "object", value: "data_source" },
				page_size: 5,
			});
			// Match the title exactly — Notion's search is fuzzy, and taking
			// results[0] returned Buffer Publishing's id for "Buffer Analytics".
			const match = results.results.find((r) => {
				const ds = r as { title?: Array<{ plain_text: string }> };
				return (ds.title ?? []).map((t) => t.plain_text).join("") === title;
			}) as { id: string; url?: string } | undefined;

			lines.push(
				match
					? `${title}\n  data_source_id: ${match.id}\n  url: ${match.url ?? "(none)"}`
					: `${title}\n  NOT FOUND — has the worker deployed and has the sync run?`,
			);
		}

		return lines.join("\n\n");
	},
});

worker.tool("setupClient", {
	title: "Set Up Client (create Buffer Publishing database)",
	description:
		"One-time onboarding for a new client. Reads the client's connected Buffer channels and " +
		"creates their Buffer Publishing database under the given Notion page — seeded with those " +
		"channels and every property the worker needs. Run once, after the first deploy has created " +
		"Buffer Analytics. Returns the new data-source id to set as BUFFER_PUBLISHING_DATA_SOURCE_ID.",
	schema: j.object({
		parentPageId: j
			.string()
			.describe(
				"The Notion page id the Publishing database is created under. Share that page with " +
					"this worker's Notion integration first.",
			),
	}),
	execute: async ({ parentPageId }: { parentPageId: string }, { notion }) => {
		// The Analytics database must already exist (created on the first deploy) so
		// the Publishing → Analytics relation has something to point at.
		let analyticsDsId: string;
		try {
			analyticsDsId = await resolveDataSourceId(notion, "Buffer Analytics", ANALYTICS_DS_ENV);
		} catch {
			return (
				"Buffer Analytics not found. Deploy the worker first (`ntn workers deploy`) so it " +
				"creates the Analytics database, then run setupClient again."
			);
		}

		// Seed the Channels picker with the client's own Buffer channels, labelled
		// the same way the worker will label them everywhere else.
		const channels = await fetchChannels();
		const channelOptions = [...new Set(channels.map(channelLabel))].map((name) => ({ name }));

		const properties: Record<string, unknown> = {
			[PUB.content]: { title: {} },
			[PUB.copy]: { rich_text: {} },
			[PUB.channels]: { multi_select: { options: channelOptions } },
			[PUB.publishAt]: { date: {} },
			[PUB.media]: { files: {} },
			[PUB.mediaUrls]: { rich_text: {} },
			[PUB.status]: {
				select: {
					options: [
						{ name: "Idea" },
						{ name: "Drafting" },
						{ name: "On Hold" },
						{ name: "Publish Now" },
						{ name: "Publish at Time" },
						{ name: "Publish to Queue" },
						{ name: "Next Buffer Slot" },
						{ name: "Scheduled" },
						{ name: "Published" },
						{ name: "Failed" },
					],
				},
			},
			[PUB.bufferPostIds]: { rich_text: {} },
			[PUB.bufferState]: {
				select: {
					options: [
						{ name: "scheduled" },
						{ name: "sent" },
						{ name: "error" },
						{ name: "draft" },
					],
				},
			},
			[PUB.sentAt]: { date: {} },
			[PUB.postUrl]: { url: {} },
			[PUB.note]: { rich_text: {} },
			[PUB.analytics]: { relation: { data_source_id: analyticsDsId } },
		};

		type CreatedDb = { id: string; url?: string; data_sources?: Array<{ id: string }> };
		let created: CreatedDb;
		try {
			created = (await notion.databases.create({
				parent: { type: "page_id", page_id: parentPageId },
				title: [{ type: "text", text: { content: "Buffer Publishing" } }],
				initial_data_source: { properties },
			} as Parameters<typeof notion.databases.create>[0])) as CreatedDb;
		} catch (err) {
			return (
				`Could not create the Publishing database under ${parentPageId}: ${(err as Error).message}\n\n` +
				"Check the page id, and make sure the page is shared with this worker's Notion integration."
			);
		}

		const dsId = created.data_sources?.[0]?.id;
		return [
			"✅ Created Buffer Publishing for this client.",
			`   ${created.url ?? created.id}`,
			`   Channels seeded: ${channelOptions.map((o) => o.name).join(", ")}`,
			"",
			"Next steps:",
			`  1. ntn workers env set BUFFER_PUBLISHING_DATA_SOURCE_ID=${dsId ?? "<the database's data source id>"}`,
			"  2. Share this new database with the worker's Notion integration.",
			"  3. Add a Notion automation on it: Status is a publish value → Send webhook → the",
			"     onReadyToPublish URL (ntn workers webhooks list).",
		].join("\n");
	},
});

worker.tool("previewMetrics", {
	title: "Preview Buffer Metrics",
	description:
		"Fetches the most recent sent posts straight from Buffer and returns their raw, " +
		"unmapped metric values. Use to check which metrics a channel actually reports and " +
		"on what scale, without writing to Notion.",
	schema: j.object({
		limit: j
			.integer()
			.describe("How many recent posts to inspect. Defaults to 3.")
			.nullable(),
	}),
	// Read defensively: the caller may omit limit or send the whole input as null.
	execute: async (input: { limit: number | null } | null) => {
		const limit = input?.limit ?? null;
		const { posts } = await fetchPostsPage(undefined);
		const sample = posts.slice(0, limit ?? 3);
		if (!sample.length) return "No sent posts found in Buffer.";

		return sample
			.map((post) => {
				const metrics = post.metrics?.length
					? post.metrics.map((m) => `    ${m.type} = ${m.value} (${m.unit})`).join("\n")
					: "    (no metrics returned)";
				return [
					`${post.sentAt ?? post.dueAt} — ${post.channelService} — via ${post.via}`,
					`  "${(post.text ?? "").slice(0, 60)}..."`,
					`  metricsUpdatedAt: ${post.metricsUpdatedAt ?? "never"}`,
					metrics,
				].join("\n");
			})
			.join("\n\n");
	},
});


// ─── Google Drive helpers ───────────────────────────────────────────────────

// DRIVE_FOLDER_NAME is imported from config.ts so a client can rename it. One
// folder per client keeps each client's media separate under the same Google app.
let cachedDriveFolderId: string | null = null;

interface DriveFile {
	id: string;
	name?: string;
}

/**
 * Finds or creates the app-owned Drive folder.
 *
 * The `drive.file` scope only grants access to files this app created, so the
 * folder must be created through the API — a folder made by hand in the Drive UI
 * is invisible to the app and reports 404 even given the correct id.
 */
async function resolveDriveFolderId(accessToken: string): Promise<string> {
	const pinned = process.env.BUFFER_DRIVE_FOLDER_ID;
	if (pinned) return pinned;
	if (cachedDriveFolderId) return cachedDriveFolderId;

	await pace(driveApi);
	const q = `name = '${DRIVE_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
	const params = new URLSearchParams({ q, fields: "files(id)", pageSize: "1" });
	const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!res.ok) throw new Error(`Drive folder lookup failed: ${res.status} ${await res.text()}`);

	const data = (await res.json()) as { files?: DriveFile[] };
	if (data.files?.[0]) {
		cachedDriveFolderId = data.files[0].id;
		return cachedDriveFolderId;
	}

	await pace(driveApi);
	const createRes = await fetch("https://www.googleapis.com/drive/v3/files?fields=id", {
		method: "POST",
		headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			name: DRIVE_FOLDER_NAME,
			mimeType: "application/vnd.google-apps.folder",
		}),
	});
	if (!createRes.ok) {
		throw new Error(`Drive folder create failed: ${createRes.status} ${await createRes.text()}`);
	}
	const created = (await createRes.json()) as DriveFile;
	console.log(`[drive] created folder "${DRIVE_FOLDER_NAME}" (${created.id})`);
	cachedDriveFolderId = created.id;
	return created.id;
}

async function findDriveFileByName(
	accessToken: string,
	name: string,
	folderId: string,
): Promise<DriveFile | null> {
	await pace(driveApi);
	const q = `name = '${name.replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed = false`;
	const params = new URLSearchParams({ q, fields: "files(id,name)", pageSize: "1" });
	const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!res.ok) return null;
	const data = (await res.json()) as { files?: DriveFile[] };
	return data.files?.[0] ?? null;
}

/** Uploads bytes and grants link-read access so Buffer can fetch them. */
async function uploadToDrive(
	accessToken: string,
	name: string,
	mimeType: string,
	bytes: Buffer,
	folderId: string,
): Promise<DriveFile> {
	await pace(driveApi);
	const boundary = `buffer_worker_${Math.random().toString(16).slice(2)}`;
	const metadata = { name, mimeType, parents: [folderId] };

	const body = Buffer.concat([
		Buffer.from(
			`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
			"utf-8",
		),
		Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`, "utf-8"),
		bytes,
		Buffer.from(`\r\n--${boundary}--`, "utf-8"),
	]);

	const res = await fetch(
		"https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name",
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": `multipart/related; boundary=${boundary}`,
			},
			body,
		},
	);
	if (!res.ok) throw new Error(`Drive upload failed: ${res.status} ${await res.text()}`);
	const file = (await res.json()) as DriveFile;

	await pace(driveApi);
	const permRes = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}/permissions`, {
		method: "POST",
		headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
		body: JSON.stringify({ role: "reader", type: "anyone" }),
	});
	if (!permRes.ok) {
		// Without this the file is private and Buffer's fetch will 403 — fail loudly
		// rather than publish a post whose media silently never appears.
		throw new Error(
			`Drive file ${file.id} uploaded but could not be made public: ${permRes.status} ${await permRes.text()}`,
		);
	}

	return file;
}

/**
 * A URL that serves the bytes themselves. `webViewLink` is an HTML wrapper page,
 * which Buffer cannot use as media.
 */
function driveDirectUrl(fileId: string): string {
	return `https://drive.google.com/uc?export=download&id=${fileId}`;
}

// Verified 2026-07-22: an anonymous fetch of this URL returned status 200,
// content-type image/png and a byte-for-byte match of a 225 KB upload — so
// Buffer can read it. Caveat: Google serves an HTML virus-scan interstitial for
// large files (roughly >100 MB), which would break big video uploads. If that
// ever appears, switch images to https://lh3.googleusercontent.com/d/<id>.

function driveThumbnailUrl(fileId: string): string {
	return `https://drive.google.com/thumbnail?id=${fileId}&sz=w1000`;
}

const MIME_BY_EXTENSION: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
	mp4: "video/mp4",
	mov: "video/quicktime",
	m4v: "video/x-m4v",
	webm: "video/webm",
	pdf: "application/pdf",
};

function mimeFromName(name: string): string {
	const ext = name.split(".").pop()?.toLowerCase() ?? "";
	return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}

/** Buffer's AssetInput is a @oneOf: exactly one of image / video / document. */
function bufferAsset(fileId: string, mimeType: string, title: string): Record<string, unknown> {
	const url = driveDirectUrl(fileId);
	if (mimeType.startsWith("image/")) return { image: { url } };
	if (mimeType.startsWith("video/")) {
		return { video: { url, thumbnailUrl: driveThumbnailUrl(fileId) } };
	}
	// DocumentAssetInput requires all three fields.
	return { document: { url, title, thumbnailUrl: driveThumbnailUrl(fileId) } };
}

interface PreparedMedia {
	assets: Array<Record<string, unknown>>;
	links: string[];
	warnings: string[];
}

/**
 * Re-hosts each Notion attachment to Drive and returns Buffer asset inputs.
 *
 * Idempotent by filename: a file already in the folder is reused rather than
 * uploaded again, so re-publishing does not litter Drive with duplicates.
 */
async function prepareMedia(
	files: Array<{ name: string; url: string }>,
	externalUrls: string[],
): Promise<PreparedMedia> {
	const assets: Array<Record<string, unknown>> = [];
	const links: string[] = [];
	const warnings: string[] = [];

	// Already-public URLs need no re-hosting; assume image unless clearly video.
	for (const url of externalUrls) {
		const mime = mimeFromName(url.split("?")[0] ?? url);
		assets.push(
			mime.startsWith("video/") ? { video: { url } } : { image: { url } },
		);
		links.push(url);
	}

	if (!files.length) return { assets, links, warnings };

	let driveToken: string;
	try {
		driveToken = await googleDriveAuth.accessToken();
	} catch (err) {
		warnings.push(
			`Google Drive is not connected, so ${files.length} attachment(s) were skipped: ${(err as Error).message}`,
		);
		return { assets, links, warnings };
	}

	const folderId = await resolveDriveFolderId(driveToken);

	for (const file of files) {
		try {
			const existing = await findDriveFileByName(driveToken, file.name, folderId);
			let fileId = existing?.id;

			if (!fileId) {
				// Notion's file URLs are short-lived signed links, which is exactly
				// why Buffer cannot be handed them directly.
				const download = await fetch(file.url);
				if (!download.ok) {
					warnings.push(`${file.name}: could not download from Notion (${download.status})`);
					continue;
				}
				const bytes = Buffer.from(await download.arrayBuffer());
				const uploaded = await uploadToDrive(
					driveToken,
					file.name,
					mimeFromName(file.name),
					bytes,
					folderId,
				);
				fileId = uploaded.id;
			}

			assets.push(bufferAsset(fileId, mimeFromName(file.name), file.name));
			links.push(driveDirectUrl(fileId));
		} catch (err) {
			warnings.push(`${file.name}: ${(err as Error).message}`);
		}
	}

	return { assets, links, warnings };
}


/**
 * Dated metric history, owned by its own sync.
 *
 * Derived from the Buffer Analytics rows rather than re-querying Buffer, so it
 * costs no extra API budget: analyticsDelta already keeps those rows current,
 * and every field a snapshot needs is on them.
 *
 * This exists as a separate capability because `targetDatabaseKey` does not
 * route — a change emitted by a sync is written to that sync's bound database
 * whatever key it carries. Writing snapshots from analyticsDelta therefore put
 * them in the wrong database entirely.
 *
 * Idempotent by `<postId>:<metricsUpdatedAt>`: unchanged metrics reproduce the
 * same key and update in place, which is what enforces "never create an
 * unchanged snapshot" without a read-back.
 */
worker.sync("snapshotsDelta", {
	database: snapshots,
	mode: "incremental",
	schedule: "1h",
	execute: async (state: { cursor?: string } | undefined, { notion }) => {
		if (!notionWritesReady("snapshotsDelta")) return { changes: [], hasMore: false };

		const dataSourceId = await resolveDataSourceId(notion, "Buffer Analytics", ANALYTICS_DS_ENV);
		// Only rows refreshed recently; older ones already have their snapshot.
		const since = new Date(Date.now() - 3 * DAY_MS).toISOString().split("T")[0]!;

		const res = await notion.dataSources.query({
			data_source_id: dataSourceId,
			filter: { property: "Metrics Updated", date: { on_or_after: since } },
			page_size: 50,
			...(state?.cursor ? { start_cursor: state.cursor } : {}),
		});

		const changes = [];
		for (const row of res.results) {
			const props = (row as { properties: NotionProps }).properties;
			const postId = propText(props, "Buffer Post ID").trim();
			const capturedAt = propDate(props, "Metrics Updated");
			if (!postId || !capturedAt) continue;

			const title = propText(props, "Post") || "(no text)";
			changes.push({
				type: "upsert" as const,
				key: `${postId}:${capturedAt}`,
				properties: {
					Snapshot: Builder.title(`${capturedAt} — ${clampText(title, 50)}`),
					"Snapshot ID": Builder.richText(`${postId}:${capturedAt}`),
					"Buffer Post ID": Builder.richText(postId),
					"Captured At": Builder.date(capturedAt),
					Impressions: metricCell(propNumber(props, "Impressions")),
					Reach: metricCell(propNumber(props, "Reach")),
					Reactions: metricCell(propNumber(props, "Reactions")),
					Likes: metricCell(propNumber(props, "Likes")),
					Comments: metricCell(propNumber(props, "Comments")),
					Shares: metricCell(propNumber(props, "Shares")),
					Reposts: metricCell(propNumber(props, "Reposts")),
					Saves: metricCell(propNumber(props, "Saves")),
					Clicks: metricCell(propNumber(props, "Clicks")),
					Follows: metricCell(propNumber(props, "Follows")),
					Views: metricCell(propNumber(props, "Views")),
					"Engagement Rate %": metricCell(propNumber(props, "Engagement Rate %")),
					"Social Post": [Builder.relation(postId)],
				},
				upstreamUpdatedAt: capturedAt,
			});
		}

		console.log(`[snapshotsDelta] ${changes.length} snapshot(s) from ${res.results.length} row(s)`);

		return {
			changes,
			hasMore: Boolean(res.has_more),
			nextState: res.has_more && res.next_cursor ? { cursor: res.next_cursor } : {},
		};
	},
});

// ─── Publishing ─────────────────────────────────────────────────────────────
//
// Notion → Buffer. This half writes to Notion through `context.notion` rather
// than through sync changes, for the reason set out on the `publishing` database:
// a sync upsert must supply every schema property, so it would overwrite the
// Caption and Channels you authored. Both syncs below therefore return no
// changes and act purely as schedulers.
//
// `worker.automation` would be the natural trigger, but automation capabilities
// are not enabled on this workspace (deploy fails with CapabilityNotEnabledError),
// so publishing polls instead.

/**
 * Resolves the Buffer Publishing data source. Worker-managed databases are not
 * visible to other integrations' search, so an explicit override is offered
 * first — worker-managed databases aren't visible to other integrations' search.
 */
async function resolveDataSourceId(notion: Client, title: string, envVar: string): Promise<string> {
	const override = process.env[envVar];
	if (override) return override;

	const results = await notion.search({
		query: title,
		filter: { property: "object", value: "data_source" },
		page_size: 5,
	});
	const match = results.results[0] as { id: string } | undefined;
	if (!match) {
		throw new Error(
			`Could not find the "${title}" data source. Ensure the worker has deployed and that ` +
				`this connection has access to it, or set ${envVar} explicitly.`,
		);
	}
	return match.id;
}

type NotionProps = Record<string, unknown>;

function propText(props: NotionProps, key: string): string {
	const prop = props[key] as
		| { rich_text?: Array<{ plain_text: string }>; title?: Array<{ plain_text: string }> }
		| undefined;
	return (prop?.rich_text ?? prop?.title ?? []).map((t) => t.plain_text).join("");
}

function propSelect(props: NotionProps, key: string): string {
	return (props[key] as { select?: { name: string } } | undefined)?.select?.name ?? "";
}

function propMultiSelect(props: NotionProps, key: string): string[] {
	const prop = props[key] as { multi_select?: Array<{ name: string }> } | undefined;
	return (prop?.multi_select ?? []).map((o) => o.name);
}

function propFiles(props: NotionProps, key: string): Array<{ name: string; url: string }> {
	const prop = props[key] as
		| { files?: Array<{ name?: string; file?: { url: string }; external?: { url: string } }> }
		| undefined;
	return (prop?.files ?? [])
		.map((f, i) => ({
			name: f.name ?? `attachment-${i}`,
			url: f.file?.url ?? f.external?.url ?? "",
		}))
		.filter((f) => f.url);
}

function propNumber(props: NotionProps, key: string): number | undefined {
	const value = (props[key] as { number?: number | null } | undefined)?.number;
	return typeof value === "number" ? value : undefined;
}

function propDate(props: NotionProps, key: string): string | null {
	return (props[key] as { date?: { start: string } | null } | undefined)?.date?.start ?? null;
}

/** Falls back to the page body when Caption is empty — how IRIS was used in practice. */
async function readPostText(notion: Client, pageId: string, caption: string): Promise<string> {
	if (caption.trim()) return caption.trim();

	const blocks = await notion.blocks.children.list({ block_id: pageId, page_size: 100 });
	const lines: string[] = [];
	for (const block of blocks.results) {
		const b = block as { type: string } & Record<string, unknown>;
		const inner = b[b.type] as { rich_text?: Array<{ plain_text: string }> } | undefined;
		const line = (inner?.rich_text ?? []).map((t) => t.plain_text).join("");
		if (line) lines.push(line);
	}
	return lines.join("\n").trim();
}

interface CreatedPost {
	id: string;
	status: string;
}

/**
 * Creates one Buffer post. `assets` uses the current `@oneOf` AssetInput shape
 * (`[{ image: { url } }]`) — the older `{ images: [...] }` form IRIS used is no
 * longer accepted by the schema.
 */
async function createBufferPost(
	channelId: string,
	text: string,
	assets: Array<Record<string, unknown>>,
	mode: string,
	dueAt: string | null,
): Promise<CreatedPost> {
	const data = await bufferGraphQL<{
		createPost: { post?: CreatedPost; message?: string };
	}>(
		`mutation CreatePost($input: CreatePostInput!) {
			createPost(input: $input) {
				... on PostActionSuccess { post { id status } }
				... on NotFoundError { message }
				... on UnauthorizedError { message }
				... on UnexpectedError { message }
				... on LimitReachedError { message }
				... on InvalidInputError { message }
				... on RestProxyError { message }
			}
		}`,
		{
			input: {
				channelId,
				text,
				schedulingType: "automatic",
				mode,
				// Only customScheduled carries a time; the others are positional.
				...(mode === "customScheduled" && dueAt ? { dueAt } : {}),
				assets,
			},
		},
	);

	if (data.createPost.message) throw new Error(data.createPost.message);
	const post = data.createPost.post;
	if (!post?.id) throw new Error("Buffer accepted the request but returned no post");
	return post;
}

/** Current scheduled-post count against the plan's ceiling (10 on the free tier). */
async function queueDepth(): Promise<{ scheduled: number; limit: number }> {
	const data = await bufferGraphQL<{
		account: { organizations: Array<{ limits: { scheduledPosts: number } }> };
		posts: { edges: Array<unknown> | null };
	}>(
		`query Queue($orgFilter: OrganizationFilterInput, $postsInput: PostsInput!) {
			account { organizations(filter: $orgFilter) { limits { scheduledPosts } } }
			posts(first: 100, input: $postsInput) { edges { cursor } }
		}`,
		{
			orgFilter: { organizationId: getBufferOrgId() },
			postsInput: {
				organizationId: getBufferOrgId(),
				filter: { status: ["scheduled"] },
			},
		},
	);

	return {
		scheduled: (data.posts.edges ?? []).length,
		limit: data.account.organizations[0]?.limits.scheduledPosts ?? 0,
	};
}

/** The exact property shape `notion.pages.update` accepts. */
type UpdateProps = NonNullable<Parameters<Client["pages"]["update"]>[0]["properties"]>;

/**
 * Notion-API-shaped property patch. Only worker-owned fields ever appear here —
 * that is what keeps Caption, Channels and Publish At safe from being clobbered.
 * The single cast is confined to this function.
 */
function workerPatch(fields: {
	status?: string;
	bufferState?: string;
	bufferPostIds?: string;
	postUrl?: string;
	sentAt?: string;
	note?: string;
	/** Analytics page ids to link. */
	analytics?: string[];
}): UpdateProps {
	const props: Record<string, unknown> = {};
	if (fields.status) props[PUB.status] = { select: { name: fields.status } };
	if (fields.bufferState) props[PUB.bufferState] = { select: { name: fields.bufferState } };
	if (fields.bufferPostIds !== undefined)
		props[PUB.bufferPostIds] = { rich_text: [{ text: { content: fields.bufferPostIds } }] };
	if (fields.postUrl) props[PUB.postUrl] = { url: fields.postUrl };
	if (fields.sentAt) props[PUB.sentAt] = { date: { start: fields.sentAt } };
	if (fields.note !== undefined)
		props[PUB.note] = { rich_text: [{ text: { content: clampText(fields.note) } }] };
	if (fields.analytics)
		props[PUB.analytics] = { relation: fields.analytics.map((id) => ({ id })) };
	return props as UpdateProps;
}

/**
 * Digs a Notion page id out of a webhook payload.
 *
 * Notion's "Send webhook" automation delivers the triggering page at `data.id`
 * (verified 2026-07-28), with the database id nested separately under
 * `data.parent.database_id` — so keying on `data.id` never picks up the wrong
 * one. The other candidate paths are defensive, in case Notion changes the shape.
 * Returning undefined is handled by the caller (it falls back to the sweep), not
 * an error.
 */
function extractPageId(body: Record<string, unknown>): string | undefined {
	const candidates = [
		body,
		body.data,
		body.page,
		body.entity,
		(body.data as Record<string, unknown> | undefined)?.page,
	];
	for (const candidate of candidates) {
		const id = (candidate as { id?: unknown } | undefined)?.id;
		if (typeof id === "string" && /^[0-9a-f]{8}-?[0-9a-f]{4}/i.test(id)) return id;
	}
	return undefined;
}

/**
 * The Status values that mean "act on this", mapped to Buffer's ShareMode.
 *
 * The status is the instruction, not just a state: picking one of these is how
 * you tell the worker what to do, and the worker then moves the row on to
 * Scheduled / Published / Failed. Anything not listed here is inert.
 */
const PUBLISH_TRIGGERS: Record<string, string> = {
	"Publish Now": "shareNow",
	"Publish at Time": "customScheduled",
	"Publish to Queue": "addToQueue",
	"Next Buffer Slot": "shareNext",
};

/**
 * Every property name the worker reads from or writes to the Buffer Publishing
 * database, in one place.
 *
 * Publishing is a plain, user-owned database — its columns can be renamed freely
 * in Notion — but the worker addresses them by name, so a rename there must be
 * mirrored to exactly one of these values and redeployed. (Analytics and
 * Snapshots are worker-managed: their names live in the schema declarations and
 * cannot drift, so they are deliberately not centralised here.)
 */
const PUB = {
	content: "Content",
	copy: "Post's Copy",
	channels: "Channels",
	publishAt: "Publish At",
	media: "Post's Media",
	mediaUrls: "Media URLs",
	status: "Status",
	bufferPostIds: "Buffer Post IDs",
	bufferState: "Buffer State",
	sentAt: "Sent At",
	postUrl: "Post URL",
	note: "Note from Buffer Worker",
	analytics: "Analytics",
} as const;

const PUBLISHING_DS_ENV = "BUFFER_PUBLISHING_DATA_SOURCE_ID";

/**
 * Both publishing syncs read and write Notion through `context.notion`, which
 * needs NOTION_API_TOKEN outside a Custom Agent context. Rather than throwing
 * every five minutes until it is configured, they skip with a clear log and
 * begin working the moment the variable appears — no redeploy needed.
 */
function notionWritesReady(syncName: string): boolean {
	if (process.env.NOTION_API_TOKEN) return true;
	console.log(
		`[${syncName}] NOTION_API_TOKEN is not set — skipping. ` +
			"Create a connection at https://app.notion.com/developers/connections, give it access " +
			"to Buffer Publishing, then: ntn workers env set NOTION_API_TOKEN=<token>",
	);
	return false;
}

/**
 * Notion channel label → Buffer channel id, resolved live so ids are never
 * hardcoded.
 *
 * Keyed on the full label (which includes the platform) rather than a bare name.
 * A client can have the same account name on two networks (e.g. one brand on both
 * LinkedIn and Google Business); keying on the bare name would let the later one
 * silently overwrite the earlier, delivering a post to the wrong network. A
 * residual collision is treated as fatal rather than guessed at.
 */
async function channelIdsByLabel(): Promise<Map<string, string>> {
	const channels = await fetchChannels();
	const map = new Map<string, string>();

	for (const channel of channels) {
		const label = channelLabel(channel);
		const existing = map.get(label);
		if (existing && existing !== channel.id) {
			throw new Error(
				`Two Buffer channels share the label "${label}" (${existing} and ${channel.id}). ` +
					"Rename one in Buffer — publishing is blocked rather than risk posting to the wrong channel.",
			);
		}
		map.set(label, channel.id);
	}

	return map;
}

/**
 * Publishes rows whose Status is one of the four publish triggers.
 *
 * Returns no changes: it is a scheduler, and writes through `context.notion` so
 * that only worker-owned properties are touched.
 *
 * Idempotency rests on `Buffer Post IDs` being empty — a row that already has
 * them is skipped, so a re-run, a retry after a crash, or a double trigger
 * cannot post twice. This is the single most important guard here.
 */
interface PublishOutcome {
	posted: number;
	summary: string;
}

/**
 * Publishes one Buffer Publishing row. Shared by publishSync and the publishNow
 * tool so the guards — idempotency above all — can never drift apart.
 *
 * `remaining` is the number of Buffer queue slots still free; the caller
 * decrements by the returned `posted` count.
 */
async function publishRow(
	notion: Client,
	page: { id: string; properties: NotionProps },
	channelIds: Map<string, string>,
	remaining: number,
	queue: { scheduled: number; limit: number },
): Promise<PublishOutcome> {
	const title = propText(page.properties, PUB.content) || "Untitled";

	// Idempotency, and the single most important guard here: a row that already
	// reached Buffer is never re-sent, so retries and double triggers cannot post
	// twice. Rather than leave the row stuck on the publish trigger it was set to
	// (which reads as "still trying" when it is actually done), reset its Status
	// to match the Buffer state it is already in, and say why. Writing a non-
	// trigger Status also can't re-fire the Notion automation.
	if (propText(page.properties, PUB.bufferPostIds).trim()) {
		const bufferState = propSelect(page.properties, PUB.bufferState);
		await notion.pages.update({
			page_id: page.id,
			properties: workerPatch({
				status: bufferState === "sent" ? "Published" : "Scheduled",
				note: "Already sent to Buffer — re-trigger ignored to avoid double-posting. Clear Buffer Post IDs only if you truly intend to republish.",
			}),
		});
		return { posted: 0, summary: `"${title}" skipped — already published (status reset)` };
	}

	const status = propSelect(page.properties, PUB.status);
	const channels = propMultiSelect(page.properties, PUB.channels);
	const text = await readPostText(notion, page.id, propText(page.properties, PUB.copy));
	const dueAt = propDate(page.properties, PUB.publishAt);

	let mode = PUBLISH_TRIGGERS[status];
	if (!mode) {
		return { posted: 0, summary: `"${title}" skipped — status "${status}" is not a publish trigger` };
	}

	// "Publish at Time" without a usable future time falls back to publishing
	// immediately, by explicit choice (2026-07-22). Buffer rejects a past dueAt
	// outright ("dueAt must be in the future"), so the alternative is a failed
	// row. The reason is always written to Worker Note so this is never silent.
	let fallbackNote = "";
	if (mode === "customScheduled") {
		const when = dueAt ? Date.parse(dueAt) : Number.NaN;
		if (Number.isNaN(when)) {
			mode = "shareNow";
			fallbackNote = "Publish At was empty, so this went out immediately. ";
		} else if (when <= Date.now()) {
			mode = "shareNow";
			fallbackNote = `Publish At (${dueAt}) was in the past, so this went out immediately. `;
		}
	}
	const externalUrls = propText(page.properties, PUB.mediaUrls)
		.split(/[\s,]+/)
		.filter((u) => u.startsWith("http"));
	const attachments = propFiles(page.properties, PUB.media);

	const problem = !channels.length
		? "No channels selected."
		: !text
			? "No copy found. Write it in the Caption property or the page body."
			: null;

	if (problem) {
		await notion.pages.update({
			page_id: page.id,
			properties: workerPatch({ status: "Failed", note: problem }),
		});
		return { posted: 0, summary: `"${title}" failed validation — ${problem}` };
	}

	if (remaining < channels.length) {
		const note =
			`Buffer queue is full (${queue.scheduled}/${queue.limit} scheduled). ` +
			`This needs ${channels.length} slot(s). Status left unchanged — ` +
			"it will go out once the queue drains.";
		await notion.pages.update({ page_id: page.id, properties: workerPatch({ note }) });
		return { posted: 0, summary: `"${title}" parked — Buffer queue full` };
	}

	// Re-host once, then reuse across every channel — uploading per channel would
	// duplicate the same file in Drive.
	const media = await prepareMedia(attachments, externalUrls);

	const postIds: string[] = [];
	const failures: string[] = [...media.warnings];

	for (const channel of channels) {
		const channelId = channelIds.get(channel);
		if (!channelId) {
			failures.push(`${channel}: not connected to Buffer`);
			continue;
		}
		try {
			const post = await createBufferPost(channelId, text, media.assets, mode, dueAt);
			postIds.push(`${channel}=${post.id}`);
		} catch (err) {
			failures.push(`${channel}: ${(err as Error).message}`);
		}
	}

	// Ids are recorded even on partial failure, so a re-run cannot republish the
	// channels that already succeeded.
	await notion.pages.update({
		page_id: page.id,
		properties: workerPatch({
			status: postIds.length ? "Scheduled" : "Failed",
			bufferState: postIds.length ? "scheduled" : "error",
			bufferPostIds: postIds.join(", "),
			note: failures.length
				? `${fallbackNote}Published to ${postIds.length}/${channels.length} channel(s). Failed: ${failures.join("; ")}`
				: `${fallbackNote}Published to ${channels.length} channel(s) via ${mode}.`,
		}),
	});

	return {
		posted: postIds.length,
		summary:
			`"${title}" → ${postIds.length} posted` +
			(failures.length ? `, ${failures.length} failed: ${failures.join("; ")}` : ""),
	};
}

/**
 * Publishes every row whose Status is a publish trigger.
 *
 * Shared by the scheduled sync and the webhook, so an instant trigger and a
 * timed one behave identically — including the queue accounting, which is why
 * `remaining` is threaded through rather than recomputed per row.
 */
async function publishAllReady(notion: Client, caller: string): Promise<string[]> {
	const dataSourceId = await resolveDataSourceId(notion, "Buffer Publishing", PUBLISHING_DS_ENV);

	const ready = await notion.dataSources.query({
		data_source_id: dataSourceId,
		filter: {
			or: Object.keys(PUBLISH_TRIGGERS).map((name) => ({
				property: PUB.status,
				select: { equals: name },
			})),
		},
		page_size: 10,
	});
	if (!ready.results.length) return [];

	const channelIds = await channelIdsByLabel();
	const { scheduled, limit } = await queueDepth();
	let remaining = limit > 0 ? limit - scheduled : Number.MAX_SAFE_INTEGER;

	console.log(`[${caller}] ${ready.results.length} ready, Buffer queue ${scheduled}/${limit}`);

	const summaries: string[] = [];
	for (const row of ready.results) {
		const page = row as { id: string; properties: NotionProps };
		const result = await publishRow(notion, page, channelIds, remaining, { scheduled, limit });
		remaining -= result.posted;
		summaries.push(result.summary);
		console.log(`[${caller}] ${result.summary}`);
	}
	return summaries;
}

/** Publishes a single row by page id — the webhook's fast path. */
async function publishPageById(notion: Client, pageId: string, caller: string): Promise<string> {
	const page = (await notion.pages.retrieve({ page_id: pageId })) as {
		id: string;
		properties: NotionProps;
	};
	const channelIds = await channelIdsByLabel();
	const queue = await queueDepth();
	const remaining = queue.limit > 0 ? queue.limit - queue.scheduled : Number.MAX_SAFE_INTEGER;

	const result = await publishRow(notion, page, channelIds, remaining, queue);
	console.log(`[${caller}] ${result.summary}`);
	return result.summary;
}

/**
 * Safety net rather than the primary trigger. The webhook below fires the moment
 * you set a publish trigger; this sweep exists so nothing is stranded if
 * a webhook delivery is lost, the automation is switched off, or a row is set
 * ready while the automation is misconfigured.
 */
worker.sync("publishSync", {
	// Bound to `analytics` only because worker.sync() requires a handle. This sync
	// writes nothing declaratively (always `changes: []`) and touches Buffer
	// Publishing exclusively through `context.notion`. Incremental mode with no
	// changes deletes nothing, so binding here is inert.
	database: analytics,
	// Never "replace": this database holds rows you wrote by hand.
	mode: "incremental",
	schedule: "5m",
	execute: async (_state, { notion }) => {
		if (!notionWritesReady("publishSync")) return { changes: [], hasMore: false };
		await publishAllReady(notion, "publishSync");
		return { changes: [], hasMore: false };
	},
});

/**
 * Instant trigger, driven by a Notion database automation:
 *   Buffer Publishing → Automations → When Status is any of "Publish Now",
 *   "Publish at Time", "Publish to Queue" or "Next Buffer Slot"
 *   → Send webhook to this capability's URL.
 *
 * Notion's payload shape is not contractually stable, so the page id is dug out
 * of the likely locations and the handler falls back to sweeping every Ready row
 * if it cannot find one — the outcome is then the same as the scheduled sync,
 * just sooner.
 *
 * Get the URL with: ntn workers webhooks list
 */
worker.webhook("onReadyToPublish", {
	title: "Publish on Ready",
	description:
		"Fired by a Notion automation when a Buffer Publishing row is set to one of the publish statuses. " +
		"Publishes it to Buffer immediately rather than waiting for the 5-minute sweep.",
	execute: async (events, { notion }) => {
		if (!process.env.NOTION_API_TOKEN) {
			console.log("[onReadyToPublish] NOTION_API_TOKEN is not set — cannot act on webhook");
			return;
		}

		// Optional shared secret. Verification is skipped when unset rather than
		// enforced, because the platform hard-blocks a webhook after 5 consecutive
		// verification failures until the worker is redeployed — a harsh failure
		// mode for a trigger whose worst case is publishing a row you had already
		// marked ready. Set PUBLISH_WEBHOOK_SECRET and add a matching
		// X-Buffer-Worker-Secret header in the Notion automation to harden it.
		const secret = process.env.PUBLISH_WEBHOOK_SECRET;

		for (const event of events) {
			if (secret) {
				const supplied =
					event.headers["x-buffer-worker-secret"] ?? event.headers["X-Buffer-Worker-Secret"];
				if (supplied !== secret) {
					throw new WebhookVerificationError("Invalid or missing X-Buffer-Worker-Secret");
				}
			}

			const pageId = extractPageId(event.body);
			try {
				if (pageId) {
					await publishPageById(notion, pageId, "onReadyToPublish");
				} else {
					console.log("[onReadyToPublish] no page id in payload — sweeping all Ready rows");
					await publishAllReady(notion, "onReadyToPublish");
				}
			} catch (err) {
				// Never rethrow: a thrown handler is retried, and retries on a
				// publishing path are how duplicate posts happen. The row's own
				// Worker Note already records the failure.
				console.log(`[onReadyToPublish] failed: ${(err as Error).message}`);
			}
		}
	},
});

const ANALYTICS_DS_ENV = "BUFFER_ANALYTICS_DATA_SOURCE_ID";

/** "Label=id, Label=id" → the bare Buffer post ids. */
function parseBufferPostIds(props: NotionProps): string[] {
	return propText(props, PUB.bufferPostIds)
		.split(",")
		.map((entry) => entry.split("=").pop()?.trim())
		.filter((id): id is string => Boolean(id));
}

/**
 * Analytics page ids for the given Buffer post ids.
 *
 * Returns only rows that exist. A post published seconds ago has no analytics
 * row yet — analyticsDelta creates it on its next sweep — so a partial or empty
 * result is normal, and statusSync retries the link on a later pass rather than
 * treating it as a failure.
 */
async function findAnalyticsPages(notion: Client, bufferPostIds: string[]): Promise<string[]> {
	const dataSourceId = await resolveDataSourceId(notion, "Buffer Analytics", ANALYTICS_DS_ENV);
	const pageIds: string[] = [];

	for (const postId of bufferPostIds) {
		const res = await notion.dataSources.query({
			data_source_id: dataSourceId,
			filter: { property: "Buffer Post ID", rich_text: { equals: postId } },
			page_size: 1,
		});
		const page = res.results[0] as { id: string } | undefined;
		if (page) pageIds.push(page.id);
	}
	return pageIds;
}

/**
 * Reconciles rows already sent to Buffer, and links them to their analytics.
 *
 * Two passes, because the two things settle at different times:
 *  1. `scheduled` rows — ask Buffer whether they have sent yet, and move them to
 *     Published (or Failed) accordingly.
 *  2. `sent` rows whose Analytics relation is still empty — the analytics row did
 *     not exist when they were first reconciled, so link them now.
 *
 * Writes directly rather than through sync changes, so only worker-owned
 * properties are touched.
 */
worker.sync("statusSync", {
	// See publishSync: inert binding, all real work goes through context.notion.
	database: analytics,
	mode: "incremental",
	// Two cheap Notion queries when idle, so a short interval costs little and
	// keeps "Published" close behind Buffer actually sending.
	schedule: "5m",
	execute: async (_state, { notion }) => {
		if (!notionWritesReady("statusSync")) return { changes: [], hasMore: false };

		const dataSourceId = await resolveDataSourceId(notion, "Buffer Publishing", PUBLISHING_DS_ENV);

		// ── Pass 1: has Buffer sent it yet? ──────────────────────────────────
		const pending = await notion.dataSources.query({
			data_source_id: dataSourceId,
			filter: { property: PUB.bufferState, select: { equals: "scheduled" } },
			page_size: 25,
		});

		console.log(`[statusSync] ${pending.results.length} awaiting reconciliation`);

		for (const row of pending.results) {
			const page = row as { id: string; properties: NotionProps };
			const ids = parseBufferPostIds(page.properties);
			if (!ids.length) continue;

			let allSent = true;
			let sentAt: string | null = null;
			let postUrl: string | null = null;
			const errors: string[] = [];

			for (const id of ids) {
				try {
					const data = await bufferGraphQL<{ post: BufferPost }>(
						`query P($input: PostInput!) {
							post(input: $input) { id status sentAt externalLink error { message } }
						}`,
						{ input: { id } },
					);
					const post = data.post as BufferPost & { error?: { message: string } | null };

					if (post.status === "error") {
						errors.push(post.error?.message ?? "Buffer reported an error");
						allSent = false;
					} else if (post.status === "sent") {
						sentAt = sentAt ?? post.sentAt;
						postUrl = postUrl ?? post.externalLink;
					} else {
						allSent = false;
					}
				} catch (err) {
					errors.push((err as Error).message);
					allSent = false;
				}
			}

			if (errors.length) {
				await notion.pages.update({
					page_id: page.id,
					properties: workerPatch({
						status: "Failed",
						bufferState: "error",
						note: `Buffer publishing failed: ${errors.join("; ")}`,
					}),
				});
				continue;
			}

			if (!allSent) continue;

			// Link whatever analytics rows exist by now; pass 2 catches the rest.
			const analyticsPages = await findAnalyticsPages(notion, ids);
			await notion.pages.update({
				page_id: page.id,
				properties: workerPatch({
					status: "Published",
					bufferState: "sent",
					...(sentAt ? { sentAt: sentAt.split("T")[0] } : {}),
					...(postUrl ? { postUrl } : {}),
					...(analyticsPages.length ? { analytics: analyticsPages } : {}),
					note: analyticsPages.length
						? "Live, analytics linked."
						: "Live. Analytics will link once the next metrics sweep runs.",
				}),
			});
		}

		// ── Pass 2: back-fill links that were not ready first time ───────────
		const unlinked = await notion.dataSources.query({
			data_source_id: dataSourceId,
			filter: {
				and: [
					{ property: PUB.bufferState, select: { equals: "sent" } },
					{ property: PUB.analytics, relation: { is_empty: true } },
				],
			},
			page_size: 25,
		});

		if (unlinked.results.length) {
			console.log(`[statusSync] ${unlinked.results.length} published row(s) awaiting analytics`);
		}

		for (const row of unlinked.results) {
			const page = row as { id: string; properties: NotionProps };
			const ids = parseBufferPostIds(page.properties);
			if (!ids.length) continue;

			const analyticsPages = await findAnalyticsPages(notion, ids);
			if (!analyticsPages.length) continue;

			await notion.pages.update({
				page_id: page.id,
				properties: workerPatch({
					analytics: analyticsPages,
					note: "Live, analytics linked.",
				}),
			});
		}

		return { changes: [], hasMore: false };
	},
});

// ─── Social Syncer tools ────────────────────────────────────────────────────
//
// The prompt-only agent's surface. Note a platform constraint that shapes these:
// a tool cannot trigger a sync, and cannot write to a managed database (Notion
// rejects every write to a synced mirror that does not come through the sync
// pipeline). So the agent can publish, inspect and report — but forcing a full
// analytics rebuild remains a CLI action:
//   ntn workers sync state reset analyticsBackfill && ntn workers sync trigger analyticsBackfill

worker.tool("checkQueue", {
	title: "Check Buffer Queue",
	description:
		"Reports how many posts are scheduled in Buffer against the plan's ceiling, and how " +
		"many free slots remain. Use before publishing a batch, or to explain why something " +
		"is parked awaiting a free slot.",
	// Notion agents call these no-argument tools inconsistently — sometimes `{}`,
	// sometimes `{ name: ... }` (the agent's cached tool schema lags deploys). The
	// builder can't mark a property optional (every property is forced into
	// `required`), so accept BOTH shapes with anyOf. The handler ignores the input.
	schema: j.anyOf(j.object({}), j.object({ name: j.string().nullable() })),
	execute: async () => {
		const { scheduled, limit } = await queueDepth();
		const free = limit > 0 ? limit - scheduled : null;
		const channels = await fetchChannels();

		return [
			`Buffer queue: ${scheduled} scheduled of ${limit} allowed` +
				(free !== null ? ` — ${free} slot(s) free` : ""),
			free !== null && free <= 0
				? "Queue is full. New posts will be parked until it drains."
				: "",
			"",
			`Connected channels (${channels.length}):`,
			...channels.map((c) => `  ${channelLabel(c)}`),
		]
			.filter(Boolean)
			.join("\n");
	},
});

worker.tool("publishNow", {
	title: "Publish Now",
	description:
		"Publishes a specific Buffer Publishing row to Buffer immediately, without waiting for " +
		"the 5-minute cycle. Matches on the row's title. Refuses rows that already carry Buffer " +
		"post ids, so it cannot double-post.",
	schema: j.object({
		title: j
			.string()
			.describe("The Content title of the row to publish. Matched case-insensitively."),
	}),
	execute: async ({ title }: { title: string }, { notion }) => {
		const dataSourceId = await resolveDataSourceId(
			notion,
			"Buffer Publishing",
			PUBLISHING_DS_ENV,
		);

		const matches = await notion.dataSources.query({
			data_source_id: dataSourceId,
			filter: { property: PUB.content, title: { contains: title } },
			page_size: 5,
		});

		if (!matches.results.length) return `No Buffer Publishing row matching "${title}".`;
		if (matches.results.length > 1) {
			const names = matches.results
				.map((r) => propText((r as { properties: NotionProps }).properties, PUB.content))
				.join(", ");
			return `"${title}" is ambiguous — matched ${matches.results.length} rows: ${names}. Be more specific.`;
		}

		const page = matches.results[0] as { id: string; properties: NotionProps };
		const channelIds = await channelIdsByLabel();
		const queue = await queueDepth();
		const remaining = queue.limit > 0 ? queue.limit - queue.scheduled : Number.MAX_SAFE_INTEGER;

		const result = await publishRow(notion, page, channelIds, remaining, queue);
		return result.summary;
	},
});

worker.tool("syncHealth", {
	title: "Check Publishing Health",
	description:
		"Reports what is in flight in Buffer Publishing: rows waiting to publish, rows awaiting " +
		"reconciliation, and rows that failed with their reasons. Use to answer 'did my post go out?' " +
		"or 'why is nothing happening?'.",
	// Notion agents call these no-argument tools inconsistently — sometimes `{}`,
	// sometimes `{ name: ... }` (the agent's cached tool schema lags deploys). The
	// builder can't mark a property optional (every property is forced into
	// `required`), so accept BOTH shapes with anyOf. The handler ignores the input.
	schema: j.anyOf(j.object({}), j.object({ name: j.string().nullable() })),
	execute: async (_input, { notion }) => {
		const dataSourceId = await resolveDataSourceId(
			notion,
			"Buffer Publishing",
			PUBLISHING_DS_ENV,
		);

		const buckets: Array<[string, string]> = [
			...Object.keys(PUBLISH_TRIGGERS).map(
				(name) => [name, "waiting to go out"] as [string, string],
			),
			["Scheduled", "awaiting reconciliation"],
			["Failed", "failed"],
		];
		const lines: string[] = [];

		for (const [status, label] of buckets) {
			const rows = await notion.dataSources.query({
				data_source_id: dataSourceId,
				filter: { property: PUB.status, select: { equals: status } },
				page_size: 25,
			});

			lines.push(`${status} — ${rows.results.length} ${label}`);
			for (const row of rows.results) {
				const props = (row as { properties: NotionProps }).properties;
				const name = propText(props, PUB.content) || "Untitled";
				const note = propText(props, PUB.note);
				lines.push(`  ${name}${note ? ` — ${note.slice(0, 140)}` : ""}`);
			}
		}

		return lines.join("\n");
	},
});
