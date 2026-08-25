# Front-end demo localHost
This folder contains a Python script to locally host the front-end with the landingPage being the application's entry point.
This document details how to start the script and troubleshoot it.

## How to start (local host only)
from the repo root:
```bash
cd ~/dial-forge/dial-forge-front-end/
python3 localHost/dial_forge_front_end_server.py
```

Then open http://localhost:8000 in a browser.

**Verify it is up:**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8000/landingPage.html
```

Expected output: `200`

### Stopping the server
Press:
```text
Ctrl + c
```
in the terminal running the server.

**Verify it is down:**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8000/landingPage.html
```

Expected output: `000`
