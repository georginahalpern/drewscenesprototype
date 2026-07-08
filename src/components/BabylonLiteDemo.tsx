import { useEffect, useRef, useState } from 'react';
import {
  addToScene,
  attachControl,
  attachPositionGizmoToNode,
  attachRotationGizmoToNode,
  attachScaleGizmoToNode,
  createArcRotateCamera,
  createBox,
  createCylinder,
  createDirectionalLight,
  createEngine,
  createGridMaterial,
  createGpuPicker,
  createGround,
  createHemisphericLight,
  getContainerMeshes,
  createPlane,
  createPositionGizmo,
  createRotationGizmo,
  createScaleGizmo,
  createSceneContext,
  createSphere,
  createStandardMaterial,
  createTransformNode,
  createUtilityLayer,
  loadGltf,
  disposeEngine,
  disposePicker,
  disposeScene,
  disposePositionGizmo,
  disposeRotationGizmo,
  disposeScaleGizmo,
  disposeUtilityLayer,
  invalidateRenderBundles,
  isGizmoInteracting,
  isGizmoDragging,
  isGizmoPickPending,
  onBeforeRender,
  pickAsync,
  registerScene,
  registerUtilityLayer,
  removeFromScene,
  resizeEngine,
  startEngine,
  stopEngine
} from '@babylonjs/lite';
import { resolveAssetUrl } from '../assets';
import { ASSET_DRAG_MIME, SHAPE_DRAG_MIME } from '../shapes';
import type { PrimNode, PrimTransform, ShapeKind } from '../types';
import type { Theme } from './TopBar';
import { getUserLibraryItem, loadUserLibrary, resolveUserAssetUrl } from '../userLibrary';

interface Props {
  prims: PrimNode[];
  theme: Theme;
  tool: 'select' | 'move' | 'rotate' | 'scale' | 'measure';
  dropEnabled: boolean;
  onShapeDropped: (kind: ShapeKind, position: [number, number, number]) => void;
  onAssetDropped: (assetId: string, position: [number, number, number]) => void;
  onTransform?: (id: string, t: Partial<PrimTransform>) => void;
}

type DemoStatus =
  | { kind: 'loading'; message: string }
  | { kind: 'ready'; message: string }
  | { kind: 'error'; message: string };

type LiteNode = ReturnType<typeof createBox> | ReturnType<typeof createTransformNode>;
type LiteMesh = ReturnType<typeof createBox>;
type LiteSceneNode = ReturnType<typeof createTransformNode>;
type LiteAssetContainer = Awaited<ReturnType<typeof loadGltf>>;
type LiteReferenceInput = string | Blob;

interface RenderEntry {
  node: LiteNode;
  isMesh: boolean;
  material?: ReturnType<typeof createStandardMaterial>;
}

interface LoadedReference {
  source: string;
  roots: unknown[];
  requestId: number;
}

const DEFAULT_LITE_COLOR: [number, number, number] = [0.7, 0.7, 0.72];

