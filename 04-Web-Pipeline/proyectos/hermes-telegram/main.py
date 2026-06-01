"""
Hermes Telegram Bot V2 — Railway 24/7 service with DeepSeek intelligence.

Components:
  - Telegram bot (polling) for real-time communication with Daniel
  - DeepSeek API integration for intelligent responses
  - Cron scheduler for daily pipeline + proactive analysis
  - Memory system: reads project context from /memory/*.md
  - Lightweight HTTP server for Railway health checks

Railway project: hermes-telegram
"""

import os
import sys
import asyncio
import subprocess
import base64
import hashlib
import hmac
import json
import logging
import sqlite3
import time as time_mod
from datetime import datetime, time
from pathlib import Path

import pytz
import httpx
from dotenv import load_dotenv
from telegram import Update
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    filters,
    ContextTypes,
)
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

# FastAPI for Railway health checks
from fastapi import FastAPI, Request, Response
import uvicorn

load_dotenv()

# ── Config ──────────────────────────────────────────────────────
BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
CHAT_ID = int(os.environ["TELEGRAM_CHAT_ID"])
PORT = int(os.environ.get("PORT", "8080"))
TZ = pytz.timezone("America/Los_Angeles")

DEEPSEEK_API_KEY = os.environ.get("DEEPSEEK_API_KEY", "")
DEEPSEEK_BASE_URL = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com/anthropic")
DEEPSEEK_MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-v4-pro")
DEEPSEEK_FLASH_MODEL = os.environ.get("DEEPSEEK_FLASH_MODEL", "deepseek-v4-flash")
FIRECRAWL_API_KEY = os.environ.get("FIRECRAWL_API_KEY", "")
FIRECRAWL_BASE_URL = os.environ.get("FIRECRAWL_BASE_URL", "https://api.firecrawl.dev")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
DEEPSEEK_INPUT_COST_PER_1M = float(os.environ.get("DEEPSEEK_INPUT_COST_PER_1M", "0.50"))
DEEPSEEK_OUTPUT_COST_PER_1M = float(os.environ.get("DEEPSEEK_OUTPUT_COST_PER_1M", "2.00"))

MEMORY_DIR = Path(__file__).parent / "memory"
PROJECT_ROOT = Path(__file__).parent
OBS_DB = PROJECT_ROOT / "observability.db"
_scheduler = None  # global reference to APScheduler instance
VAULT_DIR = PROJECT_ROOT / "vault"
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET", "")
NOTIFY_SECRET = os.environ.get("NOTIFY_SECRET", "")
CHROMA_DIR = PROJECT_ROOT / "chroma_index"
CHROMA_COLLECTION_NAME = "vault"
RAG_TOP_K = 5
CHUNK_SIZE = 1000
CHUNK_OVERLAP = 200
BACKUP_DIR = PROJECT_ROOT / "vault_backups"
BACKUP_RETENTION = int(os.environ.get("BACKUP_RETENTION", "10"))
VAULT_BRANCH_AI = os.environ.get("VAULT_BRANCH_AI", "ai-memory")
WEBHOOK_DEBOUNCE_S = int(os.environ.get("WEBHOOK_DEBOUNCE_S", "60"))
_last_webhook_time: float = 0.0

# ── Zone-based Permissions ──────────────────────────────────────
# Each zone defines read/write/create/append rules for vault subdirectories.
# write="existing" means can modify existing files but cannot create new ones.

ZONE_CORE = "core"
ZONE_PROJECTS = "projects"
ZONE_AI_PROPOSALS = "ai_proposals"
ZONE_DAILY = "daily"
ZONE_LOGS = "logs"

ZONE_RULES = {
    ZONE_CORE: {
        "prefixes": [".obsidian", "Sistemas", "Estrategia", "Marketing"],
        "root_files": True,  # any .md at vault root (Contexto-Hermes.md, Sistema-Hermes.md)
        "read": True,
        "write": False,       # REJECTED outright (never reaches confirmation)
        "create": False,
        "append": False,
    },
    ZONE_PROJECTS: {
        "prefixes": ["Proyectos", "Clientes"],
        "read": True,
        "write": "existing",  # only existing files
        "create": False,
        "append": False,
    },
    ZONE_AI_PROPOSALS: {
        "prefixes": ["AI-Proposals"],
        "read": True,
        "write": True,
        "create": True,
        "append": False,
    },
    ZONE_DAILY: {
        "prefixes": ["Daily"],
        "read": True,
        "write": False,      # write_file not allowed; use append_daily_log
        "create": False,
        "append": True,
    },
    ZONE_LOGS: {
        "prefixes": ["Logs"],
        "read": True,
        "write": True,
        "create": True,
        "append": True,
    },
}

# Root-level .md files considered Core (Contexto-Hermes.md, Sistema-Hermes.md)
CORE_ROOT_FILES = {"Contexto-Hermes.md", "Sistema-Hermes.md"}


def resolve_zone(vault_rel_path: str) -> str:
    """Determine which zone a vault-relative path belongs to."""
    path = vault_rel_path.replace("\\", "/")

    # If it's at root level (no directory component)
    if "/" not in path:
        if path in CORE_ROOT_FILES:
            return ZONE_CORE
        if path.endswith(".md"):
            return ZONE_CORE
        return ZONE_LOGS

    # Check each zone's prefixes
    for zone, rules in ZONE_RULES.items():
        for prefix in rules.get("prefixes", []):
            if path.startswith(prefix + "/") or path.startswith(prefix):
                return zone

    return ZONE_LOGS


def check_vault_permission(vault_rel_path: str, operation: str, is_create: bool = False) -> tuple:
    """Check if an operation is allowed on a vault path. Returns (allowed, reason)."""
    zone = resolve_zone(vault_rel_path)
    rules = ZONE_RULES.get(zone, ZONE_RULES[ZONE_LOGS])

    if operation == "read":
        return (True, "")

    if operation == "write":
        write_rule = rules.get("write", False)
        if write_rule is False:
            log.warning(f"Zone permission denied: write to {vault_rel_path} (zone={zone}, read-only)")
            zone_names = {ZONE_CORE: "Core (solo lectura)", ZONE_DAILY: "Daily (usa append_daily_log)"}
            name = zone_names.get(zone, f"zona {zone}")
            return (False, f"Acceso denegado: {name} no permite escritura directa.")
        if write_rule == "existing" and is_create:
            log.warning(f"Zone permission denied: create new file in {vault_rel_path} (zone={zone})")
            return (False, f"Acceso denegado: zona {zone} solo permite modificar archivos existentes, no crear nuevos.")
        return (True, "")

    if operation == "append":
        if not rules.get("append", False):
            return (False, f"Acceso denegado: zona {zone} no permite append.")
        return (True, "")

    return (False, f"Operacion desconocida: {operation}")


def vault_relative_path(tool_path: str) -> str | None:
    """If tool_path resolves to inside VAULT_DIR, return path relative to vault. Else None."""
    try:
        full = (PROJECT_ROOT / tool_path).resolve()
        vault = VAULT_DIR.resolve()
        if str(full).startswith(str(vault) + os.sep) or str(full) == str(vault):
            rel = str(full.relative_to(vault)).replace("\\", "/")
            return rel
    except (ValueError, OSError):
        pass
    return None


# ── Observability DB ────────────────────────────────────────────
def init_observability_db():
    """Create SQLite database and table if they don't exist."""
    conn = sqlite3.connect(str(OBS_DB))
    conn.execute("""
        CREATE TABLE IF NOT EXISTS api_calls (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            model TEXT NOT NULL,
            prompt_tokens INTEGER NOT NULL DEFAULT 0,
            completion_tokens INTEGER NOT NULL DEFAULT 0,
            latency_ms REAL NOT NULL DEFAULT 0,
            cost_est REAL NOT NULL DEFAULT 0,
            success INTEGER NOT NULL DEFAULT 1,
            source TEXT NOT NULL DEFAULT 'chat'
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS sync_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            event_type TEXT NOT NULL,
            files_changed INTEGER DEFAULT 0,
            files_list TEXT DEFAULT '',
            duration_ms REAL DEFAULT 0,
            success INTEGER DEFAULT 1,
            details TEXT DEFAULT ''
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS cron_executions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            job_name TEXT NOT NULL,
            job_id TEXT NOT NULL,
            duration_ms REAL DEFAULT 0,
            success INTEGER DEFAULT 1,
            error TEXT DEFAULT ''
        )
    """)
    conn.commit()
    conn.close()


def log_api_call(model: str, prompt_tokens: int, completion_tokens: int,
                 latency_ms: float, success: bool = True, source: str = "chat"):
    """Record an API call in the observability database."""
    input_cost = (prompt_tokens / 1_000_000) * DEEPSEEK_INPUT_COST_PER_1M
    output_cost = (completion_tokens / 1_000_000) * DEEPSEEK_OUTPUT_COST_PER_1M
    cost_est = input_cost + output_cost

    conn = sqlite3.connect(str(OBS_DB))
    conn.execute(
        "INSERT INTO api_calls (timestamp, model, prompt_tokens, completion_tokens, latency_ms, cost_est, success, source) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (datetime.now(TZ).isoformat(), model, prompt_tokens, completion_tokens,
         round(latency_ms, 1), round(cost_est, 6), 1 if success else 0, source),
    )
    conn.commit()
    conn.close()


def log_sync_event(event_type: str, files_changed: int = 0, files_list: str = "",
                   duration_ms: float = 0, success: bool = True, details: str = ""):
    """Record a sync event in the observability database."""
    conn = sqlite3.connect(str(OBS_DB))
    conn.execute(
        "INSERT INTO sync_events (timestamp, event_type, files_changed, files_list, duration_ms, success, details) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (datetime.now(TZ).isoformat(), event_type, files_changed, files_list,
         round(duration_ms, 1), 1 if success else 0, details[:1000]),
    )
    conn.commit()
    conn.close()


def log_cron_execution(job_name: str, job_id: str, duration_ms: float,
                       success: bool = True, error: str = ""):
    """Record a cron job execution in the observability database."""
    conn = sqlite3.connect(str(OBS_DB))
    conn.execute(
        "INSERT INTO cron_executions (timestamp, job_name, job_id, duration_ms, success, error) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (datetime.now(TZ).isoformat(), job_name, job_id,
         round(duration_ms, 1), 1 if success else 0, error[:500]),
    )
    conn.commit()
    conn.close()


async def track_cron(job_id: str, coro):
    """Wrap a cron coroutine with execution tracking."""
    t0 = time_mod.time()
    try:
        await coro
        duration_ms = (time_mod.time() - t0) * 1000
        log_cron_execution(coro.__name__, job_id, duration_ms, success=True)
    except Exception as e:
        duration_ms = (time_mod.time() - t0) * 1000
        log_cron_execution(coro.__name__, job_id, duration_ms, success=False, error=str(e))
        log.error(f"Cron {job_id} ({coro.__name__}) failed: {e}")


# ── Pending Confirmations (destructive tool guard) ──────────────
# {chat_id: {"system_prompt": str, "messages": list, "tool_calls": list, "safe_results": list}}
pending_confirmations: dict[int, dict] = {}


# ── Vault Sync (GitHub API — delta-based, no git binary needed) ─
GITHUB_API = "https://api.github.com"
VAULT_OWNER = "leaderforge"
VAULT_REPO_NAME = "Hermes-Brain"
VAULT_BRANCH_MAIN = "master"       # source of truth (read-only for bot)
VAULT_BRANCH = "master"            # legacy alias kept for compatibility
LAST_COMMIT_FILE = PROJECT_ROOT / ".vault_commit_sha"


def _gh_headers() -> dict:
    return {
        "Authorization": f"Bearer {GITHUB_TOKEN}",
        "Accept": "application/vnd.github.v3+json",
    }


# ── Low-level GitHub API helpers ─────────────────────────────────

async def _gh_get_json(url: str) -> dict | list | None:
    """GET a GitHub API URL, return parsed JSON or None on failure."""
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.get(url, headers=_gh_headers())
            if r.status_code == 200:
                return r.json()
            log.warning(f"GH API GET {r.status_code}: {url}")
            return None
    except Exception as e:
        log.error(f"GH API GET error: {e}")
        return None


async def _gh_get_raw(url: str) -> bytes | None:
    """GET a raw URL (download), return bytes or None on failure."""
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.get(url, headers=_gh_headers())
            if r.status_code == 200:
                return r.content
            return None
    except Exception as e:
        log.error(f"GH raw download error: {e}")
        return None


async def _gh_download_file(download_url: str, local_path: Path) -> bool:
    """Download a single file from GitHub to local path."""
    content = await _gh_get_raw(download_url)
    if content is None:
        return False
    local_path.parent.mkdir(parents=True, exist_ok=True)
    local_path.write_bytes(content)
    return True


# ── Commit SHA tracking ──────────────────────────────────────────

def _read_last_sha() -> str | None:
    """Read the last known commit SHA from disk."""
    if LAST_COMMIT_FILE.exists():
        return LAST_COMMIT_FILE.read_text().strip()
    return None


def _write_last_sha(sha: str):
    """Persist the last known commit SHA."""
    LAST_COMMIT_FILE.write_text(sha)


