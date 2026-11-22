"""Generate Android launcher icons from the PULSE/LAB mark."""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
RES = ROOT / "android" / "res"
SOURCE = ROOT / "assets" / "icon-512.png"


def legacy_icons() -> None:
    source = Image.open(SOURCE).convert("RGB")
    sizes = {
        "mipmap-mdpi": 48,
        "mipmap-hdpi": 72,
        "mipmap-xhdpi": 96,
        "mipmap-xxhdpi": 144,
        "mipmap-xxxhdpi": 192,
    }
    for folder, size in sizes.items():
        path = RES / folder
        path.mkdir(parents=True, exist_ok=True)
        source.resize((size, size), Image.Resampling.LANCZOS).save(path / "ic_launcher.png", optimize=True)
        print(f"wrote {path / 'ic_launcher.png'}")


def adaptive_foreground() -> None:
    size = 432
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    points = [
        (0.28, 0.53),
        (0.37, 0.53),
        (0.43, 0.39),
        (0.50, 0.65),
        (0.56, 0.45),
        (0.61, 0.56),
        (0.66, 0.49),
        (0.73, 0.49),
    ]
    coords = [(x * size, y * size) for x, y in points]
    width = round(size * 0.047)

    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.line(
        coords,
        fill=(199, 255, 87, 145),
        width=width + 12,
        joint="curve",
    )
    glow = glow.filter(ImageFilter.GaussianBlur(11))
    image = Image.alpha_composite(image, glow)
    draw = ImageDraw.Draw(image)
    draw.line(coords, fill=(214, 255, 112, 255), width=width, joint="curve")
    for x, y in (coords[0], coords[-1]):
        radius = width * 0.58
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=(214, 255, 112, 255))

    folder = RES / "drawable-nodpi"
    folder.mkdir(parents=True, exist_ok=True)
    image.save(folder / "ic_launcher_foreground.png", optimize=True)
    print(f"wrote {folder / 'ic_launcher_foreground.png'}")


if __name__ == "__main__":
    legacy_icons()
    adaptive_foreground()
