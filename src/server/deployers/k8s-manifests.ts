import * as k8s from "@kubernetes/client-node";
import {
  defaultImage,
  agentId,
  tryParseProjectId,
  buildOpenClawConfig,
  usesDefaultEnvSecretRef,
} from "./k8s-helpers.js";
import type { DeployConfig } from "./types.js";
import { shouldUseLitellmProxy, LITELLM_IMAGE, LITELLM_PORT } from "./litellm.js";
import { shouldUseOtel, OTEL_COLLECTOR_IMAGE, OTEL_GRPC_PORT, OTEL_HTTP_PORT, otelAgentEnv } from "./otel.js";
import type { TreeEntry } from "../state-tree.js";
import { loadAgentSourceBundle, mainWorkspaceShellCondition } from "./agent-source.js";

export function namespaceManifest(ns: string): k8s.V1Namespace {
  return {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name: ns, labels: { "app.kubernetes.io/managed-by": "openclaw-installer" } },
  };
}

export function pvcManifest(ns: string): k8s.V1PersistentVolumeClaim {
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name: "openclaw-home-pvc",
      namespace: ns,
      labels: { app: "openclaw" },
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      resources: { requests: { storage: "10Gi" } },
    },
  };
}

export function configMapManifest(ns: string, config: DeployConfig, gatewayToken: string): k8s.V1ConfigMap {
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: "openclaw-config",
      namespace: ns,
      labels: { app: "openclaw" },
    },
    data: {
      "openclaw.json": JSON.stringify(buildOpenClawConfig(config, gatewayToken)),
    },
  };
}

export function agentConfigMapManifest(ns: string, config: DeployConfig, workspaceFiles: Record<string, string>): k8s.V1ConfigMap {
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: "openclaw-agent",
      namespace: ns,
      labels: { app: "openclaw" },
    },
    data: workspaceFiles,
  };
}

export function fileTreeConfigMapManifest(ns: string, name: string, entries: TreeEntry[]): k8s.V1ConfigMap {
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name,
      namespace: ns,
      labels: { app: "openclaw" },
    },
    data: Object.fromEntries(entries.map((entry) => [entry.key, entry.content])),
  };
}

export function fileConfigMapManifest(ns: string, name: string, filename: string, content?: string): k8s.V1ConfigMap {
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name,
      namespace: ns,
      labels: { app: "openclaw" },
    },
    data: content !== undefined ? { [filename]: content } : {},
  };
}

export function gcpSaSecretManifest(ns: string, saJson: string): k8s.V1Secret {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: "gcp-sa",
      namespace: ns,
      labels: { app: "openclaw" },
    },
    stringData: { "sa.json": saJson },
  };
}

export function litellmConfigMapManifest(ns: string, configYaml: string): k8s.V1ConfigMap {
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: "litellm-config",
      namespace: ns,
      labels: { app: "openclaw" },
    },
    data: { "config.yaml": configYaml },
  };
}

export function otelConfigMapManifest(ns: string, configYaml: string): k8s.V1ConfigMap {
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: "otel-collector-config",
      namespace: ns,
      labels: { app: "openclaw" },
    },
    data: { "config.yaml": configYaml },
  };
}

export function secretManifest(ns: string, config: DeployConfig, gatewayToken: string, litellmMasterKey?: string): k8s.V1Secret {
  const data: Record<string, string> = {
    OPENCLAW_GATEWAY_TOKEN: gatewayToken,
  };
  if (config.anthropicApiKey && (!config.anthropicApiKeyRef || usesDefaultEnvSecretRef(config.anthropicApiKeyRef))) {
    data.ANTHROPIC_API_KEY = config.anthropicApiKey;
  }
  if (config.openaiApiKey && (!config.openaiApiKeyRef || usesDefaultEnvSecretRef(config.openaiApiKeyRef))) {
    data.OPENAI_API_KEY = config.openaiApiKey;
  }
  if (config.modelEndpoint) data.MODEL_ENDPOINT = config.modelEndpoint;
  // Custom endpoints (e.g. Ollama) may not require an API key, but the gateway
  // endpoint provider still expects one to be set. Use a dummy value when the
  // user hasn't provided a key.
  data.MODEL_ENDPOINT_API_KEY = config.modelEndpointApiKey || "not-required";
  if (config.telegramBotToken && (!config.telegramBotTokenRef || usesDefaultEnvSecretRef(config.telegramBotTokenRef))) {
    data.TELEGRAM_BOT_TOKEN = config.telegramBotToken;
  }

  // Resolve project ID from config or from the SA JSON
  const projectId = config.googleCloudProject
    || (config.gcpServiceAccountJson ? tryParseProjectId(config.gcpServiceAccountJson) : "");
  if (projectId) data.GOOGLE_CLOUD_PROJECT = projectId;
  if (config.googleCloudLocation) data.GOOGLE_CLOUD_LOCATION = config.googleCloudLocation;
  if (litellmMasterKey) data.LITELLM_MASTER_KEY = litellmMasterKey;
  if (config.sandboxEnabled) {
    if (config.sandboxSshIdentity) data.SSH_IDENTITY = config.sandboxSshIdentity;
    if (config.sandboxSshCertificate) data.SSH_CERTIFICATE = config.sandboxSshCertificate;
    if (config.sandboxSshKnownHosts) data.SSH_KNOWN_HOSTS = config.sandboxSshKnownHosts;
  }

  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: "openclaw-secrets",
      namespace: ns,
      labels: { app: "openclaw" },
    },
    stringData: data,
  };
}

