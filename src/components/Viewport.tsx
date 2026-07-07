import { useEffect, useRef, useState } from 'react';
import type { AssetContainer } from '@babylonjs/core/assetContainer';
import { Camera } from '@babylonjs/core/Cameras/camera';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Engine } from '@babylonjs/core/Engines/engine';
import { PointerEventTypes } from '@babylonjs/core/Events/pointerEvents';
import { GizmoManager } from '@babylonjs/core/Gizmos/gizmoManager';
import type { IPositionGizmo } from '@babylonjs/core/Gizmos/positionGizmo';
import type { IRotationGizmo } from '@babylonjs/core/Gizmos/rotationGizmo';
import type { IScaleGizmo } from '@babylonjs/core/Gizmos/scaleGizmo';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { Material } from '@babylonjs/core/Materials/material';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import '@babylonjs/core/Culling/ray';
import type { LinesMesh } from '@babylonjs/core/Meshes/linesMesh';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Node } from '@babylonjs/core/node';
import { Scene } from '@babylonjs/core/scene';
import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { RegisterGLTFFileLoader } from '@babylonjs/loaders/glTF/glTFFileLoader.pure';
import { RegisterGLTF2Loader } from '@babylonjs/loaders/glTF/2.0/glTFLoader.pure';
import { OBJFileLoader, RegisterOBJFileLoader } from '@babylonjs/loaders/OBJ/objFileLoader.pure';
import { GridMaterial } from '@babylonjs/materials/grid/gridMaterial';
import type { AssetMeshNode, PrimNode, PrimTransform, ShapeKind, SubMeshInfo, ToolMode } from '../types';
import { ASSET_DRAG_MIME, SHAPE_DRAG_MIME } from '../shapes';
import { resolveAssetUrl } from '../assets';
import CameraControls, { type CameraView } from './CameraControls';

let objLoaderConfigured = false;
let sceneLoadersRegistered = false;
function ensureSceneLoadersRegistered(): void {
  if (sceneLoadersRegistered) return;
  RegisterGLTF2Loader();
  RegisterGLTFFileLoader();
  RegisterOBJFileLoader();
  sceneLoadersRegistered = true;
}
function ensureObjLoaderDefaults(): void {
  if (objLoaderConfigured) return;
  // - OPTIMIZE_WITH_UV=true (the default) merges vertices across smoothing
  //   groups and breaks shading on dense meshes (e.g. the hospital bed).
  // - COMPUTE_NORMALS recomputes normals from face geometry, sidestepping any
  //   bad/incomplete `vn` data in exported OBJs.
  // - OPTIMIZE_NORMALS averages duplicated normals so the recomputed shading
  //   stays smooth across the merged vertex set.
  OBJFileLoader.OPTIMIZE_WITH_UV = false;
  OBJFileLoader.COMPUTE_NORMALS = true;
  OBJFileLoader.OPTIMIZE_NORMALS = true;
  objLoaderConfigured = true;
}

interface Props {
  prims: PrimNode[];
  tool: ToolMode;
  selectedId: string | null;
  /** Full multi-selection set (always includes `selectedId` when set). Each
   *  prim in this list is outlined; when the position gizmo is dragged the
   *  group moves together. The "primary" of the selection — the one the
   *  gizmo actually attaches to — is `selectedId`. */
  selectedIds: string[];
  /** When set, identifies a specific sub-mesh inside a loaded reference
   *  asset (GLB/OBJ) that should be highlighted instead of the whole prim. */
  selectedMeshUid: string | null;
  theme: 'dark' | 'light';
  /** Bump to reset the camera to its initial view (Focus button / F hotkey). */
  focusSignal: number;
  onShapeDropped: (kind: ShapeKind, position: [number, number, number]) => void;
  onAssetDropped: (assetId: string, position: [number, number, number]) => void;
  onSelect: (
    id: string | null,
    meshUid?: string | null,
    additive?: boolean
  ) => void;
  onTransform: (id: string, t: Partial<PrimTransform>) => void;
  /** Batch transform writer used after a group move so the secondary
   *  selection's new positions land in a single setPrims commit. */
  onTransformMany: (
    updates: Array<{ id: string; t: Partial<PrimTransform> }>
  ) => void;
  /** Called whenever a reference prim's GLB/OBJ has finished loading (or has
   *  been cleared because its source changed). `nodes` is empty when the
   *  asset is being reset. */
  onAssetMeshesLoaded: (primId: string, nodes: AssetMeshNode[]) => void;
  /** Called with read-only pose data for the currently selected sub-mesh
   *  (a node inside a loaded reference asset). Null when no sub-mesh is
   *  selected — i.e. the selection is a top-level prim or nothing. */
  onSubMeshInfoChange: (info: SubMeshInfo | null) => void;
  /** When false, gizmo drags move/rotate/scale continuously instead of
   *  snapping to the grid / 5° / 0.25 increments. */
  snapEnabled: boolean;
  /** Fired on right-click over a mesh; coords are page-space. Empty space
   *  right-clicks are ignored (no menu shown). */
  onContextMenu: (primId: string, x: number, y: number) => void;
  /** Called when the user mousedowns on a gizmo handle to start a
   *  position/rotation/scale drag. Lets App open a single undo batch so
   *  every per-tick transform commit collapses into one history entry
   *  representing the pre-drag state. */
  onBeginTransformBatch: () => void;
  /** Called when the user releases the gizmo. Closes the open undo batch
   *  so a single entry is pushed using the snapshot captured at
   *  onBeginTransformBatch time. */
  onEndTransformBatch: () => void;
  /** When false, palette / hierarchy drag sources are no longer accepted as
   *  drops on the canvas. Used by Scene Editor mode (the scene is
   *  read-only — geometry comes from the ontology, not user drops). */
  dropEnabled?: boolean;
}

// Translation snap = the grid's minor tick (FR-14.3 in the spec: 1 m).
const POSITION_SNAP = 1;
// Rotation snap = 5 degrees per drag tick.
const ROTATION_SNAP = (5 * Math.PI) / 180;
// Scale snap kept fine-grained; not asked for explicitly but matches the move-snap feel.
const SCALE_SNAP = 0.25;
const SELECTION_COLOR = new Color3(0.35, 0.7, 1);
// Alpha used by the renderOverlay tint on selected meshes. Low enough that
// the underlying material/textures still read through, high enough that the
// selection is obvious. Tweak together with SELECTION_COLOR if either feels
// off.
const SELECTION_OVERLAY_ALPHA = 0.25;

// Match the origin axis lines below so gizmo colors read as the same axes.
const AXIS_COLORS = {
  x: new Color3(0.85, 0.25, 0.25),
  y: new Color3(0.3, 0.85, 0.35),
  z: new Color3(0.3, 0.55, 0.95)
} as const;
const HIDDEN_THIN_INSTANCE = Matrix.Scaling(0, 0, 0);

