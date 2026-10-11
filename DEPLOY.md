# Deploy Bridgekit

Part 1 puts the free tool on `<domain>` with page counts. It stands alone. Part 2 turns on accounts and payments. Part 1 is one sitting. Step 1.2 is the only wait in that sitting.

Write the site host for `<domain>`, the database id from step 1.3 for `<id>`, and the client token from step 2.14 for `<client-token>`. This file has no real value for any of them. Do not put a secret in a file or on a command line. `wrangler secret put` asks for it.

Each step uses the same lines. `Do` says what to do. One of `Run`, `Edit`, `Open`, or `Dashboard (not verified)` says where. `Source` names a file and a line, and the words on that line. `Derived from` means those lines support the step and do not state it. When a derived command was not run, the line says so. `Not verified` means the repo is silent. `Worked` says what you see before the next step. When that check shows a value is set and not that it is right, the next line says what a wrong value looks like later.

Run every command from the repo root.

## Part 1. The free tool and page counts

### 1.1 Install the tools and sign in to Cloudflare

Do: Use Node 24, install the packages, and sign Wrangler in to the Cloudflare account that will own the site.

Run:
```sh
npm ci
wrangler login
```

- Source: `.github/workflows/ci.yml:12` has `node-version: 24`.
- Source: `.github/workflows/ci.yml:14` has `npm ci`.
- Source: `package.json:41` has `"wrangler": "^4.147.0"`.
- Worked: `wrangler whoami` prints the account you mean to use.

### 1.2 Put the domain on Cloudflare

Do: Add `<domain>` to that account. At your registrar, set the two name servers Cloudflare gives you.

Dashboard (not verified): Cloudflare > Account Home > Add a domain.

- Not verified: the repo names no domain, no zone, and no route.
- Source: `wrangler.jsonc:1-38` has `"name": "bridgekit"`. `wrangler.jsonc:1-38` lacks `"routes"`.
- Worked: `dig +short NS <domain>` prints two names that end in `ns.cloudflare.com`. The name servers may not show yet. Steps 1.3 through 1.9 do not wait. Step 1.10 does.

### 1.3 Create the database

Do: Create the D1 database and copy the id it prints. If Wrangler offers to write that id into the config file, refuse. Step 1.4 writes it.

Run:
```sh
wrangler d1 create bridgekit
```

- Source: `wrangler.jsonc:24` has `wrangler d1 create bridgekit`.
- Source: `wrangler.jsonc:23` has `"database_name": "bridgekit"`.
- Not verified: whether this version of Wrangler offers to edit the config file.
- Worked: `wrangler d1 list` shows a database named `bridgekit`.

### 1.4 Put the database id in wrangler.jsonc

Do: Replace the row of zeros on the database id line with the id from step 1.3.

Edit: `wrangler.jsonc:25`
```text
      "database_id": "<id>",
```

- Source: `wrangler.jsonc:25` has `"database_id"`.
- Worked: `grep -c 00000000-0000 wrangler.jsonc` prints 0, and `grep -c database_id wrangler.jsonc` prints 1.

### 1.5 Set the site address

Do: Set `BETTER_AUTH_URL` to `https://<domain>` with no path and no trailing slash. Do not edit this line in Part 2.

Edit: `wrangler.jsonc:32`
```text
    "BETTER_AUTH_URL": "https://<domain>",
```

- Source: `wrangler.jsonc:32` has `"BETTER_AUTH_URL"`.
- Source: `wrangler.jsonc:31` has `Replaced with the real address in production.`
- Source: `server/auth.ts:19` has `trustedOrigins: [env.BETTER_AUTH_URL]`.
- Source: `server/auth.ts:53` has `${env.BETTER_AUTH_URL}/app/?invitation=${id}`.
- Source: `server/env.ts:8` has `BETTER_AUTH_URL: string`.
- Worked: `grep -n BETTER_AUTH_URL wrangler.jsonc` prints one line, and that line contains `"BETTER_AUTH_URL": "https://<domain>"`.

### 1.6 Build the free site

