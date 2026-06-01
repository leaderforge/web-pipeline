"""Generate a professional OG preview card image for demo sites."""
from PIL import Image, ImageDraw, ImageFont

W, H = 1200, 630

img = Image.new("RGB", (W, H), "#0D0D0D")
draw = ImageDraw.Draw(img)

# Left accent bar
draw.rectangle([0, 0, 8, H], fill="#2979C1")

# Top-right gradient overlay
for i in range(200):
    alpha = int(30 * (1 - i / 200))
    draw.rectangle([W - 300 + i, 0, W - 300 + i + 1, H], fill=(41, 121, 193))

# Text
try:
    font_large = ImageFont.truetype("C:\\Windows\\Fonts\\segoeui.ttf", 72)
    font_small = ImageFont.truetype("C:\\Windows\\Fonts\\segoeui.ttf", 28)
    font_brand = ImageFont.truetype("C:\\Windows\\Fonts\\segoeuib.ttf", 32)
except Exception:
    font_large = ImageFont.load_default()
    font_small = font_large
    font_brand = font_large

draw.text((80, 180), "Website", fill="#FFFFFF", font=font_large)
draw.text((80, 270), "Preview", fill="#2979C1", font=font_large)

# Divider line
draw.rectangle([80, 380, 200, 384], fill="#2979C1")

draw.text((80, 420), "A custom demo built by", fill="#AAAAAA", font=font_small)

# LeaderForge Digital branding
draw.rectangle([80, 470, 84, 520], fill="#2979C1")
draw.text((100, 470), "LeaderForge", fill="#FFFFFF", font=font_brand)
draw.text((370, 470), "Digital", fill="#2979C1", font=font_brand)

img.save("preview-card.jpg", quality=85)
print("Saved preview-card.jpg")
