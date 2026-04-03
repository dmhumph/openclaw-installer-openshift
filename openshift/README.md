# OpenClaw Installer on OpenShift

Deploy the [OpenClaw Installer](https://github.com/sallyom/openclaw-installer) as a containerized application on an OpenShift cluster. The installer provides a web UI for deploying and managing OpenClaw AI agents.

## Prerequisites

- An OpenShift cluster (tested on OpenShift 4.x with OKD/OCP)
- `oc` CLI installed (`brew install openshift-cli` on macOS)
- Cluster-admin access (or equivalent RBAC to create namespaces, clusterroles, builds, etc.)

## Quick Start

### 1. Clone this repo

```bash
git clone http://192.168.0.110:3000/openclaw/openclaw-installer-openshift.git
cd openclaw-installer-openshift
```

### 2. Add required container registries to the cluster allowlist

The build uses base images from registries that may not be in your cluster's `allowedRegistries` policy. Check your current policy:

```bash
oc get image.config.openshift.io/cluster -o jsonpath='{.spec.registrySources.allowedRegistries}'
```

Add any missing registries. The build requires:

- `registry.access.redhat.com` (UBI Node.js build stage)
- `registry.fedoraproject.org` (Fedora minimal runtime stage)

The deployed agents additionally require:

- `ghcr.io` (OpenClaw container images)

To add them:

```bash
oc patch image.config.openshift.io/cluster --type='json' -p='[
  {"op":"add","path":"/spec/registrySources/allowedRegistries/-","value":"registry.access.redhat.com"},
  {"op":"add","path":"/spec/registrySources/allowedRegistries/-","value":"registry.fedoraproject.org"},
  {"op":"add","path":"/spec/registrySources/allowedRegistries/-","value":"ghcr.io"}
]'
```

**Important:** After patching, wait for the Machine Config Operator to roll out the changes to all nodes. This involves node reboots and can take 5-10 minutes:

```bash
# Watch the rollout progress
oc get machineconfigpool -w
```

Wait until the master (and worker, if separate) pools show `UPDATED=True` and `UPDATING=False` before proceeding.

### 3. Configure your secrets

Edit `secret.yaml` and fill in the credentials for the providers you plan to use:

```yaml
stringData:
  # Anthropic API key OR OAuth token (the SDK accepts both)
  ANTHROPIC_API_KEY: "your-key-or-oauth-token-here"

  # OpenAI API key (optional)
  OPENAI_API_KEY: ""

  # Custom model endpoint URL (e.g., Ollama: http://your-ollama-host:11434/v1)
  MODEL_ENDPOINT: "http://192.168.0.93:11434/v1"

  # API key for the custom endpoint (not needed for Ollama - leave blank)
  MODEL_ENDPOINT_API_KEY: ""

  # Telegram bot integration (optional)
  TELEGRAM_BOT_TOKEN: ""
  TELEGRAM_ALLOW_FROM: ""
```

**Notes:**

- **Anthropic OAuth tokens** go in `ANTHROPIC_API_KEY` -- the Anthropic SDK treats API keys and OAuth tokens the same way through this env var.
- **Ollama endpoints** do not require an API key. Just set `MODEL_ENDPOINT` to your Ollama URL and leave `MODEL_ENDPOINT_API_KEY` empty.
- **Telegram Bot Token**: Message `@BotFather` on Telegram, send `/newbot`, and follow the prompts. The token looks like `7123456789:AAH...`
- **Telegram Allow From**: A comma-separated list of numeric Telegram user IDs. Message `@userinfobot` on Telegram to find your user ID.

### 4. Deploy everything

```bash
oc apply -k .
```

This creates:
- `openclaw-installer` namespace
- ServiceAccount with ClusterRole/ClusterRoleBinding for managing agent namespaces
- Secret with your provider credentials
- PersistentVolumeClaim for installer state
- BuildConfig + ImageStream (builds the installer image from source)
- Deployment, Service, and Route

### 5. Trigger and watch the build

The BuildConfig has a `ConfigChange` trigger, so the first build should start automatically. If it doesn't:

```bash
oc start-build openclaw-installer -n openclaw-installer --follow
```

The build clones the upstream repo and builds the container image using the Dockerfile. This takes a few minutes.

### 6. Verify the deployment

```bash
# Check the pod is running
oc get pods -n openclaw-installer -l app.kubernetes.io/name=openclaw-installer

# If the pod is in ImagePullBackOff (because it was created before the build finished),
# delete it and let the ReplicaSet create a new one:
oc delete pod -n openclaw-installer -l app.kubernetes.io/name=openclaw-installer

# Get the installer URL
oc get route openclaw-installer -n openclaw-installer -o jsonpath='{.spec.host}'
```

### 7. Deploy an agent via the web UI

Open `https://<route-host>` in your browser. The installer will detect OpenShift and offer it as a deployment target. Fill in the deployment form (model provider, agent name, etc.) and click Deploy.

## Post-Deployment: Connecting to the Agent Web UI

After deploying an agent through the installer, the agent gets its own Route with an OAuth proxy for authentication. There are a few things to be aware of:

### OAuth Proxy Configuration

The installer deploys agents with an OpenShift OAuth proxy sidecar. The proxy must use ServiceAccount-based authentication (not an explicit client secret). If you see a **500 Internal Error** after logging in, check the oauth-proxy container logs:

```bash
oc logs <agent-pod> -n <agent-namespace> -c oauth-proxy --tail=20
```

If you see `"unauthorized_client"`, the proxy args need to use `--openshift-service-account=<sa-name>` instead of `--client-secret-file`. Patch the deployment:

```bash
oc patch deployment <name> -n <namespace> --type='json' -p='[
  {"op":"replace","path":"/spec/template/spec/containers/0/args","value":[
    "--http-address=:8443",
    "--https-address=",
    "--provider=openshift",
    "--upstream=http://localhost:18789",
    "--openshift-service-account=openclaw-oauth-proxy",
    "--cookie-secret-file=/etc/oauth/config/cookie_secret",
    "--cookie-expire=23h0m0s",
    "--pass-access-token",
    "--scope=user:info",
    "--skip-auth-regex=^/(metrics|api)"
  ]}
]'
```

### Gateway Token

To connect to the agent's Control UI, you need the gateway token. Extract it from the running pod:

```bash
oc exec <agent-pod> -n <agent-namespace> -c gateway -- \
  python3 -c "import json; d=json.load(open('/home/node/.openclaw/openclaw.json')); print(d['gateway']['auth']['token'])"
```

Paste this token into the Control UI settings when prompted.

### Trusted Proxies and Device Pairing

The gateway requires device pairing for web UI connections. When running behind the OAuth proxy in OpenShift, you need to configure trusted proxies so the gateway recognizes connections as local. If you see "pairing required" errors:

1. **Add trusted proxies** to the gateway config:

```bash
oc exec <agent-pod> -n <agent-namespace> -c gateway -- python3 -c "
import json
with open('/home/node/.openclaw/openclaw.json') as f:
    d = json.load(f)
d['gateway']['trustedProxies'] = ['127.0.0.1', '::1', '10.0.0.0/8']
with open('/home/node/.openclaw/openclaw.json', 'w') as f:
    json.dump(d, f, indent=2)
print('Done')
"
```

2. **Approve pending device pairing** after connecting from the web UI:

```bash
oc exec <agent-pod> -n <agent-namespace> -c gateway -- python3 -c "
import json, time
with open('/home/node/.openclaw/devices/pending.json') as f:
    pending = json.load(f)
with open('/home/node/.openclaw/devices/paired.json') as f:
    paired = json.load(f)
for req_id, req in pending.items():
    device_id = req['deviceId']
    now_ms = int(time.time() * 1000)
    paired[device_id] = {
        'deviceId': device_id,
        'publicKey': req['publicKey'],
        'displayName': f'Web UI ({req[\"platform\"]})',
        'platform': req['platform'],
        'clientId': req['clientId'],
        'clientMode': req['clientMode'],
        'role': req['role'],
        'roles': req['roles'],
        'scopes': req['scopes'],
        'approvedScopes': req['scopes'],
        'tokens': {},
        'createdAtMs': now_ms,
        'approvedAtMs': now_ms
    }
with open('/home/node/.openclaw/devices/paired.json', 'w') as f:
    json.dump(paired, f, indent=2)
with open('/home/node/.openclaw/devices/pending.json', 'w') as f:
    json.dump({}, f)
print('Approved', len(pending), 'device(s)')
"
```

## Ongoing Management

```bash
# View installer logs
oc logs deployment/openclaw-installer -n openclaw-installer

# Rebuild after upstream code changes
oc start-build openclaw-installer -n openclaw-installer --follow

# List deployed agent pods across all namespaces
oc get pods --all-namespaces -l app=openclaw

# View agent gateway logs
oc logs <agent-pod> -n <agent-namespace> -c gateway --tail=50
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Build fails with `Source image rejected by policy` | Container registry not in `allowedRegistries` | Add the registry via `oc patch image.config.openshift.io/cluster` and wait for MCP rollout |
| Pod stuck in `ImagePullBackOff` | Image not yet built, or registry policy not yet propagated | Wait for build to complete and MCP rollout, then delete the stuck pod |
| 500 Internal Error after OAuth login | OAuth proxy using `--client-secret-file` instead of SA token | Patch deployment to use `--openshift-service-account=<sa>` (see above) |
| "pairing required" in Control UI | Gateway doesn't recognize proxy as trusted | Add `trustedProxies` to gateway config, then approve pending device |
| `oc login` fails with "no route to host" from iTerm2 | macOS Local Network permission not granted to iTerm2 | System Settings > Privacy & Security > Local Network > enable iTerm2 |
| `oc login` works in Terminal but not iTerm2 | Same as above | Same fix -- toggle Local Network permission for iTerm2, restart iTerm2 |

## Architecture

```
                                   OpenShift Cluster
                          +-------------------------------+
                          |   openclaw-installer namespace |
  User Browser ----HTTPS--+-> Route -> Service -> Pod     |
                          |           (installer web UI)   |
                          |                                |
                          |   user-<name> namespace(s)     |
                          |   +-------------------------+  |
                          |   | OAuth Proxy (sidecar)   |  |
                          |   | OpenClaw Gateway        |  |
                          |   | (agent + web chat)      |  |
                          |   +-------------------------+  |
                          +-------------------------------+
                                        |
                                        v
                              Ollama / Anthropic API
                              (model inference)
```
