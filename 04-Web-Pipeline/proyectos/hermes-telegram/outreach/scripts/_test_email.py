"""One-shot test: send a single email to verify MIME fix renders HTML correctly."""
import sys, importlib.util, importlib.machinery
loader = importlib.machinery.SourceFileLoader("daily_send", "daily-send.py")
spec = importlib.util.spec_from_loader("daily_send", loader)
daily = importlib.util.module_from_spec(spec)
loader.exec_module(daily)
send_email = daily.send_email
find_screenshot = daily.find_screenshot
EMAIL_INITIAL_EN = daily.EMAIL_INITIAL_EN

name = "Javier's Custom Welding"
first = "Daniel"
city = "Bakersfield"
demo_url = "https://javiers-custom-welding.netlify.app"
screenshot = find_screenshot(name)

html = EMAIL_INITIAL_EN.format(first=first, business_name=name, city=city, demo_url=demo_url)
subject = f"TEST MIME FIX -- {first} -- quick look at {name} online"
success = send_email("daniel@leaderforgeai.com", subject, html, screenshot)
print(f"Test email sent: {success}")
