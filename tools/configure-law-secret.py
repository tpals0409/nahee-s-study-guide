"""Install the law API credential without printing it in CI logs."""
import json, os, urllib.request
key = os.environ.get('LAW_OC', '')
if not key:
    raise SystemExit('LAW_OC secret is required for deployment')
url = 'https://api.cloudflare.com/client/v4/accounts/' + os.environ['CLOUDFLARE_ACCOUNT_ID'] + '/workers/scripts/hapgyeok-note/secrets'
request = urllib.request.Request(url, method='PUT', data=json.dumps({'name':'LAW_OC','text':key,'type':'secret_text'}).encode(), headers={'Authorization':'Bearer '+os.environ['CLOUDFLARE_API_TOKEN'], 'Content-Type':'application/json'})
with urllib.request.urlopen(request, timeout=30) as response:
    result = json.load(response)
if not result.get('success'):
    raise SystemExit('Unable to configure law API secret')
print('Law API credential configured')
