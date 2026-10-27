# Deploy PVM Bridge

Part 1 puts the free tool on `pvmbridge.com` with page counts. It stands alone. Part 2 turns on accounts and payments. Part 3 turns on support mail. Part 1 is one sitting. Step 1.2 is the only wait in that sitting.

This file names the site host `pvmbridge.com` and the production database id. The only placeholder left in a config snippet or build command is `<client-token>` from step 2.15. Part 2 also tells you to add `ACCOUNTS` and, if necessary, change the rate-limit namespace id. Do not put a secret in a file or on a command line. `npx wrangler secret put` asks for it.

`npm ci` installs Wrangler in this repo. It does not put `wrangler` on the shell PATH. Use `npx wrangler` for a direct command. `npm run cf:dev` and `npm run cf:deploy` already run that install, because npm puts `node_modules/.bin` on the script PATH.

- Source: `package.json:47` has `"wrangler": "^4.153.0"`.
- Source: `package.json:22` has `wrangler dev`.
- Source: `package.json:23` has `wrangler deploy`.
- Not verified: npm's script PATH is not a line in this repo.

Each step uses the same lines. `Do` says what to do. One of `Run`, `Edit`, `Open`, or `Dashboard (not verified)` says where. `Source` names a file and a line, and the words on that line. `Derived from` means those lines support the step and do not state it. When a derived command was not run, the line says so. `Not verified` means the repo is silent. `Worked` says what you see before the next step. When that check shows a value is set and not that it is right, the next line says what a wrong value looks like later.

Run every command from the repo root.

## Part 1. The free tool and page counts

The server leaves accounts off because `ACCOUNTS` is unset. `accountsEnabled` is true only when the value is the exact string `on`. `VITE_WORKSPACES` shows or hides the workspace page. It does not switch the Worker.

### 1.1 Install the tools and sign in to Cloudflare

Do: Use Node 24. Install the packages. Sign Wrangler in to the Cloudflare account that will own the site.

Run:
```sh
npm ci
npx wrangler login
```

- Source: `.github/workflows/ci.yml:21` has `node-version: 24`.
- Source: `.github/workflows/ci.yml:23` has `npm ci`.
- Source: `package.json:47` has `"wrangler": "^4.153.0"`.
- Worked: `npx wrangler whoami` prints the account you mean to use.

### 1.2 Put the domain on Cloudflare

Do: Add `pvmbridge.com` to that account. At your registrar, set the two name servers Cloudflare gives you.

Dashboard (not verified): Cloudflare > Account Home > Add a domain.

- Not verified: the repo names no zone and no route.
- Source: `wrangler.jsonc:6` has `"name": "bridgekit"`. `wrangler.jsonc:1-41` has `"name": "bridgekit"`. `wrangler.jsonc:1-41` lacks `"routes"`.
- Worked: `dig +short NS pvmbridge.com` prints two names that end in `ns.cloudflare.com`. The name servers may not show yet. Steps 1.3 through 1.10 do not wait. Step 1.11 does.

### 1.3 Create the database

Do: Create the D1 database and copy the id it prints. If Wrangler offers to write that id into the config file, refuse. Its default binding name is the database name, `bridgekit`, and the entry in this file is bound as `DB`. Accepting that default binding name adds a second entry; choosing `DB` at the binding-name prompt updates the existing entry. Put the id on `wrangler.jsonc:25` yourself, as step 1.4 describes. Done in this repository: `wrangler.jsonc:23-25` already names the database and carries its production id, so run this only when `npx wrangler d1 list` does not show `bridgekit`. That listing is how you know the database is created.

Run:
```sh
npx wrangler d1 create bridgekit
```

- Source: `wrangler.jsonc:24` has `wrangler d1 create bridgekit`.
- Source: `wrangler.jsonc:23` has `"database_name": "bridgekit"`.
- Not verified: whether this version of Wrangler offers to edit the config file.
- Worked: `npx wrangler d1 list` shows a database named `bridgekit`.

### 1.4 Put the database id in wrangler.jsonc

Do: Confirm `wrangler.jsonc:25` holds the id from step 1.3. Done in this repository: the line already carries the production id shown below, so there is nothing to paste. Read it against the `npx wrangler d1 list` output from step 1.3. If that listing prints a different id, replace the id on this line with it.

Edit: `wrangler.jsonc:25`
```text
      "database_id": "919c2ed7-4a73-4d18-842d-02e392927a69",
```

- Source: `wrangler.jsonc:25` has `"database_id"`.
- Worked: `grep -c 00000000-0000 wrangler.jsonc` prints 0, and `grep -c database_id wrangler.jsonc` prints 1.

### 1.5 Set the site address

Do: Set `BETTER_AUTH_URL` to `https://pvmbridge.com` with no path and no trailing slash. Do not change this value in Part 2. Step 2.3 adds `ACCOUNTS` beside it. Done in this repository: `wrangler.jsonc:40` already carries that value, so confirm it and change nothing. `npm run cf:dev` and the local wrangler smoke run override it to `http://localhost:8790`, so those two local runs never send the production address. A direct `npx wrangler dev` still reads the value in the file.

Edit: `wrangler.jsonc:40`
```text
    "BETTER_AUTH_URL": "https://pvmbridge.com",
```

- Source: `wrangler.jsonc:40` has `"BETTER_AUTH_URL"`.
- Source: `wrangler.jsonc:39` has `The site address in production. Local development overrides it with http://localhost:8790.`
- Source: `server/auth.ts:48` has `trustedOrigins: [env.BETTER_AUTH_URL]`.
- Source: `server/auth.ts:118` has `${env.BETTER_AUTH_URL}/app/?invitation=${id}`.
- Source: `server/env.ts:8` has `BETTER_AUTH_URL: string`.
- Worked: `grep -n BETTER_AUTH_URL wrangler.jsonc` prints one line, and that line contains `"BETTER_AUTH_URL": "https://pvmbridge.com"`.

### 1.6 Check the build environment

Do: List `VITE_` names in the shell. List env files in the repo root. If the first command prints a `VITE_` name other than `VITE_PAGE_COUNTS`, `VITE_WORKSPACES`, or `VITE_AI_COMMENTARY`, unset that name. Run the first command again. If the second command prints a file other than `.env.example`, move that file out of the repo root. Run the second command again.

The build command in step 1.7 sets `VITE_PAGE_COUNTS`, `VITE_WORKSPACES`, and `VITE_AI_COMMENTARY`. Those three assignments override the same names from the shell and from an env file. A different `VITE_` name, such as `VITE_PADDLE_CLIENT_TOKEN`, can still change the build.

Run:
```sh
env | grep '^VITE_'
ls .env*
```

- Source: `vite.config.ts:53` has `loadEnv(mode, import.meta.dirname, "")`.
- Source: `vite.config.ts:59-61` has `VITE_AI_COMMENTARY === "1"`, `VITE_PAGE_COUNTS === "1"`, `VITE_WORKSPACES === "1"`.
- Source: `.env.example:4` has `VITE_AI_COMMENTARY=1`.
- Source: `README.md:100` has `.env.local`.
- Derived from: Vite's env guide says an environment variable that already exists when Vite runs is not overwritten by an env file ([Env Variables and Modes](https://vite.dev/guide/env-and-mode)). The assignments on the step 1.7 command set the three names before Vite runs. It was not run.
- Not verified: this repo does not state that priority.
- Worked: the first command prints nothing, or only `VITE_PAGE_COUNTS`, `VITE_WORKSPACES`, and `VITE_AI_COMMENTARY`. The second command prints only `.env.example`.

### 1.7 Build the free site

Do: Build with page counts on, workspaces off, and AI commentary off. Do not run `npm run build:cloudflare`. Do not run `npm run build`. Run this only after step 1.6 has the result in its Worked line.

Run:
```sh
node scripts/sitemap.mjs && VITE_PAGE_COUNTS=1 VITE_WORKSPACES=0 VITE_AI_COMMENTARY=0 npx vite build && node scripts/compress-wasm.mjs
```

`npm run build:cloudflare:free` wrote the same files, with the same hashes, as the command above.

- Derived from: `package.json:21` has `"build:cloudflare:free": "npm run sitemap && VITE_PAGE_COUNTS=1 VITE_WORKSPACES=0 VITE_AI_COMMENTARY=0 vite build && node scripts/compress-wasm.mjs"`. The command above keeps page counts. It sets the other two flags to 0. The author's session ran this command locally. `ls dist/pay` failed. The raw wasm count was 0. `dist/index.html` had `No tracking scripts.` once. `dist/index.html` had `No cookies, no accounts.` once. `dist/index.html` had `Cookies are used for sign-in.` zero times. The reviewer's session ran the same command locally, including a repeat. Both runs exited 0. The Worked checks matched. The reviewer's Node was v26.7.0. The author's report records no Node version. Node 24 was not installed in the reviewer's session. Neither session deployed.
- Source: `wrangler.jsonc:2` has `npm run build:cloudflare`. That line tells you to run the script in `package.json`. This step does not follow that line.
- Source: `package.json:20` has `VITE_AI_COMMENTARY=${VITE_AI_COMMENTARY:-1}`.
- Source: `package.json:9` has `"build": "npm run sitemap && vite build"`.
- Derived from: `index.html:237` has `No analytics.`, `No tracking scripts.`. `scripts/feature-blocks.ts:4` has `kept only when it applies`. `npm run build` does not set `VITE_PAGE_COUNTS`. The home page would keep `No analytics.` while the server counts page loads. The author's session ran `npm run build`. The reviewer's session ran `npm run build`. That run exited 0. Neither report records a reading of the home page after that build. Whether that page keeps `No analytics.` was not checked.
- Source: `vite.config.ts:60` has `VITE_PAGE_COUNTS === "1"`.
- Source: `vite.config.ts:77` has `VITE_WORKSPACES === "1"`, `pay/index.html`.
- Source: `scripts/compress-wasm.mjs:30` has `rmSync(file)`.
- Source: `index.html:237` has `No cookies, no accounts.`, `Cookies are used for sign-in.`
- Worked: `ls dist/pay` fails, `ls dist/assets | grep -c '\.wasm$'` prints 0, `grep -c 'No tracking scripts.' dist/index.html` prints 1, `grep -c 'No cookies, no accounts.' dist/index.html` prints 1, and `grep -c 'Cookies are used for sign-in.' dist/index.html` prints 0.