export default function BabylonLiteDemo({
  prims,
  theme,
  tool,
  dropEnabled,
  onShapeDropped,
  onAssetDropped,
  onTransform
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [sceneVersion, setSceneVersion] = useState(0);
  const [status, setStatus] = useState<DemoStatus>({
    kind: 'loading',
    message: 'Initializing Babylon Lite demo...'
  });

  const engineRef = useRef<Awaited<ReturnType<typeof createEngine>> | null>(null);
  const sceneRef = useRef<ReturnType<typeof createSceneContext> | null>(null);
  const pickerRef = useRef<ReturnType<typeof createGpuPicker> | null>(null);
  const groundRef = useRef<ReturnType<typeof createGround> | null>(null);
  const bootstrapMeshRef = useRef<ReturnType<typeof createBox> | null>(null);
  const utilityLayerRef = useRef<ReturnType<typeof createUtilityLayer> | null>(null);
  const selectedNodeRef = useRef<unknown | null>(null);
  const positionGizmoRef = useRef<ReturnType<typeof createPositionGizmo> | null>(null);
  const rotationGizmoRef = useRef<ReturnType<typeof createRotationGizmo> | null>(null);
  const scaleGizmoRef = useRef<ReturnType<typeof createScaleGizmo> | null>(null);
  const renderEntriesRef = useRef<Map<string, RenderEntry>>(new Map());
  // Reverse index (lite node -> prim id) so the per-frame gizmo drag-sync can
  // resolve the dragged node's prim in O(1) instead of scanning renderEntries.
  const nodeToPrimIdRef = useRef<WeakMap<object, string>>(new WeakMap());
  const loadedReferencesRef = useRef<Map<string, LoadedReference>>(new Map());
  const dropEnabledRef = useRef(dropEnabled);
  const onShapeDroppedRef = useRef(onShapeDropped);
  const onAssetDroppedRef = useRef(onAssetDropped);
  const onTransformRef = useRef(onTransform);
  const primsRef = useRef<PrimNode[]>(prims);
  const toolRef = useRef(tool);

  useEffect(() => {
    dropEnabledRef.current = dropEnabled;
  }, [dropEnabled]);

  useEffect(() => {
    onShapeDroppedRef.current = onShapeDropped;
  }, [onShapeDropped]);

  useEffect(() => {
    onAssetDroppedRef.current = onAssetDropped;
  }, [onAssetDropped]);

  useEffect(() => {
    onTransformRef.current = onTransform;
  }, [onTransform]);

  useEffect(() => {
    primsRef.current = prims;
  }, [prims]);

  useEffect(() => {
    toolRef.current = tool;
  }, [tool]);

  useEffect(() => {
    const scene = sceneRef.current;
    const ground = groundRef.current;
    if (!scene || !ground) return;
    applyThemeToScene(scene, ground, theme);
  }, [theme]);

  useEffect(() => {
    // Show only the active tool's gizmo. applyGizmoForMode keeps all three
    // gizmos alive and toggles their visibility, so exactly one is visible at
    // a time without ever disposing GPU buffers mid-session.
    applyGizmoForMode(
      tool,
      engineRef.current,
      utilityLayerRef.current,
      selectedNodeRef.current,
      { position: positionGizmoRef, rotation: rotationGizmoRef, scale: scaleGizmoRef }
    );
  }, [tool]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!('gpu' in navigator)) {
      setStatus({
        kind: 'error',
        message:
          'WebGPU is not available in this browser, so the Babylon Lite demo cannot run.'
      });
      return;
    }

    let cancelled = false;
    let detachControl: (() => void) | null = null;
    let removeResize: (() => void) | null = null;

    const init = async () => {
      try {
        const engine = await createEngine(canvas, { maxDevicePixelRatio: 2 });
        if (cancelled) return;
        engineRef.current = engine;

        const scene = createSceneContext(engine);
        sceneRef.current = scene;
        scene.clearColor = { r: 0.1, g: 0.11, b: 0.13, a: 1 };

        const hemi = createHemisphericLight([0, 1, 0], 1.1);
        hemi.diffuseColor = [1, 1, 1];
        hemi.groundColor = [0.35, 0.38, 0.45];
        addToScene(scene, hemi);

        const key = createDirectionalLight([-0.5, -1, -0.4], 1.2);
        key.diffuse = [1, 0.98, 0.94];
        addToScene(scene, key);

        const ground = createGround(engine, { width: 300, height: 300, subdivisions: 1 });
        groundRef.current = ground;
        ground.pickable = true;
        applyThemeToScene(scene, ground, theme);
        addToScene(scene, ground);

        // Lite builds `builder._rebuildSingle` lazily after the first standard
        // build. Without that, post-start addToScene + material-swap can no-op.
        // Seed one hidden standard mesh before registerScene so dropped prims render.
        const bootstrap = createBox(engine, 0.001);
        bootstrap.visible = false;
        const bootstrapMat = createStandardMaterial();
        bootstrap.material = bootstrapMat;
        bootstrapMeshRef.current = bootstrap;
        addToScene(scene, bootstrap);

        const camera = attachDefaultCamera(scene);
        // Pass gizmo interaction detection to camera so it doesn't orbit when gizmos are active
        detachControl = attachControl(camera, canvas, scene, {
          shouldHandlePointerDown: () => !isGizmoInteracting(canvas),
          isExternalDragActive: () => isGizmoDragging(canvas),
          isExternalPickPending: () => isGizmoPickPending(canvas)
        });

        await registerScene(scene);
        await startEngine(engine);
        if (cancelled) return;
        
        // Create and register utility layer for gizmos
        const utilityLayer = createUtilityLayer(engine, scene);
        utilityLayerRef.current = utilityLayer;
        registerUtilityLayer(utilityLayer);
        
        setSceneVersion((v) => v + 1);

        const bootstrapMesh = bootstrapMeshRef.current;
        if (bootstrapMesh) {
          removeFromScene(scene, bootstrapMesh);
          bootstrapMeshRef.current = null;
        }

        pickerRef.current = createGpuPicker(scene);

        // While a transform gizmo is being dragged, mirror the live node
        // transform back into the app store so the Properties panel (X/Y/Z
        // position, rotation, scale) tracks the gizmo in real time. Gizmos
        // mutate the lite node directly and don't know about React state, so
        // without this poll the panel only reflects the pre-drag values.
        let lastPushedKey = '';
        let wasSyncing = false;
        onBeforeRender(scene, () => {
          const c = canvasRef.current;
          const node = selectedNodeRef.current as LiteNode | null;
          const emit = onTransformRef.current;
          if (!c || !node || !emit) {
            wasSyncing = false;
            return;
          }
          // Sync during a drag and for one frame after it ends (to capture the
          // final resting transform on pointer-up).
          const dragging = isGizmoDragging(c) || isGizmoInteracting(c);
          if (!dragging && !wasSyncing) return;
          wasSyncing = dragging;

          const primId = node
            ? nodeToPrimIdRef.current.get(node as object) ?? null
            : null;
          if (!primId) return;
          const prim = primsRef.current.find((p) => p.id === primId);
          const transform = readNodeTransform(node, prim?.kind);
          const key = transform.position.concat(transform.rotation, transform.scale).join(',');
          if (key === lastPushedKey) return;
          lastPushedKey = key;
          emit(primId, transform);
        });

        const onResize = () => {
          if (engineRef.current) resizeEngine(engineRef.current);
        };
        window.addEventListener('resize', onResize);
        removeResize = () => window.removeEventListener('resize', onResize);
        onResize();

        setStatus({
          kind: 'ready',
          message: 'Babylon Lite demo ready.'
        });
        
        // Test asset loading disabled for now
        // Use the proper ensureReferenceLoaded function for actual asset loading
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setStatus({
          kind: 'error',
          message: `Babylon Lite demo failed to initialize: ${message}`
        });
      }
    };

    const onDragOver = (ev: DragEvent) => {
      if (!dropEnabledRef.current) return;
      const types = ev.dataTransfer?.types;
      if (!types) return;
      if (types.includes(SHAPE_DRAG_MIME) || types.includes(ASSET_DRAG_MIME)) {
        ev.preventDefault();
        ev.dataTransfer!.dropEffect = 'copy';
      }
    };

    const onDrop = async (ev: DragEvent) => {
      if (!dropEnabledRef.current) return;
      const dt = ev.dataTransfer;
      if (!dt) return;
      const assetId = dt.getData(ASSET_DRAG_MIME);
      const shapeKind = dt.getData(SHAPE_DRAG_MIME) as ShapeKind | '';
      if (!assetId && !shapeKind) return;
      ev.preventDefault();

      const scene = sceneRef.current;
      const picker = pickerRef.current;
      const ground = groundRef.current;
      const canvas = canvasRef.current;
      if (!scene || !picker || !canvas) return;

      const rect = canvas.getBoundingClientRect();
      const xCss = ev.clientX - rect.left;
      const yCss = ev.clientY - rect.top;
      // Lite picker expects canvas pixel coordinates (not CSS pixels).
      const x = xCss * (canvas.width / Math.max(rect.width, 1));
      const y = yCss * (canvas.height / Math.max(rect.height, 1));
      const info = await pickAsync(picker, x, y);
      const p = info.hit && info.pickedPoint
        ? toVec3(info.pickedPoint)
        : getDropFallbackPosition(scene, ground);

      if (assetId) {
        onAssetDroppedRef.current(assetId, [p[0], 0, p[2]]);
      } else if (shapeKind) {
        onShapeDroppedRef.current(shapeKind, [p[0], 0, p[2]]);
      }
      focusCameraOnDrop(scene, p);
    };

    const onCanvasDrop = (ev: DragEvent) => {
      void onDrop(ev);
    };
    const onCanvasContextMenu = (ev: MouseEvent) => {
      ev.preventDefault();
    };
  const onCanvasClick = async (ev: MouseEvent) => {
      const currentTool = toolRef.current;
      if (currentTool === 'measure') return;
      const scene = sceneRef.current;
      const picker = pickerRef.current;
      const canvas = canvasRef.current;
      const engine = engineRef.current;
      const utilityLayer = utilityLayerRef.current;
      const ground = groundRef.current;
      if (!scene || !picker || !canvas || !engine || !utilityLayer) return;
      
      // Skip pick if gizmo is interacting
      if (isGizmoInteracting(canvas) || isGizmoDragging(canvas) || isGizmoPickPending(canvas)) return;
      
      const rect = canvas.getBoundingClientRect();
      const xCss = ev.clientX - rect.left;
      const yCss = ev.clientY - rect.top;
      
      // pickAsync expects CSS-space coordinates (it scales internally)
      const info = await pickAsync(picker, xCss, yCss);

      // Skip if we picked the ground or nothing
      if (!info.hit || !info.pickedMesh || info.pickedMesh === ground) {
        // While transforming, keep the current selection and its gizmo on
        // incidental ground clicks so a later tool switch still targets it.
        if (selectedNodeRef.current && currentTool !== 'select') {
          return;
        }

        // Deselect in select mode: drop the selection and hide all gizmos.
        selectedNodeRef.current = null;
        applyGizmoForMode('select', engine, utilityLayer, null, {
          position: positionGizmoRef,
          rotation: rotationGizmoRef,
          scale: scaleGizmoRef
        });
        return;
      }
      
      const pickedNode = info.pickedMesh;
      
      // If same node is already selected, just return
      if (selectedNodeRef.current === pickedNode) return;
       
      // Select the new node and show the active tool's gizmo on it.
      selectedNodeRef.current = pickedNode;
      applyGizmoForMode(currentTool, engine, utilityLayer, pickedNode, {
        position: positionGizmoRef,
        rotation: rotationGizmoRef,
        scale: scaleGizmoRef
      });
    };

    canvas.addEventListener('dragover', onDragOver);
    canvas.addEventListener('drop', onCanvasDrop);
    canvas.addEventListener('contextmenu', onCanvasContextMenu);
    canvas.addEventListener('click', onCanvasClick);

    void init();

    return () => {
      cancelled = true;
      removeResize?.();
      detachControl?.();
      
      const scene = sceneRef.current;
      const utilityLayer = utilityLayerRef.current;
      
      // Dispose gizmos
      disposeAllGizmos(utilityLayer, positionGizmoRef.current, rotationGizmoRef.current, scaleGizmoRef.current);
      positionGizmoRef.current = null;
      rotationGizmoRef.current = null;
      scaleGizmoRef.current = null;
      selectedNodeRef.current = null;
      
      // Dispose utility layer
      if (utilityLayer) disposeUtilityLayer(utilityLayer);
      utilityLayerRef.current = null;
      
      const picker = pickerRef.current;
      if (picker) disposePicker(picker);
      pickerRef.current = null;
      for (const [primId] of loadedReferencesRef.current) {
        clearLoadedReference(scene, primId, loadedReferencesRef.current);
      }
      renderEntriesRef.current.clear();
      const engine = engineRef.current;
      const bootstrapMesh = bootstrapMeshRef.current;
      if (scene && bootstrapMesh) {
        removeFromScene(scene, bootstrapMesh);
      }
      bootstrapMeshRef.current = null;
      if (engine) stopEngine(engine);
      if (scene) disposeScene(scene);
      if (engine) disposeEngine(engine);
      sceneRef.current = null;
      engineRef.current = null;
      groundRef.current = null;
      canvas.removeEventListener('dragover', onDragOver);
      canvas.removeEventListener('drop', onCanvasDrop);
      canvas.removeEventListener('contextmenu', onCanvasContextMenu);
      canvas.removeEventListener('click', onCanvasClick);
    };
  }, []);

  useEffect(() => {
    const scene = sceneRef.current;
    const engine = engineRef.current;
    if (!scene || !engine) return;

    const entries = renderEntriesRef.current;
    const primIds = new Set(prims.map((p) => p.id));

    for (const prim of prims) {
      let entry = entries.get(prim.id);
      if (!entry) {
        entry = createEntryForPrim(engine, scene, prim);
        entries.set(prim.id, entry);
        nodeToPrimIdRef.current.set(entry.node as object, prim.id);
      }
      applyPrimToNode(entry, prim);
      if (prim.kind === 'reference') {
        ensureReferenceLoaded(engine, scene, prim, entry, loadedReferencesRef.current);
      }
    }

    for (const [id, entry] of entries) {
      if (primIds.has(id)) continue;
      clearLoadedReference(scene, id, loadedReferencesRef.current);
      if (entry.isMesh) {
        removeFromScene(scene, entry.node as ReturnType<typeof createBox>);
      }
      entries.delete(id);
    }

    for (const prim of prims) {
      const entry = entries.get(prim.id);
      if (!entry) continue;
      const parentEntry = prim.parentId ? entries.get(prim.parentId) : undefined;
      entry.node.parent = parentEntry?.node ?? null;
    }
  }, [prims, sceneVersion]);

  return (
    <section className="babylon-lite-demo">
      <canvas ref={canvasRef} className="babylon-lite-canvas" aria-label="Babylon Lite demo viewport" />
      {status.kind === 'error' && (
        <div className={`babylon-lite-status is-${status.kind}`}>{status.message}</div>
      )}
    </section>
  );
}