async def _get_remote_head_sha(branch: str = "master") -> str | None:
    """Fetch the HEAD commit SHA of a branch from GitHub."""
    url = f"{GITHUB_API}/repos/{VAULT_OWNER}/{VAULT_REPO_NAME}/git/ref/heads/{branch}"
    data = await _gh_get_json(url)
    if data and isinstance(data, dict):
        return data.get("object", {}).get("sha")
    return None


# ── Delta sync (Compare API) ─────────────────────────────────────

async def get_changed_files(base_sha: str, head_sha: str) -> dict | None:
    """Use GitHub Compare API to find changed/added/removed files between two SHAs.

    Returns dict with keys: 'added', 'modified', 'removed' — each a list of file paths.
    Returns None if the compare fails (e.g., too many commits behind, use full sync).
    """
    url = f"{GITHUB_API}/repos/{VAULT_OWNER}/{VAULT_REPO_NAME}/compare/{base_sha}...{head_sha}"
    data = await _gh_get_json(url)
    if not data or not isinstance(data, dict):
        return None

    status = data.get("status")
    if status not in ("ahead", "behind", "identical", "diverged"):
        return None

    if status == "identical":
        return {"added": [], "modified": [], "removed": []}

    result = {"added": [], "modified": [], "removed": []}
    for f in data.get("files", []):
        fname = f["filename"]
        st = f.get("status", "modified")
        if st == "added":
            result["added"].append(fname)
        elif st == "removed":
            result["removed"].append(fname)
        elif st in ("modified", "renamed", "changed"):
            result["modified"].append(fname)
    return result


# ── Backup / Rollback ────────────────────────────────────────────

def backup_files(file_paths: list[str]) -> str:
    """Create timestamped backup of specific vault files. Returns backup ID."""
    backup_id = datetime.now(TZ).strftime("%Y%m%d_%H%M%S")
    backup_root = BACKUP_DIR / backup_id
    backup_root.mkdir(parents=True, exist_ok=True)

    count = 0
    for rel_path in file_paths:
        src = VAULT_DIR / rel_path
        if not src.exists():
            continue
        dst = backup_root / rel_path
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(src.read_bytes())
        count += 1

    log.info(f"Backup {backup_id}: {count} files saved")
    return backup_id


async def restore_backup(backup_id: str) -> bool:
    """Restore vault files from a backup by ID."""
    backup_root = BACKUP_DIR / backup_id
    if not backup_root.exists():
        log.error(f"Backup not found: {backup_id}")
        return False

    count = 0
    for src in backup_root.rglob("*"):
        if src.is_dir():
            continue
        rel = str(src.relative_to(backup_root)).replace("\\", "/")
        dst = VAULT_DIR / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(src.read_bytes())
        count += 1

    log.info(f"Restore {backup_id}: {count} files restored")
    return True


def prune_backups(keep: int = 10):
    """Remove old backups, keeping only the most recent `keep`."""
    if not BACKUP_DIR.exists():
        return
    backups = sorted(
        [d for d in BACKUP_DIR.iterdir() if d.is_dir()],
        key=lambda d: d.name,
        reverse=True,
    )
    for old in backups[keep:]:
        import shutil
        shutil.rmtree(str(old))
        log.info(f"Pruned old backup: {old.name}")


# ── Full vault download (fallback) ───────────────────────────────

async def sync_vault_full() -> bool:
    """Full vault download via recursive Contents API. Used as fallback."""
    async def _download_dir(repo_path: str, local_dir: Path) -> bool:
        url = f"{GITHUB_API}/repos/{VAULT_OWNER}/{VAULT_REPO_NAME}/contents/{repo_path}?ref={VAULT_BRANCH_MAIN}"
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                r = await client.get(url, headers=_gh_headers())
                if r.status_code != 200:
                    return False
                items = r.json()
                if not isinstance(items, list):
                    items = [items]
                for item in items:
                    item_path = item["path"]
                    item_type = item["type"]
                    local_path = local_dir / item_path
                    if item_type == "dir":
                        local_path.mkdir(parents=True, exist_ok=True)
                        await _download_dir(item_path, local_dir)
                    elif item_type == "file":
                        if item.get("size", 0) > 500_000:
                            continue
                        if "download_url" in item and item["download_url"]:
                            await _gh_download_file(item["download_url"], local_path)
                return True
        except Exception as e:
            log.error(f"Full download error at {repo_path}: {e}")
            return False

    VAULT_DIR.mkdir(parents=True, exist_ok=True)
    return await _download_dir("", VAULT_DIR)


# ── Delta sync (primary) ─────────────────────────────────────────

async def sync_vault_delta() -> dict | None:
    """Delta sync: only download changed files since last known SHA.

    Returns dict with 'changed' (list of file paths) on success,
    None if full sync is needed.
    """
    if not GITHUB_TOKEN:
        return None

    VAULT_DIR.mkdir(parents=True, exist_ok=True)

    remote_sha = await _get_remote_head_sha(VAULT_BRANCH_MAIN)
    if not remote_sha:
        log.warning("Could not fetch remote HEAD SHA — falling back to full sync")
        return None

    local_sha = _read_last_sha()
    if not local_sha:
        log.info("No local SHA — performing full sync, then tracking delta from now")
        ok = await sync_vault_full()
        if ok:
            _write_last_sha(remote_sha)
        return None  # caller should do full reindex

    if local_sha == remote_sha:
        log.debug("Vault SHA unchanged — no sync needed")
        return {"changed": []}

    delta = await get_changed_files(local_sha, remote_sha)
    if delta is None:
        log.warning("Compare API failed — falling back to full sync")
        ok = await sync_vault_full()
        if ok:
            _write_last_sha(remote_sha)
        return None  # caller should do full reindex

    changed = delta["added"] + delta["modified"]
    removed = delta["removed"]

    if not changed and not removed:
        _write_last_sha(remote_sha)
        return {"changed": []}

    log.info(f"Delta sync: +{len(delta['added'])} ~{len(delta['modified'])} -{len(delta['removed'])} files")

    changed_paths = []

    # Backup files that will change
    if changed:
        backup_files(changed)

    # Download changed/added files
    for fpath in changed:
        download_url = f"https://raw.githubusercontent.com/{VAULT_OWNER}/{VAULT_REPO_NAME}/{VAULT_BRANCH_MAIN}/{fpath}"
        local_path = VAULT_DIR / fpath
        if await _gh_download_file(download_url, local_path):
            changed_paths.append(fpath)
        else:
            log.warning(f"Failed to download: {fpath}")

    # Remove locally deleted files
    for fpath in removed:
        local_path = VAULT_DIR / fpath
        if local_path.exists():
            local_path.unlink()
            log.info(f"Removed: {fpath}")

    _write_last_sha(remote_sha)
    prune_backups(BACKUP_RETENTION)
    return {"changed": changed_paths}


# ── Sync + Reindex orchestration ─────────────────────────────────

async def sync_and_reindex():
    """Delta pull vault from GitHub, then incrementally reindex only changed files."""
    global _brain_map_ts
    t0 = time_mod.monotonic()
    try:
        result = await sync_vault_delta()
        duration_ms = (time_mod.monotonic() - t0) * 1000

        if result is None:
            # Full sync happened or error — reindex everything
            await reindex_all()
            # Refresh brain map after full sync
            try:
                _brain_map_ts = 0  # force rebuild
                await build_brain_map()
                log.info("Brain map rebuilt after full vault sync")
            except Exception as e:
                log.warning(f"Brain map refresh failed: {e}")
            log_sync_event("full_sync", 0, "", duration_ms, True, "full vault reindex")
        elif result["changed"]:
            # Incremental: only reindex changed files
            changed = result["changed"]
            for fpath in changed:
                await index_file(fpath)
            log.info(f"Delta reindex: {len(changed)} files")
            # Refresh brain map if structural files changed (_index.md or new dirs)
            if any(f.endswith("_index.md") or "/" not in f for f in changed):
                _brain_map_ts = 0
                await build_brain_map()
                log.info("Brain map rebuilt due to structural vault change")
            log_sync_event("delta_sync", len(changed), ", ".join(changed[:20]), duration_ms, True, "")
        else:
            log_sync_event("delta_sync", 0, "", duration_ms, True, "no changes")
    except Exception as e:
        duration_ms = (time_mod.monotonic() - t0) * 1000
        log.error(f"Sync+reindex failed: {e}")
        log_sync_event("delta_sync", 0, "", duration_ms, False, str(e)[:200])


async def sync_vault() -> bool:
    """Startup sync: delta if possible, full if needed."""
    if not GITHUB_TOKEN:
        log.warning("No GITHUB_TOKEN configured — vault sync disabled")
        return False
    try:
        await sync_and_reindex()
        return True
    except Exception as e:
        log.error(f"Vault sync error: {e}")
        return False


# ── AI writes → ai-memory branch ─────────────────────────────────

async def vault_push_file(file_path: str, content: str, message: str, branch: str = "") -> bool:
    """Push a single file to the vault repo via GitHub Contents API.

    Args:
        branch: target branch. Defaults to VAULT_BRANCH_AI for bot writes.
    """
    if not GITHUB_TOKEN:
        return False

    target_branch = branch or VAULT_BRANCH_AI

    url = f"{GITHUB_API}/repos/{VAULT_OWNER}/{VAULT_REPO_NAME}/contents/{file_path}"
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            sha = None
            r = await client.get(f"{url}?ref={target_branch}", headers=_gh_headers())
            if r.status_code == 200:
                sha = r.json().get("sha")

            body = {
                "message": f"[hermes-bot] {message}",
                "content": base64.b64encode(content.encode("utf-8")).decode("ascii"),
                "branch": target_branch,
            }
            if sha:
                body["sha"] = sha

            r = await client.put(url, headers=_gh_headers(), json=body)
            if r.status_code in (200, 201):
                log.info(f"Bot pushed to {target_branch}: {file_path}")
                log_sync_event("bot_push", 1, file_path, 0, True, f"branch={target_branch}")
                return True
            else:
                log.error(f"Push failed ({r.status_code}): {r.text[:200]}")
                log_sync_event("bot_push", 0, file_path, 0, False, f"HTTP {r.status_code}")
                return False
    except Exception as e:
        log.error(f"Push error: {e}")
        log_sync_event("bot_push", 0, file_path, 0, False, str(e)[:200])
        return False


async def vault_commit_push(file_path: str, message: str) -> bool:
    """Push a vault file to the ai-memory branch via GitHub API."""
    if not GITHUB_TOKEN:
        return False

    local_path = VAULT_DIR / file_path
    try:
        if not local_path.exists():
            log.warning(f"Local file not found for push: {file_path}")
            return False
        content = local_path.read_text(encoding="utf-8")
        ok = await vault_push_file(file_path, content, message)
        return ok
    except Exception as e:
        log.error(f"Vault commit/push error: {e}")
        return False


# ── Cron: periodic delta sync ────────────────────────────────────

async def cron_vault_pull():
    """Pull latest vault changes via delta sync (runs every 30 min)."""
    if not GITHUB_TOKEN:
        log.warning("Vault pull skipped: GITHUB_TOKEN not configured")
        return
    VAULT_DIR.mkdir(parents=True, exist_ok=True)
    if not any(VAULT_DIR.iterdir()):
        log.info("Vault empty — performing full sync from GitHub...")
        ok = await sync_vault_full()
        if ok:
            await reindex_all()
        else:
            log.error("Initial vault full sync FAILED")
        return
    log.info("Vault auto-pull: delta sync from GitHub...")
    await sync_and_reindex()


# ── Semantic Retrieval (RAG) ─────────────────────────────────────
_rag_available: bool = False
_collection: object = None


def _get_chroma_collection():
    """Lazy-init ChromaDB collection with ONNX embeddings. Returns None on failure."""
    global _rag_available, _collection
    if _collection is not None:
        return _collection

    try:
        import chromadb
        from chromadb.utils import embedding_functions

        client = chromadb.PersistentClient(path=str(CHROMA_DIR))
        ef = embedding_functions.DefaultEmbeddingFunction()
        _collection = client.get_or_create_collection(
            name=CHROMA_COLLECTION_NAME,
            embedding_function=ef,
        )
        _rag_available = True
        log.info("ChromaDB RAG collection ready")
        return _collection
    except Exception as e:
        log.warning(f"ChromaDB init failed (RAG disabled): {e}")
        _rag_available = False
        return None


def _chunk_markdown(text: str, file_path: str, zone: str) -> list[dict]:
    """Split markdown into overlapping chunks with metadata."""
    paragraphs = text.split("\n\n")
    chunks = []
    current = ""
    idx = 0

    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
        if len(current) + len(para) + 2 > CHUNK_SIZE and current:
            chunks.append({
                "id": f"{file_path}#chunk{idx}",
                "text": current.strip(),
                "metadata": {"path": file_path, "zone": zone, "chunk_idx": idx},
            })
            idx += 1
            # Overlap: keep last ~overlap chars of previous chunk
            if len(current) > CHUNK_OVERLAP:
                current = current[-CHUNK_OVERLAP:] + "\n\n" + para
            else:
                current = para
        else:
            current = current + "\n\n" + para if current else para

    if current.strip():
        chunks.append({
            "id": f"{file_path}#chunk{idx}",
            "text": current.strip(),
            "metadata": {"path": file_path, "zone": zone, "chunk_idx": idx},
        })

    return chunks


