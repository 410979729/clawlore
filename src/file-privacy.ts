import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

type ExecFile = typeof execFileSync;

export interface PrivatePathOptions {
  kind?: "file" | "directory";
  platform?: NodeJS.Platform;
  execFile?: ExecFile;
}

interface WindowsAclAccessRule {
  sid?: string;
  type?: string;
  rights?: string;
  inherited?: boolean;
  inheritanceFlags?: string;
  propagationFlags?: string;
}

interface WindowsAclReport {
  ownerSid?: string;
  protected?: boolean;
  access?: WindowsAclAccessRule[];
}

let cachedWindowsCurrentUserSid: string | null = null;

const WINDOWS_ACL_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$path=$env:CLAWLORE_PRIVATE_PATH",
  "$sidText=$env:CLAWLORE_PRIVATE_SID",
  "$kind=$env:CLAWLORE_PRIVATE_KIND",
  "$mode=$env:CLAWLORE_PRIVATE_MODE",
  "if([string]::IsNullOrWhiteSpace($path)-or[string]::IsNullOrWhiteSpace($sidText)-or[string]::IsNullOrWhiteSpace($kind)){throw 'CLAWLORE_WINDOWS_ACL_INPUT_MISSING'}",
  "$sid=New-Object -TypeName System.Security.Principal.SecurityIdentifier -ArgumentList $sidText",
  "if($mode -eq 'enforce'){$acl=Get-Acl -LiteralPath $path;$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);@($acl.Access)|ForEach-Object{[void]$acl.RemoveAccessRuleSpecific($_)};$inheritance=if($kind -eq 'directory'){[System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'}else{[System.Security.AccessControl.InheritanceFlags]::None};$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,[System.Security.AccessControl.FileSystemRights]::FullControl,$inheritance,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow);[void]$acl.AddAccessRule($rule);Set-Acl -LiteralPath $path -AclObject $acl}",
  "$verified=Get-Acl -LiteralPath $path",
  "$ownerSid=$verified.Owner",
  "try{$ownerSid=([System.Security.Principal.NTAccount]$verified.Owner).Translate([System.Security.Principal.SecurityIdentifier]).Value}catch{try{$ownerSid=(New-Object -TypeName System.Security.Principal.SecurityIdentifier -ArgumentList $verified.Owner).Value}catch{}}",
  "$rules=@($verified.Access|ForEach-Object{$ruleSid=$_.IdentityReference.Value;try{$ruleSid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value}catch{};[ordered]@{sid=$ruleSid;type=$_.AccessControlType.ToString();rights=$_.FileSystemRights.ToString();inherited=$_.IsInherited;inheritanceFlags=$_.InheritanceFlags.ToString();propagationFlags=$_.PropagationFlags.ToString()}})",
  "[ordered]@{ownerSid=$ownerSid;protected=$verified.AreAccessRulesProtected;access=$rules}|ConvertTo-Json -Compress -Depth 5",
].join(";");

const WINDOWS_ACL_ENCODED_COMMAND = Buffer.from(WINDOWS_ACL_SCRIPT, "utf16le").toString("base64");

function windowsCurrentUserSid(run: ExecFile): string {
  if (run === execFileSync && cachedWindowsCurrentUserSid) {
    return cachedWindowsCurrentUserSid;
  }
  const output = String(run("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
  }));
  const sid = output.match(/S-\d-(?:\d+-)+\d+/)?.[0];
  if (!sid) throw new Error("CLAWLORE_WINDOWS_ACL_OWNER_UNRESOLVED");
  if (run === execFileSync) cachedWindowsCurrentUserSid = sid;
  return sid;
}

function parseWindowsAclReport(raw: string): WindowsAclReport {
  try {
    const parsed = JSON.parse(raw) as WindowsAclReport;
    return {
      ownerSid: typeof parsed.ownerSid === "string" ? parsed.ownerSid : undefined,
      protected: parsed.protected === true,
      access: Array.isArray(parsed.access) ? parsed.access : [],
    };
  } catch {
    throw new Error("CLAWLORE_WINDOWS_ACL_REPORT_INVALID");
  }
}

