#!/usr/bin/env python3
"""TTSSorcery-Extension wordmark banner: a Christmas tree close enough that only
branches fill the width. The pickle hides deep inside, half screened by needles.
Treaty objects around it: candle lantern low left, gold bead strings, a paper
chain with one faded repair loop, a chipped silver grandmother ornament high up.
Two hands at opposite edges, older steadying at left, younger reaching at right
and stopping short. Title on the gift tag tied to the lowest branch, Arapey cream
on dark red card, tag turned slightly toward the viewer."""
import sys, math, random
from PIL import Image, ImageDraw, ImageFilter, ImageFont
import numpy as np
random.seed(31)
W, H = 2560, 640
v = sys.argv[1] if len(sys.argv) > 1 else "ship"
FIR = (16, 48, 28); FIR2 = (24, 66, 36); BOTTLE = (25, 95, 51); GOLD = (196, 148, 62)
img = Image.new("RGB", (W, H), (8, 24, 14)); d = ImageDraw.Draw(img, "RGBA")
for y in range(H):
    d.line([(0, y), (W, y)], fill=(8, int(24 + 12 * y / H), 14))
glow = Image.new("RGBA", (W, H), (0, 0, 0, 0)); gd = ImageDraw.Draw(glow)
for gx, gy, gr, ga in ((420, 300, 260, 90), (1500, 220, 200, 55), (2150, 380, 220, 60)):
    gd.ellipse([gx - gr, gy - gr, gx + gr, gy + gr], fill=(255, 190, 90, ga))
img = Image.alpha_composite(img.convert("RGBA"), glow.filter(ImageFilter.GaussianBlur(70))).convert("RGB")
d = ImageDraw.Draw(img, "RGBA")
def bough(x, y, length, ang, col, wdt=4, ndl=30):
    ex, ey = x + length * math.cos(ang), y + length * math.sin(ang)
    d.line([(x, y), (ex, ey)], fill=col + (255,), width=wdt + 2)
    for i in range(ndl):
        t = i / ndl; bx, by = x + (ex - x) * t, y + (ey - y) * t
        nl = 32 * (1 - t * 0.5)
        for s in (-1, 1):
            na = ang + s * 0.8
            d.line([(bx, by), (bx + nl * math.cos(na), by + nl * math.sin(na))], fill=col + (235,), width=2)
def fan(cx, cy, r, col, base):
    for i in range(5):
        bough(cx, cy, r * random.uniform(0.75, 1.1), base + (i - 2) * 0.42, col, 2, 15)
for sx, sy, sb in ((200, 120, 0.6), (800, 80, 2.4), (1500, 100, 0.9), (2150, 90, 2.8), (400, 520, -0.5), (1200, 540, 3.6), (2000, 520, -0.9), (100, 330, 0.1), (2450, 320, 3.0)):
    fan(sx, sy, random.randint(170, 260), (12, 37, 20), sb)
for bx, by, bl, ba in ((0, 210, 1100, 0.28), (2560, 190, 1150, math.pi - 0.3), (300, 620, 1200, -0.18), (1500, 640, 1100, math.pi + 0.15)):
    bough(bx, by, bl, ba, FIR, 4, 36)
