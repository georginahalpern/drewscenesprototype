import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Matrix } from '@babylonjs/core/Maths/math.vector.pure';
import BottomPanel from './components/BottomPanel';
import ContextMenu, {
  type ContextMenuItem
} from './components/ContextMenu';
import ConditionsPanel from './components/ConditionsPanel';
import EntityModelsPanel, {
  HIDDEN_ENTITY_TYPE_NAMES
} from './components/EntityModelsPanel';
import HierarchyPanel from './components/HierarchyPanel';
import LeftToolbar from './components/LeftToolbar';
import OntologyPanel from './components/OntologyPanel';
import PropertiesPanel from './components/PropertiesPanel';
import TopBar, { type AppMode, type Theme } from './components/TopBar';
import Viewport from './components/Viewport';
import { ASSET_LIBRARY, getAsset } from './assets';
import { createCondition, type Condition } from './conditions';
import {
  addEntityInstance,
  addEntityType,
  addEntityTypeParent,
  applyBindingsToOntology,
  attachUsdToInstance,
  buildModelTree,
  buildOntology,
  DEFAULT_ENTITY_TYPE,
  duplicateEntityInstance,
  ensureHasUsdEdges,
  loadHospitalOntologyDoc,
  moveEntityType,
  removeModelRelationship,
  removeEntityInstance,
  removeEntityType,
  removeEntityTypeParent,
  renameEntityInstance,
  renameEntityType,
  setEntityInstanceParent,
  setEntityTypeParent,
  updateEntityInstance,
  updateEntityType,
  upsertModelRelationship,
  type OntologyDoc,
  type OntologyEntity,
  type OntologyEntityType,
  type OntologyRelationship,
  type SpatialBinding
} from './ontology';
import { parseUsda } from './usd';
import {
  KIND_LABELS,
  SPAWN_HALF_HEIGHT,
  DEFAULT_COLOR,
  SHAPE_USDA
} from './sceneConstants';
import {
  decomposeMatrix,
  fileSafe,
  getWorldMatrix,
  invertMatrix,
  isDescendant,
  newId,
  nextDuplicateName,
  randomSceneName
} from './sceneUtils';
import type {
  AssetMeshNode,
  PrimNode,
  PrimPatch,
  PrimTransform,
  ShapeKind,
  SubMeshInfo,
  ToolMode,
  Vec3
} from './types';

/** Cheap structural check used by the scene import path to tell an ontology
 *  doc from the legacy combined envelope (`{ Scene, Ontology }`). */
function looksLikeOntologyDoc(value: unknown): value is OntologyDoc {
  if (!value || typeof value !== 'object') return false;
  const instances = (value as { instances?: unknown }).instances;
  if (!instances || typeof instances !== 'object') return false;
  return (
    Array.isArray((instances as { entities?: unknown }).entities) &&
    Array.isArray((instances as { relationships?: unknown }).relationships)
  );
}