async def index_file(vault_rel_path: str):
    """Index a single vault file into ChromaDB."""
    collection = _get_chroma_collection()
    if collection is None:
        return

    full_path = VAULT_DIR / vault_rel_path
    try:
        if not full_path.exists() or not full_path.suffix == ".md":
            return
        if full_path.stat().st_size > 200_000:
            log.info(f"RAG: skipping large file {vault_rel_path}")
            return

        text = full_path.read_text(encoding="utf-8")
        zone = resolve_zone(vault_rel_path)
        chunks = _chunk_markdown(text, vault_rel_path, zone)

        if not chunks:
            return

        # Remove old chunks for this file, add new ones
        try:
            collection.delete(where={"path": vault_rel_path})
        except Exception:
            pass

        collection.add(
            ids=[c["id"] for c in chunks],
            documents=[c["text"] for c in chunks],
            metadatas=[c["metadata"] for c in chunks],
        )
        log.info(f"RAG: indexed {vault_rel_path} ({len(chunks)} chunks)")
    except Exception as e:
        log.warning(f"RAG: failed to index {vault_rel_path}: {e}")


async def reindex_all():
    """Re-index all vault .md files into ChromaDB."""
    if not VAULT_DIR.exists() or not any(VAULT_DIR.iterdir()):
        return

    collection = _get_chroma_collection()
    if collection is None:
        return

    try:
        # Clear existing index
        existing = collection.get()
        if existing and existing.get("ids"):
            collection.delete(ids=existing["ids"])
    except Exception:
        pass

    count = 0
    for md_file in sorted(VAULT_DIR.rglob("*.md")):
        rel = str(md_file.relative_to(VAULT_DIR)).replace("\\", "/")
        await index_file(rel)
        count += 1

    log.info(f"RAG: reindexed {count} vault files")


async def retrieve_relevant_chunks(query: str, top_k: int = RAG_TOP_K) -> list[dict]:
    """Retrieve top-k relevant chunks from the vault for a query."""
    if not _rag_available:
        return []

    collection = _get_chroma_collection()
    if collection is None:
        return []

    try:
        results = collection.query(query_texts=[query], n_results=top_k)
        if not results or not results.get("documents") or not results["documents"][0]:
            return []

        chunks = []
        docs = results["documents"][0]
        metas = results["metadatas"][0] if results.get("metadatas") else [[] for _ in docs]
        for doc, meta in zip(docs, metas):
            chunks.append({"text": doc, "metadata": meta or {}})
        return chunks
    except Exception as e:
        log.warning(f"RAG retrieval error: {e}")
        return []


logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(message)s",
    level=logging.INFO,
)
log = logging.getLogger("hermes")

# ── FastAPI app ─────────────────────────────────────────────────
api = FastAPI(title="Hermes Telegram V3", version="3.0.0")


@api.get("/")
def root():
    return {
        "status": "online",
        "service": "hermes-telegram-v2",
        "model": DEEPSEEK_MODEL,
        "time": datetime.now(TZ).isoformat(),
    }


@api.get("/health")
def health():
    """Enhanced health check with sync status."""
    result = {"status": "healthy"}
    # Add last sync info if available
    last_sha = _read_last_sha()
    if last_sha:
        result["vault_sha"] = last_sha[:7]
    if LAST_COMMIT_FILE.exists():
        result["last_sync"] = datetime.fromtimestamp(
            LAST_COMMIT_FILE.stat().st_mtime, tz=TZ
        ).isoformat()
    # Add sync stats from DB
    try:
        if OBS_DB.exists():
            conn = sqlite3.connect(str(OBS_DB))
            conn.row_factory = sqlite3.Row
            last = conn.execute(
                "SELECT timestamp, event_type, files_changed FROM sync_events "
                "WHERE success = 1 ORDER BY id DESC LIMIT 1"
            ).fetchone()
            if last:
                result["last_sync_event"] = {
                    "timestamp": last["timestamp"],
                    "type": last["event_type"],
                    "files": last["files_changed"],
                }
            conn.close()
    except Exception:
        pass
    return result


@api.post("/notify")
async def notify_daniel(request: Request):
    """Bridge: Claude Code → Telegram. Sends a message to Daniel's chat."""
    if not NOTIFY_SECRET:
        return Response(
            status_code=500,
            content=json.dumps({"error": "NOTIFY_SECRET not configured"}),
            media_type="application/json",
        )

    auth = request.headers.get("authorization", "")
    if auth != f"Bearer {NOTIFY_SECRET}":
        return Response(
            status_code=403,
            content=json.dumps({"error": "unauthorized"}),
            media_type="application/json",
        )

    try:
        body = await request.json()
        message = body.get("message", "").strip()
        if not message:
            return Response(
                status_code=400,
                content=json.dumps({"error": "message is required"}),
                media_type="application/json",
            )
    except Exception:
        return Response(
            status_code=400,
            content=json.dumps({"error": "invalid JSON"}),
            media_type="application/json",
        )

    telegram_url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            telegram_url,
            json={"chat_id": CHAT_ID, "text": message, "parse_mode": "Markdown"},
            timeout=10,
        )

    if resp.status_code == 200:
        return {"status": "sent"}
    else:
        log.error(f"Notify failed: {resp.text}")
        return Response(
            status_code=502,
            content=json.dumps({"error": "telegram API failed"}),
            media_type="application/json",
        )


@api.post("/webhook/github")
async def github_webhook(request: Request):
    """Receive GitHub push events via webhook, trigger delta vault sync with debounce."""
    global _last_webhook_time

    if not WEBHOOK_SECRET:
        return Response(
            status_code=500,
            content=json.dumps({"error": "webhook not configured"}),
            media_type="application/json",
        )

    signature = request.headers.get("x-hub-signature-256", "")
    if not signature:
        return Response(
            status_code=400,
            content=json.dumps({"error": "missing signature"}),
            media_type="application/json",
        )

    body = await request.body()
    expected = "sha256=" + hmac.new(
        WEBHOOK_SECRET.encode(), body, hashlib.sha256
    ).hexdigest()

    if not hmac.compare_digest(signature, expected):
        return Response(
            status_code=401,
            content=json.dumps({"error": "invalid signature"}),
            media_type="application/json",
        )

    event = request.headers.get("x-github-event", "")
    if event == "ping":
        return {"status": "ok", "event": "ping", "message": "webhook configured correctly"}

    if event != "push":
        return {"status": "ignored", "event": event}

    # Debounce: ignore rapid consecutive pushes within WEBHOOK_DEBOUNCE_S
    now = time_mod.monotonic()
    if now - _last_webhook_time < WEBHOOK_DEBOUNCE_S:
        log.info("Webhook debounced — too soon since last push")
        return {"status": "debounced", "reason": f"within {WEBHOOK_DEBOUNCE_S}s window"}
    _last_webhook_time = now

    log.info("Webhook: push event — triggering delta sync")
    log_sync_event("webhook_received", 0, "", 0, True, "push event")
    asyncio.create_task(sync_and_reindex())
    return {"status": "accepted", "action": "delta_sync"}


@api.post("/api/admin/revert")
async def admin_revert(request: Request):
    """Restore vault from a backup snapshot. Protected by NOTIFY_SECRET."""
    if not NOTIFY_SECRET:
        return Response(
            status_code=500,
            content=json.dumps({"error": "NOTIFY_SECRET not configured"}),
            media_type="application/json",
        )

    auth = request.headers.get("authorization", "")
    if auth != f"Bearer {NOTIFY_SECRET}":
        return Response(
            status_code=403,
            content=json.dumps({"error": "unauthorized"}),
            media_type="application/json",
        )

    try:
        body = await request.json()
        backup_id = body.get("backup_id", "").strip()
    except Exception:
        return Response(
            status_code=400,
            content=json.dumps({"error": "invalid JSON"}),
            media_type="application/json",
        )

    if not backup_id:
        backups = sorted(
            [d.name for d in BACKUP_DIR.iterdir() if d.is_dir()],
            reverse=True,
        ) if BACKUP_DIR.exists() else []
        return {"backups": backups[:10], "total": len(backups)}

    ok = await restore_backup(backup_id)
    if ok:
        log_sync_event("rollback", 0, backup_id, 0, True, "manual revert")
        return {"status": "restored", "backup_id": backup_id}
    else:
        return Response(
            status_code=404,
            content=json.dumps({"error": f"backup not found: {backup_id}"}),
            media_type="application/json",
        )


@api.get("/api/admin/crons")
async def admin_crons(request: Request):
    """Return status of all scheduled cron jobs. Protected by NOTIFY_SECRET."""
    if NOTIFY_SECRET:
        auth = request.headers.get("authorization", "")
        if auth != f"Bearer {NOTIFY_SECRET}":
            return Response(
                status_code=403,
                content=json.dumps({"error": "unauthorized"}),
                media_type="application/json",
            )

    jobs = []
    now = datetime.now(TZ)

    if _scheduler:
        for job in _scheduler.get_jobs():
            last_run = job.next_run_time
            # Fetch last execution from DB
            last_exec = {"timestamp": None, "duration_ms": None, "success": None, "error": None}
            try:
                conn = sqlite3.connect(str(OBS_DB))
                row = conn.execute(
                    "SELECT timestamp, duration_ms, success, error FROM cron_executions "
                    "WHERE job_id=? ORDER BY id DESC LIMIT 1",
                    (job.id,),
                ).fetchone()
                conn.close()
                if row:
                    last_exec = {
                        "timestamp": row[0],
                        "duration_ms": row[1],
                        "success": bool(row[2]),
                        "error": row[3] if row[3] else None,
                    }
            except Exception:
                pass

            jobs.append({
                "id": job.id,
                "name": job.name,
                "next_run": str(job.next_run_time) if job.next_run_time else None,
                "trigger": str(job.trigger),
                "last_execution": last_exec,
            })

    return {
        "total": len(jobs),
        "server_time": now.isoformat(),
        "jobs": jobs,
    }


# ── Memory ──────────────────────────────────────────────────────
def load_memory() -> dict[str, str]:
    """Load all memory files into a dict {filename: content}."""
    memory = {}
    if MEMORY_DIR.exists():
        for f in sorted(MEMORY_DIR.glob("*.md")):
            content = f.read_text(encoding="utf-8")
            memory[f.name] = content
    return memory


# ── DeepSeek Client ─────────────────────────────────────────────
TOOLS = [
    {
        "name": "read_file",
        "description": "Lee el contenido de un archivo. Usalo para consultar estado de proyectos, leer logs, o obtener informacion detallada.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Ruta del archivo relativa al directorio del proyecto (ej: memory/leaderforge-digital-project.md)",
                }
            },
            "required": ["path"],
        },
    },
    {
        "name": "write_file",
        "description": "Crea o sobrescribe un archivo. Usalo para guardar notas, actualizar archivos de memoria, o crear documentos nuevos. NO lo uses para modificar main.py u otros archivos de codigo del bot. Restricciones por zona: Core (raiz, .obsidian/, Sistemas/, Estrategia/) es SOLO LECTURA. Projects (Proyectos/, Clientes/) solo modificar existentes. Daily solo append. AI-Proposals/ y Logs/ tienen escritura libre.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Ruta del archivo relativa al directorio del proyecto. NO escribas a archivos raiz del vault ni a Sistemas/ o Estrategia/.",
                },
                "content": {
                    "type": "string",
                    "description": "Contenido a escribir en el archivo",
                },
            },
            "required": ["path", "content"],
        },
    },
    {
        "name": "list_directory",
        "description": "Lista archivos y directorios en una ruta dada.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Ruta del directorio relativa al proyecto (usa '.' para raiz)",
                }
            },
            "required": ["path"],
        },
    },
    {
        "name": "append_daily_log",
        "description": "Agrega una entrada al archivo de registro diario en vault/Daily/. Solo append — no sobrescribe. Usa esto para registrar actividades diarias.",
        "input_schema": {
            "type": "object",
            "properties": {
                "entry": {
                    "type": "string",
                    "description": "Texto a agregar al daily log de hoy en vault/Daily/",
                }
            },
            "required": ["entry"],
        },
    },
    {
        "name": "firecrawl_search",
        "description": "Busca en internet usando Firecrawl. Usa esto para investigar temas actuales, buscar informacion de mercado, competidores, noticias, o cualquier dato que necesites de la web. Ideal para research de proyectos, analisis de competencia, y verificacion de datos.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "La consulta de busqueda (ej: 'mejores practicas de marketing para roofing 2025')",
                },
                "limit": {
                    "type": "integer",
                    "description": "Numero maximo de resultados (default: 5, max: 10)",
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "firecrawl_scrape",
        "description": "Extrae el contenido completo de una URL especifica. Usa esto para leer articulos, paginas de competidores, documentacion, o cualquier pagina web que necesites analizar en profundidad. NO uses para sitios que requieren login.",
        "input_schema": {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "URL completa de la pagina a extraer (ej: 'https://example.com/article')",
                },
            },
            "required": ["url"],
        },
    },
]


