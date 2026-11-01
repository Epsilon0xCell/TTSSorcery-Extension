#!/usr/bin/env python3
"""TTSSorcery-Extension intro banner: inside a Christmas tree at night, wordless.
v1 (scratch/intro-v1.png) was sparse: diagonal stick branches, a flat oval pickle,
a mitten hand. v2 onward: a dense layered branch field, a tapered bumpy pickle
partly screened by a foreground bough, capsule fingers on the searching hand.
Foreground left: fir bough with clipped candle lantern and sagging gold beads.
Centre: the glass pickle half hidden. Right: paper chain with one pale repair
loop, hand entering from the edge. No text of any kind."""
import sys, math, random
from PIL import Image, ImageDraw, ImageFilter
import numpy as np
random.seed(11)
W, H = 1600, 900
v = sys.argv[1] if len(sys.argv) > 1 else "ship"
DEEP = (7, 22, 13); FIR = (15, 46, 26); FIR2 = (23, 64, 34); FIR3 = (30, 82, 42)
BOTTLE = (24, 92, 50); CRAN = (150, 26, 36); GOLD = (196, 148, 62)

img = Image.new("RGB", (W, H), DEEP)
d = ImageDraw.Draw(img, "RGBA")
for y in range(H):
    t = y / H
    d.line([(0, y), (W, y)], fill=(int(9 + 7 * t), int(28 + 13 * t), int(16 + 8 * t)))
glow = Image.new("RGBA", (W, H), (0, 0, 0, 0)); gd = ImageDraw.Draw(glow)
for gx, gy, gr, ga in ((280, 330, 210, 95), (1080, 230, 160, 55), (1290, 570, 190, 62), (740, 660, 140, 44), (520, 120, 130, 40)):
    gd.ellipse([gx - gr, gy - gr, gx + gr, gy + gr], fill=(255, 190, 90, ga))
img = Image.alpha_composite(img.convert("RGBA"), glow.filter(ImageFilter.GaussianBlur(60))).convert("RGB")
d = ImageDraw.Draw(img, "RGBA")

def bough(x, y, length, ang, col, wdt=3, ndl=30, nl0=30):
    ex, ey = x + length * math.cos(ang), y + length * math.sin(ang)
    d.line([(x, y), (ex, ey)], fill=col + (255,), width=wdt + 2)
    for i in range(ndl):
        t = i / ndl; bx, by = x + (ex - x) * t, y + (ey - y) * t
        nl = nl0 * (1 - t * 0.5)
        for s in (-1, 1):
            na = ang + s * 0.8
            d.line([(bx, by), (bx + nl * math.cos(na), by + nl * math.sin(na))], fill=col + (235,), width=2)

def spray(cx, cy, r, col, n=5, base=None):
    # a fir fan, not a starburst: several stems leaving one point inside a wide arc
    if base is None: base = random.uniform(0, math.pi * 2)
    for i in range(n):
        a = base + (i - (n - 1) / 2) * 0.42 + random.uniform(-0.08, 0.08)
        bough(cx, cy, r * random.uniform(0.75, 1.1), a, col, 2, 16, 24)

