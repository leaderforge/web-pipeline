"""
Merge new Firecrawl/YellowPages leads with existing lead-queue.csv.
Deduplicates by phone (primary) and website (secondary).
Preserves pipeline state for existing leads. Archives old unmatched leads.
"""
import csv
import re
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
LEAD_CSV = ROOT / "data" / "lead-queue.csv"
OUTPUT_CSV = ROOT / "data" / "lead-queue-merged.csv"

# ── Raw scraped leads from Yellow Pages (7 cities) ──
# Format: {business_name, phone, city, website}
RAW_LEADS = [
    # ── Fresno CA ──
    {"business_name": "Mad Man Mobile Welder and Mechanic", "phone": "(559) 285-6014", "city": "Fresno CA", "website": "http://madmanmobilewelderandmechanic.localsearch.com/"},
    {"business_name": "Verduzco Ag Mobile Welding", "phone": "(559) 400-4586", "city": "Fresno CA", "website": ""},
    {"business_name": "G&B Mobile Welding Inc", "phone": "(559) 255-7907", "city": "Fresno CA", "website": ""},
    {"business_name": "Modern Welding of California", "phone": "(559) 275-9353", "city": "Fresno CA", "website": "http://www.modweldco.com/"},
    {"business_name": "Rand Welding & Fabrication", "phone": "(559) 233-0316", "city": "Fresno CA", "website": "http://www.randmachineworks.com/"},
    {"business_name": "Barnes Welding", "phone": "(559) 432-9353", "city": "Fresno CA", "website": "http://ramweldingsupply.com/"},
    {"business_name": "Unique Universal Welding", "phone": "(559) 369-6938", "city": "Fresno CA", "website": ""},
    {"business_name": "Morelos & Welding", "phone": "(559) 237-2772", "city": "Fresno CA", "website": ""},
    {"business_name": "Advanced Welding & Fabrication", "phone": "(559) 840-2949", "city": "Fresno CA", "website": ""},
    {"business_name": "Mayfield Welding Inc", "phone": "(559) 237-2031", "city": "Fresno CA", "website": "http://www.mayfieldweldinginc.com/"},
    {"business_name": "Performance Welding & Machine Inc", "phone": "(559) 233-0042", "city": "Fresno CA", "website": ""},
    {"business_name": "Ghazarian Welding & Fabrication", "phone": "(559) 233-1210", "city": "Fresno CA", "website": "http://www.ghazarianwelding.com/"},
    {"business_name": "Ogden Welding", "phone": "(559) 454-1132", "city": "Fresno CA", "website": ""},
    {"business_name": "Mike's Welding & Fabrication", "phone": "(559) 960-2570", "city": "Fresno CA", "website": ""},
    {"business_name": "Maylo Welding", "phone": "(559) 403-6814", "city": "Fresno CA", "website": ""},
    {"business_name": "Wildwest Welding-Fab Consulting", "phone": "(559) 312-3811", "city": "Fresno CA", "website": ""},
    {"business_name": "AAA Welding Shop & Portable", "phone": "(559) 237-5181", "city": "Fresno CA", "website": ""},
    {"business_name": "Diamond Welding", "phone": "(559) 268-9999", "city": "Fresno CA", "website": "https://www.diamondweldindustries.com/"},
    {"business_name": "Process Welding Fab & Engineering", "phone": "(559) 579-7497", "city": "Fresno CA", "website": ""},
    {"business_name": "Vulcan Welding & Fabrication", "phone": "(559) 981-5431", "city": "Fresno CA", "website": ""},
    {"business_name": "Young B's Welding", "phone": "(559) 288-5826", "city": "Fresno CA", "website": ""},
    {"business_name": "Faustino Welding", "phone": "(559) 312-8604", "city": "Fresno CA", "website": ""},
    {"business_name": "John's Welding & Repairs", "phone": "(559) 834-3331", "city": "Fresno CA", "website": ""},
    {"business_name": "Sal's Welding & Fabrication", "phone": "(559) 275-1726", "city": "Fresno CA", "website": ""},
    {"business_name": "Derek Lincoln Portable Welding", "phone": "(559) 434-0864", "city": "Fresno CA", "website": ""},
    {"business_name": "James Mark Welding", "phone": "(559) 917-5710", "city": "Fresno CA", "website": ""},

    # ── Sacramento CA ──
    {"business_name": "A1 Fabrication & Welding", "phone": "(916) 349-8700", "city": "Sacramento CA", "website": ""},
    {"business_name": "S & H Welding Inc", "phone": "(916) 661-6410", "city": "Sacramento CA", "website": ""},
    {"business_name": "Lincoln Welding & Machine", "phone": "(916) 442-4787", "city": "Sacramento CA", "website": ""},
    {"business_name": "Lawson's Welding & Service", "phone": "(916) 708-9038", "city": "Sacramento CA", "website": ""},
    {"business_name": "Custom Welding", "phone": "(916) 738-2835", "city": "Sacramento CA", "website": ""},
    {"business_name": "Overnight Welding Works", "phone": "(916) 706-1589", "city": "Sacramento CA", "website": ""},
    {"business_name": "Eagle Weld", "phone": "(916) 382-4555", "city": "Sacramento CA", "website": ""},
    {"business_name": "Mr. B's Welding and Fabrication", "phone": "(916) 275-7272", "city": "Sacramento CA", "website": "http://www.mrbsweldingandfabrication.com/"},
    {"business_name": "Top Pick Mobile Welding", "phone": "(209) 304-6271", "city": "Sacramento CA", "website": ""},
    {"business_name": "Advanced Welding Service", "phone": "(916) 804-7196", "city": "Sacramento CA", "website": ""},
    {"business_name": "Taurus Welding Inc", "phone": "(916) 812-2855", "city": "Sacramento CA", "website": "https://tauruswelding.com/"},
    {"business_name": "Jay's Mobile Welding & Fabricating", "phone": "(916) 203-8082", "city": "Sacramento CA", "website": ""},
    {"business_name": "Aaron's Mobile Welding", "phone": "(916) 717-1059", "city": "Sacramento CA", "website": ""},
    {"business_name": "Navarro Brother's Welding Co", "phone": "(916) 731-8452", "city": "Sacramento CA", "website": ""},
    {"business_name": "Halm Metal Fab", "phone": "(916) 992-6131", "city": "Sacramento CA", "website": "http://halmmetalfab.com/"},

    # ── Los Angeles CA ──
    {"business_name": "Benito's Iron Works", "phone": "(323) 364-0078", "city": "Los Angeles CA", "website": ""},
    {"business_name": "Hollywood Welding Works", "phone": "(323) 465-3137", "city": "Los Angeles CA", "website": "http://www.hollywoodwelding.com/"},
    {"business_name": "Aero Space Welding Inc", "phone": "(310) 914-0324", "city": "Los Angeles CA", "website": "http://aerospace-welding.com/"},
    {"business_name": "W M Welding & Fabricating Service", "phone": "(323) 712-1375", "city": "Los Angeles CA", "website": ""},
    {"business_name": "Martin Welding Works", "phone": "(213) 453-1253", "city": "Los Angeles CA", "website": "https://www.martinweldingworksllc.net/"},
    {"business_name": "L.A. City Welder", "phone": "(323) 480-7802", "city": "Los Angeles CA", "website": ""},
    {"business_name": "Cwelding Services", "phone": "(562) 879-9376", "city": "Los Angeles CA", "website": ""},
    {"business_name": "La City Certified Mobile Welding", "phone": "(213) 822-4509", "city": "Los Angeles CA", "website": ""},
    {"business_name": "Luis Steel Welding", "phone": "(213) 536-5990", "city": "Los Angeles CA", "website": ""},
    {"business_name": "Quality Steel Welding", "phone": "(323) 223-7545", "city": "Los Angeles CA", "website": ""},
    {"business_name": "Fab Works Pro", "phone": "(323) 649-3893", "city": "Los Angeles CA", "website": ""},
    {"business_name": "O K Welding", "phone": "(323) 750-3394", "city": "Los Angeles CA", "website": ""},
    {"business_name": "S & S Welding", "phone": "(323) 587-1332", "city": "Los Angeles CA", "website": ""},
    {"business_name": "Batten Welding Artistic", "phone": "(323) 484-9750", "city": "Los Angeles CA", "website": ""},
    {"business_name": "Artistic Welding Workshop", "phone": "(323) 778-4581", "city": "Los Angeles CA", "website": "http://artisticweldingworkshop.com/"},
    {"business_name": "BNC Welding", "phone": "(323) 589-8872", "city": "Los Angeles CA", "website": ""},
    {"business_name": "Alonsos Welding Svc", "phone": "(323) 264-3942", "city": "Los Angeles CA", "website": ""},
    {"business_name": "Hector's Welding", "phone": "(323) 759-1816", "city": "Los Angeles CA", "website": ""},
    {"business_name": "Mario's Welding", "phone": "(323) 751-3670", "city": "Los Angeles CA", "website": ""},
    {"business_name": "L.A. Certified Welder", "phone": "(213) 703-4832", "city": "Los Angeles CA", "website": ""},
    {"business_name": "VMR Welding Services", "phone": "(213) 448-9306", "city": "Los Angeles CA", "website": ""},
    {"business_name": "Professional Welding", "phone": "(310) 642-0112", "city": "Los Angeles CA", "website": ""},
    {"business_name": "Kelly's Block Welding", "phone": "(310) 827-6795", "city": "Los Angeles CA", "website": ""},
    {"business_name": "Dennis 24 Hour Welding", "phone": "(310) 473-0397", "city": "Los Angeles CA", "website": ""},
    {"business_name": "Montoya Welding Services", "phone": "(310) 213-5922", "city": "Los Angeles CA", "website": ""},

    # ── San Diego CA ──
    {"business_name": "Sam's Welding Incorporated", "phone": "(619) 810-9026", "city": "San Diego CA", "website": "http://www.samsweldinginc.com/"},
    {"business_name": "Jeff's Stainless Solutions", "phone": "(858) 566-0208", "city": "San Diego CA", "website": "http://jeffsstainless.com/"},
    {"business_name": "Livin Metal", "phone": "(619) 300-8782", "city": "San Diego CA", "website": ""},
    {"business_name": "Empire Welding", "phone": "(619) 887-4670", "city": "San Diego CA", "website": ""},
    {"business_name": "Iron Welding International", "phone": "(619) 623-8459", "city": "San Diego CA", "website": "http://ironlioninternational.com/"},
    {"business_name": "Jerry's Welding & Machine Inc", "phone": "(858) 565-4800", "city": "San Diego CA", "website": "https://jerryswelding.com/"},
    {"business_name": "Ski's Mobile Welding", "phone": "(619) 283-7744", "city": "San Diego CA", "website": ""},
    {"business_name": "San Diego Golden Gate Welding", "phone": "(619) 338-0952", "city": "San Diego CA", "website": ""},
    {"business_name": "Ken Miller Welding", "phone": "(619) 807-6743", "city": "San Diego CA", "website": "http://kenmillerwelding.com/"},
    {"business_name": "Stanley Welding Service", "phone": "(858) 395-5079", "city": "San Diego CA", "website": ""},
    {"business_name": "Morena Welding Inc", "phone": "(619) 275-4829", "city": "San Diego CA", "website": "http://morenawelding.com/"},
    {"business_name": "All Around Mobile Welding & Fabrication", "phone": "(619) 987-3511", "city": "San Diego CA", "website": ""},
    {"business_name": "Dobson & Gores Welding", "phone": "(619) 232-5809", "city": "San Diego CA", "website": ""},
    {"business_name": "Craftec Welding", "phone": "(619) 696-9348", "city": "San Diego CA", "website": ""},
    {"business_name": "Chuck's Custom Welding & Fabrication", "phone": "(619) 459-6494", "city": "San Diego CA", "website": ""},
    {"business_name": "D & C Q Welding", "phone": "(858) 270-8523", "city": "San Diego CA", "website": ""},
    {"business_name": "George's Welding", "phone": "(858) 395-1877", "city": "San Diego CA", "website": "http://www.georgeswelding.com/"},
    {"business_name": "Westech Metal Fabrication Inc", "phone": "(619) 702-9353", "city": "San Diego CA", "website": "http://westechmetalfab.com/"},
    {"business_name": "Kearny Mesa Welding", "phone": "(619) 933-4766", "city": "San Diego CA", "website": ""},
    {"business_name": "Metal Master Inc", "phone": "(858) 292-8880", "city": "San Diego CA", "website": "http://www.metalmasterinc.com/"},

    # ── San Jose CA ──
    {"business_name": "B Metal Fabrication", "phone": "(650) 273-0346", "city": "San Jose CA", "website": "https://www.bmetalfabrication.com/"},
    {"business_name": "All Fab Precision Sheetmetal Inc", "phone": "(408) 610-4083", "city": "San Jose CA", "website": "https://www.allfabprecision.com/"},
    {"business_name": "S & S Welding", "phone": "(408) 293-4135", "city": "San Jose CA", "website": "http://ssweld.com/"},
    {"business_name": "Brian's Welding", "phone": "(408) 275-9834", "city": "San Jose CA", "website": "http://brianswelding.com/"},
    {"business_name": "Welder's Heaven", "phone": "(408) 288-6706", "city": "San Jose CA", "website": "http://www.weldersheavensj.com/"},
    {"business_name": "Lam Welding", "phone": "(408) 295-3997", "city": "San Jose CA", "website": ""},
    {"business_name": "M & E Welding", "phone": "(408) 287-2114", "city": "San Jose CA", "website": ""},
    {"business_name": "Precision Weld Tech", "phone": "(408) 437-9031", "city": "San Jose CA", "website": "http://www.precisionweldtech.com/"},
    {"business_name": "Anytime Welding", "phone": "(408) 279-3292", "city": "San Jose CA", "website": "https://www.anytimewelding.com/"},
    {"business_name": "Chavez Welding Machining", "phone": "(408) 247-4658", "city": "San Jose CA", "website": ""},
    {"business_name": "Arturo Welding Service", "phone": "(408) 876-9649", "city": "San Jose CA", "website": ""},
    {"business_name": "TD Welding Machine", "phone": "(408) 515-7117", "city": "San Jose CA", "website": ""},
    {"business_name": "Ryland Custom Welding", "phone": "(408) 781-2509", "city": "San Jose CA", "website": ""},
    {"business_name": "A G's Welding & Service", "phone": "(408) 416-6899", "city": "San Jose CA", "website": ""},
    {"business_name": "J&J Welding S.R.", "phone": "(669) 296-4618", "city": "San Jose CA", "website": "https://welderca.com/"},
    {"business_name": "Jb's Portable Welding", "phone": "(408) 225-1714", "city": "San Jose CA", "website": ""},
    {"business_name": "Welding Linda", "phone": "(408) 972-2345", "city": "San Jose CA", "website": ""},
    {"business_name": "J & S Welding Co", "phone": "(408) 436-8800", "city": "San Jose CA", "website": ""},
    {"business_name": "Ffr Fabrication & Repair", "phone": "(408) 295-5674", "city": "San Jose CA", "website": "http://www.ffrfabrication.com/"},
    {"business_name": "Almaden Welding & Ornamental Wrought Iron", "phone": "(408) 294-4243", "city": "San Jose CA", "website": "http://www.weldingsanjose.com/"},
    {"business_name": "Robeck's Welding & Fab Inc", "phone": "(408) 287-0202", "city": "San Jose CA", "website": "http://robeckswelding.com/"},
    {"business_name": "Silicon Valley Ironworks", "phone": "(408) 227-4766", "city": "San Jose CA", "website": "http://www.siliconvalleyiron.com/"},

    # ── Oakland / Bay Area CA ──
    {"business_name": "Bayfab Metals Inc", "phone": "(341) 208-1594", "city": "Oakland CA", "website": "https://bayfabmetals.com/"},
    {"business_name": "Weld-It", "phone": "(341) 218-1528", "city": "Oakland CA", "website": "http://www.welditco.com/"},
    {"business_name": "Sanchez Iron Works", "phone": "(510) 632-7329", "city": "Oakland CA", "website": ""},
    {"business_name": "Arcsurfer", "phone": "(408) 841-0193", "city": "Oakland CA", "website": ""},
    {"business_name": "Brothers Welding", "phone": "(510) 479-7061", "city": "Oakland CA", "website": "http://brotherweldinginc.com/"},
    {"business_name": "Royal Welding Services Inc", "phone": "(510) 686-1440", "city": "Oakland CA", "website": ""},
    {"business_name": "Diaz Welding", "phone": "(510) 316-8434", "city": "Oakland CA", "website": "https://www.diazweldingco.com/"},
    {"business_name": "SS Steel", "phone": "(510) 772-0771", "city": "Oakland CA", "website": ""},
    {"business_name": "Garden Of Iron", "phone": "(510) 508-5250", "city": "Oakland CA", "website": ""},
    {"business_name": "Goma Iron Work", "phone": "(510) 636-1988", "city": "Oakland CA", "website": ""},
    {"business_name": "Carlos Welding Inc", "phone": "(510) 463-7371", "city": "Oakland CA", "website": "http://carlosweldinginc.com/"},
    {"business_name": "Williams Welding Co.", "phone": "(510) 521-5514", "city": "Alameda CA", "website": "http://www.williamswelding.net/"},
    {"business_name": "International Ornamental Iron Works", "phone": "(415) 822-3518", "city": "San Francisco CA", "website": "http://www.internationalornamentaliron.com/"},
    {"business_name": "Olympic Iron Works", "phone": "(415) 358-8601", "city": "San Francisco CA", "website": "http://www.olympicironworkssf.com/"},
    {"business_name": "Valencia's Iron Works", "phone": "(510) 600-8230", "city": "San Leandro CA", "website": ""},
    {"business_name": "Edwards Welding", "phone": "(510) 352-4389", "city": "San Leandro CA", "website": ""},
    {"business_name": "G K Welding", "phone": "(510) 233-0133", "city": "Richmond CA", "website": "http://www.gkwelding.com/"},
    {"business_name": "Applied Fusion Inc", "phone": "(510) 351-4511", "city": "San Leandro CA", "website": "https://appliedfusionllc.com/"},
    {"business_name": "Tom's Welding & Fabrication", "phone": "(415) 822-7971", "city": "San Francisco CA", "website": ""},
    {"business_name": "Paz Welding", "phone": "(415) 738-9419", "city": "San Francisco CA", "website": ""},
    {"business_name": "West Cork Welding Inc", "phone": "(415) 671-0994", "city": "San Francisco CA", "website": "http://westcorkwelding.com/"},
    {"business_name": "Catz Welding", "phone": "(415) 860-7400", "city": "San Francisco CA", "website": ""},

    # ── Bakersfield CA ──
    {"business_name": "B & G Machine and Welding", "phone": "(661) 241-8407", "city": "Bakersfield CA", "website": ""},
    {"business_name": "Rockys Welding Service", "phone": "(661) 808-1831", "city": "Bakersfield CA", "website": ""},
    {"business_name": "Welding Services", "phone": "(661) 427-8642", "city": "Bakersfield CA", "website": ""},
    {"business_name": "Javier's Custom Welding", "phone": "(661) 243-6139", "city": "Bakersfield CA", "website": "http://www.javierscustomwelding.com/"},
    {"business_name": "Raw Welding", "phone": "(661) 387-5950", "city": "Bakersfield CA", "website": "https://rawwelding.com/"},
    {"business_name": "Bakersfield Welding Service", "phone": "(661) 238-0493", "city": "Bakersfield CA", "website": ""},
    {"business_name": "Gils Welding", "phone": "(661) 324-2623", "city": "Bakersfield CA", "website": ""},
    {"business_name": "Eric's Welding Svc", "phone": "(661) 201-7579", "city": "Bakersfield CA", "website": ""},
    {"business_name": "Ross Fabrication And Welding Inc", "phone": "(661) 393-1242", "city": "Bakersfield CA", "website": ""},
    {"business_name": "Mariott Welding & General Engineering", "phone": "(661) 564-2266", "city": "Bakersfield CA", "website": "https://www.mariottwelding.com/"},
    {"business_name": "Scarbroughs Portable Welding", "phone": "(661) 978-6833", "city": "Bakersfield CA", "website": ""},
    {"business_name": "DMW Industries Inc", "phone": "(661) 829-1520", "city": "Bakersfield CA", "website": "http://dmwindustriesinc.com/"},
    {"business_name": "J & D Engineering", "phone": "(661) 589-2148", "city": "Bakersfield CA", "website": ""},
    {"business_name": "Moreno's Welding", "phone": "(661) 864-7987", "city": "Bakersfield CA", "website": ""},
    {"business_name": "Precision Welding Solutions Inc", "phone": "(661) 852-8464", "city": "Bakersfield CA", "website": "http://www.precisionweldingsolutions.com/"},
    {"business_name": "Quinonez Welding", "phone": "(661) 567-6604", "city": "Bakersfield CA", "website": ""},
    {"business_name": "Alpha Welding", "phone": "(661) 805-7378", "city": "Bakersfield CA", "website": ""},
    {"business_name": "Advanced Welding SVC", "phone": "(661) 621-2777", "city": "Bakersfield CA", "website": ""},
    {"business_name": "Shiflet Custom Welding", "phone": "(661) 439-0735", "city": "Bakersfield CA", "website": ""},
    {"business_name": "NSW NonStop Welding Inc", "phone": "(661) 599-9335", "city": "Bakersfield CA", "website": ""},
    {"business_name": "Gomez Brothers Custom Welding", "phone": "(661) 412-4995", "city": "Bakersfield CA", "website": ""},
    {"business_name": "RCL Welding Inc", "phone": "(661) 344-6192", "city": "Bakersfield CA", "website": ""},
    {"business_name": "Nitram Welding & Constr", "phone": "(661) 201-6726", "city": "Bakersfield CA", "website": ""},
    {"business_name": "Cheatwood Welding Service", "phone": "(661) 619-2292", "city": "Bakersfield CA", "website": ""},
]


