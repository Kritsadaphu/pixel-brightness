# MZ20K Portrait Hard-Cut Projection Layout

แบบ Concept สำหรับนำเสนอและตรวจหน้างาน อ้างอิงรูปด้านและผังที่ได้รับ

## Layout

- ผิวฉายอ้างอิง: กว้าง 14.40 m × สูง 13.40 m
- เครื่องใช้งาน: Panasonic PT-MZ20K จำนวน 2 เครื่อง ฉาย Portrait
- เลนส์: ET-EMS650, throw ratio 1.35–2.10:1
- ระยะเลนส์ถึงผนังในแบบ: 20.00 m
- Throw ratio ใช้งาน: 1.49:1 (คำนวณจากระยะ ÷ ด้านยาวของภาพ Portrait)
- Full optical footprint ต่อเครื่อง: 8.375 m × 13.40 m
- ลำแสงซ้อนทางกายภาพ: 1.175 m (ใช้เป็นพื้นที่เผื่อการ Warp/Mask เท่านั้น ไม่ทำ Blend)
- ระดับศูนย์เลนส์: +3.00 m
- PJ-L centerline: x=3.31 m
- PJ-R centerline: x=10.51 m
- จุด Hard Cut: ร่อง Grid 16, x=6.62 m
- ไม่มี Edge Blend / Feather; ให้ Mask ของ PJ-L จบที่ร่อง และ PJ-R เริ่มจากร่องเดียวกัน

## Files

- `MZ20K_Hardcut_Setup.dae` — โมเดล 3D นำเข้า SketchUp ด้วย File > Import > COLLADA (.dae)
- `MZ20K_Hardcut_Setup.rb` — สคริปต์สร้างโมเดล Native SketchUp พร้อม Tags และ Scenes
- `MZ20K_Hardcut_Top_View.svg` — ผังลำแสง Top View
- `MZ20K_Hardcut_Front_View.svg` — รูปด้านแบ่ง Active Image

## Important

ตำแหน่งร่องและ relief ในโมเดลเป็นการถอดสเกลจากภาพแบบความละเอียดต่ำ จึงต้องสำรวจ Total Station/laser measurement ก่อนผลิต Mask จริง การ Hard Cut ต้อง trace ตามเส้นร่องจริงใน UV/warp ของแต่ละเครื่อง ไม่ควรใช้เส้นตรงจาก Concept โดยไม่ตรวจหน้างาน
