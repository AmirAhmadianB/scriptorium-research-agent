"""Generate the Scriptorium desktop icon.

Mark = the system in one glyph: concentric radar arcs (the scanning agents)
around an amber quill-star (the writing engine), on a graphite→teal field.
Outputs: desktop/assets/icon-512.png and desktop/assets/scriptorium.ico
Run:  python desktop/make_icon.py
"""
from __future__ import annotations
import math
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).parent / "assets"
OUT.mkdir(exist_ok=True)

S = 1024  # supersample, downscale for crispness
GRAPHITE = (31, 37, 44)
TEAL = (44, 110, 99)
TEAL_DEEP = (30, 74, 67)
AMBER = (222, 168, 66)
PORCELAIN = (236, 239, 234)


def rounded_gradient() -> Image.Image:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    grad = Image.new("RGB", (S, S))
    for y in range(S):
        t = y / S
        # diagonal-ish blend graphite → deep teal
        r = int(GRAPHITE[0] + (TEAL_DEEP[0] - GRAPHITE[0]) * t)
        g = int(GRAPHITE[1] + (TEAL_DEEP[1] - GRAPHITE[1]) * t)
        b = int(GRAPHITE[2] + (TEAL_DEEP[2] - GRAPHITE[2]) * t)
        for x in range(0, S, 8):
            grad.paste((r, g, b), (x, y, min(x + 8, S), y + 1))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=S // 5, fill=255)
    img.paste(grad, (0, 0), mask)
    return img


def draw_mark(img: Image.Image) -> None:
    d = ImageDraw.Draw(img)
    cx = cy = S // 2
    # radar arcs — three sweeps, gaps at rotating angles (a scan in motion)
    arcs = [(0.36, 145, 395, 20, PORCELAIN + (70,)),
            (0.27, 245, 495, 24, PORCELAIN + (110,)),
            (0.18, 335, 585, 28, TEAL[:3] and (120, 190, 176, 200))]
    for frac, a0, a1, w, color in arcs:
        r = S * frac
        d.arc([cx - r, cy - r, cx + r, cy + r], start=a0 % 360, end=a1 % 360,
              fill=color, width=w)
    # scan dot on the outer arc
    ang = math.radians(30)
    r = S * 0.36
    px, py = cx + r * math.cos(ang), cy - r * math.sin(ang)
    d.ellipse([px - 22, py - 22, px + 22, py + 22], fill=AMBER)

    # quill-star: eight tapered nibs (the ✳ of the wordmark, drawn as pen strokes)
    R_out, R_in, half_w = S * 0.125, S * 0.028, S * 0.02
    for k in range(8):
        a = math.radians(k * 45)
        tipx, tipy = cx + R_out * math.cos(a), cy + R_out * math.sin(a)
        b1 = a + math.pi / 2
        base1 = (cx + R_in * math.cos(a) + half_w * math.cos(b1),
                 cy + R_in * math.sin(a) + half_w * math.sin(b1))
        base2 = (cx + R_in * math.cos(a) - half_w * math.cos(b1),
                 cy + R_in * math.sin(a) - half_w * math.sin(b1))
        d.polygon([base1, (tipx, tipy), base2], fill=AMBER)
    d.ellipse([cx - R_in * 1.4, cy - R_in * 1.4, cx + R_in * 1.4, cy + R_in * 1.4],
              fill=GRAPHITE, outline=AMBER, width=10)


def main() -> None:
    img = rounded_gradient()
    draw_mark(img)
    png = img.resize((512, 512), Image.LANCZOS)
    png.save(OUT / "icon-512.png")
    png.resize((256, 256), Image.LANCZOS).save(
        OUT / "scriptorium.ico",
        sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
    print(f"wrote {OUT/'icon-512.png'} and {OUT/'scriptorium.ico'}")


if __name__ == "__main__":
    main()
