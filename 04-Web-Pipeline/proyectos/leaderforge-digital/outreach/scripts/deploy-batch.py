"""Deploy all 5 demo pages using known site IDs. Bundles audio when available."""
import os, re, urllib.parse, subprocess, tempfile, shutil
from pathlib import Path

os.environ["NO_COLOR"] = "1"

SITES = {
    'sams-welding-inc': ('f26a9030-3512-4710-a4d5-298fa39da8dc', "Sam's Welding Inc.", 'San Diego, CA', '(619) 281-2709'),
    'san-diego-mobile-welder': ('a7d9d11c-297c-4f49-b48c-78627d165634', 'San Diego Mobile Welder', 'San Diego, CA', '858-437-2339'),
    'morena-welding': ('250efa2e-1b78-48fb-a35f-f65d819fb698', 'Morena Welding', 'San Diego, CA', '619-275-4829'),
    'california-on-site-welding': ('f5afd616-3790-444f-b2db-09b300fd00af', 'California On-Site Welding', 'Riverside, CA', ''),
    'american-mobile-welding': ('5b998300-8d91-4301-920e-e868fb0c7920', 'American Mobile Welding', 'Ontario, CA', ''),
}

AUDIO_DIR = Path(__file__).parent.parent / 'audio'
template = (Path(__file__).parent.parent / 'demo-template' / 'index.html').read_text(encoding='utf-8')
env = {**os.environ, 'NO_COLOR': '1'}

for slug, (site_id, name, city, phone) in SITES.items():
    city_clean = city.replace(' CA', '')
    phone_clean = phone.replace(' ', '').replace('-', '').replace('(', '').replace(')', '') if phone else '8584658919'
    phone_display = phone if phone else '(858) 465-8919'

    # Find audio file
    audio_url = ''
    audio_file = AUDIO_DIR / f'{slug}.mp3'
    if not audio_file.exists():
        candidates = list(AUDIO_DIR.glob(f'{slug}*.mp3')) if AUDIO_DIR.exists() else []
        if candidates:
            audio_file = candidates[0]
    if audio_file.exists():
        audio_url = './audio.mp3'

    html = template
    html = html.replace('{{BUSINESS_NAME}}', name)
    html = html.replace('{{BUSINESS_NAME_SHORT}}', name.split()[0])
    html = html.replace('{{BUSINESS_NAME_ENCODED}}', urllib.parse.quote(name))
    html = html.replace('{{TRADE}}', 'Welding')
    html = html.replace('{{CITY}}', city_clean)
    html = html.replace('{{CITY_ENCODED}}', urllib.parse.quote(city_clean))
    html = html.replace('{{PHONE}}', phone_clean)
    html = html.replace('{{PHONE_DISPLAY}}', phone_display)
    html = html.replace('{{LEAD_ID}}', slug)
    html = html.replace('{{AUDIO_URL}}', audio_url)

    build_dir = Path(tempfile.mkdtemp(prefix='demo-'))
    (build_dir / 'index.html').write_text(html, encoding='utf-8')

    # Copy audio file
    if audio_file.exists():
        shutil.copy2(audio_file, build_dir / 'audio.mp3')
        print(f'  Audio: bundled ({audio_file.name})')

    # Copy map placeholder
    map_img = Path(__file__).parent.parent / 'demo-template' / 'map-placeholder.jpg'
    if map_img.exists():
        shutil.copy2(map_img, build_dir / 'map-placeholder.jpg')

    print(f'Deploying {name} to {site_id}...', flush=True)
    r = subprocess.run(
        ['netlify.cmd', 'deploy', '--dir', str(build_dir), '--site', site_id, '--prod'],
        capture_output=True, text=True, encoding='utf-8', errors='ignore', timeout=120,
        cwd=str(build_dir), env=env,
    )

    combined = r.stdout + r.stderr

    if r.returncode == 0:
        m = re.search(r'Production URL:\s*(https://[^\s]+)', combined)
        if m:
            print(f'  OK: {m.group(1)}')
        else:
            print(f'  OK (deployed, rc=0)')
    else:
        print(f'  FAIL (rc={r.returncode})')
        for line in combined.splitlines():
            if 'error' in line.lower():
                print(f'    {line.strip()}')

    shutil.rmtree(build_dir, ignore_errors=True)

print('\nDone!')
