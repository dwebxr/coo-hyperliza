import { describe, expect, it } from 'vitest';
import { DEFAULT_WORLD_WS_URL, resolveWorldWsUrl } from './world-url';

describe('resolveWorldWsUrl', () => {
  it('uses the default world only when WS_URL is unset or empty', () => {
    expect(resolveWorldWsUrl(undefined)).toBe(DEFAULT_WORLD_WS_URL);
    expect(resolveWorldWsUrl('')).toBe(DEFAULT_WORLD_WS_URL);
  });

  it('refuses a WS_URL that is set but only whitespace, instead of falling back to the default world', () => {
    expect(() => resolveWorldWsUrl('   ')).toThrow('WS_URL is set but blank');
    expect(() => resolveWorldWsUrl('\t\n')).toThrow('WS_URL is set but blank');
  });

  it('returns a usable URL as written, without surrounding whitespace', () => {
    expect(resolveWorldWsUrl(' wss://play.example.com/ws ')).toBe('wss://play.example.com/ws');
    for (const url of ['ws://127.0.0.1:3000/ws', 'https://play.example.com/ws', 'http://localhost:3000/ws']) {
      expect(resolveWorldWsUrl(url)).toBe(url);
    }
  });

  it('refuses values that cannot be a world socket URL', () => {
    expect(() => resolveWorldWsUrl('play.example.com/ws')).toThrow(/not a valid URL/);
    expect(() => resolveWorldWsUrl('ftp://play.example.com/ws')).toThrow(/must start with ws:\/\/.*not ftp:\/\//);
    expect(() => resolveWorldWsUrl('localhost:3000/ws')).toThrow(/must start with/);
  });
});
