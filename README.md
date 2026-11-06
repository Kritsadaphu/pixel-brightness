# Pixel Brightness V3

กรอบผลิตภัณฑ์อ้างอิง **Hive / Screenberry / MadMapper** และขอบเขตที่ผู้ใช้ย้ำ
บันทึกไว้ใน [Product direction](docs/product-direction.md) โดยแยกเป้าหมายออกจาก
ความสามารถที่ทดสอบผ่านจริง

Pixel Brightness คือ **Final Spatial Processor** สำหรับ Projection Mapping บน
Windows 11 โดยให้ Resolume Arena ทำหน้าที่เล่นวิดีโอและวาง Composition เท่านั้น
จากนั้น Pixel Brightness รับภาพรวมผ่าน Spout แล้วจัดการ Area, Geometry, Warp,
Blend, Mask, Black Uniformity และสีของโปรเจคเตอร์แต่ละตัวเองทั้งหมด

สำหรับ renderer รุ่นติดตั้งเดิม เส้นทางรับ NDI คือ
`local NDI source → Resolume Arena บน render PC → PB-COMPOSITION แบบ local Spout → Pixel Brightness`
Arena เป็นผู้รับ NDI และทำ composition; renderer เดิมไม่รับ NDI โดยตรงและไม่มี
สถานะหรือ acceptance gate ที่อ้างว่า NDI พร้อม รายละเอียด one-PC/two-PC และ operator
preflight อยู่ใน [`docs/windows/ndi-arena-spout.md`](docs/windows/ndi-arena-spout.md)

มี **Windows development preview** แยกเพิ่มสำหรับ
`Arena NDI Composition → Pixel correction → NDI outputs` พร้อมหน้า Control
และ `START-NDI-PREVIEW.cmd` แล้ว แต่ยังไม่ใช่ Auto รุ่นสมบูรณ์หรือเส้นทางที่
ทดสอบผ่าน 60 fps / 5 โปรเจคเตอร์ ดูผลวัดและข้อจำกัดล่าสุดใน
[`docs/windows/ndi-video-preview.md`](docs/windows/ndi-video-preview.md)

ระบบตั้งเวลาเปิด–ปิดรายสัปดาห์สำหรับเครื่องเดียวอยู่ที่
[`docs/windows/weekly-show-schedule.md`](docs/windows/weekly-show-schedule.md): BIOS/UEFI
ปลุกเครื่อง, Windows auto-logon เข้าบัญชี Show, ระบบเปิด Arena/renderer แล้วค่อยเปิด
โปรเจคเตอร์ 5 ตัว ส่วนขาปิดจะ Save และปิด Arena แบบปกติก่อน standby โปรเจคเตอร์และ
shutdown Windows เสมอ ถ้า Arena ปิดไม่สำเร็จ ระบบจะค้างเครื่องไว้และรายงาน
`SHUTDOWN-BLOCKED` แทนการ force-close

```text
Resolume Arena
  └─ PB-COMPOSITION (Spout texture เดียว ไม่ warp)
       └─ Pixel Brightness D3D11 renderer
            ├─ Area / source viewport A → mesh → blend → black → mask → Projector A
            ├─ Area / source viewport B → mesh → blend → black → mask → Projector B
            └─ Area / source viewport C → mesh → blend → black → mask → Projector C
```

Pixel Brightness ในโหมดนี้ **ไม่ใช่ media player** และ Arena ต้องไม่ fullscreen
ออกโปรเจคเตอร์โดยตรง โปรแกรม native ของ Pixel Brightness เป็น output สุดท้ายที่
ถือ D3D11 device, รับ Spout texture หนึ่งครั้งต่อเฟรม และส่งภาพไป DXGI swapchain
ของทุกโปรเจคเตอร์

## สิ่งที่ V3 ทำ

- Master Canvas และ rational frame rate กำหนดได้อิสระ
- เลือก Area จาก Composition แยกต่อโปรเจคเตอร์
- Mesh warp 2×2 ถึง 128×128 สำหรับโค้ง, keystone และ deflex
- Web Control แก้ dense mesh แบบ manual ด้วย smooth-radius brush โดยไม่ยุบกลับเหลือแค่ 4 มุม
- Blend แบบ procedural หรือ measured `r32_float` map ใน linear light
- Final mask แบบ measured map หรือ polygon พร้อม softness
- Black Uniformity แบบ scalar/RGB float map ต่อพิกเซล
- RGB gain/offset/gamma และ 3D LUT
- Test pattern/Identify grid ขนาด 32 px
- ผูกจอด้วย Windows device path + adapter LUID + target ID ไม่ยึด Display 1/2
- เมื่อ Spout, resolution, format หรือ display identity ผิด ระบบ fail closed เป็นดำ
- Web Control สำหรับกำหนด Area/Geometry/Optical และตรวจ Windows render node

