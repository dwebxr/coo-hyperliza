// No type declarations are installed for these packages, so they are declared here. For three,
// each member this project's TypeScript names is listed (a value and, where it is used as one, a
// type), all `any`.
declare module 'lodash-es';

// Its package exports name declaration files it does not ship (types/index.d.ts; dist/node/index.d.ts
// re-exports a module without one). The two members this project's tests use:
declare module '@elizaos/plugin-sql' {
  export const plugin: import('@elizaos/core').Plugin;
  export function createDatabaseAdapter(
    config: { dataDir?: string; postgresUrl?: string },
    agentId: import('@elizaos/core').UUID
  ): import('@elizaos/core').IDatabaseAdapter;
}

declare module 'three' {
  export const Vector3: any;
  export type Vector3 = any;
  export const Quaternion: any;
  export type Quaternion = any;
  export const Euler: any;
  export type Euler = any;
  export const Matrix4: any;
  export type Matrix4 = any;
  export const Object3D: any;
  export type Object3D = any;
  export const Mesh: any;
  export type Mesh = any;
  export const BufferGeometry: any;
  export const SphereGeometry: any;
  export const MeshBasicMaterial: any;
  export const Fog: any;
  export const Color: any;
  export const BackSide: any;
}
