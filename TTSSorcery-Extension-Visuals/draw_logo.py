#!/usr/bin/env python3
"""TTSSorcery-Extension logo: one glass pickle on a cranberry ribbon loop, hung from
a fir branch tip entering from the upper left, two plain ornaments lower and behind.
Wordmark under it in Arapey, pumpkin cream on near black green, spaced like names
on a gift tag. At 64px only the pickle silhouette and ribbon loop must survive."""
import sys, math
from PIL import Image, ImageDraw, ImageFilter, ImageFont
import numpy as np
W = H = 1024
v = sys.argv[1] if len(sys.argv) > 1 else "ship"
BG = (10, 28, 17); BOTTLE = (26, 98, 54); CRAN = (158, 28, 38); CREAM = (243, 233, 205)
img = Image.new("RGB", (W, H), BG); d = ImageDraw.Draw(img, "RGBA")
for y in range(H):
    d.line([(0, y), (W, y)], fill=(10, int(28 + 10 * y / H), 17))
def bough(x, y, length, ang, col, wdt=4, ndl=26):
    ex, ey = x + length * math.cos(ang), y + length * math.sin(ang)
    d.line([(x, y), (ex, ey)], fill=col + (255,), width=wdt + 2)
    for i in range(ndl):
        t = i / ndl; bx, by = x + (ex - x) * t, y + (ey - y) * t
        nl = 30 * (1 - t * 0.5)
        for s in (-1, 1):
            na = ang + s * 0.8
            d.line([(bx, by), (bx + nl * math.cos(na), by + nl * math.sin(na))], fill=col + (235,), width=2)
# branch tip from upper left, stopping just past centre
bough(-10, 96, 560, 0.30, (26, 74, 38), 6, 30)
bough(120, 60, 380, 0.75, (20, 60, 31), 4, 22)
# two plain ornaments, lower and further back, deliberately ordinary
for cx, cy, r, col in ((268, 560, 52, (140, 112, 48)), (742, 596, 58, (120, 22, 32))):
    d.line([(cx, cy - r - 120), (cx, cy - r)], fill=(150, 140, 110, 160), width=3)
    d.ellipse([cx - 9, cy - r - 10, cx + 9, cy - r + 5], fill=(150, 132, 88, 255))
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=col + (235,))
    d.ellipse([cx - r + 9, cy - r + 9, cx - r // 2, cy - r // 3], fill=(255, 255, 255, 40))
# ribbon loop and the pickle, centre
cx = 512
d.ellipse([cx - 30, 128, cx + 30, 196], outline=CRAN + (255,), width=13)
d.line([(cx, 192), (cx, 232)], fill=(170, 150, 100, 255), width=5)
pw, ph = 215, 400
pk = Image.new("RGBA", (340, 470), (0, 0, 0, 0)); pd = ImageDraw.Draw(pk)
pts = []
for i in range(29):
    t = i / 28; yy = 30 + t * (ph - 36)
    half = (pw / 2) * (0.30 + 0.70 * math.sin(math.pi * min(1, 0.06 + t * 0.96)) ** 0.6)
    pts.append((170 - half, yy))
for i in range(28, -1, -1):
    t = i / 28; yy = 30 + t * (ph - 36)
    half = (pw / 2) * (0.30 + 0.70 * math.sin(math.pi * min(1, 0.06 + t * 0.96)) ** 0.6)
    pts.append((170 + half, yy))
pd.polygon(pts, fill=BOTTLE + (255,))
for bx, by, br in ((138, 110, 20), (196, 160, 17), (132, 224, 19), (192, 288, 16), (152, 344, 14)):
    pd.ellipse([bx - br, by - br, bx + br, by + br], fill=(35, 116, 63, 255))
hl = Image.new("RGBA", (340, 470), (0, 0, 0, 0)); hd = ImageDraw.Draw(hl)
hd.line([(140, 52), (126, 200), (138, 360)], fill=(220, 255, 222, 130), width=15)
pk = Image.alpha_composite(pk, hl.filter(ImageFilter.GaussianBlur(6)))
pk = pk.rotate(6, expand=True, resample=Image.BICUBIC)
img.paste(pk, (cx - 170, 218), pk); d = ImageDraw.Draw(img, "RGBA")
# wordmark on the gift tag ground: plain cream Arapey, tall and calm
f = ImageFont.truetype("fonts/Arapey.ttf", 64 if v == "v1" else 72)
txt = "TTSSorcery-Extension"
tw = d.textlength(txt, font=f)
d.text(((W - tw) / 2, 806), txt, font=f, fill=CREAM)
rng = np.random.default_rng(6); a = np.asarray(img).astype(np.int16)
img = Image.fromarray(np.clip(a + rng.normal(0, 3, a.shape[:2])[..., None], 0, 255).astype(np.uint8))
out = "logo.png" if v == "ship" else f"scratch/logo-{v}.png"
img.save(out)
img.resize((64, 64), Image.LANCZOS).save("scratch/logo64-ship.png" if v == "ship" else f"scratch/logo64-{v}.png")
print(out)