function assertWindowsPrivateAclReport(report: WindowsAclReport, sid: string): void {
  const rules = report.access ?? [];
  const currentAllowRules = rules.filter((rule) =>
    rule.sid?.toUpperCase() === sid.toUpperCase() && rule.type?.toLowerCase() === "allow"
  );
  const unexpectedRule = rules.some((rule) =>
    rule.sid?.toUpperCase() !== sid.toUpperCase() ||
    rule.type?.toLowerCase() !== "allow" ||
    rule.inherited === true
  );
  const hasFullControl = currentAllowRules.some((rule) =>
    /fullcontrol|full control|\b2032127\b/i.test(rule.rights ?? "")
  );
  if (
    report.ownerSid?.toUpperCase() !== sid.toUpperCase() ||
    report.protected !== true ||
    rules.length !== 1 ||
    unexpectedRule ||
    !hasFullControl
  ) {
    throw new Error("CLAWLORE_WINDOWS_ACL_VERIFICATION_FAILED");
  }
}

function windowsPrivateAcl(
  path: string,
  run: ExecFile,
  kind: "file" | "directory",
  mode: "enforce" | "verify",
): void {
  const sid = windowsCurrentUserSid(run);
  const report = parseWindowsAclReport(String(run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    WINDOWS_ACL_ENCODED_COMMAND,
  ], {
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      CLAWLORE_PRIVATE_PATH: path,
      CLAWLORE_PRIVATE_SID: sid,
      CLAWLORE_PRIVATE_KIND: kind,
      CLAWLORE_PRIVATE_MODE: mode,
    },
  })).trim());
  assertWindowsPrivateAclReport(report, sid);
}

export function enforceWindowsPrivateAcl(
  path: string,
  run: ExecFile = execFileSync,
  kind: "file" | "directory" = "file",
): void {
  windowsPrivateAcl(path, run, kind, "enforce");
}

export function verifyWindowsPrivateAcl(
  path: string,
  run: ExecFile = execFileSync,
  kind: "file" | "directory" = "file",
): void {
  windowsPrivateAcl(path, run, kind, "verify");
}

export function enforcePrivatePath(path: string, options: PrivatePathOptions = {}): void {
  if (!existsSync(path)) return;
  const status = lstatSync(path);
  if (status.isSymbolicLink()) {
    throw new Error("CLAWLORE_PRIVATE_PATH_SYMLINK_REJECTED");
  }
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    enforceWindowsPrivateAcl(path, options.execFile ?? execFileSync, options.kind ?? "file");
    return;
  }
  const expectedMode = options.kind === "directory" ? 0o700 : 0o600;
  chmodSync(path, expectedMode);
  const statusAfter = statSync(path);
  const mode = statusAfter.mode & 0o777;
  if (mode !== expectedMode) {
    throw new Error(`CLAWLORE_PRIVATE_PATH_MODE_INVALID:${mode.toString(8)}`);
  }
  if (typeof process.getuid === "function" && statusAfter.uid !== process.getuid()) {
    throw new Error("CLAWLORE_PRIVATE_PATH_OWNER_INVALID");
  }
}

export function verifyPrivatePath(path: string, options: PrivatePathOptions = {}): void {
  if (!existsSync(path)) {
    throw new Error("CLAWLORE_PRIVATE_PATH_MISSING");
  }
  const status = lstatSync(path);
  if (status.isSymbolicLink()) {
    throw new Error("CLAWLORE_PRIVATE_PATH_SYMLINK_REJECTED");
  }
  const kind = options.kind ?? "file";
  if (kind === "directory" ? !status.isDirectory() : !status.isFile()) {
    throw new Error("CLAWLORE_PRIVATE_PATH_KIND_INVALID");
  }
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    verifyWindowsPrivateAcl(path, options.execFile ?? execFileSync, kind);
    return;
  }
  const expectedMode = kind === "directory" ? 0o700 : 0o600;
  const mode = status.mode & 0o777;
  if (mode !== expectedMode) {
    throw new Error(`CLAWLORE_PRIVATE_PATH_MODE_INVALID:${mode.toString(8)}`);
  }
  if (typeof process.getuid === "function" && status.uid !== process.getuid()) {
    throw new Error("CLAWLORE_PRIVATE_PATH_OWNER_INVALID");
  }
}

export function ensurePrivateDirectory(path: string, options: PrivatePathOptions = {}): void {
  if (existsSync(path)) {
    verifyPrivatePath(path, { ...options, kind: "directory" });
    return;
  }
  const missing: string[] = [];
  let existingAncestor = path;
  while (!existsSync(existingAncestor)) {
    missing.push(existingAncestor);
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) {
      throw new Error("CLAWLORE_PRIVATE_PATH_PARENT_MISSING");
    }
    existingAncestor = parent;
  }
  verifyPrivatePath(existingAncestor, { ...options, kind: "directory" });
  for (const directory of missing.reverse()) {
    mkdirSync(directory, { recursive: false, mode: 0o700 });
    enforcePrivatePath(directory, { ...options, kind: "directory" });
  }
}
