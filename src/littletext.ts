/**
 * LinkedIn reads a post's `commentary` as "little text": these characters
 * are markup, and an unescaped one can cut the post off.
 *   | { } @ [ ] ( ) < > # \ * _ ~
 * We escape everything, then turn #words back into real hashtags with
 * LinkedIn's hashtag template: {hashtag|\#|word}
 */

const RESERVED = /[\\|{}@[\]()<>#*_~]/g;
// A hashtag starts the text or follows whitespace/punctuation, then letters/digits.
const HASHTAG = /(^|[^\p{L}\p{N}_&\\])#([\p{L}\p{N}]+)/gu;

export function escapeLittleText(text: string): string {
  return text.replace(RESERVED, (c) => `\\${c}`);
}

export function toCommentary(text: string, opts: { hashtags?: boolean } = {}): string {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (opts.hashtags === false) return escapeLittleText(normalized);

  let out = "";
  let last = 0;
  for (const m of normalized.matchAll(HASHTAG)) {
    const start = m.index! + m[1].length; // position of '#'
    out += escapeLittleText(normalized.slice(last, start));
    out += `{hashtag|\\#|${m[2]}}`;
    last = start + 1 + m[2].length;
  }
  return out + escapeLittleText(normalized.slice(last));
}