## Named surfaces และ layout ที่ปลอดภัยสำหรับงานจริง

งาน manual mapping ไม่ต้องมีกล้อง: bind/Identify จอจริง → **Create surface**
(ID + ชื่อ) → เลือก layout → assign output → ตั้ง Area/mesh/seam/blend/mask/black/colour
→ Save spatial output → ยืนยัน project revision เดียวกัน live ทุก renderer
เป้าส่งมอบของ workflow นี้คือ **2 September 2026**

surface ใหม่เริ่มที่ **Independent** (`independent`) และต้องมี overlap ทั้งสี่ด้านเป็น
ศูนย์ ถ้าเป็นหนึ่งแถวให้เลือก **Horizontal row** (`horizontal`); ถ้าเป็นหนึ่งคอลัมน์
ให้เลือก **Vertical column** (`vertical`) positive seam ยอมรับได้เฉพาะ output คู่ติดกัน
บน surface เดียวกัน, มีค่า reciprocal เท่ากัน, แนวตั้งฉากตรงกัน และ `sourceViewport`
ทับกันจริงเท่ากับ seam เท่านั้น

layout แบบ 2D/หลายแถว, แตกกิ่ง, L/T หรือมีเพื่อนบ้านได้หลายคำตอบ ต้อง reject ไม่เดา
จากลำดับหรือพิกัด ต้องรอ explicit edge graph รุ่นถัดไป หรือแยกเป็น surface ที่ไม่
คลุมเครือ คู่มือ canonical อยู่ที่
[`docs/windows/surface-mapping-show.md`](docs/windows/surface-mapping-show.md)

## ขอบเขตทางฟิสิกส์

Mask ทำ signal นอกพื้นที่ให้เป็นศูนย์ได้ แต่ซอฟต์แวร์ไม่สามารถดูดแสงรั่วของ LCD
กลับเข้าเครื่องได้ Black Uniformity จึงวัด native black ของทุกพิกเซล แล้วเพิ่มแสง
เฉพาะบริเวณที่มืดกว่าให้เท่ากับ black floor ที่แย่ที่สุด ผลคือกรอบและรอย overlap
กลืนกันมากขึ้น แต่อาจทำให้ดำรวมสว่างขึ้นเล็กน้อย

## เครื่อง Windows ตัวแรก

- Windows 11 Pro 64-bit
- NVIDIA RTX A400 หรือการ์ด NVIDIA ที่ขับโปรเจคเตอร์ทุกตัวบน GPU เดียวกัน
- Resolume Arena และ Pixel Brightness อยู่ใน local Show session เดียวกัน
- Node.js 22.13+ x64 จาก official MSI (อยู่ใต้ `C:\Program Files`, ไม่ใช้ nvm/AppData), Git, CMake 3.24+ พร้อม CMake/CTest ใน system PATH, Visual Studio 2022 Desktop C++ workload
- โปรเจคเตอร์ทุกตัวใช้ native resolution และ exact refresh เดียวกัน
- Windows ใช้ Extend; ปิด HDR, Night Light, VRR/G-SYNC และ scaling บนจอฉาย
- ห้ามใช้ RDP ระหว่างเปิด output เพราะ session/display topology อาจเปลี่ยน

## ติดตั้งบน SSD Windows

ชุดส่งมอบจริงต้องตรวจ SHA-256 ของ ZIP กับไฟล์ `.sha256` จากช่องทาง release ที่
เชื่อถือได้ก่อนแตกไฟล์ และต้องเก็บ `MANIFEST-SHA256.txt` ไว้ครบ ตัวติดตั้งจะตรวจ
hash ของ source ทุกไฟล์ก่อน UAC และตรวจซ้ำใน protected staging ก่อนรัน npm/CMake
โดย manifest นี้ยืนยันความครบถ้วน ไม่ใช่ลายเซ็นผู้ผลิต

เปิด Windows Terminal แบบ Administrator ในโฟลเดอร์โปรเจกต์:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\deploy\windows\Preflight-PixelBrightness.ps1
.\deploy\windows\Install-PixelBrightness.ps1 `
  -ShowUser $env:USERNAME `
  -Appliance
