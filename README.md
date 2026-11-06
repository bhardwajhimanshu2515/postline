# Postline: post to LinkedIn from Claude

A remote MCP connector that lets Claude publish posts to your personal LinkedIn profile, right away or at a scheduled time.
It runs on Cloudflare Workers (the free plan is enough). Scheduled posts are published by the server itself, every minute, even when Claude is closed.

- **Tools:**
  - `get_linkedin_profile` (read-only)
  - `publish_linkedin_post`: text, plus an optional image or link card, visible to everyone or to connections only
  - `schedule_linkedin_post`: the same options plus `publish_at` (ISO 8601 with UTC offset), up to 59 days ahead
  - `list_scheduled_linkedin_posts` (read-only): upcoming posts, plus ones published, failed or cancelled in the last 7 days
  - `cancel_scheduled_linkedin_post` (destructive)
  - `delete_linkedin_post` (destructive)
- **Scheduling:** Posts are stored in Cloudflare D1, with the post content and LinkedIn token encrypted (AES-256-GCM). A Cron Trigger runs every minute, claims due posts atomically so nothing double-posts, and retries 3 times if LinkedIn is down.
- **Sign-in:** OAuth 2.1 for Claude, then LinkedIn OAuth with the self-serve scopes `openid profile w_member_social`. No LinkedIn partner approval is needed.
- **Pages:** `/` is the docs page and `/privacy` is the privacy policy. The directory submission asks for both URLs.

> "Postline" is a working name. To rename it, change `name` and `APP_NAME` in `wrangler.jsonc`.
> Don't put "LinkedIn" in the product name, because LinkedIn's brand rules don't allow that. "for LinkedIn" in descriptions is fine.

---

## You'll need a computer for setup

