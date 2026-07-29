/**
 * The only file you might edit per client — and only if you want to.
 *
 * Out of the box the worker labels channels straight from Buffer, e.g. a
 * LinkedIn channel named "Acme Corp" becomes "Acme Corp (LinkedIn)". That is
 * usually enough. Use the overrides below only when you want curated names —
 * for instance to make personal vs company unmistakable.
 */

/**
 * Optional curated channel labels. Key each entry by `service:displayName`
 * exactly as Buffer reports it (run `ntn workers exec listChannels` to see the
 * raw names). The value is the label shown in Notion.
 *
 * @example
 * export const CHANNEL_OVERRIDES: Record<string, string> = {
 *   "linkedin:Acme Corp": "Company LinkedIn (acme)",
 *   "linkedin:Jane Doe": "Personal LinkedIn (jane)",
 *   "twitter:acmehq": "Company X (acmehq)",
 * };
 */
export const CHANNEL_OVERRIDES: Record<string, string> = {};

/**
 * The Google Drive folder re-hosted media is uploaded into. The worker creates
 * it on first use (the drive.file scope only sees folders the app created, so it
 * must be app-created — do not pre-make it by hand). Rename per client if you
 * like; one folder per client keeps their media separate.
 */
export const DRIVE_FOLDER_NAME = "Buffer Social Media";
