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

const root = document.getElementById("root");
if (root) {
  pickSource().then((source) => {
    createRoot(root).render(
      <StrictMode>
        <App source={source} />
      </StrictMode>,
    );
  });
}
