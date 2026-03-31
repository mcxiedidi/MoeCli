import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { getSecretsPath } from "./paths.js";
import type { ProviderSecretRef } from "../providers/types.js";

const execFileAsync = promisify(execFile);

const SecretFieldSchema = z.object({
  scheme: z.enum(["plain", "dpapi"]),
  value: z.string(),
});

const SecretBlobSchema = z.record(z.string(), z.record(z.string(), SecretFieldSchema));

type SecretBlob = z.infer<typeof SecretBlobSchema>;
export type SecretStorageMode = "plain-file" | "dpapi";

async function encryptWithDpapi(plainText: string): Promise<string> {
  const base64 = Buffer.from(plainText, "utf8").toString("base64");
  const script = [
    `$bytes = [Convert]::FromBase64String("${base64}")`,
    `$text = [Text.Encoding]::UTF8.GetString($bytes)`,
    `$secure = ConvertTo-SecureString -String $text -AsPlainText -Force`,
    `ConvertFrom-SecureString -SecureString $secure`,
  ].join("; ");
  const { stdout } = await execFileAsync("powershell", [
    "-NoProfile",
    "-Command",
    script,
  ]);
  return stdout.trim();
}

async function decryptWithDpapi(cipherText: string): Promise<string> {
  const escaped = cipherText.replace(/'/g, "''");
  const script = [
    `$secure = ConvertTo-SecureString '${escaped}'`,
    `$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)`,
    `try {`,
    `  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)`,
    `  [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($plain))`,
    `} finally {`,
    `  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)`,
    `}`,
  ].join("; ");
  const { stdout } = await execFileAsync("powershell", [
    "-NoProfile",
    "-Command",
    script,
  ]);
  return Buffer.from(stdout.trim(), "base64").toString("utf8");
}

function loadSecretBlob(): SecretBlob {
  if (!existsSync(getSecretsPath())) {
    return {};
  }

  const parsed = SecretBlobSchema.safeParse(
    JSON.parse(readFileSync(getSecretsPath(), "utf8")),
  );

  if (!parsed.success) {
    return {};
  }

  return parsed.data;
}

function saveSecretBlob(blob: SecretBlob): void {
  writeFileSync(getSecretsPath(), `${JSON.stringify(blob, null, 2)}\n`, "utf8");
  try {
    chmodSync(getSecretsPath(), 0o600);
  } catch {
    // Ignore chmod errors on platforms that don't support POSIX modes.
  }
}

async function encodeSecretValue(value: string): Promise<{
  scheme: "plain" | "dpapi";
  value: string;
}> {
  if (process.platform === "win32") {
    try {
      return {
        scheme: "dpapi",
        value: await encryptWithDpapi(value),
      };
    } catch {
      return {
        scheme: "plain",
        value,
      };
    }
  }

  return {
    scheme: "plain",
    value,
  };
}

async function decodeSecretValue(secret: {
  scheme: "plain" | "dpapi";
  value: string;
}): Promise<string> {
  if (secret.scheme === "dpapi") {
    return decryptWithDpapi(secret.value);
  }
  return secret.value;
}

export async function getProfileSecrets(
  profileId: string,
): Promise<ProviderSecretRef> {
  const blob = loadSecretBlob();
  const raw = blob[profileId] ?? {};
  const output: ProviderSecretRef = { profileId };

  for (const [key, value] of Object.entries(raw)) {
    const decoded = await decodeSecretValue(value);
    (output as unknown as Record<string, unknown>)[key] = decoded;
  }

  return output;
}

export async function setProfileSecrets(
  profileId: string,
  secrets: Omit<ProviderSecretRef, "profileId">,
): Promise<{ storage: SecretStorageMode }> {
  const blob = loadSecretBlob();
  const encoded: Record<string, { scheme: "plain" | "dpapi"; value: string }> =
    {};
  let storage: SecretStorageMode = "plain-file";

  for (const [key, value] of Object.entries(secrets)) {
    if (typeof value === "string" && value.trim() !== "") {
      const encodedValue = await encodeSecretValue(value);
      if (encodedValue.scheme === "dpapi") {
        storage = "dpapi";
      }
      encoded[key] = encodedValue;
    }
  }

  blob[profileId] = encoded;
  saveSecretBlob(blob);
  return { storage };
}

export function deleteProfileSecrets(profileId: string): void {
  const blob = loadSecretBlob();
  delete blob[profileId];
  saveSecretBlob(blob);
}

export function getSecretStorageMode(
  profileId: string,
): SecretStorageMode | null {
  const raw = loadSecretBlob()[profileId];
  if (!raw) {
    return null;
  }

  return Object.values(raw).some((entry) => entry.scheme === "dpapi")
    ? "dpapi"
    : "plain-file";
}
