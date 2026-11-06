import { AuthorizationError, CimdFetchError, authorizationErrorRedirect } from "@cloudflare/workers-oauth-provider";
import { type GrantProps, SCOPE_POST } from "./env";
import { LinkedInError, authorizeUrl, exchangeCode, getMember } from "./linkedin";
import { refreshPendingTokens } from "./schedule";
import { consentPage, docsPage, html, messagePage, privacyPage } from "./pages";

function site(env: Env, request: Request) {
  return {
    appName: env.APP_NAME || "Postline",
    operator: env.OPERATOR_NAME || env.APP_NAME || "Postline",
    supportEmail: env.SUPPORT_EMAIL || "support@example.com",
    origin: new URL(request.url).origin,
  };
}

const callbackUrl = (request: Request) => `${new URL(request.url).origin}/callback`;

/** Handles every route that isn't /mcp or a library-owned OAuth endpoint. */
export const AuthHandler: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const s = site(env, request);

    try {
      if (url.pathname === "/" && request.method === "GET") {
        return html(docsPage(s), { headers: { "Cache-Control": "public, max-age=300" } });
      }
      if (url.pathname === "/privacy" && request.method === "GET") {
        return html(privacyPage(s), { headers: { "Cache-Control": "public, max-age=300" } });
      }
      if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
      if (url.pathname === "/healthz") return Response.json({ ok: true });

      if (url.pathname === "/authorize" && request.method === "GET") return await showConsent(request, env, s);
      if (url.pathname === "/authorize" && request.method === "POST") return await submitConsent(request, env, s);
      if (url.pathname === "/callback" && request.method === "GET") return await linkedinCallback(request, env, s);

      return html(messagePage(s, "Page not found", "There's nothing at this address."), { status: 404 });
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo) {
        return Response.redirect(error.redirectTo, 302);
      }
      if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
        const message =
          error instanceof AuthorizationError
            ? error.description || "This sign-in link expired or was already used."
            : "The app that sent you here couldn't be verified.";
        return html(messagePage(s, "Couldn't continue", message), { status: 400 });
      }
      if (error instanceof LinkedInError) {
        return html(messagePage(s, "LinkedIn sign-in didn't work", error.message), { status: 502 });
      }
      throw error;
    }
  },
};

// GET /authorize: validate the client's request and ask the user to approve it.
async function showConsent(request: Request, env: Env, s: ReturnType<typeof site>) {
  const oauth = env.OAUTH_PROVIDER;
  const authRequest = await oauth.parseAuthRequest(request);
  const details = await oauth.describeConsent(authRequest);
  const consent = await oauth.beginConsent(authRequest);
  return html(consentPage(s, details, consent.handle), { headers: consent.headers });
}

// POST /authorize: approved → send the user to LinkedIn; cancelled → back to the client.
async function submitConsent(request: Request, env: Env, _s: ReturnType<typeof site>) {
  const oauth = env.OAUTH_PROVIDER;
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");

  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }

  const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE_POST] });
  const { state, headers } = await oauth.beginUpstream(approved.request, { data: {}, headers: approved.headers });
  headers.set(
    "Location",
    authorizeUrl({ clientId: env.LINKEDIN_CLIENT_ID, redirectUri: callbackUrl(request), state }),
  );
  return new Response(null, { status: 302, headers });
}

// GET /callback: LinkedIn sends the user back here with ?code=… (or ?error=…).
async function linkedinCallback(request: Request, env: Env, _s: ReturnType<typeof site>) {
  const oauth = env.OAUTH_PROVIDER;
  const params = new URL(request.url).searchParams;
  const { request: original, headers } = await oauth.finishUpstream(request);

  const code = params.get("code");
  if (params.get("error") || !code) {
    headers.set("Location", authorizationErrorRedirect(original, "access_denied"));
    return new Response(null, { status: 302, headers });
  }

  const token = await exchangeCode({
    code,
    redirectUri: callbackUrl(request),
    clientId: env.LINKEDIN_CLIENT_ID,
    clientSecret: env.LINKEDIN_CLIENT_SECRET,
  });
  if (token.scope && !token.scope.split(/[ ,]+/).includes("w_member_social")) {
    throw new LinkedInError(
      "LinkedIn didn't grant permission to post. Add the “Share on LinkedIn” product to the LinkedIn app and try again.",
      403,
      "auth",
    );
  }
  const member = await getMember(token.accessToken);

  const props: GrantProps = {
    sub: member.sub,
    name: member.name,
    picture: member.picture,
    linkedinToken: token.accessToken,
    linkedinTokenExpiresAt: token.expiresAt,
  };
  // Reconnecting renews the token for posts already scheduled.
  await refreshPendingTokens(env, member.sub, token.accessToken, token.expiresAt);

  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId: `li_${member.sub.replace(/:/g, "_")}`,
    metadata: { label: member.name },
    scope: original.scope.length ? original.scope : [SCOPE_POST],
    props,
  });
  headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers });
}
