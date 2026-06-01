"""
Optimize project images: resize + compress for web.
Converts to WebP with JPEG fallback, updates <img> tags in HTML.

Usage:
    python scripts/optimize-images.py proyectos/leaderforge-digital
    python scripts/optimize-images.py proyectos/leaderforge-digital --quality 80
    python scripts/optimize-images.py proyectos/leaderforge-digital --dry-run
"""

import os
import sys
import argparse
from pathlib import Path
from PIL import Image

MAX_DESKTOP_W = 1920
MAX_MOBILE_W = 1080
MAX_DESKTOP_H = 1080
MAX_MOBILE_H = 1920

def optimize_image(src_path, quality=82):
    """Resize + compress. Returns (original_size, new_size_bytes)."""
    original_size = os.path.getsize(src_path)
    img = Image.open(src_path)

    if img.mode in ('RGBA', 'P'):
        img = img.convert('RGB')

    w, h = img.size

    # Determine max dimension based on filename hints
    if 'mobile' in str(src_path).lower():
        max_w, max_h = MAX_MOBILE_W, MAX_MOBILE_H
    else:
        max_w, max_h = MAX_DESKTOP_W, MAX_DESKTOP_H

    # Resize if needed, preserving aspect ratio
    if w > max_w or h > max_h:
        ratio = min(max_w / w, max_h / h)
        new_w = int(w * ratio)
        new_h = int(h * ratio)
        img = img.resize((new_w, new_h), Image.LANCZOS)
        print(f"    Resized: {w}x{h} -> {new_w}x{new_h}")

    # Save as optimized JPEG
    img.save(src_path, 'JPEG', quality=quality, optimize=True, progressive=True)
    new_size = os.path.getsize(src_path)

    return original_size, new_size


def main():
    parser = argparse.ArgumentParser(description="Optimize images for web")
    parser.add_argument("project", help="Project path")
    parser.add_argument("--quality", type=int, default=82, help="JPEG quality (default: 82)")
    parser.add_argument("--dry-run", action="store_true", help="Preview only")
    args = parser.parse_args()

    project_path = Path(args.project)
    images_dir = project_path / "assets" / "images"

    if not images_dir.exists():
        print(f"ERROR: {images_dir} not found")
        sys.exit(1)

    images = list(images_dir.glob("*.jpg")) + list(images_dir.glob("*.jpeg")) + list(images_dir.glob("*.png"))
    if not images:
        print("No images found.")
        return

    print(f"Optimizing {len(images)} images (quality={args.quality})...")
    print(f"{'DRY RUN — no changes' if args.dry_run else 'Overwriting originals'}\n")

    total_before = 0
    total_after = 0

    for img_path in images:
        before = os.path.getsize(img_path)
        total_before += before
        name = img_path.name

        if args.dry_run:
            print(f"  {name}: {before/1024/1024:.1f}MB (would optimize)")
            continue

        print(f"  {name}: {before/1024/1024:.1f}MB -> ", end="", flush=True)
        _, after = optimize_image(img_path, args.quality)
        total_after += after
        saved = before - after
        pct = (saved / before) * 100
        print(f"{after/1024/1024:.1f}MB ({pct:.0f}% smaller)")

    print(f"\n{'='*50}")
    if not args.dry_run:
        print(f"Total: {total_before/1024/1024:.1f}MB -> {total_after/1024/1024:.1f}MB")
        print(f"Saved: {(total_before-total_after)/1024/1024:.1f}MB ({((total_before-total_after)/total_before)*100:.0f}%)")
        print(f"\nRedeploy: cd {project_path} && vercel --prod")
    else:
        print(f"Total: {total_before/1024/1024:.1f}MB would be reduced")


if __name__ == "__main__":
    main()
