/**
 * Scheduled posts: stored in D1 with the LinkedIn token encrypted
 * (AES-256-GCM, key from the SCHEDULE_ENCRYPTION_KEY secret), published by
 * a Cron Trigger that runs every minute.
 */
import { LinkedInError } from "./linkedin";
import { type PostRequest, publish } from "./publish";

export const MAX_SCHEDULE_DAYS = 59;

interface Payload {
  token: string;
  tokenExpiresAt: number;
  post: PostRequest;
}

export interface ScheduledRow {
  id: string;
  member_sub: string;
  run_at: number;
  publish_at: string;
  status: "pending" | "publishing" | "published" | "failed" | "cancelled";
  preview: string;
  payload: string;
  attempts: number;
  post_urn: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------- crypto

let cachedKey: { raw: string; key: CryptoKey } | undefined;

async function key(env: Env): Promise<CryptoKey> {
  const raw = env.SCHEDULE_ENCRYPTION_KEY;
  if (!raw || raw.length < 32) {
    throw new Error("SCHEDULE_ENCRYPTION_KEY secret is missing or shorter than 32 characters");
  }
  if (cachedKey?.raw === raw) return cachedKey.key;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  const k = await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
  cachedKey = { raw, key: k };
  return k;
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function seal(env: Env, id: string, payload: Payload): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(payload));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(id) }, await key(env), data),
  );
  return `v1.${b64(iv)}.${b64(ct)}`;
}

async function open(env: Env, id: string, sealed: string): Promise<Payload> {
  const [v, iv, ct] = sealed.split(".");
  if (v !== "v1") throw new Error("unknown payload version");
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(iv), additionalData: new TextEncoder().encode(id) },
    await key(env),
    unb64(ct),
  );
  return JSON.parse(new TextDecoder().decode(pt)) as Payload;
}

// ---------------------------------------------------------------- time

/** Parses "2026-11-08T09:00:00+05:30" (offset or Z required). Returns epoch ms or null. */
export function parsePublishAt(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Shows an epoch time in the same UTC offset the user gave, e.g. "Sun 8 Nov 2026, 09:00 (UTC+05:30)". */
export function formatLike(ms: number, publishAt: string): string {
  const m = publishAt.match(/([+-])(\d{2}):(\d{2})$/);
  const offsetMin = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  const d = new Date(ms + offsetMin * 60_000);
  const day = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
  const label = m ? `UTC${m[1]}${m[2]}:${m[3]}` : "UTC";
  return `${day}, ${time} (${label})`;
}

// ---------------------------------------------------------------- schema

// Same SQL as migrations/0001_scheduled_posts.sql. Running it on first use
// means a fresh database needs no manual migration step.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS scheduled_posts (
     id TEXT PRIMARY KEY, member_sub TEXT NOT NULL, run_at INTEGER NOT NULL, publish_at TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending', preview TEXT NOT NULL, payload TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0, post_urn TEXT, error TEXT,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_posts (status, run_at)`,
  `CREATE INDEX IF NOT EXISTS idx_scheduled_member ON scheduled_posts (member_sub, run_at)`,
];
let schemaReady: Promise<void> | undefined;

export function ensureSchema(env: Env): Promise<void> {
  schemaReady ??= env.DB.batch(SCHEMA.map((q) => env.DB.prepare(q)))
    .then(() => undefined)
    .catch((e) => {
      schemaReady = undefined; // try again next time
      throw e;
    });
  return schemaReady;
}

// ---------------------------------------------------------------- store

const newId = () => `sp_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
const previewOf = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 77)}…` : flat;
};

export async function createScheduled(
  env: Env,
  opts: { memberSub: string; runAt: number; publishAt: string; token: string; tokenExpiresAt: number; post: PostRequest },
): Promise<ScheduledRow> {
  await ensureSchema(env);
  const id = newId();
  const now = Date.now();
  const payload = await seal(env, id, { token: opts.token, tokenExpiresAt: opts.tokenExpiresAt, post: opts.post });
  const row: ScheduledRow = {
    id,
    member_sub: opts.memberSub,
    run_at: opts.runAt,
    publish_at: opts.publishAt,
    status: "pending",
    preview: previewOf(opts.post.text),
    payload,
    attempts: 0,
    post_urn: null,
    error: null,
    created_at: now,
    updated_at: now,
  };
  await env.DB.prepare(
    `INSERT INTO scheduled_posts (id, member_sub, run_at, publish_at, status, preview, payload, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, 0, ?, ?)`,
  )
    .bind(row.id, row.member_sub, row.run_at, row.publish_at, row.preview, row.payload, now, now)
    .run();
  return row;
}

export async function listScheduled(env: Env, memberSub: string): Promise<ScheduledRow[]> {
  await ensureSchema(env);
  const weekAgo = Date.now() - 7 * 86_400_000;
  const { results } = await env.DB.prepare(
    `SELECT id, member_sub, run_at, publish_at, status, preview, attempts, post_urn, error, created_at, updated_at, '' AS payload
       FROM scheduled_posts
      WHERE member_sub = ?
        AND (status IN ('pending', 'publishing') OR updated_at >= ?)
      ORDER BY run_at ASC
      LIMIT 100`,
  )
    .bind(memberSub, weekAgo)
    .all<ScheduledRow>();
  return results;
}

