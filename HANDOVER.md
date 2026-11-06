# Handover: Dome mapping (โดม Solar Cell / YDome)

อัปเดต 2026-11-06 · สำหรับคนหรือ agent ที่จะทำต่อบนเครื่องอื่น

## สรุปสั้น

- เพิ่ม **โหมดโดม (domemaster fisheye)** ให้ Pixel Brightness V3 แล้ว โดยไม่ต้องแก้ native
  renderer (C++) เพราะใช้ช่อง warp mesh / blend map / mask map ที่มีอยู่
- คณิตศาสตร์, CLI และ contract test ผ่านบน macOS แล้ว (83/83 ใน unit suite ที่เลือกรัน รวม
  `tests/dome-mapping.test.mjs` 12 ข้อ) **ยังไม่ได้ทดสอบบนโดมจริง**
- ค่าตำแหน่งโปรเจคเตอร์ใน `config/dome.example.json` เป็น **ค่าสมมติ** ต้องวัดจากหน้างาน
- คู่มือเต็ม: [`docs/windows/dome-mapping.md`](docs/windows/dome-mapping.md)

## ไซต์

- ห้องนิทรรศการพลังงานแสงอาทิตย์ โดมเพดานทรงกลม ผนังโค้งมีกราฟิกพิมพ์ ทางเข้ามีม่านดำ
- **โปรเจคเตอร์ Epson 6 ตัว** ติดรอบวงแหวน cove ยิงขึ้นโดม (ยังไม่รู้รุ่น/เลนส์/ความละเอียด)
- ระบบเดิมคือ **YDome** บน Windows: `C:\YDome\data\videos\Solar_Cell_Master_4K.mp4`
  - 3840×3840, 25 fps, 4:01 นาที, ~80 Mbps, stereo 48 kHz เป็น domemaster fisheye
  - มีโฟลเดอร์ `set1`, `set2` (ยังไม่รู้ว่ามีอะไร)
- ยังไม่รู้ว่าเครื่อง YDome คือ MAPPINGPC (`192.168.1.200` บน Wi-Fi จัดการ) หรือเครื่องอื่น

## สิ่งที่ทำแล้ว (commit บน `main`)

| Commit | เนื้อหา |
| --- | --- |
| `ee960b5` | Initial commit ของโปรเจกต์ทั้งหมด (`outputs/` 32 GB ไม่ได้ commit เพราะอยู่ใน .gitignore) |
| `7cf3b77` | โหมดโดม: `runtime/shared/dome-mapping.mjs`, `scripts/dome-build.mjs`, tests, docs |
| `52e9e68` | ตัวอย่าง 6 โปรเจคเตอร์ + หมายเหตุเรื่องช่องต่อจอ |

ไฟล์หลัก:

- `runtime/shared/dome-mapping.mjs`: โมเดลโดม/โปรเจคเตอร์, ray → fisheye, mesh, blend/mask,
  coverage, ตัวแก้ตำแหน่งโปรเจคเตอร์จากจุดอ้างอิง (Levenberg–Marquardt), กริดทดสอบ
- `scripts/dome-build.mjs` (`npm run dome:build`): สร้าง mesh, `.r32f` maps, `renderer.json`,
  `project-outputs.json`, `report.json`, `coverage.svg`, `dome-grid.png`
- `config/dome.example.json`: ตัวอย่าง 6 ตัว ห่างกัน 60° ภาพครอบโดม 100% ในการจำลอง
- `tests/dome-mapping.test.mjs`

## วิธีรัน

```bash
npm run dome:build -- --profile config/dome.example.json --out outputs/dome/test \
  --renderer-base native/windows/config/renderer.example.json --grid
node --test tests/dome-mapping.test.mjs
```

ต้องใช้ Node 22+ บน Mac เครื่องเดิมไม่มี node ใน PATH ตอนทำงานใช้ binary จากแอป Codex
เครื่องใหม่ควรติดตั้ง Node 22 LTS เอง

## งานที่ค้าง (เรียงตามลำดับ)

1. **เก็บข้อมูลหน้างาน** ดูรายการใน `docs/windows/dome-mapping.md` หัวข้อ 5:
   รุ่น Epson / throw ratio / lens shift / ความละเอียด, ตำแหน่ง+ทิศเลนส์ทั้ง 6 ตัว,
   เส้นผ่านศูนย์กลางโดม, ทิศ "หน้า", ติดจุดอ้างอิงบนโดม
