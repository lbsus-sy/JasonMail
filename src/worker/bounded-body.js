YªçŠx-®éÜj×¢ëiºÚ+Š§j[h‘éÜ¢éíß­S¢Ö¥¢ëiºÙbë5export async function readBoundedBytes(source, maxBytes) {
  const declaredLength = Number(source.headers.get('content-length') || 0);
  if (Number.isÛ­m¢G§²ÚîÆ­yØt(source, maxBytes) {
  const bytes = await readBoundedBytes(source, maxBytes);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}
