import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

const W = 14.4;
const H = 13.4;
const seam = 6.62;
const throwDistance = 20.0;
const lensHeight = 3.0;
const portraitBeamWidth = H * 1200 / 1920;
const throwRatio = throwDistance / H;
const leftCenter = seam / 2;
const rightCenter = seam + (W - seam) / 2;
const physicalBeamOverlap = portraitBeamWidth - (rightCenter - leftCenter);

const materials = {
  ground: [0.18, 0.20, 0.22, 1],
  facade: [0.72, 0.61, 0.47, 1],
  groove: [0.20, 0.14, 0.10, 1],
  pj: [0.07, 0.08, 0.10, 1],
  tower: [0.38, 0.42, 0.46, 1],
  left: [0.12, 0.55, 1.0, 0.25],
  right: [1.0, 0.28, 0.12, 0.25],
  leftPatch: [0.12, 0.55, 1.0, 0.55],
  rightPatch: [1.0, 0.28, 0.12, 0.55],
  cut: [1.0, 0.92, 0.12, 1],
};

let geometryId = 0;
const geometries = [];
const nodes = [];

function addGeometry(name, vertices, triangles, material, translation = [0, 0, 0]) {
  const id = `geom_${geometryId++}`;
  const pos = vertices.flat().join(" ");
  const idx = triangles.flat().join(" ");
  geometries.push(`
    <geometry id="${id}" name="${name}">
      <mesh>
        <source id="${id}_positions">
          <float_array id="${id}_positions_array" count="${vertices.length * 3}">${pos}</float_array>
          <technique_common><accessor source="#${id}_positions_array" count="${vertices.length}" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common>
        </source>
        <vertices id="${id}_vertices"><input semantic="POSITION" source="#${id}_positions"/></vertices>
        <triangles material="${material}" count="${triangles.length}"><input semantic="VERTEX" source="#${id}_vertices" offset="0"/><p>${idx}</p></triangles>
      </mesh>
    </geometry>`);
  nodes.push(`<node id="node_${id}" name="${name}"><translate>${translation.join(" ")}</translate><instance_geometry url="#${id}"><bind_material><technique_common><instance_material symbol="${material}" target="#mat_${material}"/></technique_common></bind_material></instance_geometry></node>`);
}

function box(name, x0, y0, z0, x1, y1, z1, material) {
  const v = [[x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]];
  const t = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
  addGeometry(name, v, t, material);
}

function quad(name, a, b, c, d, material) {
  addGeometry(name, [a,b,c,d], [[0,1,2],[0,2,3]], material);
}

function frustum(name, apex, xCenter, material) {
  const half = portraitBeamWidth / 2;
  const corners = [[xCenter-half,0,0],[xCenter+half,0,0],[xCenter+half,0,H],[xCenter-half,0,H]];
  addGeometry(name, [apex, ...corners], [[0,1,2],[0,2,3],[0,3,4],[0,4,1],[1,4,3],[1,3,2]], material);
}

box("Ground", -2, -22, -0.12, W + 2, 2, 0, "ground");

// Simplified facade envelope with shallow relief at the architectural grid bays.
const bays = [0, 2.62, 4.62, 6.62, 8.32, 11.17, 13.12, 14.4];
const depths = [0.28, 0.52, 0.34, 0.58, 0.30, 0.50, 0.26];
for (let i = 0; i < bays.length - 1; i++) {
  box(`Facade_Bay_${i + 1}`, bays[i], -depths[i], 0, bays[i + 1], 0, H, "facade");
  if (i > 0) box(`Groove_${i}`, bays[i] - 0.035, -0.62, 0, bays[i] + 0.035, -0.01, H, "groove");
}

// Active content zones: meet exactly at the surveyed groove, with no blend ramp.
quad("ACTIVE_LEFT_HARDCUT", [0,-0.64,0], [seam,-0.64,0], [seam,-0.64,H], [0,-0.64,H], "leftPatch");
quad("ACTIVE_RIGHT_HARDCUT", [seam,-0.65,0], [W,-0.65,0], [W,-0.65,H], [seam,-0.65,H], "rightPatch");
box("HARDCUT_SEAM_GRID_16", seam - 0.045, -0.72, 0, seam + 0.045, -0.66, H, "cut");

