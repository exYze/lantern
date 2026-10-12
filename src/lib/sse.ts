/** Incremental Server-Sent Events parser: feed text chunks, get complete `data` payloads. */
export class SseParser {
  private buffer = "";
  private data: string[] = [];

  feed(chunk: string): string[] {
    this.buffer += chunk;
    const out: string[] = [];
    let nl: number;
    while ((nl = this.buffer.search(/\r\n|\r|\n/)) !== -1) {
      const line = this.buffer.slice(0, nl);
      const sepLen = this.buffer.startsWith("\r\n", nl) ? 2 : 1;
      this.buffer = this.buffer.slice(nl + sepLen);
      this.line(line, out);
    }
    return out;
  }

  /** Flushes a trailing event that was not terminated by a blank line. */
  end(): string[] {
    const out: string[] = [];
    if (this.buffer) this.line(this.buffer, out);
    this.buffer = "";
    this.line("", out);
    return out;
  }

  private line(line: string, out: string[]) {
    if (line === "") {
      if (this.data.length) out.push(this.data.join("\n"));
      this.data = [];
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
  }
}

/**
 * Splits `<think>…</think>` reasoning out of a streamed content channel
 * (DeepSeek-R1, Qwen3 and other open models emit it inline).
 */
export class ThinkSplitter {
  private inThink = false;
  private pending = "";
  private sawContent = false;

  push(text: string): { content: string; reasoning: string } {
    let content = "";
    let reasoning = "";
    let s = this.pending + text;
    this.pending = "";
    while (s.length) {
      const tag = this.inThink ? "</think>" : "<think>";
      const idx = s.indexOf(tag);
      if (idx === -1) {
        // Hold back a possible partial tag at the end of the chunk.
        const keep = partialSuffix(s, tag);
        const emit = s.slice(0, s.length - keep);
        this.pending = s.slice(s.length - keep);
        if (this.inThink) reasoning += emit;
        else content += emit;
        break;
      }
      const before = s.slice(0, idx);
      if (this.inThink) reasoning += before;
      else content += before;
      // Only treat <think> as reasoning when it opens the reply.
      if (!this.inThink && (this.sawContent || content.trim().length > 0)) {
        content += tag;
      } else {
        this.inThink = !this.inThink;
      }
      s = s.slice(idx + tag.length);
    }
    if (content.trim()) this.sawContent = true;
    return { content, reasoning };
  }

  flush(): { content: string; reasoning: string } {
    const rest = this.pending;
    this.pending = "";
    return this.inThink ? { content: "", reasoning: rest } : { content: rest, reasoning: "" };
  }
}

function partialSuffix(s: string, tag: string): number {
  for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) {
    if (tag.startsWith(s.slice(s.length - n))) return n;
  }
  return 0;
}
