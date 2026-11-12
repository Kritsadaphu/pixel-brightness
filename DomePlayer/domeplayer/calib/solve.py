"""Turn captured Gray-code data into per-projector warp meshes and brightness maps.

Geometry (dome, the default): the camera looks up at the dome and a circle marks the dome's
edge in its picture. Every camera pixel inside it is a known spot of the Domemaster image
(angle around the circle = angle in the video, distance from the centre = view angle from
the camera, using the lens focal length). Each projector's mesh stores, for its own pixels,
the video position that belongs where that pixel lands, so the projectors may point at
different parts of the dome and overlap any amount.

Geometry (stacking): the first monitor is the reference. For every other projector we find,
through the camera, which reference pixel lands on the same spot of the dome. Its mesh stores
that reference position, so it shows exactly what the reference shows there.

Brightness: in camera space, S = sum of every projector's light. The target T is a smooth
surface at or below S everywhere (so it is reachable) and each projector is dimmed by
a_i = T * w_i / sum_j(w_j * L_j), where w_i fades to 0 at the projector's own edge so its
border does not show. Dimming is converted to a signal multiplier with gamma 2.2.
"""
from __future__ import annotations

import json
import logging
import time
from pathlib import Path

log = logging.getLogger("domeplayer.calib")

MESH = (64, 40)          # nodes across x, y of each projector
GAIN_DIV = 4             # brightness map = output size / 4
GAMMA = 2.2


def _splat(np, gx, gy, values, shape):
    """Bilinear splat of values at fractional node coords into a grid. Returns sums, weights."""
    gw, gh = shape
    x0 = np.floor(gx).astype(np.int64)
    y0 = np.floor(gy).astype(np.int64)
    fx, fy = gx - x0, gy - y0
    size = gw * gh
    sums = [np.zeros(size, np.float64) for _ in values]
    wsum = np.zeros(size, np.float64)
    for dx, dy, wt in ((0, 0, (1 - fx) * (1 - fy)), (1, 0, fx * (1 - fy)), (0, 1, (1 - fx) * fy), (1, 1, fx * fy)):
        idx = np.clip(y0 + dy, 0, gh - 1) * gw + np.clip(x0 + dx, 0, gw - 1)
        wsum += np.bincount(idx, weights=wt, minlength=size)
        for s, v in zip(sums, values):
            s += np.bincount(idx, weights=wt * v, minlength=size)
    return [s.reshape(gh, gw) for s in sums], wsum.reshape(gh, gw)


def _fill(np, arrs, valid, rings):
    """Grow valid nodes outward by averaging valid neighbours (fills holes, extends edges)."""
    valid = valid.copy()
    arrs = [a.copy() for a in arrs]
    for _ in range(rings):
        acc = [np.zeros_like(a) for a in arrs]
        cnt = np.zeros(valid.shape)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                sv = np.roll(np.roll(valid, dy, 0), dx, 1)
                if dy == 1: sv[0, :] = False
                if dy == -1: sv[-1, :] = False
                if dx == 1: sv[:, 0] = False
                if dx == -1: sv[:, -1] = False
                cnt += sv
                for a, s in zip(acc, arrs):
                    a += np.where(sv, np.roll(np.roll(s, dy, 0), dx, 1), 0)
        new = (~valid) & (cnt >= 3)
        for a, s in zip(acc, arrs):
            s[new] = a[new] / cnt[new]
        if not new.any():
            break
        valid |= new
    return arrs, valid


def _norm_blur(np, cv2, img, mask, sigma):
    m = mask.astype(np.float32)
    num = cv2.GaussianBlur(img * m, (0, 0), sigma)
    den = cv2.GaussianBlur(m, (0, 0), sigma)
    return np.where(den > 1e-4, num / np.maximum(den, 1e-4), 0)


LENS_TYPES = ("action", "equidistant")


