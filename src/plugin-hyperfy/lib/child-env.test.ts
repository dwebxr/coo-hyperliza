import { describe, expect, it } from 'vitest';
import { childEnv } from './child-env';

describe('childEnv', () => {
  it('passes on what a program needs to start and nothing else of the agent', () => {
    const env = childEnv({
      PATH: '/usr/bin',
      HOME: '/home/agent',
      TMPDIR: '/tmp/x',
      LANG: 'ja_JP.UTF-8',
      DISPLAY: ':0',
      ANTHROPIC_API_KEY: 'key',
      OPENAI_API_KEY: 'key',
      ELEVENLABS_XI_API_KEY: 'key',
      ELIZA_SERVER_AUTH_TOKEN: 'token',
      TIP_WALLET_PRIVATE_KEY: '0xkey',
      POSTGRES_URL: 'postgresql://user:pw@db/x',
      SECRET_SALT: 'salt',
      WS_URL: 'wss://world.example/ws',
      HTTP_PROXY: 'http://proxy:3128',
      HTTPS_PROXY: 'http://proxy:3128',
      ALL_PROXY: 'socks5://proxy:1080',
      NODE_OPTIONS: '--require /tmp/inject.js',
      LD_PRELOAD: '/tmp/inject.so',
      DYLD_INSERT_LIBRARIES: '/tmp/inject.dylib',
      A_VARIABLE_ADDED_NEXT_YEAR: 'x',
      UNSET_HERE: undefined,
    });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/agent', TMPDIR: '/tmp/x', LANG: 'ja_JP.UTF-8', DISPLAY: ':0' });
  });

  it('reads the process environment by default, and never returns a variable that is not set', () => {
    const env = childEnv();
    expect(typeof process.env.PATH).toBe('string');
    expect(env.PATH).toBe(process.env.PATH);
    expect(Object.values(env).every((value) => typeof value === 'string')).toBe(true);
    // A name on the list that is not set is left out, not passed on as undefined
    expect(Object.keys(childEnv({ PATH: undefined, HOME: '/home/agent', TZ: undefined }))).toEqual(['HOME']);
    expect(Object.keys(childEnv({}))).toEqual([]);
  });
});