Do: Build with page counts on, workspaces off, and AI commentary off. Do not run `npm run build:cloudflare`. Do not run `npm run build`.

Run:
```sh
VITE_PAGE_COUNTS=1 VITE_WORKSPACES=0 VITE_AI_COMMENTARY=0 npx vite build && node scripts/compress-wasm.mjs
```

- Derived from: `package.json:17` has `VITE_PAGE_COUNTS=1 VITE_WORKSPACES=1 VITE_AI_COMMENTARY=1 vite build && node scripts/compress-wasm.mjs`. The command above keeps page counts and sets the other two flags to 0. No npm script builds that combination. It was not run.
- Source: `wrangler.jsonc:2` has `npm run build:cloudflare`. That line tells you to run the script in `package.json`, and that script turns AI commentary on. This step does not follow that line.
- Source: `package.json:9` has `"build": "vite build"`.
- Derived from: `index.html:231` has `No analytics.`, `No tracking scripts.`. `scripts/feature-blocks.ts:4` has `kept only when it applies`. `npm run build` does not set `VITE_PAGE_COUNTS`, so the home page would keep `No analytics.` while the server counts page loads. It was not run.
- Source: `vite.config.ts:60` has `VITE_PAGE_COUNTS === "1"`.
- Source: `vite.config.ts:75` has `VITE_WORKSPACES === "1"`, `pay/index.html`.
- Source: `scripts/compress-wasm.mjs:30` has `rmSync(file)`.
- Source: `index.html:231` has `No cookies, no accounts.`, `No cookies or accounts unless you sign in for Pro.`
- Worked: `ls dist/pay` fails, `ls dist/assets | grep -c '\.wasm$'` prints 0, `grep -c 'No tracking scripts.' dist/index.html` prints 1, `grep -c 'No cookies, no accounts.' dist/index.html` prints 1, and `grep -c 'sign in for Pro' dist/index.html` prints 0.

### 1.7 Store the one secret Part 1 needs

Do: Store a random string of at least 32 characters as `BETTER_AUTH_SECRET`. `openssl rand -base64 32` prints one. Paste it when Wrangler asks. If Wrangler reports that the Worker does not exist, run the deploy command in step 1.9, run this put again, and run that deploy command again.

Run:
```sh
wrangler secret put BETTER_AUTH_SECRET
```

- Source: `server/env.ts:9` has `BETTER_AUTH_SECRET: string`.
- Source: `.dev.vars.example:3` has `at-least-32-chars`.
- Source: `wrangler.jsonc:34` has `wrangler secret put NAME`.
- Not verified: the repo does not say whether a secret put before the first deploy finds a Worker, or which words Wrangler uses when it does not.
- Worked: `wrangler secret list` prints `BETTER_AUTH_SECRET`.

### 1.8 Confirm no other name is set

Do: Confirm the Worker lists only `BETTER_AUTH_SECRET`. In this part, leave unset `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `EMAIL_FROM`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`, `PADDLE_PRICE_ID`, and `PADDLE_ENVIRONMENT`. Also confirm the shell has no `VITE_` variable and the repo has no env file except `.env.example`.

Run:
```sh
wrangler secret list
env | grep '^VITE_'
ls .env*
```

- Source: `.env.example:4` has `VITE_AI_COMMENTARY=1`.
- Source: `README.md:95` has `.env.local`.
- Derived from: `vite.config.ts:53` has `loadEnv(mode, import.meta.dirname, "")`. A `VITE_` value in the shell or in an env file would change the build in step 1.6. It was not run.
- Worked: the first command prints `BETTER_AUTH_SECRET` and no other name from `server/env.ts`, the second command prints nothing, and the third command prints only `.env.example`.

### 1.9 Deploy

Do: Deploy the build from step 1.6. This command applies the remote migrations and then deploys. It does not build. If the upload fails after the migrations are already applied, run the same command again. If step 1.7 already ran this command twice, stop. You are done with this step.

Run:
```sh
npm run cf:deploy
```

