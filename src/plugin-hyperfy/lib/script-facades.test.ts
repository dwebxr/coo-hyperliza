import { describe, expect, it, vi } from 'vitest';
import {
  type ScriptNetwork,
  createScriptConsole,
  createScriptFetch,
  createScriptSetTimeout,
  scriptBlobBytes,
} from './script-facades';

const target = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe('script console', () => {
  it('hands the host console one string per call and never calls a custom-inspect hook', () => {
    const out = target();
    let hooked = 0;
    const value = {
      a: 1,
      nested: { b: [1, 2] },
      [Symbol.for('nodejs.util.inspect.custom')]() {
        hooked++;
        return 'hooked';
      },
    };

    createScriptConsole(out).log('label', value, 3);
    createScriptConsole(out).error(value);

    expect(out.log.mock.calls).toHaveLength(1);
    expect(out.log.mock.calls[0]).toHaveLength(1);
    expect(out.log.mock.calls[0][0]).toMatch(/^\[script\] label \{ a: 1, nested: \{ b: \[ 1, 2 \] \}.* 3$/);
    expect(out.error.mock.calls[0]).toHaveLength(1);
    expect(typeof out.error.mock.calls[0][0]).toBe('string');
    expect(out.log.mock.calls[0][0]).not.toContain('hooked');
    expect(hooked).toBe(0);
  });

  it('bounds the length of a line', () => {
    const out = target();
    createScriptConsole(out).warn('x'.repeat(10_000));
    expect(out.warn.mock.calls[0][0].length).toBeLessThan(2200);
    expect(out.warn.mock.calls[0][0]).toContain('more characters');
  });

  it('times with labels rendered to text', () => {
    const out = target();
    const scriptConsole = createScriptConsole(out);
    scriptConsole.time('load');
    scriptConsole.timeEnd('load');
    scriptConsole.timeEnd('never started');
    expect(out.log).toHaveBeenCalledTimes(1);
    expect(out.log.mock.calls[0][0]).toMatch(/^\[script\] load: [\d.]+ms$/);
  });
});

describe('script fetch', () => {
  it('rejects every request when no network function is given, and says so once', async () => {
    const out = target();
    const scriptFetch = createScriptFetch(null, new AbortController().signal, out);

    await expect(scriptFetch('https://example.com/')).rejects.toThrow('fetch is not available to world scripts');
    await expect(scriptFetch('http://127.0.0.1:3000/api/agents')).rejects.toBeInstanceOf(TypeError);

    expect(out.warn).toHaveBeenCalledTimes(1);
  });

  it('passes the network function only strings and bytes, and builds the response from what it returns', async () => {
    const signal = new AbortController().signal;
    const network = vi.fn<ScriptNetwork>(async () => ({
      status: 201,
      statusText: 'Created',
      headers: { 'Content-Type': 'application/json', weird: 5 as unknown as string },
      body: new TextEncoder().encode('{"ok":true}'),
    }));
    const scriptFetch = createScriptFetch(network, signal, target());

    const response: any = await scriptFetch('https://api.test/x', {
      method: 'post',
      headers: { a: 'b', n: 1, o: {} },
      body: new Uint8Array([1, 2]),
      signal: 'ignored',
      agent: {},
    });

    expect(network).toHaveBeenCalledWith('https://api.test/x', { method: 'POST', headers: { a: 'b' }, body: new Uint8Array([1, 2]) }, signal);
    expect(response.ok).toBe(true);
    expect(response.status).toBe(201);
    expect(response.headers).toEqual({ 'content-type': 'application/json' });
    expect(await response.json()).toEqual({ ok: true });
    expect(await response.text()).toBe('{"ok":true}');
    expect(Object.isFrozen(response)).toBe(true);
  });

  it('refuses a URL that is not a string', async () => {
    const network = vi.fn<ScriptNetwork>();
    await expect(createScriptFetch(network, new AbortController().signal, target())({ href: 'x' })).rejects.toThrow('must be a string');
    expect(network).not.toHaveBeenCalled();
  });

  it('gives a frozen blob made of plain values, keeping the bytes out of the object', async () => {
    const body = new TextEncoder().encode('hello world');
    const scriptFetch = createScriptFetch(
      async () => ({ status: 200, statusText: 'OK', headers: { 'content-type': 'image/png' }, body }),
      new AbortController().signal,
      target()
    );
    const blob: any = await ((await scriptFetch('https://x.test/')) as any).blob();

    expect(blob).not.toBeInstanceOf(Blob);
    expect(Object.getPrototypeOf(blob)).toBe(Object.prototype);
    expect(Object.isFrozen(blob)).toBe(true);
    expect(blob.size).toBe(11);
    expect(blob.type).toBe('image/png');
    expect(await blob.text()).toBe('hello world');
    expect(await blob.slice(6).text()).toBe('world');
    expect(await blob.slice(-5, -1).text()).toBe('worl');
    // What the script reads is a copy: changing it does not change the blob
    new Uint8Array(await blob.arrayBuffer())[0] = 0;
    expect(await blob.text()).toBe('hello world');
    expect(scriptBlobBytes(blob)).toEqual(body);
    expect(scriptBlobBytes({ size: 11, type: 'image/png' })).toBeUndefined();
  });
});

describe('script setTimeout', () => {
  it('returns a number and keeps the engine timer to itself', () => {
    const timers: unknown[] = [];
    const engine = vi.fn((fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms);
      timers.push(timer);
      clearTimeout(timer);
      return timer;
    });
    const scriptSetTimeout = createScriptSetTimeout(engine, target());

    const first = scriptSetTimeout(() => {}, 5);
    const second = scriptSetTimeout(() => {}, -5);

    expect([first, second]).toEqual([1, 2]);
    expect(engine.mock.calls.map((call) => call[1])).toEqual([5, 0]);
    expect(() => scriptSetTimeout('not a function')).toThrow(TypeError);
  });

  it('contains an error thrown by the callback', () => {
    const out = target();
    let run: () => void = () => {};
    const scriptSetTimeout = createScriptSetTimeout((fn) => void (run = fn), out);
    scriptSetTimeout(() => {
      throw new Error('late');
    }, 0);

    expect(() => run()).not.toThrow();
    expect(out.error.mock.calls[0][0]).toContain('late');
  });
});