export default function Viewport({
  prims,
  tool,
  selectedId,
  selectedIds,
  selectedMeshUid,
  theme,
  focusSignal,
  onShapeDropped,
  onAssetDropped,
  onSelect,
  onTransform,
  onTransformMany,
  onAssetMeshesLoaded,
  onSubMeshInfoChange,
  snapEnabled,
  onContextMenu,
  onBeginTransformBatch,
  onEndTransformBatch,
  dropEnabled = true
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<Scene | null>(null);
  const cameraRef = useRef<ArcRotateCamera | null>(null);
  const engineRef = useRef<Engine | null>(null);
  const groundRef = useRef<Mesh | null>(null);
  const gridMatRef = useRef<GridMaterial | null>(null);
  const meshesRef = useRef<Map<string, Mesh>>(new Map());
  const materialsRef = useRef<Map<string, StandardMaterial>>(new Map());
  /** Sub-mesh registry: babylon uniqueId (stringified) -> Node, for every
   *  node inside a loaded reference asset (TransformNodes for groups,
   *  AbstractMeshes for leaves). Used to map clicks to a specific sub-mesh
   *  and to outline a sub-mesh (or every descendant of an intermediate
   *  group node) when selected. */
  const subMeshRegistryRef = useRef<Map<string, Node>>(new Map());
  const gizmoMgrRef = useRef<GizmoManager | null>(null);
  const ensureSnapRef = useRef<() => void>(() => {});
  const lastPositionGizmoRef = useRef<IPositionGizmo | null>(null);
  const lastRotationGizmoRef = useRef<IRotationGizmo | null>(null);
  const lastScaleGizmoRef = useRef<IScaleGizmo | null>(null);
  // Prim ids whose meshes are currently being driven by a live gizmo drag.
  // Reconcile skips re-writing transforms for these so the per-tick state
  // commits don't race the gizmo / direct mesh writes and snap them back.
  const draggingIdsRef = useRef<Set<string>>(new Set());

  // Tool mode tracked in a ref so the once-attached pointer observable can
  // branch on the current tool without being re-attached.
  const toolRef = useRef<ToolMode>(tool);
  useEffect(() => {
    toolRef.current = tool;
  }, [tool]);

  // Measurement tool state. start/end are world-space points; null means
  // "waiting for that click". Visuals (spheres, dashed line) are owned by
  // refs so the once-attached pointer/render listeners can update them
  // without React re-renders.
  const measureRef = useRef<{
    start: Vector3 | null;
    end: Vector3 | null;
    committed: boolean;
  }>({ start: null, end: null, committed: false });
  const measureMarkersRef = useRef<Mesh | null>(null);
  const measureMarkerMatricesRef = useRef<Float32Array | null>(null);
  const measureLineRef = useRef<LinesMesh | null>(null);
  const measureLabelRef = useRef<HTMLDivElement | null>(null);
  const clearMeasurementRef = useRef<() => void>(() => {});

  const [cameraView, setCameraView] = useState<CameraView>('perspective');
  // Outstanding async reference-asset loads (OBJ/GLB). Drives the loader bar
  // overlay; >0 means at least one reference prim is still loading. The
  // counter is bumped inside the reconcile effect's `loadReference` wrapper
  // and decremented in a finally so a failed load also clears it.
  const [loadingCount, setLoadingCount] = useState(0);

  // Latest callbacks captured so the once-attached listeners always see fresh state.
  const onDropRef = useRef(onShapeDropped);
  const onAssetDropRef = useRef(onAssetDropped);
  const onSelectRef = useRef(onSelect);
  const onTransformRef = useRef(onTransform);
  const onTransformManyRef = useRef(onTransformMany);
  const onAssetMeshesLoadedRef = useRef(onAssetMeshesLoaded);
  const onSubMeshInfoChangeRef = useRef(onSubMeshInfoChange);
  const onContextMenuRef = useRef(onContextMenu);
  const onBeginTransformBatchRef = useRef(onBeginTransformBatch);
  const onEndTransformBatchRef = useRef(onEndTransformBatch);
  // Latest prim list captured so the canvas right-click handler can walk to
  // the topmost ancestor of whatever was picked.
  const primsRef = useRef<PrimNode[]>(prims);
  // Snap toggle captured so the long-lived ensureSnapRef closure can read
  // the current setting without being rebuilt on every flip.
  const snapEnabledRef = useRef(snapEnabled);
  // Drop-target gating captured so the once-attached canvas listeners can
  // refuse drops in Scene Editor mode without being re-bound.
  const dropEnabledRef = useRef(dropEnabled);
  // Latest selection captured so the focus / frame effect can read it
  // without re-running every time the user clicks something new.
  const selectedIdRef = useRef(selectedId);
  const selectedMeshUidRef = useRef(selectedMeshUid);
  // Multi-selection captured for the position-gizmo's group-move path. The
  // ref is updated by the props effect below; the gizmo's drag observer
  // reads it at drag start to pick up the current "secondary" prims.
  const selectedIdsRef = useRef<string[]>(selectedIds);
  // Currently-outlined meshes. The selection effect diffs against this set
  // so a stable selection across drag ticks does no work. `renderOverlay` is
  // an AbstractMesh property, but we keep this as Set<Mesh> since every
  // outline target we add is a Mesh anyway (group transforms have no
  // geometry to tint).
  const outlinedMeshesRef = useRef<Set<Mesh>>(new Set());
  useEffect(() => {
    onDropRef.current = onShapeDropped;
  }, [onShapeDropped]);
  useEffect(() => {
    onAssetDropRef.current = onAssetDropped;
  }, [onAssetDropped]);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);
  useEffect(() => {
    onTransformRef.current = onTransform;
  }, [onTransform]);
  useEffect(() => {
    onTransformManyRef.current = onTransformMany;
  }, [onTransformMany]);
  useEffect(() => {
    onAssetMeshesLoadedRef.current = onAssetMeshesLoaded;
  }, [onAssetMeshesLoaded]);
  useEffect(() => {
    onSubMeshInfoChangeRef.current = onSubMeshInfoChange;
  }, [onSubMeshInfoChange]);
  useEffect(() => {
    onContextMenuRef.current = onContextMenu;
  }, [onContextMenu]);
  useEffect(() => {
    onBeginTransformBatchRef.current = onBeginTransformBatch;
  }, [onBeginTransformBatch]);
  useEffect(() => {
    onEndTransformBatchRef.current = onEndTransformBatch;
  }, [onEndTransformBatch]);
  useEffect(() => {
    primsRef.current = prims;
  }, [prims]);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);
  useEffect(() => {
    selectedMeshUidRef.current = selectedMeshUid;
  }, [selectedMeshUid]);
  useEffect(() => {
    selectedIdsRef.current = selectedIds;
  }, [selectedIds]);
  // Re-apply snap distances to the live gizmos whenever the toggle flips.
  useEffect(() => {
    snapEnabledRef.current = snapEnabled;
    ensureSnapRef.current();
  }, [snapEnabled]);
  useEffect(() => {
    dropEnabledRef.current = dropEnabled;
  }, [dropEnabled]);

  // One-time scene setup.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const engine = new Engine(canvas, true, {
      preserveDrawingBuffer: true,
      stencil: true,
      antialias: true
    });

    ensureObjLoaderDefaults();
    ensureSceneLoadersRegistered();
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.1, 0.11, 0.13, 1);
    sceneRef.current = scene;

    const camera = new ArcRotateCamera(
      'camera',
      Math.PI / 4,
      Math.PI / 3,
      25,
      Vector3.Zero(),
      scene
    );
    camera.attachControl(canvas, true);
    camera.lowerRadiusLimit = 1;
    camera.upperRadiusLimit = 5000;
    camera.wheelDeltaPercentage = 0.02;
    camera.panningSensibility = 80;
    // Tighter near/far than Babylon's defaults (0.1 / 10000) to keep the
    // depth buffer precise at typical scene scales — fixes the major grid
    // lines "jumping" when the camera moves close to the ground.
    camera.minZ = 0.1;
    camera.maxZ = 2000;
    // Allow orbiting under the floor.
    camera.lowerBetaLimit = -Math.PI;
    camera.upperBetaLimit = Math.PI;
    camera.allowUpsideDown = true;
    cameraRef.current = camera;
    engineRef.current = engine;

    // Keep orthographic bounds in sync with the camera's current radius so
    // the wheel-zoom still feels natural in top/side views.
    scene.onBeforeRenderObservable.add(() => {
      if (camera.mode !== Camera.ORTHOGRAPHIC_CAMERA) return;
      const aspect = engine.getAspectRatio(camera);
      const half = camera.radius * 0.5;
      camera.orthoTop = half;
      camera.orthoBottom = -half;
      camera.orthoLeft = -half * aspect;
      camera.orthoRight = half * aspect;
    });

    const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene);
    hemi.intensity = 1.1;
    hemi.diffuse = new Color3(1, 1, 1);
    hemi.groundColor = new Color3(0.35, 0.38, 0.45);

    const key = new DirectionalLight('key', new Vector3(-0.5, -1, -0.4), scene);
    key.intensity = 1.2;
    key.diffuse = new Color3(1, 0.98, 0.94);

    const groundSize = 1000;
    const ground = MeshBuilder.CreateGround(
      'ground',
      { width: groundSize, height: groundSize, subdivisions: 1 },
      scene
    );
    groundRef.current = ground;

    const grid = new GridMaterial('gridMat', scene);
    grid.majorUnitFrequency = 10;
    grid.minorUnitVisibility = 0.35;
    grid.gridRatio = 1;
    grid.mainColor = new Color3(0.1, 0.11, 0.13);
    grid.lineColor = new Color3(0.6, 0.65, 0.75);
    grid.opacity = 0.25;
    grid.backFaceCulling = false;
    // Logarithmic depth avoids z-fighting / "jumping" major grid lines as
    // the camera moves around the origin. Without it, the depth precision
    // near the ground plane is too coarse and lines snap between texels.
    grid.useLogarithmicDepth = true;
    ground.material = grid;
    ground.alphaIndex = 0;
    gridMatRef.current = grid;
    scene.onBeforeRenderObservable.add(() => {
      // Babylon warns when logarithmic depth is used with orthographic cameras.
      // Keep it enabled for perspective (better depth precision), disabled for ortho.
      const useLogDepth = camera.mode !== Camera.ORTHOGRAPHIC_CAMERA;
      if (grid.useLogarithmicDepth !== useLogDepth) {
        grid.useLogarithmicDepth = useLogDepth;
      }
    });

    const axisLength = 2;
    const xAxis = MeshBuilder.CreateLines(
      'xAxis',
      { points: [new Vector3(0, 0.001, 0), new Vector3(axisLength, 0.001, 0)] },
      scene
    );
    xAxis.color = new Color3(0.85, 0.25, 0.25);
    xAxis.isPickable = false;
    // Draw axis lines in a higher rendering group so they sit cleanly above
    // the GridMaterial ground without depth-fighting.
    xAxis.renderingGroupId = 1;

    const zAxis = MeshBuilder.CreateLines(
      'zAxis',
      { points: [new Vector3(0, 0.001, 0), new Vector3(0, 0.001, axisLength)] },
      scene
    );
    zAxis.color = new Color3(0.3, 0.55, 0.95);
    zAxis.isPickable = false;
    zAxis.renderingGroupId = 1;

    const yAxis = MeshBuilder.CreateLines(
      'yAxis',
      { points: [new Vector3(0, 0.001, 0), new Vector3(0, axisLength, 0)] },
      scene
    );
    yAxis.color = new Color3(0.3, 0.85, 0.35);
    yAxis.isPickable = false;
    yAxis.renderingGroupId = 1;

    // Selection is driven by us (click in viewport or in the hierarchy panel),
    // not by the gizmo manager's own pointer handling.
    const gizmoMgr = new GizmoManager(scene);
    gizmoMgr.usePointerToAttachGizmos = false;
    gizmoMgr.positionGizmoEnabled = false;
    gizmoMgr.rotationGizmoEnabled = false;
    gizmoMgr.scaleGizmoEnabled = false;
    gizmoMgrRef.current = gizmoMgr;

    const commitFromMesh = () => {
      const m = gizmoMgr.attachedMesh;
      if (!m) return;
      const id = (m.metadata as { primId?: string } | undefined)?.primId;
      if (!id) return;
      // Meshes always carry a rotationQuaternion (see reconcile), since the
      // RotationGizmo only manipulates the quaternion. Convert it back to
      // Euler radians for our state model.
      const e = m.rotationQuaternion
        ? m.rotationQuaternion.toEulerAngles()
        : m.rotation;
      onTransformRef.current(id, {
        position: [m.position.x, m.position.y, m.position.z],
        rotation: [e.x, e.y, e.z],
        scale: [m.scaling.x, m.scaling.y, m.scaling.z]
      });
    };

    // Group-move bookkeeping for the position gizmo. We capture the primary
    // mesh + each secondary mesh's world position at drag start, then mirror
    // the primary's world-space delta onto every secondary mesh on every
    // drag tick. Drag end commits the new local positions in a single batch.
    // Only "independent" secondaries are tracked — i.e. ones whose ancestor
    // chain doesn't contain any other selected prim, so we don't translate
    // a child both via its parent and again on its own.
    type GroupMoveEntry = {
      mesh: AbstractMesh;
      primId: string;
      startWorld: Vector3;
    };
    let groupMoveStart: {
      primaryStart: Vector3;
      others: GroupMoveEntry[];
    } | null = null;

    const independentSelectedIds = (allIds: string[]): string[] => {
      const set = new Set(allIds);
      const byId = new Map(
        primsRef.current.map((p) => [p.id, p] as const)
      );
      return allIds.filter((id) => {
        let cur = byId.get(id);
        let parent = cur?.parentId ?? null;
        while (parent) {
          if (set.has(parent)) return false;
          cur = byId.get(parent);
          parent = cur?.parentId ?? null;
        }
        return true;
      });
    };

    const markAttachedDragging = () => {
      const m = gizmoMgr.attachedMesh;
      const id = (m?.metadata as { primId?: string } | undefined)?.primId;
      if (id) draggingIdsRef.current.add(id);
    };
    const unmarkAttachedDragging = () => {
      const m = gizmoMgr.attachedMesh;
      const id = (m?.metadata as { primId?: string } | undefined)?.primId;
      if (id) draggingIdsRef.current.delete(id);
    };

    const onPositionDragStart = () => {
      // Open a single undo batch so every per-tick transform commit during
      // the drag collapses into one history entry (using the snapshot from
      // BEFORE the drag).
      onBeginTransformBatchRef.current();
      const primary = gizmoMgr.attachedMesh;
      if (!primary) {
        groupMoveStart = null;
        return;
      }
      const primaryId = (primary.metadata as { primId?: string } | undefined)
        ?.primId;
      // Mark the primary as live-driven so reconcile doesn't fight the
      // gizmo when we commit its position every drag tick.
      if (primaryId) draggingIdsRef.current.add(primaryId);
      const all = selectedIdsRef.current;
      if (!primaryId || all.length <= 1) {
        groupMoveStart = null;
        return;
      }
      const others: GroupMoveEntry[] = [];
      for (const id of independentSelectedIds(all)) {
        if (id === primaryId) continue;
        const mesh = meshesRef.current.get(id);
        if (!mesh) continue;
        // Force fresh world matrices so the captured start positions match
        // the live scene state, not a stale cache.
        mesh.computeWorldMatrix(true);
        others.push({
          mesh,
          primId: id,
          startWorld: mesh.getAbsolutePosition().clone()
        });
        draggingIdsRef.current.add(id);
      }
      if (others.length === 0) {
        groupMoveStart = null;
        return;
      }
      primary.computeWorldMatrix(true);
      groupMoveStart = {
        primaryStart: primary.getAbsolutePosition().clone(),
        others
      };
    };

    const onPositionDrag = () => {
      // Move secondaries first so they stay perfectly in sync with the
      // primary on the current frame. We DO NOT commit secondaries to React
      // state on every tick — that round-trips through render+reconcile and
      // visibly lags behind the gizmo. The drag-end handler commits them in
      // one batch instead. The primary's state is still committed live so
      // the Properties panel inputs follow along.
      const state = groupMoveStart;
      if (state) {
        const primary = gizmoMgr.attachedMesh;
        if (primary) {
          // getAbsolutePosition() returns a cached value; force a fresh
          // world-matrix compute so the delta below reflects THIS frame's
          // gizmo translation, not the previous frame's. Without this the
          // secondaries trail by a frame and drag-end commits them short.
          primary.computeWorldMatrix(true);
          const cur = primary.getAbsolutePosition();
          const dx = cur.x - state.primaryStart.x;
          const dy = cur.y - state.primaryStart.y;
          const dz = cur.z - state.primaryStart.z;
          for (const o of state.others) {
            const targetWorld = new Vector3(
              o.startWorld.x + dx,
              o.startWorld.y + dy,
              o.startWorld.z + dz
            );
            const parent = o.mesh.parent;
            if (parent && parent instanceof TransformNode) {
              parent.computeWorldMatrix(true);
              const inv = Matrix.Invert(parent.getWorldMatrix());
              const local = Vector3.TransformCoordinates(targetWorld, inv);
              o.mesh.position.copyFrom(local);
            } else {
              o.mesh.position.copyFrom(targetWorld);
            }
            o.mesh.computeWorldMatrix(true);
          }
        }
      }
      // Commit the primary's pose so Properties inputs update live.
      commitFromMesh();
    };

    const onPositionDragEnd = () => {
      // Run one final group-sync from the primary's FINAL world position so
      // the secondaries match exactly. The last onPositionDrag tick may have
      // run before Babylon settled the gizmo on its release frame.
      const state = groupMoveStart;
      const primaryMesh = gizmoMgr.attachedMesh;
      if (state && primaryMesh) {
        primaryMesh.computeWorldMatrix(true);
        const cur = primaryMesh.getAbsolutePosition();
        const dx = cur.x - state.primaryStart.x;
        const dy = cur.y - state.primaryStart.y;
        const dz = cur.z - state.primaryStart.z;
        for (const o of state.others) {
          const targetWorld = new Vector3(
            o.startWorld.x + dx,
            o.startWorld.y + dy,
            o.startWorld.z + dz
          );
          const parent = o.mesh.parent;
          if (parent && parent instanceof TransformNode) {
            parent.computeWorldMatrix(true);
            const inv = Matrix.Invert(parent.getWorldMatrix());
            const local = Vector3.TransformCoordinates(targetWorld, inv);
            o.mesh.position.copyFrom(local);
          } else {
            o.mesh.position.copyFrom(targetWorld);
          }
        }
      }
      // Commit the primary first via the shared single-target path, then
      // batch-commit every secondary mesh in one state update.
      commitFromMesh();
      groupMoveStart = null;
      const primaryId = (
        primaryMesh?.metadata as { primId?: string } | undefined
      )?.primId;
      if (primaryId) draggingIdsRef.current.delete(primaryId);
      if (!state) {
        // Single-selection drag still needs to close the undo batch that
        // onPositionDragStart opened — otherwise batchingRef stays set
        // forever and subsequent edits never produce a history entry.
        onEndTransformBatchRef.current();
        return;
      }
      const updates: Array<{
        id: string;
        t: Partial<PrimTransform>;
      }> = state.others.map((o) => ({
        id: o.primId,
        t: {
          position: [o.mesh.position.x, o.mesh.position.y, o.mesh.position.z]
        }
      }));
      for (const o of state.others) draggingIdsRef.current.delete(o.primId);
      onTransformManyRef.current(updates);
      // Close the undo batch opened in onPositionDragStart. Done after the
      // batch commit so the final state lands before the snapshot record.
      onEndTransformBatchRef.current();
    };

    // Group-rotate bookkeeping for the rotation gizmo. Mirrors the position
    // group-move flow: capture each independent secondary's world pose at
    // drag start, then on every tick rotate them by the primary's world-
    // space delta quaternion around the primary's start pivot.
    type GroupRotateEntry = {
      mesh: AbstractMesh;
      primId: string;
      startWorldPos: Vector3;
      startWorldRot: Quaternion;
    };
    let groupRotateStart: {
      primaryStartPos: Vector3;
      primaryStartRotInv: Quaternion;
      others: GroupRotateEntry[];
    } | null = null;

    const onRotationDragStart = () => {
      onBeginTransformBatchRef.current();
      const primary = gizmoMgr.attachedMesh;
      if (!primary) {
        groupRotateStart = null;
        return;
      }
      const primaryId = (primary.metadata as { primId?: string } | undefined)
        ?.primId;
      if (primaryId) draggingIdsRef.current.add(primaryId);
      const all = selectedIdsRef.current;
      if (!primaryId || all.length <= 1) {
        groupRotateStart = null;
        return;
      }
      const others: GroupRotateEntry[] = [];
      for (const id of independentSelectedIds(all)) {
        if (id === primaryId) continue;
        const mesh = meshesRef.current.get(id);
        if (!mesh) continue;
        mesh.computeWorldMatrix(true);
        others.push({
          mesh,
          primId: id,
          startWorldPos: mesh.getAbsolutePosition().clone(),
          startWorldRot: mesh.absoluteRotationQuaternion.clone()
        });
        draggingIdsRef.current.add(id);
      }
      if (others.length === 0) {
        groupRotateStart = null;
        return;
      }
      primary.computeWorldMatrix(true);
      groupRotateStart = {
        primaryStartPos: primary.getAbsolutePosition().clone(),
        primaryStartRotInv: Quaternion.Inverse(
          primary.absoluteRotationQuaternion
        ),
        others
      };
    };

    const applyGroupRotate = () => {
      const state = groupRotateStart;
      if (!state) return;
      const primary = gizmoMgr.attachedMesh;
      if (!primary) return;
      primary.computeWorldMatrix(true);
      // World delta: primaryNow * inverse(primaryStart). Applied first to
      // each secondary's world rotation and then to the offset vector from
      // the primary's start pivot so the whole group rotates rigidly.
      const deltaWorld = primary.absoluteRotationQuaternion.multiply(
        state.primaryStartRotInv
      );
      const pivot = state.primaryStartPos;
      for (const o of state.others) {
        const offset = o.startWorldPos.subtract(pivot);
        const rotatedOffset = new Vector3();
        offset.rotateByQuaternionToRef(deltaWorld, rotatedOffset);
        const targetWorldPos = pivot.add(rotatedOffset);
        const targetWorldRot = deltaWorld.multiply(o.startWorldRot);
        const parent = o.mesh.parent;
        if (parent && parent instanceof TransformNode) {
          parent.computeWorldMatrix(true);
          const parentWorld = parent.getWorldMatrix();
          const invParent = Matrix.Invert(parentWorld);
          const localPos = Vector3.TransformCoordinates(
            targetWorldPos,
            invParent
          );
          o.mesh.position.copyFrom(localPos);
          const parentScale = new Vector3();
          const parentRot = new Quaternion();
          const parentPos = new Vector3();
          parentWorld.decompose(parentScale, parentRot, parentPos);
          const localRot = Quaternion.Inverse(parentRot).multiply(targetWorldRot);
          if (!o.mesh.rotationQuaternion) {
            o.mesh.rotationQuaternion = new Quaternion();
          }
          o.mesh.rotationQuaternion.copyFrom(localRot);
        } else {
          o.mesh.position.copyFrom(targetWorldPos);
          if (!o.mesh.rotationQuaternion) {
            o.mesh.rotationQuaternion = new Quaternion();
          }
          o.mesh.rotationQuaternion.copyFrom(targetWorldRot);
        }
        o.mesh.computeWorldMatrix(true);
      }
    };

    const onRotationDrag = () => {
      applyGroupRotate();
      commitFromMesh();
    };

    const onRotationDragEnd = () => {
      applyGroupRotate();
      commitFromMesh();
      const state = groupRotateStart;
      groupRotateStart = null;
      const primaryMesh = gizmoMgr.attachedMesh;
      const primaryId = (
        primaryMesh?.metadata as { primId?: string } | undefined
      )?.primId;
      if (primaryId) draggingIdsRef.current.delete(primaryId);
      if (!state) {
        onEndTransformBatchRef.current();
        return;
      }
      const updates: Array<{
        id: string;
        t: Partial<PrimTransform>;
      }> = state.others.map((o) => {
        const e = o.mesh.rotationQuaternion
          ? o.mesh.rotationQuaternion.toEulerAngles()
          : o.mesh.rotation;
        return {
          id: o.primId,
          t: {
            position: [
              o.mesh.position.x,
              o.mesh.position.y,
              o.mesh.position.z
            ],
            rotation: [e.x, e.y, e.z]
          }
        };
      });
      for (const o of state.others) draggingIdsRef.current.delete(o.primId);
      onTransformManyRef.current(updates);
      onEndTransformBatchRef.current();
    };

    // Gizmos are lazily (re-)created when the manager enables them, so we
    // re-apply snap and hook the commit callback whenever a new gizmo instance shows up.
    ensureSnapRef.current = () => {
      const snap = snapEnabledRef.current;
      const p = gizmoMgr.gizmos.positionGizmo;
      if (p) {
        p.snapDistance = snap ? POSITION_SNAP : 0;
        if (p !== lastPositionGizmoRef.current) {
          p.onDragStartObservable.add(onPositionDragStart);
          p.onDragObservable.add(onPositionDrag);
          p.onDragEndObservable.add(onPositionDragEnd);
          lastPositionGizmoRef.current = p;
        }
      }
      const r = gizmoMgr.gizmos.rotationGizmo;
      if (r) {
        r.snapDistance = snap ? ROTATION_SNAP : 0;
        if (r !== lastRotationGizmoRef.current) {
          // Keep the rings on world axes. Babylon refuses to track an attached
          // mesh's rotation when its scale is non-uniform and the drag stops
          // responding; world-aligned rings sidestep that entirely.
          r.updateGizmoRotationToMatchAttachedMesh = false;
          r.onDragStartObservable.add(onRotationDragStart);
          r.onDragObservable.add(onRotationDrag);
          r.onDragEndObservable.add(onRotationDragEnd);
          lastRotationGizmoRef.current = r;
        }
      }
      const s = gizmoMgr.gizmos.scaleGizmo;
      if (s) {
        s.snapDistance = snap ? SCALE_SNAP : 0;
        if (s !== lastScaleGizmoRef.current) {
          // Make the drag-to-scale ratio track mouse travel ~1:1 instead of
          // Babylon's default fractional response.
          s.sensitivity = 4;
          s.onDragStartObservable.add(markAttachedDragging);
          s.onDragStartObservable.add(() => onBeginTransformBatchRef.current());
          s.onDragObservable.add(commitFromMesh);
          s.onDragEndObservable.add(unmarkAttachedDragging);
          s.onDragEndObservable.add(commitFromMesh);
          s.onDragEndObservable.add(() => onEndTransformBatchRef.current());
          lastScaleGizmoRef.current = s;
        }
      }
      // Tint runs every time because gizmo subtrees lazily mount their handle
      // meshes; an early one-shot may run before the geometry exists.
      if (p) tintGizmoAxes(p);
      if (r) tintGizmoAxes(r);
      if (s) tintGizmoAxes(s);
    };

    // Pick that snaps to the nearest bounding-box corner of the picked mesh
    // if one is within ~0.5 m of the surface point. Falls back to the raw
    // surface point (or the floor pick). Returns null if nothing was hit.
    const pickMeasurePoint = (): Vector3 | null => {
      const p = scene.pick(scene.pointerX, scene.pointerY);
      if (!p?.hit || !p.pickedPoint) return null;
      const pt = p.pickedPoint;
      const m = p.pickedMesh;
      if (!m || m === ground) return pt.clone();
      const bb = m.getBoundingInfo().boundingBox;
      const corners = bb.vectorsWorld;
      const SNAP = 0.5;
      let best: Vector3 | null = null;
      let bestD = SNAP;
      for (const c of corners) {
        const d = Vector3.Distance(c, pt);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      return (best ?? pt).clone();
    };

    const rebuildMeasureLine = () => {
      const { start, end } = measureRef.current;
      if (measureLineRef.current) {
        measureLineRef.current.dispose();
        measureLineRef.current = null;
      }
      if (!start || !end) return;
      const line = MeshBuilder.CreateDashedLines(
        'measure-line',
        {
          points: [start, end],
          dashSize: 6,
          gapSize: 4,
          dashNb: Math.max(20, Math.floor(Vector3.Distance(start, end) * 8))
        },
        scene
      );
      line.color = new Color3(1, 0.84, 0.27);
      line.isPickable = false;
      line.renderingGroupId = 1;
      measureLineRef.current = line;
    };

    const ensureMeasureMarkers = (): {
      mesh: Mesh;
      matrices: Float32Array;
    } => {
      let mesh = measureMarkersRef.current;
      let matrices = measureMarkerMatricesRef.current;
      if (!mesh || !matrices) {
        mesh = MeshBuilder.CreateSphere(
          'measure-markers',
          { diameter: 0.18 },
          scene
        );
        mesh.isPickable = false;
        mesh.renderingGroupId = 1;
        const mat = new StandardMaterial('measure-markers-mat', scene);
        mat.emissiveColor = new Color3(1, 0.84, 0.27);
        mat.disableLighting = true;
        mesh.material = mat;
        matrices = new Float32Array(16 * 2);
        HIDDEN_THIN_INSTANCE.copyToArray(matrices, 0);
        HIDDEN_THIN_INSTANCE.copyToArray(matrices, 16);
        mesh.thinInstanceSetBuffer('matrix', matrices, 16, true);
        measureMarkersRef.current = mesh;
        measureMarkerMatricesRef.current = matrices;
      }
      return { mesh, matrices };
    };

    const setMeasureMarker = (index: 0 | 1, pos: Vector3 | null) => {
      const { mesh, matrices } = ensureMeasureMarkers();
      if (pos) {
        Matrix.Translation(pos.x, pos.y, pos.z).copyToArray(matrices, index * 16);
      } else {
        HIDDEN_THIN_INSTANCE.copyToArray(matrices, index * 16);
      }
      mesh.thinInstanceBufferUpdated('matrix');
    };

    clearMeasurementRef.current = () => {
      measureRef.current = { start: null, end: null, committed: false };
      setMeasureMarker(0, null);
      setMeasureMarker(1, null);
      if (measureLineRef.current) {
        measureLineRef.current.dispose();
        measureLineRef.current = null;
      }
      if (measureLabelRef.current) measureLabelRef.current.style.display = 'none';
    };

    scene.onPointerObservable.add((info) => {
      // Measurement mode owns clicks: don't select/deselect prims here.
      if (toolRef.current === 'measure') {
        if (info.type === PointerEventTypes.POINTERTAP) {
          const ev = info.event as PointerEvent;
          if (ev.button !== 0) return;
          const pt = pickMeasurePoint();
          if (!pt) return;
          const cur = measureRef.current;
          if (cur.committed) {
            // Third click: restart with a fresh start point.
            measureRef.current = { start: pt, end: null, committed: false };
            setMeasureMarker(0, pt);
            setMeasureMarker(1, null);
            rebuildMeasureLine();
          } else if (!cur.start) {
            measureRef.current = { start: pt, end: null, committed: false };
            setMeasureMarker(0, pt);
          } else {
            measureRef.current = { start: cur.start, end: pt, committed: true };
            setMeasureMarker(1, pt);
            rebuildMeasureLine();
          }
        } else if (info.type === PointerEventTypes.POINTERMOVE) {
          // While the user is choosing the second point, show a live preview
          // line + label from start to the cursor. Stop previewing once the
          // end point is committed by a click.
          const cur = measureRef.current;
          if (!cur.start || cur.committed) return;
          const pt = pickMeasurePoint();
          if (!pt) return;
          measureRef.current = { start: cur.start, end: pt, committed: false };
          rebuildMeasureLine();
          // Keep the end marker hidden during preview so the user can
          // still see which click "locks in" the measurement.
        }
        return;
      }

      if (info.type !== PointerEventTypes.POINTERTAP) return;
      const ev = info.event as PointerEvent;
      if (ev.button !== 0) return;
      // Ctrl (Win/Linux) and Cmd (mac) toggle a prim into the multi-selection
      // instead of replacing it. Clicks on empty space with the modifier
      // held are ignored so the existing multi-selection isn't wiped out.
      const additive = ev.ctrlKey || ev.metaKey;
      const pick = info.pickInfo;
      if (!pick?.hit) {
        if (!additive) onSelectRef.current(null);
        return;
      }
      const m = pick.pickedMesh;
      if (m === ground) {
        if (!additive) onSelectRef.current(null);
        return;
      }
      const id = (m?.metadata as { primId?: string } | undefined)?.primId;
      if (id) {
        // If the picked mesh is a sub-mesh of a loaded reference asset, also
        // surface its uid so the caller can highlight it specifically.
        const uid = m ? String(m.uniqueId) : null;
        const meshUid =
          uid && subMeshRegistryRef.current.has(uid) ? uid : null;
        onSelectRef.current(id, meshUid, additive);
      }
      // Otherwise we probably tapped a gizmo handle; leave selection alone.
    });

    // Render-loop hook: project the measurement midpoint to screen space
    // and place the HTML label there. Hide the label when there is no live
    // measurement.
    scene.onBeforeRenderObservable.add(() => {
      const label = measureLabelRef.current;
      if (!label) return;
      const { start, end } = measureRef.current;
      if (!start || !end) {
        label.style.display = 'none';
        return;
      }
      const mid = Vector3.Center(start, end);
      const cam = cameraRef.current;
      if (!cam) {
        label.style.display = 'none';
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const screen = Vector3.Project(
        mid,
        Matrix.Identity(),
        scene.getTransformMatrix(),
        cam.viewport.toGlobal(rect.width, rect.height)
      );
      label.style.display = 'block';
      label.style.left = `${screen.x}px`;
      label.style.top = `${screen.y}px`;
      const d = Vector3.Distance(start, end);
      label.textContent = `${d.toFixed(2)} m`;
    });

    engine.runRenderLoop(() => scene.render());

    const onResize = () => engine.resize();
    window.addEventListener('resize', onResize);
    // Babylon's built-in resize handling only listens to the window. When
    // our grid layout changes (e.g. Scene Editor mode hiding the bottom
    // palette) the canvas's client size changes without a window resize,
    // so without this observer the engine keeps its old draw-buffer
    // dimensions and the rendered image stretches/skews into the new box.
    const ro = new ResizeObserver(onResize);
    ro.observe(canvas);

    // HTML5 drop wiring: drop on the canvas, pick the ground at the cursor,
    // hand the world position back so a prim can be appended to the model.
    // Both listeners short-circuit when `dropEnabledRef` is false so Scene
    // Editor mode can refuse drops without re-binding the listeners.
    const onDragOver = (ev: DragEvent) => {
      if (!dropEnabledRef.current) return;
      const types = ev.dataTransfer?.types;
      if (!types) return;
      if (types.includes(SHAPE_DRAG_MIME) || types.includes(ASSET_DRAG_MIME)) {
        ev.preventDefault();
        ev.dataTransfer!.dropEffect = 'copy';
      }
    };
    const onDrop = (ev: DragEvent) => {
      if (!dropEnabledRef.current) return;
      const dt = ev.dataTransfer;
      if (!dt) return;
      const assetId = dt.getData(ASSET_DRAG_MIME);
      const shapeKind = dt.getData(SHAPE_DRAG_MIME) as ShapeKind | '';
      if (!assetId && !shapeKind) return;
      ev.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      const pick = scene.pick(x, y, (m) => m === ground);
      const p = pick?.pickedPoint ?? Vector3.Zero();
      if (assetId) {
        onAssetDropRef.current(assetId, [p.x, 0, p.z]);
      } else if (shapeKind) {
        onDropRef.current(shapeKind, [p.x, 0, p.z]);
      }
    };
    canvas.addEventListener('dragover', onDragOver);
    canvas.addEventListener('drop', onDrop);

    // Right-click in the viewport is disabled by user request. We still
    // swallow the event so the browser's default context menu doesn't pop.
    const onCanvasContextMenu = (ev: MouseEvent) => {
      ev.preventDefault();
    };
    canvas.addEventListener('contextmenu', onCanvasContextMenu);

    return () => {
      canvas.removeEventListener('dragover', onDragOver);
      canvas.removeEventListener('drop', onDrop);
      canvas.removeEventListener('contextmenu', onCanvasContextMenu);
      window.removeEventListener('resize', onResize);
      ro.disconnect();
      meshesRef.current.clear();
      materialsRef.current.clear();
      sceneRef.current = null;
      groundRef.current = null;
      cameraRef.current = null;
      engineRef.current = null;
      gizmoMgrRef.current = null;
      lastPositionGizmoRef.current = null;
      lastRotationGizmoRef.current = null;
      lastScaleGizmoRef.current = null;
      gridMatRef.current = null;
      if (measureMarkersRef.current) {
        measureMarkersRef.current.dispose(false, true);
      }
      measureMarkersRef.current = null;
      measureMarkerMatricesRef.current = null;
      measureLineRef.current = null;
      gizmoMgr.dispose();
      outlinedMeshesRef.current.clear();
      engine.dispose();
    };
  }, []);

  // Reconcile meshes with the prim list: ensure mesh exists, sync transforms,
  // material color, and parent linkage.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    const existingMeshes = meshesRef.current;
    const existingMats = materialsRef.current;
    const seen = new Set<string>();

    // Wrapper around loadGltfReference that bumps loadingCount up/down so
    // the loader bar overlay reflects outstanding async asset loads. Used
    // for both initial spawn and edit-the-source reload.
    const loadReference = (
      parent: Mesh,
      assetSource: string,
      primId: string
    ): void => {
      setLoadingCount((c) => c + 1);
      void loadGltfReference(
        parent,
        assetSource,
        scene,
        primId,
        subMeshRegistryRef.current,
        (nodes) => onAssetMeshesLoadedRef.current(primId, nodes)
      ).finally(() => setLoadingCount((c) => Math.max(0, c - 1)));
    };

    // Pass 1: create/update meshes + materials + transforms.
    for (const prim of prims) {
      seen.add(prim.id);
      let mesh = existingMeshes.get(prim.id);
      if (!mesh) {
        mesh = buildShapeMesh(prim, scene, loadReference);
        existingMeshes.set(prim.id, mesh);
      } else if (prim.kind === 'reference') {
        // Reload the GLB if the user edited the source path.
        const meta = mesh.metadata as
          | { primId?: string; loadedSource?: string }
          | undefined;
        if ((meta?.loadedSource ?? '') !== (prim.assetSource ?? '')) {
          for (const child of mesh.getChildMeshes(false)) child.dispose();
          clearSubMeshRegistry(subMeshRegistryRef.current, prim.id);
          onAssetMeshesLoadedRef.current(prim.id, []);
          mesh.metadata = { primId: prim.id };
          if (prim.assetSource) {
            loadReference(mesh, prim.assetSource, prim.id);
          }
        }
      }
      // Skip transform writes for meshes that a gizmo drag is actively
      // driving. The per-tick state commits we do for live Properties
      // updates would otherwise race the gizmo (primary) or stomp on the
      // direct mesh writes we make for group secondaries, causing a
      // visible lag/snap-back. Drag-end clears the id and the next render
      // re-syncs naturally.
      if (!draggingIdsRef.current.has(prim.id)) {
        mesh.position.set(prim.position[0], prim.position[1], prim.position[2]);
        // Drive rotation via quaternion only — the RotationGizmo writes to
        // rotationQuaternion, and a non-null quaternion takes precedence over
        // mesh.rotation in Babylon's world-matrix composition.
        const q = Quaternion.FromEulerAngles(
          prim.rotation[0],
          prim.rotation[1],
          prim.rotation[2]
        );
        if (mesh.rotationQuaternion) {
          mesh.rotationQuaternion.copyFrom(q);
        } else {
          mesh.rotationQuaternion = q;
        }
        mesh.scaling.set(prim.scale[0], prim.scale[1], prim.scale[2]);
      } else if (!mesh.rotationQuaternion) {
        // Ensure the quaternion exists even when we skip the write, so the
        // RotationGizmo has something to drive on the very first drag.
        mesh.rotationQuaternion = Quaternion.FromEulerAngles(
          prim.rotation[0],
          prim.rotation[1],
          prim.rotation[2]
        );
      }

      let mat = existingMats.get(prim.id);
      if (!mat) {
        mat = new StandardMaterial(`mat-${prim.id}`, scene);
        mat.specularColor = new Color3(0.15, 0.15, 0.15);
        existingMats.set(prim.id, mat);
      }
      const { color: rgb, alpha } = parseHexColor(prim.color);
      mat.diffuseColor = rgb;
      mat.alpha = alpha;
      // Reference prims carry their own PBR materials from the GLB; don't
      // overwrite them with our flat color.
      if (prim.kind !== 'reference') {
        mesh.material = mat;
      }
    }

    // Pass 2: wire up parents now that every mesh exists.
    for (const prim of prims) {
      const mesh = existingMeshes.get(prim.id);
      if (!mesh) continue;
      const parent = prim.parentId
        ? existingMeshes.get(prim.parentId) ?? null
        : null;
      if (mesh.parent !== parent) {
        mesh.parent = parent;
      }
    }

    // Pass 3: dispose meshes/materials whose prims are gone.
    const mgr = gizmoMgrRef.current;
    for (const [id, mesh] of existingMeshes) {
      if (seen.has(id)) continue;
      if (mgr?.attachedMesh === mesh) mgr.attachToMesh(null);
      clearSubMeshRegistry(subMeshRegistryRef.current, id);
      onAssetMeshesLoadedRef.current(id, []);
      mesh.dispose();
      existingMeshes.delete(id);
      const mat = existingMats.get(id);
      if (mat) {
        mat.dispose();
        existingMats.delete(id);
      }
    }
  }, [prims]);

  // Selection + tool sync: solid outline on selected mesh, gizmo wiring.
  useEffect(() => {
    const mgr = gizmoMgrRef.current;
    if (!mgr) return;

    const primMesh = selectedId
      ? meshesRef.current.get(selectedId) ?? null
      : null;
    // Prefer the specific sub-mesh outline when one is selected; otherwise
    // fall back to outlining the prim's root mesh.
    const subNode =
      selectedMeshUid != null
        ? subMeshRegistryRef.current.get(selectedMeshUid) ?? null
        : null;

    // Build the desired outlined-mesh set. HighlightLayer.addMesh requires
    // a Mesh; group transforms and non-Mesh AbstractMesh subclasses are
    // skipped. Empty-geometry meshes are skipped too (no silhouette to
    // render).
    const desired = new Set<Mesh>();
    const addOutlineTarget = (m: AbstractMesh): void => {
      if (!(m instanceof Mesh)) return;
      if (m.getTotalVertices() === 0) return;
      desired.add(m);
    };
    if (subNode) {
      // The selected sub-node can be a leaf mesh *or* an intermediate group
      // (e.g. `Object331` / `04 - HVP01` in OBJ assets, which load as a
      // TransformNode with primitive child meshes). For groups, the node
      // itself has no geometry, so outline every descendant mesh so the
      // whole group lights up.
      if (subNode instanceof AbstractMesh) addOutlineTarget(subNode);
      for (const d of subNode.getChildMeshes(false)) addOutlineTarget(d);
    } else {
      // Top-level prim selection: outline every prim in the multi-selection
      // set. Each prim's root mesh + every descendant mesh is lit up, since
      // asset groups carry no geometry of their own.
      for (const id of selectedIds) {
        const mesh = meshesRef.current.get(id);
        if (!mesh) continue;
        addOutlineTarget(mesh);
        for (const d of mesh.getChildMeshes(false)) addOutlineTarget(d);
      }
    }

    // Diff against the previous outlined set so a stable selection across
    // drag ticks (effect re-runs every time `prims` changes) does no
    // overlay work. `renderOverlay = true` adds one extra draw call per
    // mesh per frame (solid-color pass with alpha) — toggling it is just a
    // flag flip, no CPU geometry work like enableEdgesRendering had.
    const prev = outlinedMeshesRef.current;
    for (const m of prev) {
      if (!desired.has(m)) {
        if (!m.isDisposed()) m.renderOverlay = false;
      }
    }
    for (const m of desired) {
      if (!prev.has(m)) {
        m.overlayColor = SELECTION_COLOR;
        m.overlayAlpha = SELECTION_OVERLAY_ALPHA;
        m.renderOverlay = true;
      }
    }
    outlinedMeshesRef.current = desired;

    // Surface the picked sub-mesh's local pose to the Properties panel.
    // Only TransformNode (and its subclass AbstractMesh) carry position +
    // rotation; other Node subtypes have no transform to report.
    if (subNode && subNode instanceof TransformNode) {
      onSubMeshInfoChangeRef.current(extractSubMeshInfo(selectedMeshUid!, subNode));
    } else {
      onSubMeshInfoChangeRef.current(null);
    }

    // Gizmos always attach to the prim's root mesh: sub-meshes inside a
    // reference asset are owned by the asset and aren't independently movable.
    const wantMove = tool === 'move' && !!primMesh;
    const wantRotate = tool === 'rotate' && !!primMesh;
    const wantScale = tool === 'scale' && !!primMesh;
    mgr.positionGizmoEnabled = wantMove;
    mgr.rotationGizmoEnabled = wantRotate;
    mgr.scaleGizmoEnabled = wantScale;
    ensureSnapRef.current();
    mgr.attachToMesh(primMesh);
  }, [selectedId, selectedIds, selectedMeshUid, tool, prims]);

  // Measure tool side-effects: swap the canvas cursor for a crosshair and
  // clear any in-flight measurement when the user switches away.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) canvas.style.cursor = tool === 'measure' ? 'crosshair' : '';
    if (tool !== 'measure') clearMeasurementRef.current();
  }, [tool]);

  // Apply a camera-view preset whenever the user picks one in the overlay.
  useEffect(() => {
    const camera = cameraRef.current;
    if (!camera) return;
    applyCameraView(camera, cameraView);
  }, [cameraView]);

  // Focus = if a prim or sub-mesh is selected, frame it in the camera;
  // otherwise reset camera to the same alpha/beta/radius/target the scene
  // started with. Bumping the counter signals the Viewport to run; both the
  // toolbar button and the 'F' hotkey go through this single channel.
  useEffect(() => {
    if (focusSignal === 0) return;
    const camera = cameraRef.current;
    const engine = engineRef.current;
    if (!camera || !engine) return;
    const sid = selectedIdRef.current;
    const muid = selectedMeshUidRef.current;
    // Prefer the specific sub-mesh when one is selected so framing zooms in
    // on the picked piece instead of the whole asset.
    let target: TransformNode | null = null;
    if (muid) {
      const n = subMeshRegistryRef.current.get(muid);
      if (n instanceof TransformNode) target = n;
    }
    if (!target && sid) target = meshesRef.current.get(sid) ?? null;
    if (target) {
      frameMeshInCamera(camera, target, engine);
      return;
    }
    camera.mode = Camera.PERSPECTIVE_CAMERA;
    camera.alpha = Math.PI / 4;
    camera.beta = Math.PI / 3;
    camera.radius = 25;
    camera.target.copyFromFloats(0, 0, 0);
    setCameraView('perspective');
  }, [focusSignal]);

  // Re-tint scene background + grid colors when the app theme changes.
  useEffect(() => {
    const scene = sceneRef.current;
    const grid = gridMatRef.current;
    if (!scene || !grid) return;
    if (theme === 'light') {
      scene.clearColor = new Color4(0.94, 0.95, 0.97, 1);
      grid.mainColor = new Color3(0.94, 0.95, 0.97);
      grid.lineColor = new Color3(0.35, 0.4, 0.5);
    } else {
      scene.clearColor = new Color4(0.1, 0.11, 0.13, 1);
      grid.mainColor = new Color3(0.1, 0.11, 0.13);
      grid.lineColor = new Color3(0.6, 0.65, 0.75);
    }
  }, [theme]);

  return (
    <div className="viewport-canvas-wrap">
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: 'block' }}
      />
      <div
        ref={measureLabelRef}
        className="measure-label"
        style={{ display: 'none' }}
        aria-hidden="true"
      />
      {loadingCount > 0 && (
        <div className="viewport-loader" role="status" aria-live="polite">
          <div className="viewport-loader-bar">
            <div className="viewport-loader-bar-fill" />
          </div>
          <span className="viewport-loader-label">
            Loading {loadingCount} asset{loadingCount > 1 ? 's' : ''}…
          </span>
        </div>
      )}
      <CameraControls view={cameraView} onChange={setCameraView} />
    </div>
  );
}

