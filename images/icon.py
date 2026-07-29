import os

from PIL import Image, ImageDraw, ImageFont

S = 1024          # rendered large, downsampled to 256 for clean edges
BG = (33, 32, 32)
FG = (245, 245, 245)
MUTED = (128, 128, 128)
RADIUS = int(S * 0.176)   # matches the corner radius of kirby-content's icon

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)
draw.rounded_rectangle([0, 0, S - 1, S - 1], radius=RADIUS, fill=BG)

font = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", int(S * 0.135), index=1)

lines = [
    ("snippet(", FG, 0.20),
    ("'button',", FG, 0.41),
    ("['...'])", MUTED, 0.62),
]

left = S * 0.115

for text, colour, y in lines:
    draw.text((left, S * y), text, font=font, fill=colour)

img.resize((256, 256), Image.LANCZOS).save(
    os.path.join(os.path.dirname(__file__), "icon.png")
)
print("written")
