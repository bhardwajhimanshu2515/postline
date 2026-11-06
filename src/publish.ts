import { createPost, postUrl, uploadDocumentFromUrl, uploadImageFromUrl, type Visibility } from "./linkedin";
import { toCommentary } from "./littletext";

/** Everything needed to publish one post. Shared by "post now" and the scheduler. */
export interface PostRequest {
  text: string;
  visibility: Visibility;
  image_url?: string;
  image_alt_text?: string;
  link_url?: string;
  link_title?: string;
  link_description?: string;
  document_url?: string;
  document_title?: string;
}

export async function publish(
  token: string,
  version: string,
  memberSub: string,
  req: PostRequest,
): Promise<{ urn: string; url: string }> {
  const authorUrn = `urn:li:person:${memberSub}`;
  const imageUrn = req.image_url ? await uploadImageFromUrl(token, version, authorUrn, req.image_url) : undefined;
  const documentUrn = req.document_url
    ? await uploadDocumentFromUrl(token, version, authorUrn, req.document_url)
    : undefined;
  const urn = await createPost(token, version, {
    authorUrn,
    commentary: toCommentary(req.text),
    visibility: req.visibility,
    imageUrn,
    imageAltText: req.image_alt_text,
    document: documentUrn ? { urn: documentUrn, title: req.document_title || "Document" } : undefined,
    article: req.link_url ? { url: req.link_url, title: req.link_title!, description: req.link_description } : undefined,
  });
  return { urn, url: postUrl(urn) };
}
