import { describe, it, expect } from 'vitest';
import { Readable } from 'stream';
import type { IncomingMessage } from 'http';
import { readJsonBody, HttpError, MAX_BODY_BYTES } from '../../../src/fleet/server.js';

/** A minimal IncomingMessage stand-in: readJsonBody only async-iterates the body. */
function bodyReq(...parts: Array<string | Buffer>): IncomingMessage {
  return Readable.from(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p)))) as unknown as IncomingMessage;
}

describe('readJsonBody', () => {
  it('parses a well-formed JSON object', async () => {
    expect(await readJsonBody(bodyReq('{"profile":"a","prompt":"hi"}'))).toEqual({
      profile: 'a',
      prompt: 'hi',
    });
  });

  it('returns {} for an empty body', async () => {
    expect(await readJsonBody(bodyReq(''))).toEqual({});
  });

  it('throws HttpError(400) on malformed JSON (not a misleading missing-field 400)', async () => {
    await expect(readJsonBody(bodyReq('{not json'))).rejects.toMatchObject({
      status: 400,
      message: 'malformed JSON body',
    });
  });

  it('throws HttpError(413) when the body exceeds the size cap', async () => {
    const tooBig = Buffer.alloc(MAX_BODY_BYTES + 1, 0x61); // 'a' * (cap + 1)
    const err = await readJsonBody(bodyReq(tooBig)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(413);
  });

  it('stops reading once the cap is exceeded across chunks', async () => {
    const half = Buffer.alloc(Math.ceil(MAX_BODY_BYTES / 2) + 1, 0x61);
    await expect(readJsonBody(bodyReq(half, half))).rejects.toMatchObject({ status: 413 });
  });
});
