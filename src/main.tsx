import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initPlatform } from "./lib/platform";
import { loadAll } from "./lib/store";
import "@fontsource-variable/archivo/standard.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);

async function boot() {
  try {
    const info = await initPlatform();
    // Lets CSS adapt to platform quirks (e.g. Android's edge-to-edge system bars).
    document.documentElement.dataset.os = info.os;
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    await loadAll();
  } catch (e) {
    console.error(e);
    root.render(
      <div className="boot-error">
        <h1>Lantern couldn't start</h1>
        <pre>{String((e as Error)?.stack ?? e)}</pre>
      </div>,
    );
  }
}

void boot();