function attachDefaultCamera(scene: ReturnType<typeof createSceneContext>) {
  const camera = createArcRotateCamera(Math.PI / 4, Math.PI / 3, 25, { x: 0, y: 0, z: 0 });
  scene.camera = camera;
  return camera;
}

function createLiteGridMaterial(theme: Theme) {
  return createGridMaterial({
    mainColor: theme === 'light' ? [0.94, 0.95, 0.97] : [0.14, 0.15, 0.18],
    lineColor: theme === 'light' ? [0.35, 0.4, 0.5] : [0.52, 0.57, 0.68],
    gridRatio: 1,
    majorUnitFrequency: 10,
    minorUnitVisibility: 0.35,
    // Lite's transparent grid blending can darken the whole viewport heavily.
    // Keep the grid opaque and control contrast via line/main colors.
    opacity: 1,
    backFaceCulling: false
  });
}

function applyThemeToScene(
  scene: ReturnType<typeof createSceneContext>,
  ground: ReturnType<typeof createGround>,
  theme: Theme
): void {
  scene.clearColor = theme === 'light'
    ? { r: 0.94, g: 0.95, b: 0.97, a: 1 }
    : { r: 0.1, g: 0.11, b: 0.13, a: 1 };
  // Grid colors are baked at creation (readonly), so the material must be
  // recreated per theme. Dispose the previous one first so toggling the theme
  // doesn't leak GPU material/pipeline state.
  const prev = ground.material as { dispose?: () => void } | undefined;
  ground.material = createLiteGridMaterial(theme);
  prev?.dispose?.();
}

