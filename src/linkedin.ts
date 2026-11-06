/**
 * Minimal LinkedIn client: sign-in (OAuth 2.0 + OpenID Connect) and the
 * Posts / Images APIs, using only the self-serve products
 * "Sign In with LinkedIn using OpenID Connect" and "Share on LinkedIn".
 */

import { env } from "cloudflare:workers";

export const LINKEDIN_SCOPES = "openid profile w_member_social";

// The *_BASE overrides exist only so tests can point at a mock LinkedIn.
const oauthBase = () => env.LINKEDIN_OAUTH_BASE || "https://www.linkedin.com";
const apiBase = () => env.LINKEDIN_API_BASE || "https://api.linkedin.com";

/** Error with a message that is safe to show the user. */
export class LinkedInError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: "auth" | "rate_limit" | "rejected" | "upstream" = "upstream",
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------- sign-in

export function authorizeUrl(opts: { clientId: string; redirectUri: string; state: string }): string {
  const url = new URL(`${oauthBase()}/oauth/v2/authorization`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("state", opts.state);
  url.searchParams.set("scope", LINKEDIN_SCOPES);
  return url.toString();
}

export interface LinkedInToken {
  accessToken: string;
  /** Epoch ms. */
  expiresAt: number;
  scope: string;
}

export async function exchangeCode(opts: {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
}): Promise<LinkedInToken> {
  const res = await fetch(`${oauthBase()}/oauth/v2/accessToken`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: opts.code,
      redirect_uri: opts.redirectUri,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof body.access_token !== "string") {
    const detail = String(body.error_description ?? body.error ?? res.status);
    throw new LinkedInError(`LinkedIn sign-in failed: ${detail}`, res.status, "auth");
  }
  const expiresIn = Number(body.expires_in ?? 0) || 60 * 24 * 3600; // LinkedIn issues 60-day tokens
  return {
    accessToken: body.access_token,
    expiresAt: Date.now() + expiresIn * 1000,
    scope: String(body.scope ?? ""),
  };
}

export interface LinkedInMember {
  sub: string;
  name: string;
  picture?: string;
  email?: string;
}

export async function getMember(token: string): Promise<LinkedInMember> {
  const res = await fetch(`${apiBase()}/v2/userinfo`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw await toError(res, "Couldn't read your LinkedIn profile");
  const body = (await res.json()) as Record<string, unknown>;
  if (typeof body.sub !== "string") throw new LinkedInError("LinkedIn didn't return a member id.", 502);
  const name =
    typeof body.name === "string"
      ? body.name
      : [body.given_name, body.family_name].filter((p) => typeof p === "string").join(" ") || "LinkedIn member";
  return {
    sub: body.sub,
    name,
    picture: typeof body.picture === "string" ? body.picture : undefined,
    email: typeof body.email === "string" ? body.email : undefined,
  };
}

// ---------------------------------------------------------------- posts

export type Visibility = "PUBLIC" | "CONNECTIONS";

export interface PostInput {
  authorUrn: string;
  commentary: string; // already in little text format
  visibility: Visibility;
  imageUrn?: string;
  imageAltText?: string;
  article?: { url: string; title: string; description?: string };
}

function restHeaders(token: string, version: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "LinkedIn-Version": version,
    "X-Restli-Protocol-Version": "2.0.0",
    "Content-Type": "application/json",
  };
}

export async function createPost(token: string, version: string, input: PostInput): Promise<string> {
  const body: Record<string, unknown> = {
    author: input.authorUrn,
    commentary: input.commentary,
    visibility: input.visibility,
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };
  if (input.article) {
    body.content = {
      article: {
        source: input.article.url,
        title: input.article.title,
        ...(input.article.description ? { description: input.article.description } : {}),
        ...(input.imageUrn ? { thumbnail: input.imageUrn } : {}),
      },
    };
  } else if (input.imageUrn) {
    body.content = {
      media: { id: input.imageUrn, ...(input.imageAltText ? { altText: input.imageAltText } : {}) },
    };
  }

  const res = await fetch(`${apiBase()}/rest/posts`, {
    method: "POST",
    headers: restHeaders(token, version),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await toError(res, "LinkedIn didn't publish the post");
  const urn = res.headers.get("x-restli-id") ?? res.headers.get("x-linkedin-id");
  if (!urn) throw new LinkedInError("LinkedIn accepted the post but didn't return its id.", 502);
  return urn;
}

export async function deletePost(token: string, version: string, postUrn: string): Promise<void> {
  const res = await fetch(`${apiBase()}/rest/posts/${encodeURIComponent(postUrn)}`, {
    method: "DELETE",
    headers: { ...restHeaders(token, version), "X-RestLi-Method": "DELETE" },
  });
  if (res.status === 404) throw new LinkedInError("That post doesn't exist or was already deleted.", 404, "rejected");
  if (!res.ok) throw await toError(res, "LinkedIn didn't delete the post");
}

export function postUrl(urn: string): string {
  return `https://www.linkedin.com/feed/update/${urn}/`;
}

// ---------------------------------------------------------------- images

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif"]);

/** Downloads an image from a public https URL and uploads it to LinkedIn. Returns urn:li:image:… */
export async function uploadImageFromUrl(
  token: string,
  version: string,
  ownerUrn: string,
  imageUrl: string,
): Promise<string> {
  const source = await fetch(imageUrl, { redirect: "follow" });
  if (!source.ok) throw new LinkedInError(`Couldn't download the image (HTTP ${source.status}).`, 400, "rejected");
  const type = (source.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!IMAGE_TYPES.has(type)) {
    throw new LinkedInError("The image must be a JPEG, PNG or GIF.", 400, "rejected");
  }
  const declared = Number(source.headers.get("content-length") ?? 0);
  if (declared > MAX_IMAGE_BYTES) throw new LinkedInError("The image is larger than 8 MB.", 400, "rejected");
  const bytes = await source.arrayBuffer();
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new LinkedInError("The image is larger than 8 MB.", 400, "rejected");

  const init = await fetch(`${apiBase()}/rest/images?action=initializeUpload`, {
    method: "POST",
    headers: restHeaders(token, version),
    body: JSON.stringify({ initializeUploadRequest: { owner: ownerUrn } }),
  });
  if (!init.ok) throw await toError(init, "LinkedIn didn't accept the image upload");
  const { value } = (await init.json()) as { value?: { uploadUrl?: string; image?: string } };
  if (!value?.uploadUrl || !value.image) throw new LinkedInError("LinkedIn didn't return an upload address.", 502);

  const put = await fetch(value.uploadUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": type },
    body: bytes,
  });
  if (!put.ok) throw await toError(put, "Uploading the image to LinkedIn failed");

  await waitUntilAvailable(token, version, value.image);
  return value.image;
}

/** LinkedIn processes uploads asynchronously; give it a few seconds before posting. */
async function waitUntilAvailable(token: string, version: string, imageUrn: string): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(`${apiBase()}/rest/images/${encodeURIComponent(imageUrn)}`, {
      headers: restHeaders(token, version),
    });
    if (!res.ok) return; // can't check: try posting anyway
    const { status } = (await res.json().catch(() => ({}))) as { status?: string };
    if (status === "AVAILABLE") return;
    if (status === "PROCESSING_FAILED") throw new LinkedInError("LinkedIn couldn't process the image.", 422, "rejected");
    await new Promise((r) => setTimeout(r, 750));
  }
}

// ---------------------------------------------------------------- errors

async function toError(res: Response, prefix: string): Promise<LinkedInError> {
  let detail = "";
  try {
    const body = (await res.json()) as Record<string, unknown>;
    detail = String(body.message ?? body.error_description ?? body.error ?? "");
  } catch {
    /* body wasn't JSON */
  }
  if (res.status === 401) {
    return new LinkedInError(
      "Your LinkedIn sign-in has expired or was revoked. Reconnect the connector in Claude's settings and try again.",
      401,
      "auth",
    );
  }
  if (res.status === 403) {
    return new LinkedInError(
      `${prefix}: LinkedIn refused permission${detail ? ` (${detail})` : ""}. Reconnecting usually fixes this.`,
      403,
      "auth",
    );
  }
  if (res.status === 429) {
    return new LinkedInError("LinkedIn's daily posting limit was reached. Try again tomorrow.", 429, "rate_limit");
  }
  const kind = res.status >= 400 && res.status < 500 ? "rejected" : "upstream";
  return new LinkedInError(`${prefix}${detail ? `: ${detail}` : ` (HTTP ${res.status})`}.`, res.status, kind);
}
