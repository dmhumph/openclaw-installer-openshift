import { homedir } from "node:os";
import { join } from "node:path";
export function openclawHomeDir() {
    return join(homedir(), ".openclaw");
}
export function installerDataDir() {
    return join(openclawHomeDir(), "installer");
}
export function agentWorkspaceDir(id) {
    return join(openclawHomeDir(), `workspace-${id}`);
}
export function skillsDir() {
    return join(openclawHomeDir(), "skills");
}
export function cronDir() {
    return join(openclawHomeDir(), "cron");
}
export function cronJobsFile() {
    return join(cronDir(), "jobs.json");
}
export function installerLocalInstanceDir(name) {
    return join(installerDataDir(), "local", name);
}
export function installerK8sInstanceDir(namespace) {
    return join(installerDataDir(), "k8s", namespace);
}
