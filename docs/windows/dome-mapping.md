# Dome / Fisheye mapping

โหมดนี้ใช้กับโดมเพดานที่เล่นคอนเทนต์แบบ **domemaster** (fisheye 180° ภาพจัตุรัส เช่น
`Solar_Cell_Master_4K.mp4` ขนาด 3840×3840, 25 fps ในเครื่อง YDome เดิม)

ไม่ต้องแก้ native renderer เลย เพราะ `scripts/dome-build.mjs` แปลงรูปทรงโดมเป็นของที่
`FinalPipeline` รองรับและตรวจอยู่แล้ว:

| สิ่งที่สร้าง | ใช้ช่องไหนของ renderer |
| --- | --- |
| mesh 64×40 ถึง 128×128 ใน physical pixel ของโปรเจคเตอร์ โดย u,v ชี้ไปที่ domemaster | `warp` |
| blend แบบ partition of unity คำนวณบนผิวโดม | `blend.map` (`r32_float`) |
| ตัดภาพใต้ spring line | `mask.map` (`r32_float`) |
| ใช้ทั้ง canvas | `sourceViewport` = 0,0,W,H |

สถานะ: คณิตศาสตร์, CLI และ contract test ผ่านบน macOS แล้ว **ยังไม่ได้ทดสอบกับ
โปรเจคเตอร์จริงบนโดม** ต้องทำ acceptance บนเครื่อง Windows ตามหัวข้อด้านล่าง

## 1. ตั้งค่า Arena

ภาพนอกวงกลม fisheye ต้องเป็นสีดำ และต้องมีขอบดำเหลือรอบวงกลม เพราะพิกเซลที่ตก
ใต้ spring line จะถูกบีบลงไปในขอบนี้ ทำให้ mesh ไม่พับ

1. Composition **4096 × 4096** (ใช้ค่านี้ก็ต่อเมื่อการ์ดจอรับไหว ถ้าไม่ไหวลดได้ แต่ต้องเป็น
   จัตุรัสและมีขอบดำ)
2. วางคลิป domemaster 3840×3840 **ตรงกลาง ขนาด 1:1** ไม่ stretch ให้เต็ม canvas
3. Spout sender `PB-COMPOSITION` เหมือนเดิม และห้าม Arena ส่งภาพออกโปรเจคเตอร์เอง

ค่า `fisheye` ใน profile ต้องตรงกับที่วางไว้: `centerX/centerY = 2048`,
`radiusPx = 1920`, `fovDeg = 180` ถ้าคอนเทนต์ "หน้า" ไม่ตรงทางเข้า ให้หมุนด้วย
`fisheye.rotationDeg` ไม่ต้องไปหมุนคลิปใน Arena

## 2. วัดหน้างานแล้วเขียน profile

คัดลอก `config/dome.example.json` เป็นไฟล์ของไซต์ แล้วแก้ค่าต่อไปนี้ ค่าตัวอย่างใน
ไฟล์เป็นค่าสมมติ ใช้งานจริงไม่ได้

ระบบพิกัด (หน่วยเมตรและองศา):

- จุดกำเนิด = จุดศูนย์กลางทรงกลมของโดม บนระนาบ spring line (ขอบล่างของโดม)
- **+X = ด้านหน้า** (azimuth 0°) ควรเลือกให้ตรงทางเข้าหรือตำแหน่งที่คนดูหันไป
- **+Y = ซ้าย** ของคนที่หันหน้าไป +X, **+Z = ขึ้น**
- azimuth วัดจาก +X ไปทาง +Y (ทวนเข็มเมื่อมองจากด้านบน)

