import subprocess, json
import numpy as np

SRC = '/run/media/memphis/LUMIX/DCIM/130MEDIA'
# (nazwa, plik, t_start, t_end) w sekundach pliku
JOBS = [
    ('0790_hook', f'{SRC}/DJI_0790.MP4', 1.20, 14.60),
    ('0791_pay',  f'{SRC}/DJI_0791.MP4', 1.12, 34.93),
]

CMD = [
    'ffmpeg', '-hide_banner', '-loglevel', 'error',
    '-i', '{path}', '-ss', '{a}', '-to', '{b}',
    '-vf', 'fps=10,scale=480:270,format=gray',
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
]

out = {}
for name, path, a, b in JOBS:
    cmd = [x.format(path=path, a=a, b=b) for x in CMD]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    n = len(raw) // (480 * 270)
    frames = np.frombuffer(raw, dtype=np.uint8)[: n * 480 * 270]
    frames = frames.reshape(n, 270, 480).astype(np.float32)

    bg = frames.mean(axis=0)
    diff = np.abs(frames - bg).mean(axis=0)      # ruch wzgledem tla
    h, w = diff.shape
    col = diff.mean(axis=0)
    thr = np.percentile(col, 60)
    mask = col >= thr
    idx = np.where(mask)[0]
    cx = float(idx.mean()) * (3840 / 480) if len(idx) else w / 2 * (3840 / 480)
    wgt = np.clip(col - np.percentile(col, 50), 0, None)
    cxw = float((np.arange(w) * wgt).sum() / wgt.sum()) * (3840 / 480) if wgt.sum() else cx
    rows = diff.mean(axis=1)
    rw = np.clip(rows - np.percentile(rows, 50), 0, None)
    cyw = float((np.arange(h) * rw).sum() / rw.sum()) * (2160 / 270) if rw.sum() else h / 2 * (2160 / 270)

    out[name] = dict(cx=cx, cxw=cxw, cy=cyw, nframes=n,
                     colprof=[round(float(v), 3) for v in (col / col.max())[::20]])
    print(f"{name}: klatki={n} cx={cx:.0f} cx_wazona={cxw:.0f} cy={cyw:.0f}")

json.dump(out, open('track.json', 'w'), indent=1)
print('### wrote track.json')