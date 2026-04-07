import { randomBytes } from "node:crypto";
import type { DeployConfig } from "./types.js";

export const LITELLM_IMAGE = "ghcr.io/berriai/litellm:v1.82.3-stable.patch.2";
export const LITELLM_PORT = 4000;

export function generateLitellmMasterKey(): string {
  return `sk-litellm-${randomBytes(24).toString("hex")}`;
}

/**
 * Returns true when the LiteLLM proxy should be used for this config.
 * On by default for Kubernetes/OpenShift deployments (routes all providers
 * through the proxy for token tracking, rate limiting, and content filtering).
 * For local deployments, only enabled when Vertex + SA JSON credentials present.
 */
export function shouldUseLitellmProxy(config: DeployConfig): boolean {
  if (config.litellmProxy === false) return false;
  if (config.litellmProxy === true) return true;
  // Default: on for cluster deployments (openshift/kubernetes mode)
  if (config.mode === "openshift" || config.mode === "kubernetes") return true;
  // Legacy: on when Vertex + SA JSON credentials are present
  return !!(config.vertexEnabled && config.gcpServiceAccountJson);
}

/**
 * Model name as registered in LiteLLM (no provider prefix).
 */
export function litellmModelName(config: DeployConfig): string {
  if (config.agentModel) return config.agentModel;
  return config.vertexProvider === "google"
    ? "gemini-2.5-pro"
    : "claude-sonnet-4-6";
}

/**
 * Full model string for OpenClaw config when using LiteLLM proxy.
 * Uses openai/ prefix so OpenClaw routes through the OpenAI-compatible client,
 * combined with MODEL_ENDPOINT pointing to LiteLLM.
 */
export function litellmModelString(config: DeployConfig): string {
  return `openai/${litellmModelName(config)}`;
}

/**
 * Build model entries for the LiteLLM config based on ALL configured providers.
 * Routes Anthropic, OpenAI, Vertex, and custom endpoint models through the proxy
 * for centralized token tracking, rate limiting, and content filtering.
 */
function buildModelList(config: DeployConfig): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const models: Array<Record<string, unknown>> = [];

  function addModel(name: string, params: Record<string, unknown>) {
    if (seen.has(name)) return;
    seen.add(name);
    models.push({ model_name: name, litellm_params: params });
  }

  // ── Vertex AI models ──
  if (config.vertexEnabled) {
    const project = config.googleCloudProject || "";
    const location = config.googleCloudLocation || "";
    if (config.vertexProvider === "google") {
      const primary = config.vertexGoogleModel?.trim() || config.agentModel?.trim() || "gemini-2.5-pro";
      addModel(primary, { model: `vertex_ai/${primary}`, vertex_project: project, vertex_location: location });
      addModel("gemini-2.5-pro", { model: "vertex_ai/gemini-2.5-pro", vertex_project: project, vertex_location: location });
      addModel("gemini-2.5-flash", { model: "vertex_ai/gemini-2.5-flash", vertex_project: project, vertex_location: location });
      for (const m of config.vertexGoogleModels || []) {
        const t = m.trim();
        if (t) addModel(t, { model: `vertex_ai/${t}`, vertex_project: project, vertex_location: location });
      }
    } else {
      const primary = config.vertexAnthropicModel?.trim() || config.agentModel?.trim() || "claude-sonnet-4-6";
      addModel(primary, { model: `vertex_ai/${primary}`, vertex_project: project, vertex_location: location });
      addModel("claude-sonnet-4-6", { model: "vertex_ai/claude-sonnet-4-6", vertex_project: project, vertex_location: location });
      addModel("claude-haiku-4-5", { model: "vertex_ai/claude-haiku-4-5", vertex_project: project, vertex_location: location });
      for (const m of config.vertexAnthropicModels || []) {
        const t = m.trim();
        if (t) addModel(t, { model: `vertex_ai/${t}`, vertex_project: project, vertex_location: location });
      }
    }
  }

  // ── Anthropic models (direct API) ──
  if (config.anthropicApiKey || config.anthropicApiKeyRef) {
    const primary = config.anthropicModel?.trim() || "claude-sonnet-4-6";
    addModel(primary, { model: `anthropic/${primary}`, api_key: "os.environ/ANTHROPIC_API_KEY" });
    for (const m of config.anthropicModels || []) {
      const t = m.trim();
      if (t) addModel(t, { model: `anthropic/${t}`, api_key: "os.environ/ANTHROPIC_API_KEY" });
    }
  }

  // ── OpenAI models ──
  if (config.openaiApiKey || config.openaiApiKeyRef) {
    const primary = config.openaiModel?.trim() || "gpt-4o";
    addModel(primary, { model: `openai/${primary}`, api_key: "os.environ/OPENAI_API_KEY" });
    for (const m of config.openaiModels || []) {
      const t = m.trim();
      if (t) addModel(t, { model: `openai/${t}`, api_key: "os.environ/OPENAI_API_KEY" });
    }
  }

  // ── Custom endpoint models (Ollama, vLLM, etc.) ──
  if (config.modelEndpoint?.trim()) {
    const endpoint = config.modelEndpoint.trim();
    const apiKey = config.modelEndpointApiKey?.trim() || "not-required";
    if (config.modelEndpointModel?.trim()) {
      const name = config.modelEndpointModel.trim();
      addModel(name, { model: `openai/${name}`, api_base: endpoint, api_key: apiKey });
    }
    for (const m of config.modelEndpointModels || []) {
      const id = String(m.id || "").trim();
      if (id) addModel(id, { model: `openai/${id}`, api_base: endpoint, api_key: apiKey });
    }
  }

  return models;
}

