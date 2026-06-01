# Animation Files

Place generated video files here. The page auto-detects and plays them.

## File naming

| File | Animation | Size |
|------|-----------|------|
| `hero-desktop.webm` | Hero — Desktop | 1920×1080, 30fps |
| `hero-mobile.webm` | Hero — Mobile | 1080×1920, 30fps |
| `unified-desktop.webm` | Unified Inbox — Desktop | 1920×1080, 30fps |
| `unified-mobile.webm` | Unified Inbox — Mobile | 1080×1920, 30fps |

## Format

- **Preferred**: WebM VP9 with alpha channel (transparent background)
- **Fallback**: MP4 H.264 (page background matches video bg)
- **Max size**: ~8MB each (heavier = slower load)

## Behavior

- **Hero**: auto-plays muted on loop as soon as video loads, fades in smoothly
- **Unified Inbox**: plays once on scroll into view, pauses when out of view
- **Fallback**: if no video file, the poster image (still frame) displays instead
- **Mobile**: `<source media>` swaps to mobile video on screens < 768px

## Initial frames (posters)

These are the static images shown before the video loads:
- `hero-desktop.jpg` (or first frame of desktop animation)
- `hero-mobile.jpg` (or first frame of mobile animation)
- For Unified Inbox: CSS gradient placeholder
