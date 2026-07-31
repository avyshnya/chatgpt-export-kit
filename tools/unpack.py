#!/usr/bin/env python3
"""NDJSON з ChatGPT backend-api -> папка-на-чат.

  unpack.py <src.ndjson> <dest_dir> "<Назва проєкту або ''>"

Для кожної розмови створює теку `<YYYY-MM-DD> — <title> — <id8>/` з:
  chat.json  — сирий рядок NDJSON байт-у-байт (джерело правди)
  chat.md    — детерміноване похідне
Тека `_files/` під чатом наповнюється окремим проходом (вкладення повідомлень).
На stdout — JSON-звіт зі списком att_ids кожного чату (для merge-manifest.py).
"""
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone

SRC, DEST = sys.argv[1], sys.argv[2]
PROJECT = sys.argv[3] if len(sys.argv) > 3 else ""


def ts(v):
    if not v:
        return ""
    return datetime.fromtimestamp(v, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def safe(s):
    return re.sub(r"\s+", " ", re.sub(r'[/\\:*?"<>|]', "-", s)).strip()[:80]


def parts_to_text(msg):
    ct = msg.get("content") or {}
    kind = ct.get("content_type")
    out = []
    if kind in ("text", "multimodal_text"):
        for p in ct.get("parts") or []:
            if isinstance(p, str):
                if p.strip():
                    out.append(p)
            elif isinstance(p, dict):
                if p.get("content_type") == "image_asset_pointer":
                    out.append(f"[image {p.get('asset_pointer')} {p.get('width')}x{p.get('height')}]")
                elif p.get("content_type") == "audio_transcription":
                    out.append(p.get("text") or "")
                else:
                    out.append(f"[{p.get('content_type', 'part')}]")
    elif kind == "thoughts":
        for t in ct.get("thoughts") or []:
            body = (t.get("content") or "").replace("\n", "\n> ")
            out.append(f"> **{t.get('summary') or 'thinking'}**\n> {body}")
    elif kind == "reasoning_recap":
        out.append("_" + (ct.get("content") or "") + "_")
    elif ct.get("text"):
        out.append("```\n" + ct["text"] + "\n```")
    else:
        out.append(f"[{kind}]")
    return "\n\n".join(x for x in out if x).strip()


def attachments(c):
    """Усі вкладення повідомлень: [{id,name,mime,size}]. Дедуп за id."""
    seen, res = set(), []
    for n in (c.get("mapping") or {}).values():
        md = (n.get("message") or {}).get("metadata") or {}
        for a in md.get("attachments") or []:
            fid = a.get("id")
            if fid and fid not in seen:
                seen.add(fid)
                res.append({"id": fid, "name": a.get("name"),
                            "mime": a.get("mime_type") or a.get("mimeType"),
                            "size": a.get("size")})
    return res


def to_md(c, project, raw_sha, atts):
    mapping = c.get("mapping") or {}
    chain, node = [], c.get("current_node")
    while node:
        n = mapping.get(node)
        if not n:
            break
        chain.append(n)
        node = n.get("parent")
    chain.reverse()

    L = [f"# {c.get('title')}", "",
         f"- conversation_id: `{c.get('conversation_id')}`",
         f"- проєкт: {project or '— (поза проєктами)'}",
         f"- модель: {c.get('default_model_slug')}",
         f"- створено: {ts(c.get('create_time'))} UTC",
         f"- оновлено: {ts(c.get('update_time'))} UTC",
         f"- джерело: `chat.json`, sha256 `{raw_sha}`"]
    if atts:
        L.append(f"- вкладень у чаті: {len(atts)} (див. `_files/`)")
    L += ["", "---", ""]
    n_msg = 0
    for n in chain:
        m = n.get("message")
        if not m:
            continue
        role = (m.get("author") or {}).get("role")
        if role == "system":
            continue
        txt = parts_to_text(m)
        if not txt:
            continue
        n_msg += 1
        name = (m.get("author") or {}).get("name")
        label = "👤 Користувач" if role == "user" else (f"🔧 {name}" if name else "🤖 ChatGPT")
        L += [f"## {label}  <sub>{ts(m.get('create_time'))}</sub>", "", txt, ""]
    return "\n".join(L), len(mapping), len(chain), n_msg


os.makedirs(DEST, exist_ok=True)
report = []
with open(SRC, encoding="utf-8") as f:
    for ln, line in enumerate(f, 1):
        line = line.rstrip("\n")
        if not line:
            continue
        raw_sha = hashlib.sha256(line.encode("utf-8")).hexdigest()
        c = json.loads(line)
        cid = c.get("conversation_id") or f"noid{ln}"
        atts = attachments(c)
        stem = f"{ts(c.get('create_time'))[:10]} — {safe(c.get('title') or cid)} — {cid[:8]}"
        cdir = os.path.join(DEST, stem)
        os.makedirs(cdir, exist_ok=True)
        with open(os.path.join(cdir, "chat.json"), "w", encoding="utf-8") as g:
            g.write(line)
        md, nodes, chain, msgs = to_md(c, PROJECT, raw_sha, atts)
        with open(os.path.join(cdir, "chat.md"), "w", encoding="utf-8") as g:
            g.write(md)
        report.append({"id": cid, "title": c.get("title"), "folder": stem,
                       "nodes": nodes, "chain": chain, "msgs": msgs, "atts": len(atts),
                       "att_ids": [a["id"] for a in atts]})

print(json.dumps({"count": len(report),
                  "unique_folders": len({r["folder"] for r in report}),
                  "total_atts": sum(r["atts"] for r in report),
                  "items": report}, ensure_ascii=False))
