import { CircleAlert, CircleCheck, ExternalLink, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { listModels } from "../lib/llm";
import { openExternal, platform } from "../lib/platform";
import { PROVIDER_PRESETS, type ProviderPreset } from "../lib/providers";
import { saveProvider } from "../lib/store";
import type { Provider } from "../lib/types";
import { uid } from "../lib/util";
import { Button, Field } from "./ui";

/** Add or edit an OpenAI-compatible server. Calls onSaved with the saved provider. */
export function ProviderForm({ provider, onSaved, onCancel, submitLabel = "Save" }: { provider?: Provider; onSaved: (p: Provider) => void; onCancel?: () => void; submitLabel?: string }) {
  const [preset, setPreset] = useState<ProviderPreset | undefined>(provider ? PROVIDER_PRESETS.find((p) => p.id === provider.presetId) : PROVIDER_PRESETS[0]);
  const [name, setName] = useState(provider?.name ?? PROVIDER_PRESETS[0].name);
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? PROVIDER_PRESETS[0].baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [modelsText, setModelsText] = useState((provider?.models ?? []).join("\n"));
  const [status, setStatus] = useState<null | "testing" | { ok: true; count: number } | { ok: false; error: string }>(null);

  const draft = (): Provider => ({
    id: provider?.id ?? uid("prov"),
    name: name.trim() || "My server",
    baseUrl: baseUrl.trim(),
    hasKey: provider?.hasKey ?? false,
    headers: provider?.headers,
    models: modelsText
      .split("\n")
      .map((m) => m.trim())
      .filter(Boolean),
    noToolModels: provider?.noToolModels,
    presetId: preset?.id ?? provider?.presetId,
    createdAt: provider?.createdAt ?? Date.now(),
  });

  const connect = async () => {
    setStatus("testing");
    try {
      const models = await listModels(draft(), apiKey ? apiKey : undefined);
      setModelsText(models.join("\n"));
      setStatus({ ok: true, count: models.length });
    } catch (e) {
      setStatus({ ok: false, error: (e as Error).message });
    }
  };

  const save = async () => {
    const p = draft();
    await saveProvider(p, apiKey ? apiKey : provider ? undefined : null);
    onSaved({ ...p, hasKey: apiKey ? true : p.hasKey });
  };

  const isLocalhost = /\/\/(localhost|127\.0\.0\.1)/.test(baseUrl);

  return (
    <div className="form">
      {!provider && (
        <div className="preset-grid">
          {PROVIDER_PRESETS.map((p) => (
            <button
              key={p.id}
              className={`preset${preset?.id === p.id ? " on" : ""}`}
              onClick={() => {
                setPreset(p);
                setName(p.name);
                setBaseUrl(p.baseUrl);
                setStatus(null);
                setModelsText("");
              }}
            >
              <span className="preset-name">{p.name}</span>
              <span className="preset-kind">{p.kind === "local" ? "Runs on your machine" : "Hosted open models"}</span>
            </button>
          ))}
        </div>
      )}
      {preset && (
        <p className="muted small">
          {preset.note.split("`").map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part))}{" "}
          <button className="link" onClick={() => void openExternal(preset.docs)}>
            Docs <ExternalLink size={11} />
          </button>
        </p>
      )}
      <Field label="Name">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field
        label="Server URL"
        hint={
          platform.mobile && isLocalhost
            ? "On a phone, “localhost” is the phone itself. Use your computer's LAN address (e.g. http://192.168.1.20:11434/v1) and make the server listen on the network."
            : "The OpenAI-compatible base URL, usually ending in /v1."
        }
      >
        <input className="input mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      </Field>
      <Field label={`API key${preset?.needsKey ? "" : " (optional)"}`} hint="Stored in secure storage. Leave empty for local servers.">
        <input className="input" type="password" value={apiKey} placeholder={provider?.hasKey ? "(saved, type to replace)" : ""} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" />
      </Field>
      <div className="row">
        <Button onClick={() => void connect()} disabled={!baseUrl.trim() || status === "testing"}>
          {status === "testing" && <LoaderCircle size={15} className="spin" />} Connect & list models
        </Button>
        {status && status !== "testing" && (
          <span className={`small ${status.ok ? "ok" : "bad"} row`}>
            {status.ok ? <CircleCheck size={15} /> : <CircleAlert size={15} />}
            {status.ok ? `Found ${status.count} model${status.count === 1 ? "" : "s"}` : status.error}
          </span>
        )}
      </div>
      <Field label="Models" hint="Filled in by Connect. You can also type model names, one per line.">
        <textarea className="input mono" rows={Math.min(8, Math.max(3, modelsText.split("\n").length))} value={modelsText} onChange={(e) => setModelsText(e.target.value)} />
      </Field>
      <div className="row-end">
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button variant="primary" onClick={() => void save()} disabled={!baseUrl.trim() || !modelsText.trim()}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}
