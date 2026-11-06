# Named-surface Windows show runbook

This is the canonical manual workflow for any set of named projection surfaces
on one Windows render node: walls, tables, floors, ceilings, scrims, scenic
pieces, or other operator-defined names. The delivery target is
**2 September 2026**.

The protocol retains the historical field names `walls` and `wallId`. Treat
them as `surfaces` and `surfaceId` conceptually; they do not restrict a surface
to a vertical wall.

Manual mapping does not require a camera. A camera-derived mesh, mask, or black
map is a separate optional calibration phase. Do not block a valid manual Area,
mesh, blend, mask, black, and colour setup merely because camera calibration is
not installed or has not been run.

This independence applies to surface membership and manual correction data. A
site that deliberately configured an active camera profile may still run its
separate hardware probe during whole-system `-Full` release acceptance; that
camera result neither creates nor changes a named-surface assignment.

## Authority and safety boundary

- `Bind-PixelBrightnessDisplays.ps1` owns physical Windows display identity.
- The authoritative project owns logical surface membership and all spatial and
  optical values.
- Resolume Arena publishes one clean master texture named exactly
  `PB-COMPOSITION`; Pixel Brightness alone owns projector warp, blend, mask,
  black correction, colour, and scanout.
- Surface layout is explicit project authority. It must never be inferred from
  output ID, Windows display number, physical proximity, or array order.
- Every committed output must have one explicit `wallId` referencing one unique
  record in `walls`. Legacy first-surface fallback is not acceptable in a frozen
  show preset.

## One-time physical binding

1. Connect every projector and set the intended resolution and exact rational
   refresh rate. Use Windows **Identify** at the physical console; do not bind
   through RDP.
2. Bind every display explicitly. Begin with zero overlap so no unrelated
   surfaces are accidentally paired:

   ```powershell
   & 'C:\ProgramData\Pixel Brightness\Bind-PixelBrightnessDisplays.ps1' `
     -GdiName '\\.\DISPLAY2','\\.\DISPLAY3','\\.\DISPLAY4' `
     -Overlap 0 -StartShow
   ```

3. Open `http://localhost:3000`, identify every output, and record the exact
   output ID beside its physical projector and intended surface. Stop and fix
   the binding if any physical identity is wrong.

## Create and assign named surfaces

In Web Control, use **Create surface** to enter a stable ID and operator-facing
name such as Floor, Ceiling, or Scrim. Surface IDs must be unique and should not
change after calibration; the visible name may be renamed deliberately without
changing output membership or layout. The new surface appears in **Physical
surface** and defaults to **Independent**.

Use stable, descriptive IDs such as:

```json
[
  { "id": "surface-north-wall", "name": "North wall", "layout": "horizontal" },
  { "id": "surface-stage-floor", "name": "Stage floor", "layout": "independent" },
  { "id": "surface-front-scrim", "name": "Front scrim", "layout": "independent" }
]
```

## Choose one show-safe layout mode

The Web Control labels and persisted `walls[].layout` values are:

| Web Control | Stored value | Current seam topology |
| --- | --- | --- |
| **Independent** | `independent` | No inferred neighbours; all four overlap values on every member output must be zero. This is the default for every new surface. |
| **Horizontal row** | `horizontal` | One strictly ordered left-to-right row. Only an adjacent output's `right`/`left` edges may form a seam. |
| **Vertical column** | `vertical` | One strictly ordered top-to-bottom column. Only an adjacent output's `bottom`/`top` edges may form a seam. |

An imported legacy surface with no `layout` is a compatibility state, not an
accepted show layout. Select and save an explicit mode before adding any
positive overlap or freezing the preset.

Every positive seam must satisfy all of these conditions together:

1. Both outputs reference the same surface ID.
2. The claim is reciprocal and equal: `A.right === B.left > 0` for a horizontal
   row, or `A.bottom === B.top > 0` for a vertical column. A one-sided or
   mismatched claim is rejected.
3. The pair is aligned on the other axis. A horizontal row requires equal
   `sourceViewport.y` and `height`; a vertical column requires equal
   `sourceViewport.x` and `width`.
