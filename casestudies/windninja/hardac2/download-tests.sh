#!/usr/bin/env bash
# WindNinja #756 (LANDFIRE download on large areas) and #730 (UCAR weather models) checks.
# Records every attempt; fixes nothing. Usage: download-tests.sh [out_dir]
# Env: WN_BIN (default WindNinja_cli), WINDNINJA_DATA (repo data folder), TRIES_756 (default 3),
#      FORECAST_HOURS (default 6), TEST_TIMEOUT seconds per attempt (default 1800).
set -u
OUT="${1:-/results}"
WN_BIN="${WN_BIN:-WindNinja_cli}"
DATA="${WINDNINJA_DATA:?set WINDNINJA_DATA to the WindNinja data folder}"
TRIES_756="${TRIES_756:-3}"
FORECAST_HOURS="${FORECAST_HOURS:-6}"
TEST_TIMEOUT="${TEST_TIMEOUT:-1800}"
mkdir -p "$OUT"
SUMMARY="$OUT/summary.tsv"
printf 'test\tstarted_utc\texit\tseconds\tresult\tlast_message\n' > "$SUMMARY"
{ echo "host: $(hostname)"; echo "date_utc: $(date -u +%FT%TZ)"; "$WN_BIN" --version 2>&1 | grep -v CONNECT; } > "$OUT/environment.txt"

attempt() { # name cfg_path
  local name="$1" cfg="$2" dir="$OUT/$1" start t0 rc secs result last
  mkdir -p "$dir"; cp "$cfg" "$dir/run.cfg"
  start="$(date -u +%FT%TZ)"; t0=$(date +%s)
  ( cd "$dir" && timeout "$TEST_TIMEOUT" "$WN_BIN" "$dir/run.cfg" ) > "$dir/run.log" 2>&1
  rc=$?; secs=$(( $(date +%s) - t0 ))
  if [ $rc -eq 0 ]; then result=ok; elif [ $rc -eq 124 ]; then result=timeout; else result=failed; fi
  last="$(grep -vE 'CONNECT tunnel|^\s*$' "$dir/run.log" | tail -1 | tr '\t' ' ' | cut -c1-200)"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$name" "$start" "$rc" "$secs" "$result" "$last" >> "$SUMMARY"
  echo "$name: $result (exit $rc, ${secs}s) $last"
}

lcp_cfg() { # path north south east west fetch_target
  cat > "$1" <<EOF
num_threads              = 1
fetch_elevation          = $6
elevation_source         = lcp
north                    = $2
south                    = $3
east                     = $4
west                     = $5
initialization_method    = domainAverageInitialization
input_speed              = 10.0
input_speed_units        = mph
input_direction          = 270.0
input_wind_height        = 20.0
units_input_wind_height  = ft
output_wind_height       = 20.0
units_output_wind_height = ft
vegetation               = trees
mesh_choice              = coarse
write_ascii_output       = true
EOF
}

wx_cfg() { # path dem model time_zone
  cat > "$1" <<EOF
num_threads              = 1
elevation_file           = $2
initialization_method    = wxModelInitialization
wx_model_type            = $3
forecast_duration        = $FORECAST_HOURS
time_zone                = $4
output_wind_height       = 20.0
units_output_wind_height = ft
vegetation               = trees
mesh_choice              = coarse
write_ascii_output       = true
write_wx_model_ascii_output = true
EOF
}

CFG="$OUT/_cfg"; mkdir -p "$CFG"

# #756: the report's box, then a box a quarter of its area around the same center.
N=48.6256; S=48.0668; E=-113.398; W=-114.299
for i in $(seq 1 "$TRIES_756"); do
  lcp_cfg "$CFG/756_full_$i.cfg" $N $S $E $W "$OUT/756_full_$i/landfire.tif"
  attempt "756_full_$i" "$CFG/756_full_$i.cfg"
done
half() { awk -v a="$1" -v b="$2" -v s="$3" 'BEGIN{c=(a+b)/2; h=(a-b)/4; printf "%.4f", c+s*h}'; }
qn=$(half $N $S 1); qs=$(half $N $S -1); qe=$(half $E $W 1); qw=$(half $E $W -1)
lcp_cfg "$CFG/756_quarter.cfg" $qn $qs $qe $qw "$OUT/756_quarter/landfire.tif"
attempt "756_quarter" "$CFG/756_quarter.cfg"

# #730: each UCAR model the build offers, over a DEM inside its coverage.
for m in UCAR-NAM-CONUS-12-KM UCAR-NDFD-CONUS-2.5-KM UCAR-RAP-CONUS-13-KM UCAR-GFS-GLOBAL-0.5-DEG; do
  mkdir -p "$OUT/730_$m"; cp "$DATA/missoula_valley.tif" "$OUT/730_$m/"
  wx_cfg "$CFG/730_$m.cfg" "$OUT/730_$m/missoula_valley.tif" "$m" America/Denver
  attempt "730_$m" "$CFG/730_$m.cfg"
done
m=UCAR-NAM-ALASKA-11-KM; mkdir -p "$OUT/730_$m"; cp "$DATA/denali.tif" "$OUT/730_$m/"
wx_cfg "$CFG/730_$m.cfg" "$OUT/730_$m/denali.tif" "$m" America/Anchorage
attempt "730_$m" "$CFG/730_$m.cfg"

echo "Summary: $SUMMARY"
column -t -s $'\t' "$SUMMARY" 2>/dev/null || cat "$SUMMARY"
