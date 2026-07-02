import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.pure';
import type { PrimNode, Vec3 } from './types';

export function fileSafe(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'scene';
}

// Generate a friendly default scene name: "<Adjective> <Animal> <Noun>".
const SCENE_NAME_ADJECTIVES = [
  'Brave', 'Bright', 'Calm', 'Cheerful', 'Clever', 'Cosmic', 'Curious',
  'Daring', 'Eager', 'Electric', 'Fancy', 'Fearless', 'Fierce', 'Frosty',
  'Gentle', 'Glowing', 'Golden', 'Happy', 'Jolly', 'Lively', 'Lucky',
  'Mighty', 'Mystic', 'Noble', 'Plucky', 'Quiet', 'Quirky', 'Radiant',
  'Rapid', 'Rustic', 'Shimmering', 'Silent', 'Silly', 'Sleepy', 'Sly',
  'Snazzy', 'Sparkling', 'Speedy', 'Spry', 'Sturdy', 'Sunny', 'Swift',
  'Tame', 'Tiny', 'Vivid', 'Wandering', 'Wild', 'Wise', 'Zany', 'Zesty'
];
const SCENE_NAME_ANIMALS = [
  'Antelope', 'Badger', 'Bear', 'Beaver', 'Bison', 'Buffalo', 'Camel',
  'Caribou', 'Cheetah', 'Coyote', 'Crane', 'Dolphin', 'Eagle', 'Elephant',
  'Elk', 'Falcon', 'Ferret', 'Finch', 'Fox', 'Gazelle', 'Gecko', 'Giraffe',
  'Goose', 'Hare', 'Hawk', 'Heron', 'Hippo', 'Horse', 'Hyena', 'Ibis',
  'Iguana', 'Jaguar', 'Koala', 'Lemur', 'Leopard', 'Lion', 'Lynx', 'Mongoose',
  'Moose', 'Narwhal', 'Ocelot', 'Octopus', 'Orca', 'Otter', 'Owl', 'Panda',
  'Panther', 'Penguin', 'Platypus', 'Puffin', 'Quokka', 'Rabbit', 'Raccoon',
  'Raven', 'Reindeer', 'Rhino', 'Salamander', 'Seal', 'Shark', 'Sloth',
  'Squirrel', 'Stingray', 'Stork', 'Swan', 'Tapir', 'Tiger', 'Toucan',
  'Turtle', 'Walrus', 'Weasel', 'Whale', 'Wolf', 'Wolverine', 'Wombat',
  'Yak', 'Zebra'
];
export function randomSceneName(): string {
  const adj = SCENE_NAME_ADJECTIVES[Math.floor(Math.random() * SCENE_NAME_ADJECTIVES.length)];
  const animal = SCENE_NAME_ANIMALS[Math.floor(Math.random() * SCENE_NAME_ANIMALS.length)];
  return `${adj} ${animal}`;
}

// Compute the next free `<base>_<n>` name for a duplicated prim. If the source
// name already ends in `_<n>`, the base is the leading part and we hunt for
// the next free n. Otherwise n starts at 1.
export function nextDuplicateName(name: string, taken: Set<string>): string {
  const m = /^(.*)_(\d+)$/.exec(name);
  const base = m ? m[1] : name;
  let n = m ? Number(m[2]) + 1 : 1;
  let candidate = `${base}_${n}`;
  while (taken.has(candidate)) {
    n += 1;
    candidate = `${base}_${n}`;
  }
  return candidate;
}

export function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  // Fallback for older runtimes; not crypto-strong but unique enough.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function isDescendant(
  prims: PrimNode[],
  ancestorId: string,
  candidateId: string
): boolean {
  let cur: PrimNode | undefined = prims.find((p) => p.id === candidateId);
  while (cur) {
    if (cur.id === ancestorId) return true;
    if (!cur.parentId) return false;
    const nextId: string = cur.parentId;
    cur = prims.find((p) => p.id === nextId);
  }
  return false;
}

// World matrix for a prim by composing local TRS up the parent chain.
export function getWorldMatrix(prims: PrimNode[], id: string): Matrix {
  const chain: PrimNode[] = [];
  let cur: PrimNode | undefined = prims.find((p) => p.id === id);
  while (cur) {
    chain.unshift(cur);
    if (!cur.parentId) break;
    const nextId: string = cur.parentId;
    cur = prims.find((p) => p.id === nextId);
  }
  let m = Matrix.Identity();
  for (const p of chain) {
    m = localMatrix(p).multiply(m);
  }
  return m;
}

export function localMatrix(p: PrimNode): Matrix {
  const q = Quaternion.FromEulerAngles(
    p.rotation[0],
    p.rotation[1],
    p.rotation[2]
  );
  return Matrix.Compose(
    new Vector3(p.scale[0], p.scale[1], p.scale[2]),
    q,
    new Vector3(p.position[0], p.position[1], p.position[2])
  );
}

export function invertMatrix(m: Matrix): Matrix {
  const inv = new Matrix();
  m.invertToRef(inv);
  return inv;
}

export function decomposeMatrix(m: Matrix): {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
} {
  const s = new Vector3();
  const q = new Quaternion();
  const t = new Vector3();
  m.decompose(s, q, t);
  const e = q.toEulerAngles();
  return {
    position: [t.x, t.y, t.z],
    rotation: [e.x, e.y, e.z],
    scale: [s.x, s.y, s.z]
  };
}