class DeepSeekClient:
    """Async client for DeepSeek's Anthropic-compatible endpoint."""

    def __init__(self):
        self.api_key = DEEPSEEK_API_KEY
        self.base_url = DEEPSEEK_BASE_URL.rstrip("/")
        self.model = DEEPSEEK_MODEL
        self.flash_model = DEEPSEEK_FLASH_MODEL

    async def chat(
        self,
        system_prompt: str,
        messages: list[dict],
        tools: list[dict] | None = None,
        source: str = "chat",
    ) -> tuple[str, list[dict]]:
        """Send chat request. Returns (text_response, tool_calls). Logs to observability DB."""
        if not self.api_key:
            return "Error: DEEPSEEK_API_KEY no configurada.", [], []

        model = self.model
        payload = {
            "model": model,
            "max_tokens": 2048,
            "system": system_prompt,
            "messages": messages,
        }
        if tools:
            payload["tools"] = tools

        t0 = time_mod.monotonic()
        try:
            async with httpx.AsyncClient(timeout=90.0) as client:
                response = await client.post(
                    f"{self.base_url}/v1/messages",
                    headers={
                        "Authorization": f"Bearer {self.api_key}",
                        "Content-Type": "application/json",
                    },
                    json=payload,
                )
                latency_ms = (time_mod.monotonic() - t0) * 1000

                if response.status_code != 200:
                    log.error(f"DeepSeek API error {response.status_code}: {response.text[:300]}")
                    log_api_call(model, 0, 0, latency_ms, success=False, source=source)
                    return f"Error de API (HTTP {response.status_code}). Intenta de nuevo.", []

                data = response.json()

            # Extract usage
            usage = data.get("usage", {})
            prompt_tokens = usage.get("input_tokens", 0)
            completion_tokens = usage.get("output_tokens", 0)
            log_api_call(model, prompt_tokens, completion_tokens, latency_ms, source=source)

            # Extract text, tool calls, and preserve all content blocks for conversation continuity
            text_parts = []
            tool_calls = []
            content_blocks = data.get("content", [])
            for block in content_blocks:
                if block["type"] == "text":
                    text_parts.append(block["text"])
                elif block["type"] == "tool_use":
                    tool_calls.append({
                        "id": block["id"],
                        "name": block["name"],
                        "input": block["input"],
                    })

            return "\n".join(text_parts), tool_calls, content_blocks

        except httpx.TimeoutException:
            latency_ms = (time_mod.monotonic() - t0) * 1000
            log.error("DeepSeek API timeout")
            log_api_call(model, 0, 0, latency_ms, success=False, source=source)
            return "El servicio de IA tardo demasiado en responder. Intenta de nuevo.", [], []
        except Exception as e:
            latency_ms = (time_mod.monotonic() - t0) * 1000
            log.error(f"DeepSeek API exception: {e}")
            log_api_call(model, 0, 0, latency_ms, success=False, source=source)
            return f"Error de conexion con la IA. El bot seguira funcionando con respuestas basicas.", [], []


deepseek = DeepSeekClient()


# ── Brain Map ────────────────────────────────────────────────────
_brain_map_cache: str = ""
_brain_map_ts: float = 0.0

async def build_brain_map() -> str:
    """Scan the entire vault and build a hierarchical brain map.
    Cached for 1 hour to avoid excessive I/O on every message."""
    global _brain_map_cache, _brain_map_ts
    now_ts = time_mod.monotonic()
    if _brain_map_cache and (now_ts - _brain_map_ts) < 3600:
        return _brain_map_cache

    if not VAULT_DIR.exists() or not any(VAULT_DIR.iterdir()):
        return ""

    lines = ["## Mapa del Cerebro (Vault Completo)"]
    lines.append("Estructura completa de todos los archivos disponibles:\n")

    def scan_dir(dir_path: Path, prefix: str = "", depth: int = 0) -> None:
        if depth > 3:
            return
        try:
            items = sorted(dir_path.iterdir(), key=lambda x: (x.is_file(), x.name.lower()))
        except (OSError, PermissionError):
            return

        dirs = [i for i in items if i.is_dir() and not i.name.startswith(".")]
        files = [i for i in items if i.is_file() and i.name.endswith(".md")]

        for d in dirs:
            lines.append(f"{prefix}📁 {d.name}/")
            scan_dir(d, prefix + "  ", depth + 1)

        for f in files[:15]:  # max 15 files per dir to keep map manageable
            try:
                size_kb = f.stat().st_size // 1024
                # Read first line (title) for context
                first_line = ""
                with open(f, "r", encoding="utf-8") as fh:
                    for i, line in enumerate(fh):
                        if i >= 3:
                            break
                        stripped = line.strip()
                        if stripped and not stripped.startswith("---"):
                            first_line = stripped[:80]
                            break
                if first_line:
                    lines.append(f"{prefix}📄 {f.name} ({size_kb}KB) — {first_line}")
                else:
                    lines.append(f"{prefix}📄 {f.name} ({size_kb}KB)")
            except Exception:
                lines.append(f"{prefix}📄 {f.name}")

    scan_dir(VAULT_DIR)

    lines.append(f"\nPuedo usar `read_file` para leer cualquier archivo listado arriba.")
    lines.append(f"Para buscar temas especificos, usa `list_directory` para explorar carpetas.")

    result = "\n".join(lines)
    if len(result) > 4000:
        result = result[:4000] + "\n\n... [mapa truncado — usa list_directory para explorar]"

    _brain_map_cache = result
    _brain_map_ts = now_ts
    return result


# ── System Prompt ───────────────────────────────────────────────
async def build_system_prompt(query: str | None = None) -> str:
    """Build context prompt with RAG retrieval (or fallback to memory/ vault files)."""
    now = datetime.now(TZ)

    # Build the context section — either from RAG or fallback
    context_section = ""

    if query and _rag_available:
        chunks = await retrieve_relevant_chunks(query, RAG_TOP_K)
        if chunks:
            lines = ["## Contexto Relevante del Vault (RAG)"]
            for c in chunks:
                path = c["metadata"].get("path", "desconocido")
                zone = c["metadata"].get("zone", "logs")
                lines.append(f"\n<!-- vault:{path} zone:{zone} -->\n{c['text']}")
            lines.append("\nUsa read_file si necesitas mas detalles de cualquier archivo.")
            context_section = "\n".join(lines)

    # Always include the brain map
    brain_map = await build_brain_map()

    if not context_section:
        # Dynamic context: scan vault for ALL projects and clients
        mem = load_memory()
        context_lines = []

        def safe_read(path: Path, max_chars: int = 2000) -> str | None:
            if path.exists():
                content = path.read_text(encoding="utf-8")
                if len(content) > max_chars:
                    content = content[:max_chars] + "\n... [truncado]"
                return content
            return None

        # Scan Proyectos/
        proyectos_dir = VAULT_DIR / "Proyectos"
        if proyectos_dir.exists():
            context_lines.append("## Proyectos")
            for proj_dir in sorted(proyectos_dir.iterdir()):
                if proj_dir.is_dir():
                    idx = proj_dir / "_index.md"
                    content = safe_read(idx, max_chars=2500)
                    if content:
                        context_lines.append(f"\n### {proj_dir.name}\n{content}")
                    else:
                        context_lines.append(f"\n### {proj_dir.name}\n(Carpeta detectada — sin _index.md)")
            # Also check memory for any project not in vault
            for mem_key, mem_content in mem.items():
                if "project" in mem_key.lower() or "proyecto" in mem_key.lower():
                    proj_name = mem_key.replace(".md", "").replace("-project", "").replace("proyecto-", "")
                    if not any(proj_name.lower() in line.lower() for line in context_lines):
                        context_lines.append(f"\n### {proj_name} (memoria)\n{mem_content[:1500]}")

        # Scan Clientes/
        clientes_dir = VAULT_DIR / "Clientes"
        if clientes_dir.exists():
            context_lines.append("\n## Clientes")
            for client_file in sorted(clientes_dir.glob("*.md")):
                if client_file.name.startswith("_"):
                    continue  # skip templates
                content = safe_read(client_file, max_chars=2000)
                if content:
                    context_lines.append(f"\n### {client_file.stem}\n{content}")

        context_section = "\n".join(context_lines) if context_lines else "No se encontraron proyectos ni clientes en el vault."

        # Fallback: if vault is empty, use memory
        if not context_lines or context_section == "No se encontraron proyectos ni clientes en el vault.":
            mem_context = []
            for k, v in mem.items():
                mem_context.append(f"### {k.replace('.md','')}\n{v[:1500]}")
            if mem_context:
                context_section = "## Proyectos (desde memoria — vault no disponible)\n\n" + "\n\n".join(mem_context)

    prompt = f"""Eres Hermes, el asesor principal de Daniel — un emprendedor en Estados Unidos que construye sitios web para negocios locales de oficios (roofing, welding, HVAC, plumbing). Tu proposito es ser su mano derecha 24/7 desde Telegram.

## Mision
Generar $1,000,000 USD de ganancia para Daniel. Cada decision debe evaluarse contra esa meta.

{brain_map}

{context_section}

## Tu rol
- **Asesor de negocios**: analizas el panorama, recomiendas prioridades, identificas oportunidades
- **Gestor de operaciones**: supervisas pipelines, detectas problemas, sugieres mejoras
- **Guardián del cerebro**: mantienes el vault de Obsidian organizado y actualizado. El vault se sincroniza circularmente: Obsidian (laptop) → GitHub → Railway → GitHub → Obsidian. Tus writes van a la rama `ai-memory` y Daniel las revisa. La sincronizacion es delta-based cada 30 min + webhooks instantaneos.
- **Investigador**: usas firecrawl_search y firecrawl_scrape para buscar informacion actualizada en internet cuando Daniel te lo pide.
- **Auto-aprendizaje**: cuando Daniel comparte nuevas ideas, decisiones, o informacion relevante, PROPON guardarlo. Dile: \"¿Guardo esto en AI-Proposals/?\" o \"¿Agrego esto al daily log?\". Si el te dice que si, usa write_file o append_daily_log inmediatamente.

## Estrategia de Ramas
- **master**: controlado por Daniel (fuente de verdad). Tu lees de aqui.
- **ai-memory**: rama donde TU escribes. Nunca se hace merge automatico a master.
- Daniel revisa y mergea manualmente los cambios de ai-memory → master.
- Cuando usas `write_file`, tu contenido va a la rama `ai-memory`. Esto protege el vault humano de escrituras automaticas no revisadas.

## Zonas del Vault (PERMISOS ESTRICTOS)
El vault tiene 5 zonas con permisos diferentes. RESPETALOS o tus herramientas fallaran:

| Zona | Carpetas | Permiso |
|---|---|---|
| **Core** | raiz (.md), .obsidian/, Sistemas/, Estrategia/, Marketing/ | SOLO LECTURA — nunca intentes escribir aqui |
| **Projects** | Proyectos/, Clientes/ | Lectura + actualizar existentes (no crear nuevos) |
| **AI-Proposals** | AI-Proposals/ | Lectura y escritura libre — usa para propuestas |
| **Daily** | Daily/ | Solo append_daily_log (nunca write_file) |
| **Logs** | Logs/ | Lectura y escritura libre |

Si necesitas modificar un archivo Core, crea una propuesta en AI-Proposals/ y Daniel la revisara.

## Herramientas disponibles
- `read_file` — leer archivos del vault para consultar detalles (sin restricciones de zona, hasta 20K chars)
- `write_file` — crear/actualizar archivos (RESPETA las zonas — Core y Daily rechazaran la escritura). Tus writes van a la rama `ai-memory`.
- `list_directory` — explorar directorios del vault
- `append_daily_log` — agregar entrada al daily log en vault/Daily/
- `firecrawl_search` — BUSCAR EN INTERNET. Usala para investigar temas actuales, tendencias de mercado, competidores, noticias. Ideal para research de proyectos y verificacion de datos.
- `firecrawl_scrape` — EXTRAER contenido completo de una URL. Usala para leer articulos, documentacion, paginas de competidores. NO para sitios con login.

## Reglas
1. Responde SIEMPRE en español, en un tono directo y profesional. Se el asistente mas util que puedas ser.
2. Se PROACTIVO: si detectas algo urgente, una oportunidad de negocio, o informacion que deberia guardarse, señálalo sin esperar. PREGUNTA si quieres guardar algo.
3. AUTO-GUARDA: cuando Daniel comparta una decision, idea, o cambio de rumbo, PROPON guardarlo en el vault. Frases clave: \"¿Guardo esto en AI-Proposals/?\" o \"Voy a registrar esto en el daily log.\" Si Daniel acepta, ejecuta la escritura.
4. INVESTIGA: usa firecrawl_search para buscar en internet cuando necesites datos actuales. NO adivines — busca.
5. LEE antes de responder: si una pregunta requiere contexto del vault, usa read_file PRIMERO, luego responde. No respondas con informacion incompleta.
6. Se conciso: ve al grano, el canal es Telegram. Pero no sacrifiques precision por brevedad.
7. Para ejecutar codigo, modificar sitios web, o hacer deploys, indicale a Daniel que use Claude Code en su laptop.
8. El vault es la fuente de verdad. Si hay conflicto entre memoria/ y vault/, el vault gana.
9. El sistema circular: Obsidian Git (auto-commit 5 min) → GitHub → Webhook instantaneo → Railway (delta sync 30 min) → ai-memory branch → Daniel revisa → merge a master.
10. Puedes escribir en AI-Proposals/ y Logs/ libremente. En Daily/ solo con append_daily_log. En Proyectos/ solo actualizar archivos existentes. Core (Sistemas/, Estrategia/) es solo lectura.

Fecha y hora actual: {now.strftime('%Y-%m-%d %H:%M')} PT
"""

    return prompt


