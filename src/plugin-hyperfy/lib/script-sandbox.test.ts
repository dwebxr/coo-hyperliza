import 'ses';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  LOCKDOWN_OPTIONS,
  WORLD_SCRIPTS_RESIDUAL_RISK,
  type ProbeResult,
  activateScriptSandbox,
  createScriptCompartment,
  createSelfTestCompartment,
  describeRejection,
  failedProbes,
  guardErrorEventsForWorldScripts,
  isScriptSandboxActive,
  resolveWorldScriptsMode,
  runEscapeProbes,
} from './script-sandbox';
import { createScriptMembrane } from './script-membrane';

// This worker is never locked down: lockdown is injected, and the real thing runs in a child
// process (script-sandbox.child.test.ts).

describe('HYPERFY_WORLD_SCRIPTS', () => {
  it('is off unless it says sandboxed', () => {
    expect(resolveWorldScriptsMode(undefined)).toEqual({ mode: 'off' });
    expect(resolveWorldScriptsMode('')).toEqual({ mode: 'off' });
    expect(resolveWorldScriptsMode('off')).toEqual({ mode: 'off' });
    expect(resolveWorldScriptsMode(' Sandboxed ')).toEqual({ mode: 'sandboxed' });
  });

  it('treats any other value as a mistake and stays off: there is no unsandboxed mode', () => {
    for (const value of ['on', 'true', '1', 'unsafe', 'trusted', 'unsandboxed']) {
      const result = resolveWorldScriptsMode(value);
      expect(result.mode).toBe('off');
      expect(result.problem).toContain(value);
    }
  });

  it('sandboxed: the error-event guard is installed as soon as src/index.ts asks, and only then', () => {
    for (const [value, installed] of [['sandboxed', true], [' SANDBOXED', true], ['off', false], [undefined, false], ['on', false]] as const) {
      const install = vi.fn();
      expect(guardErrorEventsForWorldScripts({ HYPERFY_WORLD_SCRIPTS: value }, install), String(value)).toBe(installed);
      expect(install).toHaveBeenCalledTimes(installed ? 1 : 0);
    }
    expect(readFileSync(new URL('../../index.ts', import.meta.url), 'utf8')).toContain('guardErrorEventsForWorldScripts(process.env);');
  });
});

// The probes added with the species, reference, receiver and error fixes (P1a2 review S-01..S-06)
const MEMBRANE_PROBES = [
  "a promise's species constructor is handed a host value (promise passed to the host)",
  "a promise's species constructor is handed a host value (promise returned by a callback)",
  "the host never holds a buffer carrying a script's properties",
  'the host never holds a copy that unwraps to a host object as a reference',
  'no host function was written to through `this`',
  'a host function never comes back to the host as itself',
  'a host error reaches a script with its stack, cause or file paths',
];