/**
 * Generate litellm_config.yaml content as a YAML string.
 * We build it manually to avoid a js-yaml dependency.
 * Includes Prometheus metrics, rate limiting, and content filtering.
 */
export function generateLitellmConfig(config: DeployConfig, masterKey: string): string {
  const models = buildModelList(config);

  const lines: string[] = [
    "model_list:",
  ];

  for (const m of models) {
    const params = m.litellm_params as Record<string, string>;
    lines.push(`  - model_name: ${String(m.model_name)}`);
    lines.push("    litellm_params:");
    lines.push(`      model: ${params.model}`);
    if (params.vertex_project !== undefined) {
      lines.push(`      vertex_project: "${params.vertex_project}"`);
      lines.push(`      vertex_location: "${params.vertex_location}"`);
    }
    if (params.api_base !== undefined) {
      lines.push(`      api_base: "${params.api_base}"`);
    }
    if (params.api_key !== undefined) {
      lines.push(`      api_key: ${params.api_key}`);
    }
  }

  // Rate limit (RPM) — configurable per agent, default 60
  const rpm = config.rateLimitRpm ? parseInt(String(config.rateLimitRpm), 10) : 60;

  lines.push("");
  lines.push("litellm_settings:");
  lines.push("  callbacks:");
  lines.push("    - prometheus");
  lines.push(`  max_parallel_requests: ${Math.max(Math.floor(rpm / 6), 5)}`);
  lines.push("  drop_params: true");
  lines.push("  num_retries: 2");

  // ── Content filtering guardrail (built-in, no external services) ──
  const filterEnabled = config.contentFilterEnabled !== false;
  if (filterEnabled) {
    const blockPii = config.contentFilterBlockPii !== false;
    const maskEmail = config.contentFilterMaskEmail !== false;
    const maskPhone = config.contentFilterMaskPhone !== false;
    const blockCreds = config.contentFilterBlockCredentials !== false;
    const blockHarmful = config.contentFilterBlockHarmful !== false;
    const customWords = (config.contentFilterCustomWords || "")
      .split(",").map((w) => w.trim()).filter((w) => w.length > 0);

    lines.push("");
    lines.push("guardrails:");
    lines.push("  - guardrail_name: openclaw-content-filter");
    lines.push("    litellm_params:");
    lines.push("      guardrail: litellm_content_filter");
    lines.push("      mode: pre_call");
    lines.push("      default_on: true");

    const patterns: Array<{ type: string; name: string; action: string }> = [];
    if (blockPii) {
      patterns.push({ type: "prebuilt", name: "us_ssn", action: "BLOCK" });
      patterns.push({ type: "prebuilt", name: "credit_card", action: "BLOCK" });
    }
    if (maskEmail) patterns.push({ type: "prebuilt", name: "email", action: "MASK" });
    if (maskPhone) patterns.push({ type: "prebuilt", name: "us_phone", action: "MASK" });
    if (blockCreds) {
      patterns.push({ type: "prebuilt", name: "aws_access_key", action: "BLOCK" });
      patterns.push({ type: "prebuilt", name: "github_token", action: "BLOCK" });
    }
    if (patterns.length > 0) {
      lines.push("      patterns:");
      for (const p of patterns) {
        lines.push(`        - pattern_type: ${p.type}`);
        lines.push(`          pattern_name: ${p.name}`);
        lines.push(`          action: ${p.action}`);
      }
    }
    if (blockHarmful) {
      lines.push("      categories:");
      lines.push("        - category: harmful_violence");
      lines.push("          enabled: true");
      lines.push("          action: BLOCK");
      lines.push("        - category: harmful_self_harm");
      lines.push("          enabled: true");
      lines.push("          action: BLOCK");
    }
    if (customWords.length > 0) {
      lines.push("      blocked_words:");
      for (const word of customWords) {
        lines.push(`        - keyword: "${word}"`);
        lines.push("          action: BLOCK");
      }
    }
  }

  lines.push("");
  lines.push("general_settings:");
  lines.push(`  master_key: "${masterKey}"`);

  return lines.join("\n") + "\n";
}

/**
 * Returns all model names registered in LiteLLM (Vertex models only), so the
 * OpenClaw config can list them in the litellm provider's models array.
 */
export function litellmRegisteredModelNames(config: DeployConfig): string[] {
  return buildModelList(config).map((m) => String(m.model_name));
}