### 1.8 Store the one secret Part 1 needs

Do: Store a random string of at least 32 characters as `BETTER_AUTH_SECRET`. The command below sends the output of `openssl rand -base64 32` straight into `npx wrangler secret put`, so the value never appears on screen. Do not type the secret on the command line.

When the Worker does not exist yet, Wrangler creates a draft Worker and then retries the secret upload. With the pipe it takes that default without asking. If creation fails, run the deploy command in step 1.10. Run this put again. Run that deploy command again.

Run:
```sh
openssl rand -base64 32 | npx wrangler secret put BETTER_AUTH_SECRET
```

- Source: `server/env.ts:9` has `BETTER_AUTH_SECRET: string`.
- Source: `.dev.vars.example:3` has `at-least-32-chars`.
- Source: `wrangler.jsonc:56` has `wrangler secret put NAME`.
- Source: `package.json:47` has `"wrangler": "^4.153.0"`.
- Not verified: the remote prompt, creating the draft Worker, and the retry. This session did not run secret put or deploy.
- Worked: `npx wrangler secret list` prints `BETTER_AUTH_SECRET`.

### 1.9 Confirm no other secret is set

Do: Confirm the Worker lists only `BETTER_AUTH_SECRET`. Leave unset `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `EMAIL_FROM`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`, `PADDLE_PRICE_ID`, and `PADDLE_ENVIRONMENT`. Leave `ACCOUNTS` and `LOCAL_EMAIL_LOG` unset. `LOCAL_EMAIL_LOG` is the local-only Worker variable that production never sets.

Run:
```sh
npx wrangler secret list
grep -c '"ACCOUNTS"' wrangler.jsonc
```

- Source: `server/env.ts:27` has `LOCAL_EMAIL_LOG?: string`.
- Source: `wrangler.jsonc:34-37` has `LOCAL_EMAIL_LOG is a Worker variable`, `This file does not`, `set it`.
- Source: `wrangler.jsonc:30-32` has `This file does not`, `set it`.
- Source: `wrangler.jsonc:40` has `"BETTER_AUTH_URL"`. `wrangler.jsonc:40` lacks `"ACCOUNTS"`.
- Worked: the first command prints `BETTER_AUTH_SECRET` and no other name from `server/env.ts`. The second command prints 0.

### 1.10 Deploy

Do: Deploy the build from step 1.7. This command applies the remote migrations and then deploys. It does not build. If the upload fails after the migrations are already applied, run the same command again. If step 1.8 already ran this command twice, stop. You are done with this step.

Run:
```sh
npm run cf:deploy
```

A deploy carrying the cron trigger fails its trigger step with Cloudflare error 10063, `You need a workers.dev subdomain in order to proceed`, until step 3.5 creates the workers.dev subdomain. Step 3.6 applies the trigger afterwards.

- Source: `package.json:23` has `"cf:deploy": "wrangler d1 migrations apply bridgekit --remote && wrangler deploy"`. `package.json:23` lacks `vite build`.
- Source: `wrangler.jsonc:26` has `"migrations_dir": "migrations"`.
- Source: `migrations/0001_page_views.sql:2` has `CREATE TABLE page_views`.
- Source: `migrations/0002_auth.sql:2` has `create table "user"`.
- Source: `migrations/0003_workspaces.sql:4` has `CREATE TABLE subscription`.
- Source: `migrations/0004_workspace_limits.sql` adds `CREATE VIEW workspace_seats` and two `BEFORE` triggers on `invitation` that refuse a write with `RAISE(ABORT)`. Applying it changes no row, so `wrangler d1 migrations apply` applies it to a database that already holds workspaces and invitations at or over the limits without touching them; the `BEFORE INSERT` and `BEFORE UPDATE` triggers on `invitation` then refuse only a write that leaves a live pending invitation the workspace has no seat for.
- Not verified: whether a second apply of the same migrations is a no-op.
- Not verified: error 10063 and the failing trigger step. The repo states neither, and this session did not deploy.
- Worked: the command exits 0 when the account already has a workers.dev subdomain. Because `wrangler.jsonc` sets `"workers_dev": false` and names no routes, it prints `No targets deployed for bridgekit` with this run's time in parentheses. Its last line is `Current Version ID: <id>`, and `npx wrangler deployments list` shows a deployment from this run.

### 1.11 Put the Worker on the domain

Do: Add `pvmbridge.com` as a custom domain on the Worker named `bridgekit`. Wait until step 1.2 has finished.

Dashboard (not verified): Cloudflare > Workers & Pages > bridgekit > Settings > Domains & Routes > Add > Custom Domain.

- Not verified: the repo does not name this dashboard screen.
- Source: `wrangler.jsonc:6` has `"name": "bridgekit"`. `wrangler.jsonc:1-41` has `"name": "bridgekit"`. `wrangler.jsonc:1-41` lacks `custom_domain`.
- Worked: `curl -sI https://pvmbridge.com/ | head -n 1` prints a status line with 200.

### 1.12 Check that accounts are off

Do: Ask the live site what it offers. Send POST `/api/auth/sign-in/magic-link` with Origin `https://pvmbridge.com` and JSON `{"email":"review@example.invalid","callbackURL":"https://pvmbridge.com/app/"}`.

Run:
```sh
curl -sS https://pvmbridge.com/api/config
curl -sS -w '\n%{http_code}\n' -X POST 'https://pvmbridge.com/api/auth/sign-in/magic-link' \
  -H 'Origin: https://pvmbridge.com' \
  -H 'content-type: application/json' \
  --data '{"email":"review@example.invalid","callbackURL":"https://pvmbridge.com/app/"}'
```

- Source: `server/worker.ts:49-50` has `function accountsEnabled`, `value === "on"`.
- Source: `server/worker.ts:61` has `providers: [] as string[]`, `commentary: false`, `billing: false`.
- Source: `server/worker.ts:67-68` has `function closedApiResponse`, `pathname === "/api/config"`, `CLOSED_CONFIG`.
- Source: `server/worker.ts:64` has `{ error: "Not found." }`, `status: 404`.
- Source: `server/worker.ts:466-467` has `closedApiResponse`, `!accountsEnabled(env.ACCOUNTS)`.
- Worked: the config body has no providers, `commentary` is false, and `billing` is false. The sign-in body is `{"error":"Not found."}` and the status is 404.

### 1.13 Check the home page and the pay address

Do: Read the live home page, and request the pay address.

Run:
```sh
curl -s https://pvmbridge.com/ | grep -c 'No tracking scripts.'
curl -s https://pvmbridge.com/ | grep -c 'No cookies, no accounts.'
curl -s https://pvmbridge.com/ | grep -c 'Cookies are used for sign-in.'
curl -s -o /dev/null -w '%{http_code}\n' https://pvmbridge.com/pay/
```

- Source: `index.html:237` has `No tracking scripts.`, `Cookies are used for sign-in.`
- Derived from: `vite.config.ts:77` has `pay/index.html`. `wrangler.jsonc:13` has `"not_found_handling": "404-page"`. The Part 1 build has no pay page. The address is not found. The author's session saw this on a local Part 1 Worker. The home page had `No tracking scripts.` once. The home page had `Cookies are used for sign-in.` zero times. `GET /pay/` returned 404. The prior reviewer's session checked `No tracking scripts.`, `sign in for Pro`, and the pay address against `http://127.0.0.1:8790`; those checks printed 1, 0, and 404. That session did not run either current cookie-sentence command. The later local Part 1 build check counted `No cookies, no accounts.` once and `Cookies are used for sign-in.` zero times in `dist/index.html`. Neither current cookie-sentence command was run against a served build or the live domain.
- Worked: the four commands print 1, 1, 0, then 404.

### 1.14 Check the tool

Do: Open the tool with the sample data.

Open:
```text
https://pvmbridge.com/app/?sample
```

- Source: `README.md:62` has `/app/?sample`.
- Source: `wrangler.jsonc:18` has `/assets/*.wasm`.
- Source: `server/assets.ts:6` has `removes the original`.
- Worked: the sample bridge appears, with its chart and its table.

### 1.15 Check that page loads are counted

Do: Open the home page in a browser, then print the counts. A request from `curl` is not counted.