- Source: `package.json:19` has `"cf:deploy": "wrangler d1 migrations apply bridgekit --remote && wrangler deploy"`. `package.json:19` lacks `vite build`.
- Source: `wrangler.jsonc:26` has `"migrations_dir": "migrations"`.
- Source: `migrations/0001_page_views.sql:2` has `CREATE TABLE page_views`.
- Source: `migrations/0002_auth.sql:2` has `create table "user"`.
- Source: `migrations/0003_workspaces.sql:4` has `CREATE TABLE subscription`.
- Not verified: whether a second apply of the same migrations is a no-op.
- Worked: the command ends without an error, and `wrangler deployments list` shows a deployment from this run.

### 1.10 Put the Worker on the domain

Do: Add `<domain>` as a custom domain on the Worker named `bridgekit`. Wait until step 1.2 has finished.

Dashboard (not verified): Cloudflare > Workers & Pages > bridgekit > Settings > Domains & Routes > Add > Custom Domain.

- Not verified: the repo does not name this dashboard screen.
- Source: `wrangler.jsonc:6` has `"name": "bridgekit"`. `wrangler.jsonc:1-38` has `"name": "bridgekit"`. `wrangler.jsonc:1-38` lacks `custom_domain`.
- Worked: `curl -sI https://<domain>/ | head -n 1` prints a status line with 200.

### 1.11 Check what the site offers

Do: Ask the live site what it offers.

Run:
```sh
curl -s https://<domain>/api/config
```

- Source: `server/worker.ts:78-79` has `c.env.MICROSOFT_CLIENT_ID ? ["microsoft"]`, `c.env.GOOGLE_CLIENT_ID ? ["google"]`.
- Source: `server/worker.ts:81-82` has `commentary: Boolean(c.env.ANTHROPIC_API_KEY)`, `billing: Boolean(c.env.PADDLE_API_KEY && c.env.PADDLE_PRICE_ID)`.
- Worked: `providers` is empty, `commentary` is false, and `billing` is false.

### 1.12 Check the home page and the pay address

Do: Read the live home page, and request the pay address.

Run:
```sh
curl -s https://<domain>/ | grep -c 'No tracking scripts.'
curl -s https://<domain>/ | grep -c 'sign in for Pro'
curl -s -o /dev/null -w '%{http_code}\n' https://<domain>/pay/
```

- Source: `index.html:231` has `No tracking scripts.`, `No cookies or accounts unless you sign in for Pro.`
- Derived from: `vite.config.ts:75` has `pay/index.html`. `wrangler.jsonc:13` has `"not_found_handling": "404-page"`. The Part 1 build has no pay page, so the address is not found. It was not run.
- Worked: the three commands print 1, then 0, then 404.

### 1.13 Check the tool

Do: Open the tool with the sample data.

Open:
```text
https://<domain>/app/?sample
```

- Source: `README.md:61` has `/app/?sample`.
- Source: `wrangler.jsonc:18` has `/assets/*.wasm`.
- Source: `server/assets.ts:6` has `removes the original`.
- Worked: the sample bridge appears, with its chart and its table.

### 1.14 Check that page loads are counted

Do: Open the home page in a browser, then print the counts. A request from `curl` is not counted.

Open:
```text
https://<domain>/
```

- Source: `server/counts.ts:11` has `headless|curl|wget`.
- Source: `server/worker.ts:168` has `countPageView(`.
- Source: `package.json:20` has `SELECT day, path, referrer, views FROM page_views`.
- Worked: `npm run stats` prints a row whose path is `/`.

### 1.15 Optional. Run the smoke test against the live site

Do: Run the smoke test against the live site. It needs Chromium on this machine.

Run:
```sh
npm run smoke -- https://<domain>
```

- Source: `package.json:14` has `"smoke": "node scripts/smoke.mjs"`.
- Source: `scripts/smoke.mjs:7` has `process.argv[2] ?? "http://localhost:5173"`.
- Source: `scripts/smoke.mjs:159` has `smoke test passed`.
- Source: `README.md:144` has `npm run smoke -- http://localhost:8790`.
- Not verified: that this passes against a deployed site. The repo shows it against a local server.
- Worked: the last line is `smoke test passed`.

