import {
  type PollDuration,
  type Visibility,
  createPost,
  postUrl,
  uploadDocumentFromUrl,
  uploadImageFromUrl,
  uploadVideoFromUrl,
} from "./linkedin";
import { toCommentary } from "./littletext";

/** Everything needed to publish one post. Shared by "post now" and the scheduler. */
export interface PostRequest {
  text: string;
  visibility: Visibility;
  image_url?: string;
  image_alt_text?: string;
  image_urls?: string[];
  image_alt_texts?: string[];
  link_url?: string;
  link_title?: string;
  link_description?: string;
  document_url?: string;
  document_title?: string;
  video_url?: string;
  video_title?: string;
  poll_question?: string;
  poll_options?: string[];
  poll_duration?: PollDuration;
  reshare_of?: string;
}

/** Returns an error message if the attachments don't fit together, else null. */
export function attachmentProblem(req: Partial<PostRequest>): string | null {
  if (req.link_url && !req.link_title) return "A link card needs a title. Add link_title and try again.";
  if (req.document_url && !req.document_title) return "A PDF carousel needs a title. Add document_title and try again.";
  if (req.poll_question && !(req.poll_options && req.poll_options.length >= 2)) return "A poll needs 2 to 4 options.";
  if (req.poll_options?.length && !req.poll_question) return "A poll needs a question (poll_question).";
  if (req.image_urls && req.image_urls.length < 2) return "Use image_url for one image; image_urls takes 2 to 20.";
  const kinds = [
    req.image_url && !req.link_url ? "image" : null,
    req.image_urls?.length ? "images" : null,
    req.link_url ? "link card" : null,
    req.document_url ? "PDF carousel" : null,
    req.video_url ? "video" : null,
    req.poll_question ? "poll" : null,
    req.reshare_of ? "reshare" : null,
  ].filter(Boolean);
  if (kinds.length > 1) return `A post can have only one of: image, images, link card, PDF carousel, video, poll or reshare. This one has ${kinds.join(" + ")}.`;
  return null;
}

export async function publish(
  token: string,
  version: string,
  memberSub: string,
  req: PostRequest,
): Promise<{ urn: string; url: string }> {
  const authorUrn = `urn:li:person:${memberSub}`;
  const imageUrn = req.image_url ? await uploadImageFromUrl(token, version, authorUrn, req.image_url) : undefined;
  const documentUrn = req.document_url ? await uploadDocumentFromUrl(token, version, authorUrn, req.document_url) : undefined;
  const videoUrn = req.video_url ? await uploadVideoFromUrl(token, version, authorUrn, req.video_url) : undefined;
  const multiImage = req.image_urls?.length
    ? await Promise.all(
        req.image_urls.map(async (u, i) => ({
          urn: await uploadImageFromUrl(token, version, authorUrn, u),
          altText: req.image_alt_texts?.[i],
        })),
      )
    : undefined;
  const urn = await createPost(token, version, {
    authorUrn,
    commentary: toCommentary(req.text),
    visibility: req.visibility,
    imageUrn,
    imageAltText: req.image_alt_text,
    document: documentUrn ? { urn: documentUrn, title: req.document_title || "Document" } : undefined,
    video: videoUrn ? { urn: videoUrn, title: req.video_title } : undefined,
    multiImage,
    poll: req.poll_question
      ? { question: req.poll_question, options: req.poll_options!, duration: req.poll_duration ?? "SEVEN_DAYS" }
      : undefined,
    reshareOf: req.reshare_of,
    article: req.link_url ? { url: req.link_url, title: req.link_title!, description: req.link_description } : undefined,
  });
  return { urn, url: postUrl(urn) };
}