# ── Tool Execution ──────────────────────────────────────────────
async def execute_tool(name: str, inputs: dict) -> str:
    """Execute a tool call and return result string."""
    try:
        if name == "read_file":
            path = inputs.get("path", "")
            full_path = (PROJECT_ROOT / path).resolve()
            # Security: only allow reading within project root
            if not str(full_path).startswith(str(PROJECT_ROOT.resolve())):
                return f"Error: acceso denegado a ruta fuera del proyecto: {path}"
            if not full_path.exists():
                return f"Error: archivo no encontrado: {path}"
            content = full_path.read_text(encoding="utf-8")
            if len(content) > 20000:
                content = content[:20000] + "\n... [truncado]"
            return content

        elif name == "firecrawl_search":
            query = inputs.get("query", "")
            limit = int(inputs.get("limit", 5))
            if not FIRECRAWL_API_KEY:
                return "Error: FIRECRAWL_API_KEY no configurada en Railway."
            try:
                async with httpx.AsyncClient(timeout=30.0) as client:
                    resp = await client.post(
                        f"{FIRECRAWL_BASE_URL}/v1/search",
                        headers={"Authorization": f"Bearer {FIRECRAWL_API_KEY}", "Content-Type": "application/json"},
                        json={"query": query, "limit": min(limit, 10), "sources": [{"type": "web"}]},
                    )
                    if resp.status_code != 200:
                        return f"Firecrawl search error HTTP {resp.status_code}: {resp.text[:200]}"
                    data = resp.json()
                    if not data.get("success"):
                        return f"Firecrawl search failed: {data}"
                    results = data.get("data", {}).get("web", [])
                    if not results:
                        return "Firecrawl search: 0 resultados encontrados."
                    lines = [f"Resultados para '{query}':"]
                    for r in results[:limit]:
                        lines.append(f"- {r.get('title','')}: {r.get('url','')}\n  {r.get('description','')[:200]}")
                    return "\n".join(lines)
            except Exception as e:
                return f"Firecrawl search error: {str(e)[:300]}"

        elif name == "firecrawl_scrape":
            url = inputs.get("url", "")
            if not FIRECRAWL_API_KEY:
                return "Error: FIRECRAWL_API_KEY no configurada en Railway."
            try:
                async with httpx.AsyncClient(timeout=30.0) as client:
                    resp = await client.post(
                        f"{FIRECRAWL_BASE_URL}/v1/scrape",
                        headers={"Authorization": f"Bearer {FIRECRAWL_API_KEY}", "Content-Type": "application/json"},
                        json={"url": url, "formats": ["markdown"]},
                    )
                    if resp.status_code != 200:
                        return f"Firecrawl scrape error HTTP {resp.status_code}: {resp.text[:200]}"
                    data = resp.json()
                    if not data.get("success"):
                        return f"Firecrawl scrape failed: {data}"
                    md = data.get("data", {}).get("markdown", "")
                    if not md:
                        return f"Firecrawl scrape: pagina extraida pero sin contenido markdown."
                    if len(md) > 6000:
                        md = md[:6000] + "\n\n... [truncado — usa firecrawl_scrape con otra URL o firecrawl_search para mas info]"
                    return md
            except Exception as e:
                return f"Firecrawl scrape error: {str(e)[:300]}"

        elif name == "write_file":
            path = inputs.get("path", "")
            content = inputs.get("content", "")
            full_path = (PROJECT_ROOT / path).resolve()
            # Security: only allow writing within project root, exclude main.py
            if not str(full_path).startswith(str(PROJECT_ROOT.resolve())):
                return f"Error: acceso denegado a ruta fuera del proyecto: {path}"
            if full_path.name == "main.py":
                return "Error: no se permite modificar main.py. Usa write_file solo para archivos de memoria/documentacion."

            # Zone permission check for vault files
            vault_rel = vault_relative_path(path)
            if vault_rel is not None:
                is_create = not full_path.exists()
                allowed, reason = check_vault_permission(vault_rel, "write", is_create)
                if not allowed:
                    return f"Error: {reason}"

            full_path.parent.mkdir(parents=True, exist_ok=True)
            full_path.write_text(content, encoding="utf-8")
            log.info(f"Tool write_file: {path} ({len(content)} chars)")

            # Auto-sync to GitHub if file is in the vault
            result_msg = f"Archivo escrito exitosamente: {path} ({len(content)} caracteres)"
            if vault_rel is not None:
                pushed = await vault_commit_push(vault_rel, f"update {vault_rel}")
                if pushed:
                    result_msg += "\nSincronizado a GitHub."
                else:
                    result_msg += "\n(No se pudo sincronizar a GitHub — cambios solo locales)"

            return result_msg

        elif name == "list_directory":
            path = inputs.get("path", ".")
            full_path = (PROJECT_ROOT / path).resolve()
            if not str(full_path).startswith(str(PROJECT_ROOT.resolve())):
                return f"Error: acceso denegado a ruta fuera del proyecto: {path}"
            if not full_path.exists():
                return f"Error: directorio no encontrado: {path}"
            items = []
            for item in sorted(full_path.iterdir()):
                suffix = "/" if item.is_dir() else ""
                size = f" ({item.stat().st_size:,} bytes)" if item.is_file() else ""
                items.append(f"  {item.name}{suffix}{size}")
            return "\n".join(items) if items else "(directorio vacio)"

        elif name == "append_daily_log":
            entry = inputs.get("entry", "")
            today = datetime.now(TZ).strftime("%Y-%m-%d")
            daily_rel = f"Daily/{today}.md"

            # Zone permission check
            allowed, reason = check_vault_permission(daily_rel, "append")
            if not allowed:
                return f"Error: {reason}"

            log_path = VAULT_DIR / daily_rel
            log_path.parent.mkdir(parents=True, exist_ok=True)
            timestamp = datetime.now(TZ).strftime("%H:%M")
            line = f"\n- **{timestamp}** {entry}\n"
            with open(log_path, "a", encoding="utf-8") as f:
                f.write(line)
            log.info(f"Tool append_daily_log: {entry[:80]}...")

            # Auto-sync to GitHub
            result_msg = f"Entrada agregada al daily log {today}.md"
            pushed = await vault_commit_push(daily_rel, f"update daily log {today}")
            if pushed:
                result_msg += "\nSincronizado a GitHub."
            return result_msg

        else:
            return f"Error: herramienta desconocida: {name}"

    except Exception as e:
        log.error(f"Tool execution error ({name}): {e}")
        return f"Error ejecutando {name}: {str(e)}"


# ── Conversation Handler ───────────────────────────────────────
async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE, override_text: str | None = None):
    """Unified handler: all messages go through DeepSeek with memory context.

    Args:
        override_text: If provided, use this instead of update.message.text.
                       Used by voice handler to pass transcript directly.
    """
    chat_id = update.effective_chat.id
    user_text = override_text if override_text is not None else (update.message.text.strip() if update.message.text else "")
    log.info(f"Message from {chat_id}: {user_text[:100]}")

    if not user_text:
        return

    # ═══════════════════════════════════════════════════════════════
    # /railway commands — handled locally, no DeepSeek call needed
    # ═══════════════════════════════════════════════════════════════
    if user_text.startswith("/railway"):
        await handle_railway_command(update, context, user_text)
        return

    try:
        # Check for pending confirmation response
        if chat_id in pending_confirmations:
            await process_confirmation(update, user_text.lower())
            return

        # Build context (pass query for RAG retrieval)
        system_prompt = await build_system_prompt(query=user_text)
        messages = [{"role": "user", "content": user_text}]

        # Call DeepSeek with tools
        text, tool_calls, content_blocks = await deepseek.chat(
            system_prompt, messages, tools=TOOLS
        )

        # Process tool calls and handle write_file confirmation
        await process_tool_loop(update, system_prompt, messages, text, tool_calls, content_blocks, round_num=0)
    except Exception as e:
        log.error(f"Unhandled error in handle_message: {e}", exc_info=True)
        try:
            await update.message.reply_text(
                "Perdon, hubo un error interno. Estoy de vuelta — intenta de nuevo."
            )
        except Exception:
            pass


async def process_tool_loop(update: Update, system_prompt: str, messages: list,
                            text: str, tool_calls: list, content_blocks: list, round_num: int):
    """Execute tool calls with confirmation guard for write_file. Max 6 rounds."""
    chat_id = update.effective_chat.id

    if not tool_calls:
        # No tools to execute — send the text response
        if text:
            await send_long_message(update, text)
        else:
            await update.message.reply_text("Procesado. ¿Algo mas que necesites?")
        return

    if round_num >= 5:
        # Max rounds reached — ask DeepSeek for a final text-only summary (no tools)
        log.info(f"Max tool rounds reached ({round_num}), requesting text-only summary")
        try:
            messages_no_tools = messages + [
                {"role": "assistant", "content": content_blocks},
                {"role": "user", "content": [
                    {"type": "text", "text": "Ya tienes suficiente informacion. Responde al usuario basado en lo que encontraste en las herramientas. NO hagas mas tool calls. Da una respuesta completa en español."}
                ]},
            ]
            final_text, _, _ = await deepseek.chat(system_prompt, messages_no_tools, tools=None, source="cron")  # no tools!
            if final_text:
                await send_long_message(update, final_text)
            else:
                await update.message.reply_text("Encontre informacion pero no pude procesarla completamente. ¿Puedes ser mas especifico?")
        except Exception as e:
            log.error(f"Final summary failed: {e}")
            await update.message.reply_text("Procese varias herramientas pero tuve un error al generar la respuesta. Intenta de nuevo con una pregunta mas concreta.")
        return

    log.info(f"Tool calls round {round_num + 1}: {[tc['name'] for tc in tool_calls]}")

    # Separate safe vs destructive
    safe_tools = [tc for tc in tool_calls if tc["name"] != "write_file"]
    destructive_tools = [tc for tc in tool_calls if tc["name"] == "write_file"]

    # Execute safe tools immediately and collect results
    tool_results = []
    for tc in safe_tools:
        result = await execute_tool(tc["name"], tc["input"])
        tool_results.append({
            "type": "tool_result",
            "tool_use_id": tc["id"],
            "content": result,
        })

    # Use full content blocks from API response (preserves thinking blocks for continuity)
    assistant_content = content_blocks

    if destructive_tools:
        # Store state for confirmation
        pending_confirmations[chat_id] = {
            "system_prompt": system_prompt,
            "messages": messages,
            "assistant_content": assistant_content,
            "safe_results": tool_results,
            "destructive_tools": destructive_tools,
            "round_num": round_num,
        }
        # Describe what needs confirmation
        tc = destructive_tools[0]
        path = tc["input"].get("path", "desconocido")
        content_preview = tc["input"].get("content", "")[:150]
        await update.message.reply_text(
            f"⚠️ Hermes quiere escribir a `{path}`\n\n"
            f"Preview: {content_preview}...\n\n"
            f"¿Confirmas? (responde 'si' o 'no')"
        )
        return

    # All tools safe — feed results back to DeepSeek
    if tool_results:
        messages = messages + [
            {"role": "assistant", "content": assistant_content},
            {"role": "user", "content": tool_results},
        ]
        text, new_tool_calls, new_content_blocks = await deepseek.chat(
            system_prompt, messages, tools=TOOLS
        )
        await process_tool_loop(update, system_prompt, messages, text, new_tool_calls, new_content_blocks, round_num + 1)
    elif text:
        await send_long_message(update, text)
    else:
        log.warning(f"Tool loop: no tool_results and no text — sending fallback")
        await update.message.reply_text("Procesé la informacion pero no pude generar una respuesta clara. ¿Puedes reformular tu pregunta?")


async def process_confirmation(update: Update, user_text: str):
    """Handle yes/no response to a write_file confirmation."""
    chat_id = update.effective_chat.id
    pending = pending_confirmations.pop(chat_id)

    if user_text not in ("si", "sí", "yes", "confirmo", "ok", "dale", "aceptar"):
        await update.message.reply_text("Acción cancelada. ¿Algo más?")
        return

    await update.message.reply_text("Ejecutando...")

    # Execute the destructive tool
    tc = pending["destructive_tools"][0]
    result = await execute_tool(tc["name"], tc["input"])
    destructive_result = {
        "type": "tool_result",
        "tool_use_id": tc["id"],
        "content": result,
    }

    # Combine safe + destructive results
    all_results = pending["safe_results"] + [destructive_result]

    # Handle remaining destructive tools (if multiple)
    remaining_destructive = pending["destructive_tools"][1:]
    for tc in remaining_destructive:
        r = await execute_tool(tc["name"], tc["input"])
        all_results.append({
            "type": "tool_result",
            "tool_use_id": tc["id"],
            "content": r,
        })

    # Feed results back to DeepSeek
    messages = pending["messages"] + [
        {"role": "assistant", "content": pending["assistant_content"]},
        {"role": "user", "content": all_results},
    ]

    text, new_tool_calls, new_content_blocks = await deepseek.chat(
        pending["system_prompt"], messages, tools=TOOLS
    )
    await process_tool_loop(
        update, pending["system_prompt"], messages,
        text, new_tool_calls, new_content_blocks, pending["round_num"] + 1,
    )


