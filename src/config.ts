import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { credentialFile, outsideRoots } from "./operator-paths.js";
import { inspectCodexAuth, oauthPath } from "./codex-auth.js";
import { requireThat } from "./contracts.js";
export const piConfigSchema = z.union([
  z.strictObject({
    jaredDir: z.string(),
    provider: z.literal("openai-codex"),
    model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/),
    oauthDir: z.string().optional(),
    authSource: z
      .strictObject({ kind: z.enum(["pi", "dedicated"]), path: z.string() })
      .optional(),
  }),
  z.strictObject({
    jaredDir: z.string(),
    provider: z.enum(["openai", "anthropic"]),
    model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/),
    credentialEnv: z.string(),
    credentialFile: z.string(),
  }),
]);
export type PiConfig = z.infer<typeof piConfigSchema>;
export function validatePiConfig(input: PiConfig): PiConfig {
  const pi = piConfigSchema.parse(input);
  if (pi.provider === "openai-codex") {
    const path = oauthPath(pi);
    outsideRoots(path, [pi.jaredDir]);
    inspectCodexAuth(path);
  } else {
    requireThat(
      { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY" }[
        pi.provider
      ] === pi.credentialEnv,
      "unsupported_provider_credential",
    );
    pi.credentialFile = credentialFile(pi.credentialFile);
    outsideRoots(pi.credentialFile, [pi.jaredDir]);
  }
  return pi;
}
export function repositoryRoot() {
  let dir = import.meta.dirname;
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    requireThat(parent !== dir, "service_package_not_found");
    dir = parent;
  }
  return dir;
}
export const bundledAgent = () => join(repositoryRoot(), "agent/v1");
