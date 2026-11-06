import { McpServer } from "@modelcontextprotocol/server";
import { getMcpAuthContext } from "agents/mcp/server";
import { env } from "cloudflare:workers";
import { z } from "zod";
import type { GrantProps } from "./env";
import { LinkedInError, deletePost, getMember, postUrl, type Visibility } from "./linkedin";
import { type PostRequest, publish } from "./publish";
import {
  MAX_SCHEDULE_DAYS,
  type ScheduledRow,
  cancelScheduled,
  createScheduled,
  formatLike,
  getScheduled,
  listScheduled,
  parsePublishAt,
} from "./schedule";

const MAX_POST_CHARS = 3000;

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

function session(): GrantProps {
  const props = getMcpAuthContext()?.props as Partial<GrantProps> | undefined;
  if (!props?.sub || !props.linkedinToken) {
    throw new LinkedInError("This connection has no LinkedIn sign-in. Reconnect the connector in Claude's settings.", 401, "auth");
  }
  if (props.linkedinTokenExpiresAt && Date.now() > props.linkedinTokenExpiresAt) {
    throw new LinkedInError(
      "Your LinkedIn sign-in expired (LinkedIn sign-ins last about 60 days). Reconnect the connector in Claude's settings.",
      401,
      "auth",
    );
  }
  return props as GrantProps;
}

async function run(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof LinkedInError) return fail(error.message);
    console.error("tool failed", error instanceof Error ? error.message : error);
    return fail("Something went wrong. Please try again in a minute.");
  }
}

// Tests against a mock LinkedIn may use http://localhost links.
const httpsUrl = z
  .string()
  .url()
  .refine(
    (u) => u.startsWith("https://") || (!!env.LINKEDIN_API_BASE && u.startsWith("http://localhost")),
    "Must be an https:// link",
  );

const postFields = {
  text: z
    .string()
    .min(1)
    .max(MAX_POST_CHARS)
    .describe(`The post text exactly as approved by the user, up to ${MAX_POST_CHARS} characters.`),
  visibility: z
    .enum(["PUBLIC", "CONNECTIONS"])
    .default("PUBLIC")
    .describe("PUBLIC = anyone on or off LinkedIn; CONNECTIONS = 1st-degree connections only."),
  image_url: httpsUrl.optional().describe("Public https link to a JPEG, PNG or GIF to attach."),
  image_alt_text: z.string().max(4086).optional().describe("Describes the image for screen readers."),
  link_url: httpsUrl.optional().describe("Share a link card for this https URL."),
  link_title: z.string().max(400).optional().describe("Title for the link card. Required with link_url."),
  link_description: z.string().max(4086).optional().describe("Short description shown on the link card."),
};

const FORMAT_NOTE =
  "Write plain text: line breaks are kept, #hashtags become clickable, and characters like ( ) * _ are escaped automatically, so don't add Markdown or backslashes. @mentions show as plain text. Optionally attach ONE of: an image from a public https link (JPEG/PNG/GIF, max 8 MB), or a link card (link_url + link_title; an image_url then becomes its thumbnail).";

function toRequest(args: {
  text: string;
  visibility: string;
  image_url?: string;
  image_alt_text?: string;
  link_url?: string;
  link_title?: string;
  link_description?: string;
}): PostRequest {
  return {
    text: args.text,
    visibility: args.visibility as Visibility,
    image_url: args.image_url,
    image_alt_text: args.image_alt_text,
    link_url: args.link_url,
    link_title: args.link_title,
    link_description: args.link_description,
  };
}

function describeRow(r: ScheduledRow): string {
  const when = formatLike(r.run_at, r.publish_at);
  const lines = [`• ${r.id} — ${r.status.toUpperCase()} — ${when}`, `  "${r.preview}"`];
  if (r.post_urn) lines.push(`  ${postUrl(r.post_urn)}`);
  if (r.error) lines.push(`  Note: ${r.error}`);
  return lines.join("\n");
}

