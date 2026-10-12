import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initPlatform } from "./lib/platform";
import { loadAll } from "./lib/store";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);

async function boot() {
  try {
    await initPlatform();
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
