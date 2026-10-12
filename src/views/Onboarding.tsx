import { ArrowRight, Link2 } from "lucide-react";
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
      <div className="onboarding-card">
        {step === "welcome" && (
          <div className="onboarding-step center">
            <img src={logo} alt="" width={88} height={88} />
            <h1>Welcome to Lantern</h1>
            <p className="lead">Create AI bots with their own instructions, memories, skills, tools and routines, running on open-source models you choose.</p>
            <ul className="welcome-points">
              <li>Works with Ollama, llama.cpp, vLLM, LM Studio and any OpenAI-compatible server</li>
              <li>Your data stays on your device. No account, no telemetry</li>
              <li>Bots ask before they change things or run commands</li>
            </ul>
            <div className="row wrap center">
              <Button variant={DEFAULT_HUB_URL ? "secondary" : "primary"} onClick={() => setStep(hasProvider ? "bot" : "server")}>
                Get started <ArrowRight size={16} />
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
            <h2>Create your first bot</h2>
            <p className="muted">Start from a template. You can change its name, look and instructions any time.</p>
            <div className="card-grid compact">
              {featured.map((t) => (
                <button
                  key={t.id}
                  className="tcard"
                  onClick={async () => {
                    await createBotFromTemplate(t);
                    await finish();
                  }}
                >
                  <Avatar spec={t.avatar} size={44} />
                  <span className="tcard-name">{t.name}</span>
                  <span className="tcard-tagline">{t.tagline}</span>
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
      </div>
    </div>
  );
}
