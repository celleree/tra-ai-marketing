/** Streams private MP4 bytes and supports the single ranges used by browser playback. */
export const createVideoResponse = (bytes: Uint8Array, request: Request): Response => {
  const headers = new Headers({ 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  let start = 0;
  let end = bytes.byteLength - 1;
  let status = 200;
  // No validators are emitted. A conditional range must receive the full representation.
  const range = request.headers.has('If-Range') ? null : request.headers.get('Range');
  const match = range && /^bytes=(\d*)-(\d*)$/.exec(range);
  // Ignore unsupported or malformed range syntax, including multipart requests.
  if (match && (match[1] || match[2])) {
    const first = match[1] ? Number(match[1]) : null;
    const last = match[2] ? Number(match[2]) : null;
    if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))
      || (first !== null && first >= bytes.byteLength) || (first !== null && last !== null && first > last)
      || (first === null && last === 0) || bytes.byteLength === 0) {
      headers.set('Content-Range', `bytes */${bytes.byteLength}`);
      return new Response(null, { status: 416, headers });
    }
    start = first === null ? Math.max(0, bytes.byteLength - last!) : first;
    end = first === null || last === null ? end : Math.min(last, end);
    status = 206;
    headers.set('Content-Range', `bytes ${start}-${end}/${bytes.byteLength}`);
  }
  headers.set('Content-Length', String(Math.max(0, end - start + 1)));
  let cursor = start;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (cursor > end) { controller.close(); return; }
      const next = Math.min(cursor + 64 * 1024, end + 1);
      controller.enqueue(bytes.subarray(cursor, next));
      cursor = next;
    },
  }), { status, headers });
};
