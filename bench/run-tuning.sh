#!/bin/bash
# Five arms on six bugs, Meta muse-spark-1.3, one after another. Each prints "details: <run dir>" at the end.
cd "$(dirname "$0")/.."
ONLY=C4-delete-not-persisted,S3-patch-missing-200,S7-post-200,C2-login-needs-both,S9-delete-too-many,C7-panel-cannot-close
i=0
for arm in "default:" "low:--reasoning low" "high:--reasoning high" "temp0:--temp 0" "oneaction:--actions 1"; do
  name=${arm%%:*}; flags=${arm#*:}; i=$((i+1))
  echo "=== arm $name ($flags)" >> bench/runs/tuning-arms.txt
  node bench.mjs --model meta --only $ONLY --workers 3 --budget 2.5 --port-base $((7000+i*100)) $flags > bench/runs/tuning-$name.log 2>&1
  grep '^details:' bench/runs/tuning-$name.log >> bench/runs/tuning-arms.txt
done
echo DONE >> bench/runs/tuning-arms.txt