```

คำสั่งนี้ใช้กับ source package ที่มี manifest หากเป็น checkout สำหรับพัฒนาในเครื่อง
เท่านั้น ให้ระบุ `-AllowUnverifiedDeveloperSource` อย่างชัดเจน ห้ามใช้ flag นี้กับ
เครื่องลูกค้าหรือ release จริง

Installer build Web และ native renderer ใน staging ก่อน publish แบบ versioned ไป
`C:\Program Files\Pixel Brightness\releases` ส่วน config/state/log/secret อยู่ที่
`C:\ProgramData\Pixel Brightness` และไม่ถูกทับตอนอัปเดต

Server กับ Web เริ่มอัตโนมัติ แต่ `PixelBrightness-Show` ถูกปิดไว้จนกว่าจะ bind
โปรเจคเตอร์จริงสำเร็จ เพื่อไม่ให้ placeholder config เปิด fullscreen ผิดจอ

### ผูกโปรเจคเตอร์

ต่อโปรเจคเตอร์ทั้งหมดเข้าการ์ด NVIDIA แล้วใช้ Windows Display Settings →
**Identify** จดหมายเลขของโปรเจคเตอร์ซ้าย/ขวาจริงก่อน จากนั้นรันครั้งแรกเพื่อดู inventory:

```powershell
& 'C:\ProgramData\Pixel Brightness\Bind-PixelBrightnessDisplays.ps1'
```

จากนั้นใช้ `gdiName` ที่แสดงจริง เรียงตามตำแหน่งซ้ายไปขวาที่ Identify แล้ว เช่น:

```powershell
& 'C:\ProgramData\Pixel Brightness\Bind-PixelBrightnessDisplays.ps1' `
  -GdiName '\\.\DISPLAY2','\\.\DISPLAY3' `
  -Overlap 240 `
  -StartShow
```

Binder ยืนยันว่าทุกจออยู่ GPU เดียวกันและใช้ resolution/refresh เดียวกัน ก่อนเขียน
Node config กับ native renderer config ให้ตรงกัน แล้วจึง enable Show task
หลัง `-StartShow` ให้เปิด Identify grid ใน Web Control ยืนยัน A/B อีกครั้งก่อน calibration

### ตั้ง Arena

1. ใน Windows Graphics settings ตั้ง Resolume Arena เป็น **High performance / NVIDIA**
   ใบเดียวกับโปรเจคเตอร์ มิฉะนั้น Spout texture อาจไม่ถึง renderer
2. สร้าง Composition ตามขนาดและ frame rate ที่ Binder รายงาน
3. เปิด **Output → Advanced** และสร้าง Spout Screen เพียงหนึ่งจอ
4. ตั้งชื่อจอนั้น `PB-COMPOSITION`, ตั้งขนาดเท่า canvas เต็ม และใช้ rectangular
   slice เดียวคลุม Composition แบบ 1:1 โดยปิด transform/mask/warp/blend ของ Arena
5. ไม่ใช้ direct Composition Spout ซึ่งจะมี sender ชื่อ `Composition`
6. ไม่ assign Advanced Output นี้เข้าโปรเจคเตอร์จริง และไม่แยก sender ต่อโปรเจคเตอร์
7. ถ้าเปิด Web Control บนเครื่อง Windows เครื่องเดียวกัน ให้ใช้ `http://localhost:3000`
   ซึ่งค่า one-click เริ่มต้นไม่ต้อง Pair; ถ้าเปิดจากเครื่องอื่นให้ใช้
   `http://<windows-ip>:3000` และ Pair ด้วย token หรือระบุ trusted IP/host ตอนติดตั้ง

ตัวอย่าง 2 โปรเจคเตอร์ 1920×1080 overlap 240 px:

```text
Canvas width = 1920 + (1920 - 240) = 3600
Canvas       = 3600 × 1080
Output A     = x 0..1919
Output B     = x 1680..3599
```

## Auto Calibration

ลำดับ calibration ที่ออกแบบไว้เป็น deterministic state machine:

```text
detect camera → lock manual exposure/WB/focus → safety black
→ black/near-black/white → Gray-code normal+inverse → RGB/tone captures
→ solve correspondence/mesh → blend/mask/black/gamma/LUT artifacts
→ validate manifest → apply project revision → restore PB-COMPOSITION
```

ระบบ simulator ใช้ทดสอบ sequence, fail-closed behavior และ artifact contract ได้
โดยไม่อ้างว่าเป็นผลวัดจริง Adapter กล้อง Canon บน Windows ต้องผ่าน USB remote
capture และยืนยัน manual settings ทุกช่องก่อน Pixel Brightness ยอมฉาย pattern