| ค่า | วัดอย่างไร |
| --- | --- |
| `dome.radiusM` | รัศมีโดม = ครึ่งหนึ่งของเส้นผ่านศูนย์กลางที่ spring line |
| `dome.springElevationDeg` | ปกติเป็น 0 ถ้าขอบล่างของโดมอยู่ต่ำกว่าเส้นศูนย์สูตรของทรงกลม (โดมตื้น) ให้ใส่ค่าติดลบ |
| `pose.positionM` | ตำแหน่งเลนส์ วัดจากจุดศูนย์กลางโดม ค่า z ติดลบแปลว่าอยู่ต่ำกว่า spring line |
| `pose.yawDeg` | ทิศที่เลนส์หันไป (azimuth) |
| `pose.pitchDeg` | มุมเงยของแกนเลนส์จากแนวราบ |
| `pose.rollDeg` | ถ้าตั้งโหมด ceiling/inverted ไว้ ให้ใส่ 180 |
| `lens.throwRatio` | ค่าจากสเปกหรือจากเมนูเลนส์ (ระยะ ÷ ความกว้างภาพ) |
| `lens.shiftX/shiftY` | lens shift เป็นสัดส่วนของความกว้าง/สูงภาพ (+0.1 = เลื่อนขึ้น/ขวา 10%) |

### โปรเจคเตอร์ 6 ตัว

ไซต์นี้มีโปรเจคเตอร์ 6 ตัว `config/dome.example.json` จึงตั้งไว้ 6 ตัว ห่างกันตัวละ 60° รอบ
cove แต่ละตัวยิงข้ามไปฝั่งตรงข้าม จากการจำลอง ภาพครอบโดมครบ 100% และทุกจุดมีโปรเจคเตอร์
ซ้อนกันอย่างน้อย 2 ตัว

renderer รองรับได้สูงสุด 32 output ต่อเครื่อง แต่ **RTX A400 มีช่องต่อจอแค่ 4 ช่อง**
ถ้าจะต่อตรง 6 ตัวต้องเลือกทางใดทางหนึ่ง:

- ใช้การ์ดที่มีช่องต่อจอ 6 ช่องขึ้นไป หรือใช้การ์ด 2 ใบ (ใบที่สองต้องอยู่ใน adapter
  เดียวกับที่ renderer ใช้ ไม่อย่างนั้นต้องแยกเป็น 2 render node)
- ใช้ render node 2 เครื่อง เครื่องละ 3 ตัว ใช้ profile เดียวกัน แล้วแบ่ง outputs ตาม `nodeId`
- ส่งออกผ่าน NDI ไปยังตัวถอดสัญญาณ (เป็น preview path ที่ยังไม่ผ่านการทดสอบที่ 60 fps)

ไม่ควรใช้ตัวแยกจอแบบ splitter หรือ wall controller ที่ทำให้ Windows เห็นเป็นจอใหญ่จอเดียว
เพราะระบบจะผูกจอแต่ละตัวด้วย EDID ไม่ได้

## 3. Build

```bash
node scripts/dome-build.mjs --profile config/dome.site.json --out outputs/dome/site \
  --renderer-base native/windows/config/renderer.example.json --grid
```

ไฟล์ที่ได้ใน `outputs/dome/site`:

- `report.json`: สัดส่วนโดมที่มีโปรเจคเตอร์ครอบ, จำนวนโปรเจคเตอร์ที่ซ้อนกันในแต่ละจุด และผลการ solve
- `coverage.svg`: รอยภาพของแต่ละโปรเจคเตอร์บน domemaster ใช้ตรวจว่ามีรูหรือไม่
- `dome-grid.png`: กริด domemaster สำหรับเล่นใน Arena (วงทุก 10°, เส้นรัศมีทุก 15°,
  หน้า = แดง, ซ้าย = เขียว, หลัง = น้ำเงิน, ขวา = เหลือง, spring line = ส้ม)
- `PJx-blend.r32f`, `PJx-mask.r32f`: correction maps
- `renderer.json`: renderer config ทั้งไฟล์ (ใช้ base ที่ระบุ แต่แทน canvas และ outputs ใหม่)
- `project-outputs.json`: outputs ในรูปแบบ project ของ Server (map ref เป็น
  `<project-asset-prefix>/<file>` พร้อม sha256)

ถ้าบางส่วนของโดมไม่มีโปรเจคเตอร์ครอบ คำสั่งจะออกด้วยรหัส 3 และบอกตัวอย่าง
azimuth/elevation ที่เป็นรู

## 4. ปรับให้ตรงโดยไม่ใช้กล้อง