describe('escape probes', () => {
  const leakyTools = {
    // A compartment in a realm that was never locked down, and no membrane at all
    evaluate: (code: string, globals: Record<string, unknown>) => new Compartment({ globals, __options__: true }).evaluate(code),
    toScript: (value: unknown) => value,
  };
  const names = (list: ProbeResult[]) => failedProbes(list).map((probe) => probe.name);

  it('report the Function-constructor escape and raw host objects when the realm is not locked down', async () => {
    const failed = names(await runEscapeProbes(leakyTools));

    expect(failed).toContain('Function constructor reached from a script function');
    expect(failed).toContain('AsyncFunction constructor');
    expect(failed).toContain('Function constructor reached from anything reachable from the globals');
    expect(failed).toContain('a host object handed over by a host function');
    expect(failed).toContain('a callback is called with a host object');
    expect(failed).toContain('what a script throws reaches the host as a plain Error');
    expect(failed).toContain('language intrinsics are frozen');
    // Without a membrane the host holds the script's own buffer, copy and function, and the
    // script holds the host's function and error
    expect(failed).toContain("the host never holds a buffer carrying a script's properties");
    expect(failed).toContain('the host never holds a copy that unwraps to a host object as a reference');
    expect(failed).toContain('no host function was written to through `this`');
    expect(failed).toContain('a host function never comes back to the host as itself');
    expect(failed).toContain('a host error reaches a script with its stack, cause or file paths');
    expect(failed).not.toContain('the self-test can evaluate a script');
  });

  it('report a membrane that lets host objects through even when the language probes pass', async () => {
    const results = await runEscapeProbes({ ...leakyTools, toScript: (value) => value });
    const membrane = createScriptMembrane();
    const withMembrane = names(await runEscapeProbes({ ...leakyTools, toScript: membrane.toScript }));

    expect(names(results)).toContain('a host object handed over by a host function');
    expect(withMembrane).not.toContain('a host object handed over by a host function');
    expect(withMembrane).not.toContain('a callback is called with a host object');
    expect(withMembrane).not.toContain('what a script throws reaches the host as a plain Error');
    // The membrane's own probes pass with this membrane even in a realm that is not locked down
    for (const name of MEMBRANE_PROBES) expect(withMembrane).not.toContain(name);
  });

  it('run every membrane probe and report it by name', async () => {
    const all = (await runEscapeProbes({ ...leakyTools, toScript: createScriptMembrane().toScript })).map((probe) => probe.name);
    for (const name of MEMBRANE_PROBES) expect(all).toContain(name);
  });

  it('count a self-test that cannot evaluate anything as failed, not as "every probe blocked"', async () => {
    const results = await runEscapeProbes({
      evaluate: () => {
        throw new Error('no compartment');
      },
      toScript: createScriptMembrane().toScript,
    });

    expect(names(results)).toContain('the self-test can evaluate a script');
  });
});

