import { createResource, createSignal, Match, Show, Switch } from "solid-js";
import { useNavigate, useParams } from "@solidjs/router";
import LookupInput from "../components/lookup_input";
import PathNodesViewer from "../components/path_nodes_viewer";
import { ZoneData } from "../components/zone_model";
import zones from "../data/zones";
import type { PathData } from "../path_nodes/extract";
import { decompress, fetchProgress } from "../util";
import { loadNavMesh } from "../zone_mesh";

const PATHDATA_BASE_URL = import.meta.env.VITE_PATHDATA_URL || `${import.meta.env.BASE_URL}/pathdata`;

function meshFile(name: string) {
  return name
    .replaceAll(" - ", "-")
    .replaceAll(" ", "_")
    .replaceAll("'", "")
    .replaceAll("(", "")
    .replaceAll(")", "")
    .replaceAll("#", "");
}

// '#' is kept: the roam files are named for the zone, so Riverne is Riverne_-_Site_#A01.
function roamFile(name: string) {
  return name
    .replaceAll(" - ", "_-_")
    .replaceAll(" ", "_")
    .replaceAll("'", "_");
}

function HowItWorks() {
  return (
    <details class="mt-2 mb-2 max-w-4xl text-sm text-slate-300">
      <summary class="cursor-pointer text-slate-200">How are these nodes found?</summary>
      <ol class="list-decimal ml-6 mt-2 space-y-1">
        <li>
          Retail mobs roam node to node. A mob walks in a straight line at a node's center and stops as soon as it is
          inside that node's radius, then picks another node it is linked to.
        </li>
        <li>
          So each straight leg of a recorded roam trail, carried on past where the mob stopped, runs through the center of
          the node it was walking to. One mob's legs meet at each center to within a few hundredths of a yalm.
        </li>
        <li>
          How far short of the center the mob stopped is that node's radius. Every mob uses the same radius for a node.
        </li>
        <li>
          Every mob in a zone walks the same nodes, each aiming at its own small offset from the center, so a spawn group
          does not stack on one spot. Removing those offsets lines all mobs up on shared nodes.
        </li>
        <li>The order a mob visits nodes in gives the links between them: the graph mobs are allowed to walk.</li>
      </ol>
    </details>
  );
}

export default function PathNodesPage() {
  const navigate = useNavigate();
  const params = useParams();
  const [loadingMessage, setLoadingMessage] = createSignal<string | undefined>();

  const [zoneMesh] = createResource(
    () => params.id,
    async (zoneIdStr) => {
      const zone = zones[parseInt(zoneIdStr)];
      if (!zone) return undefined;
      setLoadingMessage("Downloading mesh...");
      const compressed = await fetchProgress(`${import.meta.env.BASE_URL}/ximeshes/${meshFile(zone.name)}.ximesh`, p => {
        if (p !== undefined) setLoadingMessage(`Downloading mesh ${(p * 100).toFixed(0)}%`);
      });
      return { id: zone.id, name: zone.name, mesh: await decompress(compressed) } as ZoneData;
    },
  );

  const [roam] = createResource(
    () => params.id,
    async (zoneIdStr) => {
      const zone = zones[parseInt(zoneIdStr)];
      if (!zone) return undefined;
      try {
        const compressed = await fetchProgress(`${PATHDATA_BASE_URL}/${encodeURIComponent(roamFile(zone.name))}.json.gz`, p => {
          if (p !== undefined) setLoadingMessage(`Loading roam data ${(p * 100).toFixed(0)}%`);
        });
        const text = new TextDecoder().decode(await decompress(compressed, "gzip"));
        return { compressed, data: JSON.parse(text) as PathData };
      } catch (e) {
        console.log("Failed to load roam data:", e);
        return undefined;
      }
    },
  );

  const [nav] = createResource(
    () => params.id,
    async (zoneIdStr) => {
      try {
        return await loadNavMesh(parseInt(zoneIdStr), () => {});
      } catch (e) {
        console.log("No navmesh for this zone:", e);
        return undefined;
      }
    },
  );

  return (
    <section class="p-8">
      <h1 class="text-2xl font-bold">Path Nodes</h1>
      <HowItWorks />
      <LookupInput
        options={zones}
        nameFn={(v) => v.name}
        autofocus
        onChange={(value) => navigate(`/pathnodes/${value.data.id}`)}
        initialId={params.id}
      />
      <Show when={params.id}>
        <Switch>
          <Match when={zoneMesh.loading || roam.loading || nav.loading}>
            <div class="mt-4">Loading... {loadingMessage()}</div>
          </Match>
          <Match when={zoneMesh.error}>
            <div class="mt-4 text-red-500">Failed to load zone mesh: {zoneMesh.error?.toString()}</div>
          </Match>
          <Match when={zoneMesh() && !roam() && !nav()}>
            <div class="mt-4 text-yellow-500">This zone has no roam data and no navmesh, so there is nothing to place nodes on.</div>
          </Match>
          <Match when={zoneMesh()}>
            <div class="mt-4">
              <Show when={!roam()}>
                <div class="text-yellow-500 mb-2">
                  No roam data recorded for this zone: every node below is generated from the server's navmesh.
                </div>
              </Show>
              <PathNodesViewer
                zoneData={zoneMesh()!}
                pathData={roam()?.data ?? {}}
                compressed={roam()?.compressed}
                nav={nav()}
              />
            </div>
          </Match>
        </Switch>
      </Show>
    </section>
  );
}