function createEntryForPrim(
  engine: Awaited<ReturnType<typeof createEngine>>,
  scene: ReturnType<typeof createSceneContext>,
  prim: PrimNode
): RenderEntry {
  let node: LiteNode;
  const isMesh = prim.kind !== 'group' && prim.kind !== 'reference';
  if (prim.kind === 'group' || prim.kind === 'reference') {
    node = createTransformNode(prim.name);
  } else if (prim.kind === 'box') {
    node = createBox(engine, 1);
  } else if (prim.kind === 'cylinder') {
    node = createCylinder(engine, { height: 1, diameter: 1, tessellation: 32 });
  } else if (prim.kind === 'sphere') {
    node = createSphere(engine, { diameter: 1, segments: 32 });
  } else if (prim.kind === 'cone') {
    node = createCylinder(engine, { height: 1, diameter: 1, diameterTop: 0, tessellation: 32 });
  } else {
    node = createPlane(engine, { size: 1 });
    node.rotation.x = Math.PI / 2;
  }

  const entry: RenderEntry = { node, isMesh };
  if (isMesh) {
    const mesh = node as ReturnType<typeof createBox>;
    mesh.pickable = true;
    const mat = createStandardMaterial();
    mat.specularColor = [0.15, 0.15, 0.15];
    if (prim.kind === 'plane') mat.backFaceCulling = false;
    mesh.material = mat;
    entry.material = mat;
  }
  addToScene(scene, node);
  return entry;
}

