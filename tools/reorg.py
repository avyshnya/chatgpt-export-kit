#!/usr/bin/env python3
"""Збірка структури архіву: `<КОРІНЬ ГІЛКИ>/projects/<Проєкт>/<чат-тека>/`.

Узагальнена версія: назва кореневої теки гілки — ПАРАМЕТР, не константа.

  python3 tools/reorg.py "<КОРІНЬ ГІЛКИ>" [<meta.json>] [<префікс ndjson>]

  КОРІНЬ ГІЛКИ     напр. "1. Робоча — <workspace>" або "2. Особиста"
  meta.json        метадані проєктів (за замовч. _source/projects-meta.json):
                   [{name, gizmo_id, instructions, files: [...]}, ...] —
                   зберігається з відповіді gizmos/snorlax/sidebar
  префікс ndjson   префікс файлів чатів проєктів у _source/
                   (за замовч. "proj-"): _source/<префікс><назва-теки>.ndjson

Регенерує чати проєктів з `_source/*.ndjson` (джерело правди), переносить
файли рівня проєкту зі старого плаского `projects/<P>/_files/` (якщо є),
пише `_PROMPT.md`, звіряє, і друкує звіт. Запуск із КОРЕНЯ АРХІВУ.
Доливає _source/attachments-manifest.json (ключ — шлях теки чату).
"""
import glob
import json
import os
import re
import shutil
import subprocess
import sys

if len(sys.argv) < 2:
    sys.exit('Вкажи корінь гілки: python3 tools/reorg.py "1. Робоча — <workspace>"')
WORK = sys.argv[1]
META = sys.argv[2] if len(sys.argv) > 2 else "_source/projects-meta.json"
ND_PREFIX = sys.argv[3] if len(sys.argv) > 3 else "proj-"
TOOLS = os.path.dirname(os.path.abspath(__file__))

meta = json.load(open(META, encoding="utf-8"))


def safe(s):
    return re.sub(r"\s+", " ", re.sub(r'[/\\:*?"<>|]', "-", s)).strip()


def norm(s):
    return re.sub(r"[_‍​]", "", s)


nds = glob.glob("_source/*.ndjson")
os.makedirs(os.path.join(WORK, "projects"), exist_ok=True)
os.makedirs(os.path.join(WORK, "no-project"), exist_ok=True)

MANIFEST = "_source/attachments-manifest.json"
manifest = {}
if os.path.exists(MANIFEST):
    manifest = json.load(open(MANIFEST, encoding="utf-8"))

report = []
for p in meta:
    name = p["name"]
    folder = safe(name)
    pdir = os.path.join(WORK, "projects", folder)
    os.makedirs(pdir, exist_ok=True)

    instr = (p.get("instructions") or "").strip()
    L = [f"# {name} — інструкції проєкту", "",
         f"- `gizmo_id`: `{p['gizmo_id']}`",
         f"- файлів рівня проєкту: {len(p.get('files') or [])}",
         f"- джерело: `{META}`", "", "---", ""]
    L += ["```text", instr, "```"] if instr else ["_Інструкції не задані._"]
    open(os.path.join(pdir, "_PROMPT.md"), "w", encoding="utf-8").write("\n".join(L))

    old = os.path.join("projects", folder, "_files")
    if os.path.isdir(old):
        dest = os.path.join(pdir, "_files")
        os.makedirs(dest, exist_ok=True)
        for f in os.listdir(old):
            shutil.move(os.path.join(old, f), os.path.join(dest, f))

    nd = next((n for n in nds
               if norm(os.path.basename(n)) == norm(ND_PREFIX + folder + ".ndjson")), None)
    if not nd:
        report.append((name, "НЕМА NDJSON", 0, 0))
        continue
    out = subprocess.run(["python3", os.path.join(TOOLS, "unpack.py"), nd, pdir, name],
                         capture_output=True, text=True)
    if out.returncode != 0:
        report.append((name, "ПОМИЛКА", 0, 0))
        print(out.stderr[-400:])
        continue
    r = json.loads(out.stdout)
    for it in r["items"]:
        if it["att_ids"]:
            manifest[os.path.join(WORK, "projects", folder, it["folder"])] = it["att_ids"]
    lines = len([x for x in open(nd, encoding="utf-8").read().split("\n") if x])
    nf = len(os.listdir(os.path.join(pdir, "_files"))) if os.path.isdir(os.path.join(pdir, "_files")) else 0
    report.append((name, "OK" if r["count"] == lines == r["unique_folders"] else "ЗБІЙ", r["count"], nf))

json.dump(manifest, open(MANIFEST, "w", encoding="utf-8"),
          ensure_ascii=False, indent=1)

bad = sum(1 for _, st, _, _ in report if st != "OK")
print(f'{"проєкт":<20}{"стан":>14}{"чатів":>7}{"файлів":>8}')
for n, st, c, f in sorted(report):
    print(f"{n:<20}{st:>14}{c:>7}{f:>8}")
print(f"\nчатів: {sum(r[2] for r in report)} | файлів рівня проєкту: {sum(r[3] for r in report)} | збоїв: {bad}")
print(f"чатів із вкладеннями: {len(manifest)} | file_id у маніфесті: {sum(len(v) for v in manifest.values())}")
if bad == 0:
    print("\n✅ 0 збоїв.")
else:
    print("\n⚠️ Є збої — розібратися перед наступним кроком.")