type PrimitiveKind = Exclude<ShapeKind, 'group' | 'reference'>;

let primitiveTemplateCachesByScene:
  | WeakMap<Scene, Map<PrimitiveKind, Mesh>>
  | null = null;
function getPrimitiveTemplateCacheByScene(): WeakMap<
  Scene,
  Map<PrimitiveKind, Mesh>
> {
  if (!primitiveTemplateCachesByScene) {
    primitiveTemplateCachesByScene = new WeakMap();
  }
  return primitiveTemplateCachesByScene;
}

function createPrimitiveTemplate(kind: PrimitiveKind, scene: Scene): Mesh {
  const name = `__primitive-template-${kind}`;
  let mesh: Mesh;
  switch (kind) {
    case 'box':
      mesh = MeshBuilder.CreateBox(name, { size: 1 }, scene);
      break;
    case 'cylinder':
      mesh = MeshBuilder.CreateCylinder(
        name,
        { diameter: 1, height: 1 },
        scene
      );
      break;
    case 'sphere':
      mesh = MeshBuilder.CreateSphere(name, { diameter: 1 }, scene);
      break;
    case 'plane':
      mesh = MeshBuilder.CreatePlane(
        name,
        { size: 1, sideOrientation: Mesh.DOUBLESIDE },
        scene
      );
      // Keep "plane" aligned to the editor's XZ floor convention.
      mesh.rotation.x = Math.PI / 2;
      break;
    case 'cone':
      mesh = MeshBuilder.CreateCylinder(
        name,
        { diameterTop: 0, diameterBottom: 1, height: 1, tessellation: 32 },
        scene
      );
      break;
  }
  mesh.isVisible = false;
  mesh.setEnabled(false);
  mesh.isPickable = false;
  return mesh;
}