สถานะ V3 ปัจจุบันวัด geometry, blend, black uniformity, mask และ gamma ได้ใน solver
จริง ส่วน 3D colour LUT ยังเขียนเป็น identity fallback พร้อมสถานะ `LUT PENDING`
เพื่อไม่อ้างว่าปรับสีเสร็จก่อนมี Canon EDSDK capture adapter และการวัดฮาร์ดแวร์จริง

## ตรวจสอบก่อนใช้งานจริง

เปิด Arena เพียงหนึ่ง instance และให้ `PB-COMPOSITION` กำลังส่งภาพที่ขนาดและ
frame rate ตรงกับ binder ก่อนเริ่มตรวจ

```powershell
.\deploy\windows\Test-PixelBrightness.ps1 -Full
```

Full acceptance ต้องเห็นพร้อมกันว่า Arena รัน, sender ตรงชื่อและขนาด,
`compositionSource.state` เป็น `connected`, ทุก DXGI output active และ counter เดิน
โดยแยกจำนวน `Present` ที่ DXGI รับออกจาก `displayTiming.PresentCount` /
`PresentRefreshCount` ที่ระบบรายงานว่าไปถึงจอจริง ต้องไม่มี submission failure,
occlusion, discontinuity, skipped present, repeated refresh หรือ late interval
เพิ่มขึ้น และหลักฐาน display timing ต้องสด การเห็น process เปิดอยู่หรือแทนค่า
สถิติที่หาไม่ได้ด้วยศูนย์ไม่นับว่าภาพทำงาน

หลังจากนั้นยังต้องทดสอบฮาร์ดแวร์จริง:

- cold boot และ hot-plug ทุกพอร์ต
- Arena sender หาย/กลับมาแล้ว output ต้องดำและฟื้นอย่างถูกต้อง
- 2–8 ชั่วโมงที่ resolution/fps หน้างานโดยไม่มี Present failure
- ถ่าย high-speed camera ตรง overlap เพื่อวัด scanout phase
- power-cycle โปรเจคเตอร์และตรวจว่าผูกกลับ output เดิม

Software pacing ไม่ใช่ hardware genlock หาก motion seam ยังมองเห็น ต้องใช้การ์ดและ
ฮาร์ดแวร์ NVIDIA Sync/Mosaic ที่รองรับ หรือจัดโปรเจคเตอร์ที่ overlap ให้อยู่ node/GPU
เดียวกัน

## พัฒนาบน macOS/Linux

```bash
npm install
npm run build
npm run lint
node --test tests/*.test.mjs
```

macOS ตรวจ Web, Server, Node contract, simulator, config/schema และ installer แบบ
static ได้ แต่ไม่สามารถรับรองว่า C++/D3D11/Spout compile และออกโปรเจคเตอร์จริง
จนกว่าจะ build/test บน Windows target

## โครงสร้าง

- `app/` — Windows Spatial Web Control
- `native/windows/` — C++20 D3D11/Spout/DXGI final renderer
- `runtime/server/` — project, fleet และ authenticated control plane
- `runtime/server/projector-control.mjs` — Panasonic PT-VMZ51 inventory, status และ group control ผ่าน native LAN TCP/1024
- `runtime/node/` — Node daemon, Windows native IPC bridge และ simulator
- `runtime/shared/` — project/mapping/calibration/time contracts
- `config/windows-arena-final-processor.example.json` — Arena master-canvas example
- `deploy/windows/` — preflight, versioned installer, display binder และ acceptance
- `docs/windows/arena-spout.md` — Arena/Spout setup contract
- `docs/windows/ndi-arena-spout.md` — NDI → Arena → local Spout operator contract
- `docs/windows/ndi-video-preview.md` — Windows corrected NDI preview, launcher,
  measured FPS and outstanding physical/Auto acceptance checks
- `docs/windows/panasonic-vmz51-lan-control.md` — ตั้ง IP และควบคุม Power/Shutter/Input ของ PT-VMZ51 ผ่าน LAN
- `docs/windows/surface-mapping-show.md` — named-surface manual show runbook
- `tests/` — unit, integration, security และ deployment regression tests

Ubuntu renderer/fleet codeยังเก็บไว้เป็น legacy/test backend แต่ Windows คือ physical
output profile หลักสำหรับเครื่อง A400 รุ่นนี้ รายละเอียด data flow อยู่ใน
[`ARCHITECTURE.md`](ARCHITECTURE.md)
