import { ChevronRight, Clock, Monitor, Plus } from "lucide-react";
import { useState } from "react";
import { Avatar } from "../components/Avatar";
import { Button, Modal } from "../components/ui";
import { createBlankBot, createBotFromTemplate } from "../lib/bots";
import { capabilities } from "../lib/platform";
import { describeSchedule } from "../lib/schedule";
import { useApp } from "../lib/store";
import { TEMPLATES, type BotTemplate } from "../lib/templates";
import { PageHead } from "./PageHead";

export function TemplatesView() {
  const hasHub = useApp((s) => !!s.hub);
  const [category, setCategory] = useState<string>("All");
  const [open, setOpen] = useState<BotTemplate | null>(null);
  const categories = ["All", ...new Set(TEMPLATES.map((t) => t.category))];
  const shown = TEMPLATES.filter((t) => category === "All" || t.category === category);

  return (
    <div className="main-pane page">
      <PageHead title="Templates" subtitle="Start a bot with a ready-made job. You can change everything later." />
      <div className="page-body">
        <div className="chips">
          {categories.map((c) => (
            <button key={c} className={`chip${c === category ? " on" : ""}`} onClick={() => setCategory(c)}>
              {c}
            </button>
          ))}
        </div>
        <div className="catalogue">
          {shown.map((t) => (
            <button key={t.id} className="catalogue-row" onClick={() => setOpen(t)}>
              <Avatar spec={t.avatar} size={40} />
              <span className="catalogue-text">
                <span className="catalogue-name">{t.name}</span>
                <span className="catalogue-desc">{t.tagline}</span>
              </span>
              <span className="catalogue-meta">
                {t.routine && (
                  <span title="Comes with a routine">
                    <Clock size={13} />
                  </span>
                )}
                {t.desktopOnly && (
                  <span title="Works best on desktop">
                    <Monitor size={13} />
                  </span>
                )}
                <span className="stamp">{t.category}</span>
              </span>
              <ChevronRight size={17} className="catalogue-go" />
            </button>
          ))}
          <button className="catalogue-row catalogue-blank" onClick={() => void createBlankBot()}>
            <Plus size={18} />
            <span className="catalogue-text">
              <span className="catalogue-name">Blank bot</span>
              <span className="catalogue-desc">Write your own instructions from scratch.</span>
            </span>
          </button>
        </div>
      </div>
      {open && (
        <Modal
          title={
            <span className="row">
              <Avatar spec={open.avatar} size={32} /> {open.name}
            </span>
          }
          onClose={() => setOpen(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpen(null)}>
                Close
              </Button>
              <Button
                variant="primary"
                onClick={async () => {
                  await createBotFromTemplate(open);
                  setOpen(null);
                }}
              >
                Create {open.name}
              </Button>
            </>
          }
        >
          <p className="lead">{open.tagline}</p>
          {open.desktopOnly && !capabilities.shell && !hasHub && <p className="notice">This bot uses the terminal, which is only available in the desktop app. It will work with reduced abilities here.</p>}
          <h3>Instructions</h3>
          <p className="muted pre-wrap">{open.instructions}</p>
          <h3>Try asking</h3>
          <ul className="bullets">
            {open.starters.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
          {open.routine && (
            <>
              <h3>Routine</h3>
              <p className="muted">
                “{open.routine.name}”, {describeSchedule(open.routine.schedule).toLowerCase()}. It starts paused. Turn it on once you've told the bot what to cover.
              </p>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
