// No type declarations are installed for these packages. The base tsconfig treats everything
// imported from them as `any`; the strict config needs that said. For three, each member this
// project's TypeScript names is listed (a value and, where it is used as one, a type), all `any`.
declare module 'lodash-es';

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