## What Part 1 leaves reachable

The pages from step 1.6 do not link to these routes. The Worker still mounts them. Do not add a route list, and do not block the routes.

- Source: `server/worker.ts:52` has `"/api/auth/*"`.
- Source: `server/worker.ts:45` has `"/api/workspaces/*"`.
- Derived from: `src/app/App.tsx:28` has `elsewhere the code is left out`. `src/app/App.tsx:29` has `import.meta.env.VITE_WORKSPACES === "1"`. The Part 1 build sets that flag to 0, so the pages do not link to those routes. It was not run.
- Source: `server/email.ts:5-6` has `!env.RESEND_API_KEY || !env.EMAIL_FROM`, `[email] to`. With both unset, a magic link asked for by hand is written to the Worker log and sent to nobody.
- Source: `server/worker.ts:116` has `Subscriptions are not set up yet.`

## Part 2. Accounts and payments

You need a Resend account and a Paddle account that can take live payments. The server is set before the pages that show sign-in and Subscribe. Those pages ship in step 2.16.

### 2.1 Decide on Workers Paid

Do: Decide whether this Cloudflare account moves to the paid Workers plan before sign-in goes live.

Dashboard (not verified): Cloudflare > Workers & Pages > Plans.

- Not verified: the repo names no Workers plan. It does not say the free plan is enough for sign-in.
- Source: `scripts/compress-wasm.mjs:1` has `25 MiB`.
- Source: `server/worker.ts:37-38` has `app.use("/api/*"`, `createAuth(c.env`.
- Worked: the dashboard shows the plan you decided on.

### 2.2 Confirm the site address

Do: Confirm `BETTER_AUTH_URL` is still `https://<domain>`, with no path and no trailing slash. The host is the host you will use in step 2.8. Do not edit the line.

Run:
```sh
grep -n BETTER_AUTH_URL wrangler.jsonc
```

- Source: `wrangler.jsonc:32` has `"BETTER_AUTH_URL"`.
- Source: `server/auth.ts:19` has `trustedOrigins: [env.BETTER_AUTH_URL]`.
- Source: `server/worker.ts:46-47` has `new URL(c.env.BETTER_AUTH_URL).origin`, `Requests must come from this site.`
- Source: `server/auth.ts:53` has `${env.BETTER_AUTH_URL}/app/?invitation=${id}`.
- Not verified: what the sign-in routes answer when the address is outside `trustedOrigins`. That code is not in this repo.
- Worked: the printed line contains `"BETTER_AUTH_URL": "https://<domain>"`. This proves it is set, not that it is right.
- If this is wrong you will see: trustedOrigins is this address. Saving, deleting, and Subscribe answer `Requests must come from this site.` An invitation link is this address joined to `/app/?invitation=`, and a trailing slash puts a second slash before `app`.

### 2.3 Verify a sending domain in Resend

Do: Add the domain you will send sign-in mail from, and add the DNS records Resend lists. Those records go in Cloudflare after step 1.2.

Dashboard (not verified): Resend > Domains > Add Domain.

- Not verified: that Resend refuses an unverified sender. This repo does not check the domain.
- Source: `server/email.ts:12` has `from: env.EMAIL_FROM`.
- Worked: Resend lists the domain as verified. Later steps do not wait for that. Step 2.18 does.

### 2.4 Store the Resend API key

Do: Create an API key that can send mail, and store it.

Dashboard (not verified): Resend > API Keys > Create API Key.
```sh
wrangler secret put RESEND_API_KEY
```

- Source: `server/env.ts:12` has `RESEND_API_KEY?: string`.
- Source: `server/email.ts:9-11` has `https://api.resend.com/emails`, `Bearer ${env.RESEND_API_KEY}`.
- Worked: `wrangler secret list` prints `RESEND_API_KEY`.

### 2.5 Store the sender address

Do: Store the From address on the domain from step 2.3. Set this and `RESEND_API_KEY` as a pair.

Run:
```sh
wrangler secret put EMAIL_FROM
```

