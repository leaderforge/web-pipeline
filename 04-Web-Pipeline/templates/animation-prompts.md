# Animation Prompts — Template & Guidelines

This template is used by `scripts/generate-animation-prompts.py` to produce
design-only prompts for 3 animation slots per landing page.

## Prompt Rules (STRICT)

Generated prompts must NEVER include:
- Pixel dimensions ("1920x1080", "1280x720", "8K")
- Aspect ratios ("16:9", "9:16", "1:1")
- Visual counts ("two houses", "three workers", "4 beams")
- Camera tech specs ("65mm", "24fps", "Unreal Engine 5")
- Resolution numbers ("4K", "8K", "HD")
- File formats ("WebM", "VP9", "MP4")

Generated prompts SHOULD include:
- Creative subject description
- Mood, atmosphere, emotional tone
- Lighting direction and quality (dramatic, soft, golden hour)
- Color palette hints (deep tones, warm accents, industrial cool)
- Material qualities (steel, concrete, fabric, organic)
- Composition hints (off-center, rule of thirds, macro, wide)
- Movement/transformation hints for the video step

## Animation Slots

### 1. Hero — Cinematic Establishing Shot
- Most dramatic, most polished
- Sets the visual tone for the entire page
- Dark background preferred (matches site theme)
- Subject: broad industry concept, scale, mastery

### 2. Mid-Page — Craftsmanship Detail
- Macro or medium shot
- Highlights skill, precision, quality
- Subject: process detail, material, technique
- Transition: macro → wider context

### 3. Closing — Emotional Payoff
- Warm tones, golden hour or soft light
- Sense of completion, trust, or aspiration
- Subject: finished result, environment, human element (silhouette/hands)
- Emotional crescendo

## Per Animation Output

Two variants (SAME prompts, user picks orientation in tool):
- **Desktop:** horizontal orientation
- **Mobile:** vertical orientation (mobile-first design)

Deliverables per animation: 1 start frame + 1 end frame → Kling 3 Flash → 5s video

## File Naming Convention
```
site/assets/video/
├── hero-desktop.mp4
├── hero-mobile.mp4
├── mid-desktop.mp4
├── mid-mobile.mp4
├── closing-desktop.mp4
└── closing-mobile.mp4
```

## Reference: Welding Brothers (completed project)

Animation prompts for this project are stored at:
`proyectos/welding-brothers/research/animation-prompts.md`