def _lens_ray(np, dome: dict, cam_size):
    """ray(x, y) -> unit view directions for pixels of the worked-on camera picture, or None when
    the lens is not known.

    lens_type "action" (Insta360 Ace Pro 2 and other action cameras: stereographic picture,
    r = 2 f tan(angle / 2)) or "equidistant" (r = f * angle); lens_view_deg = the angle the
    camera sees across the SHORT side of its full picture (wall test: 2.7 m wide from 1 m =
    107 degrees). The worked-on picture may be a cut-out of the full frame (video: "frame")."""
    kind = dome.get("lens_type")
    view = np.radians(float(dome.get("lens_view_deg") or 0))
    if kind not in LENS_TYPES or not 0.2 < view < 3.3:
        return None
    wcam, hcam = cam_size
    frame = dome.get("frame") or {}
    fw, fh = frame.get("size") or (wcam, hcam)
    x0, y0, x1, y1 = frame.get("crop") or (0, 0, fw, fh)
    sx, sy = (x1 - x0) / wcam, (y1 - y0) / hcam
    half = min(fw, fh) / 2.0
    f = half / (2 * np.tan(view / 4)) if kind == "action" else half / (view / 2)

    def ray(x, y):
        X = x0 + np.asarray(x, np.float64) * sx - fw / 2.0
        Y = y0 + np.asarray(y, np.float64) * sy - fh / 2.0
        r = np.hypot(X, Y)
        th = 2 * np.arctan(r / (2 * f)) if kind == "action" else r / f
        th = np.minimum(th, np.pi * 0.95)
        psi = np.arctan2(Y, X)
        return np.stack([np.sin(th) * np.cos(psi), np.sin(th) * np.sin(psi), np.cos(th)], -1)
    return ray


def _on_dome(np, th, th_edge, dome: dict):
    """View angle from the dome axis -> Domemaster radius (1 = dome edge), for a camera on the axis.

    With the dome's shape (diameter and height of the cap, as YDome had them: 4.847 m / 0.778 m)
    the ray is followed to the dome surface, and the radius is the distance from the zenith
    ALONG the surface - the way YDome put the video on this dome (its "linear" fisheye map).
    How far the camera is below the dome follows from where it sees the edge. Without the
    shape: view angle / edge angle."""
    a = float(dome.get("dome_diameter_m") or 0) / 2.0
    h = float(dome.get("dome_height_m") or 0)
    if a <= 0 or h <= 0 or h > a:
        return th / np.maximum(th_edge, 1e-6)
    Rs = (a * a + h * h) / (2 * h)            # sphere radius
    cz = Rs - h                               # sphere centre below the rim plane
    te = np.clip(th_edge, 0.05, 1.5)
    d = a / np.tan(te)                        # camera below the rim plane
    k = cz - d
    c = np.cos(th)
    t = -c * k + np.sqrt(np.maximum(c * c * k * k - k * k + Rs * Rs, 0.0))
    s, z = t * np.sin(th), t * c - d
    return np.arctan2(s, z + cz) / np.arcsin(a / Rs)


def dome_to_video(np, xs, ys, cam_size, dome: dict):
    """Camera pixels -> Domemaster square position (0..1, y down) and radius (1 = dome edge)."""
    wcam, hcam = cam_size
    cx, cy, R = dome["circle_px"]
    dx, dy = xs - cx, ys - cy
    rho = np.hypot(dx, dy)
    ang = np.arctan2(dy, dx)
    f = float(dome.get("lens_mm", 0)) / float(dome.get("sensor_width_mm", 22.3)) * wcam
    known = _lens_ray(np, dome, cam_size)
    if known is not None:
        axis = known(cx, cy)
        th = np.arccos(np.clip(known(xs, ys) @ axis, -1, 1))
        th_edge = np.arccos(np.clip(known(cx + R * np.cos(ang), cy + R * np.sin(ang)) @ axis, -1, 1))
        rr = _on_dome(np, th, th_edge, dome)
    elif f > 0:
        # view angle away from the ray toward the dome centre (lens centre = picture centre)
        def ray(x, y):
            x = np.asarray(x, np.float64)
            y = np.asarray(y, np.float64)
            v = np.stack([(x - wcam / 2) / f, (y - hcam / 2) / f, np.ones_like(x)], -1)
            return v / np.linalg.norm(v, axis=-1, keepdims=True)
        axis = ray(cx, cy)
        th = np.arccos(np.clip(ray(xs, ys) @ axis, -1, 1))
        th_edge = np.arccos(np.clip(ray(cx + R * np.cos(ang), cy + R * np.sin(ang)) @ axis, -1, 1))
        rr = th / np.maximum(th_edge, 1e-6)
    else:
        rr = rho / max(R, 1e-6)
    a = ang - np.radians(float(dome.get("front_deg", 0))) + np.pi / 2   # FRONT = bottom of the Domemaster
    return 0.5 + 0.5 * rr * np.cos(a), 0.5 + 0.5 * rr * np.sin(a), rr


