// The checkout page: the server creates a Paddle transaction and sends the
// buyer here with ?_ptxn=<transaction id>; Paddle.js opens its checkout for
// that transaction. Paddle.js is loaded on this page only.
interface PaddleJs {
  Environment: { set(environment: string): void };
  Initialize(options: { token: string; checkout?: { settings?: { successUrl?: string } } }): void;
}

type CheckoutInstruction =
  | readonly [
      kind: "show",
      sentence: "There is no checkout to open. Start from the Workspace panel in the tool.",
      errorName: null,
    ]
  | readonly [
      kind: "show",
      sentence: "Checkout is not available right now. Try again later.",
      errorName: "VITE_PADDLE_CLIENT_TOKEN",
    ]
  | readonly [kind: "open", token: string];

export function decideCheckout(input: {
  readonly search: string;
  readonly token: string | undefined;
}): CheckoutInstruction {
  if (!new URLSearchParams(input.search).has("_ptxn")) {
    return ["show", "There is no checkout to open. Start from the Workspace panel in the tool.", null];
  }
  if (!input.token) {
    return ["show", "Checkout is not available right now. Try again later.", "VITE_PADDLE_CLIENT_TOKEN"];
  }
  return ["open", input.token];
}

if (typeof document !== "undefined") {
  const status = document.getElementById("status")!;
  const token = import.meta.env.VITE_PADDLE_CLIENT_TOKEN as string | undefined;
  const instruction = decideCheckout({ search: location.search, token });
  if (instruction[0] === "show") {
    status.textContent = instruction[1];
    if (instruction[2] !== null) console.error(instruction[2]);
  } else if (token) {
    const script = document.createElement("script");
    script.src = "https://cdn.paddle.com/paddle/v2/paddle.js";
    script.onload = () => {
      const paddle = (window as unknown as { Paddle: PaddleJs }).Paddle;
      if (import.meta.env.VITE_PADDLE_ENVIRONMENT !== "live") paddle.Environment.set("sandbox");
      paddle.Initialize({ token, checkout: { settings: { successUrl: `${location.origin}/app/?subscribed=1` } } });
    };
    script.onerror = () => {
      status.textContent = "The checkout could not be loaded. Check your connection or any content blocker, then reload.";
    };
    document.head.append(script);
  }
}
