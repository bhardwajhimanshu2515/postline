// End-to-end test: runs the Worker locally against a mock LinkedIn and walks
// through what Claude does: discovery → registration → consent → LinkedIn
// sign-in → token → MCP tool calls.
//   npm test
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { startMock } from "./mock-linkedin.mjs";

const BASE = "http://localhost:8787";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
let passed = 0;
const step = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.log(`  ✗ ${name}\n    ${e.stack?.split("\n").slice(0, 3).join("\n    ")}`);
    process.exitCode = 1;
  }
};

// ------------------------------------------------------------ cookie jar
const jar = new Map();
function keep(res) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair, ...attrs] = c.split(";");
    const [k, v] = pair.split("=");
    if (attrs.some((a) => /max-age=0/i.test(a)) || v === "") jar.delete(k.trim());
    else jar.set(k.trim(), v);
  }
}
const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
const req = async (path, init = {}) => {
  const res = await fetch(path.startsWith("http") ? path : BASE + path, {
    redirect: "manual",
    ...init,
    headers: { cookie: cookie(), ...(init.headers ?? {}) },
  });
  keep(res);
  return res;
};

// ------------------------------------------------------------ boot
const { server: mock, log } = await startMock(9999);
const quietEnv = { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", NO_PROXY: "localhost,127.0.0.1", no_proxy: "localhost,127.0.0.1" };
import { execFileSync } from "node:child_process";
import fs from "node:fs";
fs.rmSync(".wrangler/state", { recursive: true, force: true });
execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "postline", "--local"], { env: quietEnv, stdio: "ignore" });
const dev = spawn(
  "npx",
  ["wrangler", "dev", "--port", "8787", "--test-scheduled", "--env-file", ".dev.vars.test", "--compatibility-flags", "nodejs_compat", "--log-level", "warn"],
  { detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", NO_PROXY: "localhost,127.0.0.1", no_proxy: "localhost,127.0.0.1" } },
);
let devOut = "";
dev.stdout.on("data", (d) => (devOut += d));
dev.stderr.on("data", (d) => (devOut += d));
const cleanup = () => {
  try { process.kill(-dev.pid, "SIGTERM"); } catch {}
  mock.close();
};
for (let i = 0; i < 120; i++) {
  try {
    if ((await fetch(BASE + "/healthz", { signal: AbortSignal.timeout(2000) })).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
  if (i === 119) {
    console.log(devOut);
    cleanup();
    throw new Error("wrangler dev didn't start");
  }
}
console.log("Worker running. Tests:");

// ------------------------------------------------------------ helpers
const verifier = crypto.randomBytes(32).toString("base64url");
const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
let clientId, accessToken, refreshToken;
let rpcId = 1;

async function mcp(method, params = {}, token = accessToken) {
  const res = await fetch(BASE + "/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
  });
  const text = await res.text();
  let body;
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const data = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).pop();
    body = data ? JSON.parse(data) : undefined;
  } else body = text ? JSON.parse(text) : undefined;
  return { res, body };
}
const callTool = async (name, args) => (await mcp("tools/call", { name, arguments: args })).body?.result;
const textOf = (r) => r?.content?.map((c) => c.text).join("\n") ?? "";

async function authorizeOnce(decision = "approve") {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: "linkedin.post",
    state: "claude-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${BASE}/mcp`,
  });
  const page = await req(`/authorize?${q}`);
  const html = await page.text();
  assert.equal(page.status, 200, html.slice(0, 300));
  const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
  assert.ok(handle, "consent page has a handle");
  const post = await req("/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE },
    body: new URLSearchParams({ handle, decision }),
  });
  return { page, html, post };
}

