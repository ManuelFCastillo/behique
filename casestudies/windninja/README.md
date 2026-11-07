# WindNinja reproduction kit

Internal working material for the WindNinja case study (brief: `WindNinja_Case_Study_Brief.pdf`). Nothing here has been posted upstream. The full write-up is the "WindNinja Reproduction Report (working draft)" doc.

WindNinja: github.com/firelab/windninja, commit `38fc7ca2650f9665cf62e00984880705fe3ddd55` (Oct 29, 2026), public domain plus BSD license.

## Findings so far

| Issue | Status | Evidence |
| --- | --- | --- |
| #348 DEM no-data error hidden | Reproduces in jobs with more than one run: final error is "Exception caught: std::exception" | `evidence/bug348/G_*`, `H_*` |
| #250 Duplicate stations | Reproduces in a changed form: two names at one location are averaged; a repeated row is dropped; both silently | `evidence/bug250/` |
| New: forecast download error is freed before it is read | Use-after-free in `wxModelInitialization::fetchForecast` (`wxModelInitialization.cpp:437-438`, `462-463`); failed UCAR downloads print garbage. Confirmed by valgrind | `evidence/uaf/valgrind.log` |
| #756 LANDFIRE timeout | Not run: needs internet | run `hardac2/` |
| #730 UCAR weather models | Not run: needs internet | run `hardac2/` |
| #117, #823 | Not run: need Windows | Windows VM, see `hardac2/windows-vm/README.md` |

Baseline: three runs (domain average, point, weather model) repeat byte for byte. Checksums in `evidence/baseline/SHA256SUMS`.

The 2-step no-data DEM for #348 is not committed (2.7 MB). Recreate it with:

```bash
gdal_translate -ot Float32 -scale -10000 10000 -9999 -9999 -a_nodata -9999 "$WINDNINJA_DATA/missoula_valley.tif" missoula_valley_allnodata.tif
```

## Running #756 and #730 on hardac2

Needs Docker and normal internet access. From this folder:

```bash
docker build -t windninja-cli:38fc7ca hardac2
```

```bash
mkdir -p results && docker run --rm -v "$PWD/results:/results" windninja-cli:38fc7ca
```

It tries the #756 LANDFIRE box 3 times plus a box a quarter of its area, then each UCAR model (NAM CONUS, NDFD, RAP, GFS, NAM Alaska) with a 6-hour forecast. Each attempt gets a folder with its config and full log; `results/summary.tsv` lists exit code, time and last message. Settings: `TRIES_756`, `FORECAST_HOURS`, `TEST_TIMEOUT` (seconds per attempt, default 1800), passed with `-e`.

The script was dry-run in a container with no internet: every attempt failed fast and was recorded, which checks the script, not the services.

## Windows VM for #117 and #823

`hardac2/windows-vm/create-vm.sh` makes a Windows 11 Enterprise evaluation VM (free for 90 days) with two displays on Ubuntu with KVM/libvirt. `hardac2/windows-vm/README.md` has the setup steps, the automated #117 test (`test-117.ps1`), the manual GUI checks for #117 and #823, and how to copy results back.

## Prompt for a Claude Code session on hardac2

> In the behique repo, check out branch `claude/loving-galileo-ki4rvd` and read `casestudies/windninja/README.md`. Build and run the Docker kit in `casestudies/windninja/hardac2` as described. Do not change WindNinja or post anything upstream. Report `results/summary.tsv`, and for each failure the last 20 lines of its log. Then classify #756 and #730 as Reproduces, Does not reproduce, or Blocked.
>
> Then set up the Windows VM following `casestudies/windninja/hardac2/windows-vm/README.md`. Check `/dev/kvm` and free disk space (about 100 GB) first. The Windows ISO has to be downloaded by a person from Microsoft's Evaluation Center; ask for its path. Fix `create-vm.sh` if it fails on this machine, and say what you changed. Stop after Windows is installed and tell me, since the #117 and #823 checks need someone at the screen.
