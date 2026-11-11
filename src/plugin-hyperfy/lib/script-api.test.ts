import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GEOMETRY_SETTERS, NODE_ARGUMENTS, NODE_SETTERS, WORLD_NODE_METHODS } from './script-api';

// The guards in script-api.ts are tested through the real engine in script-sandbox.child.test.ts.
// This file keeps their lists complete: it reads the engine's sources (a third-party submodule
// that can change under the agent) for every member that turns a value into a node or geometry.

const core = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../hyperfy/src/core');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) return sources(file);
    return name.endsWith('.js') ? [file] : [];
  });
}

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function']);
// `name(args) {`, `get name(args) {`, `set name(args) {`, or `export function name(args) {`
const MEMBER = /^\s*(?:(?:export\s+)?function\s+([A-Za-z_$][\w$]*)|(?:(get|set)\s+)?([A-Za-z_$][\w$]*))\s*\([^)]*\)\s*\{\s*$/;

/**
 * "file:member" for every line that calls getRef(value) (nodes/Node.js) or reads `value._ref`
 * itself (nodes/Joint.js does), named after the member it is in
 */
function referenceReaders(): string[] {
  const found = new Set<string>();
  for (const file of sources(core)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      const code = line.replace(/\/\/.*$/, '');
      if (!/\bgetRef\(\s*[^)\s]/.test(code) && !/\._ref\b/.test(code)) return;
      for (let i = index; i >= 0; i--) {
        const match = MEMBER.exec(lines[i]);
        if (!match) continue;
        const name = match[1] ? `function ${match[1]}` : `${match[2] ? `${match[2]} ` : ''}${match[3]}`;
        if (KEYWORDS.has(match[3] ?? '')) continue;
        found.add(`${path.relative(core, file)}:${name}`);
        return;
      }
      found.add(`${path.relative(core, file)}:<no member found at line ${index + 1}>`);
    });
  }
  return [...found].sort();
}

describe('the node and geometry guards of the script API', () => {
  it('cover every engine member that turns a value into a node or geometry', () => {
    const readers = referenceReaders();

    // If this list changes, the engine has a new way for a script's value to become a node:
    // give it a guard in script-api.ts (NODE_ARGUMENTS, NODE_SETTERS, GEOMETRY_SETTERS,
    // WORLD_NODE_METHODS) and a forged-reference case in test-support/sandbox/hostile-hooks.js
    expect(readers).toEqual([
      'nodes/Collider.js:set geometry',
      'nodes/Joint.js:set body0',
      'nodes/Joint.js:set body1',
      'nodes/LOD.js:insert',
      'nodes/Node.js:add',
      'nodes/Node.js:function getRef',
      'nodes/Node.js:remove',
      'nodes/Video.js:set geometry',
      'systems/Apps.js:add',
      'systems/Apps.js:attach',
      'systems/Apps.js:remove',
    ]);
    for (const reader of readers) {
      const [file, member] = reader.split(':');
      if (member === 'function getRef') continue; // the definition itself
      const covered = file.startsWith('systems/Apps.js')
        ? WORLD_NODE_METHODS.has(member)
        : member.startsWith('set ')
          ? NODE_SETTERS.has(member.slice(4)) || GEOMETRY_SETTERS.has(member.slice(4))
          : NODE_ARGUMENTS.has(member);
      expect(covered, reader).toBe(true);
    }
  });
});
