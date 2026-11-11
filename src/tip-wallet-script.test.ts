import { spawnSync } from 'node:child_process';
import fs, { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

// The script is plain JavaScript outside src/: loaded by path, with its shape written out here
interface TipWalletScript {
  KEY: string;
  findAssignments(text: string): { normalized: string; found: { value: string; start: number; end: number }[] };
  plan(text: string, entry: string): { action: 'keep'; value: string } | { action: 'refuse'; count: number } | { action: 'write'; text: string };
  writeAtomically(file: string, text: string): void;
}
const { KEY, findAssignments, plan, writeAtomically } = (await import(/* @vite-ignore */ new URL('../scripts/tip-wallet.mjs', import.meta.url).href)) as TipWalletScript;

/*
 * scripts/tip-wallet.mjs, on files in a temporary directory of its own (never the repository's
 * .env: every run below names its file with --file).
 */

const script = fileURLToPath(new URL('../scripts/tip-wallet.mjs', import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function envFile(content?: string, mode = 0o644) {
  const dir = mkdtempSync(path.join(tmpdir(), 'coo-tip-wallet-'));
  dirs.push(dir);
  const file = path.join(dir, '.env');
  if (content !== undefined) {
    writeFileSync(file, content);
    chmodSync(file, mode);
  }
  return { dir, file };
}

function runScript(file: string) {
  const result = spawnSync(process.execPath, [script, '--file', file], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

const key = generatePrivateKey();
const address = privateKeyToAccount(key).address;
const bare = key.slice(2);

// Every way dotenv reads the key as set
const SET_SPELLINGS: [string, string][] = [
  ['plain', `${KEY}=${key}`],
  ['without 0x', `${KEY}=${bare}`],
  ['exported', `export ${KEY}=${key}`],
  ['exported with several spaces', `export   ${KEY}=${key}`],
  ['spaces around =', `${KEY} = ${key}`],
  ['indented', `   ${KEY}=${key}`],
  ['a colon', `${KEY}: ${key}`],
  ['double quotes', `${KEY}="${key}"`],
  ['single quotes', `${KEY}='${key}'`],
  ['backticks', `${KEY}=\`${key}\``],
  ['quotes and spaces', `export ${KEY} = "${key}"`],
  ['a trailing comment', `${KEY}=${key} # the tip wallet`],
  ['a quoted value and a trailing comment', `${KEY}="${key}" # the tip wallet`],
  ['CRLF line ends', `OTHER=1\r\n${KEY}=${key}\r\nMORE=2\r\n`],
  ['no final newline, after other lines', `OTHER=1\n\n${KEY}=${key}`],
];
const NOT_SET_SPELLINGS: [string, string][] = [
  ['an empty file', ''],
  ['other keys only', 'ANTHROPIC_API_KEY=abc\nWS_URL=wss://world.test/ws\n'],
  ['commented out', `# ${KEY}=${key}\n`],
  ['commented out with an indent', `   #${KEY}=${key}\n`],
  ['a longer name', `${KEY}_OLD=${key}\nMY_${KEY}=${key}\n`],
  ['the name inside another value', `NOTE="${KEY}=${key}"\n`],
];
const EMPTY_SPELLINGS: [string, string][] = [
  ['empty, as in .env.example', `# Tips\n${KEY}=\nOTHER=1\n`],
  ['empty quotes', `${KEY}=""\n`],
  ['exported and empty', `export ${KEY}=\n`],
  ['empty with a comment', `${KEY}= # put the key here\nOTHER=1\n`],
];

describe('reading a .env file the way dotenv does', () => {
  it.each([...SET_SPELLINGS, ...NOT_SET_SPELLINGS, ...EMPTY_SPELLINGS])('agrees with dotenv itself about the key: %s', (_what, text) => {
    const parsed = dotenv.parse(text)[KEY];
    const { found } = findAssignments(text);
    expect(found.at(-1)?.value).toBe(parsed);
    expect(found.length).toBe(parsed === undefined ? 0 : 1);
  });

  it.each(SET_SPELLINGS)('finds the key set: %s', (_what, text) => {
    expect(plan(text, 'ENTRY')).toEqual({ action: 'keep', value: text.includes(key) ? key : bare });
  });

  it.each(NOT_SET_SPELLINGS)('finds the key not set, and appends it without touching what is there: %s', (_what, text) => {
    const decision = plan(text, 'ENTRY');
    if (decision.action !== 'write') throw new Error(`expected a write, got ${decision.action}`);
    expect(decision.text.startsWith(text)).toBe(true);
    expect(decision.text.endsWith('\nENTRY\n')).toBe(true);
  });

  it.each(EMPTY_SPELLINGS)('puts the key on the one line that assigns nothing: %s', (_what, text) => {
    const decision = plan(text, 'ENTRY');
    if (decision.action !== 'write') throw new Error(`expected a write, got ${decision.action}`);
    expect(dotenv.parse(decision.text.replace('ENTRY', `${KEY}=${key}`))[KEY]).toBe(key);
    expect(findAssignments(decision.text.replace('ENTRY', `${KEY}=${key}`)).found).toHaveLength(1);
    // Everything else stays
    for (const line of text.split('\n').filter((candidate) => candidate && !candidate.includes(KEY))) expect(decision.text).toContain(line);
  });

  it.each([
    ['twice the same way', `${KEY}=${key}\n${KEY}=${key}\n`, 2],
    ['once exported and once spaced', `export ${KEY}=${key}\nOTHER=1\n${KEY} = "${key}"\n`, 2],
    ['an empty line and a set one', `${KEY}=\n${KEY}=${key}\n`, 2],
    ['two empty lines', `${KEY}=\nexport ${KEY}=\n`, 2],
    ['three times', `${KEY}=a\n${KEY}: b\n ${KEY}='c'\n`, 3],
  ])('refuses a file that assigns the key more than once: %s', (_what, text, count) => {
    expect(plan(text, 'ENTRY')).toEqual({ action: 'refuse', count });
  });

  it('keeps CRLF line ends when it writes', () => {
    const decision = plan(`OTHER=1\r\n${KEY}=\r\nMORE=2\r\n`, 'ENTRY');
    expect(decision.action === 'write' && decision.text).toBe('OTHER=1\r\nENTRY\r\nMORE=2\r\n');
  });
});

describe('npm run tip-wallet (the script itself, on a temporary file)', () => {
  const keyIn = (file: string) => dotenv.parse(readFileSync(file, 'utf8'))[KEY];

  it('creates the file with the key when there is none: mode 0600, the address printed, the key never', () => {
    const { dir, file } = envFile();
    const { status, out } = runScript(file);
    expect(status).toBe(0);
    const written = keyIn(file);
    expect(written).toMatch(/^0x[0-9a-f]{64}$/);
    expect(out).toContain(`Created a tip wallet: ${privateKeyToAccount(written as `0x${string}`).address}`);
    expect(out).not.toContain(written);
    expect(out).not.toContain(written.slice(2));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['.env']);
  });

  it('adds the key to an existing file by replacing it in one step: other lines kept, mode 0600, no temporary file left', () => {
    const before = 'ANTHROPIC_API_KEY=abc # comment\n\n# a note\nWS_URL=wss://world.test/ws';
    const { dir, file } = envFile(before, 0o644);
    const inode = statSync(file).ino;
    const { status, out } = runScript(file);
    expect(status).toBe(0);
    const after = readFileSync(file, 'utf8');
    expect(after.startsWith(`${before}\n`)).toBe(true);
    expect(findAssignments(after).found).toHaveLength(1);
    expect(out).not.toContain(keyIn(file));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // A new file took the old one's place (written next to it, then renamed)
    expect(statSync(file).ino).not.toBe(inode);
    expect(readdirSync(dir)).toEqual(['.env']);
  });

  it('fills the empty line of a copied .env.example in place', () => {
    const { file } = envFile(`# Tips\n${KEY}=\nOPENPAY_STORE_HANDLES=coo\n`);
    expect(runScript(file).status).toBe(0);
    const lines = readFileSync(file, 'utf8').split('\n');
    expect(lines[0]).toBe('# Tips');
    expect(lines[1]).toMatch(new RegExp(`^${KEY}=0x[0-9a-f]{64}$`));
    expect(lines.slice(2)).toEqual(['OPENPAY_STORE_HANDLES=coo', '']);
  });

  it.each(SET_SPELLINGS)('changes nothing and prints only the address when the key is already set: %s', (_what, text) => {
    const { dir, file } = envFile(text, 0o644);
    const before = statSync(file);
    const { status, out } = runScript(file);
    expect(status).toBe(0);
    expect(out).toContain('is already set in .env; nothing changed.');
    expect(out).toContain(`Tip wallet address: ${address}`);
    expect(out).not.toContain(bare);
    expect(readFileSync(file, 'utf8')).toBe(text);
    const after = statSync(file);
    expect([after.ino, after.mtimeMs, after.mode]).toEqual([before.ino, before.mtimeMs, before.mode]);
    expect(readdirSync(dir)).toEqual(['.env']);
  });

  it('refuses a file that assigns the key twice, and one whose value is not a key, without changing or printing either', () => {
    const duplicated = envFile(`export ${KEY}=${key}\n${KEY} = "${generatePrivateKey()}"\n`);
    const twice = runScript(duplicated.file);
    expect(twice.status).toBe(1);
    expect(twice.out).toContain(`${KEY} is assigned 2 times in .env; nothing changed.`);
    expect(twice.out).not.toContain(bare);
    expect(readFileSync(duplicated.file, 'utf8')).toContain(`export ${KEY}=${key}\n`);
    expect(findAssignments(readFileSync(duplicated.file, 'utf8')).found).toHaveLength(2);

    const invalid = envFile(`${KEY}=not-a-key-but-maybe-a-mistyped-secret\n`);
    const bad = runScript(invalid.file);
    expect(bad.status).toBe(1);
    expect(bad.out).toContain('is not a valid private key; nothing changed.');
    expect(bad.out).not.toContain('mistyped');
    expect(readFileSync(invalid.file, 'utf8')).toBe(`${KEY}=not-a-key-but-maybe-a-mistyped-secret\n`);
  });

  it('writes through a symlink: the link stays a link and its target gets the key', () => {
    const { dir, file: target } = envFile('OTHER=1\n');
    const link = path.join(dir, 'link.env');
    symlinkSync(target, link);
    expect(runScript(link).status).toBe(0);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(keyIn(target)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('leaves the file as it was when the new one cannot be put in place', () => {
    const { dir, file } = envFile('OTHER=1\n');
    chmodSync(dir, 0o500);
    try {
      const { status, out } = runScript(file);
      expect(status).toBe(1);
      expect(out).toContain('Could not write .env (EACCES); nothing changed.');
      expect(out).not.toMatch(/0x[0-9a-f]{64}/);
      expect(readFileSync(file, 'utf8')).toBe('OTHER=1\n');
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(readdirSync(dir)).toEqual(['.env']);
  });

  it('removes its temporary file and leaves the old file when the new one cannot be moved into place', () => {
    const { dir, file } = envFile('OTHER=1\n');
    // The move itself fails (as across file systems), after the temporary file was written
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
    });
    try {
      expect(() => writeAtomically(file, `OTHER=1\n${KEY}=${key}\n`)).toThrow('EXDEV');
      expect(rename).toHaveBeenCalledTimes(1);
    } finally {
      rename.mockRestore();
    }
    expect(readdirSync(dir)).toEqual(['.env']);
    expect(readFileSync(file, 'utf8')).toBe('OTHER=1\n');
  });

  it('takes no other arguments', () => {
    const { file } = envFile('OTHER=1\n');
    const result = spawnSync(process.execPath, [script, file], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    expect(result.status).toBe(2);
    expect(existsSync(file) && readFileSync(file, 'utf8')).toBe('OTHER=1\n');
  });
});