function createPrimitiveMesh(kind: PrimitiveKind, id: string, scene: Scene): Mesh {
  const cachesByScene = getPrimitiveTemplateCacheByScene();
  let cache = cachesByScene.get(scene);
  if (!cache) {
    cache = new Map();
    cachesByScene.set(scene, cache);
  }
  let template = cache.get(kind);
  if (!template || template.isDisposed()) {
    template = createPrimitiveTemplate(kind, scene);
    cache.set(kind, template);
  }
  const clone = template.clone(id);
  if (!clone) {
    throw new Error(`Failed to clone primitive template for kind "${kind}"`);
  }
  clone.isVisible = true;
  clone.setEnabled(true);
  clone.isPickable = true;
  return clone;
}

function buildShapeMesh(
  prim: PrimNode,
  scene: Scene,
  loadReference: (parent: Mesh, assetSource: string, primId: string) => void
): Mesh {
  let mesh: Mesh;
  switch (prim.kind) {
    case 'box':
      mesh = createPrimitiveMesh('box', prim.id, scene);
      break;
    case 'cylinder':
      mesh = createPrimitiveMesh('cylinder', prim.id, scene);
      break;
    case 'sphere':
      mesh = createPrimitiveMesh('sphere', prim.id, scene);
      break;
    case 'plane':
      mesh = createPrimitiveMesh('plane', prim.id, scene);
      break;
    case 'cone':
      mesh = createPrimitiveMesh('cone', prim.id, scene);
      break;
    case 'group':
      // An empty Mesh acts as a pure transform node: children parent to it,
      // and the gizmo can attach to it, but it has no geometry to render.
      mesh = new Mesh(prim.id, scene);
      mesh.isPickable = false;
      break;
    case 'reference':
      // Empty parent transform; the GLB's meshes get parented under it once
      // the async glTF load completes.
      mesh = new Mesh(prim.id, scene);
      mesh.isPickable = false;
      if (prim.assetSource) {
        loadReference(mesh, prim.assetSource, prim.id);
      }
      break;
  }
  mesh.metadata = { primId: prim.id };
  // Initialize rotation as a quaternion so the rotation gizmo has something
  // to drive; the reconcile effect keeps it in sync from state.
  mesh.rotationQuaternion = Quaternion.Identity();
  return mesh;
}

