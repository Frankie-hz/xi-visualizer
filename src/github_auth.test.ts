// node src/github_auth.test.ts  (run by `pnpm test`)
//
// The install flow leaves the page and comes back, and everything that can go wrong goes wrong on
// the way back: a redirect that did not start here, a redirect carrying no code because the app was
// misconfigured, and a route that has to be restored because the callback lands on the site root.
import assert from "node:assert";

// Set before the module under test is loaded, since it reads its configuration once.
(globalThis as any).VITE_ENV = {
  VITE_GH_CLIENT_ID: "Iv23liTEST",
  VITE_GH_RELAY: "https://relay.test",
  VITE_GH_APP_SLUG: "lsb-roam-regions-editor",
};

const store = (map = new Map<string, string>()) => ({
  getItem: (k: string) => map.get(k) ?? null,
  setItem: (k: string, v: string) => void map.set(k, v),
  removeItem: (k: string) => void map.delete(k),
});
(globalThis as any).localStorage = store();
(globalThis as any).sessionStorage = store();

/** Stands in for the address bar. */
let href = "";
(globalThis as any).location = {
  search: "",
  hash: "",
  origin: "https://editor.test",
  pathname: "/xi-visualizer/",
  set href(v: string) {
    href = v;
  },
};

const { canSignIn, completeSignIn, isCallback, restoreRoute, signOut, startSignIn, storedToken } = await import(
  "./github_auth.ts"
);

let reply: any = {};
const calls: { url: string; body: any; }[] = [];
(globalThis as any).fetch = async (url: string, init?: any) => {
  calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
  return { ok: !reply.error, status: reply.error ? 403 : 200, json: async () => reply };
};

assert.ok(canSignIn(), "configured with a client id, a relay and a slug");

// --- leaving ---

await startSignIn("#/regions/west_ronfaure");
// Not the installation URL: that only completes and redirects the first time, and answers somebody
// who already installed the app with a settings page and no code at all.
assert.match(href, /^https:\/\/github\.com\/login\/oauth\/authorize\?/, "authorize, not install");
const sent = new URLSearchParams(href.split("?")[1]);
assert.strictEqual(sent.get("code_challenge_method"), "S256", "PKCE, which this endpoint does accept");
assert.strictEqual(sent.get("code_challenge")!.length, 43, "a base64url sha-256 digest");
assert.strictEqual(
  sent.get("redirect_uri"),
  "https://editor.test/xi-visualizer/",
  "named explicitly, or GitHub picks the first callback registered on the app",
);
/** The nonce the module just issued, which is the only thing a valid callback can carry. */
const issued = () => JSON.parse(sessionStorage.getItem("xi-regions-oauth-pending")!).state as string;
assert.strictEqual(sent.get("state"), issued(), "carries the nonce tying the trip back to this tab");

// --- coming back ---

const location = (globalThis as any).location;
location.search = `?code=abc&installation_id=42&setup_action=install&state=${issued()}`;
assert.ok(isCallback(), "a code in the query is what a callback looks like");

// the callback lands on the site root, so the route the user left from has to be put back
location.hash = "";
restoreRoute();
assert.strictEqual(location.hash, "#/regions/west_ronfaure", "back where they were, not the home page");

reply = { access_token: "ghu_test", login: "someone" };
const verifier = JSON.parse(sessionStorage.getItem("xi-regions-oauth-pending")!).verifier as string;
assert.ok(verifier.length >= 43, "a verifier long enough to be worth hashing");
const token = await completeSignIn();
assert.deepStrictEqual(token, { token: "ghu_test", login: "someone" });
assert.strictEqual(calls[0].body.code, "abc", "the code went to the relay");
assert.strictEqual(calls[0].body.code_verifier, verifier, "redeemed with the verifier whose hash was sent out");
assert.strictEqual(calls[0].body.redirect_uri, "https://editor.test/xi-visualizer/", "and the uri the code was issued for");
assert.ok(!("client_secret" in calls[0].body), "the secret is the relay's business, not the page's");
assert.deepStrictEqual(storedToken(), { token: "ghu_test", login: "someone" }, "kept for next time");

signOut();
assert.strictEqual(storedToken(), null, "signing out forgets it");

// --- the ways back that must not be trusted ---

// a callback nobody started here: the pending state was consumed above, so nothing matches it
location.search = "?code=abc&state=whatever";
await assert.rejects(completeSignIn(), /did not start in this tab/, "an unsolicited callback is refused");

// a state that does not match the one we issued
await startSignIn("#/regions");
location.search = "?code=abc&state=somebody-elses";
await assert.rejects(completeSignIn(), /did not start in this tab/, "a forged state is refused");

// the relay refusing somebody has to reach the user rather than vanish into a generic failure
await startSignIn("#/regions");
location.search = `?code=abc&state=${issued()}`;
reply = { error: "not_allowed", error_description: "nobody is not on this editor's list." };
await assert.rejects(completeSignIn(), /not on this editor's list/, "says why it was refused");

// pressing Cancel on GitHub comes back as a callback, to the page it left, saying so
await startSignIn("#/regions/west_ronfaure");
location.search = `?error=access_denied&error_description=denied&state=${issued()}`;
location.hash = "";
assert.ok(isCallback(), "a cancelled sign-in is still a callback");
restoreRoute();
assert.strictEqual(location.hash, "#/regions/west_ronfaure", "back where it started");
await assert.rejects(completeSignIn(), /cancelled/, "and says it was cancelled");

// a spent code cannot be replayed by reloading, since the pending state is consumed either way
await startSignIn("#/regions");
location.search = `?code=abc&state=${issued()}`;
reply = { access_token: "ghu_x", login: "someone" };
await completeSignIn();
await assert.rejects(completeSignIn(), /did not start in this tab/, "the pending state is single use");

console.log("ok");
