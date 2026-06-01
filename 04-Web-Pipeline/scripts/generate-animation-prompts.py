"""
Animation Prompt Generator for Client Launch Pipeline.

Reads the build brief and generates creative prompts for 3 animation
slots (hero, mid-page, closing). Outputs a file ready for manual
execution in Kling 3 Flash.

IMPORTANT RULES for generated prompts:
  - NO pixel dimensions (no "1920x1080", "4K", "HD", etc.)
  - NO aspect ratio specs (no "16:9", "9:16")
  - NO visual counts (no "two houses", "three workers", "4 people")
  - NO camera/film format specs (no "65mm", "24fps", "8K resolution")
  - YES: creative descriptions, mood, lighting, subject, atmosphere
  - YES: color palette references, action/motion hints
  - YES: emotional tone, style direction

The user will generate start + end frames manually using these prompts,
then feed them to Kling 3 Flash for video.

Usage:
    python scripts/generate-animation-prompts.py proyectos/[client-name]
"""

import sys
import argparse
from pathlib import Path
from datetime import datetime


def find_build_brief(project_dir: Path) -> Path | None:
    """Locate the build brief in the project research folder."""
    brief_paths = [
        project_dir / "research" / "04-build-brief.md",
        project_dir / "research" / "03-build-brief.md",
    ]
    for p in brief_paths:
        if p.exists():
            return p
    return None


def extract_design_context(brief_text: str) -> dict:
    """Extract relevant design details from the build brief for prompt generation."""
    ctx = {
        "industry": "",
        "colors": [],
        "tone": "",
        "hero_concept": "",
    }

    lines = brief_text.split("\n")
    for line in lines:
        lower = line.lower().strip()
        if "primary color" in lower or "primary:" in lower:
            ctx["colors"].append(line.strip())
        if "tone:" in lower or "tone of voice" in lower:
            ctx["tone"] = line.strip()
        if "industry" in lower or "niche" in lower:
            ctx["industry"] = line.strip()
        if "hero" in lower and ("h1" in lower or "headline" in lower or "option" in lower):
            ctx["hero_concept"] = line.strip()

    return ctx


