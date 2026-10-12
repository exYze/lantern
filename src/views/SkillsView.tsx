import { BookOpen, FileUp, Pencil, Plus, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { SkillEditor } from "../components/BotPanel";
import { Button, confirmDialog, Empty, IconButton } from "../components/ui";
import { deleteSkill, saveSkill, toast, useApp } from "../lib/store";
import type { Skill } from "../lib/types";
import { uid } from "../lib/util";
import { PageHead } from "./PageHead";

/** Parses a SKILL.md file (YAML front-matter with name/description, Markdown body). */
export function parseSkillMarkdown(text: string, fallbackName: string): Pick<Skill, "name" | "description" | "content"> {
  const m = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/);
  if (!m) return { name: fallbackName, description: `Use for ${fallbackName}`, content: text.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { name: meta.name || fallbackName, description: meta.description || `Use for ${meta.name || fallbackName}`, content: m[2].trim() };
}

export function SkillsView() {
  const skills = useApp((s) => s.skills);
  const bots = useApp((s) => s.bots);
  const [editing, setEditing] = useState<Skill | "new" | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const library = skills.filter((s) => !s.botId);
  const privateSkills = skills.filter((s) => s.botId);

  return (
    <div className="main-pane page">
      <PageHead
        title="Skills"
        subtitle="Reusable instruction packs. A bot loads a skill when a task matches its description."
        actions={
          <>
            <Button onClick={() => file.current?.click()}>
              <FileUp size={16} /> Import SKILL.md
            </Button>
            <Button variant="primary" onClick={() => setEditing("new")}>
              <Plus size={16} /> New skill
            </Button>
          </>
        }
      />
      <input
        ref={file}
        type="file"
        accept=".md,.markdown,.txt"
        hidden
        onChange={async (e) => {
          for (const f of Array.from(e.target.files ?? [])) {
            const parsed = parseSkillMarkdown(await f.text(), f.name.replace(/\.(md|markdown|txt)$/i, ""));
            const now = Date.now();
            await saveSkill({ id: uid("skill"), ...parsed, createdAt: now, updatedAt: now });
            toast(`Imported skill “${parsed.name}”`, "success");
          }
          e.target.value = "";
        }}
      />
      <div className="page-body">
        {!library.length ? (
          <Empty icon={<BookOpen size={36} />} title="Your skill library is empty">
            Write a skill, or import a SKILL.md file. Then switch it on for a bot in its Skills tab.
          </Empty>
        ) : (
          <div className="stack">
            {library.map((s) => {
              const users = bots.filter((b) => b.skillIds.includes(s.id));
              return (
                <div key={s.id} className="card skill-card">
                  <div className="list-main">
                    <strong>{s.name}</strong>
                    <span className="muted small">{s.description}</span>
                    <span className="small">{users.length ? `Used by ${users.map((b) => b.name).join(", ")}` : "Not used by any bot yet"}</span>
                  </div>
                  <IconButton label="Edit" onClick={() => setEditing(s)}>
                    <Pencil size={16} />
                  </IconButton>
                  <IconButton
                    label="Delete"
                    onClick={async () => {
                      if (await confirmDialog({ title: `Delete “${s.name}”?`, confirmLabel: "Delete", danger: true })) await deleteSkill(s.id);
                    }}
                  >
                    <Trash2 size={16} />
                  </IconButton>
                </div>
              );
            })}
          </div>
        )}
        {privateSkills.length > 0 && (
          <>
            <h3 className="section-title">Private skills</h3>
            <div className="stack">
              {privateSkills.map((s) => (
                <div key={s.id} className="card skill-card">
                  <div className="list-main">
                    <strong>{s.name}</strong>
                    <span className="muted small">
                      {bots.find((b) => b.id === s.botId)?.name} · {s.description}
                    </span>
                  </div>
                  <IconButton label="Edit" onClick={() => setEditing(s)}>
                    <Pencil size={16} />
                  </IconButton>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
      {editing && <SkillEditor skill={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
