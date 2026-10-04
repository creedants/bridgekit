// The checkout page: the server creates a Paddle transaction and sends the
// buyer here with ?_ptxn=<transaction id>; Paddle.js opens its checkout for
// that transaction. Paddle.js is loaded on this page only.
interface PaddleJs {
  Environment: { set(environment: string): void };
  Initialize(options: { token: string; checkout?: { settings?: { successUrl?: string } } }): void;
}

const status = document.getElementById("status")!;
const token = import.meta.env.VITE_PADDLE_CLIENT_TOKEN as string | undefined;

if (!token || !new URLSearchParams(location.search).has("_ptxn")) {
  status.textContent = "There is no checkout to open. Start from the Workspace panel in the tool.";
} else {
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
