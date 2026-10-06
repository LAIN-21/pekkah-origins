import { Id } from "@pekkah/protocol";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { type FeedSource, marketSource } from "./source";
import "./styles.css";

async function pickSource(): Promise<FeedSource> {
  // Dev builds only: import.meta.env.DEV is false in production, so this branch
  // and the fixture module are dropped from the bundle.
  if (import.meta.env.DEV) {
    const params = new URLSearchParams(location.search);
    if (params.get("fixture") === "1") {
      const { fixtureSource } = await import("./dev/fixture");
      return fixtureSource(params);
    }
  }
  return marketSource;
}

/** ?run=<runId> opens that run and keeps it on screen. */
function pinnedRunId(): string | undefined {
  const value = new URLSearchParams(location.search).get("run");
  return value && Id.safeParse(value).success ? value : undefined;
}

const root = document.getElementById("root");
if (root) {
  pickSource().then((source) => {
    const pinned = pinnedRunId();
    createRoot(root).render(
      <StrictMode>
        <App source={source} {...(pinned ? { pinnedRunId: pinned } : {})} />
      </StrictMode>,
    );
  });
}
