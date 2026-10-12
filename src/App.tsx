import { CircleAlert, CircleCheck, Info } from "lucide-react";
import { useEffect } from "react";
import { BotPanel } from "./components/BotPanel";
import { ChatView } from "./components/ChatView";
import { Sidebar } from "./components/Sidebar";
import { ConfirmHost } from "./components/ui";
import { UpdateBanner } from "./components/UpdateBanner";
import { startScheduler } from "./lib/routines";
import { useApp } from "./lib/store";
import { startSync } from "./lib/sync";
import { startUpdateChecks } from "./lib/updates";
import { Onboarding } from "./views/Onboarding";
import { PluginsView } from "./views/PluginsView";
import { RoutinesView } from "./views/RoutinesView";
import { SettingsView } from "./views/SettingsView";
import { SkillsView } from "./views/SkillsView";
import { TemplatesView } from "./views/TemplatesView";
import logo from "./assets/lantern.svg";

function useTheme(theme: "system" | "light" | "dark") {
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme = theme === "system" ? (media.matches ? "dark" : "light") : theme;
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
}

function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          {t.kind === "error" ? <CircleAlert size={16} /> : t.kind === "success" ? <CircleCheck size={16} /> : <Info size={16} />}
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

function Main() {
  const view = useApp((s) => s.view);
  switch (view.kind) {
    case "templates":
      return <TemplatesView />;
    case "routines":
      return <RoutinesView />;
    case "skills":
      return <SkillsView />;
    case "plugins":
      return <PluginsView />;
    case "settings":
      return <SettingsView key={view.tab ?? ""} />;
    default:
      return <ChatView />;
  }
}

export function App() {
  const ready = useApp((s) => s.ready);
  const theme = useApp((s) => s.settings.theme);
  const onboarded = useApp((s) => s.settings.onboarded);
  const detailsOpen = useApp((s) => s.detailsOpen && s.view.kind === "chat" && !!s.activeBotId);
  const navOpen = useApp((s) => s.navOpen);
  const banner = useApp((s) => !!s.update && !s.update.dismissed);
  useTheme(theme);

  useEffect(() => {
    if (!ready) return;
    startScheduler();
    void startSync().catch((e) => console.error("sync", e));
    startUpdateChecks();
  }, [ready]);

  if (!ready) {
    return (
      <div className="splash">
        <img src={logo} alt="" width={72} height={72} />
      </div>
    );
  }

  return (
    <>
      {onboarded ? (
        <div className={`app-shell${banner ? " has-banner" : ""}`}>
          <UpdateBanner />
          <div className={`app${navOpen ? " nav-open" : ""}${detailsOpen ? " details-open" : ""}`}>
            <Sidebar />
            <main className="main">
              <Main />
            </main>
            {detailsOpen && <BotPanel />}
          </div>
        </div>
      ) : (
        <Onboarding />
      )}
      <ConfirmHost />
      <Toasts />
    </>
  );
}