Open:
```text
https://pvmbridge.com/
```

- Source: `server/counts.ts:16` has `headless|curl|wget`.
- Source: `server/worker.ts:446` has `countPageView(`.
- Source: `package.json:24` has `SELECT day, path, referrer, views FROM page_views`.
- Worked: `npm run stats` prints a row whose path is `/`.

### 1.16 Optional. Run the smoke test against the live site

Do: Run the smoke test against the live site. It needs Chromium on this machine.

Run:
```sh
npm run smoke -- https://pvmbridge.com
```

- Source: `package.json:15` has `"smoke": "node scripts/smoke.mjs"`.
- Source: `scripts/smoke.mjs:204` has `where ?? "http://localhost:5173"`.
- Source: `scripts/smoke.mjs:2072` has `smoke test passed`.
- Source: `README.md:162` has `npm run smoke -- http://localhost:8790`.
- Not verified: that this passes against a deployed site. The repo shows it against a local server.
- Worked: the last line is `smoke test passed`.

## What Part 1 leaves off

Account, workspace, checkout, webhook, and commentary routes are off because `ACCOUNTS` is unset. The Part 1 pages omit the workspace code because `VITE_WORKSPACES` is `0`. The page flag and the server flag change separately.

- Source: `server/worker.ts:50` has `value === "on"`.
- Source: `server/worker.ts:61` has `CLOSED_CONFIG`.
- Source: `server/worker.ts:67-69` has `closedApiResponse`, `gatedApiPath`, `notFound()`.
- Source: `server/worker.ts:77` has `createAuth(c.env`.
- Source: `server/worker.ts:466-468` has `closedApiResponse`, `!accountsEnabled(env.ACCOUNTS)`, `open.fetch`.
- Source: `wrangler.jsonc:30-32` has `ACCOUNTS is a Worker variable`, `This file does not`, `set it`.
- Source: `src/app/App.tsx:38` has `elsewhere the code is left out`.
- Source: `src/app/App.tsx:39` has `import.meta.env.VITE_WORKSPACES === "1"`.

`worker.fetch` returns the closed response before `open.fetch` when accounts are off. `createAuth` is on the open app, so that return does not call it. A gated path returns 404 and `{"error":"Not found."}`. It does not write a verification row, because the auth handler does not run.

- Derived from: `server/worker.ts:77` has `createAuth(c.env`. `server/worker.ts:467-468` has `return closed`, `open.fetch`. The verification write is not a line in this return. It was not run.

A path whose first segment is `api` in another letter case does not match `run_worker_first`. `/API/auth/sign-in/magic-link` is that kind of path. A local wrangler measurement returned the site's HTML 404 page for GET and 405 with an empty body for POST. That path never reaches an account route. The measurement is the local one. It was not a live zone.

A path with an encoded prefix also misses `run_worker_first`. `/api%2Fauth/sign-in/magic-link` and `/%61pi/auth/sign-in/magic-link` are that kind of path. The same local wrangler measurement returned 307 to the canonical path for GET and 405 with an empty body for POST. Following that redirect ends at the Worker's 404, not at an account handler.

A feature segment in another letter case does match `/api/*`. `/api/AUTH/sign-in/magic-link` reaches the Worker. The gate returns 404 JSON. That answer is the Worker, not the asset layer.

- Source: `wrangler.jsonc:18` has `run_worker_first`, `/api/*`.
- Source: `wrangler.jsonc:13` has `"not_found_handling": "404-page"`.
- Source: `server/worker.ts:57-58` has `toLowerCase()`, `feature === "auth"`.
- Not verified: production asset responses for the other-case prefix and the encoded prefix. The statuses above are the local wrangler measurement.

## Part 2. Accounts and payments

You need a Resend account and a Paddle account that can take live payments. The server is set before the pages that show sign-in and Subscribe. Those pages ship in step 2.18.

### 2.1 Move the account to Workers Paid

Do: Move this Cloudflare account to Workers Paid before sign-in goes live.

Dashboard (not verified): Cloudflare > Workers & Pages > Plans.

- Not verified: the dashboard click path. The repo names no Workers plan. The repo does not establish which plan is enough.
- Worked: the dashboard shows Workers Paid.

### 2.2 Confirm the site address

Do: Confirm `BETTER_AUTH_URL` is still `https://pvmbridge.com`, with no path and no trailing slash. The host is the host you will use in step 2.10. Do not edit the value.

Run:
```sh
grep -n BETTER_AUTH_URL wrangler.jsonc
```

- Source: `wrangler.jsonc:40` has `"BETTER_AUTH_URL"`.
- Source: `server/auth.ts:48` has `trustedOrigins: [env.BETTER_AUTH_URL]`.
- Source: `server/worker.ts:85-86` has `new URL(c.env.BETTER_AUTH_URL).origin`, `Requests must come from this site.`
- Source: `server/auth.ts:118` has `${env.BETTER_AUTH_URL}/app/?invitation=${id}`.
- Not verified: what the sign-in routes answer when the address is outside `trustedOrigins`. That code is not in this repo.
- Worked: the printed line contains `"BETTER_AUTH_URL": "https://pvmbridge.com"`. This proves it is set, not that it is right.
- If this is wrong you will see: trustedOrigins is this address. Saving, deleting, and Subscribe answer `Requests must come from this site.` An invitation link is this address joined to `/app/?invitation=`, and a trailing slash puts a second slash before `app`.

### 2.3 Set ACCOUNTS to on

Do: Add `"ACCOUNTS": "on"` inside `vars`, beside `BETTER_AUTH_URL`. Do not store this name with `npx wrangler secret put`. It is not a secret.

Edit: `wrangler.jsonc` `vars`
```text
    "ACCOUNTS": "on",
```

Dashboard (not verified): the repo does not name the dashboard control for a Worker variable.

- Source: `wrangler.jsonc:38` has `"vars"`.
- Source: `wrangler.jsonc:30-32` has `ACCOUNTS is a Worker variable`, `exact string on`, `This file does not`.
- Source: `server/env.ts:37-38` has `Off unless the value is exactly "on".`, `ACCOUNTS?: string`.
- Source: `server/worker.ts:50` has `value === "on"`.
- Not verified: the dashboard control for a Worker variable.
- Worked: `grep -n '"ACCOUNTS"' wrangler.jsonc` prints `"ACCOUNTS": "on"`.
- If this value is missing or is any other value, every account, workspace, checkout, webhook, and commentary route returns 404 `{"error":"Not found."}` even when the secrets are set. `GET /api/config` still reports no providers, no billing, and no commentary. Step 2.19 is the check after the rest of Part 2 is in place.

### 2.4 Verify a sending domain in Resend

Do: Add the domain you will send sign-in mail from, and add the DNS records Resend lists. Those records go in Cloudflare after step 1.2.

Dashboard (not verified): Resend > Domains > Add Domain.

- Not verified: that Resend refuses an unverified sender. This repo does not check the domain.
- Source: `server/email.ts:36` has `from: env.EMAIL_FROM`.
- Worked: Resend lists the domain as verified. Later steps do not wait for that. Step 2.20 does.

### 2.5 Store the Resend API key

Do: Create an API key that can send mail, and store it.

Dashboard (not verified): Resend > API Keys > Create API Key.
```sh
npx wrangler secret put RESEND_API_KEY
```

- Source: `server/env.ts:12` has `RESEND_API_KEY?: string`.
- Source: `server/email.ts:33-35` has `https://api.resend.com/emails`, `Bearer ${env.RESEND_API_KEY}`.
- Worked: `npx wrangler secret list` prints `RESEND_API_KEY`.

### 2.6 Store the sender address

Do: Store the From address on the domain from step 2.4. Set this and `RESEND_API_KEY` as a pair.

Run:
```sh
npx wrangler secret put EMAIL_FROM
```

- Source: `server/env.ts:13` has `EMAIL_FROM?: string`.
- Source: `server/email.ts:6` has `return value === "on"`.
- Source: `server/email.ts:28-30` has `!env.RESEND_API_KEY || !env.EMAIL_FROM`, `[email] to`.
- Source: `src/app/Workspace.tsx:259` has `Check your email for a sign-in link.`
- Source: `src/app/account.ts:81` has `if (!response.ok) throw new Error`.
- Worked: `npx wrangler secret list` prints `EMAIL_FROM` and `RESEND_API_KEY`. This proves it is set, not that it is right.
- If this is wrong you will see: only one of the pair is set. When `LOCAL_EMAIL_LOG` is not exactly `on`, the Workspace panel shows `Accounts are not open yet.` and no form, and the Worker log does not contain `[email] to`. When `LOCAL_EMAIL_LOG` is exactly `on`, the form is shown and the Worker log contains `[email] to`.

### 2.6a Leave LOCAL_EMAIL_LOG for local work

Do: Copy `.dev.vars.example` to `.dev.vars` (not committed) and set `LOCAL_EMAIL_LOG=on` for local work. The value is exactly `on`. Any other value, a missing line, or an empty value means production.

Edit: `.dev.vars`
```text
LOCAL_EMAIL_LOG=on
```

Without a mail key, exactly `on` writes the sign-in or invitation mail to the Worker log. Any other value makes the send fail, so a link never lands in a production log.

