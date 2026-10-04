import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { warmBrowserDatabase } from "./db.ts";
import "./styles.css";

/** Shows a readable message instead of a blank page if rendering fails. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="empty">
        <h1>Something went wrong</h1>
        <p>The tool hit an error and stopped. Your file was not uploaded or changed. Reload the page to start again.</p>
        <p className="error">{this.state.error.message}</p>
      </main>
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

warmBrowserDatabase();
