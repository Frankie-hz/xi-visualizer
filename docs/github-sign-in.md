# Signing in to GitHub

Contributors sign in, draw regions, and press Save. Each save puts that zone on a branch on **their
own fork**, as exactly one commit. When they are done they click one link, which opens GitHub's pull
request form already filled in. Nobody needs push access and nobody has to make a token.

Everything goes to **`LandSandBoat/server@base`**: zone data is read from there and pull requests
are opened against it. A `?repo=owner/name&ref=branch` link reads from somewhere else instead.

## The shape, and why

**A relay is unavoidable.** `api.github.com` sends CORS headers, so everything after sign-in happens
straight from the page. `github.com/login/oauth/access_token` does not, and it requires the client
secret — GitHub demands it even when PKCE is used. A static page can hold neither, so a static site
needs something in the middle. `workers/github-relay.js` is that, and nothing else.

**Two grants, asked for separately.** A GitHub App has two and this needs both: *authorization* says
who you are, *installation* is what lets a token write to a repository. They are asked for one at a
time, because asking together only works once — `apps/<slug>/installations/new` completes and
redirects on a *first* install, but somebody who already installed the app just lands on the
configure page and no code ever comes back. So sign-in drives `/login/oauth/authorize`, which answers
the same way either way, and the install page is offered only when the app turns out to be missing
from the repository being written to.

(The device flow does neither well: it authorizes but can never install, so it hands back a token
that reads a fork perfectly and refuses every commit.)

That endpoint accepts **PKCE**, so the code is bound to a verifier that never leaves the tab, with
`state` on top. `state` also carries the route to come back to, since the callback lands on the site
root with no hash of its own.

**A GitHub App, not an OAuth app**, so the consent screen reads "access to `you/server`" instead of
"write to every public repository you own", and can be revoked for that one repo.

**Two steps the app cannot do**: creating the fork and opening the pull request. Both require the
app to be installed on the account owning the target repository, which is not ours to install on. So
both are links the user clicks on github.com. This is a small loss and one real gain: the pull
request form arrives with a title and description we wrote, carrying a link to the visual diff.

**Two people on one zone merge rather than collide.** A pull request can be merged into the staging
branch while somebody else is still drawing that same zone. Committing the files as they were loaded
would quietly revert the other person, and the diff would look clean because it is taken against the
newer tip. So a save that finds the zone has moved does a three-way merge first: regions by name,
placement by spawn id. Work on different regions or different mobs merges without anybody being
asked; only a region or a spawn that *both* sides moved differently stops the save, and it is named
rather than counted.

## Setting it up, once

1. **Create the GitHub App** at github.com/settings/apps → New GitHub App.
   - **Callback URL**: one per origin the editor is served from, and they must match exactly —
     `https://sruon.github.io/xi-visualizer/` and `http://localhost:5199/xi-visualizer/`.
   - Untick Webhook.
   - Repository permissions: **Contents: Read and write** and **Workflows: Read and write**. It
     never opens the pull request, so it does not need Pull requests.

     Workflows looks like more than an editor of yaml data should want, and it is asked for a
     specific reason. "Create a reference" takes Contents (write) alone only when the new ref
     carries no changes under `.github/workflows`. A contributor's fork is usually hundreds of
     commits behind, so the first branch cut from the staging tip carries all of them, workflow
     files included, and GitHub refuses that to an app without Workflows (write). The refusal is a
     bare 403 on the ref, after the trees and commits have already been written.

     A contributor who keeps their fork synced never needs it. The editor checks which case applies
     and offers both ways out.

     Changing an app's permissions after people have installed it leaves a request each of them has
     to **accept**, at github.com/settings/installations. Signing in again does not do it: that
     issues a new user token, and an installation keeps the permissions it was created with until
     its owner says otherwise.
   - Where can this app be installed: **Any account**.
   - Copy the client id (`Iv23li…`), and **generate a client secret**.

   Device Flow can be left off, and so can **Request user authorization (OAuth) during
   installation** — sign-in authorizes on its own. Leaving the latter on is harmless but makes the
   "Install it on…" link bounce a stray code back into a tab that never asked for one, which the
   editor then ignores.

