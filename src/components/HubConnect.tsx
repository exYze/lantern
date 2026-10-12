import { Link2 } from "lucide-react";
import { useState } from "react";
import { DEFAULT_HUB_URL, fetchHubInfo, HubError, normalizeHubUrl, pairWithHub, type HubInfo } from "../lib/hub";
import { startSync } from "../lib/sync";
import { Button, Field } from "./ui";

/** Connects this device to a Lantern Hub: one tap for the owner's Tailscale devices, otherwise a pairing code. */
export function HubConnectForm({ onConnected }: { onConnected?: () => void }) {
  const [url, setUrl] = useState(DEFAULT_HUB_URL);
  const [code, setCode] = useState("");
  const [info, setInfo] = useState<HubInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const finish = async (hubUrl: string, pairingCode?: string) => {
    await pairWithHub(hubUrl, pairingCode);
    await startSync();
    onConnected?.();
  };

  const connect = async () => {
    const hubUrl = normalizeHubUrl(url);
    if (!hubUrl) return;
    setBusy(true);
    setError(null);
    try {
      const found = await fetchHubInfo(hubUrl);
      setUrl(hubUrl);
      if (found.canAutoPair) await finish(hubUrl);
      else setInfo(found);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pairWithCode = async () => {
    setBusy(true);
    setError(null);
    try {
      await finish(normalizeHubUrl(url), code);
    } catch (e) {
      setError(e instanceof HubError && e.status === 401 ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="form">
      {!info ? (
        <>
          <Field label="Hub address" hint="For example https://lantern.your-tailnet.ts.net. It's shown on your hub's downloads page.">
            <input
              className="input mono"
              value={url}
              placeholder="https://lantern.your-tailnet.ts.net"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void connect()}
            />
          </Field>
          <div>
            <Button variant="primary" disabled={busy || !url.trim()} onClick={() => void connect()}>
              <Link2 size={16} /> {busy ? "Connecting…" : "Connect"}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p>
            Found <strong>{info.name}</strong>. This device isn't signed in to the hub owner's Tailscale account, so it needs a one-time pairing code: from a connected device (Settings →
            Hub → Add a device), or by running <code>lantern-hubctl pair-code</code> on the hub.
          </p>
          <Field label="Pairing code">
            <input
              className="input mono"
              value={code}
              placeholder="ABCD-2345"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void pairWithCode()}
            />
          </Field>
          <div className="row">
            <Button variant="primary" disabled={busy || code.replace(/[^a-z0-9]/gi, "").length < 8} onClick={() => void pairWithCode()}>
              {busy ? "Pairing…" : "Pair this device"}
            </Button>
            <Button variant="ghost" onClick={() => setInfo(null)}>
              Back
            </Button>
          </div>
        </>
      )}
      {error && <p className="notice notice-error">{error}</p>}
    </div>
  );
}
