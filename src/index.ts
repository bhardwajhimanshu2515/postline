import { GrantType, OAuthError, OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { env } from "cloudflare:workers";
import { AuthHandler } from "./auth";
import { type GrantProps, SCOPE_POST } from "./env";
import { createServer } from "./mcp";
import { runDuePosts } from "./schedule";

const resourceHost = new URL(env.MCP_RESOURCE).hostname;

const mcpHandler = createMcpHandler(createServer, {
  route: "/mcp",
  allowedHostnames: [resourceHost],
});

const ONE_HOUR = 3600;

const provider = new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: {
    fetch(request: Request, env: Env, ctx: ExecutionContext) {
      return mcpHandler(request, env, ctx);
    },
  },
  defaultHandler: AuthHandler,

  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  clientIdMetadataDocumentEnabled: true,

  scopesSupported: [SCOPE_POST],
  requiredScopes: [SCOPE_POST],
  resourceMetadata: {
    resource: env.MCP_RESOURCE,
    resource_name: env.APP_NAME || "Postline",
  },

  accessTokenTTL: ONE_HOUR,

  // Keep Claude's sign-in no longer-lived than the LinkedIn token behind it.
  // LinkedIn's self-serve apps get no refresh tokens, so when the LinkedIn
  // token runs out the grant ends and Claude asks the user to reconnect.
  tokenExchangeCallback: async ({ grantType, props }) => {
    const p = props as GrantProps;
    const remaining = Math.floor((p.linkedinTokenExpiresAt - Date.now()) / 1000);
    if (remaining < 120) {
      throw new OAuthError("invalid_grant", { description: "LinkedIn sign-in expired. Please reconnect." });
    }
    if (grantType === GrantType.AUTHORIZATION_CODE) {
      return { refreshTokenTTL: Math.max(60, remaining), accessTokenTTL: Math.min(ONE_HOUR, remaining) };
    }
    return { accessTokenTTL: Math.min(ONE_HOUR, remaining) };
  },
});

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => provider.fetch(request, env, ctx),

  // Cron Trigger (every minute): publish scheduled posts that are due.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      runDuePosts(env).then((s) => {
        if (s.published || s.failed || s.retried) console.log("scheduled posts", s);
      }),
    );
  },
} satisfies ExportedHandler<Env>;