กล้อง Canon ไม่มี EDSDK ก็ทำงานนี้ได้ เพราะไม่ได้ใช้กล้องเลย

**ขั้น A: เทียบกับกริด** (ทำได้เร็ว)

1. เล่น `dome-grid.png` ใน Arena
2. ดูว่าจุดขาวกลางภาพตกที่ยอดโดม และวงส้มตกที่ spring line หรือไม่
3. ถ้าคลาด ให้แก้ `yawDeg`, `pitchDeg` และ `positionM` ของตัวที่ผิด แล้ว build ใหม่
   (ใช้เวลาไม่ถึง 1 วินาที)

**ขั้น B: solve จากจุดอ้างอิง** (แม่นกว่า)

1. ติดเทปหรือสติกเกอร์บนโดมที่ตำแหน่งรู้มุม เช่น ยอดโดม (el 90) และจุดบน spring line
   ทุก 45° ทำอย่างน้อย 6 จุดต่อโปรเจคเตอร์ ยิ่งกระจายทั่วภาพยิ่งดี
2. เปิด Identify grid 32 px ของโปรเจคเตอร์นั้นจาก Web Control แล้วนับช่องกริด (ถ่ายรูป
   ด้วยมือถือช่วยได้) เพื่อหาว่าจุดเทปตรงกับ pixel x,y ไหนของโปรเจคเตอร์
3. ใส่ค่าใน `calibrationPoints` ของโปรเจคเตอร์ตัวนั้น:

   ```json
   "calibrationPoints": [
     { "label": "zenith", "azimuthDeg": 0, "elevationDeg": 90, "x": 1012, "y": 388 },
     { "label": "S-180", "azimuthDeg": 180, "elevationDeg": 0, "x": 960, "y": 1150 }
   ]
   ```

4. build ใหม่ ระบบจะ solve ตำแหน่ง/มุม (Levenberg–Marquardt) โดยใช้ค่าที่วัดเป็นจุดเริ่ม
   แล้วเขียน `solved-profile.json` พร้อม RMS error ต่อโปรเจคเตอร์ ถ้ามีจุดมากพอ
   (8 จุดขึ้นไป) ใส่ `"solve": { "free": ["px","py","pz","yawDeg","pitchDeg","rollDeg","throwRatio","shiftY"] }`
   เพื่อ solve throw ratio และ lens shift ด้วย
5. ถ้า RMS ต่ำกว่าประมาณ 2 px ให้ใช้ `solved-profile.json` เป็น profile ต่อไป

**ขั้น C:** ส่วนที่คลาดเล็กน้อย (เช่น โดมไม่กลมสนิท) แก้ด้วย dense-mesh brush ที่มีอยู่แล้วใน
Web Control

### กล้อง Canon

- **EOS R50** ต่อเป็น USB video (UVC) ได้โดยไม่ต้องมี SDK ตั้งที่กล้อง: Set-up → Choose USB
  connection app → Video calls/streaming ระบบมี `pixel-brightness-uvc.exe` และหน้า
  diagnostic อยู่แล้ว (`docs/windows/uvc-camera-development.md`) ได้ภาพ 1080p30
  (ภาพประมวลผลแล้ว ไม่ใช่ RAW)
- ใช้กล้องเป็น "ตาระยะไกล" ได้: ตั้ง R50 ใต้โดม (ใช้เลนส์มุมกว้างที่สุด) แล้วจับภาพ 1 เฟรมผ่าน
  SSH เพื่อดูกริดว่าตรงหรือไม่ ทำจากบ้านได้
- กล้องรุ่นที่ไม่มีโหมด UVC: ใช้ HDMI clean output → USB HDMI capture card (UVC) ได้ผลแบบเดียวกัน
- การ auto-calibrate โดมด้วยกล้อง (structured light + lens fisheye calibration) **ยังไม่มี**
  เป็นงานต่อยอด ตัว UVC geometry ที่มีอยู่ออกแบบมาสำหรับผนังเรียบ ใช้กับโดมไม่ได้

## 5. ทำงานกับ Windows ผ่าน SSH