def generate_prompts(project_name: str, design_context: dict) -> str:
    """Generate the animation prompts document (Markdown)."""

    industry = design_context.get("industry", "the business")
    tone = design_context.get("tone", "professional")

    today = datetime.now().strftime("%Y-%m-%d")

    doc = f"""# Animation Prompts — {project_name}
Generated: {today}

> These prompts are DESIGN-ONLY. No technical specs. Use them to generate
> start + end frame images, then feed both to Kling 3 Flash for 5-second video.
>
> Each animation needs TWO orientations (generated separately with the SAME prompt,
> just choose the aspect ratio in your tool):
>   - **Desktop** — horizontal (16:9 or similar wide frame)
>   - **Mobile** — vertical (9:16 or similar tall frame)

---

## Animation 1 — Hero

**Role:** Sets the cinematic tone. Most dramatic, most polished.

### Start Frame Prompt
A dramatic, cinematic establishing shot that conveys mastery and scale in {industry}. Deep shadow and controlled highlight creating depth and atmosphere. Rich color palette anchored by deep tones with warm accent highlights. Dark background allowing subject to stand out with volumetric presence. Shallow depth of field drawing focus to the central subject. Unreal Engine quality surfaces. Subject positioned off-center using rule of thirds composition.

### End Frame Prompt
Same scene, same subject, but evolved — subtle movement, new detail revealed, accent glow now active. Identical lighting setup and camera distance as start frame. Seamless visual continuity. The transformation suggests progress, completion, or revelation while maintaining cinematic mood.

### Motion Direction (for Kling)
Smooth cinematic camera movement from start to end frame over 5 seconds. Gentle dolly motion combined with subtle subject rotation. Dramatic lighting maintained throughout. Single continuous shot, no cuts. Suitable for seamless loop. Floating particles in atmosphere for depth.

---

## Animation 2 — Mid-Page

**Role:** Supporting concept — craftsmanship, process, or detail.

### Start Frame Prompt
Extreme close-up macro shot revealing texture, detail, and craftsmanship central to {industry}. Natural lighting from above with warm light tones blending with subtle cool accents. Shallow depth of field. Photorealistic surface detail. Horizontal composition emphasizing the subject's tactile quality. Premium product photography feel.

### End Frame Prompt
Same macro perspective but evolved — tool now in motion, material transforming, or hidden detail revealed. Identical lighting setup and focal length. Continuous moment from start frame. The evolution suggests skill, quality, or precision.

### Motion Direction (for Kling)
Slow macro pull-back or gentle rotation from start to end frame over 5 seconds, revealing more context. Smooth gimbal-style movement. Warm cinematic color grading. Single continuous shot. ASMR-quality smoothness.

---

## Animation 3 — Closing

**Role:** Emotional payoff — trust, completion, or aspiration.

### Start Frame Prompt
Wide environmental shot suggesting accomplishment, pride, or the finished result in {industry}. Golden hour lighting with warm amber and orange tones. Professional photography composition with atmospheric depth. Human element present as silhouette or working hands. Sense of scale and possibility.

### End Frame Prompt
Same scene with emotional escalation — sunlight breaking through, completion moment, or final result fully revealed. Same warm color grading and composition. Slight camera push-in adding intimacy and impact.

### Motion Direction (for Kling)
Slow cinematic push-in from start to end frame over 5 seconds. Emotional crescendo with subtle lens flare. Warm golden hour throughout. Single take with smooth camera operator feel. Loop-friendly at endpoints.

---

## Usage Instructions

1. For each animation, generate the **Start Frame** image using these prompts
2. Generate the **End Frame** image (same tool, same settings)
3. For EACH orientation (desktop AND mobile), repeat steps 1-2
4. Feed both frames to **Kling 3 Flash** with image-to-video mode
5. Duration: 5 seconds, loop-friendly
6. Output: .mp4 H.264, no audio, max 2MB
7. Save as:
   - `site/assets/video/hero-desktop.mp4`
   - `site/assets/video/hero-mobile.mp4`
   - `site/assets/video/mid-desktop.mp4`
   - `site/assets/video/mid-mobile.mp4`
   - `site/assets/video/closing-desktop.mp4`
   - `site/assets/video/closing-mobile.mp4`
8. Replace the `<!-- 3D ASSET PLACEHOLDER -->` comments in index.html

---

## Customization Space

Use this section to add project-specific notes, reference images,
or adjustments to the base prompts above.

"""
    return doc


def main():
    parser = argparse.ArgumentParser(
        description="Generate animation prompts for Kling 3 Flash (design-only, no tech specs)"
    )
    parser.add_argument("project", help="Path to project directory (e.g., proyectos/welding-brothers)")
    parser.add_argument("--output", "-o", help="Output path (default: project/research/animation-prompts.md)")
    args = parser.parse_args()

    project_dir = Path(args.project).resolve()
    if not project_dir.exists():
        print(f"ERROR: {project_dir} not found")
        sys.exit(1)

    project_name = project_dir.name.replace("-", " ").title()

    # Try to load design context from build brief
    brief = find_build_brief(project_dir)
    design_context = {}
    if brief:
        text = brief.read_text(encoding="utf-8")
        design_context = extract_design_context(text)
        print(f"Loaded build brief: {brief.name}")
    else:
        print("No build brief found — using generic context")

    # Generate prompts
    doc = generate_prompts(project_name, design_context)

    # Save
    output_path = Path(args.output) if args.output else project_dir / "research" / "animation-prompts.md"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(doc, encoding="utf-8")

    print(f"\nAnimation prompts saved to: {output_path}")
    print(f"  Animations: 3 (hero, mid, closing)")
    print(f"  Variants each: desktop + mobile = 6 videos total")
    print(f"\nNext step: Use these prompts to generate start+end frames,")
    print(f"then Kling 3 Flash for 5-second video.")


if __name__ == "__main__":
    main()