4. The two `sourceViewport` rectangles have a real positive intersection on
   the seam axis, and its width or height equals the reciprocal seam value. A
   gap or edge-only touch is not an overlap.
5. The pair is adjacent in the mode's single ordering and has no positive seam
   in the other axis. Cross-surface and non-adjacent seams are always rejected.

A 2D matrix, multiple rows or columns, an L/T shape, a branch, a diagonal, or
any other topology with more than one plausible neighbour is intentionally not
representable by these three modes. Keep it **Independent** with zero seams or
split it into unambiguous named surfaces. A future versioned explicit edge
graph is required before such positive seams can be accepted. Import, Web
Control, and show validation must reject an ambiguous topology; they must not
guess from sorting or nearest coordinates.

## Manual no-camera workflow

For the **2 September 2026** delivery, the supported manual path is: bind and
Identify every physical display, create each named surface, choose its layout,
assign outputs, author source Area and mesh, add only valid reciprocal seams,
then set blend, mask, black, and colour. Save the project revision and require
it live on every renderer before acceptance. No camera step is required.

For every output:

1. Create or select the intended named surface, select the exact output, and
   choose that **Physical surface**.
2. Author its source Area and manual mesh.
3. Set overlap only against adjacent outputs on that same surface.
4. Set blend, mask, black, and colour values.
5. Press **Save spatial output** and require
   `Project revision N is LIVE on every renderer` before editing the next
   output. `RUNTIME LIVE` alone does not prove the new project revision applied.

## Guarded complete-project import

Normal creation, renaming, assignment, and spatial edits use Web Control. For
controlled recovery of a complete frozen project, run this from the trusted
local Web console after replacing every example ID and viewport. The preset
must describe the complete output inventory; a partial output set is rejected.
Physical display selectors and existing calibration fields are preserved.

This guarded preset is deliberately **1:1 only**: it has no source-to-output
scaling field. Every `sourceViewport.width` and `height` must equal the live
output resolution, and every viewport must remain inside the existing master
canvas. Use Web Control—not this recovery snippet—if the accepted design needs
scaled source Areas.

```js
const api = `http://${location.hostname}:4100`;
const preset = {
  surfaces: [
    { id: "surface-north-wall", name: "North wall", layout: "horizontal" },
    { id: "surface-stage-floor", name: "Stage floor", layout: "independent" },
    { id: "surface-front-scrim", name: "Front scrim", layout: "independent" },
  ],
  outputs: {
    "node01-A": {
      surfaceId: "surface-north-wall",
      sourceViewport: { x: 0, y: 0, width: 1920, height: 1080 },
      overlap: { left: 0, right: 240, top: 0, bottom: 0 },
    },
    "node01-B": {
      surfaceId: "surface-north-wall",
      sourceViewport: { x: 1680, y: 0, width: 1920, height: 1080 },
      overlap: { left: 240, right: 0, top: 0, bottom: 0 },
    },
    "node01-C": {
      surfaceId: "surface-stage-floor",
      sourceViewport: { x: 3360, y: 0, width: 1920, height: 1080 },
      overlap: { left: 0, right: 0, top: 0, bottom: 0 },
    },
  },
};

const layouts = new Set(["independent", "horizontal", "vertical"]);
const overlapEdges = ["left", "right", "top", "bottom"];
const reject = (message) => { throw new Error(`Preset rejected: ${message}`); };
const requirePixel = (value, field, { positive = false } = {}) => {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
    reject(`${field} must be a ${positive ? "positive" : "non-negative"} integer`);
  }
  return value;
};
const end = (member, coordinate, extent) => (
  member.viewport[coordinate] + member.viewport[extent]
);
const intersection = (first, second, coordinate, extent) => Math.max(0,
  Math.min(end(first, coordinate, extent), end(second, coordinate, extent))
    - Math.max(first.viewport[coordinate], second.viewport[coordinate]),
);