// ------------------------------------------------------------ tests
try {
  await step("docs and privacy pages load", async () => {
    const docs = await req("/");
    assert.equal(docs.status, 200);
    assert.match(await docs.text(), /Post to LinkedIn from Claude/);
    const privacy = await req("/privacy");
    assert.equal(privacy.status, 200);
    assert.match(await privacy.text(), /Retention/);
  });

  await step("MCP endpoint demands sign-in (401 + resource metadata)", async () => {
    const { res } = await mcp("initialize", {}, null);
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate") ?? "", /resource_metadata/);
  });

  await step("OAuth discovery documents", async () => {
    const prm = await (await req("/.well-known/oauth-protected-resource/mcp")).json();
    assert.equal(prm.resource, `${BASE}/mcp`);
    const as = await (await req("/.well-known/oauth-authorization-server")).json();
    assert.ok(as.authorization_endpoint.endsWith("/authorize"));
    assert.ok(as.registration_endpoint);
    assert.deepEqual(as.scopes_supported, ["linkedin.post"]);
  });

  await step("Claude registers as a client (DCR)", async () => {
    const res = await req("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Claude",
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    clientId = body.client_id;
  });

  await step("Cancel on the consent page returns access_denied to Claude", async () => {
    const { html, post } = await authorizeOnce("deny");
    assert.match(html, /Allow Claude to post to LinkedIn as you\?/);
    assert.match(html, /claude\.ai/);
    assert.equal(post.status, 302);
    const loc = new URL(post.headers.get("location"));
    assert.equal(loc.origin + loc.pathname, REDIRECT);
    assert.equal(loc.searchParams.get("error"), "access_denied");
    assert.equal(loc.searchParams.get("state"), "claude-state");
  });

  await step("LinkedIn 'cancel' at sign-in returns access_denied to Claude", async () => {
    const { post } = await authorizeOnce("approve");
    const li = new URL(post.headers.get("location"));
    const back = await req(`/callback?error=user_cancelled_login&state=${li.searchParams.get("state")}`);
    assert.equal(back.status, 302);
    assert.equal(new URL(back.headers.get("location")).searchParams.get("error"), "access_denied");
  });

  let claudeCode;
  await step("Approve → LinkedIn sign-in → code back to Claude", async () => {
    const { post } = await authorizeOnce("approve");
    assert.equal(post.status, 302);
    const li = new URL(post.headers.get("location"));
    assert.equal(li.origin + li.pathname, "http://localhost:9999/oauth/v2/authorization");
    assert.equal(li.searchParams.get("scope"), "openid profile w_member_social");
    assert.equal(li.searchParams.get("redirect_uri"), `${BASE}/callback`);
    assert.equal(li.searchParams.get("client_id"), "test-client");
    const state = li.searchParams.get("state");
    assert.ok(state);

    const back = await req(`/callback?code=good-code&state=${state}`);
    assert.equal(back.status, 302, (await back.clone().text()).replace(/<style>[\s\S]*?<\/style>/, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 400));
    const loc = new URL(back.headers.get("location"));
    assert.equal(loc.origin + loc.pathname, REDIRECT);
    assert.equal(loc.searchParams.get("state"), "claude-state");
    claudeCode = loc.searchParams.get("code");
    assert.ok(claudeCode);
  });

  await step("A replayed LinkedIn callback is refused", async () => {
    const res = await fetch(`${BASE}/callback?code=good-code&state=made-up`, { redirect: "manual" });
    assert.equal(res.status, 400);
  });

  await step("Claude exchanges the code for tokens", async () => {
    const res = await req("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: claudeCode,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
        resource: `${BASE}/mcp`,
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    accessToken = body.access_token;
    refreshToken = body.refresh_token;
    assert.ok(accessToken && refreshToken);
    assert.ok(body.expires_in <= 3600);
  });

  await step("Refresh token works", async () => {
    const res = await req("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    accessToken = body.access_token;
  });

  await step("MCP initialize + tools/list with annotations", async () => {
    const init = await mcp("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    assert.equal(init.res.status, 200, JSON.stringify(init.body));
    assert.ok(init.body.result.serverInfo);
    const list = await mcp("tools/list");
    const tools = Object.fromEntries(list.body.result.tools.map((t) => [t.name, t]));
    assert.ok(tools.publish_linkedin_post && tools.delete_linkedin_post);
    for (const t of Object.values(tools)) {
      assert.ok(t.title || t.annotations?.title, `${t.name} has a title`);
      assert.ok(typeof t.annotations?.readOnlyHint === "boolean" || typeof t.annotations?.destructiveHint === "boolean");
    }
    assert.equal(tools.get_linkedin_profile.annotations.readOnlyHint, true);
    assert.equal(tools.delete_linkedin_post.annotations.destructiveHint, true);
  });

  await step("get_linkedin_profile", async () => {
    const r = await callTool("get_linkedin_profile", {});
    assert.ok(!r.isError, textOf(r));
    assert.match(textOf(r), /Test Member/);
    assert.match(textOf(r), /urn:li:person:abc123/);
  });

  await step("publish text post: escaping, hashtags, visibility", async () => {
    const text = "Shipped my portfolio (v2) today! *finally* #frontend #WebDev\nThanks @everyone_ [docs] <3 ~ 100% | {ok} \\o/";
    const r = await callTool("publish_linkedin_post", { text, visibility: "CONNECTIONS" });
    assert.ok(!r.isError, textOf(r));
    assert.match(textOf(r), /linkedin\.com\/feed\/update\/urn:li:share:/);
    const sent = JSON.parse(log.filter((e) => e.path === "/rest/posts" && e.method === "POST").at(-1).body);
    assert.equal(sent.author, "urn:li:person:abc123");
    assert.equal(sent.visibility, "CONNECTIONS");
    assert.equal(sent.lifecycleState, "PUBLISHED");
    assert.equal(
      sent.commentary,
      "Shipped my portfolio \\(v2\\) today! \\*finally\\* {hashtag|\\#|frontend} {hashtag|\\#|WebDev}\nThanks \\@everyone\\_ \\[docs\\] \\<3 \\~ 100% \\| \\{ok\\} \\\\o/",
    );
    assert.equal(sent.content, undefined);
  });

  await step("publish with image upload", async () => {
    const r = await callTool("publish_linkedin_post", {
      text: "With a picture",
      image_url: "http://localhost:9999/img.png",
      image_alt_text: "A tiny dot",
    });
    assert.ok(!r.isError, textOf(r));
    const put = log.find((e) => e.method === "PUT" && e.path === "/upload/1");
    assert.ok(put, "image bytes uploaded");
    assert.equal(put.headers.authorization, "Bearer li-token");
    const sent = JSON.parse(log.filter((e) => e.path === "/rest/posts" && e.method === "POST").at(-1).body);
    assert.deepEqual(sent.content, { media: { id: "urn:li:image:C4E1", altText: "A tiny dot" } });
    const initBody = JSON.parse(log.find((e) => e.path === "/rest/images" && e.method === "POST").body);
    assert.equal(initBody.initializeUploadRequest.owner, "urn:li:person:abc123");
  });

  await step("rejects a non-image image_url with a clear message", async () => {
    const r = await callTool("publish_linkedin_post", { text: "x", image_url: "http://localhost:9999/page.html" });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /JPEG, PNG or GIF/);
  });

  await step("publish link card", async () => {
    const r = await callTool("publish_linkedin_post", {
      text: "Read this",
      link_url: "https://example.com/post",
      link_title: "My write-up",
    });
    assert.ok(!r.isError, textOf(r));
    const sent = JSON.parse(log.filter((e) => e.path === "/rest/posts" && e.method === "POST").at(-1).body);
    assert.deepEqual(sent.content, { article: { source: "https://example.com/post", title: "My write-up" } });
    assert.equal(sent.visibility, "PUBLIC");
  });

  await step("publish PDF carousel (document post)", async () => {
    const r = await callTool("publish_linkedin_post", {
      text: "My carousel",
      document_url: "http://localhost:9999/deck.pdf",
      document_title: "Same AI. Different results.",
    });
    assert.ok(!r.isError, textOf(r));
    const put = log.find((e) => e.method === "PUT" && e.path === "/upload/doc");
    assert.ok(put && put.body.startsWith("%PDF-"));
    const sent = JSON.parse(log.filter((e) => e.path === "/rest/posts" && e.method === "POST").at(-1).body);
    assert.deepEqual(sent.content, { media: { id: "urn:li:document:D5E1", title: "Same AI. Different results." } });
    let bad = await callTool("publish_linkedin_post", { text: "x", document_url: "http://localhost:9999/deck.pdf" });
    assert.match(textOf(bad), /needs a title/);
    bad = await callTool("publish_linkedin_post", { text: "x", document_url: "http://localhost:9999/img.png", document_title: "t" });
    assert.match(textOf(bad), /isn't a PDF/);
    bad = await callTool("publish_linkedin_post", { text: "x", document_url: "http://localhost:9999/deck.pdf", document_title: "t", image_url: "http://localhost:9999/img.png" });
    assert.match(textOf(bad), /not both/);
  });

  await step("link card without title is refused", async () => {
    const r = await callTool("publish_linkedin_post", { text: "x", link_url: "https://example.com" });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /needs a title/);
  });

  await step("too-long post is refused before reaching LinkedIn", async () => {
    const before = log.length;
    const out = await mcp("tools/call", { name: "publish_linkedin_post", arguments: { text: "a".repeat(3001) } });
    const r = out.body.result;
    assert.ok(out.body.error || r?.isError, "rejected");
    assert.equal(log.length, before);
  });

  await step("delete post (and 404 message)", async () => {
    const r = await callTool("delete_linkedin_post", { post_id: "urn:li:share:700001" });
    assert.ok(!r.isError, textOf(r));
    const del = log.filter((e) => e.method === "DELETE").at(-1);
    assert.equal(del.path, "/rest/posts/urn%3Ali%3Ashare%3A700001");
    assert.equal(del.headers["x-restli-method"], "DELETE");
    const missing = await callTool("delete_linkedin_post", { post_id: "urn:li:share:404" });
    assert.equal(missing.isError, true);
    assert.match(textOf(missing), /doesn't exist/);
  });

  // ---------------------------------------------------------- scheduling
  const isoIn = (ms) => {
    const d = new Date(Date.now() + ms + 5.5 * 3600_000);
    return d.toISOString().slice(0, 19) + "+05:30";
  };
  const runCron = async () => {
    const r = await fetch(BASE + "/__scheduled?cron=*+*+*+*+*");
    assert.equal(r.status, 200, await r.text());
    await new Promise((r) => setTimeout(r, 1500)); // waitUntil work finishes
  };
  const scheduleId = (r) => textOf(r).match(/sp_[a-f0-9]{12}/)?.[0];
  let dueId, cancelId, farId, retryId;

  await step("schedule: rejects bad time formats, past and too-far times", async () => {
    let r = await callTool("schedule_linkedin_post", { text: "x", publish_at: "tomorrow 9am" });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /must look like/);
    r = await callTool("schedule_linkedin_post", { text: "x", publish_at: "2026-11-08T09:00:00" });
    assert.equal(r.isError, true, "no offset is refused");
    r = await callTool("schedule_linkedin_post", { text: "x", publish_at: isoIn(-60_000) });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /in the past/);
    r = await callTool("schedule_linkedin_post", { text: "x", publish_at: isoIn(70 * 86_400_000) });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /up to 59 days/);
    r = await callTool("schedule_linkedin_post", { text: "x", publish_at: isoIn(3_600_000), image_url: "http://localhost:9999/page.html" });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /JPEG, PNG or GIF/);
  });

  await step("schedule: creates posts and lists them as pending", async () => {
    let r = await callTool("schedule_linkedin_post", {
      text: "Scheduled hello (from cron) #automation",
      publish_at: isoIn(2_000),
      image_url: "http://localhost:9999/img.png",
    });
    assert.ok(!r.isError, textOf(r));
    assert.match(textOf(r), /UTC\+05:30/);
    dueId = scheduleId(r);
    r = await callTool("schedule_linkedin_post", { text: "Cancel me", publish_at: isoIn(2_000) });
    cancelId = scheduleId(r);
    r = await callTool("schedule_linkedin_post", { text: "Far away post", publish_at: isoIn(3_600_000) });
    farId = scheduleId(r);
    r = await callTool("schedule_linkedin_post", { text: "FAIL500 retry me", publish_at: isoIn(2_000) });
    retryId = scheduleId(r);
    assert.ok(dueId && cancelId && farId && retryId);
    const list = textOf(await callTool("list_scheduled_linkedin_posts", {}));
    for (const id of [dueId, cancelId, farId, retryId]) assert.match(list, new RegExp(`${id} — PENDING`));
  });

  await step("schedule: cancel a pending post (and only once)", async () => {
    let r = await callTool("cancel_scheduled_linkedin_post", { schedule_id: cancelId });
    assert.ok(!r.isError, textOf(r));
    r = await callTool("cancel_scheduled_linkedin_post", { schedule_id: cancelId });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /cancelled/);
    r = await callTool("cancel_scheduled_linkedin_post", { schedule_id: "sp_000000000000" });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /No scheduled post/);
  });

  await step("cron publishes due posts, skips cancelled and future ones", async () => {
    await new Promise((r) => setTimeout(r, 2500));
    const before = log.filter((e) => e.path === "/rest/posts" && e.method === "POST").length;
    await runCron();
    const posts = log.filter((e) => e.path === "/rest/posts" && e.method === "POST").slice(before).map((e) => JSON.parse(e.body));
    const texts = posts.map((p) => p.commentary);
    assert.ok(texts.includes("Scheduled hello \\(from cron\\) {hashtag|\\#|automation}"), JSON.stringify(texts));
    assert.ok(!texts.some((t) => t.includes("Cancel me") || t.includes("Far away")));
    const withImage = posts.find((p) => p.commentary.startsWith("Scheduled hello"));
    assert.equal(withImage.content.media.id, "urn:li:image:C4E1");
    const list = textOf(await callTool("list_scheduled_linkedin_posts", {}));
    assert.match(list, new RegExp(`${dueId} — PUBLISHED`));
    assert.match(list, /linkedin\.com\/feed\/update\/urn:li:share:/);
    assert.match(list, new RegExp(`${cancelId} — CANCELLED`));
    assert.match(list, new RegExp(`${farId} — PENDING`));
  });

  await step("cron: a LinkedIn outage is retried, not lost", async () => {
    const list = textOf(await callTool("list_scheduled_linkedin_posts", {}));
    assert.match(list, new RegExp(`${retryId} — PENDING[\\s\\S]*?Retrying`));
  });

  await step("cron run again doesn't double-post", async () => {
    const before = log.filter((e) => e.path === "/rest/posts" && e.method === "POST").length;
    await runCron();
    const after = log.filter((e) => e.path === "/rest/posts" && e.method === "POST").length;
    assert.equal(after, before);
  });

  await step("cancelling an already-published post points to delete", async () => {
    const r = await callTool("cancel_scheduled_linkedin_post", { schedule_id: dueId });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /already published[\s\S]*delete_linkedin_post/);
  });

  await step("tools/list has all 6 tools", async () => {
    const list = await mcp("tools/list");
    assert.deepEqual(list.body.result.tools.map((t) => t.name).sort(), [
      "cancel_scheduled_linkedin_post",
      "delete_linkedin_post",
      "get_linkedin_profile",
      "list_scheduled_linkedin_posts",
      "publish_linkedin_post",
      "schedule_linkedin_post",
    ]);
  });

  await step("bad bearer token is refused", async () => {
    const { res } = await mcp("tools/list", {}, "nope");
    assert.equal(res.status, 401);
  });
} finally {
  if (process.exitCode) console.log("--- wrangler output ---\n" + devOut.slice(-3000));
  cleanup();
  await new Promise((r) => setTimeout(r, 1500));
  // Stored scheduled posts must never contain the LinkedIn token in plain text.
  try {
    const out = execFileSync("npx", ["wrangler", "d1", "execute", "postline", "--local", "--json", "--command", "SELECT id, status, payload FROM scheduled_posts"], { env: quietEnv }).toString();
    const rows = JSON.parse(out)[0].results;
    const pending = rows.filter((r) => r.status === "pending");
    assert.ok(pending.length >= 1 && pending.every((r) => r.payload.startsWith("v1.")));
    assert.ok(!out.includes("li-token"), "token not stored in plain text");
    assert.ok(rows.filter((r) => r.status !== "pending").every((r) => r.payload === ""), "finished rows drop the payload");
    passed++;
    console.log("  ✓ D1 stores tokens only encrypted, and drops them when done");
  } catch (e) {
    process.exitCode = 1;
    console.log("  ✗ D1 storage check\n    " + e.message);
  }
  console.log(`${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
  setTimeout(() => process.exit(), 200);
}