export function serviceManifest(ns: string, config: DeployConfig): k8s.V1Service {
  const withA2a = Boolean(config.withA2a);
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name: "openclaw",
      namespace: ns,
      labels: {
        app: "openclaw",
        ...(withA2a
          ? {
              "kagenti.io/type": "agent",
              "kagenti.io/protocol": "a2a",
              "app.kubernetes.io/name": "openclaw",
            }
          : {}),
      },
      annotations: {
        ...(withA2a ? { "kagenti.io/description": "OpenClaw AI Agent Gateway" } : {}),
      },
    },
    spec: {
      type: "ClusterIP",
      selector: { app: "openclaw" },
      ports: [
        ...(withA2a
          ? [
              { name: "a2a", port: 8080, targetPort: "a2a" as unknown as k8s.IntOrString, protocol: "TCP" as const },
            ]
          : []),
        { name: "gateway", port: 18789, targetPort: 18789 as unknown as k8s.IntOrString, protocol: "TCP" },
        ...(withA2a
          ? [
              { name: "bridge", port: 18790, targetPort: 18790 as unknown as k8s.IntOrString, protocol: "TCP" as const },
            ]
          : []),
      ],
    },
  };
}

export function deploymentManifest(
  ns: string,
  config: DeployConfig,
  otelViaOperator = false,
  skillEntries: TreeEntry[] = [],
  agentTreeEntries: TreeEntry[] = [],
  cronJobsContent?: string,
): k8s.V1Deployment {
  const image = defaultImage(config);
  const id = agentId(config);

  const envVars: k8s.V1EnvVar[] = [
    { name: "HOME", value: "/home/node" },
    { name: "NODE_ENV", value: "production" },
    { name: "OPENCLAW_CONFIG_DIR", value: "/home/node/.openclaw" },
    { name: "OPENCLAW_STATE_DIR", value: "/home/node/.openclaw" },
    {
      name: "OPENCLAW_GATEWAY_TOKEN",
      valueFrom: { secretKeyRef: { name: "openclaw-secrets", key: "OPENCLAW_GATEWAY_TOKEN" } },
    },
  ];

  const useProxy = shouldUseLitellmProxy(config);
  const useOtel = shouldUseOtel(config);
  const withA2a = Boolean(config.withA2a);
  // Direct sidecar only when OTEL is enabled and operator is NOT handling it
  const useOtelDirect = useOtel && !otelViaOperator;

  const optionalKeys = [
    // Gateway always gets provider API keys so it can route to OpenAI/Anthropic
    // natively. LiteLLM only handles Vertex models.
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "MODEL_ENDPOINT",
    "MODEL_ENDPOINT_API_KEY",
    "TELEGRAM_BOT_TOKEN",
    // In proxy mode LiteLLM gets project/location from its config.yaml;
    // the gateway doesn't need them.
    ...(!useProxy ? ["GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"] : []),
    "SSH_IDENTITY",
    "SSH_CERTIFICATE",
    "SSH_KNOWN_HOSTS",
  ];
  for (const key of optionalKeys) {
    envVars.push({
      name: key,
      valueFrom: { secretKeyRef: { name: "openclaw-secrets", key, optional: true } },
    });
  }

  // OTEL collector env vars (tell the agent where to send traces)
  if (useOtel) {
    for (const [key, val] of Object.entries(otelAgentEnv())) {
      envVars.push({ name: key, value: val });
    }
  }

  if (config.vertexEnabled && useProxy) {
    // LiteLLM proxy mode: provider config in openclaw.json points to the sidecar,
    // just need the API key for authentication
    envVars.push({
      name: "LITELLM_API_KEY",
      valueFrom: { secretKeyRef: { name: "openclaw-secrets", key: "LITELLM_MASTER_KEY", optional: true } },
    });
  } else if (config.vertexEnabled) {
    // Direct Vertex mode (legacy): gateway gets GCP creds directly
    envVars.push({ name: "VERTEX_ENABLED", value: "true" });
    envVars.push({ name: "VERTEX_PROVIDER", value: config.vertexProvider || "anthropic" });
    if (config.gcpServiceAccountJson) {
      envVars.push({ name: "GOOGLE_APPLICATION_CREDENTIALS", value: "/home/node/gcp/sa.json" });
    }
  }

  const agentFiles = ["AGENTS.md", "agent.json", "SOUL.md", "IDENTITY.md", "TOOLS.md", "USER.md", "HEARTBEAT.md", "MEMORY.md"];
  const copyLines = agentFiles
    .map((f) => `  cp /agents/${f} /home/node/.openclaw/workspace-${id}/${f} 2>/dev/null || true`)
    .join("\n");

  // Fix for #62: use bundle-aware routing so persona-named workspaces map to the main agent
  const mainWorkspaceDest = `/home/node/.openclaw/workspace-${id}`;
  const workspaceRouting = mainWorkspaceShellCondition(mainWorkspaceDest, loadAgentSourceBundle(config));

  const initScript = `
cp /config/openclaw.json /home/node/.openclaw/openclaw.json
chmod 644 /home/node/.openclaw/openclaw.json
mkdir -p /home/node/.openclaw/workspace
mkdir -p /home/node/.openclaw/skills
mkdir -p /home/node/.openclaw/cron
mkdir -p /home/node/.openclaw/workspace-${id}
${copyLines}
find -L /agents-tree -mindepth 1 -type d -name 'workspace-*' -exec sh -c 'base="$(basename "$1")"; ${workspaceRouting}; mkdir -p "$dest"; cp -r "$1"/* "$dest"/ 2>/dev/null || true' _ {} \\;
cp -r /skills-src/. /home/node/.openclaw/skills/ 2>/dev/null || true
cp /cron-src/jobs.json /home/node/.openclaw/cron/jobs.json 2>/dev/null || true
# Copy default policies into workspace (user-editable copies)
if [ -d /policies ]; then
  for f in /policies/*; do
    fname=$(basename "$f")
    dest="/home/node/.openclaw/workspace-${id}/$fname"
    # Only copy if the file doesn't already exist (preserve user edits)
    [ ! -f "$dest" ] && cp "$f" "$dest" 2>/dev/null || true
  done
fi
chown -R 1000:1000 /home/node/.openclaw 2>/dev/null || true
echo "Config initialized"
`.trim();

  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: "openclaw",
      namespace: ns,
      labels: {
        app: "openclaw",
        "app.kubernetes.io/managed-by": "openclaw-installer",
        "openclaw.prefix": (config.prefix || "openclaw").toLowerCase(),
        "openclaw.agent": config.agentName.toLowerCase(),
        ...(withA2a
          ? {
              "kagenti.io/type": "agent",
              "kagenti.io/protocol": "a2a",
              "kagenti.io/framework": "OpenClaw",
              "app.kubernetes.io/name": "openclaw",
              "app.kubernetes.io/component": "agent",
            }
          : {}),
      },
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: "openclaw" } },
      strategy: { type: "Recreate" },
      template: {
        metadata: {
          labels: {
            app: "openclaw",
            ...(withA2a
              ? {
                  "kagenti.io/type": "agent",
                  "kagenti.io/protocol": "a2a",
                  "kagenti.io/inject": "enabled",
                }
              : {}),
          },
          annotations: {
            "openclaw.io/restart-at": new Date().toISOString(),
            // When OTel Operator is available, it injects the collector sidecar
            ...(otelViaOperator ? { "sidecar.opentelemetry.io/inject": "openclaw-sidecar" } : {}),
            ...(withA2a
              ? {
                  "kagenti.io/description": "OpenClaw AI Agent Gateway",
                  "kagenti.io/outbound-ports-exclude": "443,4317,4318,18789",
                  "kagenti.io/inbound-ports-exclude": "8080,8443,18789,18790",
                }
              : {}),
          },
        },
        spec: {
          ...(withA2a ? { serviceAccountName: "openclaw-oauth-proxy" } : {}),
          initContainers: [
            {
              name: "init-config",
              image: "registry.access.redhat.com/ubi9-minimal:latest",
              imagePullPolicy: "IfNotPresent",
              command: ["sh", "-c", initScript],
              resources: {
                requests: { memory: "64Mi", cpu: "50m" },
                limits: { memory: "128Mi", cpu: "200m" },
              },
              volumeMounts: [
                { name: "openclaw-home", mountPath: "/home/node/.openclaw" },
                { name: "config-template", mountPath: "/config" },
                { name: "agent-config", mountPath: "/agents" },
                { name: "agent-tree-config", mountPath: "/agents-tree", readOnly: true },
                { name: "skills-config", mountPath: "/skills-src", readOnly: true },
                { name: "cron-config", mountPath: "/cron-src", readOnly: true },
                { name: "policies", mountPath: "/policies", readOnly: true },
              ],
            },
          ],
          containers: [
            {
              name: "gateway",
              image,
              imagePullPolicy: "Always",
              command: [
                "node", "dist/index.js", "gateway", "run",
                "--bind", "lan", "--port", "18789",
              ],
              ports: [
                { name: "gateway", containerPort: 18789, protocol: "TCP" },
                ...(withA2a ? [{ name: "bridge", containerPort: 18790, protocol: "TCP" as const }] : []),
              ],
              env: envVars,
              resources: {
                requests: { memory: "1Gi", cpu: "250m" },
                limits: { memory: "4Gi", cpu: "1000m" },
              },
              livenessProbe: {
                exec: {
                  command: [
                    "node", "-e",
                    "require('http').get('http://127.0.0.1:18789/',r=>process.exit(r.statusCode<400?0:1)).on('error',()=>process.exit(1))",
                  ],
                },
                initialDelaySeconds: 60,
                periodSeconds: 30,
                timeoutSeconds: 10,
                failureThreshold: 3,
              },
              readinessProbe: {
                exec: {
                  command: [
                    "node", "-e",
                    "require('http').get('http://127.0.0.1:18789/',r=>process.exit(r.statusCode<400?0:1)).on('error',()=>process.exit(1))",
                  ],
                },
                initialDelaySeconds: 30,
                periodSeconds: 10,
                timeoutSeconds: 5,
                failureThreshold: 2,
              },
              volumeMounts: [
                { name: "openclaw-home", mountPath: "/home/node/.openclaw" },
                { name: "tmp-volume", mountPath: "/tmp" },
                // Read-only policy files (SOUL.md, AGENTS.md) — tamper-proof baseline
                { name: "policies", mountPath: "/policies", readOnly: true },
                // Only mount GCP creds on gateway in direct (non-proxy) mode
                ...(!useProxy && config.gcpServiceAccountJson
                  ? [{ name: "gcp-sa", mountPath: "/home/node/gcp", readOnly: true }]
                  : []),
              ],
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ["ALL"] },
              },
            },
            // LiteLLM proxy sidecar: routes all LLM requests for token tracking,
            // rate limiting, and content filtering. Exposes /metrics for Prometheus.
            ...(useProxy ? [{
              name: "litellm",
              image: config.litellmImage || LITELLM_IMAGE,
              args: ["--config", "/etc/litellm/config.yaml", "--port", String(LITELLM_PORT)],
              ports: [{ name: "litellm", containerPort: LITELLM_PORT, protocol: "TCP" as const }],
              env: [
                // Pass provider API keys so LiteLLM can authenticate with upstream APIs
                { name: "ANTHROPIC_API_KEY", valueFrom: { secretKeyRef: { name: "openclaw-secrets", key: "ANTHROPIC_API_KEY", optional: true } } },
                { name: "OPENAI_API_KEY", valueFrom: { secretKeyRef: { name: "openclaw-secrets", key: "OPENAI_API_KEY", optional: true } } },
                ...(config.gcpServiceAccountJson
                  ? [{ name: "GOOGLE_APPLICATION_CREDENTIALS", value: "/home/node/gcp/sa.json" }]
                  : []),
              ],
              volumeMounts: [
                { name: "litellm-config", mountPath: "/etc/litellm", readOnly: true },
                { name: "litellm-tmp", mountPath: "/tmp" },
                ...(config.gcpServiceAccountJson
                  ? [{ name: "gcp-sa", mountPath: "/home/node/gcp", readOnly: true }]
                  : []),
              ],
              resources: {
                requests: { memory: "512Mi", cpu: "100m" },
                limits: { memory: "1Gi", cpu: "500m" },
              },
              readinessProbe: {
                httpGet: { path: "/health/readiness", port: LITELLM_PORT as unknown as k8s.IntOrString },
                initialDelaySeconds: 10,
                periodSeconds: 10,
                timeoutSeconds: 5,
              },
              securityContext: {
                allowPrivilegeEscalation: false,
                capabilities: { drop: ["ALL"] },
              },
            }] : []),
            // OTEL collector sidecar: receives OTLP traces and exports to configured backend
            ...(useOtelDirect ? [{
              name: "otel-collector",
              image: config.otelImage || OTEL_COLLECTOR_IMAGE,
              imagePullPolicy: "IfNotPresent" as const,
              args: ["--config", "/etc/otel/config.yaml"],
              ports: [
                { name: "otlp-grpc", containerPort: OTEL_GRPC_PORT, protocol: "TCP" as const },
                { name: "otlp-http", containerPort: OTEL_HTTP_PORT, protocol: "TCP" as const },
              ],
              volumeMounts: [
                { name: "otel-config", mountPath: "/etc/otel", readOnly: true },
              ],
              resources: {
                requests: { memory: "128Mi", cpu: "100m" },
                limits: { memory: "256Mi", cpu: "200m" },
              },
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ["ALL"] },
              },
            }] : []),
            ...(withA2a ? [{
              name: "agent-card",
              image: "registry.redhat.io/ubi9:latest",
              command: ["python3", "-u", "/scripts/a2a-bridge.py"],
              ports: [{ name: "a2a", containerPort: 8080, protocol: "TCP" as const }],
              env: [
                {
                  name: "GATEWAY_TOKEN",
                  valueFrom: { secretKeyRef: { name: "openclaw-secrets", key: "OPENCLAW_GATEWAY_TOKEN" } },
                },
                { name: "GATEWAY_URL", value: "http://localhost:18789" },
                { name: "AGENT_ID", value: "" },
              ],
              volumeMounts: [
                { name: "agent-card-data", mountPath: "/srv/.well-known", readOnly: true },
                { name: "a2a-bridge-script", mountPath: "/scripts", readOnly: true },
              ],
              resources: {
                requests: { memory: "32Mi", cpu: "10m" },
                limits: { memory: "64Mi", cpu: "50m" },
              },
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ["ALL"] },
              },
            }] : []),
          ],
          volumes: [
            { name: "openclaw-home", persistentVolumeClaim: { claimName: "openclaw-home-pvc" } },
            { name: "config-template", configMap: { name: "openclaw-config" } },
            { name: "agent-config", configMap: { name: "openclaw-agent" } },
            {
              name: "skills-config",
              configMap: {
                name: "openclaw-skills",
                ...(skillEntries.length > 0
                  ? { items: skillEntries.map((entry) => ({ key: entry.key, path: entry.path })) }
                  : {}),
              },
            },
            {
              name: "cron-config",
              configMap: {
                name: "openclaw-cron",
                ...(cronJobsContent !== undefined
                  ? { items: [{ key: "jobs.json", path: "jobs.json" }] }
                  : {}),
              },
            },
            {
              name: "agent-tree-config",
              configMap: {
                name: "openclaw-agent-tree",
                ...(agentTreeEntries.length > 0
                  ? { items: agentTreeEntries.map((entry) => ({ key: entry.key, path: entry.path })) }
                  : {}),
              },
            },
            { name: "tmp-volume", emptyDir: {} },
            {
              name: "policies",
              configMap: {
                name: "openclaw-policies",
                optional: true,
              },
            },
            ...(config.gcpServiceAccountJson
              ? [{ name: "gcp-sa", secret: { secretName: "gcp-sa" } }]
              : []),
            ...(useProxy
              ? [
                  { name: "litellm-config", configMap: { name: "litellm-config" } },
                  { name: "litellm-tmp", emptyDir: {} },
                ]
              : []),
            ...(useOtelDirect
              ? [{ name: "otel-config", configMap: { name: "otel-collector-config" } }]
              : []),
            ...(withA2a
              ? [
                  { name: "agent-card-data", configMap: { name: "openclaw-agent-card" } },
                  { name: "a2a-bridge-script", configMap: { name: "a2a-bridge" } },
                ]
              : []),
          ],
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Policy ConfigMap — cluster-wide SOUL.md and AGENTS.md defaults
// ---------------------------------------------------------------------------

