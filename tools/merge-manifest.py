#!/usr/bin/env python3
"""Долити att_ids зі звіту unpack.py у _source/attachments-manifest.json.

  merge-manifest.py <unpack-report.json> "<префікс шляху теки чату>"

Ключ маніфесту — шлях теки чату відносно кореня архіву.
Чати без вкладень у маніфест не додаються. Запуск із кореня архіву.
"""
import json
import os
import sys

REPORT, PREFIX = sys.argv[1], sys.argv[2]
MANIFEST = "_source/attachments-manifest.json"

rep = json.load(open(REPORT, encoding="utf-8"))
man = {}
if os.path.exists(MANIFEST):
    man = json.load(open(MANIFEST, encoding="utf-8"))

added = 0
for it in rep["items"]:
    if not it["att_ids"]:
        continue
    key = f"{PREFIX}/{it['folder']}"
    if key not in man:
        added += 1
    man[key] = it["att_ids"]

with open(MANIFEST, "w", encoding="utf-8") as f:
    json.dump(man, f, ensure_ascii=False, indent=1)

uniq = {fid for v in man.values() for fid in v}
print(json.dumps({"chats_added": added, "chats_total": len(man),
                  "unique_file_ids": len(uniq)}, ensure_ascii=False))
