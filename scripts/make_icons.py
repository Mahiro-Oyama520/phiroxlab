"""Generate the PWA icons for PULSE/LAB with Pillow."""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
ASSETS.mkdir(exist_ok=True)


def mix(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    return tuple(round(a[i] * (1 - t) + b[i] * t) for i in range(3))  # type: ignore[return-value]


def make_master(size: int, safe: bool) -> Image.Image:
    image = Image.new("RGB", (size, size), (7, 10, 8))
    draw = ImageDraw.Draw(image, "RGBA")

    # Soft lime glow from the top-right.
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.ellipse(
        (size * 0.52, -size * 0.28, size * 1.28, size * 0.62),
        fill=(199, 255, 87, 62),
    )
    glow = glow.filter(ImageFilter.GaussianBlur(size * 0.16))
    image = Image.alpha_composite(image.convert("RGBA"), glow).convert("RGB")
    draw = ImageDraw.Draw(image, "RGBA")

    # Faint grid.
    step = size // 12
    for i in range(1, 12):
        x = i * step
        draw.line((x, 0, x, size), fill=(255, 255, 255, 8), width=max(1, size // 600))
        draw.line((0, x, size, x), fill=(255, 255, 255, 8), width=max(1, size // 600))

    # Inset rounded frame.
    inset = size * 0.075
    radius = size * 0.25
    draw.rounded_rectangle(
        (inset, inset, size - inset, size - inset),
        radius=radius,
        outline=(199, 255, 87, 42),
        width=max(2, round(size * 0.007)),
    )

    # Waveform coordinates. The maskable version stays well inside the safe zone.
    if safe:
        points = [
            (0.27, 0.53),
            (0.36, 0.53),
            (0.42, 0.40),
            (0.49, 0.64),
            (0.56, 0.46),
            (0.61, 0.55),
            (0.66, 0.50),
            (0.73, 0.50),
        ]
    else:
        points = [
            (0.18, 0.55),
            (0.30, 0.55),
            (0.37, 0.33),
            (0.48, 0.74),
            (0.56, 0.43),
            (0.62, 0.59),
            (0.68, 0.48),
            (0.82, 0.48),
        ]

    coords = [(x * size, y * size) for x, y in points]
    line_width = round(size * 0.052)
    glow_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow_layer)
    glow_draw.line(
        coords,
        fill=(199, 255, 87, 150),
        width=line_width + round(size * 0.032),
        joint="curve",
    )
    glow_layer = glow_layer.filter(ImageFilter.GaussianBlur(size * 0.026))
    image = Image.alpha_composite(image.convert("RGBA"), glow_layer).convert("RGB")
    draw = ImageDraw.Draw(image, "RGBA")

    draw.line(coords, fill=(214, 255, 112, 255), width=line_width, joint="curve")
    for x, y in (coords[0], coords[-1]):
        r = line_width * 0.58
        draw.ellipse((x - r, y - r, x + r, y + r), fill=(214, 255, 112, 255))

    # Tiny amplitude ticks.
    for i in range(4):
        x = size * (0.38 + i * 0.08)
        draw.line(
            (x, size * 0.82, x, size * 0.845),
            fill=(199, 255, 87, 80),
            width=max(2, round(size * 0.006)),
        )

    return image


def main() -> None:
    master_any = make_master(2048, safe=False)
    master_maskable = make_master(2048, safe=True)

    for output, source, size in [
        ("icon-192.png", master_any, 192),
        ("icon-512.png", master_any, 512),
        ("icon-maskable-512.png", master_maskable, 512),
        ("favicon-32.png", master_any, 32),
    ]:
        source.resize((size, size), Image.Resampling.LANCZOS).save(ASSETS / output, optimize=True)
        print(f"wrote assets/{output}")


if __name__ == "__main__":
    main()