renderer ต้องรันใน interactive Show session เสมอ คำสั่งที่รันใน SSH session
**เปิดหน้าต่างออกโปรเจคเตอร์ไม่ได้** ดังนั้นใช้ SSH เพื่อคัดลอกไฟล์ build ตรวจ และสั่ง
scheduled task ของ Show session เท่านั้น และห้ามใช้ RDP ระหว่าง setup/playback

```bash
# จาก Mac: build แล้วส่งไฟล์ไปเครื่อง Windows (แก้ user/host ให้ตรงเครื่องจริง)
node scripts/dome-build.mjs --profile config/dome.site.json --out outputs/dome/site --renderer-base native/windows/config/renderer.example.json --grid
scp -r outputs/dome/site CPU_Mapping@192.168.1.200:"C:/ProgramData/PixelBrightness/dome/"
```

บน Windows (ผ่าน SSH, PowerShell):

```powershell
# build หรือตรวจซ้ำบนเครื่อง Windows เองได้ ต้องมี Node 22+ และ source ชุดนี้อยู่ในเครื่อง
node scripts\dome-build.mjs --profile config\dome.site.json --out C:\ProgramData\PixelBrightness\dome\site
# renderer.json อ้าง .r32f แบบ relative ดังนั้นต้องวางไฟล์ไว้โฟลเดอร์เดียวกับ config
Get-ChildItem C:\ProgramData\PixelBrightness\dome\site
```

ก่อนเปลี่ยน config ของ renderer ตัวจริง ให้สำรองไฟล์เดิมทุกครั้ง แล้วรีสตาร์ท renderer ผ่าน
scheduled task ของ Show session (ดู `deploy/windows/README.md`) อย่า kill แล้วเปิดใหม่จาก SSH

ข้อมูลที่ต้องเก็บจากหน้างานก่อนกลับบ้าน:

- จำนวนโปรเจคเตอร์ Epson รุ่น ความละเอียด throw ratio และ lens shift ที่ตั้งไว้
- ตำแหน่งและทิศของเลนส์ทุกตัว (วัดด้วยเลเซอร์จากจุดศูนย์กลางโดม)
- เส้นผ่านศูนย์กลางโดม ความสูง spring line และทิศ "หน้า"
- ติดจุดอ้างอิงบนโดมไว้เลย ไว้ใช้ทำขั้น B
- ถ้าจะใช้ R50 เป็นกล้องระยะไกล ให้ตั้งกล้องค้างไว้ เปิดโหมด UVC และเสียบ USB ไว้

## 6. Acceptance บนโดมจริง

- [ ] `report.json` coverage 100% และทุกจุดบนโดมมีโปรเจคเตอร์อย่างน้อย 1 ตัว
- [ ] renderer โหลด `renderer.json` ได้, ไม่ fail-closed, Present telemetry ปกติ
- [ ] เล่น `dome-grid.png`: เส้นกริดต่อกันข้ามรอยต่อทุกจุด คลาดไม่เกิน 2–3 px
- [ ] เล่นภาพขาวเต็มจอ: รอยต่อไม่สว่างหรือมืดกว่าส่วนอื่นจนเห็นได้ (blend เป็นแบบ
      geometric ยังไม่ได้ชดเชยความสว่างที่ต่างกันของแต่ละโปรเจคเตอร์ `radiometryVerified: false`)
- [ ] เล่น `Solar_Cell_Master_4K.mp4` ครบ 4:01 นาที ที่ 25 fps โดยไม่มีเฟรมตก

## ข้อจำกัด

- โดมถือว่าเป็นทรงกลม ถ้าเป็นทรงรีหรือรูปทรงอิสระต้องใช้ mesh brush แก้เพิ่ม
- คอนเทนต์ถูก render สำหรับคนดูที่ `eyepointM` (ค่าเริ่มต้น = จุดศูนย์กลางโดม)
- blend ยังไม่ได้วัดความสว่างจริง และไม่ได้ปรับ black level ระหว่างโปรเจคเตอร์
- ห้ามให้กรอบภาพโปรเจคเตอร์ไปถึงจุดต่ำสุดของทรงกลม (nadir) ระบบจะปฏิเสธ mesh ที่พับ