def ornament(cx, cy, r, col, chip=False):
    d.line([(cx, cy - r - 24), (cx, cy - r)], fill=(180, 170, 140, 255), width=3)
    d.ellipse([cx - 7, cy - r - 8, cx + 7, cy - r + 4], fill=(170, 150, 100, 255))
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=col + (255,))
    d.ellipse([cx - r + 6, cy - r + 6, cx - r // 2, cy - r // 3], fill=(255, 255, 255, 55))
    if chip:
        d.ellipse([cx + r // 3, cy + r // 4, cx + r // 3 + 15, cy + r // 4 + 11], fill=(118, 116, 108, 255))

# dense far field: overlapping sprays and long boughs fill the frame
random.seed(23)
for sx, sy in ((140, 140), (520, 90), (900, 130), (1330, 110), (240, 480), (620, 430), (1050, 470), (1420, 460), (120, 790), (560, 770), (1000, 800), (1460, 770), (800, 300)):
    spray(sx, sy, random.randint(120, 210), (11, 34, 19), 13)
for bx, by, bl, ba in ((60, 150, 760, 0.45), (880, 60, 800, 2.65), (160, 720, 860, -0.35), (1080, 780, 760, 3.35), (0, 520, 700, 0.1), (1600, 540, 720, math.pi - 0.12)):
    bough(bx, by, bl, ba, (12, 36, 20), 3, 34)
ornament(430, 300, 33, (112, 20, 30)); ornament(1185, 205, 27, (150, 118, 52))
ornament(1250, 435, 39, (166, 168, 170), chip=True); ornament(555, 565, 25, (150, 118, 52))
ornament(985, 620, 30, (112, 20, 30))
bough(0, 420, 640, 0.2, FIR, 4, 32); bough(1600, 370, 660, math.pi - 0.28, FIR, 4, 32)
bough(280, 70, 720, 0.92, FIR2, 4, 30); bough(1520, 110, 640, math.pi - 0.82, FIR2, 4, 30)

# pickle: tapered bumpy silhouette, centre, stem loop and cranberry ribbon above
px, py = 800, 392
pw, ph = 118, 218
pk = Image.new("RGBA", (260, 320), (0, 0, 0, 0)); pd = ImageDraw.Draw(pk)
pts = []
for i in range(25):
    t = i / 24; yy = 26 + t * (ph - 30)
    half = (pw / 2) * (0.58 + 0.42 * math.sin(math.pi * min(1, 0.10 + t * 0.95)) ** 0.7)
    pts.append((130 - half, yy))
for i in range(24, -1, -1):
    t = i / 24; yy = 26 + t * (ph - 30)
    half = (pw / 2) * (0.58 + 0.42 * math.sin(math.pi * min(1, 0.10 + t * 0.95)) ** 0.7)
    pts.append((130 + half, yy))
pd.polygon(pts, fill=BOTTLE + (255,))
for bx, by, br in ((104, 84, 13), (152, 116, 11), (100, 152, 12), (150, 188, 10), (120, 218, 9)):
    pd.ellipse([bx - br, by - br, bx + br, by + br], fill=(33, 110, 60, 255))
hl = Image.new("RGBA", (260, 320), (0, 0, 0, 0)); hd = ImageDraw.Draw(hl)
hd.line([(96, 44), (86, 120), (94, 206)], fill=(215, 255, 218, 120), width=9)
pk = Image.alpha_composite(pk, hl.filter(ImageFilter.GaussianBlur(5)))
pk = pk.rotate(13, expand=True, resample=Image.BICUBIC)
img.paste(pk, (px - 130, py - 130), pk); d = ImageDraw.Draw(img, "RGBA")
d.line([(px + 8, py - 128), (px + 2, py - 84)], fill=(170, 150, 100, 255), width=4)
d.ellipse([px - 12, py - 152, px + 22, py - 118], outline=CRAN + (255,), width=7)
# foreground bough crossing in front of the pickle's lower half: the hiding
bough(px - 215, py + 26, 440, 0.13, FIR3, 5, 30, 36)
spray(px + 120, py + 92, 110, FIR2, 11)
# paper chain, right, one pale repair loop (index 6)
for i in range(11):
    t = i / 10; cx, cy = 1055 + t * 490, 566 + math.sin(t * math.pi) * 88 - t * 58
    col = (216, 200, 170) if i == 6 else [(150, 26, 36), (20, 62, 34), (226, 214, 182)][i % 3]
    d.ellipse([cx - 29, cy - 16, cx + 29, cy + 16], outline=col + (255,), width=9)
# foreground bough left with bead string and lantern
bough(-20, 246, 580, 0.33, FIR2, 6, 36, 36)
for i in range(21):
    t = i / 20; bx, by = 36 + t * 440, 298 + math.sin(t * math.pi) * 60 + t * 24
    d.ellipse([bx - 5, by - 5, bx + 5, by + 5], fill=GOLD + (255,))
lx, ly = 268, 330
d.line([(lx, ly - 64), (lx, ly - 30)], fill=(60, 54, 40, 255), width=6)
d.rounded_rectangle([lx - 34, ly - 30, lx + 34, ly + 78], 8, fill=(38, 34, 28, 238), outline=(150, 128, 84, 255), width=3)
d.rectangle([lx - 24, ly - 16, lx + 24, ly + 62], fill=(255, 214, 130, 66))
fl = Image.new("RGBA", (W, H), (0, 0, 0, 0)); fd = ImageDraw.Draw(fl)
fd.ellipse([lx - 30, ly - 38, lx + 30, ly + 70], fill=(255, 176, 66, 105))
img = Image.alpha_composite(img.convert("RGBA"), fl.filter(ImageFilter.GaussianBlur(18))).convert("RGB")
d = ImageDraw.Draw(img, "RGBA")
d.ellipse([lx - 7, ly + 2, lx + 7, ly + 34], fill=(255, 226, 150, 255))
d.ellipse([lx - 3, ly + 12, lx + 3, ly + 30], fill=(255, 250, 230, 255))
# searching hand from the right: wrist block plus separate capsule fingers
skin = (198, 152, 118, 255)
d.rectangle([1470, 252, 1600, 348], fill=skin)
d.ellipse([1422, 256, 1510, 344], fill=skin)
for (fx, fy, fa, fl2) in ((1436, 268, math.pi + 0.5, 86), (1424, 292, math.pi + 0.16, 104), (1426, 318, math.pi - 0.18, 96), (1440, 340, math.pi - 0.52, 74)):
    ex, ey = fx + fl2 * math.cos(fa), fy + fl2 * math.sin(fa)
    d.line([(fx, fy), (ex, ey)], fill=skin, width=21)
    d.ellipse([ex - 10, ey - 10, ex + 10, ey + 10], fill=skin)
d.line([(1468, 344), (1408, 372)], fill=skin, width=19)  # thumb
# extra near sprays at the corners for depth
spray(60, 60, 150, FIR2, 12); spray(1540, 60, 150, FIR2, 12); spray(80, 850, 160, FIR, 12); spray(1520, 850, 160, FIR, 12)
vg = Image.new("RGBA", (W, H), (0, 0, 0, 0)); vd = ImageDraw.Draw(vg)
vd.rectangle([0, 0, W, H], fill=(0, 0, 0, 84)); vd.ellipse([-240, -150, W + 240, H + 190], fill=(0, 0, 0, 0))
img = Image.alpha_composite(img.convert("RGBA"), vg.filter(ImageFilter.GaussianBlur(120))).convert("RGB")
rng = np.random.default_rng(4); a = np.asarray(img).astype(np.int16)
img = Image.fromarray(np.clip(a + rng.normal(0, 4, a.shape[:2])[..., None], 0, 255).astype(np.uint8))
out = "intro-banner.png" if v == "ship" else f"scratch/intro-{v}.png"
img.save(out); print(out)