function applyPrimToNode(entry: RenderEntry, prim: PrimNode): void {
  entry.node.name = prim.name;
  entry.node.position.x = prim.position[0];
  entry.node.position.y = prim.position[1];
  entry.node.position.z = prim.position[2];
  entry.node.rotation.x = prim.kind === 'plane' ? prim.rotation[0] + Math.PI / 2 : prim.rotation[0];
  entry.node.rotation.y = prim.rotation[1];
  entry.node.rotation.z = prim.rotation[2];
  entry.node.scaling.x = prim.scale[0];
  entry.node.scaling.y = prim.scale[1];
  entry.node.scaling.z = prim.scale[2];
  if (entry.material) {
    const diffuse = parseHexColor(prim.color);
    entry.material.diffuseColor = diffuse;
    entry.material.emissiveColor = [diffuse[0] * 0.06, diffuse[1] * 0.06, diffuse[2] * 0.06];
  }
}

/**
 * Read a lite node's transform back into store space. Mirrors applyPrimToNode
 * in reverse, including undoing the +90° X offset planes carry so the node's
 * flat orientation maps back to the prim's zero rotation.
 */
function readNodeTransform(node: LiteNode, kind: ShapeKind | undefined): PrimTransform {
  const n = node as {
    position: { x: number; y: number; z: number };
    rotation: { x: number; y: number; z: number };
    scaling: { x: number; y: number; z: number };
  };
  const rotX = kind === 'plane' ? n.rotation.x - Math.PI / 2 : n.rotation.x;
  return {
    position: [n.position.x, n.position.y, n.position.z],
    rotation: [rotX, n.rotation.y, n.rotation.z],
    scale: [n.scaling.x, n.scaling.y, n.scaling.z]
  };
}


