import { Download, RefreshCw, X } from "lucide-react";
import { installUpdate } from "../lib/updates";
import { useApp } from "../lib/store";
import { Button, IconButton } from "./ui";

export function UpdateBanner() {
  const update = useApp((s) => s.update);
  if (!update || update.dismissed) return null;
  const busy = update.status !== "available";
  const percent = update.progress !== undefined ? ` ${Math.round(update.progress * 100)}%` : "";
  return (
    <div className="update-banner" role="status">
      <span>
        {update.status === "downloading"
          ? `Downloading Lantern ${update.version}…${percent}`
          : update.status === "installing"
            ? `Installing Lantern ${update.version}…`
            : `Lantern ${update.version} is available.`}
      </span>
      {!busy && (
        <>
          <Button size="sm" variant="primary" onClick={() => void installUpdate()}>
            {update.downloadUrl ? <Download size={14} /> : <RefreshCw size={14} />}
            {update.downloadUrl ? "Download" : "Restart to update"}
          </Button>
          <IconButton label="Later" onClick={() => useApp.setState({ update: { ...update, dismissed: true } })}>
            <X size={15} />
          </IconButton>
        </>
      )}
    </div>
  );
}
