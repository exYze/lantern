import { ArrowLeft, CornerDownLeft, Globe, LoaderCircle, MousePointerClick, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { browserSpot, clickAt, pressKey, typeText } from "../lib/browser";
import { hubBrowser } from "../lib/hub";
import { appVisible } from "../lib/platform";
import { toast } from "../lib/store";
import type { Bot } from "../lib/types";
import { Button, IconButton } from "./ui";

const WIDTH = 1280;
const HEIGHT = 900;

/** Watch a bot's browser on the hub, and take over: click the picture, type, go to an address. */
export function BrowserView({ bot }: { bot: Bot }) {
  const spot = browserSpot(bot);
  const [open, setOpen] = useState<boolean | null>(null);
  const [shot, setShot] = useState<string | null>(null);
  const [page, setPage] = useState<{ u: string; t: string } | null>(null);
  const [address, setAddress] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const tick = useRef(0);

  const refresh = async () => {
    if (!spot) return;
    try {
      const st = await hubBrowser.status(spot.key);
      setOpen(st.open);
      if (!st.open) return;
      const [img, info] = await Promise.all([
        hubBrowser.call<{ data: string }>(spot, "Page.captureScreenshot", { format: "jpeg", quality: 60 }),
        hubBrowser.call<{ result?: { value?: { u: string; t: string } } }>(spot, "Runtime.evaluate", { expression: "({ u: location.href, t: document.title })", returnByValue: true }),
      ]);
      setShot(`data:image/jpeg;base64,${img.data}`);
      if (info.result?.value) setPage(info.result.value);
    } catch {
      setOpen(false);
    }
  };

  useEffect(() => {
    void refresh();
    const t = setInterval(() => {
      // Only while you're looking: screenshots aren't free.
      if (appVisible()) void refresh();
    }, 1500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id]);

  if (!spot) return <p className="muted small">The browser lives on your Lantern Hub. Connect one in Settings → Hub.</p>;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    const n = ++tick.current;
    try {
      await fn();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setTimeout(() => n === tick.current && void refresh().finally(() => setBusy(false)), 600);
    }
  };

  const go = () => {
    let url = address.trim();
    if (!url) return;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;
    void act(() => hubBrowser.call(spot, "Page.navigate", { url }, { timeoutMs: 45_000 }));
  };

  return (
    <div className="form browser-view">
      <p className="muted small">
        {bot.name}'s own browser, on your hub. You share it: click the page to click, type below to type. Sign in to a site here once and {bot.name} stays signed in.
      </p>
      <div className="row">
        <IconButton label="Back" disabled={!open || busy} onClick={() => void act(() => hubBrowser.call(spot, "Runtime.evaluate", { expression: "history.back()" }))}>
          <ArrowLeft size={16} />
        </IconButton>
        <input
          className="input mono"
          placeholder={page?.u ?? "Go to an address"}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go()}
        />
        <Button size="sm" disabled={!address.trim() || busy} onClick={go}>
          <Globe size={14} /> Go
        </Button>
      </div>
      {open && shot ? (
        <div className="browser-screen">
          {page?.t && <div className="browser-title small">{page.t}</div>}
          <img
            src={shot}
            alt={`What ${bot.name}'s browser shows`}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const x = ((e.clientX - r.left) / r.width) * WIDTH;
              const y = ((e.clientY - r.top) / r.height) * HEIGHT;
              void act(() => clickAt(spot, x, y));
            }}
          />
          {busy && <LoaderCircle size={18} className="spin browser-busy" />}
        </div>
      ) : (
        <div className="browser-closed muted small">
          {open === null ? "Checking the browser…" : `The browser is closed. It opens when ${bot.name} uses it, or when you go to an address above.`}
        </div>
      )}
      {open && (
        <>
          <div className="row">
            <input
              className="input"
              placeholder="Type into the page (click a field first)"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && text) {
                  const t = text;
                  setText("");
                  void act(async () => {
                    await typeText(spot, t);
                    await pressKey(spot, "Enter");
                  });
                }
              }}
            />
            <Button
              size="sm"
              disabled={!text || busy}
              onClick={() => {
                const t = text;
                setText("");
                void act(() => typeText(spot, t));
              }}
            >
              <MousePointerClick size={14} /> Type
            </Button>
            <IconButton label="Press Enter" disabled={busy} onClick={() => void act(() => pressKey(spot, "Enter"))}>
              <CornerDownLeft size={16} />
            </IconButton>
          </div>
          <div>
            <Button size="sm" variant="ghost" onClick={() => void act(() => hubBrowser.close(spot.key))}>
              <X size={14} /> Close the browser
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