def normalize_phone(phone: str) -> str:
    """Strip to digits only for comparison."""
    return re.sub(r'\D', '', phone)


def normalize_website(url: str) -> str:
    """Extract domain for comparison."""
    if not url:
        return ""
    url = url.strip().lower()
    url = re.sub(r'^https?://(www\.)?', '', url)
    url = url.split('/')[0]
    return url


def slugify(name: str) -> str:
    return re.sub(r'[^a-z0-9]', '', name.lower())[:30]


def is_welding_business(name: str) -> bool:
    """Filter out obvious non-welding businesses."""
    name_lower = name.lower()
    exclude_keywords = [
        'muffler', 'radiator', 'rental', 'powder coat', 'glass',
        'medical', 'security', 'film', 'turf', 'vacuum', 'plastic',
        'automotive', 'muffler tech', 'pinky', 'supply', 'equipment supply',
        'wire warehouse', 'chrome craft',
    ]
    for kw in exclude_keywords:
        if kw in name_lower:
            return False
    return True


def load_existing_leads(path: Path) -> list[dict]:
    """Load existing lead-queue.csv."""
    if not path.exists():
        return []
    with open(path, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        return list(reader)


def generate_lead_id(index: int) -> str:
    """Generate a short lead ID."""
    # Find next available pattern
    return f"ca{index:03d}"


def main():
    # 1. Load existing leads
    existing = load_existing_leads(LEAD_CSV)
    print(f"Existing leads: {len(existing)}")

    # 2. Build lookup maps from existing leads
    existing_by_phone = {}
    existing_by_website = {}
    for lead in existing:
        phone_digits = normalize_phone(lead.get('phone', ''))
        website_domain = normalize_website(lead.get('website', ''))
        if phone_digits:
            existing_by_phone[phone_digits] = lead
        if website_domain:
            existing_by_website[website_domain] = lead

    # 3. Deduplicate raw leads internally by phone
    seen_phones = set()
    unique_new = []
    for lead in RAW_LEADS:
        if not is_welding_business(lead['business_name']):
            continue
        phone_digits = normalize_phone(lead['phone'])
        if phone_digits in seen_phones:
            continue
        seen_phones.add(phone_digits)
        unique_new.append(lead)

    print(f"Unique new leads (after dedup + filter): {len(unique_new)}")

    # 4. Merge: match new against existing, or create new
    FIELD_NAMES = [
        'lead_id', 'business_name', 'contact_name', 'phone', 'email',
        'website', 'website_quality', 'city', 'state', 'source_url',
        'has_email', 'has_phone', 'has_website', 'priority', 'scraped_at',
        'demo_url', 'email_sent_at', 'email_status', 'batch_day',
        'funnel_stage', 'responded', 'notes', 'pipeline_stage'
    ]

    merged = []
    matched_existing_ids = set()
    new_lead_counter = 1

    for lead in unique_new:
        phone_digits = normalize_phone(lead['phone'])
        website_domain = normalize_website(lead['website'])

        # Try to match existing lead
        matched = None
        if phone_digits and phone_digits in existing_by_phone:
            matched = existing_by_phone[phone_digits]
        elif website_domain and website_domain in existing_by_website:
            matched = existing_by_website[website_domain]

        if matched:
            # Carry over existing state
            matched_existing_ids.add(matched['lead_id'])
            row = {k: matched.get(k, '') for k in FIELD_NAMES}
            # Update with any new info (website, city) if old was missing
            if not row['website'] and lead['website']:
                row['website'] = lead['website']
            if not row['city'] and lead['city']:
                row['city'] = lead['city']
            row['business_name'] = lead['business_name']  # Use freshest name
            merged.append(row)
        else:
            # New lead
            has_email = False  # Yellow Pages doesn't provide emails
            has_website = bool(lead['website'] and '.localsearch.com' not in lead['website'])
            row = {
                'lead_id': generate_lead_id(new_lead_counter),
                'business_name': lead['business_name'],
                'contact_name': '',
                'phone': lead['phone'],
                'email': '',
                'website': lead['website'] if has_website else '',
                'website_quality': 'unknown',
                'city': lead['city'],
                'state': 'CA',
                'source_url': lead['website'] if lead['website'] else '',
                'has_email': str(has_email).lower(),
                'has_phone': 'true',
                'has_website': str(has_website).lower(),
                'priority': '2' if has_website else '1',
                'scraped_at': '2026-05-28',
                'demo_url': '',
                'email_sent_at': '',
                'email_status': '',
                'batch_day': 'scraped',
                'funnel_stage': '',
                'responded': '',
                'notes': 'YP batch 2026-05-28',
                'pipeline_stage': 'scraped',
            }
            merged.append(row)
            new_lead_counter += 1

    # 5. Archive old leads that didn't match
    archived_count = 0
    for lead in existing:
        if lead['lead_id'] not in matched_existing_ids:
            if lead.get('pipeline_stage', '') not in ('archived',):
                row = {k: lead.get(k, '') for k in FIELD_NAMES}
                row['pipeline_stage'] = 'archived'
                if row['notes']:
                    row['notes'] += ' | archived 2026-05-28'
                else:
                    row['notes'] = 'archived 2026-05-28'
                merged.append(row)
                archived_count += 1

    print(f"Matched existing: {len(matched_existing_ids)}")
    print(f"New leads added: {new_lead_counter - 1}")
    print(f"Archived old: {archived_count}")
    print(f"Total merged: {len(merged)}")

    # 6. Write merged CSV
    with open(OUTPUT_CSV, 'w', encoding='utf-8', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=FIELD_NAMES)
        writer.writeheader()
        writer.writerows(merged)

    # Also overwrite lead-queue.csv
    with open(LEAD_CSV, 'w', encoding='utf-8', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=FIELD_NAMES)
        writer.writeheader()
        writer.writerows(merged)

    print(f"\nWritten: {OUTPUT_CSV}")
    print(f"Overwritten: {LEAD_CSV}")

    # 7. Stats
    with_email = sum(1 for m in merged if m.get('email') and m['email'].strip())
    with_demo = sum(1 for m in merged if m.get('demo_url') and m['demo_url'].strip())
    emailed = sum(1 for m in merged if m.get('pipeline_stage') == 'emailed')
    screenshotted = sum(1 for m in merged if m.get('pipeline_stage') == 'screenshotted')
    phone_only = sum(1 for m in merged if m.get('pipeline_stage') == 'phone_only')
    scraped = sum(1 for m in merged if m.get('pipeline_stage') == 'scraped')
    archived = sum(1 for m in merged if m.get('pipeline_stage') == 'archived')

    print(f"\n── Pipeline Summary ──")
    print(f"With email:     {with_email}")
    print(f"With demo URL:  {with_demo}")
    print(f"Emailed:        {emailed}")
    print(f"Screenshotted:  {screenshotted}")
    print(f"Phone-only:     {phone_only}")
    print(f"Scraped (new):  {scraped}")
    print(f"Archived:       {archived}")


if __name__ == '__main__':
    main()
