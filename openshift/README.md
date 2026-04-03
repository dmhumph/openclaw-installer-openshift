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

After deploying an agent through the installer, the agent gets its own Route with an OAuth proxy for authentication. The connection flow is:

### 1. Open the agent route

Find your agent's route URL in the installer's **Instances** tab, or run:

```bash
oc get route openclaw -n <agent-namespace> -o jsonpath='{.spec.host}'
```

### 2. Log in with OpenShift

Click "Log in with OpenShift" and authenticate with your cluster credentials.

### 3. Enter the gateway token

The gateway token is available from the installer's **Instances** tab (click the instance to see connection details). You can also retrieve it via CLI:

```bash
oc get secret openclaw-secrets -n <agent-namespace> -o jsonpath='{.data.OPENCLAW_GATEWAY_TOKEN}' | base64 -d
```

### 4. Approve device pairing

After entering the token, you'll see "pairing required." Approve it from the installer's **Instances** tab using the **Approve Pairing** button.

Alternatively, approve via CLI:

```bash
oc exec $(oc get pods -n <agent-namespace> -l app=openclaw -o jsonpath='{.items[0].metadata.name}') \
  -n <agent-namespace> -c gateway -- openclaw devices approve --latest
```

### Security: EgressFirewall

Each agent namespace automatically gets an OVN EgressFirewall that restricts outbound traffic to only the endpoints configured at deploy time:

- Cluster-internal traffic (pod network, service network, DNS)
- Node network on ports 443/6443 (for OAuth and API server)
- Model endpoint (e.g., Ollama IP and port)
- LLM provider APIs (Anthropic, OpenAI) if API keys are configured
- Telegram API if Telegram is enabled
- **All other egress is denied**

To inspect the rules:

```bash
oc get egressfirewall default -n <agent-namespace> -o yaml
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
| Agent can't reach model endpoint | EgressFirewall blocking traffic | Check `oc get egressfirewall -n <ns> -o yaml` and verify the endpoint IP/port is listed |
| `oc login` fails with "no route to host" from iTerm2 | macOS Local Network permission not granted to iTerm2 | System Settings > Privacy & Security > Local Network > enable iTerm2 |

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