def _fill_holes(np, cv2, lit):
    """Unlit spots enclosed by lit area count as lit (a lamp or LED the camera sees directly is
    saturated with the projectors on and off, so it looks 'unlit'). The outer edge is not changed."""
    ff = np.pad(lit.astype(np.uint8), 1)                       # picture border = outside
    cv2.floodFill(ff, np.zeros((ff.shape[0] + 2, ff.shape[1] + 2), np.uint8), (0, 0), 2)
    return ff[1:-1, 1:-1] != 2


def find_circle(np, cv2, lit_union) -> tuple[float, float, float]:
    """Biggest circle that is fully lit by the projectors (first guess of the dome edge)."""
    m = np.pad(lit_union.astype(np.uint8), 1)          # picture border counts as unlit
    dist = cv2.distanceTransform(m, cv2.DIST_L2, 5)[1:-1, 1:-1]
    if dist.max() <= 0:
        h, w = lit_union.shape
        return w / 2, h / 2, min(w, h) * 0.45
    y, x = np.unravel_index(int(np.argmax(dist)), dist.shape)
    return float(x), float(y), float(dist[y, x])


def solve(data: dict, ref: int | None, progress=None, dome: dict | None = None) -> dict:
    """dome=None: stack on monitor 'ref'.  dome={circle, front_deg, lens_mm, ...}: dome mode."""
    import cv2
    import numpy as np

    t0 = time.perf_counter()
    projs = data["projectors"]
    nums = list(projs)
    black = data["black"]
    gw, gh = MESH
    lin = lambda img: (np.clip(img, 0, 255) / 255.0) ** GAMMA  # noqa: E731

    hcam, wcam = black.shape
    ys, xs = np.mgrid[0:hcam, 0:wcam].astype(np.float32)
    out = {"ref": ref, "outputs": {}, "camera_size": (wcam, hcam), "mode": "stack"}
    if dome is not None:
        ref = None
        fx, fy, fr = dome.get("circle") or (0, 0, 0)
        if fr > 0:
            circle = (fx * wcam, fy * hcam, fr * hcam)
        else:
            union = np.zeros((hcam, wcam), bool)
            blk = lin(black)
            for P in projs.values():
                li = np.maximum(lin(P["white"]) - blk, 0)
                union |= li > 0.12 * np.percentile(li, 99.5)
            union = _fill_holes(np, cv2, union)
            union = cv2.morphologyEx(union.astype(np.uint8), cv2.MORPH_OPEN, np.ones((9, 9), np.uint8))
            circle = find_circle(np, cv2, union)
        dome = dict(dome, circle_px=circle,
                    frame={"size": (data.get("video") or {}).get("size"), "crop": data.get("crop")})
        out.update(mode="dome", circle=[circle[0] / wcam, circle[1] / hcam, circle[2] / hcam],
                   front_deg=float(dome.get("front_deg", 0)))
        svx, svy, srr = dome_to_video(np, xs.astype(np.float64), ys.astype(np.float64), (wcam, hcam), dome)
        svx, svy, srr = svx.astype(np.float32), svy.astype(np.float32), srr.astype(np.float32)
    else:
        R = projs[ref]
        wR, hR = R["size"]
        validR = np.isfinite(R["px"])
        # positions use the shader's convention: pixel i is at (i + 0.5) / size
        qx_all = (R["px"] + 0.5) / wR
        qy_all = (R["py"] + 0.5) / hR
    out["ref"] = ref
    nodes_cam = {}
    for k, n in enumerate(nums):
        P = projs[n]
        w, h = P["size"]
        valid = np.isfinite(P["px"])
        gx = (P["px"][valid] + 0.5) / w * (gw - 1)
        gy = (P["py"][valid] + 0.5) / h * (gh - 1)
        # projector node -> camera position (where this projector's light lands)
        (sx, sy), wsum = _splat(np, gx, gy, [xs[valid], ys[valid]], (gw, gh))
        cvalid = wsum > 0.3
        camx = np.where(cvalid, sx / np.maximum(wsum, 1e-9), 0)
        camy = np.where(cvalid, sy / np.maximum(wsum, 1e-9), 0)
        (camx, camy), cvalid = _fill(np, [camx, camy], cvalid, 2)
        nodes_cam[n] = (camx, camy, cvalid)

        if dome is not None:
            # node -> camera position -> video position
            cxf, cyf = camx.astype(np.float32), camy.astype(np.float32)
            mx = cv2.remap(svx, cxf, cyf, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
            my = cv2.remap(svy, cxf, cyf, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
            mesh = np.stack([mx, my], -1).astype(np.float32)
            mesh[~cvalid] = np.nan
            cover = float(np.mean(cvalid))
        elif n == ref:
            mesh = None   # the reference keeps its own 4-corner warp
            cover = float(np.mean(cvalid))
        else:
            both = valid & validR
            gx2 = (P["px"][both] + 0.5) / w * (gw - 1)
            gy2 = (P["py"][both] + 0.5) / h * (gh - 1)
            (sqx, sqy), w2 = _splat(np, gx2, gy2, [qx_all[both], qy_all[both]], (gw, gh))
            mvalid = w2 > 0.3
            mx = np.where(mvalid, sqx / np.maximum(w2, 1e-9), 0)
            my = np.where(mvalid, sqy / np.maximum(w2, 1e-9), 0)
            (mx, my), mvalid = _fill(np, [mx, my], mvalid, 3)
            mesh = np.stack([mx, my], -1).astype(np.float32)
            mesh[~mvalid] = np.nan
            cover = float(np.mean(mvalid))
        out["outputs"][n] = {"mesh": mesh, "coverage": cover, "size": (w, h)}
        if progress:
            progress(0.1 + 0.5 * (k + 1) / len(nums))

    # ---- brightness, in camera space at half resolution -------------------------------------
    ds = 2
    small = (wcam // ds, hcam // ds)
    rs = lambda a: cv2.resize(a.astype(np.float32), small, interpolation=cv2.INTER_AREA)  # noqa: E731
    blk = lin(rs(black))
    L, W, lit = {}, {}, {}
    ramp = 0.06 * min(small)
    k5 = np.ones((5, 5), np.uint8)
    for n in nums:
        P = projs[n]
        light = np.maximum(lin(rs(P["white"])) - blk, 0).astype(np.float32)
        # lit area from the white picture (the stripe decode has tiny holes at stripe edges)
        m = (light > 0.12 * np.percentile(light, 99.5)).astype(np.uint8)
        # light bounced around the dome is bright but carries no stripes: only count where the
        # projector's own picture was decoded
        dec = cv2.resize(np.isfinite(P["px"]).astype(np.float32), small, interpolation=cv2.INTER_AREA)
        m &= cv2.morphologyEx((dec > 0.2).astype(np.uint8), cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, k5)
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, k5)
        lit[n] = m > 0
        L[n] = np.where(lit[n], light, 0).astype(np.float32)
        dist = cv2.distanceTransform(m, cv2.DIST_L2, 5)
        t = np.clip(dist / ramp, 0, 1)
        W[n] = (t * t * (3 - 2 * t)).astype(np.float32)
    if dome is not None:
        inside = rs(srr) < 1.0
        anylit = np.logical_or.reduce([lit[n] for n in nums])
        region = cv2.erode((inside & anylit).astype(np.uint8), k5) > 0
    else:
        region = cv2.erode(lit[ref].astype(np.uint8), k5) > 0
    S = sum(L.values())
    sigma = 0.05 * small[0]
    T = _norm_blur(np, cv2, S, region, sigma)
    for _ in range(12):
        T = np.minimum(T, S)
        T = _norm_blur(np, cv2, T, region, sigma)
    T = np.where(region, np.minimum(T, S) * 0.985, 0).astype(np.float32)
    denom = sum(W[n] * L[n] for n in nums)
    stats_s = S[region]
    stats_t = T[region]
    out["stats"] = {
        "uniformity_before": float(np.std(stats_s) / max(np.mean(stats_s), 1e-9)),
        "uniformity_after": float(np.std(stats_t) / max(np.mean(stats_t), 1e-9)),
        "brightness_kept": float(np.mean(stats_t) / max(np.mean(stats_s), 1e-9)),
        "black_drift": data.get("black_drift"),
        "seconds": 0.0,
    }
    if progress:
        progress(0.75)

    for n in nums:
        a = np.where((denom > 1e-6) & region, T * W[n] / np.maximum(denom, 1e-6), 0)
        a = np.clip(a, 0, 1).astype(np.float32)
        w, h = out["outputs"][n]["size"]
        mw, mh = max(2, w // GAIN_DIV), max(2, h // GAIN_DIV)
        camx, camy, cvalid = nodes_cam[n]
        # brightness-map pixel -> mesh node coords -> camera position (half-res)
        nx = np.clip((np.arange(mw, dtype=np.float32) + 0.5) / mw * (gw - 1), 0, gw - 1)
        ny = np.clip((np.arange(mh, dtype=np.float32) + 0.5) / mh * (gh - 1), 0, gh - 1)
        NX, NY = np.meshgrid(nx, ny)
        cx = cv2.remap(camx.astype(np.float32), NX, NY, cv2.INTER_LINEAR)
        cy = cv2.remap(camy.astype(np.float32), NX, NY, cv2.INTER_LINEAR)
        ok = cv2.remap(cvalid.astype(np.float32), NX, NY, cv2.INTER_LINEAR) > 0.99
        g = cv2.remap(a, cx / ds - 0.5, cy / ds - 0.5, cv2.INTER_LINEAR,
                      borderMode=cv2.BORDER_CONSTANT, borderValue=0)
        g = np.where(ok, g, 0) ** (1 / GAMMA)
        mesh = out["outputs"][n]["mesh"]
        if mesh is not None:   # no picture where the mesh has no reference position
            mok = cv2.remap(np.isfinite(mesh[..., 0]).astype(np.float32), NX, NY, cv2.INTER_LINEAR) > 0.5
            g = np.where(mok, g, 0)
        out["outputs"][n]["gain"] = g.astype(np.float32)
    out["stats"]["seconds"] = round(time.perf_counter() - t0, 1)
    if progress:
        progress(1.0)
    log.info("calibration solved in %.1fs: %s", out["stats"]["seconds"], out["stats"])
    return out


# ---- files ---------------------------------------------------------------------------------

def save(result: dict, folder: Path, extra: dict) -> None:
    import numpy as np
    folder.mkdir(parents=True, exist_ok=True)
    info = {"ref": result["ref"], "mode": result.get("mode", "stack"), "circle": result.get("circle"),
            "front_deg": result.get("front_deg"), "created": time.strftime("%Y-%m-%d %H:%M:%S"),
            "camera_size": result["camera_size"], "stats": result["stats"], "outputs": {}, **extra}
    for n, o in result["outputs"].items():
        if o["mesh"] is not None:
            np.save(folder / f"{n}_mesh.npy", o["mesh"])
        np.save(folder / f"{n}_gain.npy", o["gain"])
        info["outputs"][str(n)] = {"size": list(o["size"]), "coverage": round(o["coverage"], 4),
                                   "mesh": o["mesh"] is not None}
    (folder / "calibration.json").write_text(json.dumps(info, indent=2), encoding="utf-8")


def load(folder: Path) -> dict | None:
    import numpy as np
    f = folder / "calibration.json"
    if not f.exists():
        return None
    info = json.loads(f.read_text(encoding="utf-8"))
    outs = {}
    for k, o in info["outputs"].items():
        n = int(k)
        mesh = np.load(folder / f"{n}_mesh.npy") if o.get("mesh") else None
        outs[n] = {"size": tuple(o["size"]), "mesh": mesh, "gain": np.load(folder / f"{n}_gain.npy")}
    ref = info.get("ref")
    return {"ref": None if ref is None else int(ref), "mode": info.get("mode", "stack"),
            "outputs": outs, "info": info}


# ---- raw capture (kept so the dome circle can be changed without capturing again) ---------

def save_capture(data: dict, folder: Path) -> None:
    import numpy as np
    folder.mkdir(parents=True, exist_ok=True)
    arrs = {"black": data["black"].astype(np.uint8)}
    meta = {"nums": [], "black_drift": data.get("black_drift"), "skipped": list(data.get("skipped") or []),
            "video": data.get("video"), "crop": data.get("crop"), "ports": data.get("ports") or {}}
    for n, P in data["projectors"].items():
        meta["nums"].append({"num": n, "size": list(P["size"])})
        for k in ("px", "py"):   # 1/16 pixel steps in int16, -1 = not seen
            arrs[f"{n}_{k}"] = np.where(np.isfinite(P[k]), np.round(P[k] * 16), -1).astype(np.int16)
        arrs[f"{n}_white"] = np.clip(P["white"], 0, 255).astype(np.uint8)
    tmp = folder / "capture.tmp.npz"
    np.savez_compressed(tmp, **arrs)
    tmp.replace(folder / "capture.npz")
    (folder / "capture.json").write_text(json.dumps(meta), encoding="utf-8")
    try:
        import cv2
        cv2.imwrite(str(folder / "camera_black.jpg"), arrs["black"])
        whites = [arrs[f"{n}_white"] for n in data["projectors"]]
        cv2.imwrite(str(folder / "camera_white_all.jpg"), np.max(whites, axis=0))
        for n in data["projectors"]:
            cv2.imwrite(str(folder / f"camera_white_{n}.jpg"), arrs[f"{n}_white"])
    except Exception:  # noqa: BLE001 - pictures are only for looking at
        pass


def load_capture(folder: Path) -> dict | None:
    import numpy as np
    if not (folder / "capture.npz").exists() or not (folder / "capture.json").exists():
        return None
    meta = json.loads((folder / "capture.json").read_text(encoding="utf-8"))
    z = np.load(folder / "capture.npz")
    projs = {}
    for it in meta["nums"]:
        n = int(it["num"])
        px, py = z[f"{n}_px"].astype(np.float32), z[f"{n}_py"].astype(np.float32)
        bad = (px < 0) | (py < 0)
        px, py = px / 16, py / 16
        px[bad] = np.nan
        py[bad] = np.nan
        projs[n] = {"px": px, "py": py, "white": z[f"{n}_white"].astype(np.float32), "size": tuple(it["size"])}
    return {"projectors": projs, "black": z["black"].astype(np.float32), "black_drift": meta.get("black_drift"),
            "skipped": list(meta.get("skipped") or []), "video": meta.get("video"), "crop": meta.get("crop"),
            "ports": meta.get("ports") or {}}
