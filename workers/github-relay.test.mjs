// node workers/github-relay.test.mjs  (run by `pnpm test`)
//
// The relay exchanges one code and makes one decision. The decision is the part worth pinning: a
// token belonging to somebody not on the list must not reach the page, and the secret must never
// appear in anything sent back.
import assert from "node:assert";
import worker from "./github-relay.js";

const ORIGIN = "http://localhost:5173";
const env = { ALLOWED_LOGINS: "sruon, Someone-Else", GH_CLIENT_ID: "Iv23liTEST", GH_CLIENT_SECRET: "s3cret" };

let sentToGitHub = [];

/** Stands in for github.com and api.github.com in turn. */
function githubSays({ token, user }) {
  sentToGitHub = [];
  globalThis.fetch = async (url, init) => {
    sentToGitHub.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
    return { ok: true, status: 200, json: async () => (String(url).includes("api.github.com/user") ? user : token) };
  };
}

const post = (path, body = { code: "abc123" }, e = env) =>
  worker.fetch(
    new Request(`http://relay.test${path}`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    e,
  );

// somebody on the list: the token comes back, with the login the relay already had to look up
githubSays({ token: { access_token: "ghu_ok" }, user: { login: "sruon" } });
let res = await post("/oauth/token");
let body = await res.json();
assert.strictEqual(res.status, 200);
assert.strictEqual(body.access_token, "ghu_ok");
assert.strictEqual(body.login, "sruon", "passed along so the page need not ask the same question");
assert.strictEqual(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);

// the list is a list of people, not of spellings
githubSays({ token: { access_token: "ghu_ok" }, user: { login: "someone-else" } });
assert.strictEqual((await (await post("/oauth/token")).json()).access_token, "ghu_ok", "case does not decide it");

// somebody not on it: refused, and the token must not leak out in the refusal
githubSays({ token: { access_token: "ghu_secret" }, user: { login: "stranger" } });
res = await post("/oauth/token");
body = await res.json();
assert.strictEqual(res.status, 403);
assert.strictEqual(body.error, "not_allowed");
assert.match(body.error_description, /stranger is not on this editor's list/);
assert.ok(!JSON.stringify(body).includes("ghu_secret"), "the token stays on this side of the refusal");

// `*` lets anyone in
githubSays({ token: { access_token: "ghu_ok" }, user: { login: "stranger" } });
assert.strictEqual((await (await post("/oauth/token", undefined, { ...env, ALLOWED_LOGINS: "*" })).json()).login, "stranger");

// a token GitHub will not identify is not a token we hand over either
githubSays({ token: { access_token: "ghu_odd" }, user: null });
globalThis.fetch = async url =>
  String(url).includes("api.github.com/user")
    ? { ok: false, status: 401, json: async () => ({}) }
    : { ok: true, status: 200, json: async () => ({ access_token: "ghu_odd" }) };
res = await post("/oauth/token");
assert.strictEqual(res.status, 403);
assert.ok(!JSON.stringify(await res.json()).includes("ghu_odd"));

// the secret is the whole reason this exists: it goes to github and nowhere else
githubSays({ token: { access_token: "ghu_ok" }, user: { login: "sruon" } });
res = await post("/oauth/token");
assert.ok(sentToGitHub.some(c => c.body?.client_secret === "s3cret"), "the exchange carried the secret");
assert.ok(!JSON.stringify(await res.json()).includes("s3cret"), "and it did not come back out");

// a code GitHub rejects passes its reason through rather than becoming a blank failure
githubSays({ token: { error: "bad_verification_code", error_description: "expired" }, user: {} });
res = await post("/oauth/token");
assert.strictEqual((await res.json()).error, "bad_verification_code");

// no code, and a relay with no secret configured, are both refusals rather than crashes
assert.strictEqual((await post("/oauth/token", {})).status, 400);
assert.strictEqual((await post("/oauth/token", { code: "x" }, { ALLOWED_LOGINS: "sruon" })).status, 500);

// an origin nobody listed gets nothing, not even a CORS header naming somebody else
res = await worker.fetch(new Request("http://relay.test/oauth/token", { method: "POST", headers: { Origin: "https://evil.test" } }), env);
assert.strictEqual(res.status, 403);
assert.strictEqual(res.headers.get("Access-Control-Allow-Origin"), null);

// nothing configured means nobody gets in, rather than everybody
githubSays({ token: { access_token: "ghu_ok" }, user: { login: "sruon" } });
res = await post("/oauth/token", { code: "abc" }, { GH_CLIENT_ID: "x", GH_CLIENT_SECRET: "y" });
assert.strictEqual(res.status, 403, "an unset allowlist is empty, not open");

console.log("ok");
