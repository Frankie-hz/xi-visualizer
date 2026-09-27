import { parseNavMesh } from "../graphics/navmesh";
import { extract, type Extraction, type PathData } from "./extract";
import { fillGaps, type Generated } from "./generate";

/**
 * The gzipped roam file, the server's navmesh, and the zone's deep-water triangles (flat xyz, three
 * vertices each); any may be missing for a zone.
 */
export type WorkerRequest = { compressed?: ArrayBuffer; nav?: ArrayBuffer; water?: ArrayBuffer };

/** Extracted nodes seen by fewer mobs than this are too weak to anchor the gap filler. */
const ANCHOR_MIN_MOBS = 2;

export type WorkerMessage =
  | { type: "progress"; stage: string; done: number; total: number }
  | { type: "done"; result: Extraction; generated: Generated }
  | { type: "error"; message: string };

const post = (message: WorkerMessage) => self.postMessage(message);

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  try {
    post({ type: "progress", stage: "Reading roam data", done: 0, total: 1 });
    const data: PathData = await (async () => {
      if (!event.data.compressed) return {};
      const stream = new Response(event.data.compressed).body!.pipeThrough(new DecompressionStream("gzip"));
      return JSON.parse(await new Response(stream).text());
    })();
    const nav = (() => {
      if (!event.data.nav) return undefined;
      return parseNavMesh(event.data.nav);
    })();
    let lastPost = 0;
    const result = extract(data, (stage, done, total) => {
      const now = performance.now();
      if (now - lastPost < 100 && done !== 0) return;
      lastPost = now;
      post({ type: "progress", stage, done, total });
    });
    post({ type: "progress", stage: "Filling gaps", done: 0, total: 1 });
    const firstId = result.nodes.reduce((m, n) => Math.max(m, n.id), -1) + 1;
    const water = (() => {
      if (!event.data.water) return undefined;
      return new Float32Array(event.data.water);
    })();
    const generated = fillGaps(data, result.nodes.filter(n => n.mobs >= ANCHOR_MIN_MOBS), firstId, nav, water);
    post({ type: "done", result, generated });
  } catch (e) {
    post({ type: "error", message: String(e) });
  }
};
