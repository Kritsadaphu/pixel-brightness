"""Calibration from a RECORDED video instead of a live camera.

For cameras that see the whole dome but are no use as a webcam: a 360 camera (Insta360),
an action camera, a phone. The player shows the patterns on a timetable (session.PatternShow)
while the camera records; the video file is then read here.

How the patterns are found in the video: the show starts with three white flashes on every
projector, 2 seconds apart. Their rising edges are found in the picture brightness; from
then on every pattern is at a known time. Each pattern is held long enough for many video
frames; only the frames from the middle of its time are used (averaged).

The picture is cut to the part that lights up and made smaller when it is bigger than max_px.

A 360 camera films with two lenses. Newer Insta360 models (X4, X5) put both into one file as
two video tracks, older ones (X3, X2) write one file per lens. Only the lens that looks up at
the dome is of use: decode_best() tries the first track and, when no projector can be read
in it, the second one.
"""
from __future__ import annotations

import logging
import os
import shutil
import struct
from pathlib import Path

log = logging.getLogger("domeplayer.calib")

FLASH_GAP_S = 2.0        # PatternShow: rising edges of the three start flashes
FLASH_ON_S = 1.0


class VideoError(RuntimeError):
    pass


def _level(small) -> float:
    """Brightness of the brightest tenth of a small grey picture. The whole-picture average
    barely moves when the dome is a small part of a 360 camera's picture."""
    import numpy as np
    flat = np.sort(small, axis=None)
    return float(flat[-max(1, flat.size // 10):].mean())


def _find_flashes(times, levels, gaps=(FLASH_GAP_S, FLASH_GAP_S), on_s=FLASH_ON_S):
    """Rising-edge times of the three start flashes ('gaps' seconds apart, each on_s long), or None."""
    import numpy as np
    if len(times) < 30:
        return None
    t = np.asarray(times)
    v = np.asarray(levels, np.float32)
    recent = t >= t[-1] - 9.0
    lo, hi = np.percentile(v[recent], 8), np.percentile(v[recent], 92)
    if hi - lo < 4.0:
        return None
    on = v > (lo + hi) / 2
    rise = [float(t[i]) for i in range(1, len(t)) if on[i] and not on[i - 1]]
    fall = [float(t[i]) for i in range(1, len(t)) if not on[i] and on[i - 1]]
    for k in range(len(rise) - 2):
        r = rise[k:k + 3]
        if abs(r[1] - r[0] - gaps[0]) > 0.25 or abs(r[2] - r[1] - gaps[1]) > 0.25:
            continue
        ends = [next((f for f in fall if f > x), None) for x in r]
        if all(e is not None and abs(e - x - on_s) < 0.45 for e, x in zip(ends, r)):
            return r
    return None


def plain_path(path) -> str:
    """Windows: the short (8.3) name of a path with Thai or other non-English letters, because the
    video reader cannot open those. The path itself when there is no short name."""
    if os.name != "nt" or str(path).isascii():
        return str(path)
    try:
        import ctypes
        buf = ctypes.create_unicode_buffer(1024)
        n = ctypes.windll.kernel32.GetShortPathNameW(str(path), buf, 1024)
        if 0 < n < 1024 and buf.value.isascii():
            return buf.value
    except Exception:  # noqa: BLE001
        pass
    return str(path)


def _boxes(f, start: int, end: int):
    """(type, position, header length, size) of every MP4 box between start and end."""
    pos = start
    while pos + 8 <= end:
        f.seek(pos)
        size, kind = struct.unpack(">I4s", f.read(8))
        head = 8
        if size == 1:
            size = struct.unpack(">Q", f.read(8))[0]
            head = 16
        elif size == 0:
            size = end - pos
        if size < head or pos + size > end:
            return
        yield kind, pos, head, size
        pos += size


def video_tracks(path) -> list[int]:
    """File positions of the 'trak' box of every video track of an MP4 / MOV / INSV file."""
    out = []
    try:
        total = os.path.getsize(path)
        with open(path, "rb") as f:
            for kind, pos, head, size in list(_boxes(f, 0, total)):
                if kind != b"moov":
                    continue
                for k2, p2, h2, s2 in list(_boxes(f, pos + head, pos + size)):
                    if k2 != b"trak":
                        continue
                    for k3, p3, h3, s3 in list(_boxes(f, p2 + h2, p2 + s2)):
                        if k3 != b"mdia":
                            continue
                        for k4, p4, h4, s4 in list(_boxes(f, p3 + h3, p3 + s3)):
                            if k4 == b"hdlr":
                                f.seek(p4 + h4 + 8)
                                if f.read(4) == b"vide":
                                    out.append(p2)
    except (OSError, struct.error):
        return []
    return out


def only_track(path, number: int, folder: Path) -> Path:
    """A copy of the file in which only video track 'number' (0 = first) can be seen: the other
    video tracks are renamed to 'free' boxes, which every reader skips. Nothing is re-encoded."""
    marks = video_tracks(path)
    if number >= len(marks):
        raise VideoError("the file has no second video track")
    size = os.path.getsize(path)
    folder.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(folder).free < size + 500_000_000:
        raise VideoError(f"not enough free disk space to read the second lens of this video ({size / 1e9:.1f} GB needed)")
    copy = folder / "second_lens.tmp.mp4"
    shutil.copyfile(path, copy)
    with open(copy, "r+b") as f:
        for i, pos in enumerate(marks):
            if i != number:
                f.seek(pos + 4)
                f.write(b"free")
    return copy


def decode_best(path: Path, show: dict, max_px: int = 2160, progress=None, work_dir: Path | None = None) -> dict:
    """decode() on the video track that shows the dome (see the top of this file)."""
    import numpy as np

    def seen(data) -> float:      # biggest part of the picture any projector could be read in
        return max((float(np.isfinite(P["px"]).mean()) for P in data["projectors"].values()), default=0.0)

    first, first_error = None, None
    try:
        first = decode(path, show, max_px, progress, stream=0)
        if seen(first) >= 0.01:
            return first
        log.warning("almost nothing can be read in the first video track - trying the second one")
    except (VideoError, RuntimeError) as e:
        first_error = e
        log.warning("first video track: %s - trying the second one", e)
    second, copy = None, None
    try:
        if len(video_tracks(path)) >= 2:
            copy = only_track(path, 1, Path(work_dir) if work_dir else Path(path).parent)
            second = decode(copy, show, max_px, progress, stream=1)
            second["video"]["file"] = Path(path).name
        else:
            log.info("the file has only one video track")
    except (VideoError, RuntimeError) as e:
        log.info("second video track: %s", e)
    except OSError as e:
        log.warning("could not make a copy for the second video track: %s", e)
    finally:
        if copy is not None:
            try:
                copy.unlink()
            except OSError:
                pass
    best = second if second is not None and (first is None or seen(second) > seen(first)) else first
    if best is not None and seen(best) >= 0.01:
        return best
    if best is not None:      # flashes found, but no stripes can be read: never save that as a calibration
        first_error = VideoError("no projector picture can be read in this video (the lens saw only the glow "
                                 "of the room, or the picture is far too dark or too bright)")
    hint = (" If the camera wrote two files for this recording (one per lens, names differing in _00_ / _10_), "
            "choose the other file: this one may be the lens that looked at the floor")
    raise VideoError(str(first_error) + hint)


def decode(path: Path, show: dict, max_px: int = 2160, progress=None, stream: int = 0) -> dict:
    """Read the recording of a pattern show. Returns the same data a live capture gives
    (session.CalibrationSession.result), plus "crop" and "video"."""
    import cv2
    import numpy as np

    from .session import CalibrationSession

    nums = [int(n) for n in show["nums"]]
    sizes = {int(k): tuple(v) for k, v in show["sizes"].items()}
    ses = CalibrationSession(nums, sizes, None, skip_bits=int(show["skip_bits"]), measure_delay=False)
    if len(ses.steps) != len(show["steps"]):
        raise VideoError("this video does not belong to the last pattern show (number of patterns differs) - "
                         "show the patterns again and record again")
    hold = float(show["hold_s"])
    if len(show.get("flashes") or []) != 3:
        raise VideoError("the pattern show record is incomplete - show the patterns again and record again")
    fl = [float(x) for x in show["flashes"]]
    gaps = (fl[1] - fl[0], fl[2] - fl[1])              # as they really were on the projectors
    ends = [float(x) for x in show.get("flash_ends") or []]
    on_s = float(sum(e - f for e, f in zip(ends, fl)) / 3) if len(ends) == 3 else FLASH_ON_S

    # 'stream' only names the track in messages: the caller hands over a file whose first
    # visible video track is the wanted one (see only_track)
    cap = cv2.VideoCapture(plain_path(path), cv2.CAP_FFMPEG)
    if not cap.isOpened():
        cap = cv2.VideoCapture(plain_path(path))
    if not cap.isOpened():
        raise VideoError(f"the video file could not be opened: {path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    fw, fh = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    log.info("video %s track %d: %dx%d, %.2f pictures/s, %d pictures (%.0f s)", Path(path).name, stream + 1,
             fw, fh, fps, count, count / fps if fps else 0)
    if fps < 10:
        raise VideoError(f"the video has only {fps:.0f} pictures per second - record normal video (25-60 per second)")
    sw = 192
    sh = max(8, round(fh * sw / max(fw, 1)))

    def stamp(index: int) -> float:
        ms = cap.get(cv2.CAP_PROP_POS_MSEC)
        return ms / 1000.0 if ms > 0 else index / fps

    # ---- 1) find the three start flashes ----------------------------------------------------
    times, levels, smalls = [], [], []
    index = 0
    edges = None
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        t = stamp(index)
        index += 1
        small = cv2.cvtColor(cv2.resize(frame, (sw, sh), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
        times.append(t)
        levels.append(_level(small))
        smalls.append(small)
        if len(smalls) > int(fps * 12):
            smalls.pop(0)
        if index % 5 == 0:
            edges = _find_flashes(times, levels, gaps, on_s)
            # wait until the black after the third flash is in the picture too
            if edges and t > edges[2] + on_s + 0.6:
                break
            edges = None
        if progress and count:
            progress(0.9 * index / count)
    if not edges:
        raise VideoError("the three start flashes were not found in the video. Start the camera recording "
                         "BEFORE pressing 'show patterns', keep the room dark, and check the camera is pointed "
                         "at the dome and its exposure is fixed (not automatic)")
    offset = float(np.mean([e - float(f) for e, f in zip(edges, show["flashes"])]))
    log.info("start flashes at %.2f / %.2f / %.2f s of the video -> the show starts at %.2f s",
             edges[0], edges[1], edges[2], offset)

    # ---- 2) the part of the picture that lights up -------------------------------------------
    recent_t = times[-len(smalls):]
    white = [s for s, t in zip(smalls, recent_t) if edges[2] + 0.3 < t < edges[2] + on_s - 0.2]
    black = [s for s, t in zip(smalls, recent_t) if edges[2] + on_s + 0.25 < t < edges[2] + on_s + 0.6]
    if not white or not black:
        raise VideoError("the video has gaps around the start flashes - record again")
    diff = np.mean(white, axis=0) - np.mean(black, axis=0)
    peak = float(np.percentile(diff, 99.5))
    if peak < 8:
        raise VideoError("the flashes are too faint in the video - raise the camera exposure (ISO)")
    ys, xs = np.nonzero(diff > 0.2 * peak)
    mx, my = 0.10 * (xs.max() - xs.min() + 1), 0.10 * (ys.max() - ys.min() + 1)
    x0 = int(max(0, (xs.min() - mx) * fw / sw))
    x1 = int(min(fw, (xs.max() + 1 + mx) * fw / sw))
    y0 = int(max(0, (ys.min() - my) * fh / sh))
    y1 = int(min(fh, (ys.max() + 1 + my) * fh / sh))
    scale = min(1.0, max_px / max(x1 - x0, y1 - y0))
    out_size = (max(16, round((x1 - x0) * scale)), max(16, round((y1 - y0) * scale)))
    log.info("picture area used: x %d-%d, y %d-%d of %dx%d, worked on at %dx%d", x0, x1, y0, y1, fw, fh, *out_size)
    del smalls

    def gray(frame):
        g = cv2.cvtColor(frame[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY)
        if scale < 1.0:
            g = cv2.resize(g, out_size, interpolation=cv2.INTER_AREA)
        return g.astype(np.float32)

    # ---- 3) every pattern: average the frames from the middle of its time -------------------
    k = 0
    acc, n_acc = None, 0
    acc_c = None                    # colour (small) of the black and white patterns
    cw = max(16, min(240, out_size[0]))
    csize = (cw, max(16, round(cw * out_size[1] / out_size[0])))
    starts = [offset + float(t) for t in show["steps"]]
    # a pattern is on the projectors until the next one starts; after a hiccup of the player
    # that is sooner than planned, so every pattern gets its own window
    last_end = offset + float(show["steps_end"]) if show.get("steps_end") else starts[-1] + hold
    on = [min(hold, nxt - s) for s, nxt in zip(starts, starts[1:] + [last_end])]
    if min(on) < 0.3:
        raise VideoError("the player stuttered while it showed the patterns (some were on too briefly) - "
                         "show the patterns again and record again")
    leads = [min(0.3, d * 0.4) for d in on]
    stops = [s + d - min(0.12, d * 0.2) for s, d in zip(starts, on)]

    def finish(step_index: int) -> None:
        nonlocal acc, n_acc, acc_c
        st = ses.steps[step_index]
        if acc_c is not None and n_acc:
            ses.note_colour(st, acc_c / n_acc)
        acc_c = None
        if n_acc == 0:
            raise VideoError(f"the video has no picture for pattern {step_index + 1} of {len(starts)} - "
                             "it stopped too early or has gaps. Record again until the last flash")
        if st.num not in ses.skipped:
            try:
                ses._process(st, acc / n_acc)
            except RuntimeError as e:
                raise VideoError(str(e)) from None
        acc, n_acc = None, 0

    while k < len(starts):
        ok = cap.grab()
        if not ok:
            break
        t = stamp(index)
        index += 1
        while k < len(starts) and t > stops[k]:
            finish(k)
            k += 1
        if k >= len(starts):
            break
        if t >= starts[k] + leads[k]:
            ok, frame = cap.retrieve()
            if ok:
                g = gray(frame)
                acc = g if acc is None else acc + g
                n_acc += 1
                if ses.steps[k].kind in ("black", "white"):
                    c = cv2.resize(frame[y0:y1, x0:x1], csize, interpolation=cv2.INTER_AREA).astype(np.float32)
                    acc_c = c if acc_c is None else acc_c + c
        if progress and count and index % 15 == 0:
            progress(min(0.99, 0.9 * index / count))
    if k < len(starts):
        if k == len(starts) - 1 and n_acc:
            finish(k)
        else:
            raise VideoError(f"the video ends at pattern {k + 1} of {len(starts)} - record until the patterns are over")
    if not ses.white:
        raise VideoError("no projector is visible in the video")

    # ---- 4) did the camera clock keep pace? (last flash) ------------------------------------
    drift = None
    want = offset + float(show.get("end_flash", 0))
    lv, tm = [], []
    while show.get("end_flash") and len(tm) < int(fps * 4):
        ok, frame = cap.read()
        if not ok:
            break
        tm.append(stamp(index))
        index += 1
        lv.append(_level(cv2.cvtColor(cv2.resize(frame, (sw, sh), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)))
    if len(lv) > 5 and max(lv) - min(lv) > 4:
        mid = (max(lv) + min(lv)) / 2
        hit = next((tm[i] for i in range(1, len(lv)) if lv[i] > mid >= lv[i - 1]), None)
        if hit is not None:
            drift = hit - want
            log.info("camera clock against the PC over the whole show: %+.0f ms", drift * 1000)
    cap.release()
    if show.get("end_flash") and drift is None:
        raise VideoError("the closing flash is not where it should be in the video: the recording was stopped too "
                         "early, or it holds more than one pattern show. Record again: start the camera, show the "
                         "patterns ONCE, stop the camera after the last flash")
    if drift is not None and abs(drift) > 0.15:
        raise VideoError(f"the video runs {abs(drift):.2f} s {'late' if drift > 0 else 'early'} at the end "
                         "(camera drops pictures or has an uneven clock) - the result would be wrong. Record again, "
                         "at a normal 30 pictures per second")
    data = ses.result()
    data.update(crop=[x0, y0, x1, y1], video={"file": Path(path).name, "track": stream + 1, "size": [fw, fh],
                                              "fps": round(fps, 2),
                                              "start_s": round(offset, 2), "drift_ms": None if drift is None else round(drift * 1000)})
    if progress:
        progress(1.0)
    return data
