---
name: vault-setup
description: "Obsidian vault structure inside Hermes-Brain serves as persistent memory, separate from code execution folders"
metadata: 
  node_type: memory
  type: project
  originSessionId: 3c78abd9-c068-4f42-a058-55cee7cd0af8
---

Obsidian vault at `C:\Hermes-Brain\Hermes-Brain` with structure:
- `Clientes/` — client dossiers (template: `_template-cliente.md`)
- `Sistemas/` — technical docs (Vercel, Railway, Telnyx, Telegram Bridge, Web Builder)
- `Marketing/` — strategy, funnels, content
- `Daily/` — daily work logs and decisions
- `Contexto-Hermes.md` — master context file Hermes reads to understand its role

**Why:** Obsidian = knowledge/memory layer. Hermes-Brain project folders = execution layer (code). Both physically co-located so Hermes can read/write both.

**How to apply:** Before major decisions, check the vault for client context. After significant work, update the vault (Daily note, client files, system docs). When giving advice, reference vault content as evidence.
