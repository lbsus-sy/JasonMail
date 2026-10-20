export async function readBoundedBytes(source, maxBytes) {
  const declaredLength = Number(source.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await source.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = source.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readBoundedText(source, maxBytes) {
  const bytes = await readBoundedBytes(source, maxBytes);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}