/** Cancels a pending post. Returns false if it isn't this member's or isn't pending any more. */
export async function cancelScheduled(env: Env, memberSub: string, id: string): Promise<ScheduledRow | null> {
  await ensureSchema(env);
  const row = await env.DB.prepare(
    `UPDATE scheduled_posts SET status = 'cancelled', payload = '', updated_at = ?
      WHERE id = ? AND member_sub = ? AND status = 'pending'
      RETURNING id, member_sub, run_at, publish_at, status, preview, attempts, post_urn, error, created_at, updated_at, '' AS payload`,
  )
    .bind(Date.now(), id, memberSub)
    .first<ScheduledRow>();
  return row ?? null;
}

export async function getScheduled(env: Env, memberSub: string, id: string): Promise<ScheduledRow | null> {
  await ensureSchema(env);
  return (
    (await env.DB.prepare(
      `SELECT id, member_sub, run_at, publish_at, status, preview, attempts, post_urn, error, created_at, updated_at, '' AS payload
         FROM scheduled_posts WHERE id = ? AND member_sub = ?`,
    )
      .bind(id, memberSub)
      .first<ScheduledRow>()) ?? null
  );
}

/** When a member reconnects, give their pending posts the new LinkedIn token. */
export async function refreshPendingTokens(env: Env, memberSub: string, token: string, tokenExpiresAt: number) {
  await ensureSchema(env);
  const { results } = await env.DB.prepare(
    `SELECT id, payload FROM scheduled_posts WHERE member_sub = ? AND status = 'pending'`,
  )
    .bind(memberSub)
    .all<{ id: string; payload: string }>();
  for (const r of results) {
    try {
      const p = await open(env, r.id, r.payload);
      const sealed = await seal(env, r.id, { ...p, token, tokenExpiresAt });
      await env.DB.prepare(`UPDATE scheduled_posts SET payload = ?, updated_at = ? WHERE id = ? AND status = 'pending'`)
        .bind(sealed, Date.now(), r.id)
        .run();
    } catch (e) {
      console.error("refresh token for scheduled post failed", r.id, e instanceof Error ? e.message : e);
    }
  }
}

// ---------------------------------------------------------------- publisher (cron)

const RETRY_DELAYS_MS = [2 * 60_000, 10 * 60_000, 30 * 60_000];
const STUCK_AFTER_MS = 10 * 60_000;

/** Runs every minute: claims due posts atomically and publishes them. */
export async function runDuePosts(env: Env): Promise<{ published: number; failed: number; retried: number }> {
  await ensureSchema(env);
  const now = Date.now();
  const stats = { published: 0, failed: 0, retried: 0 };

  // A run that crashed mid-publish leaves rows in 'publishing'. Don't re-post
  // them blindly (LinkedIn may have accepted the post); mark them for a look.
  await env.DB.prepare(
    `UPDATE scheduled_posts SET status = 'failed', payload = '', updated_at = ?,
            error = 'Publishing was interrupted. Check your LinkedIn profile: the post may or may not have gone out.'
      WHERE status = 'publishing' AND updated_at < ?`,
  )
    .bind(now, now - STUCK_AFTER_MS)
    .run();

  // Claim due rows in one statement so overlapping runs never take the same post.
  const { results: due } = await env.DB.prepare(
    `UPDATE scheduled_posts SET status = 'publishing', attempts = attempts + 1, updated_at = ?
      WHERE id IN (SELECT id FROM scheduled_posts WHERE status = 'pending' AND run_at <= ? ORDER BY run_at LIMIT 25)
      RETURNING *`,
  )
    .bind(now, now)
    .all<ScheduledRow>();

  for (const row of due) {
    try {
      const p = await open(env, row.id, row.payload);
      if (Date.now() > p.tokenExpiresAt) {
        throw new LinkedInError("Your LinkedIn sign-in expired before this post was due. Reconnect and schedule it again.", 401, "auth");
      }
      const { urn } = await publish(p.token, env.LINKEDIN_VERSION, row.member_sub, p.post);
      await env.DB.prepare(
        `UPDATE scheduled_posts SET status = 'published', post_urn = ?, payload = '', error = NULL, updated_at = ? WHERE id = ?`,
      )
        .bind(urn, Date.now(), row.id)
        .run();
      stats.published++;
    } catch (e) {
      const err = e instanceof LinkedInError ? e : null;
      const retryable = !err || err.kind === "upstream" || err.kind === "rate_limit";
      const delay = err?.kind === "rate_limit" ? 60 * 60_000 : RETRY_DELAYS_MS[row.attempts - 1];
      const message = err?.message ?? "Unexpected error while publishing.";
      if (!(e instanceof LinkedInError)) console.error("scheduled publish failed", row.id, e instanceof Error ? e.message : e);
      if (retryable && delay !== undefined) {
        await env.DB.prepare(`UPDATE scheduled_posts SET status = 'pending', run_at = ?, error = ?, updated_at = ? WHERE id = ?`)
          .bind(Date.now() + delay, `Retrying: ${message}`, Date.now(), row.id)
          .run();
        stats.retried++;
      } else {
        await env.DB.prepare(`UPDATE scheduled_posts SET status = 'failed', payload = '', error = ?, updated_at = ? WHERE id = ?`)
          .bind(message, Date.now(), row.id)
          .run();
        stats.failed++;
      }
    }
  }

  // Housekeeping: forget finished rows after 30 days.
  await env.DB.prepare(
    `DELETE FROM scheduled_posts WHERE status IN ('published', 'failed', 'cancelled') AND updated_at < ?`,
  )
    .bind(now - 30 * 86_400_000)
    .run();

  return stats;
}