- Source: `server/env.ts:13` has `EMAIL_FROM?: string`.
- Source: `server/email.ts:5-6` has `!env.RESEND_API_KEY || !env.EMAIL_FROM`, `[email] to`.
- Source: `src/app/Workspace.tsx:218` has `Check your email for a sign-in link.`
- Source: `src/app/account.ts:65` has `if (!response.ok) throw new Error`.
- Worked: `wrangler secret list` prints `EMAIL_FROM` and `RESEND_API_KEY`. This proves it is set, not that it is right.
- If this is wrong you will see: only one of the pair is set. The panel says `Check your email for a sign-in link.` No mail arrives. The Worker log contains `[email] to`.

### 2.6 Create the product in Paddle

Do: Create one product for Pro.

Dashboard (not verified): Paddle > Catalog > Products > New product.

- Not verified: the repo names no Paddle product. Checkout sends a price id.
- Source: `server/paddle.ts:198` has `price_id: options.priceId`.
- Worked: the product is in the Paddle catalog.

### 2.7 Create the per-seat price and store its id

Do: Add one monthly per-seat price to that product, at the price you chose. Set the maximum quantity to at least 200. Store the id of the price, not the id of the product.

Dashboard (not verified): Paddle > Catalog > Products > the product > New price.
```sh
wrangler secret put PADDLE_PRICE_ID
```

- Source: `server/env.ts:20` has `PADDLE_PRICE_ID?: string`.
- Source: `server/paddle.ts:198` has `quantity: options.seats`.
- Source: `src/app/Workspace.tsx:252` has `max={200}`.
- Source: `index.html:281` has `per user per month`.
- Source: `server/worker.ts:133-135` has `c.env.PADDLE_PRICE_ID ? [c.env.PADDLE_PRICE_ID] : undefined`, `"ignored"`.
- Not verified: Paddle's default quantity limit for a price.
- Worked: `wrangler secret list` prints `PADDLE_PRICE_ID`.

### 2.8 Point the default payment link at the pay page

Do: Set the default payment link to `https://<domain>/pay/` with the final slash. Use the same host as `BETTER_AUTH_URL` from step 1.5.

Dashboard (not verified): Paddle > Checkout > Checkout settings > Default payment link.
```text
https://<domain>/pay/
```

- Derived from: `server/paddle.ts:188-189` has `default payment link`, `?_ptxn=`. `vite.config.ts:75` has `pay/index.html`. `README.md:134-135` has `Checkout opens on`, `/pay/`. The code names no path for that link. `/pay/` is the page built to load Paddle's script. It was not run.
- Source: `scripts/policy.ts:10` has `script-src 'self' 'wasm-unsafe-eval'`.
- Source: `scripts/policy.ts:25` has `https://cdn.paddle.com`.
- Source: `src/app/Workspace.tsx:112` has `location.href = (await api.checkout(active, seats)).checkoutUrl`.
- Source: `src/pay/pay.ts:20` has `successUrl`, `/app/?subscribed=1`.
- Source: `src/app/Workspace.tsx:56` has `if (!signedIn) return`.
- Not verified: that a session cookie set on one host is absent on another host. That is the browser, not this repo.
- Worked: Paddle shows the saved link. This proves it is set, not that it is right.
- If this is wrong you will see: the payment link is not on `/pay/`. Subscribe opens another page of the site with `?_ptxn=` in the address. No checkout appears, and nothing reports an error.
- If this is wrong you will see: the success URL is the pay page host plus `/app/?subscribed=1`. On another host the buyer is signed out, `if (!signedIn) return` runs, and the thank-you line does not.

### 2.9 Get the website approved

Do: Ask Paddle to approve `<domain>`.

Dashboard (not verified): Paddle > Checkout > Website approval.

- Source: `server/paddle.ts:190` has `domain approved in Paddle (Website approval)`.
- Source: `server/paddle.ts:219` has `Check the default payment link is set and approved.`
- Not verified: how long approval takes, and what Paddle asks for.
- Worked: Paddle lists `<domain>` as approved. Later steps do not wait for that. Step 2.19 does.