2. **Deploy the relay.** Config is `workers/wrangler.toml`; wrangler comes from `npx`, so there is
   nothing to install.

   ```
   npx wrangler@4 login             # interactive, opens a browser against your Cloudflare account
   pnpm relay:deploy                # prints the https://github-relay.<subdomain>.workers.dev address
   cp .dev.vars.example .dev.vars   # then fill in GH_CLIENT_SECRET
   pnpm relay:secrets               # uploads all three from that file
   ```

   `relay:secrets` reads `.dev.vars` rather than prompting, because `wrangler secret put` asks only
   "Enter a secret value" without naming the key — putting the client id and the client secret the
   wrong way round is easy, and secrets cannot be read back to check. The script refuses to upload
   if the two look swapped, and uploading again simply overwrites.

   `pnpm relay:deploy` again after any change to the worker. Secrets survive redeploys, so
   `relay:secrets` is only needed when one of them changes.

   Add the site's origin to `ALLOWED_ORIGINS` in the worker first, or the browser will refuse the
   response.

   **Where the secret lives:** only in Cloudflare's secret store, put there by `wrangler secret put`
   and injected as `env.GH_CLIENT_SECRET`. It is never in the repository and never readable back —
   rotate it on the app's settings page if it ever leaks. `.dev.vars` (gitignored, and wrangler's
   own convention) holds it locally: `pnpm relay` reads it to run the worker on node, and
   `pnpm relay:secrets` uploads it. It is never passed as a command argument, so it stays out of
   the shell history and the process list.

   **Never put it in `.env.local`.** Vite inlines every `VITE_*` name into the public JavaScript
   bundle, which is correct for the client id and catastrophic for the secret.

3. **Point the build at all three.** `.github/workflows/gh-pages.yml` already carries the client id
   and the slug; uncomment `VITE_GH_RELAY` there with the address step 2 printed. All three are
   public — they identify the app, they do not authorise anything — so they are literals in the
   workflow rather than repository secrets.

   Locally the same three names go in `.env.local`. Note that vite bakes `VITE_*` into the bundle at
   **build** time, so `pnpm dev` will not pick up a change to `.env.local` without a restart, and a
   preview build has to be rebuilt. With any of them missing there is no way to sign in at all: the
   editor says so and leaves **Copy YAML** as the way to get the files out.

## What the allowlist is, and is not

It gates **who gets to use this editor**. It is not a boundary around LSB: nobody can push to `base`
with or without it, and anyone who wants to can fork and open a pull request by hand today.
`ALLOWED_LOGINS=*` lets every GitHub account in, which is how the published editor runs; a comma
separated list of logins closes it again, and takes effect without a redeploy. Two consequences
worth knowing:

- It is checked when the token is issued, not on every write. Removing a login stops new sign-ins;
  it does not reach back and invalidate a token somebody already holds. Revoke the app installation
  for that to be immediate.
- Anyone can still paste their own token into a self-hosted copy and commit to their own fork. That
  is their repository and their business.

## What a contributor sees

1. **Sign in with GitHub** → github.com to authorise the app, and back to the editor already signed
   in, with whatever was on screen restored. No code to type.
2. If they have no fork, the panel says so and links to **Fork it on GitHub**. One click, then
   "Done, check again". An app cannot fork on someone's behalf. A fork under another name, such as
   `server-1`, is found too.
3. If they are signed in but the app is not installed on the fork, the panel says *that* and links
   to the install page. This case is worth catching properly: a user access token can read any
   **public** repository whether or not the app was installed, so the fork reads back perfectly and
   then refuses the first write. The editor asks `/user/installations` instead of inferring it from
   a successful read.
4. The toolbar then shows `→ their-login/server@regions/<date>`, which is where Save goes. The
   panel stays open until nothing is left to do, and an expired session signs them out and says so.
5. **Save** puts the zone on that branch as one commit. The branch covers a sitting: every zone
   touched that day is one commit on it, and saving a zone again rewrites *its* commit rather than
   adding another. Saving unchanged files does nothing at all.
6. **Open pull request** appears once something is on the branch, and opens GitHub's form against
   `base` with the description already written, from `src/pr_template.md`. Once the pull request
   exists it becomes **View pull request #N**, and later saves add to it. When it is merged or
   closed, including by squash, the next save starts a new branch.

## How the branch is built

The branch is rebuilt from the staging tip on every save rather than appended to. Each zone already
on it is replayed as a single commit -- by blob reference, so nothing is re-uploaded -- the saved
zone's commit is replaced, and the ref is force-moved to the result. Four things fall out of that:

- one commit per zone stays true however many times a zone is saved;
- a branch whose work has since been merged compares away to nothing, so the next save starts over
  from the new staging tip instead of dragging merged commits along;
- a zone already on the branch that `base` has changed since would be reverted by replaying its old
  files, so the save stops and names it instead; opening that zone and saving it again merges the
  change in;
- a save that changes nothing has to be recognised *before* the replay, since commit hashes take in
  the time they were made and a replay would otherwise mint new ones every time. That is why the
  editor computes git's own blob hash locally and compares it against what the branch already has.

A fork can point a ref straight at a commit in the staging repository because every fork in a
network shares one object store, which is also why no syncing step is needed.

Tokens expire after 8 hours by default. There is no refresh handling on purpose: 8 hours is a work
session, and signing in again is one click against twenty lines of token juggling.

## If a write fails with "Resource not accessible by integration"

That is GitHub saying the installation does not grant what the call needs. The editor turns it into
the permission's name and the page to fix it on, because the raw message names neither. The usual
causes are the app not being installed on that repository at all, or an installation still holding
the permissions it was created with after the app's were widened — the account owner has to accept
the new permissions before they take effect.
