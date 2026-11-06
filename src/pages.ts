import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";

export const esc = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

interface Site {
  appName: string;
  operator: string;
  supportEmail: string;
  origin: string;
}

const STYLE = `
:root{--ink:#16181d;--muted:#5b616e;--line:#e3e5ea;--bg:#f7f8fa;--card:#fff;--accent:#0a66c2;--accent-ink:#fff;--warn:#8a5a00;--warn-bg:#fff6e0}
@media (prefers-color-scheme:dark){:root{--ink:#eceef2;--muted:#a3a9b5;--line:#2c3038;--bg:#121418;--card:#1a1d23;--accent:#4c9be8;--accent-ink:#0b0d10;--warn:#f2c46b;--warn-bg:#2b2416}}
*{box-sizing:border-box}
body{margin:0;font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--bg);-webkit-font-smoothing:antialiased}
main{max-width:720px;margin:0 auto;padding:40px 20px 64px}
header.site{display:flex;align-items:center;gap:10px;margin-bottom:32px}
.logo{width:32px;height:32px;border-radius:8px;background:var(--accent);display:grid;place-items:center;color:var(--accent-ink);font-weight:700}
header.site a{color:inherit;text-decoration:none;font-weight:650}
nav{margin-left:auto;display:flex;gap:16px;font-size:14px}
nav a{color:var(--muted)!important;font-weight:500!important}
h1{font-size:30px;line-height:1.2;margin:0 0 12px;letter-spacing:-.01em}
h2{font-size:20px;margin:36px 0 8px}
p,li{color:var(--ink)}
.lead{font-size:18px;color:var(--muted);margin:0 0 24px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px}
code,.mono{font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
code{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:1px 6px}
.url{display:block;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:var(--bg);word-break:break-all;margin:8px 0 0}
table{width:100%;border-collapse:collapse;font-size:15px}
td,th{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600;color:var(--muted);font-size:13px;text-transform:uppercase;letter-spacing:.04em}
.muted{color:var(--muted)}
.warn{background:var(--warn-bg);color:var(--warn);border-radius:10px;padding:12px 14px;margin:16px 0}
.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:24px}
button{font:inherit;font-weight:600;border-radius:999px;padding:12px 22px;cursor:pointer;border:1px solid var(--line);background:var(--card);color:var(--ink);min-height:44px}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
button:focus-visible,a:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
ul.checks{padding-left:20px}
footer{margin-top:48px;font-size:14px;color:var(--muted)}
footer a{color:inherit}
`;

