#!/bin/bash
# export-kit: забрати готові <PREFIX>-NN.ndjson із теки завантажень у _source/
# і розкласти в теку призначення (unpack.py + merge-manifest.py).
# Береться лише файл, старший за 60 с (щоб не схопити той, що ще пишеться).
#
# Запуск ІЗ КОРЕНЯ АРХІВУ:  TARGET="1. Робоча — <ws>/no-project" bash <шлях>/ingest.sh
# Змінні середовища (шляхи — через змінні, без хардкоду):
#   ARC     корінь архіву            (за замовч. поточна тека, $PWD)
#   DL      тека завантажень Chrome  (за замовч. $HOME/Downloads)
#   PREFIX  префікс ndjson-файлів    (за замовч. chats; той самий, що __kitPrefix)
#   TARGET  тека призначення відносно ARC (ОБОВ'ЯЗКОВА, напр. "1. Робоча — X/no-project")
#   PROJ    назва проєкту для chat.md (за замовч. порожньо = поза проєктами)
set -u
TOOLS="$(cd "$(dirname "$0")" && pwd)"
ARC="${ARC:-$PWD}"
DL="${DL:-$HOME/Downloads}"
PREFIX="${PREFIX:-chats}"
: "${TARGET:?Вкажи TARGET — теку призначення відносно кореня архіву}"
PROJ="${PROJ:-}"
REP="$ARC/_inbox/reports"
cd "$ARC" || exit 1
mkdir -p "$REP" "_source" "$TARGET"
NOW=$(date +%s)
for f in "$DL/$PREFIX"-*.ndjson; do
  [ -e "$f" ] || continue
  b=$(basename "$f")
  age=$(( NOW - $(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f") ))
  if [ "$age" -lt 60 ]; then echo "SKIP(fresh) $b"; continue; fi
  if [ -e "_source/$b" ]; then echo "SKIP(exists) $b"; continue; fi
  # валідація: кожен рядок має бути валідним JSON
  if ! python3 -c "
import json,sys
n=0
for line in open(sys.argv[1],encoding='utf-8'):
    line=line.strip()
    if not line: continue
    json.loads(line); n+=1
print(n)
" "$f"; then echo "BAD $b — пропускаю"; continue; fi
  cp "$f" "_source/$b" && rm "$f"
  python3 "$TOOLS/unpack.py" "_source/$b" "$TARGET" "$PROJ" > "$REP/rep-$b.json" \
    || { echo "UNPACK FAIL $b"; continue; }
  python3 "$TOOLS/merge-manifest.py" "$REP/rep-$b.json" "$TARGET"
  echo "OK $b"
done
echo "тек у $TARGET: $(ls "$TARGET" | wc -l)"
