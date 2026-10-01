import { useBeforeLeave, useNavigate, useParams, useSearchParams } from "@solidjs/router";
import { createEffect, createMemo, createResource, createSignal, ErrorBoundary, For, Match, onCleanup, onMount, Show, Switch, untrack } from "solid-js";
import RegionEditor, { type EditorView } from "../components/region_editor";
import { BTN, FIELD } from "../components/ui";
import YamlView from "../components/yaml_view";
import zones, { zoneFolders, zoneOfFolder } from "../data/zones";
import {
  compareUrl,
  deleteBranch,
  fillTemplate,
  findFork,
  findSitting,
  type ForkState,
  forkUrl,
  freeBranchName,
  ghPublic,
  grantedOn,
  installUrl,
  listRegionBranches,
  prTitle,
  refusedForWorkflows,
  save,
  type Sitting,
  UPSTREAM,
  UPSTREAM_BASE,
  whoAmI,
  ZONES_DIR,
} from "../github";
import { canSignIn, completeSignIn, isCallback, signOut, startSignIn as beginSignIn, storedToken } from "../github_auth";
import {
  commitMessage,
  emitRegionsBlock,
  mergeZone,
  parseMobsYaml,
  parsePastedZone,
  parseRegionsYaml,
  patchMobsYaml,
  patchRegionsYaml,
  placementsFrom,
  placementsOf,
  splitPlacements,
  zoneOfMobId,
} from "../regions";
import type { Patrol, RegionSet, Spawn, ZoneState } from "../regions";
import { copyText, isMissing } from "../util";
// The wording of a pull request is prose, so it lives in a file that can be edited as prose.
import prTemplate from "../pr_template.md?raw";
import { loadRoam } from "../roam";
import { loadNavMesh, loadZoneMesh } from "../zone_mesh";

// data/zones/<zone>/{regions.yaml,mobs.yaml} straight out of the LSB checkout.
interface ZoneFiles {
  folder: string;
  regionsYaml: string;
  mobsYaml: string;
  /** Whether these came off the working branch rather than staging, which decides what the merge
   * at save time may treat as the common ancestor. */
  fromBranch?: boolean;
}

// Unsaved work is mirrored to localStorage so a closed tab or a crash does not lose it. One draft
// per zone folder, dropped as soon as the files are written or the edits are undone.
interface Draft {
  at: number;
  regions: RegionSet;
  assign: Record<string, string[]>;
  paths?: Record<string, Patrol>;
  /** The zone as it was loaded when the draft was taken, so a draft that outlives those files can
   * still be merged onto newer ones rather than thrown away. Absent on drafts from before this. */
  base?: ZoneState;
}

/** A draft found for the zone being opened, and whether it was taken from these very files. */
interface FoundDraft {
  key: string;
  draft: Draft;
  /** Taken from an older version of the zone's files: base has moved on since. */
  stale: boolean;
}

// Everything funnels into one staging repository: contributors open pull requests against it, and
// pushing from there up to LandSandBoat is done by hand, outside this editor. Zone data is read
// from the same place, so a contributor sees the regions already accepted rather than redoing them.
// Upstream itself. The pull request is opened through GitHub's compare form rather than the API,
// so this repository does not need the app installed on it for that to work.
const DEFAULT_REPO = UPSTREAM;
const DEFAULT_REF = UPSTREAM_BASE;
const ZONES = ZONES_DIR;
const LOCAL = "/local-zones"; // dev middleware over a folder on disk, see vite.config.ts
// A branch per sitting, carrying one commit per zone touched in it. A branch per zone would mean a
// pull request per zone, and a single standing branch would have to be re-cut after every merge anyway.
// Work done on a later day starts a new branch, leaving the previous pull request alone.
const branchForToday = () => `regions/${new Date().toISOString().slice(0, 10)}`;
const APP_SLUG = import.meta.env.VITE_GH_APP_SLUG || "lsb-roam-regions-editor";
// One button vocabulary for the whole page. Anything that acts like a button looks like one,
// including the links -- an <a> is the right element for something that opens github.com, but it
// has no business being the only underlined blue thing in a row of buttons.
const BTN_PLAIN = BTN.plain;
const BTN_QUIET = BTN.quiet;
const BTN_GO = BTN.go;

/** What shows before a zone is picked. */
function RegionsIntro() {
  return (
    <div class="mt-6 max-w-3xl text-sm text-slate-300 space-y-3">
      <p>
        Edit LandSandBoat's spawn regions: areas a mob spawns anywhere inside, instead of on a fixed spot. The cyan dots are recorded roam trails.
      </p>
      <ol class="list-decimal pl-5 space-y-0.5">
        <li>Pick a zone above.</li>
        <li>
          Edit or draw regions, and assign mobs to them. <b>Review</b> flags problems.
        </li>
        <li>
          <b>Save</b> to your fork of LandSandBoat/server (sign in with GitHub the first time), then <b>Open pull request</b>.
        </li>
      </ol>
      <p class="text-slate-400">
        Edits are kept in this browser until saved. <b>?</b> on the map lists the shortcuts.
      </p>
    </div>
  );
}

/** A zone folder as people know it: "West Ronfaure", not west_ronfaure. */
const zoneLabel = (folder: string) => zoneOfFolder(folder)?.name ?? folder;

/** "1 region", "3 regions" -- these end up in commit messages and pull request bodies. */
const count = (n: number, thing: string) => `${n} ${thing}${n === 1 ? "" : "s"}`;

/**
 * Draft slot for a zone, identified by the files it was taken from and not just the folder name.
 *
 * Keying on the name alone meant every `west_ronfaure` shared one slot -- the repo's, a local
 * folder's, an LSB checkout's -- so a stale draft from one source was silently restored over
 * another and the page showed different geometry depending on when it was last reloaded.
 */
/** Where the editor is published, for links that leave this machine. */
const PUBLIC_EDITOR = "https://sruon.github.io/xi-visualizer/";

/** Session flag naming the zone whose edits went out with the sign-in redirect. */
const RESUME = "xi-visualizer:regions-resume";

const draftKey = (folder: string, source: string) => `xi-visualizer:regions-draft:${folder}:${source}`;

/** Cheap non-cryptographic digest, only needs to tell one version of a file from another. */
function fingerprint(...texts: string[]): string {
  let h = 0x811c9dc5;
  for (const text of texts) {
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  }
  return (h >>> 0).toString(36);
}

function readDraftAt(key: string): Draft | undefined {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * The draft to offer for this zone: the one taken from these exact files, else the newest taken
 * from an older version of them. Those used to be deleted on sight, which lost an evening's work
 * every time somebody else's change to the zone was merged.
 */
function findDraft(folder: string, source: string): FoundDraft | undefined {
  const exact = draftKey(folder, source);
  const here = readDraftAt(exact);
  if (here) return { key: exact, draft: here, stale: false };
  const prefix = `xi-visualizer:regions-draft:${folder}:`;
  let best: FoundDraft | undefined;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k?.startsWith(prefix)) continue;
    const d = readDraftAt(k);
    if (d && (!best || d.at > best.draft.at)) best = { key: k, draft: d, stale: true };
  }
  return best;
}