// Accepts `#rrggbb` or `#rrggbbaa`. Falls back to a neutral grey when the
// string is malformed so a typo in a prim's color doesn't crash the scene.
function parseHexColor(hex: string): { color: Color3; alpha: number } {
  const m8 = /^#?([0-9a-fA-F]{8})$/.exec(hex);
  if (m8) {
    const v = parseInt(m8[1].slice(0, 6), 16);
    const a = parseInt(m8[1].slice(6, 8), 16) / 255;
    return {
      color: new Color3(
        ((v >> 16) & 0xff) / 255,
        ((v >> 8) & 0xff) / 255,
        (v & 0xff) / 255
      ),
      alpha: a
    };
  }
  const m6 = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (m6) {
    const v = parseInt(m6[1], 16);
    return {
      color: new Color3(
        ((v >> 16) & 0xff) / 255,
        ((v >> 8) & 0xff) / 255,
        (v & 0xff) / 255
      ),
      alpha: 1
    };
  }
  return { color: new Color3(0.7, 0.7, 0.72), alpha: 1 };
}

// Per-scene cache of parsed asset containers, keyed by resolved URL. The
// container is held OFF-scene (we never call addAllToScene); each load
// clones from it via instantiateModelsToScene, which shares GPU geometry
// (Mesh.clone reuses the source Geometry instance) and shares materials/
// textures (cloneMaterials=false). One OBJ/GLB parse + texture upload is
// reused for N instances of the same asset — the dominant cost when a
// scene contains many copies of e.g. HospitalBed.obj. WeakMap so disposing
// the scene auto-evicts the cache.
let assetContainerCachesByScene:
  | WeakMap<Scene, Map<string, Promise<AssetContainer>>>
  | null = null;