`wrangler` (Cloudflare's command-line tool) runs on a laptop or desktop with Node.js 20 or newer. After setup, everything works from Claude on your phone.

```bash
unzip postline.zip && cd postline
npm install
```

## Step 1: Create the LinkedIn app (about 10 min)

1. Go to <https://www.linkedin.com/developers/apps> and choose **Create app**.
   - **App name:** Postline, or whatever you pick.
   - **LinkedIn Page:** Every app has to be linked to a LinkedIn Page. If you don't have one, create a free Page for the product first.
   - **Logo:** Upload any square logo.
2. Open the **Products** tab and add both:
   - **Sign In with LinkedIn using OpenID Connect**
   - **Share on LinkedIn**
3. Open the **Auth** tab and copy the **Client ID** and **Primary Client Secret**.
   You'll add the redirect URL in Step 2, once you know your Worker's address.

## Step 2: Deploy to Cloudflare (about 10 min)

```bash
npx wrangler login                          # opens the browser; a free account is fine
npx wrangler kv namespace create OAUTH_KV   # prints an id
npx wrangler d1 create postline             # prints a database_id
```

1. Paste the KV id into `wrangler.jsonc` in place of `REPLACE_WITH_YOUR_KV_ID`, and the D1 `database_id` in place of `REPLACE_WITH_YOUR_D1_ID`. Then create the scheduled-posts table:

```bash
npx wrangler d1 migrations apply postline --remote
```

2. Set `OPERATOR_NAME` and `SUPPORT_EMAIL` in `wrangler.jsonc`. Both appear on the public docs and privacy pages.
3. Deploy once to get your address:

```bash
npx wrangler deploy
# → https://postline.<your-subdomain>.workers.dev
```

4. Put that exact address plus `/mcp` into `MCP_RESOURCE` in `wrangler.jsonc`, for example `https://postline.himanshu.workers.dev/mcp`.
5. Add the secrets and deploy again:

```bash
npx wrangler secret put LINKEDIN_CLIENT_ID
npx wrangler secret put LINKEDIN_CLIENT_SECRET
npx wrangler secret put SCHEDULE_ENCRYPTION_KEY   # paste 32+ random characters, e.g. from: openssl rand -base64 32
npx wrangler deploy
```

Keep `SCHEDULE_ENCRYPTION_KEY` the same from now on. If you change it, posts that are already scheduled can't be decrypted and will fail.

6. Back in the LinkedIn app's **Auth** tab, under **Authorized redirect URLs**, add:
   `https://postline.<your-subdomain>.workers.dev/callback`

7. Open `https://postline.<your-subdomain>.workers.dev/` in a browser. You should see the docs page.

## Step 3: Test with your own LinkedIn (about 5 min)

1. In Claude, open **Settings → Connectors → Add custom connector**.
2. Paste `https://postline.<your-subdomain>.workers.dev/mcp`, then select **Add** and **Connect**.
3. On the Postline page, select **Continue to LinkedIn**. Sign in to LinkedIn and select **Allow**.
4. In a new chat, check each part:
   - *"Which LinkedIn account am I connected to?"*
   - *"Post 'Testing my new connector 🚀 #buildinpublic' to LinkedIn, visible to connections only."* Approve the tool call when Claude asks.
   - Open the link Claude returns and check the post.
   - *"Delete that post."*
   - *"Schedule 'Scheduling test ⏰' for 3 minutes from now, connections only."* Close Claude, wait, and check LinkedIn. Then ask *"List my scheduled posts."*
   - Optionally, an image post: *"Post this with the image https://…/photo.jpg"*
5. Connect once with a **second LinkedIn account** too, a friend's or a test account. This confirms that people other than you can use it.

If something fails, run `npx wrangler tail` while you try again to see the logs.

## Step 4: Submit to Claude's Connectors Directory

Open <https://claude.ai/directory/manage>, select **Submit new**, then **MCP connector**. You need a paid Claude plan to submit.

| Portal step | What to enter |
|---|---|
| Connection | `https://postline.<your-subdomain>.workers.dev/mcp` |
| Tools | These sync automatically. All 3 have titles and read-only or destructive labels. |
| Listing | **Name:** Postline<br>**One-liner:** "Write, schedule and publish LinkedIn posts from Claude, after you approve them."<br>**Category:** Social / Marketing<br>**Docs URL:** `https://…workers.dev/`<br>**Privacy policy:** `https://…workers.dev/privacy`<br>**Support:** your support email<br>**Icon:** a square logo |
| Use cases | Draft and publish posts now or on a schedule, share a link or image, list or cancel scheduled posts, delete a post you just made.<br>**Needs:** a LinkedIn account.<br>**Access:** reads and writes. |
| Authentication | OAuth, required. The server handles registration itself (DCR and CIMD), so no client ID is needed here. |
| Data handling | Third-party API (LinkedIn) used through its public developer program. No health data, no sponsored content. |
| Test & launch | Give reviewers a dedicated test LinkedIn account (email and password), or say that any LinkedIn account works. Confirm you ran every tool in Claude (Step 3). |
| Compliance | Read and accept all 7. |

After you submit, Anthropic scans it automatically, and by default it's listed as a **Community** connector. You'll see its status and any feedback in the same portal. For escalations, email `mcp-review@anthropic.com`.

---

## Maintenance

- **LinkedIn API version:** `LINKEDIN_VERSION` in `wrangler.jsonc` is a monthly version (`YYYYMM`). LinkedIn retires versions after about a year, so bump it every few months and redeploy.
- **Sign-in length:** LinkedIn sign-ins last about 60 days with no refresh. When one expires, Claude's grant ends with it and the user reconnects. Reconnecting also renews the token on that user's pending scheduled posts.
- **Scheduled post failures:** These show in `list_scheduled_linkedin_posts` with the reason. Run `npx wrangler tail` to watch the cron's work live.
- **Logs:** `npx wrangler tail`

## Development

```bash
npm run typecheck
npm test     # starts the Worker locally against a fake LinkedIn and runs 29 end-to-end checks, including scheduling
```

`LINKEDIN_OAUTH_BASE` and `LINKEDIN_API_BASE` exist only for tests (see `.dev.vars.test`). Never set them in production.

## Files

```
src/index.ts      OAuth provider + MCP endpoint wiring, token lifetimes
src/auth.ts       consent page, LinkedIn redirect + callback, docs/privacy routes
src/mcp.ts        the six tools
src/publish.ts    shared "publish one post" logic
src/schedule.ts   scheduled-post storage (D1, encrypted) and the cron publisher
migrations/       D1 table for scheduled posts
src/linkedin.ts   LinkedIn API client (sign-in, posts, images)
src/littletext.ts escapes post text for LinkedIn's "little text" format
src/pages.ts      HTML for docs, privacy policy, consent and error pages
test/             fake LinkedIn + end-to-end test
```
