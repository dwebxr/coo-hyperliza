#!/usr/bin/env node
// Creates the agent's tip wallet: a new private key written straight into .env as
// TIP_WALLET_PRIVATE_KEY (never printed), and its address printed. When the key is already set,
// prints its address and changes nothing.
//
// Usage: npm run tip-wallet
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const KEY = 'TIP_WALLET_PRIVATE_KEY';
const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
const line = new RegExp(`^${KEY}=(.*)$`, 'm');

const text = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
const existing = text.match(line)?.[1].replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '');

if (existing) {
  try {
    const { address } = privateKeyToAccount(existing.startsWith('0x') ? existing : `0x${existing}`);
    console.log(`${KEY} is already set in .env; nothing changed.\nTip wallet address: ${address}`);
    process.exit(0);
  } catch {
    console.error(`${KEY} in .env is not a valid private key. Fix or remove that line, then run this again.`);
    process.exit(1);
  }
}

const key = generatePrivateKey();
const { address } = privateKeyToAccount(key);
const entry = `${KEY}=${key}`;
const updated = line.test(text)
  ? text.replace(line, () => entry)
  : `${text}${text && !text.endsWith('\n') ? '\n' : ''}\n# Tip wallet (npm run tip-wallet). Back this key up; never share it.\n${entry}\n`;
fs.writeFileSync(envPath, updated, { mode: 0o600 });
// Also tighten an existing file, which writeFileSync's mode does not change
fs.chmodSync(envPath, 0o600);

console.log(`Created a tip wallet: ${address}
The private key was written to .env as ${KEY} (not shown here).
- Back it up somewhere safe, such as a password manager: without it, tokens sent to this address cannot be moved.
- Move tips to your main wallet now and then; keep only small amounts here.
- Restart the agent to start receiving tips.`);