function validateSurfaceLayout(surface, members) {
  if (surface.layout === "independent") {
    for (const member of members) {
      if (overlapEdges.some((edge) => member.overlap[edge] !== 0)) {
        reject(`Independent surface ${surface.id} requires all-zero overlap (${member.id})`);
      }
    }
    return;
  }

  const horizontal = surface.layout === "horizontal";
  const coordinate = horizontal ? "x" : "y";
  const extent = horizontal ? "width" : "height";
  const crossCoordinate = horizontal ? "y" : "x";
  const crossExtent = horizontal ? "height" : "width";
  const leading = horizontal ? "left" : "top";
  const trailing = horizontal ? "right" : "bottom";
  const forbiddenEdges = horizontal ? ["top", "bottom"] : ["left", "right"];

  for (const member of members) {
    if (forbiddenEdges.some((edge) => member.overlap[edge] !== 0)) {
      reject(`${surface.layout} surface ${surface.id} has a wrong-axis seam (${member.id})`);
    }
  }

  const ordered = [...members].sort((first, second) => (
    first.viewport[coordinate] - second.viewport[coordinate]
      || first.id.localeCompare(second.id)
  ));
  const anchor = ordered[0]?.viewport;
  for (const member of ordered.slice(1)) {
    if (member.viewport[crossCoordinate] !== anchor[crossCoordinate]
      || member.viewport[crossExtent] !== anchor[crossExtent]) {
      reject(`${surface.layout} surface ${surface.id} is not orthogonally aligned`);
    }
  }
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (current.viewport[coordinate] <= previous.viewport[coordinate]
      || end(current, coordinate, extent) <= end(previous, coordinate, extent)) {
      reject(`${surface.layout} surface ${surface.id} has an ambiguous ordering`);
    }
  }

  if (ordered[0]?.overlap[leading] !== 0
    || ordered.at(-1)?.overlap[trailing] !== 0) {
    reject(`${surface.layout} surface ${surface.id} claims a seam without a neighbour`);
  }

  // Any intersection beyond an adjacent pair is a non-adjacent/triple overlap.
  for (let firstIndex = 0; firstIndex < ordered.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 2; secondIndex < ordered.length; secondIndex += 1) {
      const first = ordered[firstIndex];
      const second = ordered[secondIndex];
      if (intersection(first, second, coordinate, extent) > 0
        && intersection(first, second, crossCoordinate, crossExtent) > 0) {
        reject(`${surface.layout} surface ${surface.id} has a non-adjacent/triple overlap`);
      }
    }
  }

  for (let index = 0; index + 1 < ordered.length; index += 1) {
    const first = ordered[index];
    const second = ordered[index + 1];
    const firstClaim = first.overlap[trailing];
    const secondClaim = second.overlap[leading];
    if (firstClaim !== secondClaim) {
      reject(`${first.id}/${second.id} seam is not reciprocal and equal`);
    }
    const primaryIntersection = intersection(first, second, coordinate, extent);
    const crossIntersection = intersection(first, second, crossCoordinate, crossExtent);
    if (firstClaim > 0 && (primaryIntersection === 0 || crossIntersection === 0)) {
      reject(`${first.id}/${second.id} claims a seam without a real viewport intersection`);
    }
    if (firstClaim !== primaryIntersection) {
      reject(`${first.id}/${second.id} seam does not equal its viewport intersection`);
    }
  }
}

