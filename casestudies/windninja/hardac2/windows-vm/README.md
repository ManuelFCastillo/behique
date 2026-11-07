# Windows VM for WindNinja #117 and #823

A Windows 11 Enterprise evaluation VM (free, 90 days) on hardac2 (Ubuntu, KVM/libvirt), with two displays, for the two Windows-only bugs. About an hour, most of it Windows setup.

Status: the `virt-install` options were checked with libvirt's test driver (all parse; that driver cannot check UEFI). Neither script has been run on real hardware yet.

## 1. Create the VM (on hardac2)

1. Download the Windows 11 Enterprise evaluation ISO (64-bit, English) from https://www.microsoft.com/en-us/evalcenter/download-windows-11-enterprise
2. Create the VM:

```bash
sudo ./create-vm.sh ~/Downloads/<the ISO file>.iso
```

3. Open its screens from a desktop session on hardac2 (or `ssh -X`):

```bash
virt-viewer --connect qemu:///system wn-win11
```

4. Install Windows. The evaluation needs no key. At the account screen choose Sign-in options, then Domain join instead, to make a local account.
5. In Windows, install the SPICE guest tools (https://www.spice-space.org/download/windows/spice-guest-tools/spice-guest-tools-latest.exe) and restart. In virt-viewer, turn on View > Displays > Display 2.
6. In Windows Settings > System > Display, set display 1 to 100% scaling and display 2 to 150%. Mixed scaling is the usual difference between a laptop screen and docked monitors.
7. Take a snapshot so each test starts clean:

```bash
virsh snapshot-create-as wn-win11 clean-install
```

## 2. #117 automated: the command-line program stopped mid-run

In the VM, copy `test-117.ps1` over (or download it from this branch) and run it in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File test-117.ps1
```

If WindNinja is not installed, it downloads the latest release's installer from GitHub and starts it. It then runs a momentum-solver job three times, stops `WindNinja_cli.exe` at a different stage each time, and records which solver processes are still running 30 seconds and 5 minutes later. Results: `%USERPROFILE%\wn-results\117\summary.csv`, with a folder per try.

This tests a stopped process, which is not the same code path as the GUI's Cancel button. Do both.

## 3. #117 manual: the GUI Cancel button

1. In PowerShell, list solver processes: `Get-Process simpleFoam,moveDynamicMesh,blockMesh,snappyHexMesh,applyInit,decomposePar,reconstructPar,mpiexec -ErrorAction SilentlyContinue`
2. In WindNinja, open an example DEM (`big_butte_small.tif` in the install's data folder), choose Conservation of Mass and Momentum, domain average 10 mph from 270, coarse mesh, and Solve.
3. When the progress shows the solver running, press Cancel.
4. Run the step 1 command after 30 seconds and after 5 minutes, and take a screenshot of Task Manager > Details sorted by name.
5. Reproduces if a solver process is still listed after Cancel. Repeat 3 times, cancelling at meshing, early solving and late solving.

## 4. #823: dropdown lists on the wrong display

1. Open WindNinja on display 1 and open a dropdown (vegetation, or output units). Leave the list open.
2. On hardac2, capture both displays: `virsh screenshot wn-win11 823-d1-screen0.png --screen 0` and `virsh screenshot wn-win11 823-d1-screen1.png --screen 1`
3. Close the list, drag the WindNinja window fully onto display 2, open the same dropdown, and capture both displays again (`823-d2-screen0.png`, `823-d2-screen1.png`).
4. Reproduces if, with the window on display 2, the list appears on display 1 or away from the control.
5. Repeat with both displays at 100% scaling. If it happens only with mixed scaling, say so.
6. If neither setup shows it, mark it Blocked: needs a physical laptop and dock. A VM may not imitate how a dock presents monitors.

## 5. Bring the results back

Windows 11 includes an ssh client, and hardac2 is 192.168.122.1 from inside the VM:

```powershell
scp -r $env:USERPROFILE\wn-results <user>@192.168.122.1:~/wn-results
```

Record the WindNinja version from `wn-results\117\version.txt` with every result.
