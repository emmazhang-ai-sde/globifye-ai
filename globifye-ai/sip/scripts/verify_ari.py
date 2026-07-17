import json
import requests
from websocket import create_connection

ARI_HOST = "localhost:8088"
ARI_USER = "sip-mvp-user"
ARI_PASSWORD = "changeme_use_a_real_secret"
APP_NAME = "sip-mvp-app"

ws_url = f"ws://{ARI_HOST}/ari/events?api_key={ARI_USER}:{ARI_PASSWORD}&app={APP_NAME}"

print(f"Connecting to {ws_url} ...")
ws = create_connection(ws_url)
print("Connected. Waiting for calls into", APP_NAME, "(Ctrl+C to stop)")

while True:
    message = ws.recv()
    event = json.loads(message)

    if event.get("type") == "StasisStart":
        channel_id = event["channel"]["id"]
        print(f"Call arrived: channel {channel_id}")
        requests.post(
            f"http://{ARI_HOST}/ari/channels/{channel_id}/answer",
            auth=(ARI_USER, ARI_PASSWORD),
        )
