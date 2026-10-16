import { DxfEntity } from "./types.ts";

export function mapParserEntityToDxfEntity(e: any): DxfEntity {
  const type = String(e?.type ?? "");
  if (type === "TEXT") {
    return {
      type: "TEXT",
      text: String(e?.text ?? ""),
      position: e?.startPoint ? { x: Number(e.startPoint.x), y: Number(e.startPoint.y) } : undefined,
      textHeight: Number.isFinite(e?.textHeight) ? Number(e.textHeight) : undefined,
      rotation: Number.isFinite(e?.rotation) ? Number(e.rotation) : 0,
      layer: e?.layer,
    };
  }
  if (type === "POLYLINE" || type === "LWPOLYLINE") {
    const vertices = Array.isArray(e?.vertices)
      ? e.vertices.map((v: any) => ({
          x: Number(v?.x ?? 0),
          y: Number(v?.y ?? 0),
          layer: v?.layer,
          bulge: Number.isFinite(v?.bulge) ? Number(v.bulge) : undefined,
        }))
      : [];
    return {
      type: "POLYLINE",
      vertices,
      shape: Boolean(e?.shape || e?.closed),
      closed: Boolean(e?.closed),
      layer: e?.layer,
      polyType: Number.isFinite(e?.polyType) ? Number(e.polyType) : undefined,
    };
  }
  if (type === "LINE") {
    // dxf-parser exposes LINE endpoints through `vertices`. Older normalized
    // JSON payloads may use start/end, so retain that shape as a fallback.
    const sourceVertices = Array.isArray(e?.vertices) && e.vertices.length >= 2
      ? e.vertices.slice(0, 2)
      : [e?.start, e?.end];
    const vertices = sourceVertices.map((v: any) => ({
      x: Number(v?.x ?? 0),
      y: Number(v?.y ?? 0),
      layer: v?.layer ?? e?.layer,
    }));
    return { type: "LINE", vertices, layer: e?.layer };
  }
  if (type === "CIRCLE") {
    return {
      type: "CIRCLE",
      center: e?.center ? { x: Number(e.center.x), y: Number(e.center.y) } : undefined,
      radius: Number.isFinite(e?.radius) ? Number(e.radius) : undefined,
      layer: e?.layer,
    };
  }
  if (type === "ARC") {
    // dxf-parser returns ARC angles in radians; the editor's normalized DXF
    // representation and arc tessellator use degrees.
    const radiansToDegrees = (value: unknown) =>
      Number.isFinite(value) ? (Number(value) * 180) / Math.PI : undefined;
    return {
      type: "ARC",
      center: e?.center ? { x: Number(e.center.x ?? 0), y: Number(e.center.y ?? 0) } : undefined,
      radius: Number.isFinite(e?.radius) ? Number(e.radius) : undefined,
      startAngle: radiansToDegrees(e?.startAngle),
      endAngle: radiansToDegrees(e?.endAngle),
      layer: e?.layer,
    };
  }
  if (type === "INSERT") {
    return {
      type: "INSERT",
      name: String(e?.name ?? e?.blockName ?? ""),
      position: { x: Number(e?.position?.x ?? 0), y: Number(e?.position?.y ?? 0) },
      rotation: Number(e?.rotation ?? 0),
      scale: Number(e?.scale ?? undefined),
      xScale: Number(e?.xScale ?? undefined),
      yScale: Number(e?.yScale ?? undefined),
      layer: e?.layer,
    };
  }
  if (type === "POINT") {
    const pos =
      e?.position ??
      e?.point ??
      (Number.isFinite(e?.x) || Number.isFinite(e?.y) ? { x: e?.x, y: e?.y } : null);
    return {
      type: "POINT",
      position: pos ? { x: Number(pos?.x ?? 0), y: Number(pos?.y ?? 0) } : { x: 0, y: 0 },
      layer: e?.layer,
    };
  }
  // Fallback: unknown types ignored in extraction phase
  return { type } as DxfEntity;
}