function parseHexColor(hex: string): [number, number, number] {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return DEFAULT_LITE_COLOR;
  const v = Number.parseInt(m[1], 16);
  return [((v >> 16) & 0xff) / 255, ((v >> 8) & 0xff) / 255, (v & 0xff) / 255];
}

function toVec3(point: unknown): [number, number, number] {
  if (Array.isArray(point) && point.length >= 3) {
    return [Number(point[0]) || 0, Number(point[1]) || 0, Number(point[2]) || 0];
  }
  if (point && typeof point === 'object') {
    const p = point as { x?: unknown; y?: unknown; z?: unknown };
    return [Number(p.x) || 0, Number(p.y) || 0, Number(p.z) || 0];
  }
  return [0, 0, 0];
}

function getDropFallbackPosition(
  scene: ReturnType<typeof createSceneContext>,
  ground: ReturnType<typeof createGround> | null
): [number, number, number] {
  const camera = scene.camera as { target?: { x?: number; z?: number } } | undefined;
  if (camera?.target) {
    return [(Number(camera.target.x) || 0) + 3, 0, (Number(camera.target.z) || 0) + 3];
  }
  if (ground?.position) {
    return [ground.position.x, 0, ground.position.z];
  }
  return [0, 0, 0];
}

function focusCameraOnDrop(
  scene: ReturnType<typeof createSceneContext>,
  position: [number, number, number]
): void {
  const camera = scene.camera as { target?: { x: number; y: number; z: number }; radius?: number } | null;
  if (!camera?.target) return;
  camera.target.x = position[0];
  camera.target.y = 0;
  camera.target.z = position[2];
  if (typeof camera.radius === 'number') {
    camera.radius = Math.min(Math.max(camera.radius, 8), 16);
  }
}

function ensureReferenceLoaded(
  engine: Awaited<ReturnType<typeof createEngine>>,
  scene: ReturnType<typeof createSceneContext>,
  prim: PrimNode,
  entry: RenderEntry,
  loadedReferences: Map<string, LoadedReference>
): void {
  if (prim.kind !== 'reference') return;
  const source = prim.assetSource?.trim() ?? '';
  if (!source || !isLiteGltfSource(source)) {
    clearLoadedReference(scene, prim.id, loadedReferences);
    return;
  }

  const current = loadedReferences.get(prim.id);
  if (current?.source === source && current.roots.length > 0) {
    return;
  }
  if (current) {
    clearLoadedReference(scene, prim.id, loadedReferences);
  }

  const requestId = (current?.requestId ?? 0) + 1;
  loadedReferences.set(prim.id, { source, roots: [], requestId });
  void resolveLiteReferenceInput(source)
    .then((input) => {
      if (!input) {
        const latest = loadedReferences.get(prim.id);
        if (!latest || latest.requestId !== requestId || latest.source !== source) return;
        console.error(`Babylon Lite user asset URL not registered for ${source}`);
        loadedReferences.delete(prim.id);
        return;
      }
      return typeof input === 'string'
        ? loadGltf(engine, input)
        : loadGltf(engine, input);
    })
    .then((container) => {
      if (!container) {
        console.error(`[Lite] loadGltf returned null/undefined for ${source}`);
        return;
      }
      const latest = loadedReferences.get(prim.id);
      if (!latest || latest.requestId !== requestId || latest.source !== source) {
        return;
      }
      const roots = attachLoadedContainer(scene, entry.node, container);
      fitReferenceAfterLoad(scene, entry.node, container);
      loadedReferences.set(prim.id, { source, roots, requestId });
    })
    .catch((err) => {
      const latest = loadedReferences.get(prim.id);
      if (!latest || latest.requestId !== requestId || latest.source !== source) return;
      console.error(`Failed to load Babylon Lite reference ${source}`, err);
    });
}

function attachLoadedContainer(
  scene: ReturnType<typeof createSceneContext>,
  parentNode: LiteNode,
  container: LiteAssetContainer
): unknown[] {
  const roots: unknown[] = [];
  for (const entity of container.entities) {
    if (isLiteSceneNode(entity)) {
      entity.parent = parentNode;
    }
    // Recursively add entity and all its children to the scene
    addEntityRecursive(scene, entity, parentNode);
    roots.push(entity);
  }
  return roots;
}

function addEntityRecursive(
  scene: ReturnType<typeof createSceneContext>,
  entity: unknown,
  parentNode?: LiteNode,
  depth: number = 0
): void {
  // Add the entity itself to scene if it's a valid type
  if (entity && typeof entity === 'object') {
    const isMesh = isLiteMesh(entity);
    const meshEntity = entity as any;
    
    // Ensure meshes are visible
    if ('visible' in meshEntity) {
      meshEntity.visible = true;
    }
    
    // Ensure meshes have a material
    if (isMesh && !meshEntity.material) {
      meshEntity.material = createStandardMaterial();
    }
    
    addToScene(scene, entity as any);
    
    // Recursively add all children
    const children = meshEntity.children as unknown[] | undefined;
    if (children && Array.isArray(children)) {
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        addEntityRecursive(scene, child, parentNode, depth + 1);
      }
    }
  }
}

