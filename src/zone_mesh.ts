import zones from "./data/zones";
import type { ZoneData } from "./types";
import { decompress, fetchProgress } from "./util";

/** How a zone's name is spelled in the ximesh and navmesh file names. */
export const meshFileName = (name: string) =>
  name.replaceAll(" - ", "-").replaceAll(" ", "_").replaceAll("'", "").replaceAll("(", "").replaceAll(")", "").replaceAll("#", "");

/** Downloads and decompresses a zone's ximesh, reporting progress as it goes. */
export async function loadZoneMesh(id: number, onStatus: (message?: string) => void): Promise<ZoneData> {
  const zone = zones[id];
  if (!zone) throw new Error(`unknown zone id ${id}`);

  const filename = meshFileName(zone.name);

  onStatus("Downloading mesh...");
  const compressed = await fetchProgress(`${import.meta.env.BASE_URL}/ximeshes/${filename}.ximesh`, progress => {
    if (progress !== undefined) onStatus(`Downloading mesh ${(progress * 100).toFixed(0)}%`);
  });
  onStatus("Decompressing mesh...");
  const mesh = await decompress(compressed);
  onStatus(undefined);
  return { id, name: zone.name, mesh } as ZoneData;
}

/**
 * The server's navmesh for a zone, straight from LandSandBoat's xiNavmeshes repository.
 *
 * Named like the ximesh, except that a bracketed suffix loses its brackets in some zones and keeps
 * them in others, so both spellings are tried.
 */
export async function loadNavMesh(id: number, onStatus: (message?: string) => void): Promise<ArrayBuffer> {
  const zone = zones[id];
  if (!zone) throw new Error(`unknown zone id ${id}`);
  const base = meshFileName(zone.name);
  onStatus("Downloading navmesh...");
  for (const name of [base.replaceAll("[", "").replaceAll("]", ""), base]) {
    const res = await fetch(`https://raw.githubusercontent.com/LandSandBoat/xiNavmeshes/master/${encodeURIComponent(name)}.nav`);
    if (res.ok) {
      const bytes = await res.arrayBuffer();
      onStatus(undefined);
      return bytes;
    }
  }
  onStatus(undefined);
  throw new Error(`no navmesh for ${zone.name}`);
}
