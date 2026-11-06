import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

declare global {
  interface Env extends Cloudflare.Env {}
  namespace Cloudflare {
    interface Env {
      /** KV namespace the OAuth library keeps grants, tokens and clients in. */
      OAUTH_KV: KVNamespace;
      /** D1 database holding scheduled posts. */
      DB: D1Database;
      /** Injected by OAuthProvider at runtime. */
      OAUTH_PROVIDER: OAuthHelpers;

      /** Secrets (wrangler secret put …). */
      LINKEDIN_CLIENT_ID: string;
      LINKEDIN_CLIENT_SECRET: string;
      /** 32+ random characters; encrypts LinkedIn tokens stored with scheduled posts. */
      SCHEDULE_ENCRYPTION_KEY: string;

      /** Plain vars (wrangler.jsonc → vars). */
      MCP_RESOURCE: string; // e.g. https://postline.example.workers.dev/mcp
      LINKEDIN_VERSION: string; // YYYYMM, e.g. 202608
      APP_NAME: string; // shown on every page
      OPERATOR_NAME: string; // who runs this server (privacy policy)
      SUPPORT_EMAIL: string; // support contact (docs + privacy policy)

      /** Test-only: point at a mock LinkedIn. Leave unset in production. */
      LINKEDIN_OAUTH_BASE?: string;
      LINKEDIN_API_BASE?: string;
      /** Test-only: minimum seconds between now and a scheduled time (default 60). */
      SCHEDULE_MIN_LEAD_SECONDS?: string;
    }
  }
}

/** What we store (encrypted) with each grant, readable from tool calls. */
export interface GrantProps {
  /** LinkedIn member id ("sub" from /v2/userinfo). Author URN is urn:li:person:<sub>. */
  sub: string;
  name: string;
  picture?: string;
  linkedinToken: string;
  /** Epoch ms when the LinkedIn access token stops working. */
  linkedinTokenExpiresAt: number;
  [key: string]: unknown;
}

export const SCOPE_POST = "linkedin.post";

export {};