/**
 * Create a ConfigMap containing the default policy files (SOUL.md, AGENTS.md)
 * for an agent namespace. These are mounted read-only into the gateway container
 * as the security policy baseline.
 */
export function policyConfigMapManifest(
  ns: string,
  policies: Record<string, string>,
): k8s.V1ConfigMap {
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: "openclaw-policies",
      namespace: ns,
      labels: { app: "openclaw", "app.kubernetes.io/managed-by": "openclaw-installer" },
    },
    data: policies,
  };
}

// ---------------------------------------------------------------------------
// NetworkPolicy — ingress isolation (only allow OpenShift router)
// ---------------------------------------------------------------------------

/**
 * Create a NetworkPolicy that denies all ingress except from the
 * OpenShift router (openshift-ingress namespace). This isolates
 * agent namespaces from each other — only the router can reach them.
 */
export function ingressNetworkPolicyManifest(ns: string): k8s.V1NetworkPolicy {
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: {
      name: "openclaw-ingress-isolation",
      namespace: ns,
      labels: { app: "openclaw", "app.kubernetes.io/managed-by": "openclaw-installer" },
    },
    spec: {
      podSelector: {},  // applies to all pods in namespace
      policyTypes: ["Ingress"],
      ingress: [
        {
          // Allow traffic from OpenShift router pods
          _from: [
            {
              namespaceSelector: {
                matchLabels: {
                  "network.openshift.io/policy-group": "ingress",
                },
              },
            },
          ],
        },
        {
          // Allow pod-to-pod within the same namespace (oauth-proxy -> gateway)
          _from: [
            {
              podSelector: {},
            },
          ],
        },
        {
          // Allow traffic from OpenShift host-network namespace
          // (API server return traffic, OAuth server, node components)
          _from: [
            {
              namespaceSelector: {
                matchLabels: {
                  "kubernetes.io/metadata.name": "openshift-host-network",
                },
              },
            },
          ],
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// ResourceQuota — per-namespace CPU/memory budget
// ---------------------------------------------------------------------------

/**
 * Create a ResourceQuota for the agent namespace.
 * Defaults: 4 CPU, 6Gi memory (configurable via DeployConfig).
 * The defaults account for the gateway container (1 CPU, 4Gi) plus
 * sidecar containers (oauth-proxy, litellm, otel).
 */
export function resourceQuotaManifest(
  ns: string,
  cpuLimit: string = "4",
  memoryLimit: string = "6Gi",
): k8s.V1ResourceQuota {
  return {
    apiVersion: "v1",
    kind: "ResourceQuota",
    metadata: {
      name: "openclaw-quota",
      namespace: ns,
      labels: { app: "openclaw", "app.kubernetes.io/managed-by": "openclaw-installer" },
    },
    spec: {
      hard: {
        "limits.cpu": cpuLimit,
        "limits.memory": memoryLimit,
        "requests.cpu": cpuLimit,
        "requests.memory": memoryLimit,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// LimitRange — default container resource limits
// ---------------------------------------------------------------------------

/**
 * Create a LimitRange so pods without explicit resource requests/limits
 * get sensible defaults and don't bypass the ResourceQuota.
 */
export function limitRangeManifest(ns: string): k8s.V1LimitRange {
  return {
    apiVersion: "v1",
    kind: "LimitRange",
    metadata: {
      name: "openclaw-limits",
      namespace: ns,
      labels: { app: "openclaw", "app.kubernetes.io/managed-by": "openclaw-installer" },
    },
    spec: {
      limits: [
        {
          type: "Container",
          _default: {
            cpu: "500m",
            memory: "512Mi",
          },
          defaultRequest: {
            cpu: "100m",
            memory: "128Mi",
          },
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// PodMonitor — Prometheus scraping for agent pods
// ---------------------------------------------------------------------------

/**
 * Create a PodMonitor that tells Prometheus to scrape the OpenClaw gateway
 * pod's health endpoint for up/down tracking.
 */
export function podMonitorManifest(ns: string): Record<string, unknown> {
  return {
    apiVersion: "monitoring.coreos.com/v1",
    kind: "PodMonitor",
    metadata: {
      name: "openclaw-agent",
      namespace: ns,
      labels: { app: "openclaw", "app.kubernetes.io/managed-by": "openclaw-installer" },
    },
    spec: {
      selector: {
        matchLabels: { app: "openclaw" },
      },
      podMetricsEndpoints: [
        {
          port: "gateway",
          path: "/",
          interval: "30s",
          scrapeTimeout: "10s",
        },
        {
          port: "litellm",
          path: "/metrics",
          interval: "30s",
          scrapeTimeout: "10s",
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// PrometheusRule — alert rules for agent health
// ---------------------------------------------------------------------------

/**
 * Create PrometheusRule with alerts for agent pod health.
 * Uses kube-state-metrics and cAdvisor metrics already collected by OpenShift.
 */
export function prometheusRuleManifest(ns: string): Record<string, unknown> {
  return {
    apiVersion: "monitoring.coreos.com/v1",
    kind: "PrometheusRule",
    metadata: {
      name: "openclaw-agent-alerts",
      namespace: ns,
      labels: { app: "openclaw", "app.kubernetes.io/managed-by": "openclaw-installer" },
    },
    spec: {
      groups: [
        {
          name: "openclaw-agent.rules",
          rules: [
            {
              alert: "OpenClawPodCrashLooping",
              expr: `rate(kube_pod_container_status_restarts_total{namespace="${ns}", container="gateway"}[15m]) * 60 * 15 > 3`,
              "for": "5m",
              labels: { severity: "critical", namespace: ns },
              annotations: {
                summary: `OpenClaw agent pod in ${ns} is crash looping`,
                description: "The gateway container has restarted more than 3 times in the last 15 minutes.",
              },
            },
            {
              alert: "OpenClawPodNotReady",
              expr: `kube_pod_status_ready{namespace="${ns}", condition="true"} == 0`,
              "for": "5m",
              labels: { severity: "warning", namespace: ns },
              annotations: {
                summary: `OpenClaw agent pod in ${ns} is not ready`,
                description: "The agent pod has been in a non-ready state for more than 5 minutes.",
              },
            },
            {
              alert: "OpenClawHighMemoryUsage",
              expr: `sum(container_memory_working_set_bytes{namespace="${ns}", container!=""}) / sum(kube_resourcequota{namespace="${ns}", resource="limits.memory", type="hard"}) > 0.8`,
              "for": "10m",
              labels: { severity: "warning", namespace: ns },
              annotations: {
                summary: `OpenClaw agent in ${ns} using >80% of memory quota`,
                description: "The agent namespace is consuming more than 80% of its memory quota.",
              },
            },
            {
              alert: "OpenClawHighCPUUsage",
              expr: `sum(rate(container_cpu_usage_seconds_total{namespace="${ns}", container!=""}[5m])) / sum(kube_resourcequota{namespace="${ns}", resource="limits.cpu", type="hard"}) > 0.8`,
              "for": "10m",
              labels: { severity: "warning", namespace: ns },
              annotations: {
                summary: `OpenClaw agent in ${ns} using >80% of CPU quota`,
                description: "The agent namespace is consuming more than 80% of its CPU quota.",
              },
            },
          ],
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// SCC RoleBinding — bind agent ServiceAccounts to openclaw-agent-scc
// ---------------------------------------------------------------------------

/**
 * Create a RoleBinding that grants the default and openclaw-oauth-proxy
 * ServiceAccounts in the agent namespace permission to use the
 * openclaw-agent-scc SecurityContextConstraints.
 */
export function sccRoleBindingManifest(ns: string): object {
  return {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "RoleBinding",
    metadata: {
      name: "openclaw-agent-scc",
      namespace: ns,
      labels: { app: "openclaw", "app.kubernetes.io/managed-by": "openclaw-installer" },
    },
    roleRef: {
      apiGroup: "rbac.authorization.k8s.io",
      kind: "ClusterRole",
      name: "openclaw-agent-scc-use",
    },
    subjects: [
      {
        kind: "ServiceAccount",
        name: "default",
        namespace: ns,
      },
      {
        kind: "ServiceAccount",
        name: "openclaw-oauth-proxy",
        namespace: ns,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// EgressFirewall (OVN-Kubernetes, k8s.ovn.org/v1)
// ---------------------------------------------------------------------------

/**
 * Parse a URL and extract the hostname (or IP) and port.
 * Returns undefined if the URL cannot be parsed.
 */
function parseEndpointHostPort(endpoint: string): { host: string; port: number } | undefined {
  try {
    const url = new URL(endpoint);
    const host = url.hostname;
    const port = url.port
      ? Number(url.port)
      : url.protocol === "https:" ? 443 : url.protocol === "http:" ? 80 : undefined;
    if (!host || !port) return undefined;
    return { host, port };
  } catch {
    return undefined;
  }
}

/**
 * Returns true if the string looks like an IPv4 address.
 */
function isIPv4(s: string): boolean {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(s);
}

/**
 * Returns true if the string looks like a CIDR notation (IP/prefix).
 */
function isCIDR(s: string): boolean {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/.test(s);
}

interface EgressRule {
  type: "Allow" | "Deny";
  to: { cidrSelector?: string; dnsName?: string };
  ports?: Array<{ protocol: string; port: number }>;
}

/**
 * Build an OVN EgressFirewall manifest scoped to one agent namespace.
 *
 * Rules are derived dynamically from the DeployConfig:
 *  - Cluster DNS and Kubernetes API are always allowed
 *  - Model endpoint (Ollama, etc.) is allowed if configured
 *  - Anthropic, OpenAI, Vertex, and Telegram APIs are allowed only when
 *    the corresponding credentials / flags are present in the config
 *  - Everything else is denied
 *
 * OVN requires exactly one EgressFirewall per namespace, named "default".
 */
export function egressFirewallManifest(
  ns: string,
  config: DeployConfig,
): Record<string, unknown> {
  const rules: EgressRule[] = [];

  // ── Always-allowed: cluster-internal traffic ──

  // Cluster pod network (DNS, inter-pod communication)
  rules.push({
    type: "Allow",
    to: { cidrSelector: "10.128.0.0/14" },
  });

  // Kubernetes / OpenShift service network (API server, OAuth, internal services)
  rules.push({
    type: "Allow",
    to: { cidrSelector: "172.30.0.0/16" },
  });

  // OpenShift node network — required for OAuth proxy to reach the OAuth server
  // route and for API server access via node IPs.
  // Configurable via OPENCLAW_NODE_NETWORK env var (default: 10.0.0.0/8 covers
  // most private networks; set to your cluster's node CIDR for tighter control).
  const nodeNetwork = process.env.OPENCLAW_NODE_NETWORK || "10.0.0.0/8";
  rules.push({
    type: "Allow",
    to: { cidrSelector: nodeNetwork },
    ports: [
      { protocol: "TCP", port: 443 },
      { protocol: "TCP", port: 6443 },
    ],
  });

  // ── Conditionally-allowed: external services based on config ──

  // Custom model endpoint (e.g. Ollama)
  if (config.modelEndpoint) {
    const ep = parseEndpointHostPort(config.modelEndpoint);
    if (ep) {
      const to = isIPv4(ep.host)
        ? { cidrSelector: `${ep.host}/32` }
        : { dnsName: ep.host };
      rules.push({
        type: "Allow",
        to,
        ports: [{ protocol: "TCP", port: ep.port }],
      });
    }
  }

  // Anthropic API
  if (config.anthropicApiKey || config.anthropicApiKeyRef) {
    rules.push({
      type: "Allow",
      to: { dnsName: "api.anthropic.com" },
      ports: [{ protocol: "TCP", port: 443 }],
    });
  }

  // OpenAI API
  if (config.openaiApiKey || config.openaiApiKeyRef) {
    rules.push({
      type: "Allow",
      to: { dnsName: "api.openai.com" },
      ports: [{ protocol: "TCP", port: 443 }],
    });
  }

  // Google Cloud / Vertex AI
  if (config.vertexEnabled) {
    for (const dns of [
      "oauth2.googleapis.com",
      "aiplatform.googleapis.com",
      "us-central1-aiplatform.googleapis.com",
    ]) {
      rules.push({
        type: "Allow",
        to: { dnsName: dns },
        ports: [{ protocol: "TCP", port: 443 }],
      });
    }
  }

  // Telegram API
  if (config.telegramEnabled || config.telegramBotToken || config.telegramBotTokenRef) {
    rules.push({
      type: "Allow",
      to: { dnsName: "api.telegram.org" },
      ports: [{ protocol: "TCP", port: 443 }],
    });
  }

  // ── Custom egress rules (user-specified additional endpoints) ──
  if (config.customEgressRules && config.customEgressRules.length > 0) {
    for (const rule of config.customEgressRules) {
      const dest = rule.destination?.trim();
      if (!dest) continue;
      const protocol = rule.protocol || "TCP";
      const port = rule.port || 443;
      const to = (isIPv4(dest) || isCIDR(dest))
        ? { cidrSelector: isCIDR(dest) ? dest : `${dest}/32` }
        : { dnsName: dest };
      rules.push({
        type: "Allow",
        to,
        ports: [{ protocol, port }],
      });
    }
  }

  // ── Default deny everything else ──
  rules.push({
    type: "Deny",
    to: { cidrSelector: "0.0.0.0/0" },
  });

  return {
    apiVersion: "k8s.ovn.org/v1",
    kind: "EgressFirewall",
    metadata: {
      name: "default",
      namespace: ns,
      labels: { app: "openclaw", "app.kubernetes.io/managed-by": "openclaw-installer" },
    },
    spec: {
      egress: rules,
    },
  };
}