export default function App() {
  const [inspectorSelection, setInspectorSelection] = useState<
    | { kind: 'model-type'; name: string }
    | { kind: 'model-relationship'; index: number }
    | null
  >(null);
  // Currently selected ontology entity instance. When set, the Properties
  // panel shows the instance form (takes priority over prim selection).
  // Cleared whenever the user picks something else (prim, model type, etc.).
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  // Scene Editor mode: list of authored conditions and the currently-edited
  // one. Selection is mutually exclusive with prim/instance/model-type
  // selection — the Properties panel routes a non-null `selectedConditionId`
  // to the ConditionForm before anything else.
  const [conditions, setConditions] = useState<Condition[]>([]);
  const [selectedConditionId, setSelectedConditionId] = useState<string | null>(null);
    const [prims, setPrims] = useState<PrimNode[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Additional prim ids selected on top of `selectedId` via Ctrl+click. The
  // "primary" selection (gizmo target, Properties form) stays on
  // `selectedId`; these are the secondary highlights that get carried along
  // when the position gizmo is dragged. Always disjoint from `selectedId`.
  const [additionalSelectedIds, setAdditionalSelectedIds] = useState<string[]>(
    []
  );
  // Identifies a specific sub-mesh inside a loaded reference asset when the
  // user clicks one (in the viewport or hierarchy). Null when the selection
  // is the whole prim. Always cleared when `selectedId` flips to a different
  // prim or to null.
  const [selectedMeshUid, setSelectedMeshUid] = useState<string | null>(null);
  // Per-reference-prim cache of the internal node/mesh tree from the loaded
  // GLB/OBJ. Populated by the Viewport once each asset finishes loading.
  const [assetMeshes, setAssetMeshes] = useState<Record<string, AssetMeshNode[]>>({});
  // Pose/name of the currently selected sub-mesh inside a loaded asset, so
  // the Properties panel can display it. Null when the selection is a
  // top-level prim or nothing.
  const [subMeshInfo, setSubMeshInfo] = useState<SubMeshInfo | null>(null);
  const [tool, setTool] = useState<ToolMode>('move');
  // Grid snapping is on by default; the snap button in the LeftToolbar
  // toggles it. When off, gizmo drags move/rotate/scale continuously.
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [sceneName, setSceneName] = useState<string>(() => randomSceneName());
  const [theme, setTheme] = useState<Theme>(() => {
    const saved =
      typeof window !== 'undefined'
        ? window.localStorage.getItem('drewscenes:theme')
        : null;
    return saved === 'dark' ? 'dark' : 'light';
  });
  // Top-level workspace mode. Ontology Editor is the default; Scene Editor /
  // Scene Viewer switch the left-rail layout (Conditions panel appears in
  // Scene Editor mode) without touching the underlying ontology state.
  const [mode, setMode] = useState<AppMode>('ontology');
  // Scene (formerly Hierarchy) slide-out is hidden by default and toggled
  // from the topbar.
  const [sceneOpen, setSceneOpen] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem('drewscenes:theme', theme);
    } catch {
      // localStorage may be unavailable (private mode, etc.); not fatal.
    }
  }, [theme]);

  const countersRef = useRef<Record<ShapeKind, number>>({
    box: 0,
    cylinder: 0,
    sphere: 0,
    plane: 0,
    cone: 0,
    group: 0,
    reference: 0
  });

  const handleShapeDropped = useCallback(
    (kind: ShapeKind, position: Vec3) => {
      const n = (countersRef.current[kind] ?? 0) + 1;
      countersRef.current[kind] = n;
      const name = `${KIND_LABELS[kind]}_${n}`;
      const halfH = SPAWN_HALF_HEIGHT[kind];
      const prim: PrimNode = {
        id: newId(),
        name,
        kind,
        position: [position[0], position[1] + halfH, position[2]],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        parentId: null,
        color: DEFAULT_COLOR
      };
      setPrims((prev) => [...prev, prim]);
      setSelectedId(prim.id);
    },
    []
  );

  // Spawn a new prim parented to the given hierarchy node (null = scene root).
  // The local position is at the parent's origin lifted by the shape's half-height
  // so the new prim isn't co-located with the parent's pivot.
  const handleShapeAddToParent = useCallback(
    (kind: ShapeKind, parentId: string | null) => {
      const n = (countersRef.current[kind] ?? 0) + 1;
      countersRef.current[kind] = n;
      const name = `${KIND_LABELS[kind]}_${n}`;
      const halfH = SPAWN_HALF_HEIGHT[kind];
      const prim: PrimNode = {
        id: newId(),
        name,
        kind,
        position: parentId === null ? [0, halfH, 0] : [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        parentId,
        color: DEFAULT_COLOR
      };
      setPrims((prev) => [...prev, prim]);
      setSelectedId(prim.id);
    },
    []
  );

  const handleTransform = useCallback(
    (id: string, t: Partial<PrimTransform>) => {
      setPrims((prev) => prev.map((p) => (p.id === id ? { ...p, ...t } : p)));
    },
    []
  );

  // Batch transform writer used by the position gizmo when a group of prims
  // is being moved together. One setPrims pass keeps the viewport scene
  // re-render to a single commit instead of N.
  const handleTransformMany = useCallback(
    (updates: Array<{ id: string; t: Partial<PrimTransform> }>) => {
      if (updates.length === 0) return;
      const byId = new Map(updates.map((u) => [u.id, u.t] as const));
      setPrims((prev) =>
        prev.map((p) => {
          const t = byId.get(p.id);
          return t ? { ...p, ...t } : p;
        })
      );
    },
    []
  );

  const handleUpdate = useCallback((id: string, patch: PrimPatch) => {
    setPrims((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }, []);

  const handleReparent = useCallback(
    (sourceId: string, parentId: string | null) => {
      setPrims((prev) => {
        if (parentId === sourceId) return prev;
        const source = prev.find((p) => p.id === sourceId);
        if (!source) return prev;
        if (source.parentId === parentId) return prev;
        if (parentId !== null && isDescendant(prev, sourceId, parentId)) {
          return prev;
        }
        // Preserve world transform across the reparent so the user's drag
        // doesn't visually teleport the shape.
        const worldM = getWorldMatrix(prev, sourceId);
        const newParentWorldM =
          parentId === null
            ? Matrix.Identity()
            : getWorldMatrix(prev, parentId);
        const newLocal = worldM.multiply(invertMatrix(newParentWorldM));
        const { position, rotation, scale } = decomposeMatrix(newLocal);
        return prev.map((p) =>
          p.id === sourceId
            ? { ...p, parentId, position, rotation, scale }
            : p
        );
      });
    },
    []
  );

  // Delete one or more prims and every descendant under each. Batched into
  // a single setPrims pass so multi-selection delete shows up in one render.
  const handleDeleteMany = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setPrims((prev) => {
      const doomed = new Set<string>(ids);
      let grew = true;
      while (grew) {
        grew = false;
        for (const p of prev) {
          if (p.parentId && doomed.has(p.parentId) && !doomed.has(p.id)) {
            doomed.add(p.id);
            grew = true;
          }
        }
      }
      setAssetMeshes((cur) => {
        let next = cur;
        for (const did of doomed) {
          if (did in next) {
            if (next === cur) next = { ...cur };
            delete next[did];
          }
        }
        return next;
      });
      // Drop any ontology binding whose target prim (or an ancestor of it)
      // is being deleted, so SpatialItems don't keep a stale USD / guid.
      setBindings((cur) => {
        let next = cur;
        for (const [eid, b] of Object.entries(cur)) {
          if (doomed.has(b.guid)) {
            if (next === cur) next = { ...cur };
            delete next[eid];
          }
        }
        return next;
      });
      return prev.filter((p) => !doomed.has(p.id));
    });
    const doomedSet = new Set(ids);
    setSelectedId((cur) => (cur && doomedSet.has(cur) ? null : cur));
    setAdditionalSelectedIds((cur) => cur.filter((x) => !doomedSet.has(x)));
    setSelectedMeshUid((cur) =>
      selectedId && doomedSet.has(selectedId) ? null : cur
    );
  }, [selectedId]);

  const handleDelete = useCallback(
    (id: string) => handleDeleteMany([id]),
    [handleDeleteMany]
  );

  // Duplicate one or more prims and every descendant under each. Roots in
  // `ids` whose ancestor is also in `ids` are skipped so descendants don't
  // get cloned twice. Each cloned root's name gets the next available
  // `_<n>` suffix; descendants keep their original names unless taken.
  const handleDuplicateMany = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      const byId = new Map(prims.map((p) => [p.id, p] as const));
      const set = new Set(ids);
      // Filter to independent roots so a selected parent + selected child
      // doesn't duplicate the child twice.
      const independent = ids.filter((id) => {
        let cur = byId.get(id);
        let pid = cur?.parentId ?? null;
        while (pid) {
          if (set.has(pid)) return false;
          cur = byId.get(pid);
          pid = cur?.parentId ?? null;
        }
        return true;
      });
      if (independent.length === 0) return;
      const order: PrimNode[] = [];
      const idMap = new Map<string, string>();
      const rootSet = new Set(independent);
      const visit = (pid: string) => {
        if (idMap.has(pid)) return;
        const p = byId.get(pid);
        if (!p) return;
        order.push(p);
        idMap.set(pid, newId());
        for (const child of prims) {
          if (child.parentId === pid) visit(child.id);
        }
      };
      for (const rid of independent) visit(rid);
      const existingNames = new Set(prims.map((p) => p.name));
      const clones: PrimNode[] = order.map((p) => {
        const cloneName = rootSet.has(p.id)
          ? nextDuplicateName(p.name, existingNames)
          : p.name;
        if (rootSet.has(p.id)) existingNames.add(cloneName);
        return {
          ...p,
          id: idMap.get(p.id)!,
          name: cloneName,
          parentId: rootSet.has(p.id)
            ? p.parentId
            : idMap.get(p.parentId ?? '') ?? p.parentId,
          position: [...p.position],
          rotation: [...p.rotation],
          scale: [...p.scale]
        };
      });
      setPrims((prev) => [...prev, ...clones]);
      const newRootIds = independent.map((id) => idMap.get(id)!);
      const primary = newRootIds[newRootIds.length - 1] ?? null;
      setSelectedId(primary);
      setAdditionalSelectedIds(primary ? newRootIds.slice(0, -1) : []);
      setSelectedMeshUid(null);
      // Clear any lingering ontology-instance selection so the previous
      // multi-selection in the ontology tree doesn't keep highlighting.
      setSelectedInstanceId(null);
      setInspectorSelection(null);
    },
    [prims]
  );

  const handleSelect = useCallback(
    (
      id: string | null,
      meshUid: string | null = null,
      additive: boolean = false
    ) => {
      // Ctrl/Cmd+click toggles a prim's membership in the multi-selection
      // without disturbing the rest. Sub-mesh selection only makes sense
      // for a single prim, so it's force-cleared in additive mode.
      if (additive && id) {
        // Compute the next selection synchronously from the latest closure
        // state. The previous version used nested setState updaters and
        // read `nextPrimary` before the inner updater ran, silently
        // dropping the primary on every Ctrl+click.
        const all = selectedId
          ? [selectedId, ...additionalSelectedIds]
          : additionalSelectedIds;
        let nextPrimary: string | null;
        let nextAdditional: string[];
        if (all.includes(id)) {
          // Remove: keep the rest, promote the most-recent survivor.
          const remaining = all.filter((x) => x !== id);
          nextPrimary = remaining[remaining.length - 1] ?? null;
          nextAdditional = remaining.slice(0, -1);
        } else {
          // Add: clicked id becomes the new primary, old primary drops
          // into the additional set so the gizmo follows the latest pick.
          nextPrimary = id;
          nextAdditional = all;
        }
        setInspectorSelection(null);
        setSelectedInstanceId(null);
        setSelectedConditionId(null);
        setSelectedMeshUid(null);
        setSelectedId(nextPrimary);
        setAdditionalSelectedIds(nextAdditional);
        return;
      }
      setInspectorSelection(null);
      setSelectedInstanceId(null);
      setSelectedConditionId(null);
      setAdditionalSelectedIds([]);
      setSelectedId(id);
      setSelectedMeshUid(id ? meshUid : null);
    },
    [selectedId, additionalSelectedIds]
  );

  // Viewport picks select the top-level prim of the clicked **asset**:
  // walk up the parent chain (inclusive of self) until we find a prim with
  // `assetId` set, and select that. Two cases this handles:
  //   - Reference assets like HospitalBed: every loaded sub-mesh already
  //     carries the bed prim's `primId`, so the walk stops at the bed.
  //   - USDA-decomposed assets like Room: the asset spawns as a group prim
  //     (with `assetId`) containing many child box prims for walls/floor.
  //     The picked wall has no `assetId`, so we walk up to the Room group.
  // If no ancestor has `assetId` (e.g. a plain Box prim dropped from the
  // shapes palette), we just select the picked prim itself. `meshUid` is
  // always dropped — clicks never select individual asset sub-meshes.
  const handleViewportSelect = useCallback(
    (
      id: string | null,
      _meshUid: string | null = null,
      additive: boolean = false
    ) => {
      if (!id) {
        handleSelect(null, null, additive);
        return;
      }
      const byId = new Map(prims.map((p) => [p.id, p] as const));
      let cur = byId.get(id);
      if (!cur) {
        handleSelect(null, null, additive);
        return;
      }
      let topAsset: PrimNode | null = null;
      let walker: PrimNode | undefined = cur;
      while (walker) {
        if (walker.assetId) {
          topAsset = walker;
          break;
        }
        if (!walker.parentId) break;
        walker = byId.get(walker.parentId);
      }
      handleSelect((topAsset ?? cur).id, null, additive);
    },
    [prims, handleSelect]
  );

  // Union of `selectedId` and `additionalSelectedIds`, in the order the
  // gizmo/outliner cares about: primary last so callers can take the tail
  // as "the focus" when they need to pick one. Memoized to keep stable
  // references for downstream useEffects.
  const selectedIds = useMemo(
    () =>
      selectedId
        ? [...additionalSelectedIds, selectedId]
        : additionalSelectedIds,
    [selectedId, additionalSelectedIds]
  );

  const handleAssetMeshesLoaded = useCallback(
    (primId: string, nodes: AssetMeshNode[]) => {
      setAssetMeshes((cur) => {
        const had = primId in cur;
        if (nodes.length === 0) {
          if (!had) return cur;
          const next = { ...cur };
          delete next[primId];
          return next;
        }
        return { ...cur, [primId]: nodes };
      });
    },
    []
  );

  const selectedPrim =
    selectedId ? prims.find((p) => p.id === selectedId) ?? null : null;

  // Ontology data + per-entity bindings live here so the Hierarchy and
  // Properties panels can show "is mapped" indicators next to the asset prim.
  // The doc is the source of truth (the runtime tree is derived); replacing
  // it via import swaps the entire ontology in one shot.
  const [ontologyDoc, setOntologyDoc] = useState<OntologyDoc>(() =>
    loadHospitalOntologyDoc()
  );
  const ontology = useMemo(() => buildOntology(ontologyDoc), [ontologyDoc]);
  const modelRoots = useMemo(() => buildModelTree(ontologyDoc), [ontologyDoc]);
  const modelRelationships = useMemo(
    () => ontologyDoc.model?.relationships ?? [],
    [ontologyDoc]
  );
  // Live count of entity instances per type name, keyed by `entity.type`.
  // Rendered as a small badge on the right of each Entity Models row;
  // recomputed whenever the ontology doc changes so adding / removing /
  // duplicating instances keeps the panel in sync automatically.
  const instanceCountByType = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of ontologyDoc.instances.entities) {
      m.set(e.type, (m.get(e.type) ?? 0) + 1);
    }
    return m;
  }, [ontologyDoc]);
  const selectedModelType: OntologyEntityType | null = useMemo(() => {
    if (inspectorSelection?.kind !== 'model-type') return null;
    return (
      ontologyDoc.model?.entityTypes.find(
        (t) => t.name === inspectorSelection.name
      ) ?? null
    );
  }, [inspectorSelection, ontologyDoc]);
  const selectedCondition: Condition | null = useMemo(
    () => conditions.find((b) => b.id === selectedConditionId) ?? null,
    [conditions, selectedConditionId]
  );
  const selectedModelRelationship: OntologyRelationship | null = useMemo(() => {
    if (inspectorSelection?.kind !== 'model-relationship') return null;
    return modelRelationships[inspectorSelection.index] ?? null;
  }, [inspectorSelection, modelRelationships]);
  const [bindings, setBindings] = useState<Record<string, SpatialBinding>>({});
  const handleBind = useCallback(
    (entityId: string, binding: SpatialBinding) => {
      // A prim can only be bound to one SpatialItem at a time: clear any
      // existing entry that points at the same group prim before writing the
      // new mapping so the old SpatialItem visibly loses its check mark.
      setBindings((cur) => {
        const next: Record<string, SpatialBinding> = {};
        for (const [eid, b] of Object.entries(cur)) {
          if (b.guid !== binding.guid && eid !== entityId) next[eid] = b;
        }
        next[entityId] = binding;
        return next;
      });
    },
    []
  );

  const handleAttachUsdToInstance = useCallback(
    (instanceId: string, usdPath: string, suggestedName?: string) => {
      // Snapshot the existing USD-child binding BEFORE updating the doc so
      // we can delete the previously-bound prim ("lose the old mapping")
      // and parent the replacement under the same prim parent.
      const existingUsdRel = ontologyDoc.instances.relationships.find(
        (r) => r.type === 'HasUSD' && r.source === instanceId
      );
      const existingUsdId = existingUsdRel?.target ?? null;
      const existingBinding = existingUsdId ? bindings[existingUsdId] : undefined;

      const result = attachUsdToInstance(
        ontologyDoc,
        instanceId,
        usdPath,
        suggestedName
      );
      if (!result) return;
      setOntologyDoc(result.doc);

      const nextUsd = usdPath.trim();
      if (!nextUsd) return;

      let parentPrimId: string | null = null;
      if (existingBinding) {
        const oldPrim = prims.find((p) => p.id === existingBinding.guid);
        parentPrimId = oldPrim?.parentId ?? null;
        handleDelete(existingBinding.guid);
      } else {
        // No prior USD-child binding — spawn under the instance's own bound
        // prim if it has one (rare, but covers asset-wrappers that already
        // anchor a sub-tree in the scene).
        const instBinding = bindings[instanceId];
        if (instBinding) parentPrimId = instBinding.guid;
      }

      const instance = ontologyDoc.instances.entities.find(
        (e) => e.id === instanceId
      );
      const spawned = spawnFromModelUsd(
        nextUsd,
        suggestedName?.trim() || instance?.name || '',
        parentPrimId
      );
      if (!spawned) return;
      setBindings((cur) => {
        const next: Record<string, SpatialBinding> = {};
        for (const [eid, b] of Object.entries(cur)) {
          if (b.guid !== spawned.guid && eid !== result.usdId) next[eid] = b;
        }
        next[result.usdId] = {
          guid: spawned.guid,
          usd: nextUsd,
          name: spawned.name
        };
        return next;
      });
    },
    [ontologyDoc, bindings, prims, handleDelete, spawnFromModelUsd]
  );

  // ---- Undo stack (Ctrl/Cmd+Z, keeps the last 10 mutations) -----------
  // An "action" is any change to prims, ontologyDoc, or bindings. Pure
  // selection changes don't push a new entry, but the selection at the
  // moment of the mutation is captured so undo restores it too. The effect
  // pushes the *previous* data snapshot whenever data changes; the keydown
  // handler pops and restores it.
  interface UndoSnapshot {
    prims: PrimNode[];
    ontologyDoc: OntologyDoc;
    bindings: Record<string, SpatialBinding>;
    selectedId: string | null;
    additionalSelectedIds: string[];
    selectedInstanceId: string | null;
  }
  const UNDO_LIMIT = 10;
  const undoStackRef = useRef<UndoSnapshot[]>([]);
  const lastDataRef = useRef<{
    prims: PrimNode[];
    ontologyDoc: OntologyDoc;
    bindings: Record<string, SpatialBinding>;
  } | null>(null);
  const lastSelectionRef = useRef<{
    selectedId: string | null;
    additionalSelectedIds: string[];
    selectedInstanceId: string | null;
  }>({
    selectedId: null,
    additionalSelectedIds: [],
    selectedInstanceId: null
  });
  const isUndoingRef = useRef(false);
  // Set while a gizmo drag is in flight (between onBeginTransformBatch and
  // onEndTransformBatch). During a batch the data effect skips pushing new
  // snapshots; the single pre-drag snapshot held in batchStartSnapshotRef
  // is handed off to pendingFlushRef when the batch closes, and the next
  // data-effect tick pushes it once — so a multi-tick drag produces exactly
  // one undo entry representing the pre-drag state.
  const batchingRef = useRef(false);
  const batchStartSnapshotRef = useRef<UndoSnapshot | null>(null);
  // Holds a snapshot waiting to be pushed onto the undo stack by the next
  // data-effect fire (e.g. the drag-end commit). Lets the effect collapse
  // the drag's final commit into a single history entry without also
  // recording the mid-drag intermediate state.
  const pendingFlushRef = useRef<UndoSnapshot | null>(null);

  useEffect(() => {
    lastSelectionRef.current = {
      selectedId,
      additionalSelectedIds,
      selectedInstanceId
    };
  }, [selectedId, additionalSelectedIds, selectedInstanceId]);

  useEffect(() => {
    if (isUndoingRef.current) {
      isUndoingRef.current = false;
      lastDataRef.current = { prims, ontologyDoc, bindings };
      pendingFlushRef.current = null;
      return;
    }
    if (batchingRef.current) {
      // Still in a gizmo drag — just track the latest data without
      // recording a history entry per tick.
      lastDataRef.current = { prims, ontologyDoc, bindings };
      return;
    }
    // Decide what to push. If a batch just ended, use the snapshot it
    // captured (pre-drag); otherwise capture the previous data + selection.
    const snapshot =
      pendingFlushRef.current ??
      (lastDataRef.current
        ? { ...lastDataRef.current, ...lastSelectionRef.current }
        : null);
    pendingFlushRef.current = null;
    if (snapshot) {
      // Only push when data actually changed; reference equality is enough
      // because every mutation produces a new array/object.
      const changed =
        snapshot.prims !== prims ||
        snapshot.ontologyDoc !== ontologyDoc ||
        snapshot.bindings !== bindings;
      if (changed) {
        undoStackRef.current.push(snapshot);
        if (undoStackRef.current.length > UNDO_LIMIT) {
          undoStackRef.current.shift();
        }
      }
    }
    lastDataRef.current = { prims, ontologyDoc, bindings };
  }, [prims, ontologyDoc, bindings]);

  const handleBeginTransformBatch = useCallback(() => {
    if (batchingRef.current) return;
    batchingRef.current = true;
    if (lastDataRef.current) {
      batchStartSnapshotRef.current = {
        ...lastDataRef.current,
        ...lastSelectionRef.current
      };
    }
  }, []);

  const handleEndTransformBatch = useCallback(() => {
    if (!batchingRef.current) return;
    batchingRef.current = false;
    // Hand the pre-drag snapshot to the data effect; it will push it once,
    // but only if the drag-end commit produced an actual data change.
    pendingFlushRef.current = batchStartSnapshotRef.current;
    batchStartSnapshotRef.current = null;
  }, []);

  const handleUndo = useCallback(() => {
    const snap = undoStackRef.current.pop();
    if (!snap) return;
    isUndoingRef.current = true;
    setPrims(snap.prims);
    setOntologyDoc(snap.ontologyDoc);
    setBindings(snap.bindings);
    setSelectedId(snap.selectedId);
    setAdditionalSelectedIds(snap.additionalSelectedIds);
    setSelectedInstanceId(snap.selectedInstanceId);
    setSelectedMeshUid(null);
    setSubMeshInfo(null);
    setInspectorSelection(null);
  }, []);

  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      const isUndo =
        (ev.ctrlKey || ev.metaKey) &&
        !ev.shiftKey &&
        !ev.altKey &&
        (ev.key === 'z' || ev.key === 'Z');
      if (!isUndo) return;
      // Don't hijack Ctrl+Z while the user is editing text in an input
      // field — let the browser's native input undo handle it instead.
      const t = ev.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          (t as HTMLElement).isContentEditable
        ) {
          return;
        }
      }
      ev.preventDefault();
      handleUndo();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleUndo]);

  // Reverse index: primId -> the SpatialItem entity it is bound to. Keyed by
  // the bound group's prim id (`binding.guid`) so the green-check indicator
  // and the Properties "Mapped" row appear on the asset's top-level wrapper
  // — the same node that viewport picks promote to.
  const mappedByPrimId = useMemo(() => {
    const entityById = new Map(ontology.entities.map((e) => [e.id, e] as const));
    const m = new Map<string, { entityId: string; entityName: string }>();
    for (const [entityId, b] of Object.entries(bindings)) {
      const entity = entityById.get(entityId);
      if (!entity) continue;
      m.set(b.guid, { entityId, entityName: entity.name });
    }
    return m;
  }, [bindings, ontology]);

  // Cross-panel selection sync: the bound group prim id maps to the bound
  // SpatialItem entity id. Since viewport picks promote to the top ancestor
  // (which IS the group), this single mapping is enough to drive highlight
  // round-trips with the Hierarchy / Properties / Ontology panels.
  const entityIdByPrimId = useMemo(() => {
    const m = new Map<string, string>();
    for (const [entityId, b] of Object.entries(bindings)) m.set(b.guid, entityId);
    return m;
  }, [bindings]);

  const selectedEntityId = selectedId ? entityIdByPrimId.get(selectedId) ?? null : null;

  // Map a (possibly hidden) USD-child entity id back to its parent. Used so
  // a viewport prim pick highlights the parent row in the Ontology panel
  // (the USD child itself isn't rendered there). Falls through unchanged
  // when the id is already a non-USD entity, or has no HasUSD parent.
  const collapseUsdChildToParent = useCallback(
    (entityId: string | null): string | null => {
      if (!entityId) return null;
      const ent = ontologyDoc.instances.entities.find((e) => e.id === entityId);
      if (!ent || ent.type !== 'USD') return entityId;
      const parentRel = ontologyDoc.instances.relationships.find(
        (r) => r.type === 'HasUSD' && r.target === entityId
      );
      return parentRel?.source ?? entityId;
    },
    [ontologyDoc]
  );

  // Multi-selection projected onto the Ontology panel: each selected prim's
  // bound entity, collapsed up to its visible parent row (USD children are
  // hidden in the panel). Includes selectedInstanceId so entity-only picks
  // also show as highlighted. Deduped for downstream `.includes` checks.
  const selectedEntityIds = useMemo(() => {
    const ids = new Set<string>();
    for (const pid of selectedIds) {
      const eid = entityIdByPrimId.get(pid);
      const visible = collapseUsdChildToParent(eid ?? null);
      if (visible) ids.add(visible);
    }
    if (selectedInstanceId) {
      const visible = collapseUsdChildToParent(selectedInstanceId);
      if (visible) ids.add(visible);
    }
    return Array.from(ids);
  }, [selectedIds, selectedInstanceId, entityIdByPrimId, collapseUsdChildToParent]);

  // Inverse lookup used when the user clicks a SpatialItem row: bring focus
  // to the bound group prim so the viewport gizmo + Properties panel update.
  const primIdByEntityId = useMemo(() => {
    const m = new Map<string, string>();
    for (const [entityId, b] of Object.entries(bindings)) m.set(entityId, b.guid);
    return m;
  }, [bindings]);

  const handleSelectOntologyEntity = useCallback(
    (entityId: string, additive: boolean = false) => {
      setInspectorSelection(null);
      setSelectedConditionId(null);
      let primId = primIdByEntityId.get(entityId);
      if (!primId) {
        // Parent rows have no prim of their own; fall back to the bound prim
        // of their hidden USD child so clicking the parent still focuses the
        // viewport gizmo.
        const usdChildId = ontologyDoc.instances.relationships.find(
          (r) => r.type === 'HasUSD' && r.source === entityId
        )?.target;
        if (usdChildId) primId = primIdByEntityId.get(usdChildId);
      }
      if (additive) {
        // Ctrl/Cmd+click on an instance row: route through the shared
        // multi-select toggle when there's an underlying prim, so the gizmo
        // picks up the addition. Entities with no bound prim can't join the
        // group move; we still surface them as the Properties focus.
        if (primId) {
          handleSelect(primId, null, true);
        }
        setSelectedInstanceId(entityId);
        return;
      }
      setSelectedInstanceId(entityId);
      setAdditionalSelectedIds([]);
      if (primId) {
        setSelectedId(primId);
        setSelectedMeshUid(null);
      } else {
        setSelectedId(null);
        setSelectedMeshUid(null);
      }
    },
    [primIdByEntityId, ontologyDoc, handleSelect]
  );

  // Resolves a prim id to an ontology binding. Walks up the parent chain so
  // dragging an inner reference node still binds to its owning asset wrapper.
  // Returns the matched library Asset (`/usd_assets/<id>.usda`) when the
  // ancestor is a Group spawned from the library, otherwise falls back to the
  // topmost primitive shape (`/usd_shapes/<Kind>.usda`).
  const resolvePrimAsAsset = useCallback(
    (primId: string) => {
      const byId = new Map(prims.map((p) => [p.id, p] as const));
      let cur: PrimNode | undefined = byId.get(primId);
      let topmost: PrimNode | undefined;
      while (cur) {
        if (cur.kind === 'group' && cur.assetId) {
          return {
            guid: cur.id,
            usdaUrl: `/usd_assets/${cur.assetId}.usda`,
            name: cur.name
          };
        }
        topmost = cur;
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
      if (topmost) {
        const shapeUsda = SHAPE_USDA[topmost.kind];
        if (shapeUsda) {
          return {
            guid: topmost.id,
            usdaUrl: `/usd_shapes/${shapeUsda}.usda`,
            name: topmost.name
          };
        }
      }
      return null;
    },
    [prims]
  );

  // Rebind a USD child to an *existing* scene prim instead of spawning a
  // fresh one. Fired when the user drags a viewport/Hierarchy prim onto an
  // instance row (OntologyPanel) or onto the USD box (PropertiesPanel).
  // The dragged prim stays put; the previously-bound prim is deleted so
  // the old mapping is gone. `targetEntityId` can be either a non-USD
  // instance (we'll upsert the HasUSD child) or a USD entity directly.
  const handleRebindUsdInstancePrim = useCallback(
    (targetEntityId: string, sourcePrimId: string) => {
      if (!targetEntityId || !sourcePrimId) return;
      const resolved = resolvePrimAsAsset(sourcePrimId);
      if (!resolved) return;
      const targetEntity = ontologyDoc.instances.entities.find(
        (e) => e.id === targetEntityId
      );
      if (!targetEntity) return;

      let usdEntityId: string;
      if (targetEntity.type === 'USD') {
        usdEntityId = targetEntityId;
        setOntologyDoc((cur) =>
          updateEntityInstance(cur, targetEntityId, {
            usd: resolved.usdaUrl
          })
        );
      } else {
        const result = attachUsdToInstance(
          ontologyDoc,
          targetEntityId,
          resolved.usdaUrl,
          resolved.name
        );
        if (!result) return;
        setOntologyDoc(result.doc);
        usdEntityId = result.usdId;
      }

      const existingBinding = bindings[usdEntityId];
      if (existingBinding && existingBinding.guid !== resolved.guid) {
        handleDelete(existingBinding.guid);
      }

      setBindings((cur) => {
        const next: Record<string, SpatialBinding> = {};
        for (const [eid, b] of Object.entries(cur)) {
          if (b.guid !== resolved.guid && eid !== usdEntityId) next[eid] = b;
        }
        next[usdEntityId] = {
          guid: resolved.guid,
          usd: resolved.usdaUrl,
          name: resolved.name
        };
        return next;
      });
    },
    [ontologyDoc, bindings, handleDelete, resolvePrimAsAsset]
  );

  const handleExport = useCallback(() => {
    // Saved file is the ontology only — the USDA scene is composed on demand
    // from the ontology's HasUSD edges + USD-child poses at load time, so we
    // don't need to persist any monolithic USDA blob alongside it.
    const primPoseById = new Map(
      prims.map(
        (p) =>
          [
            p.id,
            { position: p.position, rotation: p.rotation, scale: p.scale }
          ] as const
      )
    );
    const primParentById = new Map(prims.map((p) => [p.id, p.parentId] as const));
    // Run ensureHasUsdEdges FIRST so fresh bindings get a HasUSD edge before
    // applyBindingsToOntology walks those edges to stamp pose on the USD
    // child entity.
    let ontologyOut = ensureHasUsdEdges(ontologyDoc, bindings, primParentById);
    ontologyOut = applyBindingsToOntology(ontologyOut, bindings, primPoseById);
    const blob = new Blob([JSON.stringify(ontologyOut, null, 2)], {
      type: 'application/json;charset=utf-8'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileSafe(sceneName)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [prims, sceneName, ontologyDoc, bindings]);

  const handleImport = useCallback(async (file: File) => {
    const MAX_IMPORT_BYTES = 250 * 1024 * 1024;
    if (file.size > MAX_IMPORT_BYTES) {
      const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
      alert(
        `"${file.name}" is ${sizeMb} MB. Scene imports are limited to 250 MB.`
      );
      return;
    }
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as
        | OntologyDoc
        | { Ontology?: OntologyDoc; Scene?: string };
      // Saved scenes are pure ontology JSON; the legacy combined envelope
      // (`{ Scene, Ontology }`) is still accepted by pulling out its
      // Ontology field — the Scene blob is ignored.
      const doc: OntologyDoc | null = looksLikeOntologyDoc(parsed)
        ? (parsed as OntologyDoc)
        : looksLikeOntologyDoc(
              (parsed as { Ontology?: OntologyDoc }).Ontology
            )
          ? ((parsed as { Ontology: OntologyDoc }).Ontology)
          : null;
      if (!doc) {
        throw new Error('File is not a drewscenes ontology JSON.');
      }

      // Reset scene state. Counters reset so auto-generated shape names
      // start over for the freshly-loaded ontology.
      setSelectedId(null);
      setSelectedMeshUid(null);
      setSubMeshInfo(null);
      setAssetMeshes({});
      countersRef.current = {
        box: 0,
        cylinder: 0,
        sphere: 0,
        plane: 0,
        cone: 0,
        group: 0,
        reference: 0
      };

      // Materialize viewport prims from the ontology. For each non-USD
      // instance entity that owns a HasUSD edge, spawn the USD child's
      // geometry, apply its pose (local to the parent prim), and record the
      // binding from the parent entity to the spawned root prim.
      const entityById = new Map(doc.instances.entities.map((e) => [e.id, e] as const));
      const usdChildBySource = new Map<string, string>();
      const parentByEntity = new Map<string, string>();
      for (const r of doc.instances.relationships) {
        if (r.type === 'HasUSD') {
          usdChildBySource.set(r.source, r.target);
        } else if (r.type === 'HasChild') {
          const src = entityById.get(r.source);
          const tgt = entityById.get(r.target);
          if (!src || !tgt) continue;
          if (src.type === 'USD' || tgt.type === 'USD') continue;
          parentByEntity.set(r.target, r.source);
        }
      }

      // Topologically order non-USD entities: ancestors before descendants.
      const orderedIds: string[] = [];
      const visited = new Set<string>();
      const visit = (id: string) => {
        if (visited.has(id)) return;
        visited.add(id);
        const parentId = parentByEntity.get(id);
        if (parentId) visit(parentId);
        const ent = entityById.get(id);
        if (ent && ent.type !== 'USD') orderedIds.push(id);
      };
      for (const e of doc.instances.entities) {
        if (e.type !== 'USD') visit(e.id);
      }

      const newPrims: PrimNode[] = [];
      const newBindings: Record<string, SpatialBinding> = {};
      for (const entityId of orderedIds) {
        const ent = entityById.get(entityId);
        if (!ent) continue;
        const usdEntId = usdChildBySource.get(entityId);
        if (!usdEntId) continue;
        const usdEnt = entityById.get(usdEntId);
        if (!usdEnt || !usdEnt.usd) continue;
        const parentEntId = parentByEntity.get(entityId);
        const parentPrimId = parentEntId
          ? newBindings[parentEntId]?.guid ?? null
          : null;
        const guid = buildPrimsFromUsd(
          usdEnt.usd,
          ent.name,
          parentPrimId,
          newPrims
        );
        if (!guid) continue;
        const idx = newPrims.findIndex((p) => p.id === guid);
        if (idx >= 0) {
          const cur = newPrims[idx];
          newPrims[idx] = {
            ...cur,
            position: usdEnt.position
              ? [usdEnt.position.x, usdEnt.position.y, usdEnt.position.z]
              : cur.position,
            rotation: usdEnt.rotation
              ? [usdEnt.rotation.x, usdEnt.rotation.y, usdEnt.rotation.z]
              : cur.rotation,
            scale: usdEnt.scale
              ? [usdEnt.scale.x, usdEnt.scale.y, usdEnt.scale.z]
              : cur.scale
          };
        }
        newBindings[entityId] = {
          guid,
          usd: usdEnt.usd,
          name: newPrims[idx]?.name ?? ent.name
        };
      }

      setOntologyDoc(doc);
      setPrims(newPrims);
      setBindings(newBindings);
      const nameFromFile = file.name.replace(/\.(json|usda?|txt)$/i, '');
      setSceneName(nameFromFile || 'Loaded Scene');
    } catch (err) {
      console.error('Scene load failed', err);
      alert(
        'Could not load that file. Expected a .json ontology saved by drewscenes.'
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Spawn an asset's prim tree at a viewport drop point. Wrap everything in a
  // single Group prim positioned at the drop point so the asset shows up as one
  // movable object in the hierarchy. The group's name is the asset's top-level
  // Xform name from the USDA (or the asset id if missing).
  const handleAssetDropped = useCallback(
    (assetId: string, dropAt: Vec3) => {
      spawnAssetUnder(assetId, null, dropAt);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // Same as `handleAssetDropped` but used when the user drags an asset onto a
  // node in the Hierarchy panel: the asset's group prim is parented to the
  // dropped-on prim with a local origin of [0,0,0].
  const handleAssetAddToParent = useCallback(
    (assetId: string, parentId: string | null) => {
      spawnAssetUnder(assetId, parentId, [0, 0, 0]);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // Shared body for the two callbacks above. Closes over `setPrims` and
  // `setSelectedId`; doesn't read other state so the empty dep arrays on
  // the wrappers are safe.
  function spawnAssetUnder(
    assetId: string,
    parentId: string | null,
    at: Vec3,
    forcedName?: string
  ): string | null {
    const asset = getAsset(assetId);
    if (!asset) return null;
    let parsed;
    try {
      parsed = parseUsda(asset.usda);
    } catch (err) {
      console.error('Asset parse failed', assetId, err);
      return null;
    }
    // An empty USDA (e.g. the Placeholder asset, which is just a named
    // wrapper Xform with no children) parses to zero inner prims. That's
    // fine: the outer groupPrim below is sufficient as a usable empty
    // container, so we don't bail in that case.

    const groupId = newId();
    const groupPrim: PrimNode = {
      id: groupId,
      name: forcedName?.trim() || parsed.sceneName || asset.label,
      kind: 'group',
      position: at,
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      parentId,
      assetId,
      color: DEFAULT_COLOR
    };
    // Reparent the asset's roots under our new group; leave their local
    // transforms untouched so the geometry composes correctly under the group.
    const newPrims: PrimNode[] = parsed.prims.map((p) =>
      p.parentId === null ? { ...p, parentId: groupId } : p
    );

    setPrims((prev) => [...prev, groupPrim, ...newPrims]);
    setSelectedId(groupId);
    return groupId;
  }

  const SHAPE_KIND_BY_USDA = new Map<string, ShapeKind>([
    ['box', 'box'],
    ['cylinder', 'cylinder'],
    ['sphere', 'sphere'],
    ['plane', 'plane'],
    ['cone', 'cone']
  ]);

  // Resolve a USD path (shape or asset) into prims appended to `accumulator`,
  // returning the id of the root prim. Used by the ontology-driven load path
  // to materialize the viewport without going through `setPrims`, so every
  // spawned instance's id is known synchronously and downstream entities can
  // be parented under it in the same pass.
  function buildPrimsFromUsd(
    usdPath: string,
    instanceName: string,
    parentPrimId: string | null,
    accumulator: PrimNode[]
  ): string | null {
    const raw = usdPath.trim();
    if (!raw) return null;
    const normalized = raw.replace(/^\.\//, '').replace(/^\/+/, '');
    const lower = normalized.toLowerCase();

    const shapeMatch = /(?:^|\/)usd_shapes\/([^/]+)\.usd[ac]?$/i.exec(normalized);
    if (shapeMatch) {
      const kind = SHAPE_KIND_BY_USDA.get(shapeMatch[1].toLowerCase());
      if (!kind) return null;
      const n = (countersRef.current[kind] ?? 0) + 1;
      countersRef.current[kind] = n;
      const name = instanceName.trim() || `${KIND_LABELS[kind]}_${n}`;
      const halfH = SPAWN_HALF_HEIGHT[kind];
      const prim: PrimNode = {
        id: newId(),
        name,
        kind,
        position: parentPrimId ? [0, 0, 0] : [0, halfH, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        parentId: parentPrimId,
        color: DEFAULT_COLOR
      };
      accumulator.push(prim);
      return prim.id;
    }

    let assetHint: string | null = null;
    const nestedAssetMatch = /(?:^|\/)usd_assets\/([^/]+)\//i.exec(normalized);
    if (nestedAssetMatch) assetHint = nestedAssetMatch[1];
    const wrapperAssetMatch = /(?:^|\/)usd_assets\/([^/]+)\.usd[ac]?$/i.exec(normalized);
    if (!assetHint && wrapperAssetMatch) assetHint = wrapperAssetMatch[1];
    if (!assetHint && lower.includes('hospitalbed')) assetHint = 'HospitalBed';
    if (!assetHint) return null;
    const matchedAssetId =
      ASSET_LIBRARY.find((a) => a.id.toLowerCase() === assetHint!.toLowerCase())
        ?.id ?? null;
    if (!matchedAssetId) return null;
    const asset = getAsset(matchedAssetId);
    if (!asset) return null;
    let parsed;
    try {
      parsed = parseUsda(asset.usda);
    } catch (err) {
      console.error('Asset parse failed', matchedAssetId, err);
      return null;
    }
    const groupId = newId();
    const groupName = instanceName.trim() || parsed.sceneName || asset.label;
    const groupPrim: PrimNode = {
      id: groupId,
      name: groupName,
      kind: 'group',
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      parentId: parentPrimId,
      assetId: matchedAssetId,
      color: DEFAULT_COLOR
    };
    accumulator.push(groupPrim);
    for (const p of parsed.prims) {
      accumulator.push(p.parentId === null ? { ...p, parentId: groupId } : p);
    }
    return groupId;
  }

  // USD-backed entity models spawn directly into the viewport and return the
  // created prim id so the instance's companion SpatialItem can be bound.
  function spawnFromModelUsd(
    modelUsd: string,
    instanceName: string,
    parentPrimId: string | null
  ): { guid: string; name: string } | null {
    const raw = modelUsd.trim();
    if (!raw) return null;
    const normalized = raw.replace(/^\.\//, '').replace(/^\/+/, '');
    const lower = normalized.toLowerCase();

    const shapeMatch = /(?:^|\/)usd_shapes\/([^/]+)\.usd[ac]?$/i.exec(normalized);
    if (shapeMatch) {
      const kind = SHAPE_KIND_BY_USDA.get(shapeMatch[1].toLowerCase());
      if (!kind) return null;
      const n = (countersRef.current[kind] ?? 0) + 1;
      countersRef.current[kind] = n;
      const name = instanceName.trim() || `${KIND_LABELS[kind]}_${n}`;
      const halfH = SPAWN_HALF_HEIGHT[kind];
      const prim: PrimNode = {
        id: newId(),
        name,
        kind,
        position: parentPrimId ? [0, 0, 0] : [0, halfH, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        parentId: parentPrimId,
        color: DEFAULT_COLOR
      };
      setPrims((prev) => [...prev, prim]);
      setSelectedId(prim.id);
      return { guid: prim.id, name: prim.name };
    }

    let assetHint: string | null = null;
    const nestedAssetMatch = /(?:^|\/)usd_assets\/([^/]+)\//i.exec(normalized);
    if (nestedAssetMatch) assetHint = nestedAssetMatch[1];
    const wrapperAssetMatch = /(?:^|\/)usd_assets\/([^/]+)\.usd[ac]?$/i.exec(normalized);
    if (!assetHint && wrapperAssetMatch) assetHint = wrapperAssetMatch[1];
    if (!assetHint && lower.includes('hospitalbed')) assetHint = 'HospitalBed';

    if (assetHint) {
      const matchedAssetId =
        ASSET_LIBRARY.find((a) => a.id.toLowerCase() === assetHint!.toLowerCase())
          ?.id ?? null;
      if (!matchedAssetId) return null;
      const name = instanceName.trim() || matchedAssetId;
      const guid = spawnAssetUnder(matchedAssetId, parentPrimId, [0, 0, 0], name);
      if (!guid) return null;
      return { guid, name };
    }
    return null;
  }

  // Focus = reset camera to its initial view. Bumping the counter signals
  // the Viewport to run a full reset; both the toolbar button and the 'F'
  // hotkey go through this single channel.
  const [focusSignal, setFocusSignal] = useState(0);
  const handleFocus = useCallback(() => {
    setFocusSignal((n) => n + 1);
  }, []);

  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      // Don't hijack typing in inputs / textareas / contenteditable fields.
      const t = ev.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (t.isContentEditable) return;
      }
      if (ev.key === 'f' || ev.key === 'F') {
        ev.preventDefault();
        handleFocus();
      } else if (ev.key === 'm' || ev.key === 'M') {
        ev.preventDefault();
        setTool('measure');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleFocus]);

  // Right-click menu state. Holds the page-space anchor point and the items
  // to render. Panels (prims, models, instances) populate this via their
  // dedicated handlers below so the same `ContextMenu` instance is reused.
  const [menu, setMenu] = useState<
    { x: number; y: number; items: ContextMenuItem[] } | null
  >(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  const handleContextMenu = useCallback(
    (primId: string, x: number, y: number) => {
      // If the right-clicked prim is part of the current multi-selection,
      // operate on the whole selection; otherwise just on the clicked one.
      const targetIds = selectedIds.includes(primId) ? selectedIds : [primId];
      const n = targetIds.length;
      setMenu({
        x,
        y,
        items: [
          {
            label: n > 1 ? `Duplicate (${n})` : 'Duplicate',
            onClick: () => handleDuplicateMany(targetIds)
          },
          {
            label: n > 1 ? `Delete (${n})` : 'Delete',
            destructive: true,
            onClick: () => handleDeleteMany(targetIds)
          }
        ]
      });
    },
    [selectedIds, handleDuplicateMany, handleDeleteMany]
  );

  // ---------- Ontology mutation handlers ----------

  // Inline-rename state. After creating a new type/instance the new id is
  // placed here so the matching panel row mounts an auto-focused input.
  const [editingType, setEditingType] = useState<string | null>(null);
  const [editingInstanceId, setEditingInstanceId] = useState<string | null>(null);

  const handleAddType = useCallback(
    (parentName: string | null = null) => {
      const existing = new Set(
        (ontologyDoc.model?.entityTypes ?? []).map((t) => t.name)
      );
      const base = DEFAULT_ENTITY_TYPE.name;
      let name = base;
      let n = 2;
      while (existing.has(name)) {
        name = `${base}${n}`;
        n++;
      }
      setOntologyDoc((cur) => {
        let next = addEntityType(cur, name);
        if (parentName) next = addEntityTypeParent(next, name, parentName);
        return next;
      });
      setEditingType(name);
      setSelectedId(null);
      setSelectedMeshUid(null);
      setSubMeshInfo(null);
      setSelectedInstanceId(null);
      setInspectorSelection({ kind: 'model-type', name });
    },
    [ontologyDoc]
  );

  const handleCommitTypeRename = useCallback(
    (oldName: string, newName: string) => {
      const trimmed = newName.trim();
      if (trimmed && trimmed !== oldName) {
        setOntologyDoc((cur) => renameEntityType(cur, oldName, trimmed));
      }
      setEditingType(null);
    },
    []
  );
  const handleCancelTypeRename = useCallback(() => setEditingType(null), []);

  const handleReparentType = useCallback(
    (name: string, newParent: string | null) => {
      // Drag-drop is now ADDITIVE: dropping a type onto a new parent appends
      // a HasChild edge (the type may have multiple parents). Root drops are
      // refused at the panel layer via canReparentType, so newParent is
      // always non-null here in practice.
      if (newParent === null) return;
      setOntologyDoc((cur) => addEntityTypeParent(cur, name, newParent));
    },
    []
  );

  // Returns whether a drag-drop reparent of `name` onto `newParent` (null =
  // root) is permitted. Refuses self-drops, cycles, duplicate edges,
  // dragging the hidden USD type, and any root drop (root placement is
  // managed via the context menu "Make root" action, not drag-drop).
  const canReparentType = useCallback(
    (name: string, newParent: string | null): boolean => {
      if (!name) return false;
      if (name === 'USD') return false;
      if (newParent === null) return false;
      if (newParent === name) return false;
      const rels = ontologyDoc.model?.relationships ?? [];
      const exists = rels.some(
        (r) =>
          r.type === 'HasChild' && r.source === newParent && r.target === name
      );
      if (exists) return false;
      // Cycle: walking up from newParent via HasChild ancestors must not
      // reach `name`.
      const parentsOf = new Map<string, string[]>();
      for (const r of rels) {
        if (r.type !== 'HasChild') continue;
        const list = parentsOf.get(r.target) ?? [];
        list.push(r.source);
        parentsOf.set(r.target, list);
      }
      const stack = [newParent];
      const seen = new Set<string>();
      while (stack.length) {
        const cur = stack.pop()!;
        if (cur === name) return false;
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const p of parentsOf.get(cur) ?? []) stack.push(p);
      }
      return true;
    },
    [ontologyDoc]
  );

  const handleSelectModelType = useCallback((name: string) => {
    setSelectedId(null);
    setSelectedMeshUid(null);
    setSubMeshInfo(null);
    setSelectedInstanceId(null);
    setSelectedConditionId(null);
    setInspectorSelection({ kind: 'model-type', name });
  }, []);

  const handleSelectModelRelationship = useCallback((index: number) => {
    setSelectedId(null);
    setSelectedMeshUid(null);
    setSubMeshInfo(null);
    setSelectedInstanceId(null);
    setSelectedConditionId(null);
    setInspectorSelection({ kind: 'model-relationship', index });
  }, []);

  const handleAddCondition = useCallback(() => {
    setConditions((cur) => {
      const taken = new Set(cur.map((b) => b.name));
      let n = cur.length + 1;
      let pick = `Condition ${n}`;
      while (taken.has(pick)) {
        n += 1;
        pick = `Condition ${n}`;
      }
      const created = createCondition(pick);
      // Selection state lives outside this updater; defer with a
      // microtask so it lands after the new condition is committed.
      queueMicrotask(() => setSelectedConditionId(created.id));
      return [...cur, created];
    });
    setSelectedId(null);
    setAdditionalSelectedIds([]);
    setSelectedMeshUid(null);
    setSubMeshInfo(null);
    setSelectedInstanceId(null);
    setInspectorSelection(null);
  }, []);

  const handleSelectCondition = useCallback((id: string) => {
    setSelectedConditionId(id);
    setSelectedId(null);
    setAdditionalSelectedIds([]);
    setSelectedMeshUid(null);
    setSubMeshInfo(null);
    setSelectedInstanceId(null);
    setInspectorSelection(null);
  }, []);

  const handleDeleteCondition = useCallback((id: string) => {
    setConditions((cur) => cur.filter((b) => b.id !== id));
    setSelectedConditionId((cur) => (cur === id ? null : cur));
  }, []);

  const handleUpdateCondition = useCallback(
    (id: string, patch: Partial<Omit<Condition, 'id'>>) => {
      setConditions((cur) =>
        cur.map((b) => (b.id === id ? { ...b, ...patch } : b))
      );
    },
    []
  );

  const handleDuplicateCondition = useCallback((id: string) => {
    setConditions((cur) => {
      const src = cur.find((b) => b.id === id);
      if (!src) return cur;
      const taken = new Set(cur.map((b) => b.name));
      const clone: Condition = {
        id: newId(),
        name: nextDuplicateName(src.name, taken),
        // ViewRules need fresh ids so future edits don't alias the original.
        viewRules: src.viewRules.map((r) => ({ ...r, id: newId() }))
      };
      queueMicrotask(() => setSelectedConditionId(clone.id));
      const idx = cur.findIndex((b) => b.id === id);
      const next = cur.slice();
      next.splice(idx + 1, 0, clone);
      return next;
    });
  }, []);

  const handleConditionContextMenu = useCallback(
    (id: string | null, x: number, y: number) => {
      if (!id) {
        setMenu({
          x,
          y,
          items: [{ label: 'Add condition', onClick: handleAddCondition }]
        });
        return;
      }
      setMenu({
        x,
        y,
        items: [
          { label: 'Duplicate', onClick: () => handleDuplicateCondition(id) },
          {
            label: 'Delete',
            destructive: true,
            onClick: () => handleDeleteCondition(id)
          }
        ]
      });
    },
    [handleAddCondition, handleDuplicateCondition, handleDeleteCondition]
  );

  const handleUpdateModelType = useCallback(
    (name: string, patch: Partial<Omit<OntologyEntityType, 'name'>>) => {
      const before = ontologyDoc.model?.entityTypes.find((t) => t.name === name);
      const beforeUsd = (before?.usd ?? '').trim();
      setOntologyDoc((cur) => updateEntityType(cur, name, patch));

      // If the USD field gained a value (or changed to a new value), backfill
      // existing instances of this type by attaching a USD child carrying that
      // path — matching what addEntityInstance does for newly-created ones —
      // and spawn the corresponding prim under the parent's bound USD prim.
      if (!('usd' in patch)) return;
      const nextUsd = (patch.usd ?? '').trim();
      if (!nextUsd || nextUsd === beforeUsd) return;

      const instances = ontologyDoc.instances.entities.filter(
        (e) => e.type === name
      );
      if (instances.length === 0) return;

      const rels = ontologyDoc.instances.relationships;
      const modelRels = ontologyDoc.model?.relationships ?? [];
      const usdRel = modelRels.find(
        (r) => r.type === 'HasUSD' && r.source === name
      );
      const usdType = usdRel?.target ?? 'USD';

      const newEntities: OntologyEntity[] = [];
      const newRels: OntologyRelationship[] = [];
      const newBindings: Record<string, SpatialBinding> = {};
      const takenNames = new Set(
        ontologyDoc.instances.entities.map((e) => e.name)
      );

      for (const inst of instances) {
        const hasUsdChild = rels.some(
          (r) => r.type === 'HasUSD' && r.source === inst.id
        );
        if (hasUsdChild) continue;

        const spatialId = `usd-${Math.random().toString(36).slice(2, 8)}`;
        let candidate = `${inst.name} USD`;
        let n = 1;
        while (takenNames.has(candidate)) {
          candidate = `${inst.name} USD_${n}`;
          n++;
        }
        takenNames.add(candidate);

        newEntities.push({
          id: spatialId,
          type: usdType,
          name: candidate,
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
          usd: nextUsd,
          topic: '',
          guid: ''
        });
        newRels.push({ type: 'HasUSD', source: inst.id, target: spatialId });

        let parentPrimId: string | null = null;
        const parentChildRel = rels.find(
          (r) => r.type === 'HasChild' && r.target === inst.id
        );
        if (parentChildRel) {
          const parentSpatialId = rels.find(
            (r) => r.type === 'HasUSD' && r.source === parentChildRel.source
          )?.target;
          if (parentSpatialId) {
            parentPrimId = bindings[parentSpatialId]?.guid ?? null;
          }
        }
        const spawned = spawnFromModelUsd(nextUsd, inst.name, parentPrimId);
        if (spawned) {
          newBindings[spatialId] = {
            guid: spawned.guid,
            usd: nextUsd,
            name: spawned.name
          };
        }
      }

      if (newEntities.length === 0) return;
      setOntologyDoc((cur) => {
        const next: OntologyDoc = JSON.parse(JSON.stringify(cur));
        next.instances.entities.push(...newEntities);
        next.instances.relationships.push(...newRels);
        return next;
      });
      setBindings((cur) => ({ ...cur, ...newBindings }));
    },
    [ontologyDoc, bindings, spawnFromModelUsd]
  );

  const handleRenameModelTypeFromProps = useCallback(
    (oldName: string, newName: string) => {
      const trimmed = newName.trim();
      if (!trimmed || trimmed === oldName) return;
      setOntologyDoc((cur) => renameEntityType(cur, oldName, trimmed));
      setInspectorSelection({ kind: 'model-type', name: trimmed });
    },
    []
  );

  const handleUpdateModelRelationship = useCallback(
    (oldRel: OntologyRelationship, nextRel: OntologyRelationship) => {
      setOntologyDoc((cur) => {
        const removed = removeModelRelationship(cur, oldRel);
        return upsertModelRelationship(removed, nextRel);
      });
    },
    []
  );

  // Live entity instance that the Properties panel is editing. Resolved
  // from `selectedInstanceId` when set (Ontology panel pick), otherwise
  // derived from the bound prim (Viewport / Hierarchy pick) by walking the
  // HasUSD edge back to the non-USD instance parent. Re-resolved from the
  // ontology doc each render so edits flow back into the form.
  const selectedInstance: OntologyEntity | null = useMemo(() => {
    const fromPick = collapseUsdChildToParent(
      selectedId ? entityIdByPrimId.get(selectedId) ?? null : null
    );
    const effectiveId = selectedInstanceId ?? fromPick;
    if (!effectiveId) return null;
    return (
      ontologyDoc.instances.entities.find((e) => e.id === effectiveId) ?? null
    );
  }, [
    selectedInstanceId,
    selectedId,
    entityIdByPrimId,
    collapseUsdChildToParent,
    ontologyDoc
  ]);

  // Hidden USD child of the selected non-USD instance, if any. Merged into
  // the Properties form so the parent row visibly owns its USD pose/USD
  // path/topic/guid.
  const selectedInstanceUsdChild: OntologyEntity | null = useMemo(() => {
    if (!selectedInstance || selectedInstance.type === 'USD') return null;
    const rel = ontologyDoc.instances.relationships.find(
      (r) => r.type === 'HasUSD' && r.source === selectedInstance.id
    );
    if (!rel) return null;
    return (
      ontologyDoc.instances.entities.find((e) => e.id === rel.target) ?? null
    );
  }, [selectedInstance, ontologyDoc]);

  // Live prim bound to the selected USD child, if any. Used by the merged
  // USD section in the Properties panel so position/rotation read and write
  // straight through to the viewport — keeping the two sides in lockstep as
  // the gizmo moves or the user types.
  const selectedInstanceUsdChildPrim: PrimNode | null = useMemo(() => {
    if (!selectedInstanceUsdChild) return null;
    const guid = bindings[selectedInstanceUsdChild.id]?.guid;
    if (!guid) return null;
    return prims.find((p) => p.id === guid) ?? null;
  }, [selectedInstanceUsdChild, bindings, prims]);

  // Patch an entity instance. For a USD entity whose `usd` field is
  // changing, also swap the bound prim in the viewport: delete the current
  // prim sub-tree and (if the new USD is non-empty) spawn a fresh one under
  // the same parent, then update the binding so it points at the new prim.
  const handleUpdateEntityInstance = useCallback(
    (id: string, patch: Partial<Omit<OntologyEntity, 'id' | 'type'>>) => {
      const entity = ontologyDoc.instances.entities.find((e) => e.id === id);
      if (!entity) return;
      setOntologyDoc((cur) => updateEntityInstance(cur, id, patch));

      if (!('usd' in patch) || entity.type !== 'USD') return;
      const nextUsd = (patch.usd ?? '').trim();
      const prevUsd = (entity.usd ?? '').trim();
      if (nextUsd === prevUsd) return;

      const existing = bindings[id];
      let parentPrimId: string | null = null;
      if (existing) {
        const oldPrim = prims.find((p) => p.id === existing.guid);
        parentPrimId = oldPrim?.parentId ?? null;
        handleDelete(existing.guid);
      } else {
        // No existing prim — try to place the new one under the bound prim
        // of the parent ontology entity (the one that HasUSD → this id).
        const parentRel = ontologyDoc.instances.relationships.find(
          (r) => r.type === 'HasUSD' && r.target === id
        );
        if (parentRel) {
          const parentSpatialId = ontologyDoc.instances.relationships.find(
            (r) => r.type === 'HasUSD' && r.source === parentRel.source
          )?.target;
          if (parentSpatialId) {
            parentPrimId = bindings[parentSpatialId]?.guid ?? null;
          }
        }
      }

      if (!nextUsd) return;
      const spawned = spawnFromModelUsd(nextUsd, entity.name, parentPrimId);
      if (!spawned) return;
      setBindings((cur) => ({
        ...cur,
        [id]: { guid: spawned.guid, usd: nextUsd, name: spawned.name }
      }));
    },
    [ontologyDoc, bindings, prims, handleDelete, spawnFromModelUsd]
  );

  const handleReparentInstance = useCallback(
    (id: string, newParentId: string | null) => {
      setOntologyDoc((cur) => setEntityInstanceParent(cur, id, newParentId));
    },
    []
  );

  // True iff a drag-drop reparent from `id` onto `newParentId` (null = root)
  // is permitted by the model's HasChild relationships. Used by OntologyPanel
  // to refuse invalid drops and shake the offending row.
  const canReparentInstance = useCallback(
    (id: string, newParentId: string | null): boolean => {
      const entities = ontologyDoc.instances.entities;
      const child = entities.find((e) => e.id === id);
      if (!child) return false;
      const rels = ontologyDoc.model?.relationships ?? [];
      if (newParentId === null) {
        // Root drop is only allowed for types that aren't a HasChild target
        // anywhere in the model (i.e. genuine top-of-hierarchy types).
        const hasChildTargets = new Set(
          rels.filter((r) => r.type === 'HasChild').map((r) => r.target)
        );
        return !hasChildTargets.has(child.type);
      }
      const parent = entities.find((e) => e.id === newParentId);
      if (!parent) return false;
      return rels.some(
        (r) =>
          r.type === 'HasChild' &&
          r.source === parent.type &&
          r.target === child.type
      );
    },
    [ontologyDoc]
  );

  const buildTypePickerSubmenu = useCallback(
    (
      mode: 'root' | 'children' | 'all',
      parentTypeName: string | null,
      onPick: (typeName: string) => void
    ): ContextMenuItem[] => {
      const types = ontologyDoc.model?.entityTypes ?? [];
      const rels = ontologyDoc.model?.relationships ?? [];
      const visible = types.filter((t) => !HIDDEN_ENTITY_TYPE_NAMES.has(t.name));
      let allowed: typeof visible;
      if (mode === 'all') {
        allowed = visible;
      } else if (mode === 'root') {
        // Root pick: only types that are NOT the target of any HasChild
        // edge. Reflects the live model — editing relationships re-narrows
        // the picker on the next open.
        const hasChildTargets = new Set(
          rels.filter((r) => r.type === 'HasChild').map((r) => r.target)
        );
        allowed = visible.filter((t) => !hasChildTargets.has(t.name));
      } else {
        const childTypes = new Set(
          rels
            .filter((r) => r.type === 'HasChild' && r.source === parentTypeName)
            .map((r) => r.target)
        );
        allowed = visible.filter((t) => childTypes.has(t.name));
      }
      if (allowed.length === 0) {
        return [{ label: '(no types available)', disabled: true }];
      }
      return allowed.map((t) => ({
        label: t.name,
        onClick: () => onPick(t.name)
      }));
    },
    [ontologyDoc]
  );

  const addInstanceOfType = useCallback(
    (type: string, parentId: string | null) => {
      const result = addEntityInstance(ontologyDoc, type, type, { parentId });
      setOntologyDoc(result.doc);
      setSelectedId(null);
      setSelectedMeshUid(null);
      setSubMeshInfo(null);
      setInspectorSelection(null);
      setSelectedInstanceId(result.id);
      if (result.spatialId && result.usd) {
        const spatialId = result.spatialId;
        const modelUsd = result.usd;
        const instanceName =
          result.doc.instances.entities.find((e) => e.id === result.id)?.name ??
          type;
        let parentPrimId: string | null = null;
        if (parentId) {
          const parentSpatialId = result.doc.instances.relationships.find(
            (r) => r.type === 'HasUSD' && r.source === parentId
          )?.target;
          if (parentSpatialId) {
            parentPrimId = bindings[parentSpatialId]?.guid ?? null;
          }
        }
        const spawned = spawnFromModelUsd(modelUsd, instanceName, parentPrimId);
        if (spawned) {
          setBindings((cur) => ({
            ...cur,
            [spatialId]: {
              guid: spawned.guid,
              usd: modelUsd,
              name: spawned.name
            }
          }));
        }
      }
    },
    [ontologyDoc, bindings, spawnFromModelUsd]
  );

  // Duplicate an entity instance and all of its descendants (HasChild + HasUSD).
  // Bound USD entities also get their underlying prim subtree cloned and a
  // fresh binding wired up to the new entity. Root duplicate name uses the
  // `_<n>` suffix scheme; child names are uniquified individually.
  const handleDuplicateInstancesMany = useCallback(
    (entityIds: string[]) => {
      if (entityIds.length === 0) return;
      let doc = ontologyDoc;
      const primById = new Map(prims.map((p) => [p.id, p] as const));
      const primNameTaken = new Set(prims.map((p) => p.name));
      const allClonedPrims: PrimNode[] = [];
      const allNewBindings: Record<string, SpatialBinding> = {};
      const newRootIds: string[] = [];

      for (const entityId of entityIds) {
        const result = duplicateEntityInstance(doc, entityId);
        if (!result) continue;
        const { doc: nextDoc, newRootId, idMap } = result;
        doc = nextDoc;
        newRootIds.push(newRootId);

        const primsToClone = new Set<string>();
        const collectPrimAndDescendants = (pid: string) => {
          if (primsToClone.has(pid) || !primById.has(pid)) return;
          primsToClone.add(pid);
          for (const child of prims) {
            if (child.parentId === pid) collectPrimAndDescendants(child.id);
          }
        };
        for (const oldEntityId of idMap.keys()) {
          const b = bindings[oldEntityId];
          if (b?.guid) collectPrimAndDescendants(b.guid);
        }

        const primIdMap = new Map<string, string>();
        for (const pid of primsToClone) primIdMap.set(pid, newId());

        const localCloned: PrimNode[] = [];
        for (const oldPid of primsToClone) {
          const src = primById.get(oldPid);
          if (!src) continue;
          const cloneName = primNameTaken.has(src.name)
            ? nextDuplicateName(src.name, primNameTaken)
            : src.name;
          primNameTaken.add(cloneName);
          localCloned.push({
            ...src,
            id: primIdMap.get(oldPid)!,
            name: cloneName,
            parentId:
              src.parentId && primIdMap.has(src.parentId)
                ? primIdMap.get(src.parentId)!
                : src.parentId,
            position: [...src.position],
            rotation: [...src.rotation],
            scale: [...src.scale]
          });
        }

        for (const [oldEntityId, newEntityId] of idMap) {
          const b = bindings[oldEntityId];
          if (!b) continue;
          const newGuid = primIdMap.get(b.guid);
          if (!newGuid) continue;
          const newEntity = doc.instances.entities.find(
            (e) => e.id === newEntityId
          );
          allNewBindings[newEntityId] = {
            guid: newGuid,
            usd: b.usd,
            name: newEntity?.name ?? b.name
          };
          const clone = localCloned.find((p) => p.id === newGuid);
          if (clone && newEntity) clone.name = newEntity.name;
        }
        allClonedPrims.push(...localCloned);
      }

      setOntologyDoc(doc);
      if (allClonedPrims.length > 0) {
        setPrims((prev) => [...prev, ...allClonedPrims]);
      }
      if (Object.keys(allNewBindings).length > 0) {
        setBindings((cur) => ({ ...cur, ...allNewBindings }));
      }
      // Replace the previous selection with the newly-cloned roots so the
      // user can immediately keep operating on them (and the old originals
      // are no longer multi-selected). For bound roots we route through
      // the prim selection so the viewport gizmo follows; selectedInstanceId
      // tracks the last new root so unbound roots still highlight in the
      // ontology tree. Bindings live on the HasUSD *child* entity, so for a
      // typical non-USD root we resolve its USD child via the new doc to
      // pick the right viewport prim.
      const newBoundPrimIds = newRootIds
        .map((rid) => {
          if (allNewBindings[rid]?.guid) return allNewBindings[rid].guid;
          const usdRel = doc.instances.relationships.find(
            (r) => r.type === 'HasUSD' && r.source === rid
          );
          const usdChildId = usdRel?.target;
          return usdChildId ? allNewBindings[usdChildId]?.guid : undefined;
        })
        .filter((g): g is string => Boolean(g));
      const lastRoot = newRootIds[newRootIds.length - 1] ?? null;
      if (newBoundPrimIds.length > 0) {
        const primary = newBoundPrimIds[newBoundPrimIds.length - 1];
        setSelectedId(primary);
        setAdditionalSelectedIds(newBoundPrimIds.slice(0, -1));
      } else {
        setSelectedId(null);
        setAdditionalSelectedIds([]);
      }
      setSelectedMeshUid(null);
      setSubMeshInfo(null);
      setInspectorSelection(null);
      setSelectedInstanceId(lastRoot);
    },
    [ontologyDoc, bindings, prims]
  );

  const handleDeleteInstancesMany = useCallback(
    (entityIds: string[]) => {
      if (entityIds.length === 0) return;
      // Walk HasChild + HasUSD edges to collect the full doomed set of
      // entity ids, then drop their prims and bindings in lockstep.
      const rels = ontologyDoc.instances.relationships;
      const doomed = new Set<string>(entityIds);
      const stack = [...entityIds];
      while (stack.length > 0) {
        const cur = stack.pop()!;
        for (const r of rels) {
          if (
            (r.type === 'HasChild' || r.type === 'HasUSD') &&
            r.source === cur &&
            !doomed.has(r.target)
          ) {
            doomed.add(r.target);
            stack.push(r.target);
          }
        }
      }
      const primIdsToDelete: string[] = [];
      for (const eid of doomed) {
        const b = bindings[eid];
        if (b?.guid) primIdsToDelete.push(b.guid);
      }
      setOntologyDoc((cur) => {
        let next = cur;
        for (const eid of entityIds) next = removeEntityInstance(next, eid);
        return next;
      });
      setBindings((cur) => {
        let next = cur;
        for (const eid of doomed) {
          if (eid in next) {
            if (next === cur) next = { ...cur };
            delete next[eid];
          }
        }
        return next;
      });
      if (primIdsToDelete.length > 0) handleDeleteMany(primIdsToDelete);
      if (selectedInstanceId && doomed.has(selectedInstanceId)) {
        setSelectedInstanceId(null);
      }
    },
    [ontologyDoc, bindings, handleDeleteMany, selectedInstanceId]
  );

  const handleCommitInstanceRename = useCallback(
    (id: string, newName: string) => {
      const trimmed = newName.trim();
      if (trimmed) {
        setOntologyDoc((cur) => renameEntityInstance(cur, id, trimmed));
      }
      setEditingInstanceId(null);
    },
    []
  );
  const handleCancelInstanceRename = useCallback(
    () => setEditingInstanceId(null),
    []
  );

  const handleAddInstance = useCallback(
    (x: number, y: number) => {
      setMenu({
        x,
        y,
        items: [
          {
            label: 'Add instance',
            submenu: buildTypePickerSubmenu('root', null, (type) =>
              addInstanceOfType(type, null)
            )
          }
        ]
      });
    },
    [buildTypePickerSubmenu, addInstanceOfType]
  );

  const handleModelContextMenu = useCallback(
    (typeName: string, parentName: string | null, x: number, y: number) => {
      if (!typeName) {
        setMenu({
          x,
          y,
          items: [{ label: 'Add type', onClick: () => handleAddType(null) }]
        });
        return;
      }
      const rels = ontologyDoc.model?.relationships ?? [];
      const parents = rels
        .filter((r) => r.type === 'HasChild' && r.target === typeName)
        .map((r) => r.source);
      const detachItems: ContextMenuItem[] = [];
      if (parentName && parents.includes(parentName)) {
        detachItems.push({
          label: `Detach from ${parentName}`,
          onClick: () =>
            setOntologyDoc((cur) =>
              removeEntityTypeParent(cur, typeName, parentName)
            )
        });
      }
      for (const p of parents) {
        if (p === parentName) continue;
        detachItems.push({
          label: `Detach from ${p}`,
          onClick: () =>
            setOntologyDoc((cur) => removeEntityTypeParent(cur, typeName, p))
        });
      }
      if (parents.length > 1) {
        detachItems.push({
          label: 'Make root (clear all parents)',
          onClick: () =>
            setOntologyDoc((cur) => setEntityTypeParent(cur, typeName, null))
        });
      } else if (parents.length === 1 && !parentName) {
        // Defensive fallback: if the panel didn't supply a parent context but
        // the type has exactly one parent, still offer a simple detach.
        detachItems.push({
          label: `Detach from ${parents[0]}`,
          onClick: () =>
            setOntologyDoc((cur) =>
              removeEntityTypeParent(cur, typeName, parents[0])
            )
        });
      }
      setMenu({
        x,
        y,
        items: [
          {
            label: `Add child type under ${typeName}`,
            onClick: () => handleAddType(typeName)
          },
          { label: 'Rename', onClick: () => setEditingType(typeName) },
          {
            label: 'Move up',
            onClick: () =>
              setOntologyDoc((cur) => moveEntityType(cur, typeName, -1))
          },
          {
            label: 'Move down',
            onClick: () =>
              setOntologyDoc((cur) => moveEntityType(cur, typeName, 1))
          },
          ...detachItems,
          {
            label: 'Delete',
            destructive: true,
            onClick: () =>
              setOntologyDoc((cur) => removeEntityType(cur, typeName))
          }
        ]
      });
    },
    [handleAddType, ontologyDoc]
  );

  const handleInstanceContextMenu = useCallback(
    (entityId: string | null, x: number, y: number) => {
      if (!entityId) {
        setMenu({
          x,
          y,
          items: [
            {
              label: 'Add instance',
              submenu: buildTypePickerSubmenu('root', null, (type) =>
                addInstanceOfType(type, null)
              )
            }
          ]
        });
        return;
      }
      const parentEntity = ontologyDoc.instances.entities.find(
        (e) => e.id === entityId
      );
      const parentTypeName = parentEntity?.type ?? null;
      // If the right-clicked entity is part of the current multi-selection,
      // operate on the whole selection; otherwise just on the clicked one.
      const targetIds = selectedEntityIds.includes(entityId)
        ? selectedEntityIds
        : [entityId];
      const n = targetIds.length;
      setMenu({
        x,
        y,
        items: [
          {
            label: 'Add child instance',
            submenu: buildTypePickerSubmenu('children', parentTypeName, (type) =>
              addInstanceOfType(type, entityId)
            )
          },
          { label: 'Rename', onClick: () => setEditingInstanceId(entityId) },
          {
            label: n > 1 ? `Duplicate (${n})` : 'Duplicate',
            onClick: () => handleDuplicateInstancesMany(targetIds)
          },
          {
            label: n > 1 ? `Delete (${n})` : 'Delete',
            destructive: true,
            onClick: () => handleDeleteInstancesMany(targetIds)
          }
        ]
      });
    },
    [
      buildTypePickerSubmenu,
      addInstanceOfType,
      handleDuplicateInstancesMany,
      handleDeleteInstancesMany,
      ontologyDoc,
      selectedEntityIds
    ]
  );

  return (
    <div className={`layout${mode === 'scene-editor' ? ' is-scene-editor' : ''}`}>
      <TopBar
        sceneName={sceneName}
        onSceneNameChange={setSceneName}
        onExport={handleExport}
        onImport={handleImport}
        theme={theme}
        onThemeChange={setTheme}
        mode={mode}
        onModeChange={setMode}
      />
      <main className="viewport-area">
        <Viewport
          prims={prims}
          tool={tool}
          selectedId={selectedId}
          selectedIds={selectedIds}
          selectedMeshUid={selectedMeshUid}
          theme={theme}
          focusSignal={focusSignal}
          snapEnabled={snapEnabled}
          onShapeDropped={handleShapeDropped}
          onAssetDropped={handleAssetDropped}
          onSelect={handleViewportSelect}
          onTransform={handleTransform}
          onTransformMany={handleTransformMany}
          onAssetMeshesLoaded={handleAssetMeshesLoaded}
          onSubMeshInfoChange={setSubMeshInfo}
          onContextMenu={handleContextMenu}
          onBeginTransformBatch={handleBeginTransformBatch}
          onEndTransformBatch={handleEndTransformBatch}
          dropEnabled={mode !== 'scene-editor'}
        />
        <LeftToolbar
          tool={tool}
          onToolChange={setTool}
          onFocus={handleFocus}
          snapEnabled={snapEnabled}
          onSnapToggle={() => setSnapEnabled((v) => !v)}
          sceneOpen={sceneOpen}
          onToggleScene={() => setSceneOpen((v) => !v)}
          readOnly={mode === 'scene-editor'}
        />
      </main>
      <HierarchyPanel
        prims={prims}
        selectedId={selectedId}
        selectedIds={selectedIds}
        selectedMeshUid={selectedMeshUid}
        assetMeshes={assetMeshes}
        mappedByPrimId={mappedByPrimId}
        onSelect={handleSelect}
        onReparent={handleReparent}
        onShapeAdd={handleShapeAddToParent}
        onAssetAdd={handleAssetAddToParent}
        onDelete={handleDelete}
        onContextMenu={handleContextMenu}
        isOpen={sceneOpen}
        onClose={() => setSceneOpen(false)}
        readOnly={mode === 'scene-editor'}
      />
      <PropertiesPanel
        prim={selectedPrim}
        subMesh={subMeshInfo}
        mappedTo={selectedPrim ? mappedByPrimId.get(selectedPrim.id) ?? null : null}
        onUpdate={handleUpdate}
        modelType={selectedModelType}
        modelRelationship={selectedModelRelationship}
        entityInstance={selectedInstance}
        entityUsdChild={selectedInstanceUsdChild}
        entityUsdChildGuid={
          selectedInstanceUsdChild
            ? bindings[selectedInstanceUsdChild.id]?.guid ?? null
            : null
        }
        entityUsdChildPrim={selectedInstanceUsdChildPrim}
        onRenameModelType={handleRenameModelTypeFromProps}
        onUpdateModelType={handleUpdateModelType}
        onUpdateModelRelationship={handleUpdateModelRelationship}
        onUpdateEntityInstance={handleUpdateEntityInstance}
        resolvePrimAsUsd={(primId) => resolvePrimAsAsset(primId)?.usdaUrl ?? null}
        onRebindUsdPrim={handleRebindUsdInstancePrim}
        condition={selectedCondition}
        onUpdateCondition={handleUpdateCondition}
        readOnly={mode === 'scene-editor' && !selectedCondition}
      />
      <div className="left-stack">
        {mode === 'scene-editor' && (
          <ConditionsPanel
            conditions={conditions}
            selectedConditionId={selectedConditionId}
            onAdd={handleAddCondition}
            onSelect={handleSelectCondition}
            onDelete={handleDeleteCondition}
            onContextMenu={handleConditionContextMenu}
          />
        )}
        <EntityModelsPanel
          roots={modelRoots}
          modelRelationships={modelRelationships}
          selectedTypeName={
            inspectorSelection?.kind === 'model-type'
              ? inspectorSelection.name
              : null
          }
          selectedRelationshipIndex={
            inspectorSelection?.kind === 'model-relationship'
              ? inspectorSelection.index
              : null
          }
          instanceCountByType={instanceCountByType}
          onAddType={() => handleAddType(null)}
          onSelectType={handleSelectModelType}
          onSelectRelationship={handleSelectModelRelationship}
          onContextMenu={handleModelContextMenu}
          editingName={editingType}
          onCommitRename={handleCommitTypeRename}
          onCancelRename={handleCancelTypeRename}
          onReparent={handleReparentType}
          canReparent={canReparentType}
          readOnly={mode === 'scene-editor'}
        />
        <OntologyPanel
          roots={ontology.roots}
          bindings={bindings}
          selectedEntityId={collapseUsdChildToParent(selectedInstanceId ?? selectedEntityId)}
          selectedEntityIds={selectedEntityIds}
          onBind={handleBind}
          onSelectEntity={handleSelectOntologyEntity}
          resolvePrimAsAsset={resolvePrimAsAsset}
          onAttachUsd={handleAttachUsdToInstance}
          onRebindUsdPrim={handleRebindUsdInstancePrim}
          onAddInstance={handleAddInstance}
          onContextMenu={handleInstanceContextMenu}
          editingId={editingInstanceId}
          onCommitRename={handleCommitInstanceRename}
          onCancelRename={handleCancelInstanceRename}
          onReparent={handleReparentInstance}
          canReparent={canReparentInstance}
          readOnly={mode === 'scene-editor'}
        />
      </div>
      {mode !== 'scene-editor' && <BottomPanel />}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          items={menu.items}
        />
      )}
    </div>
  );
}
