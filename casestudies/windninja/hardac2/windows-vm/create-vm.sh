#!/usr/bin/env bash
# Create a Windows 11 Enterprise evaluation VM for WindNinja #117 and #823 on Ubuntu (KVM/libvirt).
# Two displays (one QXL device per display, as Windows needs), emulated TPM 2.0, UEFI Secure Boot.
#
# Usage:  sudo ./create-vm.sh /path/to/Windows11_Enterprise_Evaluation.iso
# Env:    VM_NAME (wn-win11), VM_RAM_MB (8192), VM_CPUS (4), VM_DISK_GB (80)
#
# The ISO comes from Microsoft's Evaluation Center (free, 90 days, no product key):
#   https://www.microsoft.com/en-us/evalcenter/download-windows-11-enterprise
set -euo pipefail

ISO_SRC="${1:?give the path to the Windows 11 Enterprise evaluation ISO}"
NAME="${VM_NAME:-wn-win11}"
RAM_MB="${VM_RAM_MB:-8192}"
CPUS="${VM_CPUS:-4}"
DISK_GB="${VM_DISK_GB:-80}"
IMG_DIR=/var/lib/libvirt/images

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo." >&2; exit 1; }
[ -e /dev/kvm ] || { echo "/dev/kvm is missing: turn on CPU virtualization (VT-x/AMD-V) in the BIOS." >&2; exit 1; }
[ -r "$ISO_SRC" ] || { echo "Cannot read $ISO_SRC" >&2; exit 1; }
if virsh dominfo "$NAME" >/dev/null 2>&1; then
  echo "A VM named $NAME already exists. Remove it (virsh undefine --nvram $NAME) or set VM_NAME." >&2; exit 1
fi

apt-get update
apt-get install -y qemu-kvm libvirt-daemon-system libvirt-clients virtinst \
                   swtpm swtpm-tools ovmf virt-viewer
systemctl enable --now libvirtd

# libvirt's default NAT network gives the VM internet access (needed to download WindNinja).
virsh net-info default >/dev/null 2>&1 || virsh net-define /usr/share/libvirt/networks/default.xml
virsh net-start default >/dev/null 2>&1 || true
virsh net-autostart default >/dev/null

# The qemu user must be able to read the ISO, so keep a copy beside the disk images.
ISO="$IMG_DIR/$(basename "$ISO_SRC")"
[ -f "$ISO" ] || cp "$ISO_SRC" "$ISO"
chmod 644 "$ISO"

# SATA disk and e1000e network card: Windows has drivers for both built in, so setup needs no driver disk.
virt-install \
  --name "$NAME" \
  --memory "$RAM_MB" --vcpus "$CPUS" --cpu host-passthrough \
  --os-variant win11 \
  --boot uefi,firmware.feature0.name=secure-boot,firmware.feature0.enabled=yes,firmware.feature1.name=enrolled-keys,firmware.feature1.enabled=yes \
  --features smm.state=on \
  --tpm backend.type=emulator,backend.version=2.0,model=tpm-crb \
  --disk path="$IMG_DIR/$NAME.qcow2",size="$DISK_GB",format=qcow2,bus=sata \
  --cdrom "$ISO" \
  --network network=default,model=e1000e \
  --graphics spice \
  --video qxl --video qxl \
  --channel spicevmc \
  --sound ich9 \
  --noautoconsole

cat <<EOF

VM "$NAME" is installing. Open its screens with:

  virt-viewer --connect qemu:///system $NAME

(from a desktop session on hardac2, or over ssh -X). Press a key when it says "Press any key to boot from CD".
The evaluation needs no product key. At the account screen, choose Sign-in options > Domain join instead
to create a local account.
After setup, inside Windows, install the SPICE guest tools so the second display works:
  https://www.spice-space.org/download/windows/spice-guest-tools/spice-guest-tools-latest.exe
Then in virt-viewer: View > Displays > Display 2.
EOF
