import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { Avatar } from "../components/Avatar";
import { ProviderForm } from "../components/ProviderForm";
import { Button } from "../components/ui";
import { createBlankBot, createBotFromTemplate } from "../lib/bots";
import { capabilities } from "../lib/platform";
import { updateSettings, useApp } from "../lib/store";
import { TEMPLATES } from "../lib/templates";
import logo from "../assets/lantern.svg";

const FEATURED = ["companion", "research-scout", "code-pilot", "writing-partner", "study-coach", "planner"];

export function Onboarding() {
  const hasProvider = useApp((s) => s.providers.length > 0);
  const [step, setStep] = useState<"welcome" | "server" | "bot">("welcome");
  const finish = () => updateSettings({ onboarded: true });
  const featured = TEMPLATES.filter((t) => FEATURED.includes(t.id) && (!t.desktopOnly || capabilities.shell));

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
              <li>You approve what bots do on your computer</li>
            </ul>
            <Button variant="primary" onClick={() => setStep(hasProvider ? "bot" : "server")}>
              Get started <ArrowRight size={16} />
            </Button>
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
