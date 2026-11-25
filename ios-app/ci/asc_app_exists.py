# Prints "yes" if an App Store Connect app record exists for the bundle ID, else "no".
import jwt, time, json, os, sys, urllib.request, urllib.parse
bid = sys.argv[1]
tok = jwt.encode({'iss': os.environ['ASC_ISSUER_ID'], 'iat': int(time.time()), 'exp': int(time.time()) + 600,
                  'aud': 'appstoreconnect-v1'}, os.environ['ASC_KEY_P8'], algorithm='ES256',
                 headers={'kid': os.environ['ASC_KEY_ID'], 'typ': 'JWT'})
url = 'https://api.appstoreconnect.apple.com/v1/apps?' + urllib.parse.urlencode({'filter[bundleId]': bid})
req = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + tok})
data = json.load(urllib.request.urlopen(req))['data']
print('yes' if any(a['attributes']['bundleId'] == bid for a in data) else 'no')
