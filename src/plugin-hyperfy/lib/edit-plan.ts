import { z } from 'zod';

/**
 * What the scene-edit planner (a model) may ask for, as data: each entry of its plan is read here
 * before anything is done with it. An entry is an operation only when it has that operation's
 * shape; what the plan says about itself (`success`, `description`) decides nothing about that.
 * The build manager checks the values again against what the world accepts
 * (managers/build-manager.ts acceptedTransform), and every effect against the requester's right.
 */

/** How many entries of one plan are run; the rest are reported as not run. */
export const MAX_OPERATIONS_PER_REQUEST = 20;

/** A name a plan gives a copy it makes (`as`), for later entries of the same plan (`targetRef`). */
const REFERENCE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const TARGET_MAX_LENGTH = 2048;

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const quat = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const target = z.string().min(1).max(TARGET_MAX_LENGTH);
const reference = z.string().regex(REFERENCE);
// Free text: anything that is not a string is left out, not a reason to refuse the entry
const description = z.string().optional().catch(undefined);
/** An entity that is in the world (`target`: its id), or a copy made earlier in this plan (`targetRef`). */
const onEntity = { target: target.optional(), targetRef: reference.optional(), description };

const operation = z
  .discriminatedUnion('operation', [
    z.object({ operation: z.literal('duplicate'), ...onEntity, as: reference.optional() }),
    z.object({ operation: z.literal('delete'), ...onEntity }),
    z.object({ operation: z.literal('translate'), ...onEntity, parameters: z.object({ position: vec3 }) }),
    z.object({ operation: z.literal('rotate'), ...onEntity, parameters: z.object({ rotation: quat }) }),
    z.object({ operation: z.literal('scale'), ...onEntity, parameters: z.object({ scale: vec3 }) }),
    z.object({
      operation: z.literal('import'),
      // A URL; which ones may be imported is the build manager's and the network policy's to say
      target,
      // Left out: the origin, facing forward
      parameters: z.object({ position: vec3.nullish(), rotation: quat.nullish() }).nullish(),
      description,
    }),
  ])
  .superRefine((op, ctx) => {
    if (op.operation === 'import') return;
    const named = Number(op.target !== undefined) + Number(op.targetRef !== undefined);
    if (named !== 1) ctx.addIssue({ code: 'custom', path: ['target'], message: 'exactly one of "target" and "targetRef" is needed' });
  });

export type EditOperation = z.infer<typeof operation>;
export type EditOperationName = EditOperation['operation'];

/**
 * One entry of a plan:
 *  - an operation to run;
 *  - `declined`: the plan itself says it cannot be done (`"success": false`, with its reason): it
 *    is never run, whatever else the entry holds;
 *  - `invalid`: not an operation this action knows, or not in its shape.
 */
export type PlanEntry =
  | { kind: 'operation'; op: EditOperation }
  | { kind: 'declined'; reason?: string }
  | { kind: 'invalid'; problem: string };

const PROBLEM_MAX_LENGTH = 160;

export function readPlanEntry(entry: unknown): PlanEntry {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { kind: 'invalid', problem: 'not an operation object' };
  const raw = entry as Record<string, unknown>;
  // Only ever a reason to do less
  if (raw.success === false) return { kind: 'declined', reason: typeof raw.reason === 'string' ? raw.reason : undefined };
  const parsed = operation.safeParse(raw);
  if (parsed.success) return { kind: 'operation', op: parsed.data };
  const [issue] = parsed.error.issues;
  if (issue.path.length === 1 && issue.path[0] === 'operation') return { kind: 'invalid', problem: 'unsupported operation type' };
  const where = issue.path.map(String).join('.');
  return { kind: 'invalid', problem: `invalid operation (${where ? `${where}: ` : ''}${issue.message})`.slice(0, PROBLEM_MAX_LENGTH) };
}

/**
 * Why a plan's copy labels do not hold together, or null. Checked before anything of the plan is
 * run: a label (`as`) is given to one copy only, and a `targetRef` names a label an earlier entry of
 * the plan gives. Only entries that are operations count (an entry that is not one gives no label).
 */
export function planLabelProblem(entries: readonly unknown[]): string | null {
  const labels = new Set<string>();
  for (const entry of entries) {
    const read = readPlanEntry(entry);
    if (read.kind !== 'operation') continue;
    const op = read.op;
    if (op.operation !== 'import' && op.targetRef !== undefined && !labels.has(op.targetRef)) return `"${op.targetRef}" names no copy an earlier step makes`;
    if (op.operation === 'duplicate' && op.as !== undefined) {
      if (labels.has(op.as)) return `two copies are named "${op.as}"`;
      labels.add(op.as);
    }
  }
  return null;
}