function clearLoadedReference(
  scene: ReturnType<typeof createSceneContext> | null,
  primId: string,
  loadedReferences: Map<string, LoadedReference>
): void {
  const loaded = loadedReferences.get(primId);
  if (!loaded) return;
  if (scene) {
    for (const root of loaded.roots) {
      removeNodeTree(scene, root);
    }
  }
  loadedReferences.delete(primId);
}

function removeNodeTree(
  scene: ReturnType<typeof createSceneContext>,
  node: unknown
): void {
  if (!isLiteSceneNode(node)) return;
  const children = [...node.children];
  for (const child of children) {
    removeNodeTree(scene, child);
  }
  node.parent = null;
  if (isLiteMesh(node)) {
    removeFromScene(scene, node);
  }
}

function isLiteSceneNode(node: unknown): node is LiteSceneNode {
  return !!node && typeof node === 'object' && 'children' in node && 'parent' in node;
}

function isLiteMesh(node: unknown): node is LiteMesh {
  return (
    !!node &&
    typeof node === 'object' &&
    'material' in node &&
    'receiveShadows' in node
  );
}

function isLiteGltfSource(source: string): boolean {
  return /\.(glb|gltf)$/i.test(source);
}

function toLiteLoadUrl(url: string): string {
  if (/^(blob:|https?:|data:)/i.test(url)) return url;
  const base = typeof window !== 'undefined' ? window.location.href : 'http://localhost/';
  return new URL(url, base).href;
}

async function resolveLiteReferenceInput(source: string): Promise<LiteReferenceInput | null> {
  if (source.startsWith('user://')) {
    const parsed = parseUserAssetPath(source);
    if (parsed) {
      let item = getUserLibraryItem(parsed.itemId);
      if (!item) {
        await loadUserLibrary();
        item = getUserLibraryItem(parsed.itemId);
      }
      const blob = item?.blobs?.[parsed.fileName];
      if (blob) return blob;
    }

    let url = resolveUserAssetUrl(source);
    if (!url) {
      await loadUserLibrary();
      url = resolveUserAssetUrl(source);
    }
    return url ? toLiteLoadUrl(url) : null;
  }
  return toLiteLoadUrl(resolveAssetUrl(source));
}

function parseUserAssetPath(source: string): { itemId: string; fileName: string } | null {
  const m = /^user:\/\/([^/]+)\/(.+)$/.exec(source);
  if (!m) return null;
  return { itemId: m[1], fileName: m[2] };
}

function fitReferenceAfterLoad(
  scene: ReturnType<typeof createSceneContext>,
  parentNode: LiteNode,
  container: LiteAssetContainer
): void {
  const meshes = getContainerMeshes(container);
  let maxExtent = 0;
  for (const mesh of meshes) {
    const min = mesh.boundMin;
    const max = mesh.boundMax;
    if (!min || !max) continue;
    const extents = [
      Math.abs(max[0] - min[0]),
      Math.abs(max[1] - min[1]),
      Math.abs(max[2] - min[2])
    ];
    const extent = Math.max(...extents);
    maxExtent = Math.max(maxExtent, extent);
  }
  if (maxExtent > 0 && maxExtent < 0.25) {
    const s = Math.min(100, 1 / maxExtent);
    parentNode.scaling.x *= s;
    parentNode.scaling.y *= s;
    parentNode.scaling.z *= s;
  }
  const camera = scene.camera as any;
  if (camera?.target) {
    camera.target.x = parentNode.position.x;
    camera.target.y = parentNode.position.y;
    camera.target.z = parentNode.position.z;
    if (typeof camera.radius === 'number') {
      const desired = Math.max(8, Math.min(32, maxExtent > 0 ? maxExtent * 3 : 16));
      camera.radius = desired;
    }
  }
}
 
function disposeAllGizmos(
  utilityLayer: ReturnType<typeof createUtilityLayer> | null,
  posGizmo: ReturnType<typeof createPositionGizmo> | null,
  rotGizmo: ReturnType<typeof createRotationGizmo> | null,
  scaleGizmo: ReturnType<typeof createScaleGizmo> | null
): void {
  if (posGizmo && utilityLayer) disposePositionGizmo(posGizmo, utilityLayer);
  if (rotGizmo && utilityLayer) disposeRotationGizmo(rotGizmo, utilityLayer);
  if (scaleGizmo && utilityLayer) disposeScaleGizmo(scaleGizmo, utilityLayer);
}

