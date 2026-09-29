// Installing the app and signing in, in one trip to github.com.
//
// A GitHub App has two separate grants and the editor needs both: authorization says who you are,
// installation is what lets a token write to a repository. They are asked for separately, because
// asking for them together only works once: github.com/apps/<slug>/installations/new completes and
// redirects on a first install, but for somebody who already installed the app it just shows the
// configure page and no code ever comes back. So this drives the authorize endpoint, which answers
// the same way whether or not the app is installed, and the editor sends people to the install page
// only when it finds the app missing from the repository they want to write to.
//
// The exchange needs the client secret, so the relay holds a credential. The authorize endpoint
// does accept PKCE, so the code is bound to this tab by a verifier it never leaves with, and by
// `state` on top. Everything after sign-in talks to api.github.com directly.

// import.meta.env is vite's, and node has no such thing, so the tests hand the same names in
// through globalThis rather than the module having to know it is being tested.
const env: Record<string, string | undefined> = (import.meta as any).env ?? (globalThis as any).VITE_ENV ?? {};
const CLIENT_ID = env.VITE_GH_CLIENT_ID;
const RELAY = env.VITE_GH_RELAY?.replace(/\/+$/, "");
const APP_SLUG = env.VITE_GH_APP_SLUG;
const STORAGE = "xi-regions-github-token";
const PENDING = "xi-regions-oauth-pending";

/** Whether this build was pointed at an app and a relay. Without all three there is no way in. */
export const canSignIn = () => !!CLIENT_ID && !!RELAY && !!APP_SLUG;

export interface StoredToken {
  token: string;
  login: string;
}

export function storedToken(): StoredToken | null {
  try {
    const raw = localStorage.getItem(STORAGE);
    return raw ? JSON.parse(raw) as StoredToken : null;
  } catch {
    return null;
  }
}

export function signOut() {
  localStorage.removeItem(STORAGE);
}

async function relay(path: string, body: Record<string, string>) {
  const res = await fetch(`${RELAY}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(body),
  });
  // A refusal carries its reason in the body, and that reason is the useful half.
  const out = (await res.json().catch(() => ({}))) as Record<string, string>;
  if (!res.ok && !out.error) throw new Error(`relay ${path} → HTTP ${res.status}`);
  return out;
}

interface Pending {
  state: string;
  /** PKCE: proves the code is being redeemed by whoever asked for it. */
  verifier: string;
  /** The hash route to come back to: the callback lands on the site root with no hash of its own. */
  returnTo: string;
}

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const randomString = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

async function challengeFor(verifier: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** Where GitHub sends people back to. Must match a callback URL registered on the app exactly. */
export const redirectUri = () => `${location.origin}${location.pathname}`;

function readPending(): Pending | null {
  try {
    return JSON.parse(sessionStorage.getItem(PENDING) ?? "null");
  } catch {
    return null;
  }
}

/**
 * Sends the user to authorize the app. Answers with a code whether or not the app is installed
 * anywhere, which is the whole reason this is not the installation URL.
 */
export async function startSignIn(returnTo: string) {
  if (!canSignIn()) throw new Error("sign-in is not configured");
  const state = crypto.randomUUID();
  const verifier = randomString();
  sessionStorage.setItem(PENDING, JSON.stringify({ state, verifier, returnTo } satisfies Pending));

  const query = new URLSearchParams({
    client_id: CLIENT_ID!,
    redirect_uri: redirectUri(),
    state,
    code_challenge: await challengeFor(verifier),
    code_challenge_method: "S256",
  });
  location.href = `https://github.com/login/oauth/authorize?${query}`;
}

/**
 * Whether the current URL is GitHub bringing somebody back from signing in, including from
 * pressing Cancel there, which comes back with an error instead of a code.
 */
export const isCallback = () => {
  const query = new URLSearchParams(location.search);
  return query.has("code") || (query.has("error") && query.has("state"));
};

/**
 * The callback lands on the site root, which under a hash router is the home page and not the
 * editor somebody left from. Called before the router mounts, this puts the route back.
 */
export function restoreRoute() {
  if (!isCallback() || location.hash) return;
  location.hash = readPending()?.returnTo || "#/regions";
}

/** Verifies the redirect belongs to this tab, exchanges the code, and keeps the token. */
export async function completeSignIn(): Promise<StoredToken> {
  const query = new URLSearchParams(location.search);
  const code = query.get("code");
  const pending = readPending();
  sessionStorage.removeItem(PENDING); // single use, whatever happens next

  // Without this, somebody can hand a contributor a callback URL of their own making and have the
  // editor quietly adopt an account nobody chose.
  if (!pending || pending.state !== query.get("state")) {
    throw new Error("this sign-in did not start in this tab, so it was not completed");
  }
  if (query.get("error") === "access_denied") throw new Error("Sign-in was cancelled on GitHub; nothing changed");
  if (query.get("error")) throw new Error(`GitHub did not sign you in: ${query.get("error_description") ?? query.get("error")}`);
  if (!code) throw new Error("GitHub sent no code");

  const out = await relay("/oauth/token", {
    code,
    code_verifier: pending.verifier,
    redirect_uri: redirectUri(),
  });
  if (out.error) throw new Error(out.error_description || out.error);
  if (!out.access_token) throw new Error("the relay returned no token");

  // The relay had to identify the account to check it against the list, and passes the answer
  // along, so there is no reason to ask GitHub the same question again.
  const stored: StoredToken = { token: out.access_token, login: out.login ?? "?" };
  localStorage.setItem(STORAGE, JSON.stringify(stored));
  return stored;
}