async def send_long_message(update: Update, text: str):
    """Send a message, splitting if needed for Telegram's 4096 char limit."""
    if len(text) <= 4000:
        await update.message.reply_text(text)
    else:
        await update.message.reply_text(text[:4000] + "\n\n... [truncado]")


# ── Fallback command handlers ───────────────────────────────────
async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Welcome message. Uses DeepSeek for a personalized greeting."""
    await update.message.reply_text(
        "Hermes V2 online — inteligencia real via DeepSeek.\n\n"
        "Puedes hablarme normalmente, no necesitas comandos.\n"
        "Ejemplos:\n"
        '  "¿Como va el funnel de welding?"\n'
        '  "¿Que proyectos tengo activos?"\n'
        '  "Analiza mis proyectos y dime en que enfocarme"\n'
        '  "Actualiza la memoria de TRS Roofing"\n\n'
        "Tambien puedes usar /status, /analyze, /memory si prefieres."
    )


async def cmd_status(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Redirect to unified handler."""
    await handle_message(update, context)


async def cmd_analyze(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Force a full analysis via DeepSeek."""
    await update.message.reply_text("Analizando todos los proyectos...")
    system_prompt = await build_system_prompt()
    analysis_prompt = """Realiza un analisis completo de todos los proyectos de Daniel.

Responde en español con este formato:
1. **Resumen general** — estado actual de todo
2. **Proyecto por proyecto** — estado, pendientes, riesgos
3. **Recomendaciones priorizadas** — que hacer primero, que delegar, que automatizar
4. **Memoria** — ¿hay archivos desactualizados? ¿que faltaria documentar?

Se especifico, cita URLs y datos concretos de los archivos de memoria."""
    messages = [{"role": "user", "content": analysis_prompt}]
    text, tool_calls, _ = await deepseek.chat(
        system_prompt, messages, tools=TOOLS, source="cmd_analyze"
    )
    if text:
        if len(text) > 4000:
            text = text[:4000] + "\n\n... [analisis truncado]"
        await update.message.reply_text(text)
    else:
        await update.message.reply_text("Analisis completado. Usa /status para ver resultados.")


async def cmd_memory(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Show memory system status (lightweight, no DeepSeek call)."""
    mem = load_memory()
    if not mem:
        await update.message.reply_text("No hay archivos de memoria.")
        return

    files = list(mem.keys())
    total_chars = sum(len(v) for v in mem.values())
    index = mem.get("MEMORY.md", "")
    entries = [
        line.strip("- ").split(" — ")[0]
        for line in index.split("\n")
        if line.startswith("- [")
    ]

    lines = [
        f"Memoria: {len(files)} archivos, {total_chars:,} caracteres",
        f"Modelo: {DEEPSEEK_MODEL}",
        "",
        "Entradas:",
    ]
    for e in entries[:15]:
        lines.append(f"  - {e}")

    await update.message.reply_text("\n".join(lines))


async def cmd_stats(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Show API usage statistics from observability database."""
    if not OBS_DB.exists():
        await update.message.reply_text("No hay datos de observabilidad todavia.")
        return

    conn = sqlite3.connect(str(OBS_DB))
    conn.row_factory = sqlite3.Row
    cursor = conn

    # Totals
    totals = cursor.execute(
        "SELECT COUNT(*) as calls, SUM(prompt_tokens) as pt, SUM(completion_tokens) as ct, "
        "SUM(cost_est) as cost, AVG(latency_ms) as avg_lat "
        "FROM api_calls WHERE success = 1"
    ).fetchone()

    # Today
    today = datetime.now(TZ).strftime("%Y-%m-%d")
    today_stats = cursor.execute(
        "SELECT COUNT(*) as calls, SUM(prompt_tokens) as pt, SUM(completion_tokens) as ct, "
        "SUM(cost_est) as cost "
        "FROM api_calls WHERE success = 1 AND timestamp LIKE ?", (f"{today}%",)
    ).fetchone()

    # This week
    week_start = (datetime.now(TZ).strftime("%Y-%W"))  # ISO week
    week_stats = cursor.execute(
        "SELECT COUNT(*) as calls, SUM(cost_est) as cost "
        "FROM api_calls WHERE success = 1 AND strftime('%Y-%W', timestamp) = ?",
        (week_start,)
    ).fetchone()

    # Last call
    last = cursor.execute(
        "SELECT timestamp, model, prompt_tokens, completion_tokens, latency_ms "
        "FROM api_calls ORDER BY id DESC LIMIT 1"
    ).fetchone()

    # Sources breakdown
    sources = cursor.execute(
        "SELECT source, COUNT(*) as cnt, SUM(cost_est) as cost "
        "FROM api_calls WHERE success = 1 GROUP BY source ORDER BY cnt DESC"
    ).fetchall()

    conn.close()

    lines = [
        "📊 Observabilidad DeepSeek",
        "",
        f"Total: {totals['calls'] or 0} llamadas • {totals['pt'] or 0:,} in • {totals['ct'] or 0:,} out tokens",
        f"Costo est: ${totals['cost'] or 0:.4f} • Latencia avg: {totals['avg_lat'] or 0:.0f}ms",
        "",
        f"Hoy: {today_stats['calls'] or 0} calls • {today_stats['pt'] or 0:,} in • {today_stats['ct'] or 0:,} out • ${today_stats['cost'] or 0:.4f}",
        f"Semana: {week_stats['calls'] or 0} calls • ${week_stats['cost'] or 0:.4f}",
    ]

    if sources:
        lines.append("")
        lines.append("Por fuente:")
        for s in sources:
            lines.append(f"  {s['source']}: {s['cnt']} calls • ${s['cost']:.4f}")

    if last:
        lines.append("")
        lines.append(f"Ultima: {last['timestamp']} • {last['model']} • {last['prompt_tokens']}+{last['completion_tokens']} tok • {last['latency_ms']:.0f}ms")

    await update.message.reply_text("\n".join(lines))


async def cmd_help(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Show help."""
    await cmd_start(update, context)


# ── Cron Jobs ────────────────────────────────────────────────────
async def cron_morning_analysis():
    """8 AM PT: DeepSeek-powered analysis sent to Telegram."""
    log.info("Running morning analysis cron (DeepSeek)")
    if not DEEPSEEK_API_KEY:
        log.warning("No DeepSeek API key, skipping morning analysis")
        return

    system_prompt = await build_system_prompt()
    analysis_prompt = """Buenos dias Daniel. Realiza tu analisis matutino de todos los proyectos.

Responde en español con:
1. **Estado de los proyectos** — una frase por proyecto
2. **Pendientes criticos** — que requiere atencion HOY
3. **Recordatorios** — deadlines proximos, trials, seguimientos
4. **Recomendacion del dia** — en que deberia enfocarse Daniel hoy

Se directo y accionable. Maximo 800 palabras."""
    messages = [{"role": "user", "content": analysis_prompt}]
    text, *_ = await deepseek.chat(system_prompt, messages, source="cron_morning")

    app = Application.builder().token(BOT_TOKEN).build()
    try:
        await app.bot.send_message(chat_id=CHAT_ID, text=text or "Analisis matutino completado.")
        log.info("Morning analysis sent")
    except Exception as e:
        log.error(f"Failed to send morning analysis: {e}")


async def cron_pipeline_reminder():
    """7 AM PT: Pipeline reminder — full pipeline health with runway forecast."""
    log.info("Pipeline reminder cron")
    app = Application.builder().token(BOT_TOKEN).build()

    outreach_dir = Path(os.getenv("OUTREACH_DIR", str(Path(__file__).parent / "outreach")))
    lead_csv = outreach_dir / "data" / "lead-queue.csv"

    lines = []
    lines.append(f"Pipeline Diario — {datetime.now(TZ).strftime('%Y-%m-%d %H:%M')} PT")

    if lead_csv.exists():
        import csv as csv_mod
        with open(lead_csv, encoding="utf-8") as f:
            leads = list(csv_mod.DictReader(f))

        EMAIL_CAP = 10
        SMS_CAP = 5

        # Categorize
        with_email = [l for l in leads if l.get("email", "").strip()]
        phone_only = [l for l in leads if not l.get("email", "").strip()]
        emailed = [l for l in with_email if l.get("email_sent_at", "").strip()]
        screenshotted = [l for l in with_email
                         if l.get("demo_url", "").strip() and not l.get("email_sent_at", "").strip()]
        scraped_email = [l for l in with_email if not l.get("demo_url", "").strip()]
        phone_ready = [l for l in phone_only if l.get("demo_url", "").strip()
                       and l.get("pipeline_stage", "").strip() != "phone_sent"]
        scraped_phone = [l for l in phone_only if not l.get("demo_url", "").strip()]
        responded = [l for l in with_email if l.get("responded", "").strip().lower() == "yes"]

        # Runway calculations
        email_ready = len(screenshotted)
        sms_ready = len(phone_ready)
        email_days = email_ready / EMAIL_CAP
        sms_days = sms_ready / SMS_CAP
        min_days = min(email_days, sms_days) if (email_ready or sms_ready) else 0

        # Header
        lines.append(f"Enviados: {len(emailed)} | Respondieron: {len(responded)}" if responded else f"Enviados: {len(emailed)}")
        lines.append("")

        # Email pipeline
        lines.append(f"EMAIL ({EMAIL_CAP}/dia):")
        lines.append(f"  Listos para enviar: {email_ready}")
        lines.append(f"  Por deployar:       {len(scraped_email)}")
        lines.append(f"  Runway: {email_days:.1f} dias")
        lines.append("")

        # SMS pipeline
        lines.append(f"SMS / Phone-Only ({SMS_CAP}/dia):")
        lines.append(f"  Listos para enviar: {sms_ready}")
        lines.append(f"  Por deployar:       {len(scraped_phone)}")
        lines.append(f"  Runway: {sms_days:.1f} dias")
        lines.append("")

        # Total
        lines.append(f"TOTAL: {len(leads)} leads | {email_ready + sms_ready} listos | {len(scraped_email) + len(scraped_phone)} por deployar")

        # Warnings
        if min_days < 1:
            lines.append(f"URGENTE: Menos de 1 dia de pipeline. Deploya mas leads hoy.")
        elif min_days < 2:
            lines.append(f"ATENCION: Solo {min_days:.1f} dias de pipeline. Considera deployar pronto.")
    else:
        lines.append("(lead-queue.csv no encontrado en Railway)")

    lines.append(f"\nCrons: phone_outreach 7:30 AM | daily_send 9 AM PT")

    try:
        await app.bot.send_message(chat_id=CHAT_ID, text="\n".join(lines))
    except Exception as e:
        log.error(f"Failed to send pipeline reminder: {e}")


async def cron_daily_send():
    """9 AM PT: Run daily email send via daily-send.py subprocess."""
    log.info("Daily send cron triggered")
    app = Application.builder().token(BOT_TOKEN).build()

    # Outreach directory — defaults to bundled outreach/ next to this bot
    outreach_dir = Path(os.getenv(
        "OUTREACH_DIR",
        str(Path(__file__).parent / "outreach")
    ))
    script = outreach_dir / "scripts" / "daily-send.py"

    if not script.exists():
        msg = (
            f"Daily Send — {datetime.now(TZ).strftime('%Y-%m-%d %H:%M')} PT\n"
            f"Script no encontrado en Railway: {script}\n"
            f"Ejecuta manualmente desde tu laptop:\n"
            f"  cd outreach && python scripts/daily-send.py"
        )
        try:
            await app.bot.send_message(chat_id=CHAT_ID, text=msg)
        except Exception as e:
            log.error(f"Failed to send daily-send notice: {e}")
        return

    try:
        result = subprocess.run(
            [sys.executable, str(script), "--json", "--mode", "all"],
            capture_output=True, text=True, timeout=600,
            cwd=str(outreach_dir),
            env={**os.environ, "NO_COLOR": "1"},
        )

        if result.returncode == 0:
            try:
                data = json.loads(result.stdout.strip().split("\n")[-1])
                status = data.get("status", "?")
                sent = data.get("sent", 0)
                failed = data.get("failed", 0)
                cap = data.get("daily_cap", "?")
                already = data.get("already_sent_today", 0)

                lines = [
                    f"Daily Send — {datetime.now(TZ).strftime('%Y-%m-%d %H:%M')} PT",
                    f"Estado: {status} | Cap diario: {cap} | Ya enviados hoy: {already}",
                ]

                if status == "skipped":
                    lines.append(f"Razon: {data.get('reason', '?')}")
                else:
                    lines.append(f"Enviados: {sent} | Fallidos: {failed}")
                    for r in data.get("results", []):
                        icon = "OK" if r.get("status") == "sent" else "FAIL"
                        lines.append(f"  [{icon}] {r.get('name', '?')} ({r.get('type', '?')})")

                await app.bot.send_message(chat_id=CHAT_ID, text="\n".join(lines))
            except json.JSONDecodeError:
                await app.bot.send_message(
                    chat_id=CHAT_ID,
                    text=f"Daily Send ejecutado pero no se pudo parsear el output.\n{result.stdout[-500:]}"
                )
        else:
            await app.bot.send_message(
                chat_id=CHAT_ID,
                text=f"Daily Send FAILED (exit {result.returncode})\n{result.stderr[-500:]}"
            )
    except subprocess.TimeoutExpired:
        log.error("Daily send timed out (10 min)")
        await app.bot.send_message(chat_id=CHAT_ID, text="Daily Send TIMEOUT (>10 min)")
    except Exception as e:
        log.error(f"Daily send error: {e}")
        await app.bot.send_message(chat_id=CHAT_ID, text=f"Daily Send ERROR: {e}")


async def cron_phone_outreach():
    """7:30 AM PT: Send phone-only leads to Telegram for manual SMS outreach.

    For each uncontacted phone-only lead (up to 5/day), sends 4 messages:
      1. Phone number (copy-paste to dial)
      2. Marketing message + demo link (copy-paste as SMS body)
      3. LeaderForge Digital landing page link
      4. Screenshot image of the demo (so Daniel can preview before texting)
    Then updates lead-queue.csv funnel_stage = 'contacted'.
    """
    log.info("Phone outreach cron triggered")
    app = Application.builder().token(BOT_TOKEN).build()
    outreach_dir = Path(os.getenv("OUTREACH_DIR", str(Path(__file__).parent / "outreach")))
    lead_csv = outreach_dir / "data" / "lead-queue.csv"

    if not lead_csv.exists():
        log.warning("lead-queue.csv not found for phone outreach")
        await app.bot.send_message(chat_id=CHAT_ID, text="Phone Outreach: lead-queue.csv no encontrado.")
        return

    import csv as csv_mod

    # Read leads
    with open(lead_csv, encoding="utf-8") as f:
        leads = list(csv_mod.DictReader(f))
        fieldnames = list(leads[0].keys()) if leads else []

    # Find phone-only leads ready for outreach (demo deployed, not yet sent)
    candidates = []
    for lead in leads:
        email = lead.get("email", "").strip()
        phone = lead.get("phone", "").strip()
        pipeline = lead.get("pipeline_stage", "").strip()
        if not email and phone and pipeline == "phone_only":
            candidates.append(lead)

    if not candidates:
        log.info("No uncontacted phone-only leads")
        return

    # Limit to 5 per day
    batch = candidates[:5]

    today = datetime.now(TZ)
    sent_count = 0
    contacted_ids = []

    for lead in batch:
        name = lead.get("business_name", "Unknown")
        phone = lead.get("phone", "").strip()
        city = lead.get("city", "").replace(" CA", "")
        demo_url = lead.get("demo_url", "").strip()
        lead_id = lead.get("lead_id", "")

        if not phone:
            continue
        if not demo_url:
            log.warning(f"No demo URL for {name}, skipping phone outreach")
            continue

        first = name.split()[0] if name else "there"

        # --- Message 1: Phone number (copy-paste) ---
        msg1 = f"📱 {name}\n{phone}"

        # --- Message 2: Marketing + demo link ---
        msg2 = (
            f"Hey {first}, I'm Daniel from LeaderForge Digital. "
            f"I put together a demo page for {name} so you can see what a professional "
            f"online presence looks like — mobile-ready website, social integration, "
            f"everything managed from your phone.\n\n"
            f"Every welding shop in {city} is getting online. "
            f"The ones who don't get left behind.\n\n"
            f"{demo_url}"
        )

        # --- Message 3: LeaderForge Digital ---
        msg3 = (
            f"This is what we do: https://leaderforge.digital\n\n"
            f"Professional websites for trades. "
            f"No hassle, results you can see."
        )

        # --- Message 4: Screenshot image ---
        slug = name.lower().strip().replace(" & ", " ").replace(" ", "-").replace("'", "").replace(".", "").replace("&", "")[:40]
        screenshot_dir = outreach_dir / "screenshots"
        screenshot_path = None
        for ext in (".jpg", ".png"):
            candidate = screenshot_dir / f"{slug}{ext}"
            if candidate.exists():
                screenshot_path = candidate
                break

        try:
            await app.bot.send_message(chat_id=CHAT_ID, text=msg1)
            await app.bot.send_message(chat_id=CHAT_ID, text=msg2)
            await app.bot.send_message(chat_id=CHAT_ID, text=msg3)
            if screenshot_path and screenshot_path.exists():
                await app.bot.send_photo(chat_id=CHAT_ID, photo=open(str(screenshot_path), "rb"), caption=f"Screenshot: {name}")
            sent_count += 1
            contacted_ids.append(lead_id)
            log.info(f"Phone outreach sent for {name} ({lead_id})")
        except Exception as e:
            log.error(f"Failed to send phone outreach for {name}: {e}")

    # Update CSV: mark as phone_sent (terminal stage, won't be re-sent)
    if contacted_ids:
        for row in leads:
            if row.get("lead_id", "") in contacted_ids:
                row["funnel_stage"] = "contacted"
                row["pipeline_stage"] = "phone_sent"
                row["email_sent_at"] = today.isoformat()

        with open(lead_csv, "w", newline="", encoding="utf-8") as f:
            writer = csv_mod.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(leads)

    # Summary message
    if sent_count > 0:
        summary = f"Phone Outreach — {today.strftime('%Y-%m-%d %H:%M')} PT\nContactados: {sent_count}/{len(batch)}"
    else:
        summary = f"Phone Outreach — {today.strftime('%Y-%m-%d %H:%M')} PT\nSin leads para contactar."
    try:
        await app.bot.send_message(chat_id=CHAT_ID, text=summary)
    except Exception as e:
        log.error(f"Failed to send phone outreach summary: {e}")


async def cron_evening_checkin():
    """8 PM PT: Evening wrap-up with DeepSeek."""
    log.info("Evening check-in cron")
    if not DEEPSEEK_API_KEY:
        log.warning("No DeepSeek API key, skipping evening check-in")
        return

    system_prompt = await build_system_prompt()
    checkin_prompt = f"""Buenas noches Daniel. Hora del cierre diario ({datetime.now(TZ).strftime('%H:%M')} PT).

Hazme 3 preguntas de cierre:
1. ¿Que avanzo hoy en cada proyecto?
2. ¿Hay algo que deba actualizar en la memoria?
3. ¿Cual es la prioridad para mañana?

Se breve y calido. Maximo 300 palabras."""
    messages = [{"role": "user", "content": checkin_prompt}]
    text, *_ = await deepseek.chat(system_prompt, messages, source="cron_evening")

    app = Application.builder().token(BOT_TOKEN).build()
    try:
        await app.bot.send_message(chat_id=CHAT_ID, text=text or "Cierre diario completado.")
    except Exception as e:
        log.error(f"Failed to send evening check-in: {e}")


# ═══════════════════════════════════════════════════════════════════
# ── Railway Agent: /railway commands + health monitor + auto-heal
# ═══════════════════════════════════════════════════════════════════

AUTOHEAL_COOLDOWN_S = 3600  # 1 hour between auto-heal attempts
RAILWAY_PROJECT_ID = "32ce3577-534f-4f25-974d-ae8e62e0b40a"
RAILWAY_SERVICE_ID = "a0e06cf7-e23d-4887-b3e8-c12be5961a50"
RAILWAY_GQL_URL = "https://api.railway.app/graphql"


def _autoheal_file() -> Path:
    return PROJECT_ROOT / ".last_autoheal.json"


def _load_autoheal() -> dict:
    """Load last auto-heal record."""
    af = _autoheal_file()
    if af.exists():
        try:
            return json.loads(af.read_text())
        except Exception:
            return {}
    return {}


def _save_autoheal(action: str, reason: str) -> None:
    """Persist auto-heal record with timestamp."""
    _autoheal_file().write_text(json.dumps({
        "action": action,
        "reason": reason,
        "timestamp": datetime.now(TZ).isoformat(),
    }, indent=2))


async def get_services_status() -> str:
    """Query Railway GraphQL API for live service status."""
    token = os.getenv("RAILWAY_API_TOKEN", "")
    if not token:
        return "RAILWAY_API_TOKEN no configurado en el servidor."

    query = """
    query($projectId: String!) {
        project(id: $projectId) {
            services {
                edges {
                    node {
                        id
                        name
                        deployments(first: 1) {
                            edges {
                                node {
                                    status
                                    createdAt
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    """

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                RAILWAY_GQL_URL,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                },
                json={
                    "query": query,
                    "variables": {"projectId": RAILWAY_PROJECT_ID},
                },
            )

        if resp.status_code != 200:
            log.warning(f"Railway GQL HTTP {resp.status_code}")
            return f"Railway API devolvio HTTP {resp.status_code}."

        body = resp.json()
        if "errors" in body:
            return f"GraphQL error: {body['errors'][0]['message']}"

        edges = (
            body.get("data", {})
            .get("project", {})
            .get("services", {})
            .get("edges", [])
        )
        if not edges:
            return "No se encontraron servicios en Railway."

        lines = ["Estado de servicios:"]
        for edge in edges:
            svc = edge["node"]
            name = svc["name"]
            deploys = svc.get("deployments", {}).get("edges", [])
            if deploys:
                dep = deploys[0]["node"]
                status = dep.get("status", "?")
                icon = {
                    "UNHEALTHY": "🔴", "FAILED": "🔴", "CRASHED": "🔴",
                    "DEPLOYING": "🟡", "BUILDING": "🟡", "QUEUED": "🟡",
                    "HEALTHY": "🟢", "SUCCESS": "🟢",
                }.get(status.upper(), "⚪")
                ts = dep.get("createdAt", "")[:10]
                lines.append(f"  {icon} {name}: {status} ({ts})")
            else:
                lines.append(f"  ⚪ {name}: sin deployments")

        return "\n".join(lines)

    except Exception as e:
        log.error(f"get_services_status: {e}")
        return f"Error consultando Railway API: {e}"