export default function RegionsPage() {
  // /regions/<zone> picks the zone; ?repo=owner/name&ref=branch override where it comes from.
  const params = useParams<{ zone?: string; }>();
  const [query] = useSearchParams<{ repo?: string; ref?: string; review?: string; cam?: string; region?: string; floor?: string; }>();
  /** The view a shared link asked for, read once when the zone opens. */
  const linkedView = (): EditorView => ({
    camera: query.cam?.split(",").map(Number),
    region: query.region,
    floor: query.floor ? Number(query.floor) : undefined,
  });
  /**
   * Keeps the address bar pointing at what is on screen, so copying it shares this exact view.
   * Written past the router, since telling it would count every camera move as a navigation.
   */
  const keepView = (view: EditorView) => {
    const [path, search = ""] = location.hash.slice(1).split("?");
    const params = new URLSearchParams(search);
    for (const [key, value] of [["cam", view.camera?.join(",")], ["region", view.region], ["floor", view.floor?.toString()]] as const) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    history.replaceState(history.state, "", `#${path}${params.size ? `?${params}` : ""}`);
  };
  const navigate = useNavigate();
  const repo = () => query.repo || DEFAULT_REPO;

  /**
   * Where the zone picker goes. The repository, branch and review flag live in the query, so
   * navigating without them silently dropped whoever was reviewing a branch back onto staging,
   * still looking like a review.
   */
  const zoneHref = (zone: string) => {
    const carried = new URLSearchParams();
    for (const [key, value] of Object.entries({ repo: query.repo, ref: query.ref, review: query.review })) {
      if (value) carried.set(key, value);
    }
    const rest = carried.toString();
    return `/regions/${zone}${rest ? `?${rest}` : ""}`;
  };
  const ref = () => query.ref || DEFAULT_REF;
  /** Opened from a review link: somebody else's branch, for reading against the roam data. */
  const reviewing = () => query.review === "1";
  // The only way in is signing in. api.github.com is CORS-enabled, so the token it yields is used
  // straight from here and needs no help from anybody.
  const [account, setAccount] = createSignal(storedToken());
  const [signingIn, setSigningIn] = createSignal(false);
  const authToken = () => account()?.token ?? "";

  // Where this session's commits go: one branch on the user's own fork, cut from base the first
  // time and added to after that. Resolved once a token exists, because a token that cannot reach a
  // fork is worth saying so about before someone spends an hour drawing regions.
  const [fork, setFork] = createSignal<ForkState | undefined>();
  /** The fork's owner/name once we know it, for the states that have one. */
  const forkRepo = () => (fork() as { repo?: string; } | undefined)?.repo ?? "";
  const [pushed, setPushed] = createSignal(false);
  /**
   * The sitting in progress: which branch to read from and write to. Work lives there until the
   * pull request is merged, so it is also where the editor has to *read* a zone from -- reading
   * staging after a commit shows the zone as it was before, which looks like the work vanished.
   */
  const [sitting, setSitting] = createSignal<Sitting | undefined>();
  /** Set by naming a branch by hand, or by starting a new one. Beats whatever is sitting. */
  const [branchChosen, setBranchChosen] = createSignal<string | undefined>();

  const branchName = () => branchChosen() ?? sitting()?.branch ?? branchForToday();

  /** findSitting only looks under regions/, so a branch named outside it would never be found again. */
  const asBranch = (raw: string) => {
    const tail = raw.replace(/^regions\//, "").trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    return tail ? `regions/${tail}` : branchForToday();
  };

  /**
   * Leaves the current branch where it is, with whatever pull request it has, and points the next
   * save at a fresh one. Reset is the other half of this pair and throws the branch away instead.
   */
  const startNewBranch = async () => {
    const where = fork();
    if (where?.state !== "ready") return;
    setStatus("Naming a new branch…");
    try {
      const taken = await listRegionBranches(authToken(), where.repo);
      setBranchChosen(freeBranchName(taken, branchForToday()));
      setSitting(undefined);
      setPushed(false);
      setStatus(`Next save starts ${branchName()}`);
    } catch (e) {
      failed(e);
    }
  };
  /** The zones sitting on the working branch, so the pull request can name what it actually holds. */
  const branchZones = () => sitting()?.zones ?? [];

  /** Why the fork could not be checked, when it could not: a panel with nothing in it helps nobody. */
  const [forkError, setForkError] = createSignal<string | undefined>();

  const endSession = () => {
    signOut();
    setAccount(null);
    setFork(undefined);
    setSitting(undefined);
    setPushed(false);
  };

  /**
   * Reports a GitHub call that failed. An expired session signs out, since every later call would
   * fail the same way behind a toolbar that still shows the login and no way to sign in again.
   */
  const failed = (e: unknown) => {
    setStatus(undefined);
    if ((e as { status?: number; }).status === 401) {
      endSession();
      setShowSignIn(true);
      return setError("Your GitHub sign-in has expired; they last eight hours. Sign in again, your edits are kept.");
    }
    // fetch throws a TypeError when the request never got an answer. A save only moves the branch
    // as its last step, so a dropped connection leaves GitHub as it was.
    if (e instanceof TypeError) return setError("Could not reach GitHub. Nothing there changed and your edits are kept; try again.");
    setError((e as Error)?.message ?? String(e));
  };

  const [checking, setChecking] = createSignal(false);
  /** "Done, check again": says it is looking, and says so when nothing has changed yet. */
  const checkAgain = async () => {
    const was = fork()?.state;
    setChecking(true);
    setStatus(undefined);
    try {
      await locateFork();
    } finally {
      setChecking(false);
    }
    if (fork()?.state === was && was !== "ready") {
      setStatus(was === "missing" ? "Still no fork. GitHub can take a minute to make one; try again shortly." : "Nothing has changed on GitHub yet.");
    }
  };
  const CheckAgain = () => (
    <button class={`${BTN_QUIET} disabled:opacity-60`} disabled={checking()} onClick={checkAgain}>
      {checking() ? "Checking…" : "Done, check again"}
    </button>
  );

  const locateFork = async () => {
    const t = authToken();
    if (!t) return setFork(undefined);
    setForkError(undefined);
    try {
      const found = await findFork(t, repo(), await whoAmI(t), ref());
      setFork(found);
      // Something still stands between this person and a save, and the panel is what says so.
      if (found.state !== "ready") return setShowSignIn(true);
      setShowSignIn(false);

      const now = await findSitting(t, found.repo, repo(), ref(), branchForToday());
      setSitting(now);
      if (now.ancestor) setPushed(true); // there is already something to open a pull request for

      // The zone on screen was read from staging before we knew there was a branch carrying a newer
      // version of it. Re-read it, unless there is unsaved work that a reload would throw away.
      const showing = files()?.folder;
      if (showing && now.ancestor && !dirty()) await openZone(showing);
    } catch (e) {
      setFork(undefined);
      if ((e as { status?: number; }).status === 401) return failed(e);
      setForkError((e as Error)?.message ?? String(e));
      setShowSignIn(true);
    }
  };

  /** Leaves the page. Everything after this happens on the way back, in finishSignIn. */
  const startSignIn = async () => {
    setError(undefined);
    setSigningIn(true);
    try {
      // The draft carries the edits across the redirect, and the zone restores it on the way back.
      if (dirty() && flushDraft()) sessionStorage.setItem(RESUME, files()!.folder);
      await beginSignIn(location.hash || "#/regions");
    } catch (e) {
      setError(`${e}`);
      setSigningIn(false);
    }
  };

  /** The other half, run on the redirect back from GitHub. */
  const finishSignIn = async () => {
    setSigningIn(true);
    setStatus("Finishing sign-in…");
    try {
      setAccount(await completeSignIn());
      setShowSignIn(false);
      await locateFork();
      setStatus(undefined);
    } catch (e) {
      setStatus(undefined);
      // Installing through the "Install it on ..." link can bounce a code back on its own, into a
      // tab that never asked for one. Nothing was exchanged, so there is nothing to report.
      if (!(authToken() && `${e}`.includes("did not start in this tab"))) {
        setError(`${e}`);
        setShowSignIn(true);
      }
    } finally {
      // The code is single use and spent either way; leaving it in the bar invites a reload that
      // fails for a reason nobody could guess at.
      history.replaceState({}, "", location.pathname + location.hash);
      setSigningIn(false);
    }
  };
  /** False until we know whether there is a working branch, so the first read goes to the right place. */
  const [authSettled, setAuthSettled] = createSignal(false);
  /** Armed by a first click, so throwing the sitting away takes two and says what it costs. */
  const [confirmReset, setConfirmReset] = createSignal(false);
  const [showSignIn, setShowSignIn] = createSignal(false);
  const [local, setLocal] = createSignal(false);
  const [folders, setFolders] = createSignal<string[]>([]);
  // Zones that already have a regions.yaml, so nobody starts one somebody else has done.
  const [started, setStarted] = createSignal(new Set<string>());
  const [files, setFiles] = createSignal<ZoneFiles | undefined>();
  const [error, setError] = createSignal<string | undefined>();
  const [status, setStatus] = createSignal<string | undefined>();
  const [dirty, setDirty] = createSignal(false);
  const [showYaml, setShowYaml] = createSignal(false);
  /** The paste box, for work somebody kept in a text file before any of this committed anywhere. */
  const [pasting, setPasting] = createSignal(false);
  const [pasted, setPasted] = createSignal("");
  // Bumped on every edit so the yaml panel can follow along. Patching is a few milliseconds, and
  // this only runs while the panel is open.
  const [edits, setEdits] = createSignal(0);
  const [draft, setDraft] = createSignal<FoundDraft | undefined>();
  // The zone as opened, which is what a draft taken now is a change to.
  let loaded: ZoneState | undefined;
  const [restored, setRestored] = createSignal<Draft | undefined>();
  // Fingerprint of the files currently open, so a draft belongs to the version it was taken from.
  const [source, setSource] = createSignal("");
  const [editorKey, setEditorKey] = createSignal("");

  // Latest editor state, written back on save.
  let pending: { regions: RegionSet; assign: Record<string, string[]>; paths: Record<string, Patrol>; } | undefined;
  let draftTimer: ReturnType<typeof setTimeout> | undefined;
  let edited = false;

  /** Drops the autosave of what is open now. A draft still on offer is left alone: only Restore or
   * Discard decides about it, not an undo back to clean or a save of something else. */
  const clearDraft = (folder: string) => localStorage.removeItem(draftKey(folder, source()));
  const [confirmDiscard, setConfirmDiscard] = createSignal(false);
  const discardDraft = () => {
    const offered = draft();
    if (offered) localStorage.removeItem(offered.key);
    setDraft(undefined);
    setConfirmDiscard(false);
  };

  // Debounced: onChange fires on every mouse move while a vertex is being dragged.
  const scheduleDraft = (isDirty: boolean) => {
    clearTimeout(draftTimer);
    const f = files();
    if (!f) return;
    // Only drop a draft once this session has made an edit of its own — the editor reports "not
    // dirty" as soon as it mounts, which would otherwise wipe the draft before it can be offered.
    if (!isDirty) return edited && clearDraft(f.folder);
    edited = true;
    // Keyed now, not when the timer fires: by then another zone can be open, and this zone's
    // edits would be written into its slot.
    const write = writerFor(f.folder);
    draftTimer = setTimeout(() => {
      try {
        write();
      } catch (e) {
        setError(`autosave failed: ${e}`);
      }
    }, 700);
  };

  /** Writes what is on screen into the draft slot for the zone it belongs to, as of now. */
  const writerFor = (folder: string) => {
    const key = draftKey(folder, source());
    const snapshot = pending;
    const base = loaded;
    return () => snapshot && localStorage.setItem(key, JSON.stringify({ at: Date.now(), ...snapshot, base }));
  };

  /**
   * Writes the draft now instead of in 700ms, before anything that takes the page away: another
   * zone, another page, the sign-in redirect, a branch being discarded. Returns false only when
   * there was unsaved work and it could not be written.
   */
  const flushDraft = () => {
    clearTimeout(draftTimer);
    const f = files();
    if (!f || !dirty()) return true;
    try {
      writerFor(f.folder)();
      return true;
    } catch {
      return false;
    }
  };
  useBeforeLeave(() => void flushDraft());

  onMount(() => {
    listZones();
    if (isCallback()) finishSignIn().finally(() => setAuthSettled(true));
    // Reviewing reads somebody else's branch: the reviewer's own fork and working branch have
    // nothing to do with it, and looking them up asked GitHub for a branch named after a commit.
    else if (authToken() && !reviewing()) locateFork().finally(() => setAuthSettled(true));
    else setAuthSettled(true);
    // With the draft written there is nothing to warn about, including on the way out to sign in.
    const guard = (e: BeforeUnloadEvent) => {
      if (!flushDraft()) e.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    onCleanup(() => {
      window.removeEventListener("beforeunload", guard);
      clearTimeout(draftTimer);
    });
  });

  // The URL is the source of truth for which zone is open, so deep links work without the listing.
  createEffect(() => {
    const zone = params.zone;
    // Waiting costs a moment; not waiting reads the zone from staging and shows work already
    // committed as missing.
    if (!authSettled()) return;
    if (zone && zone !== untrack(files)?.folder) {
      untrack(flushDraft);
      openZone(zone);
    }
  });

  // Parsed once when the zone is opened and never re-derived from a patched file: assigning a
  // region strips `at:`, so re-parsing after a save would lose every assigned spawn's coordinates.
  const [spawns, setSpawns] = createSignal<Spawn[] | undefined>();
  const [regions, setRegions] = createSignal<RegionSet>({});
  const [baseline, setBaseline] = createSignal({ block: "", assign: {} as Record<string, string[]>, paths: "" });

  // Coordinates as the file had them, so unassigning can put `at:` back.
  const positions = () => Object.fromEntries((spawns() ?? []).filter(s => s.at).map(s => [s.id, s.at!]));

  const zoneId = () => {
    const first = spawns()?.[0];
    return first ? zoneOfMobId(first.id) : undefined;
  };

  const listZones = async () => {
    // In dev, a local zones folder wins if the vite middleware has one to serve (see vite.config).
    if (import.meta.env.DEV) {
      try {
        const res = await fetch(`${LOCAL}/`);
        const names = res.ok ? ((await res.json()) as string[]) : [];
        if (names.length) {
          setLocal(true);
          setFolders(names);
          setStatus(undefined);
          setError(undefined);
          return;
        }
      } catch {
        // no local folder, fall through to GitHub
      }
    }
    setLocal(false);
    const listing = `Listing ${repo()}…`;
    setStatus(listing);
    // Takes back only its own message: the zone opens alongside this, and what it says (a draft
    // put back) is still worth reading when the list arrives.
    const done = () => setStatus(now => (now === listing ? undefined : now));
    try {
      // The subtree under data/zones, not the whole repository: asking for the repository root
      // recursively downloaded nearly 7MB to read a few hundred directory names, on every visit.
      const json = (await ghPublic(`/repos/${repo()}/git/trees/${ref()}:${ZONES}?recursive=1`, authToken()).catch(e => {
        throw e.status === 404 ? new Error(`no ${ref()} branch on ${repo()}, or the repository is private`) : e;
      })) as { tree?: { path: string; }[]; };
      // Paths come back relative to data/zones, so a zone is a directory holding a mobs.yaml.
      // Fifty of them are towns with none, and those cannot be edited here.
      const wanted = new RegExp("^([^/]+)/mobs\\.yaml$");
      const names = (json.tree ?? [])
        .map(e => e.path.match(wanted)?.[1])
        .filter((n): n is string => !!n)
        .sort((a, b) => zoneLabel(a).localeCompare(zoneLabel(b)));
      setStarted(new Set((json.tree ?? []).map(e => e.path.match(/^([^/]+)\/regions\.yaml$/)?.[1]).filter((n): n is string => !!n)));
      setFolders(names);
      done();
      setError(names.length ? undefined : `No ${ZONES}/<zone>/mobs.yaml in ${repo()}@${ref()} yet`);
    } catch (e) {
      done();
      // Out of requests for the hour. Opening a zone reads raw files, which that limit does not
      // cover, so a list of every zone name still gets somebody working.
      if ((e as { rateLimited?: boolean; }).rateLimited) {
        setFolders(zoneFolders().sort((a, b) => zoneLabel(a).localeCompare(zoneLabel(b))));
        return setError(`${(e as Error).message}. Meanwhile every zone is listed, including ones with no mobs to place.`);
      }
      // fetch rejects with a TypeError when the request never completed at all: nothing was
      // refused, so there is no status to report and "Failed to fetch" on its own helps nobody.
      setError(
        e instanceof TypeError
          ? `Could not reach api.github.com (${e}). The request was blocked or the connection dropped -- ${repo()} itself is public and readable without signing in.`
          : `${repo()}: ${(e as Error).message}`,
      );
    }
  };

  /** Counts zone loads, so one that comes back after a newer one was asked for is dropped. */
  let opening = 0;
  const openZone = async (folder: string) => {
    if (!folder) return;
    const mineToOpen = ++opening;
    setStatus(`Loading ${folder}…`);
    try {
      // The working branch first when it carries this zone, since that is where the newest version
      // of it is; staging otherwise, and always in a local folder.
      const mine = sitting()?.ancestor && branchZones().some(z => z.zone === folder)
        ? { repo: forkRepo(), ref: sitting()?.head ?? branchName() }
        : { repo: repo(), ref: ref() };
      const url = (name: string) =>
        local()
          ? `${LOCAL}/${folder}/${name}`
          : `https://raw.githubusercontent.com/${mine.repo}/${mine.ref}/${ZONES}/${folder}/${name}`;
      const raw = (name: string) => fetch(url(name)).then(r => (r.ok ? r.text() : Promise.reject(new Error(`${name} → HTTP ${r.status}`))));
      // Most zones have no regions.yaml yet; drawing the first region is what creates it.
      const [regionsYaml, mobsYaml] = await Promise.all([raw("regions.yaml").catch(() => ""), raw("mobs.yaml")]);
      // Picked another zone while this one was on its way: showing it now would put the wrong
      // zone under the newer choice, and Save would commit to it.
      if (mineToOpen !== opening) return;
      // Cleared first, so what opening the zone has to say (a draft put back) is not wiped.
      setStatus(undefined);
      open({ folder, regionsYaml, mobsYaml, fromBranch: !local() && mine.repo === forkRepo() });
    } catch (e) {
      if (mineToOpen !== opening) return;
      setFiles(undefined);
      setStatus(undefined);
      setError(`${folder}: ${e}`);
    }
  };

  const open = (next: ZoneFiles) => {
    let parsed: Spawn[];
    let regionSet: RegionSet;
    try {
      parsed = parseMobsYaml(next.mobsYaml);
      regionSet = parseRegionsYaml(next.regionsYaml);
    } catch (e) {
      setFiles(undefined);
      setError(`${next.folder}: ${e}`);
      return;
    }
    edited = false;
    // The last zone's shapes are not this one's: until the editor reports in, there is nothing pending.
    pending = undefined;
    setFiles(next);
    setSpawns(parsed);
    setRegions(regionSet);
    setBaseline({
      block: emitRegionsBlock(regionSet),
      assign: Object.fromEntries(parsed.filter(s => s.regions?.length).map(s => [s.id, s.regions!])),
      paths: JSON.stringify(Object.fromEntries(parsed.filter(s => s.path).map(s => [s.id, { legs: s.path, loop: s.loop }]))),
    });
    setDirty(false);
    setError(undefined);
    setRestored(undefined);
    const stamp = fingerprint(next.regionsYaml, next.mobsYaml);
    setSource(stamp);
    loaded = { regions: regionSet, placements: placementsOf(parsed) };
    // A reviewer's own unsaved work is not on offer over the branch they are reviewing.
    setDraft(reviewing() ? undefined : findDraft(next.folder, stamp));
    setConfirmDiscard(false);
    // A draft taken on exactly these files is this person's unsaved work, so it comes straight back
    // rather than waiting behind a banner that the next edit would have written over. One taken on
    // an older version is offered instead, since putting it back means merging. Back from signing
    // in, either comes straight back: those edits were on screen when they left.
    const resuming = sessionStorage.getItem(RESUME) === next.folder;
    if (resuming) sessionStorage.removeItem(RESUME);
    const found = draft();
    if (found && (!found.stale || resuming)) {
      restoreDraft();
      if (!found.stale) setStatus(`Put back your unsaved edits from ${new Date(found.draft.at).toLocaleString()}`);
    }
    // Keyed on the content, not the name: re-opening the same zone from a different branch used to
    // leave the key unchanged, so the editor was never rebuilt and went on showing the files it
    // first mounted with while every signal underneath it held the newer ones.
    setEditorKey(`${next.folder}:${stamp}`);
  };

  const restoreDraft = () => {
    const found = draft();
    const f = files();
    if (!found || !f) return;
    let d = found.draft;
    if (found.stale && d.base && loaded) {
      // The draft is a change to an older version of the zone. Merged onto the current one, so
      // what arrived on base since stays, and only what this draft changed is taken from it.
      const merged = mergeZone(d.base, loaded, {
        regions: d.regions,
        placements: placementsFrom(spawns() ?? [], d.assign, d.paths),
      });
      d = { at: d.at, regions: merged.regions, ...splitPlacements(merged.placements) };
      setStatus(
        merged.conflicts.length
          ? `Restored onto the current ${f.folder}. ${merged.conflicts.join(", ")} also changed on ${ref()}; your version was kept, check ${
            merged.conflicts.length === 1 ? "it" : "them"
          } before saving.`
          : `Restored onto the current ${f.folder}, keeping what changed on ${ref()} since.`,
      );
    } else if (found.stale) {
      setStatus(`Restored as it was. ${f.folder} has changed since, so check nothing added on ${ref()} went missing before saving.`);
    }
    setRestored(d);
    setEditorKey(`${f.folder}:${d.at}`);
    // The restored work is autosaved under this version's slot from the next edit on.
    if (found.stale) localStorage.removeItem(found.key);
    setDraft(undefined);
  };

  const yamlFiles = createMemo(() => {
    if (!showYaml()) return undefined;
    edits();
    const out = patched();
    return out && [{ name: "regions.yaml", text: out.regionsYaml }, { name: "mobs.yaml", text: out.mobsYaml }];
  });

  /**
   * Regions that cannot be written: an outline or a hole with fewer than three vertices is not a
   * polygon, and one such was committed once. The review tab flags them, but a flag is advice
   * and this is the one place it has to be a wall.
   */
  const degenerate = () =>
    Object.entries(pending?.regions ?? {})
      .filter(([, r]) => r.rings.some(ring => ring.length < 3))
      .map(([name]) => name);
  const refuseDegenerate = () => {
    const names = degenerate();
    if (!names.length) return (setError(undefined), false);
    setError(`${names.join(", ")} ${names.length === 1 ? "has" : "have"} a ring with fewer than 3 vertices; fix or delete before saving`);
    return true;
  };

  const patched = () => {
    const f = files();
    if (!f || !pending) return undefined;
    return {
      regionsYaml: patchRegionsYaml(f.regionsYaml, pending.regions),
      mobsYaml: patchMobsYaml(f.mobsYaml, pending.assign, positions(), pending.paths),
    };
  };

  /** Writes both files back to the local folder through the dev middleware. */
  const saveLocal = async () => {
    const f = files();
    const next = patched();
    if (!f || !next || refuseDegenerate()) return;
    setStatus(`Saving ${f.folder}…`);
    try {
      for (const [name, text] of [["regions.yaml", next.regionsYaml], ["mobs.yaml", next.mobsYaml]] as const) {
        const res = await fetch(`${LOCAL}/${f.folder}/${name}`, { method: "PUT", body: text });
        if (!res.ok) throw new Error(`${name} → HTTP ${res.status}`);
      }
      setFiles({ ...f, ...next });
      setBaseline({ block: emitRegionsBlock(pending!.regions), assign: pending!.assign, paths: JSON.stringify(pending!.paths) });
      setDirty(false);
      clearDraft(f.folder);
      setStatus(`Saved ${f.folder}`);
    } catch (e) {
      setStatus(undefined);
      setError(`save: ${e}`);
    }
  };

  /**
   * Loads a zone out of pasted text, through the same door a restored draft comes in by.
   *
   * Refuses a paste from another zone rather than mixing them: the spawn ids say which zone they
   * belong to, and quietly loading Ronfaure's placements over Konschtat would be the kind of mess
   * that is only noticed much later.
   */
  const loadPasted = () => {
    const f = files();
    if (!f) return;
    try {
      const { regions: theirs, spawns: theirSpawns } = parsePastedZone(pasted());
      if (!Object.keys(theirs).length && !theirSpawns?.length) throw new Error("no regions and no spawns in that");

      const wrong = theirSpawns?.find(sp => zoneOfMobId(sp.id) !== zoneId());
      if (wrong) {
        throw new Error(
          `that is ${zones[zoneOfMobId(wrong.id)]?.name ?? "another zone"}, and this is ${zones[zoneId()!]?.name}`,
        );
      }

      // Placement only moves when the paste actually carried a mobs.yaml; a regions.yaml on its own
      // says nothing about it, and taking that as "nothing is placed" would wipe the assignments.
      const placed = theirSpawns
        ? {
          assign: Object.fromEntries(theirSpawns.filter(sp => sp.regions?.length).map(sp => [sp.id, sp.regions!])),
          paths: Object.fromEntries(theirSpawns.filter(sp => sp.path).map(sp => [sp.id, { legs: sp.path!, loop: sp.loop }])),
        }
        : { assign: pending?.assign ?? {}, paths: pending?.paths ?? {} };

      setRestored({ at: Date.now(), regions: theirs, ...placed });
      setEditorKey(`${f.folder}:pasted:${Date.now()}`);
      setPasting(false);
      setPasted("");
      setError(undefined);
      setStatus(`Loaded ${count(Object.keys(theirs).length, "region")} from the clipboard`);
    } catch (e) {
      setError(`that paste did not load: ${e}`);
    }
  };

  const copyPatched = () => {
    const next = patched();
    if (!next) return;
    copyText(`# --- regions.yaml ---\n${next.regionsYaml}\n# --- mobs.yaml (spawns section) ---\n${next.mobsYaml}`).then(ok =>
      ok ? setStatus("Copied both files") : setError("The browser would not let this page use the clipboard; View YAML shows the files to copy by hand")
    );
  };

  /** Deletes the working branch and goes back to reading the zone from staging. */
  const resetBranch = async () => {
    const where = fork();
    if (where?.state !== "ready" || !sitting()?.ancestor) return;
    const doomed = branchName();
    // The zone is re-read below, and anything unsaved would otherwise go with the old version.
    flushDraft();
    setStatus(`Deleting ${doomed}…`);
    try {
      await deleteBranch(authToken(), where.repo, doomed);
      setSitting(undefined);
      setPushed(false);
      setBranchChosen(undefined);
      setConfirmReset(false);
      setStatus(`Deleted ${doomed}`);
      const showing = files()?.folder;
      if (showing) await openZone(showing); // back to staging's version of it
    } catch (e) {
      failed(e);
    }
  };

  /**
   * The zone as it stands on the staging branch right now, if that is not what we opened.
   *
   * Somebody else's pull request can be merged while a zone is being drawn, and committing the
   * files as loaded would quietly revert their work: the diff would be against the newer tip, so it
   * would look clean. Both sides are structured, so most of it merges without anybody being asked.
   */
  const reconcile = async (
    f: ZoneFiles,
  ): Promise<{ regionsNow: string; mobsNow: string; merged?: ReturnType<typeof mergeZone>; theirSpawns?: Spawn[]; } | undefined> => {
    // A 404 is an answer (no regions.yaml yet, or a zone new on this side); anything else is a read
    // that failed, and treating it as an empty file skipped the merge and committed over base.
    const at = (where: string, ref: string, name: string) =>
      fetch(`https://raw.githubusercontent.com/${where}/${ref}/${ZONES}/${f.folder}/${name}`).then(r => {
        if (r.ok) return r.text();
        if (r.status === 404) return "";
        throw new Error(`could not re-read ${name} from ${where}@${ref} to merge against (HTTP ${r.status}); nothing was committed, try Save again`);
      });
    const [regionsNow, mobsNow] = await Promise.all([at(repo(), ref(), "regions.yaml"), at(repo(), ref(), "mobs.yaml")]);
    if (!mobsNow) return undefined;

    // What both sides started from. Files read off the working branch already contain this
    // contributor's committed work, so using them as the ancestor would read that work as "never
    // changed" and let staging quietly undo it. The real ancestor is where the branch was cut.
    const ancestor = sitting()?.ancestor;
    let [regionsWas, mobsWas] = f.fromBranch && ancestor
      ? await Promise.all([at(forkRepo(), ancestor, "regions.yaml"), at(forkRepo(), ancestor, "mobs.yaml")])
      : [f.regionsYaml, f.mobsYaml];
    // An ancestor we cannot read is no ancestor. Falling back to what was loaded is the old
    // behaviour, which is wrong in one direction; guessing at an empty one is wrong in every.
    if (!mobsWas) [regionsWas, mobsWas] = [f.regionsYaml, f.mobsYaml];
    if (regionsNow === regionsWas && mobsNow === mobsWas) return { regionsNow, mobsNow }; // staging has not moved

    const theirSpawns = parseMobsYaml(mobsNow);
    const merged = mergeZone(
      { regions: parseRegionsYaml(regionsWas), placements: placementsOf(parseMobsYaml(mobsWas)) },
      { regions: parseRegionsYaml(regionsNow), placements: placementsOf(theirSpawns) },
      {
        regions: pending!.regions,
        placements: placementsFrom(spawns() ?? [], pending!.assign, pending!.paths),
      },
    );
    return { merged, regionsNow, mobsNow, theirSpawns };
  };

  const [saving, setSaving] = createSignal(false);
  /** One save at a time: two rebuilding the branch at once race, and the second POST of a new ref fails. */
  const runSave = async (keepMine = false) => {
    if (saving()) return;
    setSaving(true);
    try {
      await (local() ? saveLocal() : saveToBranch(keepMine));
    } finally {
      setSaving(false);
    }
  };
  /** Whether the zone on screen is one of the commits on the working branch. */
  const zoneOnBranch = () => branchZones().some(z => z.zone === files()?.folder);

  /** What the last save found changed on both sides, until the person decides about it. */
  const [conflicts, setConflicts] = createSignal<string[] | undefined>();

  const saveToBranch = async (keepMine = false) => {
    setConflicts(undefined);
    const f = files();
    let next = patched();
    const where = fork();
    if (!f || !next || refuseDegenerate()) return;
    // Both dead ends are explained in the panel rather than in an error, since both are fixable.
    if (!authToken() || where?.state !== "ready") return setShowSignIn(true);

    setStatus(`Committing ${f.folder}…`);
    try {
      const staged = await reconcile(f);
      if (staged?.merged) {
        // Everything else merged; these few were changed on both sides. Saving anyway keeps this
        // side's version of them, which is a decision for the person, not something to do quietly.
        if (staged.merged.conflicts.length && !keepMine) {
          setStatus(undefined);
          setConflicts(staged.merged.conflicts);
          return setError(
            `${f.folder} changed on ${ref()} while you were editing. Everything merged except ${staged.merged.conflicts.join(", ")}, which ${
              staged.merged.conflicts.length === 1 ? "was" : "were"
            } changed there too.`,
          );
        }
        // Patch what is on the staging branch now, not what was loaded, so anything else that
        // arrived in these files while the zone was open survives.
        const { assign, paths } = splitPlacements(staged.merged.placements);
        next = {
          regionsYaml: patchRegionsYaml(staged.regionsNow, staged.merged.regions),
          mobsYaml: patchMobsYaml(staged.mobsNow, assign, Object.fromEntries(staged.theirSpawns!.filter(s => s.at).map(s => [s.id, s.at!])), paths),
        };
      }
      const result = await save({
        token: authToken(),
        repo: where.repo,
        baseRepo: repo(),
        branch: branchName(),
        base: ref(),
        zone: f.folder,
        // Against what the commit's parent holds: the staging tip, or the files as loaded when
        // the zone is not on staging yet.
        message: commitMessage(
          f.folder,
          { regions: parseRegionsYaml(staged?.regionsNow ?? f.regionsYaml), spawns: parseMobsYaml(staged?.mobsNow ?? f.mobsYaml) },
          { regions: parseRegionsYaml(next.regionsYaml), spawns: parseMobsYaml(next.mobsYaml) },
        ),
        files: [
          { path: `${ZONES}/${f.folder}/regions.yaml`, content: next.regionsYaml },
          { path: `${ZONES}/${f.folder}/mobs.yaml`, content: next.mobsYaml },
        ],
      });
      setStatus(
        result.unchanged
          ? (result.onBranch ? "Already committed" : "Nothing to commit")
          : sitting()?.pr
          ? `Committed, and added to pull request #${sitting()!.pr!.number}`
          : `Committed, ${count(result.zones.length, "zone")} on ${branchName()}. Next: open the pull request.`,
      );
      if (!result.unchanged) {
        // It is on a branch now, so this is as safe as saving to disk. From here on the zone is the
        // branch's version, merged against the staging commit the branch was just rebuilt on: kept
        // as files loaded from base, the next save read this one's edits as base undoing them.
        setFiles({ ...f, ...next, fromBranch: true });
        setSource(fingerprint(next.regionsYaml, next.mobsYaml));
        loaded = { regions: parseRegionsYaml(next.regionsYaml), placements: placementsOf(parseMobsYaml(next.mobsYaml)) };
        setBaseline({ block: emitRegionsBlock(pending!.regions), assign: pending!.assign, paths: JSON.stringify(pending!.paths) });
        setDirty(false);
        clearDraft(f.folder);
      }
      setSitting({
        ...sitting()!,
        branch: branchName(),
        zones: result.zones,
        ancestor: result.base ?? sitting()?.ancestor,
        head: result.sha ?? sitting()?.head,
      });
      if (result.onBranch) setPushed(true);
    } catch (e) {
      if (refusedForWorkflows(e)) {
        setStatus(undefined);
        setError(undefined);
        setFork({ state: "needs_sync", repo: where.repo });
        return setShowSignIn(true);
      }
      if ((e as { status?: number; }).status !== 403) return failed(e);
      setStatus(undefined);
      // A refusal on a write is worth one more question before reporting it: "not accessible by
      // integration" says nothing about which of several causes it was, and what the installation
      // holds is the fact that tells them apart.
      setError(`${(e as Error).message} (${where.repo}: ${await grantedOn(authToken(), where.repo)})`);
    }
  };

  /**
   * The pull request form on github.com, prefilled. A GitHub App cannot open the pull request
   * itself, and this is the better half of that trade: the description arrives carrying a link to
   * the visual diff, which is the thing a reviewer actually wants and cannot get from the yaml.
   */
  const prUrl = () => {
    const where = fork();
    if (where?.state !== "ready") return undefined;
    // A link a reviewer can open: the published editor, even when this one is a dev server.
    const editor = /^(localhost|127\.)/.test(location.hostname) ? PUBLIC_EDITOR : `${location.origin}${location.pathname}`;
    const zone = files()?.folder ?? "";
    // Both sides, named separately: the base is on the staging repository and the head on this
    // contributor's fork. Pointing both at one repository only ever worked for whoever owns the
    // staging repository, and read every region as newly added for everybody else.
    const diffFor = (name: string) =>
      `${editor}#/regions-diff?${new URLSearchParams({ repo: repo(), base: ref(), head_repo: where.repo, head: branchName(), zone: name })}`;

    // Every zone on the branch, not whichever one is open: a sitting's pull request covers all of
    // them, and a reviewer wants a diff link per zone rather than one into the middle of it.
    const onBranch = branchZones().length ? branchZones() : [{ zone, summary: "" }];
    const body = fillTemplate(prTemplate, {
      editor,
      zone,
      base: ref(),
      zones: onBranch
        .map(z => `- [${z.zone}](${diffFor(z.zone)})${z.summary ? ` (${z.summary})` : ""}`)
        .join("\n"),
      diff: diffFor(zone),
      regions: String(Object.keys(pending?.regions ?? {}).length),
      spawns: String(Object.keys(pending?.assign ?? {}).length),
    });
    // What the branch holds, not whichever zone happened to be open when the link was clicked.
    const title = prTitle(onBranch.map(z => z.zone).filter(Boolean));
    return `${compareUrl(repo(), ref(), where.repo, branchName())}&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  };

  // On by default; a zone's trails are a few MB, so unticking it also stops the fetch.
  const [showRoam, setShowRoam] = createSignal(true);
  const [roam] = createResource(() => (showRoam() ? zoneId() : undefined), loadRoam);

  // The server's navmesh in place of the terrain, for seeing whether a vertex is somewhere a
  // mob can actually walk. Off by default: another few MB a zone.
  const [showNav, setShowNav] = createSignal(false);
  const [nav] = createResource(() => (showNav() ? zoneId() : undefined), id => loadNavMesh(id, setStatus));

  // Its own line: the download's progress ending in "nothing" wiped whatever else the status said.
  const [meshProgress, setMeshProgress] = createSignal<string>();
  const [zoneMesh] = createResource(zoneId, id => loadZoneMesh(id, setMeshProgress));

  return (
    <section class="p-8 plain-ui">
      <div class="flex flex-wrap items-center gap-3 text-sm">
        <h1 class="text-2xl font-bold mr-2">Spawn Regions</h1>
        {/* value depends on folders() so it re-applies once the options exist */}
        <select
          class={`${FIELD} max-w-64`}
          value={folders().includes(params.zone ?? "") ? params.zone! : ""}
          aria-label="Zone"
          title={local() ? "served from a local folder" : `${repo()}@${ref()}`}
          onChange={e => navigate(zoneHref(e.currentTarget.value))}
        >
          <option value="">{folders().length ? `${folders().length} zones, pick one` : "no zones"}</option>
          <Show when={started().size} fallback={<For each={folders()}>{f => <option value={f}>{zoneLabel(f)}</option>}</For>}>
            <optgroup label="Has regions">
              <For each={folders().filter(f => started().has(f))}>{f => <option value={f}>{zoneLabel(f)}</option>}</For>
            </optgroup>
            <optgroup label="No regions yet">
              <For each={folders().filter(f => !started().has(f))}>{f => <option value={f}>{zoneLabel(f)}</option>}</For>
            </optgroup>
          </Show>
        </select>
        <button
          class={BTN_PLAIN}
          onClick={listZones}
          title={local() ? "Re-read the local folder" : `Re-read ${repo()}@${ref()}`}
          aria-label="Reload the zone list"
        >
          ⟳
        </button>
        <Show when={files()}>
          <span class="text-slate-400">
            {zones[zoneId()!]?.name ?? "?"} ({zoneId()}) · {spawns()?.length ?? 0} spawns
          </span>
          <Show when={!reviewing()}>
            <button
              class={dirty() && !saving() ? BTN.go : BTN.plain}
              disabled={!dirty() || saving()}
              onClick={() => runSave()}
              title={local()
                ? "Write both files back to the local folder"
                : authToken()
                ? `Commit both files to ${branchName()} on your fork`
                : "Saving commits to your fork of the repository on GitHub, so it needs you signed in"}
            >
              {saving()
                ? "Saving…"
                : dirty()
                ? (local() || authToken() ? "Save" : "Sign in to save")
                : local()
                ? "Saved"
                : zoneOnBranch()
                ? "Committed"
                : "No changes"}
            </button>
          </Show>
          <button class={BTN_PLAIN} onClick={copyPatched}>Copy YAML</button>
          <button
            class={BTN_PLAIN}
            title="Copy a link to this zone as it is on screen: the camera, the region picked and the floor"
            onClick={() =>
              copyText(location.href).then(ok => (ok ? setStatus("Link copied") : setError("The browser would not let this page use the clipboard")))}
          >
            Copy link
          </button>
          <Show when={!reviewing()}>
            <button
              class={BTN_PLAIN}
              title="Load a zone back out of yaml kept in a file"
              onClick={() => setPasting(v => !v)}
            >
              Paste YAML
            </button>
          </Show>
          <button
            class={showYaml() ? BTN.quiet : BTN.plain}
            title="Show the files as they would be written"
            onClick={() => setShowYaml(v => !v)}
          >
            {showYaml() ? "Hide YAML" : "View YAML"}
          </button>
          {/* Neither of these means anything until something is on the branch. */}
          <Show when={sitting()?.ancestor && !reviewing()}>
            <button
              class={BTN_PLAIN}
              title={`Leave ${branchName()} and any pull request for it alone, and start the next save on a branch of its own.`}
              onClick={startNewBranch}
            >
              Start a new branch
            </button>
            <button
              class={confirmReset() ? BTN.danger : BTN_PLAIN}
              title={`Delete ${branchName()} from your fork. The work on it is not recoverable from here, and an open pull request for it would be left with nothing to merge.`}
              onClick={() => (confirmReset() ? resetBranch() : setConfirmReset(true))}
              onBlur={() => setConfirmReset(false)}
            >
              {confirmReset()
                ? `Discard ${count(branchZones().length, "zone")}?`
                : "Discard branch"}
            </button>
          </Show>
          {/* Only once something is actually on the branch: an empty compare page helps nobody. */}
          <Show when={pushed() && prUrl() && !reviewing()}>
            <Show
              when={sitting()?.pr}
              fallback={
                <a class={BTN_GO} href={prUrl()} target="_blank" rel="noreferrer" title={`Opens a pull request against ${repo()}@${ref()}`}>
                  Open pull request
                </a>
              }
            >
              {open => (
                <a class={BTN_PLAIN} href={open().url} target="_blank" rel="noreferrer" title="Saves to this branch add to it">
                  View pull request #{open().number}
                </a>
              )}
            </Show>
          </Show>
        </Show>
        <Show when={files()}>
          <label class="flex items-center gap-2 text-slate-400 cursor-pointer" title="Overlay the recorded roam trails for this zone">
            <input type="checkbox" checked={showRoam()} onChange={e => setShowRoam(e.currentTarget.checked)} />
            roam data
            <Show when={showRoam()}>
              <span class="text-slate-500">
                {roam.error
                  ? (isMissing(roam.error) ? "none for this zone" : "failed to load, untick and tick to retry")
                  : roam()
                  ? `${(roam()!.count / 1000).toFixed(0)}k points`
                  : "loading…"}
              </span>
            </Show>
          </label>
          <label class="flex items-center gap-2 text-slate-400 cursor-pointer" title="Draw the server's navmesh in place of the collision mesh">
            <input type="checkbox" checked={showNav()} onChange={e => setShowNav(e.currentTarget.checked)} />
            navmesh
            <Show when={showNav() && nav.error}>
              <span class="text-slate-500">{isMissing(nav.error) ? "none for this zone" : "failed to load, untick and tick to retry"}</span>
            </Show>
          </label>
        </Show>
        <Show when={status()}>
          <span class="text-slate-400">{status()}</span>
        </Show>
        <Show when={error()}>
          <span class="text-red-500">{error()}</span>
        </Show>
        <Show when={conflicts()}>
          <button
            class={BTN_QUIET}
            title={`Commit with your version of ${conflicts()!.join(", ")}, replacing what changed on ${ref()}. The pull request diff will show it.`}
            onClick={() => runSave(true)}
          >
            Save, keeping mine
          </button>
        </Show>
        <Show when={fork()?.state === "ready" && !reviewing()}>
          <span class="text-slate-500 flex items-center gap-1" title="Where Save commits to">
            → {forkRepo()}@
            <Show
              when={!sitting()?.ancestor}
              fallback={<span class="font-mono text-slate-400">{branchName()}</span>}
            >
              {/* Renaming is free until something is committed to it, and fixed once it is. */}
              <input
                class="px-1 py-0.5 bg-slate-700 rounded font-mono text-slate-200 w-44"
                value={branchName()}
                aria-label="Branch name"
                title="Name this branch, before anything is committed to it"
                onChange={async e => {
                  const input = e.currentTarget;
                  const named = asBranch(input.value);
                  const where = fork();
                  // A name already on the fork belongs to other work, and a save would rebuild it.
                  const taken = where?.state === "ready" ? await listRegionBranches(authToken(), where.repo).catch(() => []) : [];
                  const free = freeBranchName(taken, named);
                  if (free !== named) setStatus(`${named} is already on your fork, so the next save starts ${free}`);
                  setBranchChosen(free);
                  input.value = free;
                }}
              />
            </Show>
          </span>
        </Show>
        <Show
          when={account()}
          fallback={
            <Show when={canSignIn()}>
              <button class={BTN_GO} disabled={signingIn()} onClick={startSignIn}>
                {signingIn() ? "Off to GitHub…" : "Sign in with GitHub"}
              </button>
            </Show>
          }
        >
          {who => (
            <>
              <span class="text-slate-400">{who().login}</span>
              <button
                class={BTN_PLAIN}
                onClick={endSession}
              >
                Sign out
              </button>
            </>
          )}
        </Show>
      </div>

      <Show when={showSignIn()}>
        <div class="mt-3 flex flex-wrap items-center gap-2 text-sm bg-slate-800 border border-slate-600 rounded px-3 py-2">
          <Show when={canSignIn() && !authToken()}>
            <button
              class={`${BTN_GO} disabled:opacity-50`}
              disabled={signingIn()}
              onClick={startSignIn}
            >
              {signingIn() ? "Off to GitHub…" : "Sign in with GitHub"}
            </button>
            <span class="text-slate-400">
              Saves go to your own fork of <b>{repo()}</b>, on a branch named <b>{branchName()}</b>. Setting that up is three steps, once: sign in, fork{" "}
              {repo()}, then install this app on that fork. This panel walks you through each, your edits are kept meanwhile, and nothing reaches {repo()}{" "}
              until you open the pull request yourself.
            </span>
          </Show>

          <Show when={authToken() && !fork()}>
            <Show when={forkError()} fallback={<span class="text-slate-400">Checking your fork of {repo()}…</span>}>
              <span>Could not check your fork of {repo()}: {forkError()}</span>
              <button class={BTN_QUIET} onClick={locateFork}>Retry</button>
            </Show>
          </Show>

          {/* Signed in, but there is nowhere to write yet. Both cases are one click on github.com. */}
          <Show when={authToken() && fork()?.state === "missing"}>
            <span>
              You have no fork of <b>{repo()}</b> yet. A GitHub App cannot make one for you, so this part is manual.
            </span>
            <a class={BTN_GO} href={forkUrl(repo())} target="_blank" rel="noreferrer">
              Fork it on GitHub
            </a>
            <CheckAgain />
          </Show>

          {
            /* Writable, but the first branch would carry a thousand unrelated commits into the fork,
              some of them touching .github/workflows, which an app may not do without Workflows
              (write). Syncing the fork removes the difference and needs no extra permission. */
          }
          <Show when={fork()?.state === "needs_sync"}>
            <span>
              Your fork <b>{forkRepo()}</b> is behind{" "}
              <b>{repo()}</b>, far enough that the first commit would carry workflow changes into it, which GitHub does not let an app do. Either fixes it:
            </span>
            <a class={BTN_GO} href={`https://github.com/${forkRepo()}`} target="_blank" rel="noreferrer">
              Sync fork
            </a>
            <span class="text-slate-400">
              (on its page: <b>Sync fork</b>, then <b>Update branch</b>)
            </span>
            {
              /* The other way: accepting the app's permissions covers it however far behind the fork
                is. Changing an app's permissions leaves a request the installation's owner has to
                accept -- signing in again does not do it, since that only issues a new token. */
            }
            <a class={BTN_PLAIN} href="https://github.com/settings/installations" target="_blank" rel="noreferrer">
              or accept the app's permissions
            </a>
            <CheckAgain />
          </Show>

          {
            /* Installed, but on terms that cannot commit. GitHub keeps an installation on the
              permissions it was created with until its owner accepts a newer set, so this looks
              exactly like a working setup right up to the first commit. */
          }
          <Show when={fork()?.state === "needs_permission"}>
            <span>
              The app is installed on <b>{forkRepo()}</b> but was only granted <b>{(fork() as { granted?: string; })?.granted}</b>, and committing needs{" "}
              <b>contents: write</b>. Accept the updated permissions and it will work.
            </span>
            <a class={BTN_GO} href="https://github.com/settings/installations" target="_blank" rel="noreferrer">
              Review permissions
            </a>
            <CheckAgain />
          </Show>

          {
            /* Signing in authorises the app; it does not install it, and only an installation can
              write. The token reads the fork perfectly either way, so this has to be asked about
              rather than waited for. */
          }
          <Show when={fork()?.state === "not_installed"}>
            <span>
              Signed in, but the app is not installed on <b>{forkRepo()}</b>{" "}
              yet. Installing is what lets it commit; signing in only proved who you are. On GitHub's page pick <b>Only select repositories</b> and choose{" "}
              <b>{forkRepo()}</b>; it needs nothing else of yours. Then come back to this tab.
            </span>
            <a
              class={BTN_GO}
              href={installUrl(APP_SLUG)}
              target="_blank"
              rel="noreferrer"
            >
              Install it on {forkRepo()}
            </a>
            <CheckAgain />
          </Show>

          {/* Nothing to offer without a relay, and saying so beats an empty box. */}
          <Show when={!canSignIn()}>
            <span class="text-slate-400">
              Sign-in is not configured on this copy of the editor. Use <b>Copy YAML</b>{" "}
              and commit the files yourself, or see docs/github-sign-in.md to point a build at a relay.
            </span>
          </Show>
        </div>
      </Show>

      <Show when={reviewing()}>
        <div class="mt-3 flex flex-wrap items-center gap-2 text-sm bg-sky-900/40 border border-sky-700 rounded px-3 py-2">
          <span class="flex-grow">
            Reviewing <b>{repo()}</b> at <b>{ref()}</b>, read only.
          </span>
        </div>
      </Show>

      <Show when={pasting()}>
        <div class="mt-3 flex flex-col gap-2 text-sm bg-slate-800 border border-slate-600 rounded px-3 py-2">
          <span class="text-slate-400">
            Paste what <b>Copy YAML</b> gave you, or a regions.yaml on its own. It loads into <b>{files()?.folder}</b>{" "}
            without committing anything, so Save is still what puts it anywhere.
          </span>
          <textarea
            aria-label="Pasted regions.yaml and mobs.yaml"
            class="w-full h-40 px-2 py-1 bg-slate-900 rounded font-mono text-xs"
            placeholder={"# --- regions.yaml ---\nregions:\n  ..."}
            value={pasted()}
            onInput={e => setPasted(e.currentTarget.value)}
          />
          <div class="flex items-center gap-2">
            <button class={BTN_GO} disabled={!pasted().trim()} onClick={loadPasted}>Load it</button>
            <button class={BTN_QUIET} onClick={() => (setPasting(false), setPasted(""))}>Cancel</button>
            <span class="text-slate-500">Replaces the regions on screen. Undo puts them back.</span>
          </div>
        </div>
      </Show>

      <Show when={draft()}>
        <div class="mt-3 flex items-center gap-3 text-sm bg-amber-900/40 border border-amber-700 rounded px-3 py-2">
          <span>
            Unsaved work on {files()!.folder} from {new Date(draft()!.draft.at).toLocaleString()}:{" "}
            {count(Object.keys(draft()!.draft.regions).length, "region")}, {count(Object.keys(draft()!.draft.assign).length, "assignment")}.
            <Show when={draft()!.stale}>
              {" "}
              {files()!.folder} has changed on {ref()} since; Restore merges your edits onto the current version.
            </Show>
          </span>
          <button class={BTN.warn} onClick={restoreDraft}>Restore</button>
          <button class={confirmDiscard() ? BTN.warn : BTN_QUIET} onClick={() => (confirmDiscard() ? discardDraft() : setConfirmDiscard(true))}>
            {confirmDiscard() ? "Discard for good?" : "Discard"}
          </button>
        </div>
      </Show>

      <Show
        when={files()}
        fallback={
          <Show when={params.zone} fallback={<RegionsIntro />}>
            <div class="mt-4 text-slate-400 flex items-center gap-2">
              <Show when={error()} fallback={<>Loading {zoneLabel(params.zone!)}…</>}>
                Could not open {zoneLabel(params.zone!)}.
                <button
                  class={BTN_QUIET}
                  onClick={() => openZone(params.zone!)}
                >
                  Retry
                </button>
              </Show>
            </div>
          </Show>
        }
      >
        <Switch>
          <Match when={zoneMesh.loading}>
            <div class="mt-4">Loading... {meshProgress()}</div>
          </Match>
          <Match when={zoneMesh.error}>
            <div class="mt-4 text-red-500">Failed to load zone mesh: {zoneMesh.error?.toString()}</div>
          </Match>
          <Match when={zoneMesh() && spawns()}>
            <div class="mt-4">
              <Show when={yamlFiles()}>
                {files => <YamlView files={files()} onClose={() => setShowYaml(false)} />}
              </Show>
              {
                /* Hidden rather than unmounted: taking the editor down would drop the webgl context
                  and reload the zone on the way back. */
              }
              <div style={{ display: showYaml() ? "none" : "block" }}>
                <Show when={editorKey()} keyed>
                  {_key => (
                    // A crash in the editor otherwise leaves a blank map and nothing to do about it.
                    <ErrorBoundary
                      fallback={err => (
                        <div class="mt-4 max-w-2xl rounded border border-red-800 bg-red-950/40 p-4 text-sm text-slate-200 space-y-2">
                          <div class="font-bold text-red-300">The editor stopped on this zone</div>
                          <div class="font-mono text-xs text-red-200">{String(err?.message ?? err)}</div>
                          <div>Reloading the zone offers any unsaved edits back as a draft.</div>
                          <button
                            class={BTN_PLAIN}
                            onClick={() => openZone(files()!.folder)}
                          >
                            Reload {zoneLabel(files()!.folder)}
                          </button>
                        </div>
                      )}
                    >
                      <RegionEditor
                        readOnly={reviewing()}
                        view={untrack(linkedView)}
                        onView={keepView}
                        zoneData={zoneMesh()!}
                        spawns={spawns()!}
                        regions={restored()?.regions ?? regions()}
                        assign={restored()?.assign}
                        paths={restored()?.paths}
                        roam={showRoam() && !roam.loading && !roam.error ? roam() : undefined}
                        nav={showNav() && !nav.loading && !nav.error ? nav() : undefined}
                        onChange={(r, a, p) => {
                          pending = { regions: r, assign: a, paths: p };
                          // Compared against the last saved state, not by re-patching: this runs on
                          // every mouse move during a vertex drag and mobs.yaml is thousands of lines.
                          const base = baseline();
                          const sameAssign = Object.keys(a).length === Object.keys(base.assign).length
                            && Object.entries(a).every(([id, n]) => base.assign[id] === n);
                          const isDirty = !sameAssign || emitRegionsBlock(r) !== base.block || JSON.stringify(p) !== base.paths;
                          setDirty(isDirty);
                          setEdits(n => n + 1);
                          scheduleDraft(isDirty);
                        }}
                      />
                    </ErrorBoundary>
                  )}
                </Show>
              </div>
            </div>
          </Match>
        </Switch>
      </Show>
    </section>
  );
}