2. **ดูเครื่อง YDome:** รายการไฟล์ใน `C:\YDome` (อาจมีข้อมูลคาลิเบรตเดิมมาใช้เป็นค่าเริ่มต้น) และรุ่นการ์ดจอ
   ```powershell
   Get-ChildItem C:\YDome -Recurse -Depth 2 | Select-Object FullName, Length
   Get-CimInstance Win32_VideoController | Select-Object Name, VideoModeDescription
   ```
3. **ตัดสินใจวิธีต่อจอ 6 ตัว:** RTX A400 มีช่องต่อจอแค่ 4 ช่อง ทางเลือกคือการ์ด 6 ช่องขึ้นไป,
   render node 2 เครื่อง (เครื่องละ 3) หรือ NDI (ยังเป็น preview) ห้ามใช้ splitter ที่ทำให้
   Windows เห็นเป็นจอใหญ่จอเดียว
4. แทนค่าจริงใน profile → `dome-build` → ตรวจ `report.json` ว่า coverage 100%
5. Arena: composition **4096×4096**, domemaster 3840 วางกลาง 1:1, Spout `PB-COMPOSITION`
6. บนโดมจริง: เล่น `dome-grid.png` ปรับตำแหน่ง/มุม หรือใส่ `calibrationPoints` แล้ว solve จากนั้นทำ
   acceptance checklist ในหัวข้อ 6 ของคู่มือ

งานต่อยอดที่ยังไม่มี: auto-calibrate โดมด้วยกล้อง, crosshair cursor ใน Web Control สำหรับเก็บจุด
อ้างอิง, การปรับความสว่างและ black level ระหว่างโปรเจคเตอร์

## กล้อง Canon (ไม่มี EDSDK)

- งานโดมนี้ไม่ต้องใช้กล้อง (ปรับด้วยกริดหรือจุดอ้างอิง)
- EOS R50 ทำงานแบบ UVC ได้โดยไม่ต้องมี SDK ตั้งที่กล้อง: Set-up → Choose USB connection app →
  Video calls/streaming และโปรเจกต์มี `pixel-brightness-uvc.exe` อยู่แล้ว ดู
  `docs/windows/uvc-camera-development.md`
- ใช้ R50 เป็นกล้องดูระยะไกลผ่าน SSH ได้ แต่ไม่ได้ใช้คำนวณ geometry ของโดม

## สถานะ SSH ผ่าน Tailscale (ยังเข้าไม่ได้)

เครื่อง **`rog`** (`100.80.222.52`, user `rog\krits`, เป็น Administrator):

- sshd: `Running`, listen `0.0.0.0:22`, ทดสอบที่ IP Tailscale ของเครื่องเองผ่าน
- สร้าง rule `OpenSSH-Tailscale` อนุญาต port 22 จาก `100.64.0.0/10` แล้ว
- Tailscale Shields Up = false
- **ตัวที่บล็อก:** rule `Trading-Tailscale-Block-Other-TCP` บล็อก TCP ขาเข้าทุก port ยกเว้น 443
  (Block ชนะ Allow) ยังมี `Trading-Tailscale-Block-UDP` อีกตัว ทั้งสองตัวเป็น rule ของงานเทรด
  ห้ามลบโดยไม่ถามเจ้าของก่อน

ถ้าจะเปิดให้เข้าได้ (ยังไม่ได้รัน) ใช้ PowerShell Administrator บน `rog`:

```powershell
$r = Get-NetFirewallRule -DisplayName "Trading-Tailscale-Block-Other-TCP"
Set-NetFirewallPortFilter -AssociatedNetFirewallRule $r -LocalPort 1-21,23-442,444-65535
# คืนค่าเดิม: Set-NetFirewallPortFilter -AssociatedNetFirewallRule $r -LocalPort 1-442,444-65535
Add-Content -Path C:\ProgramData\ssh\administrators_authorized_keys -Value "<public key ของเครื่องที่จะ SSH เข้า>"
icacls C:\ProgramData\ssh\administrators_authorized_keys /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F"
```

ยังไม่ได้ตรวจว่า `rog` คือเครื่องหน้างานโดม หรือเป็นเครื่องที่บ้าน ถ้าเป็นเครื่องที่บ้าน
ต้องติดตั้ง Tailscale และเปิด sshd ที่เครื่องหน้างานด้วย

## ข้อควรระวัง

- renderer ต้องรันใน interactive Show session ห้ามเปิดจาก SSH และห้ามใช้ RDP ระหว่าง setup/playback
- สำรอง config ของ renderer ทุกครั้งก่อนเปลี่ยน และรีสตาร์ทผ่าน scheduled task
- `outputs/installer/obsolete/` (19 GB, ไฟล์ DO-NOT-USE) ลบได้ถ้าไม่ใช้แล้ว แต่ยังไม่ได้ลบ