- Source: `server/email.ts:6` has `return value === "on"`.
- Source: `server/email.ts:29` has `throw new APIError("SERVICE_UNAVAILABLE"`.
- Source: `server/env.ts:20-27` has `On only when the value is exactly "on".`, `LOCAL_EMAIL_LOG?: string`.
- Source: `wrangler.jsonc:34-37` has `LOCAL_EMAIL_LOG is a Worker variable`, `This file does not`, `set it`.
- Worked: `grep -c '^LOCAL_EMAIL_LOG=on$' .dev.vars` prints 1, and the production Worker has no `LOCAL_EMAIL_LOG` secret, so `npx wrangler secret list` does not print it. The second check is step 3.3.

### 2.7 Create the product in Paddle

Do: Create one product for Pro.

Dashboard (not verified): Paddle > Catalog > Products > New product.

- Not verified: the repo names no Paddle product. Checkout sends a price id.
- Source: `server/paddle.ts:383` has `price_id: options.priceId`.
- Worked: the product is in the Paddle catalog.

### 2.8 Create the per-seat price and store its id

Do: Add one monthly per-seat price to that product, at the price you chose. Set the maximum quantity to at least 200. Store the id of the price, not the id of the product.

Dashboard (not verified): Paddle > Catalog > Products > the product > New price.
```sh
npx wrangler secret put PADDLE_PRICE_ID
```

- Source: `server/env.ts:34` has `PADDLE_PRICE_ID?: string`.
- Source: `server/paddle.ts:383` has `quantity: options.seats`.
- Source: `src/app/Workspace.tsx:294` has `max={200}`.
- Source: `index.html:287` has `per user per month`.
- Source: `server/worker.ts:307` has `env.PADDLE_PRICE_ID ? [env.PADDLE_PRICE_ID] : undefined`.
- Source: `server/worker.ts:361` has `"ignored"`.
- Not verified: Paddle's default quantity limit for a price.
- Worked: `npx wrangler secret list` prints `PADDLE_PRICE_ID`.

### 2.9 Get the website approved

Do: Ask Paddle to approve `pvmbridge.com`. Wait until Paddle lists `pvmbridge.com` as approved.

Dashboard (not verified): Paddle > My account > Settings > Website approval.

- Source: `server/paddle.ts:333` has `domain approved in Paddle (Website approval)`.
- Source: `server/paddle.ts:405` has `Check the default payment link is set and approved.`
- Not verified: how long approval takes, and what Paddle asks for. Nobody entered an account. Paddle's guide names this screen and places approval before the default payment link, at [Set your default payment link](https://developer.paddle.com/build/transactions/default-payment-link).
- Worked: Paddle lists `pvmbridge.com` as approved.

### 2.10 Point the default payment link at the pay page

Do: Set the default payment link to `https://pvmbridge.com/pay/` with the final slash. Use the same host as `BETTER_AUTH_URL` from step 1.5. Run this only after step 2.9 has the result in its Worked line.

Dashboard (not verified): Paddle > Checkout > Checkout configuration.
```text
https://pvmbridge.com/pay/
```

