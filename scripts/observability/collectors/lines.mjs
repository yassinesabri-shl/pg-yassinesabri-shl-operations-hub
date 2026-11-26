// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-26
/**
 * lines.mjs — reads a JSON-lines log from an offset, the way every file-based collector adapter
 * needs it: in chunks, so a long log never sits in memory whole, and only up to the last complete
 * line, so a half-written line waits for the next read. A file shorter than the offset was
 * replaced, and is read again from the start: the checkpoint keeps every call from counting twice.
 *
 * Node standard library only.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';

const CHUNK = 4 * 1024 * 1024;

/**
 * Calls `onLine(line)` for every complete line after `offset` that contains one of `needles`, in
 * order. A line without any of them is never parsed. Returns the offset to start from next time.
 */
export function readLines(path, offset, needles, onLine) {
  const wanted = (line) => needles.some((n) => line.includes(n));
  let size;
  try {
    size = statSync(path).size;
  } catch (err) {
    if (err.code === 'ENOENT') return offset || 0;
    throw err;
  }
  let at = offset && offset <= size ? offset : 0;
  let next = at;
  let carry = Buffer.alloc(0);
  const fd = openSync(path, 'r');
  try {
    while (at < size) {
      const buf = Buffer.alloc(Math.min(CHUNK, size - at));
      const got = readSync(fd, buf, 0, buf.length, at);
      if (got <= 0) break;
      at += got;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, got)]) : buf.subarray(0, got);
      const end = data.lastIndexOf(10);
      if (end === -1) {
        carry = data;
      } else {
        for (const line of data.subarray(0, end).toString('utf8').split('\n')) if (wanted(line)) onLine(line);
        next += end + 1;
        carry = data.subarray(end + 1);
      }
    }
  } finally {
    closeSync(fd);
  }
  return next;
}