function addProjector(name, x, beamMaterial) {
  // MZ20K body shown in portrait orientation: approx. 440 x 650 x 211 mm in this schematic.
  box(`${name}_Tower`, x - 0.55, -throwDistance - 0.55, 0, x + 0.55, -throwDistance + 0.55, lensHeight - 0.34, "tower");
  box(`${name}_MZ20K_Portrait`, x - 0.22, -throwDistance - 0.325, lensHeight - 0.325, x + 0.22, -throwDistance + 0.325, lensHeight - 0.114, "pj");
  frustum(`${name}_Full_Optical_Beam`, [x,-throwDistance,lensHeight], x, beamMaterial);
}

addProjector("PJ_L", leftCenter, "left");
addProjector("PJ_R", rightCenter, "right");

const effects = Object.entries(materials).map(([name, rgba]) => `
  <effect id="fx_${name}"><profile_COMMON><technique sid="common"><lambert><diffuse><color>${rgba.join(" ")}</color></diffuse><transparency><float>${rgba[3]}</float></transparency></lambert></technique></profile_COMMON></effect>`).join("");
const mats = Object.keys(materials).map(name => `<material id="mat_${name}" name="${name}"><instance_effect url="#fx_${name}"/></material>`).join("");

const dae = `<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
  <asset><contributor><authoring_tool>Codex MZ20K Hardcut Layout Generator</authoring_tool></contributor><unit name="meter" meter="1"/><up_axis>Z_UP</up_axis></asset>
  <library_effects>${effects}</library_effects>
  <library_materials>${mats}</library_materials>
  <library_geometries>${geometries.join("")}</library_geometries>
  <library_visual_scenes><visual_scene id="Scene" name="MZ20K Hardcut Setup">${nodes.join("")}</visual_scene></library_visual_scenes>
  <scene><instance_visual_scene url="#Scene"/></scene>
</COLLADA>`;
fs.writeFileSync(path.join(dir, "MZ20K_Hardcut_Setup.dae"), dae);

