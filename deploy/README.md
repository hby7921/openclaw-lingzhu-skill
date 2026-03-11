# Cloud Deployment

This folder contains server-side deployment assets for `openclaw-lingzhu`.

## Files

- `ubuntu-quick-install.sh`
  - Clones or updates the repository
  - Runs `npm install`
  - Links the plugin with `openclaw plugins install --link`
- `openclaw.lingzhu.config.json5`
  - Merge this into your existing `openclaw.json` or `moltbot.json`
- `openclaw-gateway.service.example`
  - Example `systemd` service unit for a long-running gateway

## Ubuntu quick start

```bash
sudo apt-get update
sudo apt-get install -y git npm
git clone https://github.com/hby7921/openclaw-lingzhu.git /opt/openclaw-lingzhu
cd /opt/openclaw-lingzhu
bash deploy/ubuntu-quick-install.sh
```

## Verify

```bash
openclaw lingzhu info
openclaw lingzhu status
openclaw lingzhu capabilities
openclaw lingzhu logpath
curl http://127.0.0.1:18789/metis/agent/api/health
```

## Lingzhu platform values

- SSE URL: `http://<public-ip>:18789/metis/agent/api/sse`
- AK: run `openclaw lingzhu curl` and copy the Bearer token from the output