async def get_recent_errors() -> str:
    """Fetch recent Railway logs and extract error/warning lines."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "railway", "logs", "--service", "hermes-telegram",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=15)

        if proc.returncode != 0:
            err = stderr.decode(errors="replace").strip()
            return f"railway logs fallo: {err}" if err else "railway logs fallo (sin detalles)."

        raw = stdout.decode(errors="replace").strip()
        if not raw:
            return "Sin logs recientes."

        lines = raw.split("\n")
        # Keep last 200 lines, filter for problems
        recent = lines[-200:]
        problems = [
            ln for ln in recent
            if any(k in ln for k in ("ERROR", "error", "WARN", "Traceback", "CRASHED", "SyntaxError", "AttributeError"))
        ]
        if not problems:
            return "Sin errores en los logs recientes."

        out = [f"{len(problems)} incidencia(s) encontrada(s):"]
        for ln in problems[-12:]:
            # Strip leading timestamp/level prefix for readability
            clean = ln.split("] ", 1)[-1] if "] " in ln else ln
            out.append(f"• {clean[:140]}")
        return "\n".join(out)

    except asyncio.TimeoutError:
        return "Timeout esperando railway logs."
    except FileNotFoundError:
        return "Railway CLI no encontrado en este contenedor."
    except Exception as e:
        log.error(f"get_recent_errors: {e}")
        return f"Error: {e}"


async def _get_service_health() -> str | None:
    """Return service status string ('HEALTHY','UNHEALTHY','CRASHED', etc) or None on error."""
    token = os.getenv("RAILWAY_API_TOKEN", "")
    if not token:
        return None

    query = """
    query($projectId: String!, $serviceId: String!) {
        project(id: $projectId) {
            service(id: $serviceId) {
                deployments(first: 1) {
                    edges {
                        node {
                            status
                        }
                    }
                }
            }
        }
    }
    """
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                RAILWAY_GQL_URL,
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                json={"query": query, "variables": {"projectId": RAILWAY_PROJECT_ID, "serviceId": RAILWAY_SERVICE_ID}},
            )
        if resp.status_code != 200:
            return None
        body = resp.json()
        if "errors" in body:
            return None
        edges = (
            body.get("data", {})
            .get("project", {})
            .get("service", {})
            .get("deployments", {})
            .get("edges", [])
        )
        if not edges:
            return None
        return edges[0]["node"].get("status", "").upper()
    except Exception:
        return None


async def attempt_autoheal(reason: str) -> str:
    """
    2-level auto-heal:
      1. railway up (redeploy) — once per cooldown window
      2. If still unhealthy after waiting → alert for manual intervention

    Returns a human-readable summary string.
    """
    last = _load_autoheal()
    if last:
        last_ts = last.get("timestamp", "")
        try:
            last_dt = datetime.fromisoformat(last_ts)
            elapsed = (datetime.now(TZ) - last_dt).total_seconds()
            if elapsed < AUTOHEAL_COOLDOWN_S:
                remaining = int((AUTOHEAL_COOLDOWN_S - elapsed) / 60)
                return (
                    f"Auto-heal en cooldown ({int(elapsed / 60)} min desde el ultimo intento).\n"
                    f"Proximo intento disponible en ~{remaining} min.\n"
                    f"Ultima accion: {last.get('action','?')} — {last.get('reason','?')}"
                )
        except Exception:
            pass  # unparseable timestamp → proceed

    # --- Nivel 1: redeploy ---
    result_text = ""
    try:
        proc = await asyncio.create_subprocess_exec(
            "railway", "up",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(PROJECT_ROOT),
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=120)
        out = stdout.decode(errors="replace").strip()
        err = stderr.decode(errors="replace").strip()

        if proc.returncode == 0:
            _save_autoheal("redeploy", reason)
            result_text = f"Nivel 1: railway up ejecutado.\n{out[-300:] if out else ''}"
            log.info("Auto-heal N1 (redeploy) completed")
        else:
            _save_autoheal("redeploy_failed", reason)
            result_text = f"Nivel 1 FALLO (exit {proc.returncode}).\n{err[-300:] if err else out[-300:]}"
            log.error(f"Auto-heal N1 failed: {err[:200]}")
            return (
                f"{result_text}\n\n"
                f"El redeploy ha fallado — se requiere intervencion manual.\n"
                f"Ejecuta `railway up` desde tu laptop o revisa los logs en Railway."
            )
    except asyncio.TimeoutError:
        result_text = "Nivel 1: railway up timeout (>120s)."
    except FileNotFoundError:
        result_text = "Nivel 1: railway CLI no encontrado en el contenedor."
    except Exception as e:
        result_text = f"Nivel 1: error inesperado — {e}"

    # --- Nivel 2: wait & verify ---
    await asyncio.sleep(60)  # Let the deploy propagate
    status = await _get_service_health()

    if status in ("HEALTHY", "SUCCESS", "ONLINE", None):
        return f"{result_text}\n\nNivel 2: Servicio responde ({status or 'OK'}). Auto-heal exitoso."

    # Still down — alert
    errors = await get_recent_errors()
    return (
        f"{result_text}\n\n"
        f"Nivel 2: Servicio sigue caido ({status}) tras redeploy.\n"
        f"Se requiere intervencion manual.\n\n"
        f"Ultimos errores:\n{errors}"
    )


async def handle_railway_command(update: Update, context, user_text: str) -> None:
    """Handle /railway subcommands and reply directly to Telegram."""
    chat_id = update.effective_chat.id
    sub = user_text.replace("/railway", "", 1).strip().lower()

    if not sub:
        await context.bot.send_message(
            chat_id=chat_id,
            text=(
                "📡 **Railway Agent**\n\n"
                "`/railway status` — Estado de servicios\n"
                "`/railway logs` — Errores recientes\n"
                "`/railway health` — Ultimo auto-heal + health check\n"
                "`/railway heal` — Forzar auto-heal manual"
            ),
            parse_mode="Markdown",
        )
    elif sub in ("status", "estado", "s"):
        await context.bot.send_chat_action(chat_id=chat_id, action="typing")
        diag = await get_services_status()
        await context.bot.send_message(chat_id=chat_id, text=diag, parse_mode="Markdown")
    elif sub in ("logs", "errores", "log", "l"):
        await context.bot.send_chat_action(chat_id=chat_id, action="typing")
        diag = await get_recent_errors()
        await context.bot.send_message(chat_id=chat_id, text=diag, parse_mode="Markdown")
    elif sub in ("health", "salud", "h"):
        await context.bot.send_chat_action(chat_id=chat_id, action="typing")
        status = await _get_service_health()
        last = _load_autoheal()
        lines = [
            f"Servicio: {status or 'desconocido'}",
        ]
        if last:
            lines.append(
                f"Ultimo auto-heal: {last.get('timestamp','?')} — "
                f"{last.get('action','?')} ({last.get('reason','?')})"
            )
        else:
            lines.append("Auto-heal: nunca ejecutado.")
        await context.bot.send_message(chat_id=chat_id, text="\n".join(lines), parse_mode="Markdown")
    elif sub in ("heal", "autoheal", "fix", "reparar"):
        await context.bot.send_chat_action(chat_id=chat_id, action="typing")
        await context.bot.send_message(chat_id=chat_id, text="Iniciando auto-heal...")
        result = await attempt_autoheal("manual — /railway heal")
        await context.bot.send_message(chat_id=chat_id, text=result, parse_mode="Markdown")
    else:
        await context.bot.send_message(
            chat_id=chat_id,
            text=f"Comando no reconocido: `{sub}`. Prueba `/railway status` o `/railway logs`.",
            parse_mode="Markdown",
        )


async def cron_health_monitor():
    """
    30-min cron: check service health via Railway API.
    If unhealthy → attempt auto-heal + notify Daniel.
    Silent when healthy.
    """
    log.info("Health monitor: checking...")
    status = await _get_service_health()

    if status in ("HEALTHY", "SUCCESS", "ONLINE", None):
        log.info(f"Health monitor: OK ({status or 'N/A'})")
        return

    # Service is unhealthy
    log.warning(f"Health monitor: UNHEALTHY ({status}) — triggering auto-heal")
    reason = f"service status = {status}"
    result = await attempt_autoheal(reason)

    # Notify Daniel
    app = Application.builder().token(BOT_TOKEN).build()
    try:
        await app.bot.send_message(
            chat_id=CHAT_ID,
            text=f"🚨 **Health Monitor Alerta** — {datetime.now(TZ).strftime('%H:%M')} PT\n\n{result}",
            parse_mode="Markdown",
        )
    except Exception as e:
        log.error(f"Health monitor: failed to send alert: {e}")

    log_cron_execution("health_monitor", "health_monitor", 0, success=(status is None or status == "HEALTHY"))
def setup_scheduler():
    """Configure APScheduler with cron jobs."""
    global _scheduler
    sched = AsyncIOScheduler(timezone=TZ)

    sched.add_job(
        lambda: track_cron("pipeline_reminder", cron_pipeline_reminder()),
        CronTrigger(hour=7, minute=0, timezone=TZ),
        id="pipeline_reminder",
        name="Daily pipeline reminder",
        misfire_grace_time=3600,
    )
    sched.add_job(
        lambda: track_cron("morning_analysis", cron_morning_analysis()),
        CronTrigger(hour=8, minute=0, timezone=TZ),
        id="morning_analysis",
        name="Morning DeepSeek analysis",
        misfire_grace_time=3600,
    )
    sched.add_job(
        lambda: track_cron("evening_checkin", cron_evening_checkin()),
        CronTrigger(hour=20, minute=0, timezone=TZ),
        id="evening_checkin",
        name="Evening DeepSeek check-in",
        misfire_grace_time=3600,
    )
    # Phone-only outreach at 7:30 AM PT
    sched.add_job(
        lambda: track_cron("phone_outreach", cron_phone_outreach()),
        CronTrigger(hour=7, minute=30, timezone=TZ),
        id="phone_outreach",
        name="Phone-only lead outreach to Telegram",
        misfire_grace_time=3600,
    )
    # Daily email send at 9 AM PT
    sched.add_job(
        lambda: track_cron("daily_send", cron_daily_send()),
        CronTrigger(hour=9, minute=0, timezone=TZ),
        id="daily_send",
        name="Daily email campaign sender",
        misfire_grace_time=3600,
    )
    # Vault git pull every 30 minutes
    sched.add_job(
        lambda: track_cron("vault_pull", cron_vault_pull()),
        CronTrigger(minute="*/30", timezone=TZ),
        id="vault_pull",
        name="Vault git pull",
        misfire_grace_time=3600,
    )
    # Health monitor every 30 minutes (staggered 5 min after vault_pull)
    sched.add_job(
        lambda: track_cron("health_monitor", cron_health_monitor()),
        CronTrigger(minute="5,35", timezone=TZ),
        id="health_monitor",
        name="Railway health monitor + auto-heal",
        misfire_grace_time=3600,
    )

    sched.start()
    _scheduler = sched
    log.info("Scheduler started: 7 AM reminder, 7:30 AM phone outreach, 8 AM analysis, 9 AM daily send, 8 PM check-in, vault pull + health monitor every 30 min (PT)")
    return sched


# ── Voice Message Handler ─────────────────────────────────────────
async def handle_voice(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Transcribe voice messages via OpenAI Whisper, then process as text."""
    chat_id = update.effective_chat.id

    if not OPENAI_API_KEY:
        await update.message.reply_text("La transcripcion de audio no esta configurada (falta OPENAI_API_KEY). Escribeme en texto.")
        return

    voice = update.message.voice or update.message.audio
    if not voice:
        await update.message.reply_text("No pude acceder al archivo de audio. Intenta de nuevo.")
        return

    await update.message.reply_text("Escuchando tu audio...")

    try:
        # Download voice file from Telegram
        file_obj = await context.bot.get_file(voice.file_id)
        audio_bytes = await file_obj.download_as_bytearray()
        audio_bytes = bytes(audio_bytes)  # httpx multipart needs bytes, not bytearray

        # Determine format — Telegram voice notes are .ogg (opus)
        suffix = ".ogg"
        if update.message.audio and update.message.audio.mime_type:
            mt = update.message.audio.mime_type
            if "mp3" in mt or "mpeg" in mt:
                suffix = ".mp3"
            elif "mp4" in mt or "m4a" in mt:
                suffix = ".m4a"
            elif "wav" in mt:
                suffix = ".wav"
            elif "webm" in mt:
                suffix = ".webm"

        # Transcribe via OpenAI Whisper
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                "https://api.openai.com/v1/audio/transcriptions",
                headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
                files={"file": (f"audio{suffix}", audio_bytes, f"audio/{suffix.lstrip('.')}")},
                data={"model": "whisper-1", "language": "es", "response_format": "json"},
            )
            if resp.status_code != 200:
                log.error(f"Whisper error {resp.status_code}: {resp.text[:300]}")
                await update.message.reply_text("No pude transcribir el audio. ¿Puedes escribirme en texto?")
                return

            result = resp.json()
            transcript = result.get("text", "").strip()

        if not transcript:
            await update.message.reply_text("El audio se escucho pero no pude extraer texto. ¿Puedes intentar en un lugar con menos ruido?")
            return

        await update.message.reply_text(f"Transcripcion: \"{transcript}\"\n\nProcesando...")

        # Feed transcript into normal message handler via override_text
        await handle_message(update, context, override_text=transcript)

    except httpx.TimeoutException:
        await update.message.reply_text("El audio tardo demasiado en procesarse. Intenta con un audio mas corto o escribeme en texto.")
    except Exception as e:
        log.error(f"Voice handler error: {e}", exc_info=True)
        await update.message.reply_text("Error al procesar el audio. ¿Puedes escribirme en texto?")


