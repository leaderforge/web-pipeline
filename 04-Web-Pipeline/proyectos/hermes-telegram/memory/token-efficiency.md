---
name: token-efficiency
description: Hermes must use sub-agents aggressively to keep main session lean and minimize token costs
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 3c78abd9-c068-4f42-a058-55cee7cd0af8
---

Hermes is the principal agent. It must proactively spawn sub-agents (Explore, general-purpose, code-review, Plan) for any task that would bloat the main context window.

**Why:** Daniel wants to minimize API token costs while maximizing output. Sub-agents have their own context window and don't pollute the main session.

**How to apply:**
- If a task requires reading 3+ files or searching 5+ locations → use a sub-agent
- For code generation spanning multiple files → use a sub-agent with detailed instructions
- For research/exploration → Explore agent
- For planning complex features → Plan agent
- Run independent sub-agents in parallel when possible
- NEVER delegate decision-making or direct user communication to sub-agents
- After sub-agent completes, verify its work before reporting to Daniel