def ornament(cx, cy, r, col, chip=False):
    d.line([(cx, cy - r - 22), (cx, cy - r)], fill=(180, 170, 140, 255), width=3)
    d.ellipse([cx - 7, cy - r - 8, cx + 7, cy - r + 4], fill=(170, 150, 100, 255))
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=col + (255,))
    d.ellipse([cx - r + 6, cy - r + 6, cx - r // 2, cy - r // 3], fill=(255, 255, 255, 55))
    if chip: d.ellipse([cx + r // 3, cy + r // 4, cx + r // 3 + 15, cy + r // 4 + 11], fill=(118, 116, 108, 255))
ornament(1730, 120, 36, (168, 170, 172), chip=True)   # grandmother ornament, high, chipped silver
ornament(620, 430, 34, (140, 112, 48)); ornament(1980, 300, 40, (128, 22, 34)); ornament(880, 180, 28, (128, 22, 34))
# gold bead strings
for x0, y0, x1, sag in ((180, 150, 900, 70), (1500, 130, 2300, 84)):
    for i in range(31):
        t = i / 30; bx, by = x0 + (x1 - x0) * t, y0 + math.sin(t * math.pi) * sag + t * 30
        d.ellipse([bx - 6, by - 6, bx + 6, by + 6], fill=GOLD + (255,))
# paper chain across the middle right, one faded repair loop
for i in range(9):
    t = i / 8; cx, cy = 1620 + t * 620, 430 + math.sin(t * math.pi) * 56 - t * 40
    col = (216, 200, 170) if i == 4 else [(150, 26, 36), (20, 62, 34), (226, 214, 182)][i % 3]
    d.ellipse([cx - 31, cy - 17, cx + 31, cy + 17], outline=col + (255,), width=9)
# pickle deep inside, half screened
px, py = 1240, 268
d.ellipse([px - 15, py - 118, px + 17, py - 84], outline=(158, 28, 38, 255), width=7)
pw, ph = 104, 196
pk = Image.new("RGBA", (230, 290), (0, 0, 0, 0)); pd = ImageDraw.Draw(pk)
pts = []
for i in range(25):
    t = i / 24; yy = 24 + t * (ph - 28)
    half = (pw / 2) * (0.56 + 0.44 * math.sin(math.pi * min(1, 0.10 + t * 0.95)) ** 0.7)
    pts.append((115 - half, yy))
for i in range(24, -1, -1):
    t = i / 24; yy = 24 + t * (ph - 28)
    half = (pw / 2) * (0.56 + 0.44 * math.sin(math.pi * min(1, 0.10 + t * 0.95)) ** 0.7)
    pts.append((115 + half, yy))
pd.polygon(pts, fill=BOTTLE + (255,))
for bx, by, br in ((92, 74, 11), (134, 106, 10), (90, 140, 10), (130, 168, 8)):
    pd.ellipse([bx - br, by - br, bx + br, by + br], fill=(33, 110, 60, 255))
hl = Image.new("RGBA", (230, 290), (0, 0, 0, 0)); hd = ImageDraw.Draw(hl)
hd.line([(88, 38), (80, 110), (88, 182)], fill=(215, 255, 218, 120), width=8)
pk = Image.alpha_composite(pk, hl.filter(ImageFilter.GaussianBlur(4))).rotate(11, expand=True, resample=Image.BICUBIC)
img.paste(pk, (px - 115, py - 108), pk); d = ImageDraw.Draw(img, "RGBA")
bough(px - 190, py + 44, 390, 0.12, FIR2, 5, 26)  # screening bough
# candle lantern low left
lx, ly = 330, 330
d.line([(lx, ly - 60), (lx, ly - 28)], fill=(60, 54, 40, 255), width=6)
d.rounded_rectangle([lx - 32, ly - 28, lx + 32, ly + 72], 8, fill=(38, 34, 28, 238), outline=(150, 128, 84, 255), width=3)
fl = Image.new("RGBA", (W, H), (0, 0, 0, 0)); fd = ImageDraw.Draw(fl)
fd.ellipse([lx - 30, ly - 36, lx + 30, ly + 64], fill=(255, 176, 66, 100))
img = Image.alpha_composite(img.convert("RGBA"), fl.filter(ImageFilter.GaussianBlur(16))).convert("RGB")
d = ImageDraw.Draw(img, "RGBA")
d.ellipse([lx - 6, ly + 2, lx + 6, ly + 30], fill=(255, 226, 150, 255))
# older hand steadying a branch at left edge; younger hand reaching at right
skin_o, skin_y = (172, 128, 94, 255), (205, 160, 124, 255)
d.rectangle([0, 400, 128, 486], fill=skin_o); d.ellipse([86, 404, 168, 482], fill=skin_o)
for (fx, fy, fa, fl2) in ((140, 414, 0.62, 70), (150, 442, 0.22, 92), (148, 470, -0.28, 78)):
    ex, ey = fx + fl2 * math.cos(fa), fy + fl2 * math.sin(fa)
    d.line([(fx, fy), (ex, ey)], fill=skin_o, width=19); d.ellipse([ex - 9, ey - 9, ex + 9, ey + 9], fill=skin_o)
d.rectangle([2432, 268, 2560, 360], fill=skin_y); d.ellipse([2350, 272, 2440, 356], fill=skin_y)
for (fx, fy, fa, fl2) in ((2380, 284, math.pi + 0.45, 80), (2366, 308, math.pi + 0.12, 96), (2368, 332, math.pi - 0.22, 88)):
    ex, ey = fx + fl2 * math.cos(fa), fy + fl2 * math.sin(fa)
    d.line([(fx, fy), (ex, ey)], fill=skin_y, width=20); d.ellipse([ex - 10, ey - 10, ex + 10, ey + 10], fill=skin_y)
# gift tag on the lowest branch, turned slightly, title in Arapey cream on dark red
tag = Image.new("RGBA", (1060, 190), (0, 0, 0, 0)); td = ImageDraw.Draw(tag)
td.rounded_rectangle([6, 6, 1054, 184], 16, fill=(122, 18, 28, 255), outline=(226, 214, 182, 255), width=4)
td.ellipse([34, 74, 74, 114], outline=(226, 214, 182, 255), width=5)
f = ImageFont.truetype("fonts/Arapey.ttf", 96)
txt = "TTSSorcery-Extension"
tw = td.textlength(txt, font=f)
td.text(((1060 - tw) / 2 + 20, 44), txt, font=f, fill=(243, 233, 205, 255))
tag = tag.rotate(-3, expand=True, resample=Image.BICUBIC)
img.paste(tag, (760, 428), tag); d = ImageDraw.Draw(img, "RGBA")
d.line([(820, 452), (700, 392)], fill=(200, 180, 130, 255), width=4)  # tag string
rng = np.random.default_rng(8); a = np.asarray(img).astype(np.int16)
img = Image.fromarray(np.clip(a + rng.normal(0, 3, a.shape[:2])[..., None], 0, 255).astype(np.uint8))
out = "banner.png" if v == "ship" else f"scratch/banner-{v}.png"
img.save(out); print(out)
