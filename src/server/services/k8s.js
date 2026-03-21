import * as k8s from "@kubernetes/client-node";
let _kc = null;
/**
 * Load kubeconfig from default locations (~/.kube/config or in-cluster SA).
 * Cached after first call.
 */
export function loadKubeConfig() {
    if (_kc)
        return _kc;
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    _kc = kc;
    return kc;
}
/** Reset cached config (useful if context changes). */
export function resetKubeConfig() {
    _kc = null;
}
export function coreApi() {
    return loadKubeConfig().makeApiClient(k8s.CoreV1Api);
}
export function appsApi() {
    return loadKubeConfig().makeApiClient(k8s.AppsV1Api);
}
/**
 * Check if we can connect to a K8s cluster at all.
 */
export async function isClusterReachable() {
    try {
        const client = loadKubeConfig().makeApiClient(k8s.VersionApi);
        await client.getCode();
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Check whether the OpenTelemetry Operator CRD is installed on the cluster.
 */
export async function hasOtelOperator() {
    try {
        const client = loadKubeConfig().makeApiClient(k8s.ApiextensionsV1Api);
        await client.readCustomResourceDefinition({ name: "opentelemetrycollectors.opentelemetry.io" });
        return true;
    }
    catch {
        return false;
    }
}
export function currentContext() {
    try {
        const kc = loadKubeConfig();
        return kc.getCurrentContext();
    }
    catch {
        return "";
    }
}
export function currentNamespace() {
    try {
        const kc = loadKubeConfig();
        const ctxName = kc.getCurrentContext();
        if (!ctxName)
            return "";
        const ctx = kc.getContextObject(ctxName);
        const ns = ctx?.namespace?.trim();
        return ns || "";
    }
    catch {
        return "";
    }
}
export function k8sApiHttpCode(err) {
    if (err && typeof err === "object" && "code" in err) {
        const code = err.code;
        return typeof code === "number" ? code : undefined;
    }
    if (err && typeof err === "object" && "cause" in err) {
        return k8sApiHttpCode(err.cause);
    }
    return undefined;
}