const topX = x => 95 + x * 43;
const topY = y => 85 + (-y) * 24;
const svgTop = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="760" viewBox="0 0 1100 760">
<defs><style>text{font-family:Arial,'Noto Sans Thai',sans-serif;fill:#e9eef5}.title{font-size:22px;font-weight:700}.h{font-size:18px;font-weight:700}.t{font-size:15px}.dim{font-size:14px;fill:#aeb9c7}.wall{fill:#b9a27f;stroke:#f0dfc1;stroke-width:2}.beamL{fill:#158cff;fill-opacity:.24;stroke:#55b4ff;stroke-width:2}.beamR{fill:#ff542e;fill-opacity:.24;stroke:#ff8b70;stroke-width:2}.pj{fill:#202733;stroke:#fff;stroke-width:2}.cut{stroke:#ffe84a;stroke-width:5;stroke-dasharray:10 7}</style></defs>
<rect width="1100" height="760" fill="#10151d"/><text x="55" y="48" class="title">MZ20K PORTRAIT — TOP VIEW / HARD CUT, NO BLENDING</text>
<rect x="${topX(0)}" y="68" width="${W*43}" height="34" class="wall"/><text x="${topX(0)}" y="126" class="t">FACADE 14.40 m</text>
<polygon points="${topX(leftCenter)},${topY(-throwDistance)} ${topX(leftCenter-portraitBeamWidth/2)},85 ${topX(leftCenter+portraitBeamWidth/2)},85" class="beamL"/>
<polygon points="${topX(rightCenter)},${topY(-throwDistance)} ${topX(rightCenter-portraitBeamWidth/2)},85 ${topX(rightCenter+portraitBeamWidth/2)},85" class="beamR"/>
<line x1="${topX(seam)}" y1="58" x2="${topX(seam)}" y2="135" class="cut"/><text x="${topX(seam)+10}" y="150" class="h">HARD CUT @ Grid 16 / x=6.62 m</text>
<rect x="${topX(leftCenter)-15}" y="${topY(-throwDistance)-20}" width="30" height="40" class="pj"/><rect x="${topX(rightCenter)-15}" y="${topY(-throwDistance)-20}" width="30" height="40" class="pj"/>
<text x="${topX(leftCenter)-75}" y="${topY(-throwDistance)+45}" class="h">PJ-L MZ20K</text><text x="${topX(rightCenter)-75}" y="${topY(-throwDistance)+45}" class="h">PJ-R MZ20K</text>
<line x1="62" y1="85" x2="62" y2="${topY(-throwDistance)}" stroke="#aeb9c7" stroke-width="1"/><line x1="52" y1="85" x2="72" y2="85" stroke="#aeb9c7"/><line x1="52" y1="${topY(-throwDistance)}" x2="72" y2="${topY(-throwDistance)}" stroke="#aeb9c7"/><text x="20" y="${(85+topY(-throwDistance))/2}" class="dim" transform="rotate(-90 20 ${(85+topY(-throwDistance))/2})">THROW DISTANCE 20.00 m</text>
<text x="55" y="650" class="t">ET-EMS650 • Throw ratio ${throwRatio.toFixed(2)}:1 • Full portrait optical footprint ${portraitBeamWidth.toFixed(3)} × ${H.toFixed(2)} m</text>
<text x="55" y="680" class="t">ลำแสงซ้อนทางกายภาพประมาณ ${physicalBeamOverlap.toFixed(3)} m แต่ Content จบชนกันที่ร่อง — ไม่มี Blend ramp</text>
<text x="55" y="710" class="dim">Schematic based on supplied elevation. Verify coordinates and obstructions by site survey before rigging.</text></svg>`;
fs.writeFileSync(path.join(dir, "MZ20K_Hardcut_Top_View.svg"), svgTop);

const sx = x => 90 + x * 55;
const sz = z => 690 - z * 44;
const svgFront = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1050" height="780" viewBox="0 0 1050 780">
<defs><style>text{font-family:Arial,'Noto Sans Thai',sans-serif;fill:#ecf1f7}.title{font-size:25px;font-weight:700}.h{font-size:17px;font-weight:700}.t{font-size:14px}.dim{font-size:13px;fill:#acb8c8}.bay{fill:#b9a27f;stroke:#e4d4b9;stroke-width:2}.l{fill:#168cff;fill-opacity:.47}.r{fill:#ff542e;fill-opacity:.47}.cut{stroke:#ffe84a;stroke-width:5;stroke-dasharray:10 7}</style></defs>
<rect width="1050" height="780" fill="#10151d"/><text x="55" y="45" class="title">MZ20K PORTRAIT — FRONT VIEW / ACTIVE IMAGE ZONES</text>
${bays.slice(0,-1).map((b,i)=>`<rect x="${sx(b)}" y="${sz(H)}" width="${(bays[i+1]-b)*55}" height="${H*44}" rx="${i%2?28:14}" class="bay" opacity="${0.82-i*0.035}"/>`).join("")}
<rect x="${sx(0)}" y="${sz(H)}" width="${seam*55}" height="${H*44}" class="l"/><rect x="${sx(seam)}" y="${sz(H)}" width="${(W-seam)*55}" height="${H*44}" class="r"/>
<line x1="${sx(seam)}" y1="${sz(H)-15}" x2="${sx(seam)}" y2="${sz(0)+15}" class="cut"/><text x="${sx(seam)+12}" y="${sz(H)+28}" class="h">Hard Cut follows wall groove</text>
<text x="${sx(seam/2)-55}" y="${sz(H/2)}" class="h">PJ-L ACTIVE</text><text x="${sx(seam+(W-seam)/2)-60}" y="${sz(H/2)}" class="h">PJ-R ACTIVE</text>
<line x1="65" y1="${sz(H)}" x2="65" y2="${sz(0)}" stroke="#aeb9c7"/><line x1="55" y1="${sz(H)}" x2="75" y2="${sz(H)}" stroke="#aeb9c7"/><line x1="55" y1="${sz(0)}" x2="75" y2="${sz(0)}" stroke="#aeb9c7"/><text x="30" y="${sz(H/2)}" class="dim" transform="rotate(-90 30 ${sz(H/2)})">13.40 m</text>
<line x1="${sx(0)}" y1="725" x2="${sx(W)}" y2="725" stroke="#aeb9c7"/><text x="${sx(W/2)-45}" y="750" class="dim">14.40 m</text>
<text x="${sx(0)+12}" y="${sz(0)-16}" class="t">0.00</text><text x="${sx(seam)+8}" y="${sz(0)-16}" class="t">Grid 16 / 6.62</text><text x="${sx(W)-42}" y="${sz(0)-16}" class="t">14.40</text>
</svg>`;
fs.writeFileSync(path.join(dir, "MZ20K_Hardcut_Front_View.svg"), svgFront);

const summary = `# MZ20K Portrait Hard-Cut Projection Layout

แบบ Concept สำหรับนำเสนอและตรวจหน้างาน อ้างอิงรูปด้านและผังที่ได้รับ

## Layout

- ผิวฉายอ้างอิง: กว้าง ${W.toFixed(2)} m × สูง ${H.toFixed(2)} m
- เครื่องใช้งาน: Panasonic PT-MZ20K จำนวน 2 เครื่อง ฉาย Portrait
- เลนส์: ET-EMS650, throw ratio 1.35–2.10:1
- ระยะเลนส์ถึงผนังในแบบ: ${throwDistance.toFixed(2)} m
- Throw ratio ใช้งาน: ${throwRatio.toFixed(2)}:1 (คำนวณจากระยะ ÷ ด้านยาวของภาพ Portrait)
- Full optical footprint ต่อเครื่อง: ${portraitBeamWidth.toFixed(3)} m × ${H.toFixed(2)} m
- ลำแสงซ้อนทางกายภาพ: ${physicalBeamOverlap.toFixed(3)} m (ใช้เป็นพื้นที่เผื่อการ Warp/Mask เท่านั้น ไม่ทำ Blend)
- ระดับศูนย์เลนส์: +${lensHeight.toFixed(2)} m
- PJ-L centerline: x=${leftCenter.toFixed(2)} m
- PJ-R centerline: x=${rightCenter.toFixed(2)} m
- จุด Hard Cut: ร่อง Grid 16, x=${seam.toFixed(2)} m
- ไม่มี Edge Blend / Feather; ให้ Mask ของ PJ-L จบที่ร่อง และ PJ-R เริ่มจากร่องเดียวกัน

## Files

- \`MZ20K_Hardcut_Setup.dae\` — โมเดล 3D นำเข้า SketchUp ด้วย File > Import > COLLADA (.dae)
- \`MZ20K_Hardcut_Setup.rb\` — สคริปต์สร้างโมเดล Native SketchUp พร้อม Tags และ Scenes
- \`MZ20K_Hardcut_Top_View.svg\` — ผังลำแสง Top View
- \`MZ20K_Hardcut_Front_View.svg\` — รูปด้านแบ่ง Active Image

## Important

ตำแหน่งร่องและ relief ในโมเดลเป็นการถอดสเกลจากภาพแบบความละเอียดต่ำ จึงต้องสำรวจ Total Station/laser measurement ก่อนผลิต Mask จริง การ Hard Cut ต้อง trace ตามเส้นร่องจริงใน UV/warp ของแต่ละเครื่อง ไม่ควรใช้เส้นตรงจาก Concept โดยไม่ตรวจหน้างาน
`;
fs.writeFileSync(path.join(dir, "README.md"), summary);

console.log(JSON.stringify({W,H,seam,throwDistance,lensHeight,portraitBeamWidth,physicalBeamOverlap,throwRatio,leftCenter,rightCenter}, null, 2));