### 2.10 Add the webhook and its nine events

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
https://<domain>/api/paddle/webhook
```

- Source: `server/worker.ts:128` has `"/api/paddle/webhook"`.
- Source: `server/paddle.ts:77-85` has `subscription.created`, `subscription.activated`, `subscription.updated`, `subscription.trialing`, `subscription.past_due`, `subscription.paused`, `subscription.resumed`, `subscription.canceled`, `subscription.imported`.
- Source: `server/paddle.ts:112` has `!SUBSCRIPTION_EVENTS.includes(body.event_type)) return null`.
- Source: `server/paddle.ts:156-159` has `case "active":`, `return true`.
- Source: `server/paddle.ts:160-163` has `case "canceled":`, `now.getTime() < end`.
- Source: `server/workspace.ts:32` has `if (!row) return { pro: false`.
- Source: `src/app/Workspace.tsx:249` has `Saving needs Pro`.
- Worked: Paddle shows the destination and those nine events. This proves it is set, not that it is right.
- If this is wrong you will see: a missing webhook event fails nothing. A workspace that paid still shows `Saving needs Pro`, or a canceled one keeps Pro, because that event never arrives.

### 2.11 Store the webhook secret

Do: Copy the destination's secret key and store it.

Dashboard (not verified): Paddle > Developer Tools > Notifications > the destination > Secret key.
```sh
wrangler secret put PADDLE_WEBHOOK_SECRET
```

- Source: `server/env.ts:19` has `PADDLE_WEBHOOK_SECRET?: string`.
- Source: `server/worker.ts:130-131` has `!c.env.PADDLE_WEBHOOK_SECRET`, `Bad signature.`
- Worked: `wrangler secret list` prints `PADDLE_WEBHOOK_SECRET`.

### 2.12 Store the Paddle API key

Do: Create a live API key and store it.

Dashboard (not verified): Paddle > Developer Tools > Authentication > API keys.
```sh
wrangler secret put PADDLE_API_KEY
```

- Source: `server/env.ts:18` has `PADDLE_API_KEY?: string`.
- Source: `server/worker.ts:116` has `Subscriptions are not set up yet.`
- Source: `server/paddle.ts:213` has `Paddle returned`.
- Source: `server/worker.ts:70-71` has `console.error(error)`, `Something went wrong on the server.`
- Worked: `wrangler secret list` prints `PADDLE_API_KEY`.

### 2.13 Store the Worker Paddle switch

Do: Store `live` as `PADDLE_ENVIRONMENT`. Type the lower-case word `live` and nothing else. Do not add this name under `vars`. The secrets comment omits it. A vars line would shift that comment. The Worker reads the name and treats only `live` as live.

Run:
```sh
wrangler secret put PADDLE_ENVIRONMENT
```

- Source: `server/env.ts:22` has `PADDLE_ENVIRONMENT?: string`.
- Source: `server/env.ts:21` has `"sandbox" (default) or "live"`.
- Source: `wrangler.jsonc:34-37` has `wrangler secret put NAME`. `wrangler.jsonc:34-37` lacks `PADDLE_ENVIRONMENT`.
- Source: `.dev.vars.example:11` has `Worker switch`, `VITE_PADDLE_ENVIRONMENT`.
- Source: `server/worker.ts:120` has `c.env.PADDLE_ENVIRONMENT === "live" ? "live" : "sandbox"`.
- Source: `server/paddle.ts:19-20` has `https://sandbox-api.paddle.com`, `https://api.paddle.com`.
- Derived from: `server/paddle.ts:204` has `PADDLE_API[options.environment]`. Any value other than `live` sends the key from step 2.12 to the sandbox host. It was not run.
- Worked: `wrangler secret list` prints `PADDLE_ENVIRONMENT`. This proves it is set, not that it is right.
- If this is wrong you will see: the Worker switch is not `live`. Subscribe shows `Something went wrong on the server.` The request goes to `https://sandbox-api.paddle.com`.

### 2.14 Create the client-side token

Do: Create a live client-side token and keep it for step 2.15. The build writes it into the page. Do not store it with `wrangler secret put`.

Dashboard (not verified): Paddle > Developer Tools > Authentication > Client-side tokens.

- Source: `src/pay/pay.ts:10` has `import.meta.env.VITE_PADDLE_CLIENT_TOKEN`.
- Worked: Paddle lists the token.

## Names that stay unset

The Part 2 build keeps `VITE_AI_COMMENTARY` at 0, so the commentary button stays hidden, and `ANTHROPIC_API_KEY` stays unset. `src/app/Results.tsx:211` has `import.meta.env.VITE_AI_COMMENTARY === "1"`. `server/worker.ts:142` has `if (!c.env.ANTHROPIC_API_KEY) return false`.

- Leave unset: `ANTHROPIC_API_KEY`

Microsoft and Google stay unset. A client id alone would add that provider to the sign-in button, and registration runs only when both the id and the secret are set. `server/worker.ts:78-79` has `c.env.MICROSOFT_CLIENT_ID ? ["microsoft"]`, `c.env.GOOGLE_CLIENT_ID ? ["google"]`. `server/auth.ts:23` has `env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET`. `server/auth.ts:26` has `env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET`.

- Leave unset: `MICROSOFT_CLIENT_ID`
- Leave unset: `MICROSOFT_CLIENT_SECRET`
- Leave unset: `GOOGLE_CLIENT_ID`
- Leave unset: `GOOGLE_CLIENT_SECRET`

### 2.15 Build with accounts and payments

Do: Build with page counts, workspaces, and the two Paddle variables. Leave AI commentary off. Do not change this command.

Run:
```sh
VITE_PAGE_COUNTS=1 VITE_WORKSPACES=1 VITE_AI_COMMENTARY=0 VITE_PADDLE_CLIENT_TOKEN=<client-token> VITE_PADDLE_ENVIRONMENT=live npx vite build && node scripts/compress-wasm.mjs
```

- Derived from: `package.json:17` has `VITE_PAGE_COUNTS=1 VITE_WORKSPACES=1 VITE_AI_COMMENTARY=1 vite build && node scripts/compress-wasm.mjs`. `package.json:17` has `VITE_AI_COMMENTARY=1`. `package.json:17` lacks `VITE_PADDLE`. The command above sets AI commentary to 0 and adds the two Paddle variables. No npm script sets those variables. It was not run.
- Source: `src/pay/pay.ts:10` has `import.meta.env.VITE_PADDLE_CLIENT_TOKEN`.
- Source: `src/pay/pay.ts:13` has `There is no checkout to open. Start from the Workspace panel in the tool.`
- Source: `src/pay/pay.ts:19` has `VITE_PADDLE_ENVIRONMENT !== "live"`.
- Source: `src/app/App.tsx:29` has `import.meta.env.VITE_WORKSPACES === "1"`.
- Source: `index.html:231` has `No cookies or accounts unless you sign in for Pro.`
- Worked: `test -f dist/pay/index.html` succeeds, `grep -R -l '<client-token>' dist` prints a path, `grep -c 'sign in for Pro' dist/index.html` prints 1, `grep -c 'No tracking scripts.' dist/index.html` prints 1, and `ls dist/assets | grep -c '\.wasm$'` prints 0.

### 2.16 Deploy

Do: Deploy the build from step 2.15. This is the same command as step 1.9. It applies any migration that is not applied yet, then deploys, and it does not build. If the upload fails after the migrations are already applied, run the same command again. From this moment the pages show sign-in and Subscribe.

Run:
```sh
npm run cf:deploy
```

- Source: `package.json:19` has `"cf:deploy": "wrangler d1 migrations apply bridgekit --remote && wrangler deploy"`. `package.json:19` lacks `vite build`.
- Source: `migrations/0001_page_views.sql:2` has `CREATE TABLE page_views`.
- Source: `migrations/0002_auth.sql:2` has `create table "user"`.
- Source: `migrations/0003_workspaces.sql:4` has `CREATE TABLE subscription`.
- Not verified: whether a second apply of the same migrations is a no-op.
- Worked: the command ends without an error, and `curl -s -o /dev/null -w '%{http_code}\n' https://<domain>/pay/` prints 200.

### 2.17 Check what the site offers

Do: Ask the live site what it offers.

Run:
```sh
curl -s https://<domain>/api/config
```

- Source: `server/worker.ts:81-82` has `commentary: Boolean(c.env.ANTHROPIC_API_KEY)`, `billing: Boolean(c.env.PADDLE_API_KEY && c.env.PADDLE_PRICE_ID)`.
- Worked: `providers` is empty, `commentary` is false, and `billing` is true.

### 2.18 Check that a sign-in email arrives

Do: Open the tool, open the Workspace panel, and ask for a link at your own address.

Open:
```text
https://<domain>/app/
```

- Source: `src/app/Workspace.tsx:218` has `Check your email for a sign-in link.`
- Derived from: `server/auth.ts:16-17` has `baseURL: env.BETTER_AUTH_URL`, `basePath: "/api/auth"`. The link is built from those two. It was not run.
- Source: `server/auth.ts:40` has `expiresIn: 15 * 60`.
- Worked: mail from the address in step 2.5 arrives, its link starts with `https://<domain>/api/auth/`, and the link signs you in.

### 2.19 Check that Subscribe opens the checkout

Do: While signed in, create a workspace and press Subscribe.

Open:
```text
https://<domain>/app/
```

- Source: `src/app/Workspace.tsx:112` has `location.href = (await api.checkout(active, seats)).checkoutUrl`.
- Source: `server/paddle.ts:188-189` has `?_ptxn=`.
- Worked: the address bar shows `https://<domain>/pay/?_ptxn=` followed by an id, and the checkout shows the price you chose.

### 2.20 Check that a payment turns Pro on

Do: Finish one purchase, and return to the tool.

Open:
```text
https://<domain>/app/
```

- Source: `src/pay/pay.ts:20` has `/app/?subscribed=1`.
- Source: `src/app/Workspace.tsx:68` has `Thank you. Pro switches on as soon as Paddle confirms the payment`.
- Source: `server/workspace.ts:207` has `"applied"`.
- Source: `server/workspace.ts:49` has `Saving to a workspace needs a Pro subscription.`
- Worked: the page shows `Thank you. Pro switches on as soon as Paddle confirms the payment`. Paddle's delivery log shows 200. After a reload, saving a setup works.

### 2.21 Check that a cancellation reaches the site

Do: Cancel that subscription in Paddle.

Dashboard (not verified): Paddle > Customers > the customer > the subscription > Cancel.

- Source: `server/paddle.ts:160-163` has `case "canceled":`, `now.getTime() < end`.
- Worked: `wrangler d1 execute bridgekit --remote --command "SELECT status FROM subscription"` prints `canceled`.

## What Part 2 leaves untrue

- Source: `index.html:262` has `planned and not available yet`. The Pricing section still says the paid plan is not available yet.
- Source: `src/app/Workspace.tsx:249` has `/#pricing`. The Subscribe hint links there.
- Source: `wrangler.jsonc:18` has `/assets/*.wasm`. `wrangler.jsonc:18` lacks `/pay`. The pay page is not counted.

To remove accounts and payments from the pages, run step 1.6 and step 1.9 again. The secrets stay set. The pages no longer lead to them.

## Checking this file

A path in backticks, then `has` or `lacks`, then words in backticks, is a claim about this repo.

1. Read the cited lines. Join them with spaces. Treat a run of whitespace as one space.
2. For `has`, every quoted run is in that span. For `lacks`, it is not. With no line number, `lacks` means the whole file.
3. A `lacks` claim on a line span also has an anchor in that same span.
4. `Not verified` has nothing to check in the repo.
5. `BETTER_AUTH_URL` is the edit to `wrangler.jsonc`. Every other string name in `server/env.ts` is one line `wrangler secret put` with that name, or one leave-unset line.
6. The nine event names in step 2.10 are the names at `server/paddle.ts:77-85`.
7. `package.json` lacks `smoke:preview`. `package.json` lacks `smoke:wrangler`.