function getAssetContainerCacheByScene(): WeakMap<
  Scene,
  Map<string, Promise<AssetContainer>>
> {
  if (!assetContainerCachesByScene) {
    assetContainerCachesByScene = new WeakMap();
  }
  return assetContainerCachesByScene;
}

function getOrLoadAssetContainer(
  scene: Scene,
  cacheKey: string,
  rootUrl: string,
  fileName: string,
  pluginExtension: string | undefined
): Promise<AssetContainer> {
  const cachesByScene = getAssetContainerCacheByScene();
  let cache = cachesByScene.get(scene);
  if (!cache) {
    cache = new Map();
    cachesByScene.set(scene, cache);
  }
  let pending = cache.get(cacheKey);
  if (pending) return pending;
  pending = (async () => {
    const container = await SceneLoader.LoadAssetContainerAsync(
      rootUrl,
      fileName,
      scene,
      null,
      pluginExtension
    );
    // Sanitize ONCE on the cached template. Clones share materials
    // (cloneMaterials=false) so this fix-up flows to every instance.
    // createNormals modifies the source Geometry, which is also shared
    // across clones, so recomputed normals stick everywhere.
    for (const m of container.meshes) {
      if (m instanceof Mesh) {
        if (m.material) m.material.fillMode = Material.TriangleFillMode;
        if (
          !m.isVerticesDataPresent(VertexBuffer.NormalKind) &&
          m.getTotalVertices() > 0 &&
          m.getTotalIndices() > 0
        ) {
          m.createNormals(true);
        }
      }
      sanitizeReferenceMaterial(m.material);
    }
    return container;
  })().catch((err) => {
    // Don't poison the cache with a rejected promise — next attempt should
    // be allowed to retry.
    cache!.delete(cacheKey);
    throw err;
  });
  cache.set(cacheKey, pending);
  return pending;
}

