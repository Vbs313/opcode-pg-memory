const PRIVATE_TAG_RE = /<private>[\s\S]*?<\/private>/gi;

export function containsPrivateTag(content: string): boolean {
  if (!content) return false;
  return PRIVATE_TAG_RE.test(content);
}

export function stripPrivateContent(content: string): string {
  if (!content) return content;
  return content.replace(PRIVATE_TAG_RE, '[REDACTED]');
}

export function isFullyPrivate(content: string): boolean {
  if (!content) return false;
  const stripped = stripPrivateContent(content).trim();
  return stripped === '[REDACTED]' || stripped === '';
}
