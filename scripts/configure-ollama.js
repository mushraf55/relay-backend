import { readFileSync, writeFileSync } from "node:fs";
const path = new URL("../.env", import.meta.url);
let text = readFileSync(path, "utf8");
const values = {
  AI_PROVIDER: "ollama",
  OLLAMA_BASE_URL: "http://127.0.0.1:11434",
  OLLAMA_CHAT_MODEL: "qwen3:8b",
  OLLAMA_EMBEDDING_MODEL: "qwen3-embedding:4b",
  OLLAMA_THINK: "true",
};
for (const [key, value] of Object.entries(values)) {
  const re = new RegExp("^" + key + "=.*$", "m");
  text = re.test(text)
    ? text.replace(re, key + "=" + value)
    : text + "\n" + key + "=" + value;
}
writeFileSync(path, text + "\n");
console.log("Local Ollama configuration saved.");
