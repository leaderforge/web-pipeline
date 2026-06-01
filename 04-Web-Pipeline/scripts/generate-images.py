"""
Hugging Face Image Auto-Generator for Client Launch Pipeline.

Reads image placeholders from site/index.html, generates each image
via Hugging Face Inference API (FLUX.1-dev), downloads to assets/images/,
and replaces placeholders in HTML with real image paths.

Usage:
    python scripts/generate-images.py proyectos/welding-brothers
    python scripts/generate-images.py proyectos/welding-brothers --skip-existing

Requires:
    HUGGINGFACE_TOKEN in .env file at pipeline root

Image placeholders in HTML:
    <img src="assets/images/placeholder.png"
         data-hf-prompt="Professional photo description"
         data-hf-model="black-forest-labs/FLUX.1-dev"
         data-hf-filename="hero-service.jpg"
         alt="Service photo">
"""

import os
import sys
import argparse
from pathlib import Path

from dotenv import load_dotenv
from huggingface_hub import InferenceClient

# ── Config ──────────────────────────────────────────────────────────

load_dotenv()

HF_TOKEN = os.getenv("HUGGINGFACE_TOKEN")
DEFAULT_MODEL = "black-forest-labs/FLUX.1-dev"

# Aspect ratios for photos (all 1:1 per spec)
PHOTO_SIZE = {"width": 1024, "height": 1024}


# ── HTML Placeholder Parser ─────────────────────────────────────────

def find_placeholders(html_path: Path) -> list[dict]:
    """Find all img tags with data-hf-prompt attributes."""
    import re

    html = html_path.read_text(encoding="utf-8")
    pattern = re.compile(
        r'<img[^>]*\bdata-hf-prompt\s*=\s*"([^"]*)"[^>]*>',
        re.IGNORECASE,
    )

    placeholders = []
    for match in pattern.finditer(html):
        full_tag = match.group(0)
        prompt = match.group(1)

        model_match = re.search(r'data-hf-model\s*=\s*"([^"]*)"', full_tag)
        model = model_match.group(1) if model_match else DEFAULT_MODEL

        fn_match = re.search(r'data-hf-filename\s*=\s*"([^"]*)"', full_tag)
        filename = fn_match.group(1) if fn_match else None

        placeholders.append({
            "full_tag": full_tag,
            "prompt": prompt,
            "model": model,
            "filename": filename or f"gen-{len(placeholders):02d}.jpg",
        })

    return placeholders


def replace_placeholder_in_html(html_path: Path, old_tag: str, new_src: str):
    """Replace a placeholder img tag with a real one, stripping data-hf-* attrs."""
    import re

    html = html_path.read_text(encoding="utf-8")
    new_tag = re.sub(r'src\s*=\s*"[^"]*"', f'src="{new_src}"', old_tag)
    new_tag = re.sub(r'\s*data-hf-(?:prompt|model|filename)\s*=\s*"[^"]*"', "", new_tag)
    new_tag = re.sub(r'\s{2,}', " ", new_tag)

    html = html.replace(old_tag.strip(), new_tag.strip())
    html_path.write_text(html, encoding="utf-8")


# ── Main Pipeline ───────────────────────────────────────────────────

def generate_images(project_dir: Path, skip_existing: bool = False):
    index_html = project_dir / "site" / "index.html"
    if not index_html.exists():
        print(f"  ERROR: {index_html} not found")
        return False

    assets_dir = project_dir / "site" / "assets" / "images"
    assets_dir.mkdir(parents=True, exist_ok=True)

    placeholders = find_placeholders(index_html)
    if not placeholders:
        print("  No image placeholders found (data-hf-prompt attrs)")
        return True

    client = InferenceClient(token=HF_TOKEN)
    print(f"  Found {len(placeholders)} image(s) to generate\n")

    for i, ph in enumerate(placeholders, 1):
        dest_path = assets_dir / ph["filename"]

        if skip_existing and dest_path.exists():
            print(f"  [{i}/{len(placeholders)}] SKIP (exists): {ph['filename']}")
            replace_placeholder_in_html(index_html, ph["full_tag"], f"assets/images/{ph['filename']}")
            continue

        print(f"  [{i}/{len(placeholders)}] Generating: {ph['filename']}")
        print(f"    Model:  {ph['model']}")
        print(f"    Prompt: {ph['prompt'][:80]}...")

        try:
            image = client.text_to_image(
                prompt=ph["prompt"],
                model=ph["model"],
                width=PHOTO_SIZE["width"],
                height=PHOTO_SIZE["height"],
            )
        except Exception as e:
            print(f"    ERROR: {e}")
            continue

        image.save(str(dest_path), quality=90)
        print(f"    SAVED: {dest_path}")

        replace_placeholder_in_html(index_html, ph["full_tag"], f"assets/images/{ph['filename']}")
        print(f"    HTML updated\n")

    print("  Done.\n")
    return True


def main():
    parser = argparse.ArgumentParser(description="Auto-generate images via Hugging Face API")
    parser.add_argument("project", help="Path to project directory (e.g., proyectos/welding-brothers)")
    parser.add_argument("--skip-existing", action="store_true", help="Skip images that already exist")
    args = parser.parse_args()

    if not HF_TOKEN:
        print("ERROR: HUGGINGFACE_TOKEN not set in .env")
        print("Create .env at pipeline root with: HUGGINGFACE_TOKEN=hf_...")
        sys.exit(1)

    project_dir = Path(args.project).resolve()
    if not project_dir.exists():
        print(f"ERROR: {project_dir} not found")
        sys.exit(1)

    print(f"\nHugging Face Image Generator")
    print(f"  Project: {project_dir.name}")
    print(f"  Model:   {DEFAULT_MODEL}")
    print(f"  Size:    {PHOTO_SIZE['width']}x{PHOTO_SIZE['height']} (1:1)")

    success = generate_images(project_dir, skip_existing=args.skip_existing)

    if success:
        print("Run: vercel --prod --cwd [project]\\site")
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
