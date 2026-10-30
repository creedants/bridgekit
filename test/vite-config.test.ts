import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { test } from "node:test";
import config from "../vite.config.ts";

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
type ConfigEnv = { command: "build" | "serve"; mode: string };
type PluginShape = { name: string; apply?: string; configureServer?: (server: FakeServer) => void };
type FakeServer = {
  middlewares: { use(path: string, handler: Handler): void };
  ssrLoadModule(path: string): Promise<{ handleCommentary: (request: Request) => Promise<Response> }>;
};

function build(env: ConfigEnv) {
  return (config as unknown as (env: ConfigEnv) => { plugins: PluginShape[] })(env);
}

function withEnv(values: Record<string, string | undefined>, run: () => void) {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function buildWarnings(env: Record<string, string | undefined>): string[] {
  const original = console.warn;
  const lines: string[] = [];
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    withEnv(env, () => build({ command: "build", mode: "production" }));
  } finally {
    console.warn = original;
  }
  return lines.filter((line) => line.includes("VITE_PADDLE_CLIENT_TOKEN"));
}

test("a workspaces build warns once when VITE_PADDLE_CLIENT_TOKEN is unset; a build with the token or without workspaces stays quiet", () => {
  const unset = buildWarnings({ VITE_WORKSPACES: "1", VITE_PADDLE_CLIENT_TOKEN: "" });
  assert.equal(unset.length, 1, `expected one warning, got ${JSON.stringify(unset)}`);
  assert.match(unset[0], /VITE_PADDLE_CLIENT_TOKEN/);
  assert.match(unset[0], /checkout will not load/);
  assert.deepEqual(buildWarnings({ VITE_WORKSPACES: "1", VITE_PADDLE_CLIENT_TOKEN: "dummy-value" }), []);
  assert.deepEqual(buildWarnings({ VITE_WORKSPACES: undefined, VITE_PADDLE_CLIENT_TOKEN: undefined }), []);
});

async function callRoute(
  handler: Handler,
  origin: string | undefined,
): Promise<{ status: number; body: string }> {
  const req = Readable.from([Buffer.from("not json")]) as unknown as IncomingMessage;
  req.method = "POST";
  req.url = "/api/commentary";
  req.headers = { host: "localhost:5173", "content-type": "text/plain" };
  if (origin !== undefined) req.headers.origin = origin;
  const result = { status: 0, body: "" };
  const res = {
    writeHead(status: number) {
      result.status = status;
    },
    end(body?: string) {
      result.body = body ?? "";
    },
  } as unknown as ServerResponse;
  await handler(req, res);
  return result;
}

const refusal = JSON.stringify({ error: "Requests must come from this site." });

function mountCommentaryRoute(): { handler: Handler; seen: string[] } {
  const mounted: Handler[] = [];
  const seen: string[] = [];
  const server: FakeServer = {
    middlewares: {
      use(path, handler) {
        assert.equal(path, "/api/commentary");
        mounted.push(handler);
      },
    },
    async ssrLoadModule(path) {
      assert.equal(path, "/server/commentary.ts");
      return {
        handleCommentary: async (request) => {
          seen.push(await request.text());
          return new Response(JSON.stringify({ paragraphs: ["fine"] }), { status: 200 });
        },
      };
    },
  };
  let plugin: PluginShape | undefined;
  withEnv({ ANTHROPIC_API_KEY: "dummy-dev-key" }, () => {
    plugin = build({ command: "serve", mode: "development" }).plugins.find(
      (entry) => entry.name === "dev-commentary",
    );
    plugin?.configureServer?.(server);
  });
  assert.equal(plugin?.apply, "serve");
  assert.equal(mounted.length, 1);
  return { handler: mounted[0], seen };
}

async function assertRefused(origin: string) {
  const { handler, seen } = mountCommentaryRoute();
  const refused = await callRoute(handler, origin);
  assert.equal(refused.status, 403);
  assert.equal(refused.body, refusal);
  assert.equal(seen.length, 0);
}

test("the development commentary route refuses a request from another site and answers a same-origin one", async () => {
  const { handler, seen } = mountCommentaryRoute();

  const refused = await callRoute(handler, "https://example.test");
  assert.equal(refused.status, 403);
  assert.equal(refused.body, refusal);
  assert.equal(seen.length, 0);

  const withoutOrigin = await callRoute(handler, undefined);
  assert.equal(withoutOrigin.status, 403);
  assert.equal(withoutOrigin.body, refusal);
  assert.equal(seen.length, 0);

  const answered = await callRoute(handler, "http://localhost:5173");
  assert.equal(answered.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0], "not json");
  assert.match(answered.body, /fine/);
});

test("the development commentary route refuses a same-host Origin with a non-HTTP(S) scheme", async () => {
  await assertRefused("ftp://localhost:5173");
});

test("the development commentary route refuses a malformed Origin", async () => {
  await assertRefused("not a url");
});

test("the development commentary route refuses a null Origin", async () => {
  await assertRefused("null");
});

test("the development commentary route refuses a same-host Origin with a different port", async () => {
  await assertRefused("http://localhost:5174");
});
