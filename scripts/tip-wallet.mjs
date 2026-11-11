#!/usr/bin/env node
// Creates the agent's tip wallet: a new private key written straight into .env as
// TIP_WALLET_PRIVATE_KEY (never printed), and its address printed.
//
// It writes only when the key is not set yet. "Set" is read the way dotenv reads the file, so
// `export TIP_WALLET_PRIVATE_KEY=...`, `TIP_WALLET_PRIVATE_KEY = ...`, `TIP_WALLET_PRIVATE_KEY: ...`
// and quoted values all count:
// - set once, to a valid key: prints its address and changes nothing;
// - set once, to something that is not a key: says so and changes nothing (exit 1);
// - assigned more than once, whatever the values: says so and changes nothing (exit 1);
// - assigned once with an empty value (as in .env.example): that line gets the new key;
// - not there: the key is appended.
// The file is replaced in one step (a temporary file with mode 0600 next to it, then a rename),
// so a crash leaves either the old file or the new one, and the result is readable by its owner only.
//
// Usage: npm run tip-wallet            (the .env next to package.json)
//        node scripts/tip-wallet.mjs --file <path>   (another file; used by the tests)
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

export const KEY = 'TIP_WALLET_PRIVATE_KEY';

// dotenv 17's own line grammar (node_modules/dotenv/lib/main.js LINE), so that what counts as an
// assignment here is what the agent will read. src/tip-wallet-script.test.ts compares the two.
const LINE = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;

/** dotenv's reading of a raw value: trimmed, surrounding quotes removed, \n and \r expanded in double quotes. */
function unquote(raw) {
  let value = (raw || '').trim();
  const quote = value[0];
  value = value.replace(/^(['"`])([\s\S]*)\1$/gm, '$2');
  if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
  return value;
}

/**
 * Every assignment of `key` in the text of a .env file, as dotenv finds them: `value` as dotenv
 * would read it, and where the assignment is in `text` (`text` with CRLF and CR written as LF,
 * which is what dotenv parses).
 */
export function findAssignments(text, key = KEY) {
  const normalized = text.replace(/\r\n?/g, '\n');
  const found = [];
  LINE.lastIndex = 0;
  for (let match; (match = LINE.exec(normalized)) !== null; ) {
    if (match[1] !== key) continue;
    // The match can start with the blank lines before the assignment: those are not part of it
    const lead = match[0].length - match[0].trimStart().length;
    found.push({ value: unquote(match[2]), start: match.index + lead, end: match.index + match[0].length });
  }
  return { normalized, found };
}

/**
 * What to do with a .env file's text: { action: 'keep', value } when the key is set once,
 * { action: 'refuse', count } when it is assigned more than once, or { action: 'write', text }
 * with the text that has `entry` in place of the one empty assignment or appended.
 */
export function plan(text, entry, key = KEY) {
  const { normalized, found } = findAssignments(text, key);
  if (found.length > 1) return { action: 'refuse', count: found.length };
  if (found.length === 1 && found[0].value !== '') return { action: 'keep', value: found[0].value };
  let updated;
  if (found.length === 1) {
    updated = `${normalized.slice(0, found[0].start)}${entry}${normalized.slice(found[0].end)}`;
  } else {
    updated = `${normalized}${normalized && !normalized.endsWith('\n') ? '\n' : ''}\n# Tip wallet (npm run tip-wallet). Back this key up; never share it.\n${entry}\n`;
  }
  // A file written with CRLF line ends keeps them
  return { action: 'write', text: text.includes('\r\n') ? updated.replace(/\n/g, '\r\n') : updated };
}

/** Replaces `file` with `text` in one step, readable and writable by the owner only. */
export function writeAtomically(file, text) {
  // Through a symlink, so the link stays and its target is replaced
  const target = fs.existsSync(file) ? fs.realpathSync(file) : file;
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let fd;
  try {
    // wx: never through something that is already there under that name
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, target);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

/** Runs the command on `envPath`. Returns the exit status; prints through `log`/`fail`, never the key. */
export function run(envPath, { log = console.log, fail = console.error } = {}) {
  const shown = path.basename(envPath);
  const text = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const key = generatePrivateKey();
  const decision = plan(text, `${KEY}=${key}`);

  if (decision.action === 'refuse') {
    fail(`${KEY} is assigned ${decision.count} times in ${shown}; nothing changed. Remove all but one of those lines (or all of them, to create a new wallet), then run this again.`);
    return 1;
  }
  if (decision.action === 'keep') {
    try {
      const existing = decision.value;
      const { address } = privateKeyToAccount(existing.startsWith('0x') ? existing : `0x${existing}`);
      log(`${KEY} is already set in ${shown}; nothing changed.\nTip wallet address: ${address}`);
      return 0;
    } catch {
      fail(`${KEY} in ${shown} is not a valid private key; nothing changed. Fix or remove that line, then run this again.`);
      return 1;
    }
  }

  const { address } = privateKeyToAccount(key);
  try {
    writeAtomically(envPath, decision.text);
  } catch (error) {
    // The system's message names the path, never the content
    fail(`Could not write ${shown} (${error?.code ?? error?.message ?? error}); nothing changed.`);
    return 1;
  }
  log(`Created a tip wallet: ${address}
The private key was written to ${shown} as ${KEY} (not shown here).
- Back it up somewhere safe, such as a password manager: without it, tokens sent to this address cannot be moved.
- Move tips to your main wallet now and then; keep only small amounts here.
- Restart the agent to start receiving tips.`);
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const fileOption = args.indexOf('--file');
  if (args.length && (fileOption !== 0 || args.length !== 2)) {
    console.error('Usage: node scripts/tip-wallet.mjs [--file <path to the .env file>]');
    process.exit(2);
  }
  const envPath = fileOption === 0 ? path.resolve(args[1]) : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
  process.exit(run(envPath));
}