describe('activating the sandbox', () => {
  const log = () => ({ info: vi.fn(), error: vi.fn() });
  const blocked: ProbeResult = { name: 'probe', blocked: true, detail: 'ok' };

  it('refuses, and stays inactive, when lockdown throws', async () => {
    const out = log();
    const selfTest = vi.fn(() => [blocked]);

    const ok = await activateScriptSandbox({ guardErrorEvents: () => null,
      lockdown: () => {
        throw new Error('Already locked down');
      },
      selfTest,
      log: out,
    });

    expect(ok).toBe(false);
    expect(selfTest).not.toHaveBeenCalled();
    expect(isScriptSandboxActive()).toBe(false);
    expect(out.error.mock.calls[0][0]).toContain('SES lockdown failed: Already locked down');
    expect(() => createScriptCompartment({})).toThrow('after the sandbox has been activated');
  });

  it('refuses, and stays inactive, when one probe is not blocked', async () => {
    const out = log();

    const ok = await activateScriptSandbox({ guardErrorEvents: () => null,
      lockdown: () => {},
      selfTest: () => [blocked, { name: 'Function constructor', blocked: false, detail: 'ESCAPED object' }],
      log: out,
    });

    expect(ok).toBe(false);
    expect(isScriptSandboxActive()).toBe(false);
    expect(out.error.mock.calls[0][0]).toContain('self-test FAILED: Function constructor (ESCAPED object)');
    expect(out.info).not.toHaveBeenCalled();
    expect(() => createScriptCompartment({})).toThrow('after the sandbox has been activated');
    expect(() => createSelfTestCompartment({})).toThrow('only while the sandbox self-test runs');
  });

  it('refuses when the self-test itself cannot run, or runs no checks', async () => {
    const failing = await activateScriptSandbox({ guardErrorEvents: () => null,
      lockdown: () => {},
      selfTest: async () => {
        throw new Error('no Compartment');
      },
      log: log(),
    });
    const empty = await activateScriptSandbox({ guardErrorEvents: () => null, lockdown: () => {}, selfTest: () => [], log: log() });

    expect(failing).toBe(false);
    expect(empty).toBe(false);
    expect(isScriptSandboxActive()).toBe(false);
  });

  it('allows only self-test compartments while the self-test runs, and hands a second caller the same activation', async () => {
    let during: Record<string, string> = {};
    let concurrent: Promise<boolean> | undefined;
    const ok = await activateScriptSandbox({ guardErrorEvents: () => null,
      lockdown: () => {},
      selfTest: async () => {
        const attempt = (fn: () => unknown) => {
          try {
            fn();
            return 'created';
          } catch (err) {
            return (err as Error).message;
          }
        };
        during = { script: attempt(() => createScriptCompartment({})), selfTest: attempt(() => createSelfTestCompartment({})) };
        concurrent = activateScriptSandbox({ guardErrorEvents: () => null, lockdown: () => {}, selfTest: () => [blocked], log: log() });
        return [{ name: 'control', blocked: false, detail: 'stop here' }];
      },
      log: log(),
    });

    expect(ok).toBe(false);
    expect(during.script).toContain('after the sandbox has been activated');
    expect(during.selfTest).toBe('created');
    // The caller during the activation waited for it and got its result; nothing ran twice
    expect(await concurrent).toBe(false);
  });

  it('refuses with the real probes when lockdown did nothing', async () => {
    const out = log();
    const membrane = createScriptMembrane();

    const ok = await activateScriptSandbox({ guardErrorEvents: () => null,
      lockdown: () => {},
      selfTest: () =>
        runEscapeProbes({
          evaluate: (code, globals) => createSelfTestCompartment(globals).evaluate(code),
          toScript: membrane.toScript,
        }),
      log: out,
    });

    expect(ok).toBe(false);
    expect(isScriptSandboxActive()).toBe(false);
    const errors = out.error.mock.calls.map((call) => call[0]).join('\n');
    expect(errors).toContain('Function constructor reached from a script function');
    // The probes did evaluate: the control passed
    expect(errors).not.toContain('the self-test can evaluate a script');
  });

  it('passes the documented options to lockdown', async () => {
    const lock = vi.fn(() => {
      throw new Error('stop here');
    });
    await activateScriptSandbox({ guardErrorEvents: () => null, lockdown: lock, selfTest: () => [], log: log() });
    expect(lock).toHaveBeenCalledWith(LOCKDOWN_OPTIONS);
    expect(LOCKDOWN_OPTIONS).toMatchObject({ localeTaming: 'unsafe', overrideTaming: 'severe', errorTrapping: 'none' });
  });
});

describe('describeRejection', () => {
  it('uses strings only and never calls an inspect hook', () => {
    const hook = vi.fn();
    const reason = { message: 'boom', name: 'Custom', [Symbol.for('nodejs.util.inspect.custom')]: hook };

    expect(describeRejection(reason)).toBe('Custom: boom');
    expect(describeRejection(new Error('real'))).toContain('real');
    expect(describeRejection('text')).toBe('text');
    expect(describeRejection(undefined)).toBe('undefined');
    expect(describeRejection({ secret: 1 })).toBe('a value that is not an error');
    expect(hook).not.toHaveBeenCalled();
  });

  it('survives a reason whose properties throw', () => {
    const reason = {
      get stack(): string {
        throw new Error('no');
      },
      get message(): string {
        throw new Error('no');
      },
    };
    expect(describeRejection(reason)).toBe('a value that is not an error');
  });
});

describe('the residual-risk statement', () => {
  it('is quoted word for word in README.md', () => {
    const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');
    expect(readme).toContain(`> ${WORLD_SCRIPTS_RESIDUAL_RISK}`);
  });

  it('names what the sandbox cannot stop', () => {
    for (const phrase of ['while (true) {}', 'no CPU or memory isolation', 'download', 'whole process', 'not a guarantee against a hostile world']) {
      expect(WORLD_SCRIPTS_RESIDUAL_RISK).toContain(phrase);
    }
  });
});
