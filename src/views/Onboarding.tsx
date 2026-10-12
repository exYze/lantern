import { ArrowRight, ChevronRight, Link2 } from "lucide-react";
import { useState } from "react";
import { Avatar } from "../components/Avatar";
import { HubConnectForm } from "../components/HubConnect";
import { ProviderForm } from "../components/ProviderForm";
import { Button } from "../components/ui";
import { createBlankBot, createBotFromTemplate } from "../lib/bots";
import { DEFAULT_HUB_URL } from "../lib/hub";
import { capabilities } from "../lib/platform";
import { updateSettings, useApp } from "../lib/store";
import { TEMPLATES } from "../lib/templates";
import logo from "../assets/lantern.svg";

const FEATURED = ["companion", "research-scout", "code-pilot", "writing-partner", "study-coach", "planner"];

export function Onboarding() {
  const hasProvider = useApp((s) => s.providers.length > 0);
  const hasHub = useApp((s) => !!s.hub);
  const [step, setStep] = useState<"welcome" | "hub" | "server" | "bot">("welcome");
  const finish = () => updateSettings({ onboarded: true });
  const featured = TEMPLATES.filter((t) => FEATURED.includes(t.id) && (!t.desktopOnly || capabilities.shell || hasHub));

  return (
    <div className="onboarding">
      <aside className="onboarding-side">
        <div className="onboarding-brand">
          <img src={logo} alt="" width={30} height={30} />
          <span>Lantern</span>
        </div>
        <p className="onboarding-statement">Bots that do real work on your own machines, with models you run.</p>
        <p className="onboarding-foot">Free and open source. No account, and nothing is sent to us.</p>
      </aside>
      <main className="onboarding-main">
        {step === "welcome" && (
          <div className="onboarding-step">
            <h1>Welcome.</h1>
            <p className="lead">
              Lantern talks to the model server you already have: Ollama, llama.cpp, vLLM, LM Studio or anything that speaks the OpenAI API. Your bots can read and write files, run
              commands and search the web.
            </p>
            <p className="lead">They ask you first before they change anything or run a command.</p>
            <div className="row wrap">
              <Button variant={DEFAULT_HUB_URL ? "secondary" : "primary"} onClick={() => setStep(hasProvider ? "bot" : "server")}>
                Set up this device <ArrowRight size={16} />
              </Button>
              <Button variant={DEFAULT_HUB_URL ? "primary" : "secondary"} onClick={() => setStep("hub")}>
                <Link2 size={16} /> Connect to a Lantern Hub
              </Button>
            </div>
          </div>
        )}
        {step === "hub" && (
          <div className="onboarding-step">
            <h2>Connect to your Lantern Hub</h2>
            <p className="muted">Your hub keeps one environment for all your devices. Once connected, your bots, chats and settings appear here.</p>
            <HubConnectForm
              onConnected={() => {
                // A hub that already has an environment marks this device as set up; a new hub continues setup here.
                if (!useApp.getState().settings.onboarded) setStep(useApp.getState().providers.length ? "bot" : "server");
              }}
            />
            <div className="row-end">
              <button className="link" onClick={() => setStep("welcome")}>
                Back
              </button>
            </div>
          </div>
        )}
        {step === "server" && (
          <div className="onboarding-step">
            <h2>Connect a model server</h2>
            <p className="muted">Pick where your models run. Ollama is the easiest way to start: install it, run <code>ollama pull qwen3</code>, then press Connect.</p>
            <ProviderForm
              submitLabel="Continue"
              onSaved={(p) => {
                if (p.models[0]) void updateSettings({ defaultModel: { providerId: p.id, model: p.models[0] } });
                setStep("bot");
              }}
            />
            <div className="row-end">
              <button className="link" onClick={() => setStep("bot")}>
                Skip for now
              </button>
            </div>
          </div>
        )}
        {step === "bot" && (
          <div className="onboarding-step">
            <h2>Pick your first bot</h2>
            <p className="muted">Each one comes with instructions for a job. You can rename it, redraw it and rewrite it later.</p>
            <div className="catalogue">
              {featured.map((t) => (
                <button
                  key={t.id}
                  className="catalogue-row"
                  onClick={async () => {
                    await createBotFromTemplate(t);
                    await finish();
                  }}
                >
                  <Avatar spec={t.avatar} size={36} />
                  <span className="catalogue-text">
                    <span className="catalogue-name">{t.name}</span>
                    <span className="catalogue-desc">{t.tagline}</span>
                  </span>
                  <ChevronRight size={17} className="catalogue-go" />
                </button>
              ))}
            </div>
            <div className="row-end">
              <button
                className="link"
                onClick={async () => {
                  await createBlankBot();
                  await finish();
                }}
              >
                Start with a blank bot
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
