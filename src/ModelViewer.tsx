import { useEffect, useRef, useState } from "react";
import { validateLocalGlb } from "../shared/glb";

type ViewMode = "texture" | "clay" | "wireframe";

export default function ModelViewer({ source }: { source: string }) {
  const host = useRef<HTMLDivElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const reset = useRef<() => void>(() => {});
  const applyMode = useRef<(mode: ViewMode) => void>(() => {});
  const currentMode = useRef<ViewMode>("texture");
  const [mode, setMode] = useState<ViewMode>("texture");
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    currentMode.current = "texture";
    setMode("texture");
  }, [source]);
  useEffect(() => {
    if (!shell.current) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    observer.observe(shell.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || !host.current) return;
    const container = host.current;
    const abort = new AbortController();
    let disposed = false;
    let cleanup = () => {};
    setError(""); setLoading(true);
    void (async () => {
      const [THREE, { GLTFLoader }, { OrbitControls }] = await Promise.all([
        import("three"), import("three/addons/loaders/GLTFLoader.js"), import("three/addons/controls/OrbitControls.js"),
      ]);
      if (disposed) return;
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setClearColor(0xf4f4f2, 1);
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      container.appendChild(renderer.domElement);
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = false;
      const light = new THREE.DirectionalLight(0xffffff, 3);
      light.position.set(3, 5, 4);
      scene.add(new THREE.HemisphereLight(0xffffff, 0x777777, 3), light);
      const render = () => { if (!disposed) renderer.render(scene, camera); };
      controls.addEventListener("change", render);
      const resize = () => {
        const width = Math.max(1, container.clientWidth), height = Math.max(1, container.clientHeight);
        renderer.setSize(width, height);
        camera.aspect = width / height; camera.updateProjectionMatrix(); render();
      };
      const observer = new ResizeObserver(resize);
      observer.observe(container);
      const originalMaterials = new Map<import("three").Mesh, import("three").Material | import("three").Material[]>();
      let wireframeMaterial: import("three").MeshBasicMaterial | undefined;
      let clayMaterial: import("three").MeshStandardMaterial | undefined;
      function disposeObject(root: import("three").Object3D) {
        const textures = new Set<import("three").Texture>();
        const materials = new Set<import("three").Material>();
        const geometries = new Set<import("three").BufferGeometry>();
        root.traverse((object) => {
          const mesh = object as import("three").Mesh;
          if (mesh.geometry) geometries.add(mesh.geometry);
          for (const material of Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []) {
            materials.add(material);
            for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
          }
        });
        const images = new Set<ImageBitmap>();
        for (const texture of textures) {
          if (texture.source.data instanceof ImageBitmap) images.add(texture.source.data);
          texture.dispose();
        }
        images.forEach((image) => image.close());
        materials.forEach((material) => material.dispose());
        geometries.forEach((geometry) => geometry.dispose());
      }
      cleanup = () => {
        observer.disconnect(); controls.dispose();
        for (const [mesh, material] of originalMaterials) mesh.material = material;
        disposeObject(scene); wireframeMaterial?.dispose(); clayMaterial?.dispose();
        renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
        reset.current = () => {}; applyMode.current = () => {};
      };
      resize();
      const response = await fetch(source, { signal: abort.signal });
      if (!response.ok) throw new Error("Файл 3D-модели не найден в папке данных");
      if (Number(response.headers.get("content-length")) > 256 * 1024 * 1024) throw new Error("3D-модель больше 256 МБ");
      const buffer = await response.arrayBuffer();
      if (disposed) return;
      validateLocalGlb(new Uint8Array(buffer));
      const manager = new THREE.LoadingManager();
      // ImageBitmapLoader fetches blob URLs through connect-src. TextureLoader uses
      // img-src, which already permits embedded GLB images under the app's CSP.
      let textureLoadFailed = false;
      manager.onError = () => { textureLoadFailed = true; };
      manager.setURLModifier((url) => {
        if (!url.startsWith("blob:") && !url.startsWith("data:")) throw new Error("Внешние ресурсы 3D-модели запрещены");
        return url;
      });
      const loader = new GLTFLoader(manager);
      loader.register((parser) => {
        parser.textureLoader = new THREE.TextureLoader(manager);
        return { name: "PI_embedded_textures" };
      });
      const gltf = await loader.parseAsync(buffer, "");
      if (disposed) { disposeObject(gltf.scene); return; }
      if (textureLoadFailed) {
        disposeObject(gltf.scene);
        throw new Error("Не удалось загрузить встроенные текстуры 3D-модели");
      }
      scene.add(gltf.scene);
      wireframeMaterial = new THREE.MeshBasicMaterial({ color: 0x333333, wireframe: true, side: THREE.DoubleSide });
      clayMaterial = new THREE.MeshStandardMaterial({ color: 0xc8c8c8, roughness: 1, metalness: 0, side: THREE.DoubleSide });
      gltf.scene.traverse((object) => {
        if (object instanceof THREE.Mesh) originalMaterials.set(object, object.material);
      });
      applyMode.current = (nextMode) => {
        for (const [mesh, material] of originalMaterials) mesh.material = nextMode === "wireframe" ? wireframeMaterial! : nextMode === "clay" ? clayMaterial! : material;
        render();
      };
      applyMode.current(currentMode.current);
      const bounds = new THREE.Box3().setFromObject(gltf.scene);
      if (bounds.isEmpty()) throw new Error("В GLB нет отображаемой геометрии");
      const center = bounds.getCenter(new THREE.Vector3());
      const size = Math.max(...bounds.getSize(new THREE.Vector3()).toArray(), 0.001);
      camera.near = size / 1000; camera.far = size * 100;
      camera.updateProjectionMatrix();
      controls.minDistance = size * 0.05; controls.maxDistance = size * 30;
      camera.position.copy(center).add(new THREE.Vector3(size * 1.5, size, size * 2));
      controls.target.copy(center); controls.update(); controls.saveState();
      reset.current = () => controls.reset();
      setLoading(false); render();
    })().catch((failure) => {
      if (!disposed) { cleanup(); cleanup = () => {}; setLoading(false); setError(failure instanceof Error ? failure.message : String(failure)); }
    });
    return () => { disposed = true; abort.abort(); cleanup(); };
  }, [source, visible]);
  return <div ref={shell} className="model-viewer">
    <div ref={host} className="model-viewer-canvas" onContextMenu={(event) => event.preventDefault()} aria-label="Интерактивная 3D-модель" />
    {(loading || error) && <div className="model-viewer-status" role="status">{error || "Загрузка 3D-модели…"}</div>}
    <div className="model-viewer-toolbar">
      <small>Левая кнопка — вращать · Правая — сдвиг · Колесо — масштаб</small>
      <div className="model-viewer-modes" role="group" aria-label="Режим просмотра модели">
        {([ ["texture", "Текстура"], ["clay", "Глина"], ["wireframe", "Сетка"] ] as const).map(([value, label]) =>
          <button key={value} type="button" aria-pressed={mode === value} onClick={() => { currentMode.current = value; setMode(value); applyMode.current(value); }}>{label}</button>
        )}
      </div>
      <button onClick={() => reset.current()}>Сбросить вид</button>
      <button onClick={() => {
        const action = document.fullscreenElement === shell.current ? document.exitFullscreen() : shell.current?.requestFullscreen();
        void action?.catch(() => setError("Полноэкранный просмотр недоступен"));
      }}>На весь экран / свернуть</button>
    </div>
  </div>;
}
