/*
 * SYNTHETIC: plausible answers of the scene-edit planner, written by hand from the planning
 * prompt's own examples (actions/build.ts) and from the plans the existing tests use. They are not
 * recordings of a model. What they pin down: the plan schema (lib/edit-plan.ts) takes every
 * operation that the action ran before the schema existed.
 */

export interface PlanFixture {
  name: string;
  /** What the planner returned, as parsed JSON */
  plan: { operations: unknown[] };
  /** For each entry: the operation it must be read as, or 'declined' */
  expected: string[];
}

export const SYNTHETIC_EDIT_PLANS: PlanFixture[] = [
  {
    name: "the prompt's own final example",
    plan: {
      operations: [
        { success: true, operation: 'import', target: 'https://assets.hyperfy.io/sculpture.glb', parameters: { position: [0, 1, 0], rotation: [0, 0, 0, 1] }, description: 'Imported a new sculpture facing the plaza' },
        { success: true, operation: 'duplicate', target: 'qr66FaMVIj', parameters: {}, description: 'Duplicated block' },
        { success: true, operation: 'translate', target: 'w9IsHHksuo', parameters: { position: [0, 2, 0] }, description: 'Moved block upward' },
        { success: false, operation: 'delete', requestedEntityName: 'floating dragon', reason: "No entity with name 'floating dragon' found in world state" },
      ],
    },
    expected: ['import', 'duplicate', 'translate', 'declined'],
  },
  {
    name: "the prompt's single-operation examples",
    plan: {
      operations: [
        { success: true, operation: 'translate', target: 'VLvCb3w5G2', parameters: { position: [4.17, 10.0, -14.33] }, description: 'Moved Seat App 10 meters upward' },
        { success: false, operation: 'delete', requestedEntityName: 'stone throne', reason: "No entity with name 'stone throne' found in world state" },
      ],
    },
    expected: ['translate', 'declined'],
  },
  {
    name: 'every operation once, as the tests plan them',
    plan: {
      operations: [
        { success: true, operation: 'translate', target: 'box', parameters: { position: [0, 2, 0] }, description: 'Moved the box up' },
        { success: true, operation: 'rotate', target: 'box', parameters: { rotation: [0, 0.7071, 0, 0.7071] }, description: 'Turned the box a quarter turn' },
        { success: true, operation: 'scale', target: 'box', parameters: { scale: [2, 2, 2] }, description: 'Doubled the box' },
        { success: true, operation: 'duplicate', target: 'box', description: 'Made another box' },
        { success: true, operation: 'delete', target: 'box', description: 'Removed the box' },
        { success: true, operation: 'import', target: 'https://cdn.example.com/models/lamp.glb', parameters: {}, description: 'Imported it' },
      ],
    },
    expected: ['translate', 'rotate', 'scale', 'duplicate', 'delete', 'import'],
  },
  {
    name: 'what a model leaves out or adds: no success flag, no description, null or missing import parameters, integers, extra keys',
    plan: {
      operations: [
        { operation: 'translate', target: 'VLvCb3w5G2', parameters: { position: [1, 0, -3] } },
        { success: true, operation: 'import', target: 'asset://3f2a9c.glb' },
        { success: true, operation: 'import', target: 'https://cdn.example.com/a.hyp', parameters: { position: [2, 0, 2], rotation: null } },
        { success: true, operation: 'import', target: 'https://cdn.example.com/a.vrm', parameters: null, description: 'Imported the avatar' },
        { success: true, operation: 'delete', target: 'w9IsHHksuo', parameters: {}, description: 'Deleted the cube', confidence: 0.9, notes: ['asked twice'] },
        { success: true, operation: 'scale', target: 'w9IsHHksuo', parameters: { scale: [0.5, 0.5, 0.5], uniform: true }, description: 42 },
      ],
    },
    expected: ['translate', 'import', 'import', 'import', 'delete', 'scale'],
  },
  {
    name: 'a copy named in the plan and moved by a later entry',
    plan: {
      operations: [
        { success: true, operation: 'duplicate', target: 'qr66FaMVIj', as: 'copy1', description: 'Duplicated the block' },
        { success: true, operation: 'translate', targetRef: 'copy1', parameters: { position: [0, 3, 0] }, description: 'Put the copy on top of the water' },
      ],
    },
    expected: ['duplicate', 'translate'],
  },
];
