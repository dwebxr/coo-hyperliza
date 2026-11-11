import type { MoveOutcome } from '../systems/controls';

/** What the agent says of a walk that did not end where it was sent (systems/controls.ts MoveOutcome). */
const NOT_ARRIVED: Record<Exclude<MoveOutcome, 'arrived'>, string> = {
  stopped: 'I stopped before I got there.',
  replaced: 'I headed somewhere else before I got there.',
  cancelled: 'I stopped before I got there.',
  'timed-out': "I couldn't get there in time.",
  unreachable: "I can't find where to go.",
};

export function notArrivedText(outcome: Exclude<MoveOutcome, 'arrived'>): string {
  return NOT_ARRIVED[outcome];
}
