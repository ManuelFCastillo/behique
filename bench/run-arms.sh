#!/bin/bash
# Wait for the stability run to finish, then run the two retrieval arms on Baseten, one after the other.
cd /Users/mcastillo/dev/behique || exit 1
while ! grep -q "^details:" bench/runs/baseten-stability.log; do sleep 30; done
echo "stability run finished $(date)"
node bench.mjs --model baseten --corpus general --workers 4 --budget 9 --port-base 6300 > bench/runs/baseten-corpus-general.log 2>&1
echo "arm general finished $(date)"
node bench.mjs --model baseten --corpus general+todomvc --workers 4 --budget 9 --port-base 6500 > bench/runs/baseten-corpus-general-todomvc.log 2>&1
echo "arm general+todomvc finished $(date)"
