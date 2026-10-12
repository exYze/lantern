import "highlight.js/styles/github-dark.css";
import "katex/dist/katex.min.css";
import { Check, Copy } from "lucide-react";
import { memo, useEffect, useId, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { openExternal } from "../lib/platform";

interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: { className?: string[] | string };
  children?: HastNode[];
}

function hastText(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(hastText).join("");
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="copy-btn"
      onClick={async () => {
        await navigator.clipboard.writeText(text).catch(() => {});
        setDone(true);
        setTimeout(() => setDone(false), 1400);
      }}
      title={label}
      aria-label={label}
    >
      {done ? <Check size={14} /> : <Copy size={14} />}
      <span>{done ? "Copied" : label}</span>
    </button>
  );
}

let mermaidLoader: Promise<typeof import("mermaid").default> | null = null;

function Mermaid({ code }: { code: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        mermaidLoader ??= import("mermaid").then((m) => m.default);
        const mermaid = await mermaidLoader;
        const dark = document.documentElement.dataset.theme === "dark";
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default", fontFamily: "inherit" });
        if (!(await mermaid.parse(code, { suppressErrors: true }))) throw new Error("invalid diagram");
        const out = await mermaid.render(`mmd${id}${Date.now()}`, code);
        if (!cancelled) {
          setSvg(out.svg);
          setFailed(false);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code, id]);

  if (svg && !failed) return <div className="mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
  return (
    <div className="codeblock">
      <div className="codeblock-head">
        <span>mermaid{failed ? " · couldn't render" : ""}</span>
        <CopyButton text={code} />
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

const components: Components = {
  a({ href, children }) {
    return (
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault();
          if (href && /^(https?:|mailto:)/i.test(href)) void openExternal(href);
        }}
      >
        {children}
      </a>
    );
  },
  pre({ node, children }) {
    const code = (node as HastNode | undefined)?.children?.find((c) => c.tagName === "code");
    const cls = code?.properties?.className;
    const classes = Array.isArray(cls) ? cls : typeof cls === "string" ? cls.split(" ") : [];
    const lang = classes.find((c) => c.startsWith("language-"))?.slice(9) ?? "";
    const text = hastText(code);
    if (lang === "mermaid") return <Mermaid code={text} />;
    return (
      <div className="codeblock">
        <div className="codeblock-head">
          <span>{lang || "text"}</span>
          <CopyButton text={text} />
        </div>
        <pre>{children as ReactNode}</pre>
      </div>
    );
  },
  table({ children }) {
    return (
      <div className="table-wrap">
        <table>{children}</table>
      </div>
    );
  },
  img({ src, alt }) {
    return <img src={typeof src === "string" ? src : undefined} alt={alt ?? ""} loading="lazy" />;
  },
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: true }]]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }], [rehypeHighlight, { detect: false, plainText: ["mermaid", "text", "txt", "plain"] }]]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
