#!/bin/sh
# The sped-up recording of a real run for the demo tour: from the moment Start run was clicked to the verdict, squeezed to N seconds.
#   sh demo/timelapse.sh out/demo/run-raw.webm [seconds=8] [out/demo/run-timelapse.webm]
set -e
RAW="$1"; SECS="${2:-8}"; OUT="${3:-out/demo/run-timelapse.webm}"
JSON="${RAW%.webm}.json"
START=$(python3 -c "import json,sys; m=json.load(open(sys.argv[1]))['marks']; print(m['start'])" "$JSON")
END=$(python3 -c "import json,sys; m=json.load(open(sys.argv[1]))['marks']; print(m['end'])" "$JSON")
FACTOR=$(python3 -c "print(($END-$START)/$SECS)" )
echo "run $START..$END s, factor $FACTOR"
ffmpeg -v error -y -ss "$START" -to "$END" -i "$RAW" -an -vf "setpts=PTS/$FACTOR,fps=30" -c:v libvpx-vp9 -b:v 3M -deadline good -cpu-used 2 "$OUT"
ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT"
