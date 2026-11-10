"""Turn captured Gray-code data into per-projector warp meshes and brightness maps.

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


def solve(data: dict, ref: int, progress=None) -> dict:
    import cv2
    import numpy as np

    t0 = time.perf_counter()
    projs = data["projectors"]
    nums = list(projs)
    black = data["black"]
    gw, gh = MESH
    lin = lambda img: (np.clip(img, 0, 255) / 255.0) ** GAMMA  # noqa: E731

    R = projs[ref]
    wR, hR = R["size"]
    validR = np.isfinite(R["px"])
    # positions use the shader's convention: pixel i is at (i + 0.5) / size
    qx_all = (R["px"] + 0.5) / wR
    qy_all = (R["py"] + 0.5) / hR
    hcam, wcam = black.shape
    ys, xs = np.mgrid[0:hcam, 0:wcam].astype(np.float32)

    out = {"ref": ref, "outputs": {}, "camera_size": (wcam, hcam)}
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

        if n == ref:
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
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, k5)
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, k5)
        lit[n] = m > 0
        L[n] = np.where(lit[n], light, 0).astype(np.float32)
        dist = cv2.distanceTransform(m, cv2.DIST_L2, 5)
        t = np.clip(dist / ramp, 0, 1)
        W[n] = (t * t * (3 - 2 * t)).astype(np.float32)
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
    info = {"ref": result["ref"], "created": time.strftime("%Y-%m-%d %H:%M:%S"),
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
    return {"ref": int(info["ref"]), "outputs": outs, "info": info}