# ── Startup ──────────────────────────────────────────────────────
async def main():
    """Start the bot and scheduler."""
    log.info("Hermes Telegram Bot V2 starting...")
    log.info(f"DeepSeek model: {DEEPSEEK_MODEL}")
    log.info(f"API key configured: {'yes' if DEEPSEEK_API_KEY else 'NO — V1 fallback mode'}")

    # Init observability database
    init_observability_db()
    log.info("Observability DB initialized")

    # Sync vault from GitHub
    vault_ok = await sync_vault()
    log.info(f"Vault sync: {'ok' if vault_ok else 'skipped (no token or error)'}")

    # Build RAG vector index from vault
    if vault_ok and VAULT_DIR.exists():
        try:
            await reindex_all()
            log.info("RAG vector index initialized")
        except Exception as e:
            log.warning(f"RAG init failed (non-fatal): {e}")

    # Build initial brain map
    try:
        brain_map = await build_brain_map()
        log.info(f"Brain map built: {len(brain_map):,} chars covering vault structure")
    except Exception as e:
        log.warning(f"Brain map init failed (non-fatal): {e}")

    # Load memory on startup
    mem = load_memory()
    log.info(f"Loaded {len(mem)} memory files ({sum(len(v) for v in mem.values()):,} chars)")

    # Setup cron
    scheduler = setup_scheduler()

    # Build bot application
    app = Application.builder().token(BOT_TOKEN).build()

    # Register handlers
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("help", cmd_help))
    app.add_handler(CommandHandler("status", cmd_status))
    app.add_handler(CommandHandler("analyze", cmd_analyze))
    app.add_handler(CommandHandler("memory", cmd_memory))
    app.add_handler(CommandHandler("stats", cmd_stats))
    # Unified message handler catches everything else
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    app.add_handler(MessageHandler(filters.VOICE | filters.AUDIO, handle_voice))

    # Error handler — prevents silent failures
    async def error_handler(update: object, context: ContextTypes.DEFAULT_TYPE) -> None:
        log.error(f"Telegram handler error: {context.error}", exc_info=context.error)
        if update and hasattr(update, "effective_chat"):
            try:
                await context.bot.send_message(
                    chat_id=update.effective_chat.id,
                    text="Algo fallo internamente. Intenta de nuevo en unos segundos."
                )
            except Exception:
                pass

    app.add_error_handler(error_handler)

    # Send startup notification
    try:
        startup_msg = (
            f"Hermes V2 online\n"
            f"Modelo: {DEEPSEEK_MODEL}\n"
            f"Memoria: {len(mem)} archivos\n"
            f"{datetime.now(TZ).strftime('%Y-%m-%d %H:%M')} PT\n\n"
            f"Hablame normalmente, no necesitas comandos."
        )
        await app.bot.send_message(chat_id=CHAT_ID, text=startup_msg)
        log.info("Startup notification sent")
    except Exception as e:
        log.warning(f"Could not send startup notification: {e}")

    # Start polling
    log.info("Starting Telegram polling...")
    await app.initialize()
    await app.start()
    await app.updater.start_polling()

    # Run FastAPI for Railway health checks
    config = uvicorn.Config(api, host="0.0.0.0", port=PORT, log_level="warning")
    server = uvicorn.Server(config)
    await server.serve()


if __name__ == "__main__":
    asyncio.run(main())