export function createServer(): McpServer {
  const server = new McpServer({ name: env.APP_NAME || "Postline", version: "1.1.0" });

  // ------------------------------------------------------------ profile
  server.registerTool(
    "get_linkedin_profile",
    {
      title: "Get connected LinkedIn profile",
      description:
        "Shows which LinkedIn account this connector posts as (name and member id). Use it to confirm the account before posting.",
      inputSchema: z.object({}),
      annotations: { title: "Get connected LinkedIn profile", readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      run(async () => {
        const s = session();
        const member = await getMember(s.linkedinToken);
        const days = Math.max(0, Math.floor((s.linkedinTokenExpiresAt - Date.now()) / 86_400_000));
        return ok(
          [
            `Connected LinkedIn account: ${member.name}`,
            `Member URN: urn:li:person:${member.sub}`,
            `LinkedIn sign-in expires in about ${days} day${days === 1 ? "" : "s"}; posts can be scheduled up to then.`,
          ].join("\n"),
        );
      }),
  );

  // ------------------------------------------------------------ publish now
  server.registerTool(
    "publish_linkedin_post",
    {
      title: "Publish LinkedIn post now",
      description: [
        "Publishes a post to the user's personal LinkedIn profile immediately.",
        "Before calling: show the user the exact final text (and any image or link) and get their explicit go-ahead. Never post a draft the user hasn't approved. For a later time, use schedule_linkedin_post instead.",
        FORMAT_NOTE,
        "Returns the post URL and its id (needed to delete it).",
      ].join(" "),
      inputSchema: z.object(postFields),
      annotations: {
        title: "Publish LinkedIn post now",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) =>
      run(async () => {
        const s = session();
        if (args.link_url && !args.link_title) return fail("A link card needs a title. Add link_title and try again.");
        const { urn, url } = await publish(s.linkedinToken, env.LINKEDIN_VERSION, s.sub, toRequest(args));
        return ok(
          [
            `Posted to LinkedIn as ${s.name} (${args.visibility === "CONNECTIONS" ? "connections only" : "public"}).`,
            `View it: ${url}`,
            `Post id (to delete it later): ${urn}`,
          ].join("\n"),
        );
      }),
  );

  // ------------------------------------------------------------ schedule
  server.registerTool(
    "schedule_linkedin_post",
    {
      title: "Schedule LinkedIn post",
      description: [
        "Schedules a post to be published automatically on the user's personal LinkedIn profile at a future time. The server publishes it on its own; Claude doesn't need to be open then.",
        "Before calling: show the user the exact final text, attachments and the date/time (in their time zone), and get their explicit go-ahead.",
        "publish_at must be ISO 8601 with the user's UTC offset, e.g. 2026-11-08T09:00:00+05:30. If you don't know the user's time zone, ask.",
        `It must be at least a minute ahead and within ${MAX_SCHEDULE_DAYS} days (and before the LinkedIn sign-in expires). Posts go out within about a minute of the time.`,
        "Any image_url must still work at publishing time.",
        FORMAT_NOTE,
        "Returns a schedule id (sp_…) for list_scheduled_linkedin_posts and cancel_scheduled_linkedin_post.",
      ].join(" "),
      inputSchema: z.object({
        ...postFields,
        publish_at: z.string().describe("When to publish: ISO 8601 with UTC offset, e.g. 2026-11-08T09:00:00+05:30"),
      }),
      annotations: {
        title: "Schedule LinkedIn post",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) =>
      run(async () => {
        const s = session();
        if (args.link_url && !args.link_title) return fail("A link card needs a title. Add link_title and try again.");
        const runAt = parsePublishAt(args.publish_at);
        if (runAt === null) {
          return fail("publish_at must look like 2026-11-08T09:00:00+05:30 (date, time and UTC offset).");
        }
        const minLead = Number(env.SCHEDULE_MIN_LEAD_SECONDS ?? 60) * 1000;
        if (runAt < Date.now() + minLead) {
          return fail(
            "That time is in the past or less than a minute away. Pick a later time, or use publish_linkedin_post to post now.",
          );
        }
        if (runAt > Date.now() + MAX_SCHEDULE_DAYS * 86_400_000) {
          return fail(`Posts can be scheduled up to ${MAX_SCHEDULE_DAYS} days ahead.`);
        }
        if (runAt > s.linkedinTokenExpiresAt - 10 * 60_000) {
          return fail(
            `Your LinkedIn sign-in ends ${formatLike(s.linkedinTokenExpiresAt, args.publish_at)}, before that time. Reconnect the connector to renew it (posts already scheduled are renewed too), then schedule again.`,
          );
        }
        if (args.image_url) {
          // Fail now rather than at publishing time if the image link is broken.
          const res = await fetch(args.image_url).catch(() => null);
          const type = res?.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
          await res?.body?.cancel();
          if (!res?.ok) return fail("Couldn't open the image link. Check it's public and try again.");
          if (!["image/jpeg", "image/png", "image/gif"].includes(type)) return fail("The image must be a JPEG, PNG or GIF.");
        }
        const row = await createScheduled(env, {
          memberSub: s.sub,
          runAt,
          publishAt: args.publish_at,
          token: s.linkedinToken,
          tokenExpiresAt: s.linkedinTokenExpiresAt,
          post: toRequest(args),
        });
        return ok(
          [
            `Scheduled for ${formatLike(runAt, args.publish_at)} as ${s.name} (${args.visibility === "CONNECTIONS" ? "connections only" : "public"}).`,
            `Schedule id: ${row.id}`,
            "It will publish automatically within about a minute of that time. List scheduled posts to check on it, or cancel it before then.",
          ].join("\n"),
        );
      }),
  );

  server.registerTool(
    "list_scheduled_linkedin_posts",
    {
      title: "List scheduled LinkedIn posts",
      description:
        "Lists the user's scheduled LinkedIn posts: upcoming ones, plus ones published, failed or cancelled in the last 7 days, with times, status, post links and any error.",
      inputSchema: z.object({}),
      annotations: { title: "List scheduled LinkedIn posts", readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      run(async () => {
        const s = session();
        const rows = await listScheduled(env, s.sub);
        if (rows.length === 0) return ok("No scheduled posts (upcoming or in the last 7 days).");
        return ok(rows.map(describeRow).join("\n\n"));
      }),
  );

  server.registerTool(
    "cancel_scheduled_linkedin_post",
    {
      title: "Cancel scheduled LinkedIn post",
      description:
        "Cancels a scheduled post that hasn't been published yet, by its schedule id (sp_…). Confirm with the user first. To remove a post that already went out, use delete_linkedin_post with its post id.",
      inputSchema: z.object({
        schedule_id: z
          .string()
          .regex(/^sp_[a-f0-9]{12}$/, "Must look like sp_1a2b3c4d5e6f")
          .describe("The schedule id, e.g. sp_1a2b3c4d5e6f"),
      }),
      annotations: {
        title: "Cancel scheduled LinkedIn post",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ schedule_id }) =>
      run(async () => {
        const s = session();
        const row = await cancelScheduled(env, s.sub, schedule_id);
        if (row) return ok(`Cancelled ${schedule_id} ("${row.preview}"). It won't be posted.`);
        const existing = await getScheduled(env, s.sub, schedule_id);
        if (!existing) return fail("No scheduled post with that id on this account.");
        if (existing.status === "published" && existing.post_urn) {
          return fail(
            `That post was already published: ${postUrl(existing.post_urn)}. Use delete_linkedin_post with ${existing.post_urn} to remove it.`,
          );
        }
        return fail(`That post can't be cancelled: it's ${existing.status}.`);
      }),
  );

  // ------------------------------------------------------------ delete
  server.registerTool(
    "delete_linkedin_post",
    {
      title: "Delete LinkedIn post",
      description:
        "Permanently deletes a published LinkedIn post by its post id (urn:li:share:… or urn:li:ugcPost:…), such as the id publish_linkedin_post returned or the link list_scheduled_linkedin_posts shows. Only posts by the connected account can be deleted. Confirm with the user first; this can't be undone.",
      inputSchema: z.object({
        post_id: z
          .string()
          .regex(/^urn:li:(share|ugcPost):[A-Za-z0-9_-]+$/, "Must look like urn:li:share:123 or urn:li:ugcPost:123")
          .describe("The post id, e.g. urn:li:share:7262000000000000000"),
      }),
      annotations: {
        title: "Delete LinkedIn post",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ post_id }) =>
      run(async () => {
        const s = session();
        await deletePost(s.linkedinToken, env.LINKEDIN_VERSION, post_id);
        return ok(`Deleted ${post_id} from ${s.name}'s LinkedIn profile.`);
      }),
  );

  return server;
}
