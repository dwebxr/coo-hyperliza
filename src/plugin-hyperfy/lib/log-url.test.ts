import { describe, expect, it } from 'vitest';
import { MAX_LOGGED_URL, describeUrl } from './log-url';

describe('describeUrl', () => {
  it.each([
    ['a plain URL', 'https://cdn.example.com/models/a.glb', 'https://cdn.example.com/models/a.glb'],
    ['credentials', 'https://user:secret-pw@cdn.example.com/a.glb', 'https://cdn.example.com/a.glb'],
    ['a signed query', 'https://bucket.example.com/a.glb?X-Amz-Credential=AKIA123&X-Amz-Signature=deadbeef', 'https://bucket.example.com/a.glb?X-Amz-Credential=…&X-Amz-Signature=…'],
    ['a fragment', 'https://cdn.example.com/a.glb#token=secret', 'https://cdn.example.com/a.glb'],
    ['a port and a websocket scheme', 'wss://lk.example.com:7880/rtc?access_token=secret', 'wss://lk.example.com:7880/rtc?access_token=…'],
    ['an asset URL', 'asset://abc.glb', 'asset://abc.glb'],
    ['a bundled path with a query', '/emotes/wave.glb?v=secret', '/emotes/wave.glb?…'],
    ['a path with a fragment', 'avatar.vrm#secret', 'avatar.vrm'],
    ['a data: URL', 'data:text/plain;base64,c2VjcmV0', 'data:text/plain… (31 characters)'],
    ['something that is not a string', 42, '42'],
    ['a broken URL with a user part', 'https://user:secret@[broken/a.glb?token=x', '<invalid URL, 41 characters>'],
    ['a broken network-path reference', '//user:secret@host/a', '<invalid URL, 20 characters>'],
    ['a blob: URL around one with credentials', 'blob:https://user:secret@cdn.example.com/uuid', 'blob:https://cdn.example.com/uuid'],
    ['a scheme in the place of a user name', 'admin:secret@host/x', '<URL of another kind, 19 characters>'],
    ['an opaque URL', 'mailto:someone@example.com', '<URL of another kind, 26 characters>'],
  ])('writes %s without anything secret', (_name, url, expected) => {
    expect(describeUrl(url)).toBe(expected);
  });

  it('caps a long URL and says how long it was', () => {
    const url = `https://cdn.example.com/${'a'.repeat(500)}.glb`;
    const line = describeUrl(url);
    expect(line.startsWith(url.slice(0, MAX_LOGGED_URL))).toBe(true);
    expect(line).toContain(`(${url.length} characters)`);
    expect(line.length).toBeLessThan(MAX_LOGGED_URL + 40);
  });
});