type GizmoRefs = {
  position: { current: ReturnType<typeof createPositionGizmo> | null };
  rotation: { current: ReturnType<typeof createRotationGizmo> | null };
  scale: { current: ReturnType<typeof createScaleGizmo> | null };
};

/**
 * Toggle the rendered meshes of a composite gizmo on or off.
 *
 * Why not `setMeshVisible(gizmo.xGizmo.root, ...)`? In babylon-lite the visible
 * arrow/ring/cube meshes are parented to the sub-gizmo `root` via `.parent`,
 * but the parent setter only wires the world-matrix hierarchy — it never adds
 * the mesh to `root.children`. `setSubtreeVisible` walks `children`, so it only
 * flips the (already invisible) root and never reaches the real geometry. That
 * is why toggling root visibility left every gizmo stacked on screen.
 *
 * Each sub-gizmo exposes `_visibleMeshes` (the rendered arrow/ring/cube, minus
 * the invisible root and pick colliders). Setting `.visible` on those directly
 * is what the render bundle honors (`drawList` skips `mesh.visible === false`).
 */
function setCompositeGizmoVisible(
  gizmo:
    | ReturnType<typeof createPositionGizmo>
    | ReturnType<typeof createRotationGizmo>
    | ReturnType<typeof createScaleGizmo>,
  visible: boolean
): void {
  const g = gizmo as any;
  const subs = [g.xGizmo, g.yGizmo, g.zGizmo, g.xPlaneGizmo, g.yPlaneGizmo, g.zPlaneGizmo, g.uniformScaleGizmo];
  for (const sub of subs) {
    const meshes = sub?._visibleMeshes as { visible: boolean }[] | undefined;
    if (!meshes) continue;
    for (const m of meshes) m.visible = visible;
  }
}

/**
 * Show only the active tool's gizmo, hiding the others — mirroring the regular
 * Babylon path where a single gizmo is live at a time.
 *
 * All three gizmos are created once and kept alive (see ensureGizmos). We never
 * dispose them on a tool switch: disposing destroys GPU buffers that the utility
 * layer's cached render bundle still references, which crashes the WebGPU device
 * ("Buffer used in submit while destroyed"). Instead we toggle mesh visibility
 * and detach the inactive gizmos (a hidden-but-attached gizmo can still capture
 * pointer drags). `invalidateRenderBundles` then forces the cached bundle to
 * re-record so the visibility change actually takes effect next frame.
 */
function applyGizmoForMode(
  mode: 'select' | 'move' | 'rotate' | 'scale' | 'measure',
  engine: Awaited<ReturnType<typeof createEngine>> | null,
  utilityLayer: ReturnType<typeof createUtilityLayer> | null,
  selectedNode: unknown | null,
  refs: GizmoRefs
): void {
  if (!engine || !utilityLayer) return;

  // Lazily create the three gizmos once. They persist for the component's life.
  if (!refs.position.current) {
    try {
      refs.position.current = createPositionGizmo(engine, utilityLayer);
      refs.rotation.current = createRotationGizmo(engine, utilityLayer);
      refs.scale.current = createScaleGizmo(engine, utilityLayer);
    } catch (err) {
      console.warn('[Lite] Failed to create gizmos:', err);
      return;
    }
  }

  const pos = refs.position.current;
  const rot = refs.rotation.current;
  const scale = refs.scale.current;

  // Hide + detach every gizmo first.
  if (pos) {
    setCompositeGizmoVisible(pos, false);
    attachPositionGizmoToNode(pos, null);
  }
  if (rot) {
    setCompositeGizmoVisible(rot, false);
    attachRotationGizmoToNode(rot, null);
  }
  if (scale) {
    setCompositeGizmoVisible(scale, false);
    attachScaleGizmoToNode(scale, null);
  }

  // Attach + show only the active gizmo, when there's something to transform.
  const node = selectedNode as any;
  if (node && mode !== 'select' && mode !== 'measure') {
    if (mode === 'move' && pos) {
      attachPositionGizmoToNode(pos, node);
      setCompositeGizmoVisible(pos, true);
    } else if (mode === 'rotate' && rot) {
      attachRotationGizmoToNode(rot, node);
      setCompositeGizmoVisible(rot, true);
    } else if (mode === 'scale' && scale) {
      attachScaleGizmoToNode(scale, node);
      setCompositeGizmoVisible(scale, true);
    }
  }

  // Force the utility layer's cached render bundle to re-record; without this
  // the visibility changes above are ignored until some other scene mutation.
  invalidateRenderBundles(engine);
}