async function loadGltfReference(
  parent: Mesh,
  assetSource: string,
  scene: Scene,
  primId: string,
  subMeshRegistry: Map<string, Node>,
  onAssetMeshesLoaded: (nodes: AssetMeshNode[]) => void
): Promise<void> {
  const url = resolveAssetUrl(assetSource);
  // SceneLoader needs rootUrl + filename split so sibling files (e.g. an OBJ's
  // .mtl and textures) resolve against the same directory.
  const lastSlash = url.lastIndexOf('/');
  const rootUrl = url.slice(0, lastSlash + 1);
  const fileName = url.slice(lastSlash + 1);
  // Resolved `user://` URLs become `blob:` URLs with no extension, so
  // Babylon can't auto-pick a loader. Pull the original extension off the
  // `assetSource` (e.g. ".glb") and pass it as pluginExtension.
  const sourceExt = assetSource.match(/\.[a-z0-9]+$/i)?.[0]?.toLowerCase();
  const pluginExtension = url.startsWith('blob:') ? sourceExt : undefined;
  // blob: URLs are one-shot handles produced by URL.createObjectURL; each
  // generated URL is unique to a single fetch, so caching by URL is
  // meaningless. Key those by assetSource so user-library files still
  // benefit from per-source reuse across instances.
  const cacheKey = url.startsWith('blob:') ? `src:${assetSource}` : url;
  try {
    const container = await getOrLoadAssetContainer(
      scene,
      cacheKey,
      rootUrl,
      fileName,
      pluginExtension
    );
    // The reference prim may have been removed before the load finished.
    if (parent.isDisposed()) return;
    // Clone (not InstancedMesh) so per-instance Mesh state — renderOverlay
    // color/alpha for selection, picking metadata — stays independent.
    // doNotInstantiate=true and cloneMaterials=false: each instance is a
    // fresh Mesh sharing the source Geometry (cheap, GPU buffers reused)
    // and the sanitized source Material (no per-instance texture upload).
    const entries = container.instantiateModelsToScene(
      undefined,
      false,
      { doNotInstantiate: true }
    );
    for (const root of entries.rootNodes) {
      root.parent = parent;
    }
    // Remember which source produced these children so a later edit triggers a reload.
    parent.metadata = { ...(parent.metadata ?? {}), primId, loadedSource: assetSource };
    // Drop any stale sub-mesh registrations from a previous load of this prim,
    // then walk the (potentially nested) loaded hierarchy under `parent` and
    // publish it as an AssetMeshNode tree so the Hierarchy panel can render
    // the asset's internal structure. buildAssetMeshNode also tags every
    // node with `metadata.primId` (and meshes with `assetMeshUid`), which
    // is what viewport picks rely on to resolve clicks back to this prim.
    clearSubMeshRegistry(subMeshRegistry, primId);
    const tree = buildAssetMeshTree(parent, primId, subMeshRegistry);
    onAssetMeshesLoaded(tree);
  } catch (err) {
    console.error(`Failed to load reference ${assetSource}`, err);
    onAssetMeshesLoaded([]);
  }
}