- Derived from: `server/paddle.ts:331-332` has `default payment link`, `?_ptxn=`. `vite.config.ts:77` has `pay/index.html`. `README.md:144-145` has `Checkout opens on`, `/pay/`. The code names no path for that link. `/pay/` is the page built to load Paddle's script. It was not run.
- Source: `scripts/policy.ts:10` has `script-src 'self' 'wasm-unsafe-eval'`.
- Source: `scripts/policy.ts:25` has `https://cdn.paddle.com`.
- Source: `src/app/Workspace.tsx:137-139` has `const { checkoutUrl } = await api.checkout(active, seats);`, `location.href = checkoutUrl;`.
- Source: `src/pay/pay.ts:48` has `successUrl`, `/app/?subscribed=1`.
- Source: `src/app/Workspace.tsx:69` has `if (!signedIn) return`.
- Not verified: that a session cookie set on one host is absent on another host. That is the browser, not this repo. Nobody entered an account. The guide is [Set your default payment link](https://developer.paddle.com/build/transactions/default-payment-link).
- Not verified: whether the dashboard accepts the link while approval is pending. Nobody entered an account to try that save.
- Worked: Paddle shows the saved link. This proves it is set, not that it is right.
- If this is wrong you will see: the payment link is not on `/pay/`. Subscribe opens another page of the site with `?_ptxn=` in the address. No checkout appears, and nothing reports an error.
- If this is wrong you will see: the success URL is the pay page host plus `/app/?subscribed=1`. On another host the buyer is signed out, `if (!signedIn) return` runs, and the thank-you line does not.

### 2.11 Add the webhook and its nine events

Do: Add one notification destination at the address below. Select these nine events, and no others.

- `subscription.created`
- `subscription.activated`
- `subscription.updated`
- `subscription.trialing`
- `subscription.past_due`
- `subscription.paused`
- `subscription.resumed`
- `subscription.canceled`
- `subscription.imported`

Dashboard (not verified): Paddle > Developer Tools > Notifications > New destination.
```text
https://pvmbridge.com/api/paddle/webhook
```

Each of these events carries the subscription, but the Worker does not store the status from the event. For a known workspace it reads the account's subscription list from Paddle, keeps the subscriptions tagged for that workspace, and stores the state Paddle reports. The event only says which workspace and subscription to look at; the row holds what Paddle reports when the delivery is handled.

- Source: `server/worker.ts:354` has `"/api/paddle/webhook"`.
- Source: `server/paddle.ts:89-97` has `subscription.created`, `subscription.activated`, `subscription.updated`, `subscription.trialing`, `subscription.past_due`, `subscription.paused`, `subscription.resumed`, `subscription.canceled`, `subscription.imported`.
- Source: `server/paddle.ts:161` has `!SUBSCRIPTION_EVENTS.includes(body.event_type)) return null`.
- Source: `server/paddle.ts:299-302` has `case "active":`, `return true`.
- Source: `server/paddle.ts:303-306` has `case "canceled":`, `now.getTime() < end`.
- Source: `server/workspace.ts:41` has `if (!row) return { pro: false`.
- Source: `server/paddle.ts:141` has `Carries no state.`
- Source: `server/workspace.ts:377` has `listWorkspaceSubscriptions(paddle, event.workspaceId)`.
- Source: `server/workspace.ts:401` has `status: elected.status`.
- Source: `src/app/Workspace.tsx:288` has `Saving needs Pro`.
- Worked: Paddle shows the destination and those nine events. This proves it is set, not that it is right.
- If this is wrong you will see: a missing webhook event fails nothing. A workspace that paid still shows `Saving needs Pro`, or a canceled one keeps Pro, because that event never arrives.

### 2.12 Store the webhook secret

Do: Copy the destination's secret key and store it.

Dashboard (not verified): Paddle > Developer Tools > Notifications > the destination > Secret key.
```sh
npx wrangler secret put PADDLE_WEBHOOK_SECRET
```

- Source: `server/env.ts:33` has `PADDLE_WEBHOOK_SECRET?: string`.
- Source: `server/worker.ts:356-357` has `!c.env.PADDLE_WEBHOOK_SECRET`, `Bad signature.`
- Worked: `npx wrangler secret list` prints `PADDLE_WEBHOOK_SECRET`.

### 2.13 Store the Paddle API key

Do: Create a live API key with the `transaction.write`, `subscription.read`, and `customer_portal_session.write` permissions. Store the key. The permission names are not in this repo.

Dashboard (not verified): Paddle > My account > Settings > Authentication > API keys.
```sh
npx wrangler secret put PADDLE_API_KEY
```

The Manage billing route opens a Paddle customer portal session. A key without `customer_portal_session.write` cannot open the portal.

After verifying the signature and accepting a supported subscription event, the Worker checks this key. With no `PADDLE_API_KEY`, the webhook answers 503 with `Subscriptions are not set up yet.`, writes nothing, and Paddle retries the delivery. For a known workspace, a key that cannot list subscriptions makes the webhook answer 502 with `Could not read the subscription from Paddle.`, and Paddle retries that too.

- Source: `server/env.ts:32` has `PADDLE_API_KEY?: string`.
- Source: `server/paddle.ts:388-391` has `doFetch`, `/transactions`, `method: "POST"`.
- Derived from: `server/paddle.ts:399` has `Paddle returned ${response.status} when creating a transaction.` A 403 makes that throw `Paddle returned 403 when creating a transaction.` It was not run.
- Source: `server/worker.ts:261-262` has `console.error(error)`, `Something went wrong on the server.`
- Source: `server/worker.ts:365` has `if (!paddle) return c.json({ error: "Subscriptions are not set up yet." }, 503)`.
- Source: `server/worker.ts:386` has `Could not read the subscription from Paddle.`, `502`
- Source: `server/paddle.ts:244` has `Paddle returned ${response.status} when listing subscriptions.`
- Source: `server/worker.ts:333` has `open.post("/api/workspaces/:id/portal", async (c) => {`.
- Source: `src/app/Workspace.tsx:306` has `Manage billing`.
- Source: `server/paddle.ts:351` has `export async function createPortalSession(`.
- Source: `server/paddle.ts:355` has `portal-sessions`.
- Source: `server/paddle.ts:367` has `Paddle returned ${response.status} when creating a portal session.`
- Not verified: the permission names are not in this repo. Paddle's transaction reference requires `transaction.write` at [Create a transaction](https://developer.paddle.com/api-reference/transactions/create-transaction). Paddle's authentication reference says a key without the permission returns 403, at [Authentication](https://developer.paddle.com/api-reference/about/authentication). Paddle's permissions page lists `subscription.read` and `customer_portal_session.write` at [Permissions](https://developer.paddle.com/api-reference/about/permissions), the second under Customer self-service; a key without a permission is refused with 403. Nobody entered an account. For an accepted subscription event for a known workspace, that refusal makes the webhook answer 502. For the portal route, it makes the answer 502 with `Could not open the billing portal. Try again.`
- Worked: `npx wrangler secret list` prints `PADDLE_API_KEY`. This proves the name is present, not that the key can create a transaction.
- If this is wrong you will see: Subscribe answers 500 and `Something went wrong on the server.`

### 2.14 Store the Worker Paddle switch

Do: Store `live` as `PADDLE_ENVIRONMENT`. Type the lower-case word `live` and nothing else. Do not add this name under `vars`. The secrets comment omits it. A vars line would shift that comment. The Worker reads the name and treats only `live` as live.

A live Worker, with `PADDLE_ENVIRONMENT` set to `live`, paired with a sandbox page, where `VITE_PADDLE_ENVIRONMENT` is not `live`, cannot open that transaction's checkout. Changing the Worker secret does not change the compiled page. Rebuild with step 2.16.

Run:
```sh
npx wrangler secret put PADDLE_ENVIRONMENT
```

- Source: `server/env.ts:36` has `PADDLE_ENVIRONMENT?: string`.
- Source: `server/env.ts:35` has `"sandbox" (default) or "live"`.
- Source: `wrangler.jsonc:56` has `wrangler secret put NAME`. `wrangler.jsonc:56` lacks `PADDLE_ENVIRONMENT`.
- Source: `.dev.vars.example:11` has `Worker switch`, `VITE_PADDLE_ENVIRONMENT`.
- Source: `server/worker.ts:325` has `c.env.PADDLE_ENVIRONMENT === "live" ? "live" : "sandbox"`.
- Source: `server/paddle.ts:19-20` has `https://sandbox-api.paddle.com`, `https://api.paddle.com`.
- Source: `src/pay/pay.ts:47` has `VITE_PADDLE_ENVIRONMENT !== "live"`.
- Derived from: `server/paddle.ts:389` has `PADDLE_API[options.environment]`. Any value other than `live` sends the key from step 2.13 to the sandbox host. It was not run.
- Not verified: the exact words Paddle shows for a live transaction opened by a sandbox page. This session did not open a checkout.
- Worked: `npx wrangler secret list` prints `PADDLE_ENVIRONMENT`. This proves it is set, not that it is right.
- If this is wrong you will see: the Worker switch is not `live`. Subscribe shows `Something went wrong on the server.` The request goes to `https://sandbox-api.paddle.com`.

### 2.15 Create the client-side token

Do: Create a live client-side token and keep it for step 2.16. The build writes it into the page. Do not store it with `npx wrangler secret put`.

Dashboard (not verified): Paddle > My account > Settings > Authentication > Client-side tokens.

- Source: `src/pay/pay.ts:37` has `import.meta.env.VITE_PADDLE_CLIENT_TOKEN`.
- Not verified: nobody entered an account. Paddle's page for this token is [Manage client-side tokens](https://developer.paddle.com/paddle-js/about/client-side-tokens).
- Worked: Paddle lists the token.

## Names that stay unset

The Part 2 build keeps `VITE_AI_COMMENTARY` at 0, so the commentary button stays hidden, and `ANTHROPIC_API_KEY` stays unset. `src/app/useConfig.ts:231` has `import.meta.env.VITE_AI_COMMENTARY !== "1"`. `server/worker.ts:391` has `if (!c.env.ANTHROPIC_API_KEY) return null`.

- Leave unset: `ANTHROPIC_API_KEY`

Microsoft and Google stay unset. A client id alone would add that provider to the sign-in button, and registration runs only when both the id and the secret are set. `server/worker.ts:269-270` has `c.env.MICROSOFT_CLIENT_ID ? ["microsoft"]`, `c.env.GOOGLE_CLIENT_ID ? ["google"]`. `server/auth.ts:52` has `env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET`. `server/auth.ts:55` has `env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET`.

- Leave unset: `MICROSOFT_CLIENT_ID`
- Leave unset: `MICROSOFT_CLIENT_SECRET`
- Leave unset: `GOOGLE_CLIENT_ID`
- Leave unset: `GOOGLE_CLIENT_SECRET`

### 2.16 Build with accounts and payments

Do: Build with page counts, workspaces, and the two Paddle page variables. Leave AI commentary off. Do not change this command. The names this command sets override the same names from the shell and from an env file. Changing `PADDLE_ENVIRONMENT` does not change the page this command compiles. Run this command again after you change `VITE_PADDLE_ENVIRONMENT`.

Run:
```sh
node scripts/sitemap.mjs && VITE_PAGE_COUNTS=1 VITE_WORKSPACES=1 VITE_AI_COMMENTARY=0 VITE_PADDLE_CLIENT_TOKEN=<client-token> VITE_PADDLE_ENVIRONMENT=live npx vite build && node scripts/compress-wasm.mjs
```

- Derived from: `package.json:21` has `VITE_PAGE_COUNTS=1 VITE_WORKSPACES=0 VITE_AI_COMMENTARY=0 vite build && node scripts/compress-wasm.mjs`. `package.json` lacks `VITE_PADDLE`. The command above sets AI commentary to 0. It adds the two Paddle variables. No npm script sets those variables. The author's session ran this command locally with a stand-in client token. `dist/pay/index.html` existed. The stand-in token was in one dist file. The `Cookies are used for sign-in.` count is 1. The `No tracking scripts.` count was 1. The raw wasm count was 0. The reviewer's session ran the same command locally with a different stand-in token. The command exited 0. The Worked checks passed. Neither session deployed. Neither session used a live Paddle client token.
- Source: `src/pay/pay.ts:37` has `import.meta.env.VITE_PADDLE_CLIENT_TOKEN`.
- Source: `src/pay/pay.ts:12` has `There is no checkout to open. Start from the Workspace panel in the tool.`
- Source: `src/pay/pay.ts:47` has `VITE_PADDLE_ENVIRONMENT !== "live"`.
- Source: `src/app/App.tsx:39` has `import.meta.env.VITE_WORKSPACES === "1"`.
- Source: `index.html:237` has `No cookies, no accounts.`, `Cookies are used for sign-in.`
- Worked: `test -f dist/pay/index.html` succeeds, `grep -R -l '<client-token>' dist` prints a path, `grep -c 'Cookies are used for sign-in.' dist/index.html` prints 1, `grep -c 'No cookies, no accounts.' dist/index.html` prints 0, `grep -c 'No tracking scripts.' dist/index.html` prints 1, and `ls dist/assets | grep -c '\.wasm$'` prints 0.

### 2.17 Confirm the sign-in rate limit

Do: Leave the `ratelimits` entry in `wrangler.jsonc`. The name is `MAGIC_LINK_RATE_LIMIT`. Part 1 does not need this step, because accounts are off and the Worker returns the closed response before it reaches this binding.

Do: Keep `namespace_id` as a string that holds a positive integer. The file has `"1001"`. Read the wrangler config of each other Worker in this account. When one of them already uses `1001`, replace that string with a positive integer none of them use. Do that before step 2.18. Leave `limit` at 3. Leave `period` at 60. The `simple` object holds those two fields. Do not store `MAGIC_LINK_RATE_LIMIT` with `npx wrangler secret put`.

Do: Confirm that this account's plan includes this binding.

The limit is approximate. Cloudflare counts it per location, and the count is eventually consistent.

The Configuration section of [Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) says a `namespace_id` is unique in the account when you do not want to share counters, and that two Workers that share a `namespace_id` share counters. The Monitoring section of that page says rate limiting bindings are not currently visible in the Cloudflare dashboard. The Locality section says the limit is local to the Cloudflare location. The Accuracy section says the API is permissive and eventually consistent.

Step 2.1 moves the account to Workers Paid. It does not say that this binding is included.

After step 2.18, step 2.20 sends four sign-in requests for one valid address from one connection within a minute. Once Cloudflare's count has caught up, the four answer 200, 200, 200, 429 and three emails arrive. Four 200 answers are inconclusive, not proof that the binding is missing. The Locality and Accuracy sections of [Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) say the count is per location and eventually consistent, so a request can pass before the cached count reaches it. Step 2.20 bounds the run and says what to do when it stays inconclusive.

Run:
```sh
grep -n -A 4 '"ratelimits"' wrangler.jsonc
```

- Source: `wrangler.jsonc:44` has `"name": "MAGIC_LINK_RATE_LIMIT"`.
- Source: `wrangler.jsonc:45` has `"namespace_id": "1001"`.
- Source: `wrangler.jsonc:46` has `"limit": 3`, `"period": 60`.
- Source: `server/env.ts:39` has `MAGIC_LINK_RATE_LIMIT?: RateLimit`.
- Derived from: `server/worker.ts:50` has `value === "on"`. `server/worker.ts:228` has `limitMagicLinkSignIn`. `server/worker.ts:466-467` has `closedApiResponse`, `!accountsEnabled(env.ACCOUNTS)`. Part 1 returns the closed response and does not call `limitMagicLinkSignIn`. It was not run.
- Source: `server/auth.ts:138` has `if (rateLimit === undefined) return null`.
- Source: `server/auth.ts:65-66` has `customRules: {`, `[signInMagicLink.path]: () => false`. The library's own limit for this route is off, so a missing binding leaves sign-in unlimited.
- Not verified: which plan includes the binding. The [Limits](https://developers.cloudflare.com/workers/platform/limits/) page does not name it. The [Pricing](https://developers.cloudflare.com/workers/platform/pricing/) page does not name it.
- Not verified: a way to list the `namespace_id` values other Workers in this account already use.
- Not verified: what you see when two Workers share a `namespace_id`. The Configuration section, cited above, says they share counters.
- Not verified: how far a live count can differ from 3.
- Not verified: whether a deploy fails when the plan omits this binding. The `ratelimits` entry is in the file step 1.10 deploys.
- Worked: the command prints `MAGIC_LINK_RATE_LIMIT`, `"namespace_id"` with `"1001"` or the string you wrote, `"limit": 3`, and `"period": 60`.
- If this is wrong you will see: a 429 before the fourth valid request in step 2.20. Four 200 answers are not the whole evidence. They are inconclusive, because the count is per location and eventually consistent. Follow step 2.20's bounded repeat, then its next action, before treating the binding as absent. A missing binding lets every request through, however many you send.

### 2.18 Deploy

Do: Deploy the build from step 2.16. This is the same command as step 1.10. It applies any migration that is not applied yet, then deploys, and it does not build. If the upload fails after the migrations are already applied, run the same command again. From this moment the pages include sign-in and Subscribe. The account routes answer only when `ACCOUNTS` is the exact string `on`.

Run:
```sh
npm run cf:deploy
```

- Source: `package.json:23` has `"cf:deploy": "wrangler d1 migrations apply bridgekit --remote && wrangler deploy"`. `package.json:23` lacks `vite build`.
- Source: `migrations/0001_page_views.sql:2` has `CREATE TABLE page_views`.
- Source: `migrations/0002_auth.sql:2` has `create table "user"`.
- Source: `migrations/0003_workspaces.sql:4` has `CREATE TABLE subscription`.
- Source: `migrations/0004_workspace_limits.sql` adds `CREATE VIEW workspace_seats` and two `BEFORE` triggers on `invitation` that refuse a write with `RAISE(ABORT)`. Applying it changes no row, so `wrangler d1 migrations apply` applies it to a database that already holds workspaces and invitations at or over the limits without touching them; the `BEFORE INSERT` and `BEFORE UPDATE` triggers on `invitation` then refuse only a write that leaves a live pending invitation the workspace has no seat for.
- Not verified: whether a second apply of the same migrations is a no-op.
- Worked: the command ends without an error, and `curl -s -o /dev/null -w '%{http_code}\n' https://pvmbridge.com/pay/` prints 200.

### 2.19 Check what the site offers

Do: Ask the live site what it offers. Send the same sign-in POST as step 1.12.

Run:
```sh
curl -sS https://pvmbridge.com/api/config
curl -sS -w '\n%{http_code}\n' -X POST 'https://pvmbridge.com/api/auth/sign-in/magic-link' \
  -H 'Origin: https://pvmbridge.com' \
  -H 'content-type: application/json' \
  --data '{"email":"review@example.invalid","callbackURL":"https://pvmbridge.com/app/"}'
```

- Source: `server/worker.ts:273-274` has `commentary: Boolean(c.env.ANTHROPIC_API_KEY)`, `billing: Boolean(c.env.PADDLE_API_KEY && c.env.PADDLE_PRICE_ID)`.
- Source: `server/worker.ts:50` has `value === "on"`.
- Source: `server/worker.ts:61` has `CLOSED_CONFIG`.
- Source: `src/app/account.ts:115` has `status: boolean`, `/api/auth/sign-in/magic-link`.
- Not verified: this repo does not contain the body `{"status":true}`. A local Worker with `ACCOUNTS` set to `on` returned that body in the D25 review. The author's session sent this step's two requests to a local Part 2 Worker with `ACCOUNTS` set to `on`. Config had `billing` true. Sign-in returned 200 `{"status":true}`. The reviewer's session ran the same two commands on a local Worker. Config had `billing` true. Sign-in returned 200 `{"status":true}`. Neither session sent the requests to the live domain. The reviewer's session entered no Paddle account. The reviewer's session entered no Cloudflare account. The reviewer's session entered no Resend account. The author's report records no deploy. The author's report records no secret upload.
- Worked: `providers` is empty, `commentary` is false, and `billing` is true. The sign-in status is 200 and the body is `{"status":true}`.
- If `ACCOUNTS` is missing or is any other value, the sign-in status is 404 and the body is `{"error":"Not found."}`. Config still has no providers, `commentary` false, and `billing` false, even when the Paddle secrets are set.

### 2.20 Check that a sign-in email arrives

Do: Open the tool. The Workspace fieldset is already on the page. It is not a panel opened by a button. Ask for a link at your own address.

Open:
```text
https://pvmbridge.com/app/
```

- Source: `src/app/Workspace.tsx:101` has `return <SignIn`.
- Source: `src/app/Workspace.tsx:106-107` has `<fieldset className="team">`, `<legend>Workspace</legend>`.
- Source: `src/app/Workspace.tsx:259` has `Check your email for a sign-in link.`
- Derived from: `server/auth.ts:45` has `baseURL: env.BETTER_AUTH_URL`. `server/auth.ts:46` has `basePath: AUTH_BASE_PATH`. `server/auth.ts:9` has `AUTH_BASE_PATH = "/api/auth"`. The link is built from the base URL and that path. It was not run.
- Source: `server/auth.ts:79` has `expiresIn: 15 * 60`.
- Worked: mail from the address in step 2.6 arrives, its link starts with `https://pvmbridge.com/api/auth/`, and the link signs you in.

Do: Check the sign-in limit from one connection.
Do: Wait until a minute has passed with no successful sign-in from this connection.
Do: Run the three commands below from that same connection.
Do: Time the four valid requests together. A run that takes longer than the 60 second window proves nothing, so discard it and wait out another quiet minute first.
Do: Repeat the timed run up to three times, and stop once the fourth valid request answers 429. Three is this runbook's own bound. Cloudflare documents no guaranteed number of attempts or delay before a count catches up.
Do: Leave `not-an-email` as it is.
Do: In the last command, put your own address in place of `review@example.invalid`.

The counter key is the `cf-connecting-ip` header. A different address on the same connection uses the same count.

Run:
```sh
curl -sS -w '\n%{http_code}\n' -X POST 'https://pvmbridge.com/api/auth/sign-in/magic-link' \
  -H 'Origin: https://pvmbridge.com' \
  -H 'content-type: text/plain' \
  --data '{"email":"not-an-email","callbackURL":"https://pvmbridge.com/app/"}'

for n in 1 2 3; do
  curl -sS -w '\n%{http_code}\n' -X POST 'https://pvmbridge.com/api/auth/sign-in/magic-link' \
    -H 'Origin: https://pvmbridge.com' \
    -H 'content-type: application/json' \
    --data '{"email":"not-an-email","callbackURL":"https://pvmbridge.com/app/"}'
done

for n in 1 2 3 4; do
  curl -sS -w '\n%{http_code}\n' -X POST 'https://pvmbridge.com/api/auth/sign-in/magic-link' \
    -H 'Origin: https://pvmbridge.com' \
    -H 'content-type: application/json' \
    --data '{"email":"review@example.invalid","callbackURL":"https://pvmbridge.com/app/"}'
done
```

- Source: `server/auth.ts:129` has `Content-Type must be application/json.`
- Source: `server/auth.ts:137` has `if (result.issues) return null`.
- Source: `server/auth.ts:33` has `Too many requests. Please try again later.`
- Source: `server/auth.ts:139` has `cf-connecting-ip`.
- Source: `test/rate-limit.test.ts:566` has `{ status: 400, body: LIBRARY_EMAIL }`.
- Source: `test/rate-limit.test.ts:572` has `calls: [{ key: CLIENT, success: true }]`.
- Not verified: that a minute with no successful sign-in clears the counter, and how many attempts a real count needs. Step 2.17 cites the Accuracy section.
- Worked: the `text/plain` request prints 415 and `Content-Type must be application/json.` All three `not-an-email` requests print 400 and send no mail, so they fail validation and do not reach the limit. Once the count has caught up, the four valid requests answer 200, 200, 200, 429 and three emails for your address arrive; a fourth email does not. The pass rests on the whole run, the three 400 answers with no mail and the fourth valid request's 429, not on the first valid request's 200 alone.
- If this is wrong you will see: a 429 before the fourth valid request. Wait out one more quiet minute and send the four valid requests again. All four valid requests answering 200 is inconclusive, not proof that the binding is missing, because the count is per location and eventually consistent. Repeat the timed run as above, then do the next action if it stays inconclusive. If no email arrives for the first valid request, the email check is incomplete. Confirm the address you typed is your own, then recheck the HTTP result, steps 2.4 through 2.6, and mail delivery. A missing first email does not show that the address belongs to someone else.
- Not verified: that the Cloudflare dashboard or a read-only command names a deployed Worker's rate limit binding. The Monitoring section, cited in step 2.17, says rate limiting bindings are not visible in the Cloudflare dashboard, so the dashboard does not settle it. As the next action, run the read-only `npx wrangler versions list`, then `npx wrangler versions view <version-id>` for the deployed version, and look for the `ratelimits` entry. Whether that output names the `ratelimits` binding is not verified. This repo did not run either command.

### 2.21 Check that Subscribe opens the checkout

Do: While signed in, create a workspace and press Subscribe.

Open:
```text
https://pvmbridge.com/app/
```

- Source: `src/app/Workspace.tsx:137-139` has `const { checkoutUrl } = await api.checkout(active, seats);`, `location.href = checkoutUrl;`.
- Source: `server/paddle.ts:332` has `?_ptxn=`.
- Worked: the address bar shows `https://pvmbridge.com/pay/?_ptxn=` followed by an id, and the checkout shows the price you chose.

### 2.22 Check that a payment turns Pro on

Do: Finish one purchase. Open the tool. Load the sample or a file so columns exist. Save a named setup. Reload the same columns. Do not use the thank-you sentence as the check.

Open:
```text
https://pvmbridge.com/app/?sample
```

- Source: `src/app/account.ts:255` has `Pro,`, `"seat"`, `"seats"`.
- Source: `src/app/Workspace.tsx:147` has `props.columns.length > 0`.
- Source: `src/app/Workspace.tsx:160-162` has `props.setup`, `label="Save setup"`.
- Source: `src/app/Workspace.tsx:167` has `api.saveSetup`.
- Source: `src/pay/pay.ts:48` has `/app/?subscribed=1`.
- Source: `server/workspace.ts:325` has `"applied"`.
- Source: `server/workspace.ts:142` has `Saving to a workspace needs a Pro subscription.`
- Worked: the hint reads `Pro,` then the seat count and `seat` or `seats`. Save setup is on the page. After you reload the same columns, the saved name is still listed.

### 2.23 Check that an immediate cancellation reaches the site

Do: Cancel that subscription in Paddle immediately. Wait until Paddle shows the `subscription.canceled` delivery. Query that subscription, not every row.

A cancel at the period end sends `subscription.updated` with status `active`. The webhook reads that subscription from Paddle's list and stores the status Paddle reports there, so the row stays `active` until the effective date. This code does not store `scheduled_change`. Do not expect `canceled` before then.

Dashboard (not verified): Paddle > Customers > the customer > the subscription > Cancel.

Run:
```sh
npx wrangler d1 execute bridgekit --remote --command "SELECT status, currentPeriodEnd FROM subscription WHERE paddleSubscriptionId = '<subscription id>'"
```

- Source: `server/paddle.ts:194` has `status: status as SubscriptionStatus`.
- Source: `server/paddle.ts` lacks `scheduled_change`.
- Source: `server/workspace.ts:401` has `status: elected.status`.
- Source: `server/workspace.ts` lacks `scheduled_change`.
- Source: `server/paddle.ts:297` has `export function hasPro`.
- Source: `server/paddle.ts:303-306` has `case "canceled":`, `now.getTime() < end`.
- Source: `src/app/account.ts:255` has `plan.status === "canceled"`, `currentPeriodEnd`, `ends`, `slice(0, 10)`.
- Source: `migrations/0003_workspaces.sql:6` has `paddleSubscriptionId`.
- Source: `migrations/0003_workspaces.sql:8` has `status TEXT NOT NULL`.
- Source: `migrations/0003_workspaces.sql:11` has `currentPeriodEnd TEXT`.
- Not verified: the dashboard click path. This session did not cancel a subscription.
- Worked: `status` is `canceled` for that id. A `canceled` row keeps Pro until `currentPeriodEnd` when that date is still ahead. The hint appends `, ends YYYY-MM-DD` when status is `canceled` and `currentPeriodEnd` is set.

## What Part 2 leaves untrue

- Source: `index.html:268` has `planned and not available yet`. The Pricing section still says the paid plan is not available yet.
- Source: `index.html:287` has `per user per month, expected`. That expected price is the static sentence on the page. It is not rewritten from the Paddle price you chose.
- Source: `src/app/Workspace.tsx:291` has `/#pricing`. The Subscribe hint links there.
- Source: `wrangler.jsonc:18` has `/assets/*.wasm`. `wrangler.jsonc:18` lacks `/pay`. The pay page is not counted.
- Source: `src/app/account.ts:268` has `Thank you. Pro switches on as soon as Paddle confirms the payment`. `src/app/account.ts:273` has `CHECKOUT_RETURN_MS = 90_000`. `src/app/account.ts:492` has `PRO_ON_SENTENCE : PRO_WAITING_SENTENCE`. The waiting sentence shows before Pro is on, and it stays when that wait ends. That is a code follow-up, not a launch check.

To hide accounts and payments on the pages, run step 1.7 and step 1.10 again. The secrets stay set. The routes stay on while `ACCOUNTS` is `on`. To turn the routes off, remove `"ACCOUNTS": "on"`. Run step 1.10 again. A gated path then returns 404 and `{"error":"Not found."}`, and that return does not call `createAuth`.

## Part 3. Support mail

Support mail does not read `ACCOUNTS`, so it needs Part 1 only. Mail to `support@pvmbridge.com` reaches the Worker's `email` handler, which forwards a copy to the address in `SUPPORT_FORWARD_TO` and stores the message in the D1 table `support_mail`. A daily cron deletes rows older than 90 days.

- Source: `server/worker.ts:471-472` has `email(message: ForwardableEmailMessage`, `receiveSupportMail(message, env)`.
- Source: `server/support.ts:387` has `const forwarded = await forward(message, env.SUPPORT_FORWARD_TO)`.
- Source: `migrations/0007_support_mail.sql:20` has `CREATE TABLE support_mail (`.
- Source: `server/support.ts:7` has `const RETENTION_MS = 90 * 86_400_000`.
- Source: `server/support.ts:406` has `DELETE FROM support_mail WHERE receivedAt < ?`.

### 3.1 Add the forward address as a verified Email Routing destination

Do: Add the inbox that receives the support copies as a destination address. This file writes `owner@example.com` in its place.

Dashboard (not verified): Cloudflare > Compute > Email Service > Email Routing > Destination Addresses.

The address must be verified before the rule can use it. Until a destination is verified, the rule that points at it stays disabled.

- Source: `server/env.ts:15` has `verified Email Routing destination`.
- Source: `.dev.vars.example:18` has `must be a verified Email Routing destination`.
- Not verified: the dashboard path, and the sentence that a rule waits for verification. [Email routing rules and addresses](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/) says a destination must be verified before a rule uses it, and that a rule stays disabled until then.
- Worked: Cloudflare lists the address as verified.

### 3.2 Store the forward address

Do: Store the address from step 3.1. This file writes `owner@example.com` as the placeholder, and the value is the verified destination.

Run:
```sh
npx wrangler secret put SUPPORT_FORWARD_TO
```

- Source: `server/env.ts:15-19` has `verified Email Routing destination`, `SUPPORT_FORWARD_TO?: string`.
- Source: `wrangler.jsonc:59` has `SUPPORT_FORWARD_TO`.
- Source: `.dev.vars.example:19` has `SUPPORT_FORWARD_TO=`.
- Source: `server/support.ts:343` has `await message.forward(to)`.
- Source: `server/support.ts:341` has `if (to === undefined || to === "") return "forward-address-unset"`.
- Source: `server/support.ts:346` has `return "forward"`.
- Source: `server/support.ts:8` has `This message could not be delivered. Please try again later.`
- Source: `server/support.ts:390-392` has `if (skip === null)`, `await store(env.DB, rowOf(message, receivedAt, body))`.
- Source: `server/support.ts:400` has `message.setReject(REJECTION)`.
- Not verified: what `message.forward` does when the address is not a verified destination, and what the sender sees then. The repo only catches the failure. This session sent no mail.
- Worked: `npx wrangler secret list` prints `SUPPORT_FORWARD_TO`. This proves it is set, not that it is a verified destination.
- If this is wrong you will see: the address is missing or empty, so `forward` returns `forward-address-unset`. The row is still stored when a person wrote the message, and the sender gets the bounce sentence. The address is not a verified destination, so `message.forward` throws, `forward` catches it and returns `forward`, and the row and the bounce are the same.

### 3.3 Confirm LOCAL_EMAIL_LOG is not a secret

Do: List the Worker's secrets and count the local flag in the config file.

Run:
```sh
npx wrangler secret list
grep -c '"LOCAL_EMAIL_LOG"' wrangler.jsonc
```

`LOCAL_EMAIL_LOG` is not a secret. It is set only in `.dev.vars` for local work, and production never sets it.

- Source: `server/env.ts:27` has `LOCAL_EMAIL_LOG?: string`.
- Source: `wrangler.jsonc:34-37` has `LOCAL_EMAIL_LOG is a Worker variable`, `This file does not`, `set it`.
- Source: `wrangler.jsonc:56-59` has `wrangler secret put NAME`. `wrangler.jsonc:56-59` lacks `LOCAL_EMAIL_LOG`.
- Worked: the first command prints `BETTER_AUTH_SECRET` and `SUPPORT_FORWARD_TO`, plus the Part 2 names when Part 2 ran, and never `LOCAL_EMAIL_LOG`. The second prints 0.

### 3.4 Apply migration 0007 through the deploy command

Do: Run the deploy command. It applies every migration that is not applied yet, including 0007, and then deploys. It does not build. Step 1.10 already runs this command, so a fresh Part 1 deployment has applied it. This step confirms it.

Run:
```sh
npm run cf:deploy
```

- Source: `package.json:23` has `wrangler d1 migrations apply bridgekit --remote && wrangler deploy`. `package.json:23` lacks `vite build`.
- Source: `wrangler.jsonc:26` has `"migrations_dir": "migrations"`.
- Source: `migrations/0007_support_mail.sql:20` has `CREATE TABLE support_mail (`.
- Source: `migrations/0007_support_mail.sql:33` has `CREATE INDEX support_mail_received`.
- Not verified: the output format of `npx wrangler d1 migrations list`. This session did not run it. Wrangler's own help describes the command as viewing the list of unapplied migration files.
- Worked: `npx wrangler d1 migrations list bridgekit --remote` prints no unapplied migration, so `0007_support_mail` is not in that list.

### 3.5 Create the account's workers.dev subdomain

Do: Create a subdomain for the account. This is the cron trigger's prerequisite. `"workers_dev": false` stays in `wrangler.jsonc`, so the Worker is not served on that subdomain.

The deploy on 2026-10-27 printed Cloudflare error 10063, `You need a workers.dev subdomain in order to proceed`, because the account had no subdomain. The subdomain was then created through the Cloudflare API with `PUT /accounts/<account id>/workers/subdomain`.

Dashboard (not verified): Cloudflare > Workers & Pages > Change next to Your subdomain.

- Source: `wrangler.jsonc:54` has `"workers_dev": false`.
- Not verified: the error text, the API call, and the claim that the Worker stays off workers.dev. [workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/) states that `workers_dev: false` disables the Worker's workers.dev route.
- Worked: the dashboard shows a workers.dev subdomain for the account.

### 3.6 Set the daily cron trigger and confirm it

Do: Apply the trigger in `wrangler.jsonc` to the current deployment.

Run:
```sh
npx wrangler triggers deploy
```

`wrangler.jsonc` already holds the schedule. A deploy replaces the Worker's triggers with the ones in the file. This command applies the trigger changes to the current deployment without a new upload. It was run after a plain `npm run cf:deploy`, and the trigger appeared.

- Source: `wrangler.jsonc:61` has `Once a day at 03:17 UTC`.
- Source: `wrangler.jsonc:62` has `"triggers": { "crons": ["17 3 * * *"] }`.
- Source: `server/worker.ts:475-476` has `async scheduled(controller: ScheduledController`, `purgeSupportMail(env.DB, new Date(controller.scheduledTime))`.
- Source: `server/support.ts:404` has `export async function purgeSupportMail`.
- Source: `server/support.ts:406` has `DELETE FROM support_mail WHERE receivedAt < ?`.
- Source: `server/support.ts:7` has `RETENTION_MS = 90 * 86_400_000`.
- Not verified: the repo does not hold Wrangler's help text or this command's output. `npx wrangler triggers --help` in Wrangler 4.153.0 prints "Apply changes to triggers (Routes or domains and Cron Triggers) when using `wrangler versions upload`", and this session ran no command against the account.
- Not verified: the dashboard path and the past-run checks. [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) names Settings > Triggers > Cron Triggers, Settings > Trigger Events > View events for past runs, and Workers Logs, and says a cron change can take up to 15 minutes to propagate. This session opened none of them.
- Worked: Dashboard > Workers & Pages > bridgekit > Settings > Triggers > Cron Triggers lists `17 3 * * *`.

### 3.7 Switch the Email Routing rule to the Worker

Do: Change the rule for `support@pvmbridge.com` from a forward action to the Worker.

Dashboard (not verified): Cloudflare > Compute > Email Service > Email Routing > Routing Rules > the `support@pvmbridge.com` rule > Edit > Action `Send to a Worker` > `bridgekit`.

- Source: `privacy.html:57` has `A copy goes to our own inbox`.
- Source: `privacy.html:121` has `mailto:support@pvmbridge.com`.
- Source: `wrangler.jsonc` lacks `"addresses"`.
- Derived from [Email routing rules and addresses](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/): a rule's action is one of `Send to an email`, `Send to a Worker`, or `Drop`, and Wrangler leaves Email Routing rules alone when the config has no `addresses` field. Not verified.
- Not verified: the dashboard path.
- Worked: the rule lists `support@pvmbridge.com` with `Send to a Worker` and `bridgekit` as its destination.

### 3.8 Check one message end to end

Do: From an account outside `pvmbridge.com`, send one short plain-text message to `support@pvmbridge.com` with a subject you will recognize. Check both halves. The message arrives at the forward address, and the table holds a row.

Run:
```sh
npx wrangler d1 execute bridgekit --remote --command "SELECT receivedAt, envelopeFrom, envelopeTo, subject, bodyCut FROM support_mail ORDER BY receivedAt DESC LIMIT 5"
```

- Source: `server/support.ts:354` has `INSERT INTO support_mail`.
- Source: `server/support.ts:392` has `const stored = await store(env.DB, rowOf(message, receivedAt, body))`.
- Source: `migrations/0007_support_mail.sql:20-32` has `receivedAt TEXT NOT NULL`, `subject TEXT`, `bodyCut INTEGER NOT NULL`.
- Source: `server/support.ts:18` has `mailer-daemon`, `postmaster`, `noreply`, `no-reply`, `donotreply`.
- Source: `server/support.ts:21-31` has `auto-submitted`, `list-id`, `empty envelope sender`, `automatic sender`, `!== "no"`.
- Source: `server/support.ts:396-398` has `[support] support mail was not handled`, `not stored:`.
- Worked: the message arrives at the forward address. The query prints a row whose `envelopeTo` is `support@pvmbridge.com`, whose `envelopeFrom` is the outside address, whose `subject` is the message's, and whose `bodyCut` is 0.
- If this is wrong you will see: if neither a row nor an inbox copy appears, check the rule in step 3.7 and the Worker logs for forwarding or storage failures. A row without an inbox copy means forwarding failed; check `SUPPORT_FORWARD_TO` (step 3.2), destination verification (step 3.1), and the forwarding failure in the Worker log. The handler calls `message.setReject` with the bounce sentence when forwarding fails. An inbox copy without a row can mean direct forwarding bypassed the Worker, a skip rule matched, or storage failed. Successful skips do not log a reason. Storage failures log `[support] support mail was not handled (store)`. An unreadable body still leaves a row with an empty body and `bodyCut` set to 1 when storage succeeds.

The handler skips storage if a message has an `Auto-Submitted` header whose value, after trimming whitespace and lowercasing, is not `no`, or if it has a `List-Id` header. It also skips storage for an empty or whitespace-only envelope sender, or when the local part of the envelope sender or `From` header address is `mailer-daemon`, `postmaster`, `noreply`, `no-reply` or `donotreply` (case-insensitive). It still attempts to forward each skipped message.

Use a message a person wrote, not an auto-reply or a mailing-list post, because those are forwarded and not stored.

### 3.9 Optional. Roll the rule back to the forward action

Do: To restore direct forwarding if step 3.8 fails, or to stop storing new support mail, edit the same rule. Set the action to `Send to an email` and the destination to the verified address from step 3.1.

Dashboard (not verified): Cloudflare > Compute > Email Service > Email Routing > Routing Rules > the `support@pvmbridge.com` rule > Edit > Action `Send to an email`.

- Source: `migrations/0007_support_mail.sql:1-5` has `Email Routing hands each message to the`, `Worker (server/support.ts)`, `this copy so a reply can be drafted from it`.
- Not verified: the dashboard path.
- Worked: the rule lists `support@pvmbridge.com` with `Send to an email` and the address from step 3.1. Mail no longer reaches the Worker, and no new `support_mail` row appears. Rows already stored are deleted by the next successful daily cron run after they become more than 90 days old.

## Checking this file

A path in backticks, then `has` or `lacks`, then words in backticks, is a claim about this repo. Every claim can be checked with `node scripts/check-deploy-doc.mjs`.

1. Read the cited lines. Join them with spaces. Treat a run of whitespace as one space.
2. For `has`, every quoted run is in that span. For `lacks`, it is not. With no line number, `lacks` means the whole file.
3. A `lacks` claim on a line span also has an anchor in that same span.
4. `Not verified` has nothing to check in the repo.
5. `BETTER_AUTH_URL` is the Part 1 value in `wrangler.jsonc`, which step 1.5 confirms. `ACCOUNTS` is the Part 2 edit to `wrangler.jsonc` `vars`, and the value is `on`. Every other string name in `server/env.ts` is one `npx wrangler secret put` line with that name, or one leave-unset line. `SUPPORT_FORWARD_TO` is the secret-put line in step 3.2. `LOCAL_EMAIL_LOG` is the local-only Worker variable that step 2.6a sets in `.dev.vars`.
6. The nine event names in step 2.11 are the names at `server/paddle.ts:89-97`.
7. `package.json:16-17` has `smoke:preview`, `smoke:wrangler`.
