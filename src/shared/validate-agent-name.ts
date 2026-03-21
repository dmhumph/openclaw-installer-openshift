const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const AGENT_NAME_SINGLE_CHAR = /^[a-z0-9]$/;
const MAX_LENGTH = 64;

export function validateAgentName(name: string): string | null {
  if (!name) return null;

  if (name !== name.toLowerCase()) {
    return "Agent name must be lowercase";
  }
  if (/\s/.test(name)) {
    return "Agent name cannot contain spaces";
  }
  if (name === "main") {
    return '"main" is a reserved agent name';
  }
  if (name.length > MAX_LENGTH) {
    return `Agent name cannot exceed ${MAX_LENGTH} characters`;
  }
  if (!/^[a-z0-9]/.test(name)) {
    return "Agent name must start with a letter or number";
  }
  if (name.length > 1 && !/[a-z0-9]$/.test(name)) {
    return "Agent name must end with a letter or number";
  }
  if (name.length === 1) {
    if (!AGENT_NAME_SINGLE_CHAR.test(name)) {
      return "Agent name can only contain lowercase letters, numbers, and hyphens";
    }
  } else if (!AGENT_NAME_PATTERN.test(name)) {
    return "Agent name can only contain lowercase letters, numbers, and hyphens";
  }

  return null;
}