// Babylon's glTF loader wraps imported scenes in an auto-generated
// `__root__` transform node. Flatten that one level out so the hierarchy
// panel shows the asset's real top-level nodes instead of a stub label.
function buildAssetMeshTree(
  parent: Node,
  primId: string,
  subMeshRegistry: Map<string, Node>
): AssetMeshNode[] {
  const nodes: AssetMeshNode[] = [];
  for (const child of parent.getChildren()) {
    if (isGltfRootStub(child)) {
      nodes.push(...buildAssetMeshTree(child, primId, subMeshRegistry));
    } else {
      nodes.push(buildAssetMeshNode(child, primId, subMeshRegistry));
    }
  }
  return nodes;
}

function buildAssetMeshNode(
  node: Node,
  primId: string,
  subMeshRegistry: Map<string, Node>
): AssetMeshNode {
  const uid = String(node.uniqueId);
  // Register every node (groups + leaves) so the selection effect can look
  // up an intermediate TransformNode and walk its descendants. The primId
  // tag on metadata is what `clearSubMeshRegistry` uses to evict entries on
  // prim removal, so set it on every node; `assetMeshUid` is used by the
  // picker which only picks meshes, so it's mesh-only.
  subMeshRegistry.set(uid, node);
  const meta = (node.metadata ?? {}) as { primId?: string; assetMeshUid?: string };
  node.metadata =
    node instanceof AbstractMesh
      ? { ...meta, primId, assetMeshUid: uid }
      : { ...meta, primId };
  const children: AssetMeshNode[] = [];
  for (const c of node.getChildren()) {
    if (isGltfRootStub(c)) {
      children.push(...buildAssetMeshTree(c, primId, subMeshRegistry));
    } else {
      children.push(buildAssetMeshNode(c, primId, subMeshRegistry));
    }
  }
  return {
    uid,
    name: node.name || '(unnamed)',
    children
  };
}

function isGltfRootStub(node: Node): boolean {
  return node.name === '__root__';
}

// Snapshot the local pose of an asset-internal node for display in the
// Properties panel. Prefers Euler rotation; falls back to converting a
// quaternion if the loader produced one (glTF nearly always does).
function extractSubMeshInfo(uid: string, node: TransformNode): SubMeshInfo {
  let rx = node.rotation.x;
  let ry = node.rotation.y;
  let rz = node.rotation.z;
  if (node.rotationQuaternion) {
    const e = node.rotationQuaternion.toEulerAngles();
    rx = e.x;
    ry = e.y;
    rz = e.z;
  }
  return {
    uid,
    name: node.name || '(unnamed)',
    position: [node.position.x, node.position.y, node.position.z],
    rotation: [rx, ry, rz]
  };
}

// Forget any sub-mesh uids previously registered for `primId`. Called when a
// reference prim is removed or its assetSource changes (and we're about to
// rebuild the registry from the new load).
function clearSubMeshRegistry(
  subMeshRegistry: Map<string, Node>,
  primId: string
): void {
  for (const [uid, node] of subMeshRegistry) {
    const meta = node.metadata as { primId?: string } | undefined;
    if (meta?.primId === primId) subMeshRegistry.delete(uid);
  }
}

// PNG textures often carry an alpha channel even when fully opaque, and the
// MTL loader can wire one to the diffuse slot — which makes Babylon's
// StandardMaterial render the whole surface translucent. Likewise the OBJ
// loader leaves backface culling on, which combined with reversed winding
// makes faces vanish. Lock things to opaque + double-sided so neither path
// silently hides the geometry.
function sanitizeReferenceMaterial(mat: Material | null): void {
  if (!mat) return;
  mat.backFaceCulling = false;
  mat.transparencyMode = Material.MATERIAL_OPAQUE;
  if (mat instanceof StandardMaterial) {
    mat.useAlphaFromDiffuseTexture = false;
    if (mat.diffuseTexture) mat.diffuseTexture.hasAlpha = false;
    mat.alpha = 1;
  } else if (mat instanceof PBRMaterial) {
    if (mat.albedoTexture) mat.albedoTexture.hasAlpha = false;
    mat.useAlphaFromAlbedoTexture = false;
    mat.alpha = 1;
  }
}

// Babylon's per-axis gizmos expose their materials as protected/internal, so
// we type-erase to recolor consistently across position / rotation / scale.
interface AxisLikeGizmo {
  xGizmo: unknown;
  yGizmo: unknown;
  zGizmo: unknown;
}

function tintGizmoAxes(gizmo: AxisLikeGizmo): void {
  applyAxisColor(gizmo.xGizmo, AXIS_COLORS.x);
  applyAxisColor(gizmo.yGizmo, AXIS_COLORS.y);
  applyAxisColor(gizmo.zGizmo, AXIS_COLORS.z);
}

type MaybeMat =
  | (StandardMaterial & { emissiveColor: Color3; diffuseColor: Color3 })
  | null
  | undefined;
type MaybeMesh = (Mesh & { color?: Color3 }) | null | undefined;

function applyAxisColor(axisGizmo: unknown, color: Color3): void {
  // Cast through unknown: Babylon's IAxisDragGizmo / IPlaneRotationGizmo /
  // IAxisScaleGizmo interfaces don't expose the inner materials, but the
  // concrete classes do (both as public getters and private fields).
  const g = axisGizmo as {
    coloredMaterial?: MaybeMat;
    hoverMaterial?: MaybeMat;
    _coloredMaterial?: MaybeMat;
    _hoverMaterial?: MaybeMat;
    _rootMesh?: { getChildMeshes(): Array<MaybeMesh> };
  } | null;
  if (!g) return;

  const hover = color.scale(1.4);
  const mainMat = g.coloredMaterial ?? g._coloredMaterial;
  if (mainMat) paintMaterial(mainMat, color);
  const hoverMat = g.hoverMaterial ?? g._hoverMaterial;
  if (hoverMat) paintMaterial(hoverMat, hover);

  // Line and curve meshes inside the gizmo ignore their material color and
  // use AbstractMesh.color. Set that on every child mesh too.
  const root = g._rootMesh;
  if (root && typeof root.getChildMeshes === 'function') {
    for (const m of root.getChildMeshes()) {
      if (!m) continue;
      if ('color' in m) {
        (m as { color: Color3 }).color = color;
      }
      const mat = m.material as MaybeMat;
      if (mat) paintMaterial(mat, color);
    }
  }
}

function paintMaterial(mat: NonNullable<MaybeMat>, color: Color3): void {
  // Render gizmo handles unlit so the color reads saturated, matching the
  // origin axis lines (which are pure Color3 line meshes with no lighting).
  if ('diffuseColor' in mat) mat.diffuseColor = Color3.Black();
  if ('emissiveColor' in mat) mat.emissiveColor = color;
  const lit = mat as { disableLighting?: boolean; specularColor?: Color3 };
  lit.disableLighting = true;
  if (lit.specularColor) lit.specularColor = Color3.Black();
}

// Babylon ArcRotateCamera angle conventions (Y-up):
// position = target + r * (sin(beta)*cos(alpha), cos(beta), sin(beta)*sin(alpha))
// beta = 0  -> camera above target (looking down)
// beta = pi -> camera below target (looking up)
const EPS = 0.0001;
const VIEW_ANGLES: Record<
  Exclude<CameraView, 'perspective'>,
  { alpha: number; beta: number }
> = {
  top: { alpha: -Math.PI / 2, beta: EPS },
  bottom: { alpha: -Math.PI / 2, beta: Math.PI - EPS },
  front: { alpha: -Math.PI / 2, beta: Math.PI / 2 },
  back: { alpha: Math.PI / 2, beta: Math.PI / 2 },
  right: { alpha: 0, beta: Math.PI / 2 },
  left: { alpha: Math.PI, beta: Math.PI / 2 }
};

function applyCameraView(camera: ArcRotateCamera, view: CameraView): void {
  if (view === 'perspective') {
    camera.mode = Camera.PERSPECTIVE_CAMERA;
    camera.alpha = Math.PI / 4;
    camera.beta = Math.PI / 3;
    return;
  }
  const a = VIEW_ANGLES[view];
  camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
  camera.alpha = a.alpha;
  camera.beta = a.beta;
}

// Frame `mesh` (and its descendants) in the ArcRotate camera by recentering
// the target on the world AABB and choosing a radius that fits the largest
// extent inside the current vertical+horizontal FOV. Leaves alpha/beta/mode
// alone so the user keeps their orbit angle and ortho/perspective choice.
function frameMeshInCamera(
  camera: ArcRotateCamera,
  mesh: TransformNode,
  engine: Engine
): void {
  const { min, max } = mesh.getHierarchyBoundingVectors(true);
  const center = Vector3.Center(min, max);
  const size = max.subtract(min);
  // Empty placeholder meshes (e.g. a reference whose GLB hasn't loaded yet)
  // report a zero-extent box; fall back to a sane radius so we don't collapse
  // the camera onto the target.
  let maxDim = Math.max(size.x, size.y, size.z);
  if (!isFinite(maxDim) || maxDim < 1e-4) maxDim = 1;
  const aspect = engine.getAspectRatio(camera);
  const vHalf = camera.fov / 2;
  const hHalf = Math.atan(Math.tan(vHalf) * aspect);
  const rV = (maxDim / 2) / Math.tan(vHalf);
  const rH = (maxDim / 2) / Math.tan(hHalf);
  // Padding factor: > 1 leaves breathing room around the framed mesh so the
  // user sees a bit of surrounding context instead of a tight crop.
  const radius = Math.max(rV, rH) * 2.0;
  camera.target.copyFrom(center);
  camera.radius = Math.max(camera.lowerRadiusLimit ?? 0.001, radius);
}