function layout(site: Site, title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="robots" content="index,follow">
<style>${STYLE}</style>
</head><body><main>
<header class="site"><div class="logo" aria-hidden="true">${esc(site.appName.charAt(0))}</div>
<a href="/">${esc(site.appName)}</a>
<nav><a href="/">Docs</a><a href="/privacy">Privacy</a></nav></header>
${body}
<footer>${esc(site.appName)} is an independent tool and is not made, endorsed or supported by LinkedIn.
LinkedIn is a trademark of LinkedIn Corporation. Support: <a href="mailto:${esc(site.supportEmail)}">${esc(site.supportEmail)}</a></footer>
</main></body></html>`;
}

export function html(body: string, init: ResponseInit & { headers?: HeadersInit } = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(body, { ...init, headers });
}

// ---------------------------------------------------------------- docs

export function docsPage(site: Site): string {
  const mcpUrl = `${site.origin}/mcp`;
  return layout(
    site,
    `${site.appName}: post to LinkedIn from Claude`,
    `
<h1>Post to LinkedIn from Claude</h1>
<p class="lead">${esc(site.appName)} lets Claude publish posts to your personal LinkedIn profile, right away or at a time you choose, after you've read and approved them.</p>

<div class="card">
<strong>Connector URL</strong>
<code class="url">${esc(mcpUrl)}</code>
</div>

<h2>Set it up</h2>
<ol>
<li>In Claude, open <strong>Settings → Connectors</strong> and choose <strong>Add custom connector</strong> (or find ${esc(site.appName)} in the directory).</li>
<li>Paste the connector URL above and select <strong>Add</strong>, then <strong>Connect</strong>.</li>
<li>Approve access on the ${esc(site.appName)} page, then sign in with LinkedIn and allow posting.</li>
<li>Ask Claude something like <em>"Draft a LinkedIn post about my new portfolio and schedule it for Monday 9am."</em></li>
</ol>

<h2>What Claude can do</h2>
<table>
<tr><th>Tool</th><th>What it does</th></tr>
<tr><td><code>get_linkedin_profile</code></td><td>Shows which LinkedIn account is connected. Read-only.</td></tr>
<tr><td><code>publish_linkedin_post</code></td><td>Publishes a post as you: text up to 3,000 characters, with an optional image (JPEG, PNG or GIF from a public link) or a link card. Visible to everyone or only your connections.</td></tr>
<tr><td><code>schedule_linkedin_post</code></td><td>Saves a post to publish automatically at a set date and time, up to 59 days ahead. It goes out within about a minute of that time, even if Claude is closed.</td></tr>
<tr><td><code>list_scheduled_linkedin_posts</code></td><td>Shows upcoming scheduled posts, plus ones published, failed or cancelled in the last 7 days. Read-only.</td></tr>
<tr><td><code>cancel_scheduled_linkedin_post</code></td><td>Cancels a scheduled post before it goes out.</td></tr>
<tr><td><code>delete_linkedin_post</code></td><td>Deletes a post this connector published, using its post id.</td></tr>
</table>
<p class="muted">Claude asks for your approval before using a tool that posts, schedules or deletes, and is instructed to show you the final text first. A scheduled post is approved when you schedule it. Nothing needs approving at publishing time.</p>

<h2>Limits</h2>
<ul>
<li>Posts go to your personal profile only, not to Company Pages.</li>
<li>${esc(site.appName)} can't read your feed, your old posts, messages or connections. LinkedIn doesn't offer that to apps like this one.</li>
<li>Mentions (@someone) appear as plain text. <code>#hashtags</code> become real hashtags.</li>
<li>LinkedIn sign-ins last about 60 days. After that, Claude will ask you to reconnect. Posts can only be scheduled before your sign-in ends, and reconnecting renews posts you've already scheduled.</li>
<li>Images in scheduled posts are fetched at publishing time, so the image link has to keep working until then.</li>
<li>LinkedIn caps posting through apps at around 150 requests per member per day.</li>
</ul>

<h2>Disconnect</h2>
<p>Cancel any scheduled posts first: they're stored separately and will still publish after you remove the connector, unless you also revoke LinkedIn access. Then remove the connector in Claude's settings. To revoke LinkedIn access as well, open LinkedIn <strong>Settings → Data privacy → Permitted services</strong> and remove ${esc(site.appName)}.</p>

<h2>Support</h2>
<p>Email <a href="mailto:${esc(site.supportEmail)}">${esc(site.supportEmail)}</a>. Please don't include passwords or tokens.</p>
`,
  );
}

// ---------------------------------------------------------------- privacy

export function privacyPage(site: Site): string {
  return layout(
    site,
    `${site.appName} privacy policy`,
    `
<h1>Privacy policy</h1>
<p class="lead">Last updated 7 November 2026. ${esc(site.appName)} is run by ${esc(site.operator)}.</p>

<h2>What we collect</h2>
<ul>
<li><strong>From LinkedIn, when you sign in:</strong> your LinkedIn member id, name and profile photo link, and an access token that lets ${esc(site.appName)} post as you.</li>
<li><strong>From Claude, when you use a tool:</strong> the post text, image link, link card details, scheduled time or post id that Claude sends for that request.</li>
<li><strong>Technical data:</strong> standard request logs from our host, Cloudflare (for example time, IP address and status codes), used for security and debugging.</li>
</ul>
<p>We don't collect your LinkedIn password, email address, feed, messages or connections, and we don't read your Claude conversations.</p>

<h2>How we use it</h2>
<p>Only to do what you ask: publish, schedule, cancel or delete a post on your profile, and show which account is connected. We don't sell data, use it for advertising, or use it to train AI models.</p>

<h2>Storage and security</h2>
<p>Sign-in records are kept in Cloudflare Workers KV. Your LinkedIn token is stored encrypted, with a key that only the matching Claude access token can unlock. Access tokens and codes are stored only as hashes. Posts you publish right away pass straight through to LinkedIn and aren't kept.</p>
<p><strong>Scheduled posts</strong> are kept in a Cloudflare D1 database until they're published, together with a copy of your LinkedIn token so the post can go out while you're away. The post content and token are encrypted (AES-256-GCM). Only a short preview, the time and the status are stored unencrypted, so the post can be listed. Once a post is published, cancelled or fails, the encrypted content and token are deleted.</p>

<h2>Sharing</h2>
<p>Post content goes to LinkedIn, because publishing it is the point. Our hosting provider, Cloudflare, processes requests on our behalf. We share nothing else unless the law requires it.</p>

<h2>Retention</h2>
<ul>
<li>Sign-in records expire automatically when your LinkedIn token expires (about 60 days), or sooner if you disconnect or sign in again.</li>
<li>Scheduled posts: the encrypted content and token are deleted as soon as the post is published, cancelled or fails. The remaining record (preview, time, status, post link) is deleted 30 days later.</li>
<li>Host request logs are kept according to Cloudflare's standard retention.</li>
<li>To have your records deleted right away, email us and we'll do it within 30 days.</li>
</ul>

<h2>Your choices</h2>
<p>Disconnect the connector in Claude, and remove ${esc(site.appName)} under LinkedIn <strong>Settings → Data privacy → Permitted services</strong>. Either stops all access.</p>

<h2>Contact</h2>
<p>${esc(site.operator)}: <a href="mailto:${esc(site.supportEmail)}">${esc(site.supportEmail)}</a></p>
`,
  );
}

// ---------------------------------------------------------------- consent

export function consentPage(site: Site, details: ConsentDescription, handle: string): string {
  const name = esc(details.clientName || "An app");
  const origin = details.clientDomain
    ? `Published by <strong>${esc(details.clientDomain)}</strong>.`
    : "This app registered itself, so its name isn't verified.";
  return layout(
    site,
    `Allow ${details.clientName || "this app"} to post to LinkedIn?`,
    `
<div class="card">
<h1>Allow ${name} to post to LinkedIn as you?</h1>
<p>${origin} Access will be sent to <strong>${esc(details.redirectHost)}</strong>.</p>
${
  details.redirectIsLoopback
    ? `<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>`
    : ""
}
<p>If you allow it, ${name} will be able to:</p>
<ul class="checks">
<li>See your LinkedIn name and photo</li>
<li>Publish posts to your profile, and delete posts it published</li>
</ul>
<p class="muted">It can't read your feed, messages or connections. Next, LinkedIn will ask you to sign in and confirm.</p>
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${esc(handle)}">
<div class="actions">
<button class="primary" name="decision" value="approve" type="submit">Continue to LinkedIn</button>
<button name="decision" value="deny" type="submit">Cancel</button>
</div>
</form>
</div>`,
  );
}

export function messagePage(site: Site, title: string, message: string): string {
  return layout(
    site,
    title,
    `<div class="card"><h1>${esc(title)}</h1><p>${esc(message)}</p>
<p class="muted">Start connecting again from Claude's connector settings.</p></div>`,
  );
}