function validatePreset(project, candidatePreset) {
  if (!Array.isArray(candidatePreset.surfaces) || candidatePreset.surfaces.length === 0) {
    reject("surfaces must be a non-empty array");
  }
  const surfacesById = new Map();
  for (const surface of candidatePreset.surfaces) {
    if (typeof surface?.id !== "string" || !surface.id) reject("every surface needs an ID");
    if (surfacesById.has(surface.id)) reject(`duplicate surface ID ${surface.id}`);
    if (!layouts.has(surface.layout)) {
      reject(`surface ${surface.id} needs an explicit independent/horizontal/vertical layout`);
    }
    surfacesById.set(surface.id, surface);
  }

  const liveOutputs = new Map(project.outputs.map((output) => [String(output.id), output]));
  const expectedIds = Object.keys(candidatePreset.outputs).sort();
  const actualIds = [...liveOutputs.keys()].sort();
  if (JSON.stringify(expectedIds) !== JSON.stringify(actualIds)) {
    reject(`preset IDs ${expectedIds} do not match live IDs ${actualIds}`);
  }

  const membersBySurface = new Map(
    candidatePreset.surfaces.map(({ id }) => [id, []]),
  );
  for (const [outputId, patch] of Object.entries(candidatePreset.outputs)) {
    const liveOutput = liveOutputs.get(outputId);
    if (!surfacesById.has(patch?.surfaceId)) {
      reject(`output ${outputId} references unknown surface ${patch?.surfaceId}`);
    }
    const viewport = patch?.sourceViewport;
    requirePixel(viewport?.x, `${outputId}.sourceViewport.x`);
    requirePixel(viewport?.y, `${outputId}.sourceViewport.y`);
    requirePixel(viewport?.width, `${outputId}.sourceViewport.width`, { positive: true });
    requirePixel(viewport?.height, `${outputId}.sourceViewport.height`, { positive: true });
    if (viewport.width !== liveOutput.resolution?.width
      || viewport.height !== liveOutput.resolution?.height) {
      reject(`${outputId} is not 1:1 with its live output resolution`);
    }
    if (viewport.x + viewport.width > project.canvas.width
      || viewport.y + viewport.height > project.canvas.height) {
      reject(`${outputId}.sourceViewport is outside the live master canvas`);
    }
    const overlap = patch?.overlap;
    for (const edge of overlapEdges) requirePixel(overlap?.[edge], `${outputId}.overlap.${edge}`);
    membersBySurface.get(patch.surfaceId).push({ id: outputId, viewport, overlap });
  }

  for (const surface of candidatePreset.surfaces) {
    validateSurfaceLayout(surface, membersBySurface.get(surface.id));
  }
}

const response = await fetch(`${api}/v1/projects/default`);
if (!response.ok) throw new Error(await response.text());
const { project } = await response.json();
validatePreset(project, preset);

const candidate = {
  ...project,
  walls: preset.surfaces,
  outputs: project.outputs.map((output) => {
    const patch = preset.outputs[output.id];
    return {
      ...output,
      wallId: patch.surfaceId,
      sourceViewport: { ...output.sourceViewport, ...patch.sourceViewport },
      overlap: { ...output.overlap, ...patch.overlap },
    };
  }),
};
const saveResponse = await fetch(`${api}/v1/projects/default`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "if-match": String(project.revision),
  },
  body: JSON.stringify(candidate),
});
const saved = await saveResponse.json();
if (!saveResponse.ok) throw new Error(JSON.stringify(saved));
console.log(`Saved named-surface project revision ${saved.project.revision}`);
```

## Freeze the accepted preset

Download the complete authoritative project, not only its `walls` fragment.
Name it `named-surfaces-show-rN.project.json`, record its SHA-256, and archive it
with the Arena preset, binder command and physical-output worksheet.

```powershell
Get-FileHash .\named-surfaces-show-r*.project.json -Algorithm SHA256
```

## Show-day acceptance and recovery

1. Cold boot at the physical console and start the frozen Arena preset.
2. Confirm exact `PB-COMPOSITION` sender, canvas, format, and rate.
3. Require the frozen project revision to be live on every renderer.
4. Run the full Windows acceptance:

   ```powershell
   & 'C:\ProgramData\Pixel Brightness\Test-PixelBrightness.ps1' -Full
   ```

   Acceptance iterates over every output in the protected committed binding,
   sends Identify through Server → Node → native, observes the target isolated
   while all other outputs are black, and always restores every output to
   `content` before proceeding. It is independent of surface name and order.

5. Visually confirm each Identify flash appears on the worksheet's intended
   physical surface. Software can prove the exact committed output was driven;
   the operator confirms its real-world semantic name.

If a bind transaction was interrupted, rerun the exact same binder command so
it resumes its protected transaction. Do not use `-ResetSpatialConfig`. If only
the logical project is wrong, restore the frozen complete project with
`If-Match` against the current revision, but only after canvas, output IDs, node
IDs, resolutions, and complete physical display selectors match. Otherwise
remain black and rebind or diagnose.

After any edit or restore, acceptance is incomplete until the exact new project
revision is live everywhere, every committed output has been identified, all
outputs have returned to content, and `Test-PixelBrightness.ps1 -Full` passes.
