"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { GameProfile } from "@/brands/types";
import type { PublicWorldMapCommunity } from "@/server/world-map/read";
import {
  buildWorldMapLayout,
  clampWorldMapCamera,
  clampZoom,
  findWorldMapCommunity,
  hitTestWorldMap,
  initialWorldMapCamera,
  screenToWorld,
  WORLD_MAP_NODE_HEIGHT,
  WORLD_MAP_NODE_WIDTH,
} from "@/server/world-map/layout-core.mjs";

type Camera = { x: number; y: number; zoom: number };
type Viewport = { width: number; height: number };
type LayoutNode = PublicWorldMapCommunity & { x: number; y: number; row: number; column: number };
type Layout = {
  nodes: LayoutNode[];
  connections: { from: LayoutNode; to: LayoutNode }[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number };
};

function mapNoun(profile: GameProfile) {
  return profile === "kingshot" ? "Kingdom" : "State";
}

export function WorldMap({
  communities,
  profile,
  unavailable = false,
}: {
  readonly communities: PublicWorldMapCommunity[];
  readonly profile: GameProfile;
  readonly unavailable?: boolean;
}) {
  const noun = mapNoun(profile);
  const router = useRouter();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef(false);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pointerOriginsRef = useRef(new Map<number, { x: number; y: number }>());
  const gestureRef = useRef<null | {
    distance: number;
    midpoint: { x: number; y: number };
    world: { x: number; y: number };
    camera: Camera;
  }>(null);
  const draggedRef = useRef(false);
  const animationRef = useRef<number | null>(null);
  const [viewport, setViewport] = useState<Viewport>({ width: 0, height: 0 });
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, zoom: 1 });
  const cameraRef = useRef(camera);
  const [dragging, setDragging] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightedCode, setHighlightedCode] = useState<string | null>(null);
  const [searchMessage, setSearchMessage] = useState("");
  const layout = useMemo(() => buildWorldMapLayout(communities) as Layout, [communities]);

  useEffect(() => { cameraRef.current = camera; }, [camera]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const observer = new ResizeObserver(([entry]) => {
      const next = {
        width: Math.max(1, Math.round(entry.contentRect.width)),
        height: Math.max(1, Math.round(entry.contentRect.height)),
      };
      setViewport(next);
      if (!initializedRef.current && layout.nodes.length) {
        initializedRef.current = true;
        setCamera(initialWorldMapCamera(layout.bounds, next));
      }
    });
    observer.observe(surface);
    return () => observer.disconnect();
  }, [layout]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !viewport.width || !viewport.height) return;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(viewport.width * pixelRatio);
    canvas.height = Math.round(viewport.height * pixelRatio);
    const context = canvas.getContext("2d");
    if (!context) return;
    const styles = getComputedStyle(document.documentElement);
    const color = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, viewport.width, viewport.height);
    context.fillStyle = color("--brand-surface-muted", "#f1f5f9");
    context.fillRect(0, 0, viewport.width, viewport.height);
    context.save();
    context.translate(viewport.width / 2, viewport.height / 2);
    context.scale(camera.zoom, camera.zoom);
    context.translate(-camera.x, -camera.y);

    context.strokeStyle = color("--brand-border", "#d4d4d8");
    context.lineWidth = Math.max(1.5, 2 / camera.zoom);
    for (const connection of layout.connections) {
      context.beginPath();
      context.moveTo(connection.from.x, connection.from.y);
      context.lineTo(connection.to.x, connection.to.y);
      context.stroke();
    }

    for (const node of layout.nodes) {
      const highlighted = node.code === highlightedCode;
      context.fillStyle = color("--brand-surface", "#ffffff");
      context.strokeStyle = highlighted
        ? color("--brand-accent-strong", "#1d4ed8")
        : color("--brand-accent", "#2563eb");
      context.lineWidth = (highlighted ? 5 : 2.5) / camera.zoom;
      context.beginPath();
      context.roundRect(
        node.x - WORLD_MAP_NODE_WIDTH / 2,
        node.y - WORLD_MAP_NODE_HEIGHT / 2,
        WORLD_MAP_NODE_WIDTH,
        WORLD_MAP_NODE_HEIGHT,
        12,
      );
      context.fill();
      context.stroke();
      context.fillStyle = color("--brand-text", "#18181b");
      context.textAlign = "center";
      context.textBaseline = "middle";
      const codeFont = camera.zoom < 0.5 ? 42 : 28;
      context.font = `800 ${codeFont}px system-ui, sans-serif`;
      context.fillText(node.code, node.x, node.y + (camera.zoom >= 0.68 ? -12 : 0), 156);
      if (camera.zoom >= 0.68) {
        context.fillStyle = color("--brand-text-muted", "#52525b");
        context.font = "600 15px system-ui, sans-serif";
        context.fillText(node.displayName, node.x, node.y + 23, 154);
      }
    }
    context.restore();
  }, [camera, highlightedCode, layout, viewport]);

  const updateCamera = useCallback((updater: (value: Camera) => Camera) => {
    setCamera((current) => {
      const next = updater(current);
      return clampWorldMapCamera(
        { ...next, zoom: clampZoom(next.zoom) },
        layout.bounds,
        viewport,
      );
    });
  }, [layout.bounds, viewport]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rectangle = canvas.getBoundingClientRect();
      const point = { x: event.clientX - rectangle.left, y: event.clientY - rectangle.top };
      setCamera((current) => {
        const world = screenToWorld(point, current, viewport);
        const zoom = clampZoom(current.zoom * Math.exp(-event.deltaY * 0.0015));
        return clampWorldMapCamera({
          x: world.x - (point.x - viewport.width / 2) / zoom,
          y: world.y - (point.y - viewport.height / 2) / zoom,
          zoom,
        }, layout.bounds, viewport);
      });
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [layout.bounds, viewport]);

  function pointerPoint(event: ReactPointerEvent<HTMLCanvasElement>) {
    const rectangle = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rectangle.left, y: event.clientY - rectangle.top };
  }

  function onPointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointerPoint(event);
    pointersRef.current.set(event.pointerId, point);
    pointerOriginsRef.current.set(event.pointerId, point);
    draggedRef.current = false;
    setDragging(true);
    if (pointersRef.current.size === 2) {
      const [first, second] = [...pointersRef.current.values()];
      const midpoint = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
      gestureRef.current = {
        distance: Math.hypot(second.x - first.x, second.y - first.y),
        midpoint,
        world: screenToWorld(midpoint, cameraRef.current, viewport),
        camera: cameraRef.current,
      };
    }
  }

  function onPointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    const previous = pointersRef.current.get(event.pointerId);
    if (!previous) return;
    const next = pointerPoint(event);
    pointersRef.current.set(event.pointerId, next);
    if (pointersRef.current.size >= 2 && gestureRef.current) {
      const [first, second] = [...pointersRef.current.values()];
      const midpoint = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
      const distance = Math.hypot(second.x - first.x, second.y - first.y);
      const zoom = clampZoom(gestureRef.current.camera.zoom * distance / Math.max(1, gestureRef.current.distance));
      const world = gestureRef.current.world;
      setCamera(clampWorldMapCamera({
        x: world.x - (midpoint.x - viewport.width / 2) / zoom,
        y: world.y - (midpoint.y - viewport.height / 2) / zoom,
        zoom,
      }, layout.bounds, viewport));
      draggedRef.current = true;
      return;
    }
    const dx = next.x - previous.x;
    const dy = next.y - previous.y;
    const origin = pointerOriginsRef.current.get(event.pointerId) ?? previous;
    if (Math.hypot(next.x - origin.x, next.y - origin.y) > 5) draggedRef.current = true;
    updateCamera((current) => ({
      ...current,
      x: current.x - dx / current.zoom,
      y: current.y - dy / current.zoom,
    }));
  }

  function finishPointer(event: ReactPointerEvent<HTMLCanvasElement>) {
    const point = pointerPoint(event);
    const wasSinglePointer = pointersRef.current.size === 1;
    pointersRef.current.delete(event.pointerId);
    pointerOriginsRef.current.delete(event.pointerId);
    if (pointersRef.current.size < 2) gestureRef.current = null;
    if (pointersRef.current.size === 0) setDragging(false);
    if (wasSinglePointer && !draggedRef.current) {
      const node = hitTestWorldMap(layout.nodes, point, cameraRef.current, viewport) as LayoutNode | null;
      if (node) router.push(node.href);
    }
  }

  function cancelPointer(event: ReactPointerEvent<HTMLCanvasElement>) {
    pointersRef.current.delete(event.pointerId);
    pointerOriginsRef.current.delete(event.pointerId);
    gestureRef.current = null;
    if (pointersRef.current.size === 0) setDragging(false);
  }

  const animateTo = useCallback((target: Camera) => {
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setCamera(target);
      return;
    }
    const start = cameraRef.current;
    const startedAt = performance.now();
    const frame = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / 280);
      const eased = 1 - (1 - progress) ** 3;
      setCamera({
        x: start.x + (target.x - start.x) * eased,
        y: start.y + (target.y - start.y) * eased,
        zoom: start.zoom + (target.zoom - start.zoom) * eased,
      });
      if (progress < 1) animationRef.current = requestAnimationFrame(frame);
    };
    animationRef.current = requestAnimationFrame(frame);
  }, []);

  useEffect(() => () => {
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
  }, []);

  function search(event: FormEvent) {
    event.preventDefault();
    const community = findWorldMapCommunity(layout.nodes, query) as LayoutNode | null;
    if (!community) {
      setHighlightedCode(null);
      setSearchMessage(`${noun} ${query.trim() || "number"} is not currently registered.`);
      return;
    }
    setHighlightedCode(community.code);
    setSearchMessage(`${noun} ${community.code}, ${community.displayName}, located.`);
    animateTo({ x: community.x, y: community.y, zoom: Math.max(1.05, cameraRef.current.zoom) });
  }

  if (unavailable) {
    return <p className="world-map__empty" role="alert">The World map is temporarily unavailable.</p>;
  }
  if (communities.length === 0) {
    return <p className="world-map__empty">No {noun}s are registered yet.</p>;
  }

  const highlighted = communities.find((community) => community.code === highlightedCode);
  return (
    <section className="world-map" aria-labelledby="world-map-title">
      <header className="world-map__heading">
        <div>
          <p className="eyebrow">Public discovery</p>
          <h1 id="world-map-title">{noun} World</h1>
          <p>Drag to explore, zoom with the wheel or a pinch, or jump to a registered {noun.toLowerCase()}.</p>
        </div>
        <form className="world-map-search" onSubmit={search} role="search">
          <label htmlFor="world-map-code">Find a {noun}</label>
          <div>
            <input
              id="world-map-code"
              inputMode="numeric"
              onChange={(event) => setQuery(event.target.value.replace(/\D/g, ""))}
              pattern="[0-9]+"
              placeholder={`Enter ${noun}`}
              value={query}
            />
            <button type="submit">Jump</button>
          </div>
          <p aria-live="polite">{searchMessage}</p>
          {highlighted ? <Link href={highlighted.href}>Open {noun} {highlighted.code}</Link> : null}
        </form>
      </header>

      <div className="world-map-surface" ref={surfaceRef}>
        <canvas
          aria-hidden="true"
          className={dragging ? "world-map-canvas world-map-canvas--dragging" : "world-map-canvas"}
          onPointerCancel={cancelPointer}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finishPointer}
          ref={canvasRef}
        />
        <div className="world-map-controls">
          <button aria-label="Zoom in" onClick={() => updateCamera((value) => ({ ...value, zoom: value.zoom * 1.25 }))}>+</button>
          <button aria-label="Zoom out" onClick={() => updateCamera((value) => ({ ...value, zoom: value.zoom / 1.25 }))}>−</button>
        </div>
      </div>

      <details className="world-map-directory">
        <summary>Browse all registered {noun}s ({communities.length})</summary>
        <ul>
          {communities.map((community) => (
            <li key={community.code}>
              <Link href={community.href}>
                <strong>{noun} {community.code}</strong>
                <span>{community.displayName}</span>
              </Link>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
