#!/bin/bash
# export-kit: фоновий доглядач — кожні 120 с забирає готові ndjson із теки
# завантажень (через ingest.sh). Виходить, коли 90 хв поспіль нічого нового.
# Змінні середовища ті самі, що в ingest.sh (ARC, DL, PREFIX, TARGET, PROJ) —
# передаються далі. Запуск із кореня архіву:
#   TARGET="…" nohup bash <шлях>/watch-ingest.sh &
# ⚠️ ОДИН примірник. Перевірка: ps aux | grep [w]atch-ingest
TOOLS="$(cd "$(dirname "$0")" && pwd)"
ARC="${ARC:-$PWD}"
PREFIX="${PREFIX:-chats}"
cd "$ARC" || exit 1
mkdir -p _tools-log
LOG="$ARC/_tools-log/ingest.log"
idle=0
for i in $(seq 1 360); do
  before=$(ls "_source/$PREFIX"-*.ndjson 2>/dev/null | wc -l)
  bash "$TOOLS/ingest.sh" >> "$LOG" 2>&1
  after=$(ls "_source/$PREFIX"-*.ndjson 2>/dev/null | wc -l)
  if [ "$after" -gt "$before" ]; then idle=0; else idle=$((idle+1)); fi
  echo "$(date +%H:%M:%S) iter=$i files=$after idle=$idle" >> "$LOG"
  if [ "$idle" -ge 45 ]; then echo "$(date +%H:%M:%S) IDLE-EXIT" >> "$LOG"; break; fi
  sleep 120
done
