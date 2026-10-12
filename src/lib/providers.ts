export interface ProviderPreset {
  id: string;
  name: string;
  baseUrl: string;
  needsKey: boolean;
  kind: "local" | "hosted";
  note: string;
  docs: string;
}

/** Servers for open-weight models. Anything OpenAI-compatible works via "Custom". */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "ollama",
    name: "Ollama",
    baseUrl: "http://localhost:11434/v1",
    needsKey: false,
    kind: "local",
    note: "Run `ollama pull qwen3` (or llama3.2, gemma3, mistral…) and keep Ollama running.",
    docs: "https://ollama.com",
  },
  {
    id: "llamacpp",
    name: "llama.cpp server",
    baseUrl: "http://localhost:8080/v1",
    needsKey: false,
    kind: "local",
    note: "Start with `llama-server -m model.gguf --jinja` so tool calling works.",
    docs: "https://github.com/ggml-org/llama.cpp",
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    baseUrl: "http://localhost:1234/v1",
    needsKey: false,
    kind: "local",
    note: "Enable the local server in the Developer tab.",
    docs: "https://lmstudio.ai",
  },
  {
    id: "vllm",
    name: "vLLM",
    baseUrl: "http://localhost:8000/v1",
    needsKey: false,
    kind: "local",
    note: "Add `--enable-auto-tool-choice --tool-call-parser <parser>` for tools.",
    docs: "https://docs.vllm.ai",
  },
  {
    id: "sglang",
    name: "SGLang",
    baseUrl: "http://localhost:30000/v1",
    needsKey: false,
    kind: "local",
    note: "Pass `--tool-call-parser` to enable tool calling.",
    docs: "https://github.com/sgl-project/sglang",
  },
  {
    id: "localai",
    name: "LocalAI",
    baseUrl: "http://localhost:8080/v1",
    needsKey: false,
    kind: "local",
    note: "Drop-in OpenAI API for GGUF, transformers and more.",
    docs: "https://localai.io",
  },
  {
    id: "jan",
    name: "Jan",
    baseUrl: "http://localhost:1337/v1",
    needsKey: false,
    kind: "local",
    note: "Turn on the Local API Server in Jan's settings.",
    docs: "https://jan.ai",
  },
  {
    id: "koboldcpp",
    name: "KoboldCpp",
    baseUrl: "http://localhost:5001/v1",
    needsKey: false,
    kind: "local",
    note: "Single-file GGUF runner with an OpenAI endpoint.",
    docs: "https://github.com/LostRuins/koboldcpp",
  },
  {
    id: "tgwui",
    name: "text-generation-webui",
    baseUrl: "http://localhost:5000/v1",
    needsKey: false,
    kind: "local",
    note: "Start with the `--api` flag.",
    docs: "https://github.com/oobabooga/text-generation-webui",
  },
  {
    id: "openrouter",
    name: "OpenRouter (open models)",
    baseUrl: "https://openrouter.ai/api/v1",
    needsKey: true,
    kind: "hosted",
    note: "Hosted Llama, Qwen, DeepSeek, Mistral, Gemma and more.",
    docs: "https://openrouter.ai",
  },
  {
    id: "together",
    name: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    needsKey: true,
    kind: "hosted",
    note: "Hosted open-weight models.",
    docs: "https://together.ai",
  },
  {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    needsKey: true,
    kind: "hosted",
    note: "Fast inference for Llama, Qwen and other open models.",
    docs: "https://groq.com",
  },
  {
    id: "huggingface",
    name: "Hugging Face Inference",
    baseUrl: "https://router.huggingface.co/v1",
    needsKey: true,
    kind: "hosted",
    note: "Open models served by Hugging Face inference providers.",
    docs: "https://huggingface.co/docs/inference-providers",
  },
  {
    id: "custom",
    name: "Custom (OpenAI-compatible)",
    baseUrl: "http://localhost:8080/v1",
    needsKey: false,
    kind: "local",
    note: "Any server that speaks the OpenAI chat completions API.",
    docs: "https://platform.openai.com/docs/api-reference/chat",
  },
];
