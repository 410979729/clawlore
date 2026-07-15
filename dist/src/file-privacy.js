import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, statSync } from "node:fs";
let cachedWindowsCurrentUserSid = null;
function windowsCurrentUserSid(run) {
    if (run === execFileSync && cachedWindowsCurrentUserSid) {
        return cachedWindowsCurrentUserSid;
    }
    const output = String(run("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
        encoding: "utf8",
        windowsHide: true,
    }));
    const sid = output.match(/S-\d-(?:\d+-)+\d+/)?.[0];
    if (!sid)
        throw new Error("CLAWLORE_WINDOWS_ACL_OWNER_UNRESOLVED");
    if (run === execFileSync)
        cachedWindowsCurrentUserSid = sid;
    return sid;
}
function parseWindowsAclReport(raw) {
    try {
        const parsed = JSON.parse(raw);
        return {
            ownerSid: typeof parsed.ownerSid === "string" ? parsed.ownerSid : undefined,
            protected: parsed.protected === true,
            access: Array.isArray(parsed.access) ? parsed.access : [],
        };
    }
    catch {
        throw new Error("CLAWLORE_WINDOWS_ACL_REPORT_INVALID");
    }
}
export function enforceWindowsPrivateAcl(path, run = execFileSync, kind = "file") {
    const sid = windowsCurrentUserSid(run);
    const report = parseWindowsAclReport(String(run("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        [
            "$ErrorActionPreference='Stop'",
            "$path=$args[0]",
            "$sidText=$args[1]",
            "$kind=$args[2]",
            "$sid=New-Object System.Security.Principal.SecurityIdentifier($sidText)",
            "$acl=Get-Acl -LiteralPath $path",
            "$acl.SetOwner($sid)",
            "$acl.SetAccessRuleProtection($true,$false)",
            "@($acl.Access) | ForEach-Object { [void]$acl.RemoveAccessRuleSpecific($_) }",
            "$inheritance=if($kind -eq 'directory'){[System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'}else{[System.Security.AccessControl.InheritanceFlags]::None}",
            "$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,[System.Security.AccessControl.FileSystemRights]::FullControl,$inheritance,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow)",
            "[void]$acl.AddAccessRule($rule)",
            "Set-Acl -LiteralPath $path -AclObject $acl",
            "$verified=Get-Acl -LiteralPath $path",
            "$ownerSid=$verified.Owner",
            "try{$ownerSid=([System.Security.Principal.NTAccount]$verified.Owner).Translate([System.Security.Principal.SecurityIdentifier]).Value}catch{try{$ownerSid=(New-Object System.Security.Principal.SecurityIdentifier($verified.Owner)).Value}catch{}}",
            "$rules=@($verified.Access | ForEach-Object { $ruleSid=$_.IdentityReference.Value; try{$ruleSid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value}catch{}; [ordered]@{sid=$ruleSid;type=$_.AccessControlType.ToString();rights=$_.FileSystemRights.ToString();inherited=$_.IsInherited;inheritanceFlags=$_.InheritanceFlags.ToString();propagationFlags=$_.PropagationFlags.ToString()} })",
            "[ordered]@{ownerSid=$ownerSid;protected=$verified.AreAccessRulesProtected;access=$rules} | ConvertTo-Json -Compress -Depth 5",
        ].join(";"),
        path,
        sid,
        kind,
    ], { encoding: "utf8", windowsHide: true })).trim());
    const rules = report.access ?? [];
    const currentAllowRules = rules.filter((rule) => rule.sid?.toUpperCase() === sid.toUpperCase() && rule.type?.toLowerCase() === "allow");
    const unexpectedRule = rules.some((rule) => rule.sid?.toUpperCase() !== sid.toUpperCase() ||
        rule.type?.toLowerCase() !== "allow" ||
        rule.inherited === true);
    const hasFullControl = currentAllowRules.some((rule) => /fullcontrol|full control|\b2032127\b/i.test(rule.rights ?? ""));
    if (report.ownerSid?.toUpperCase() !== sid.toUpperCase() ||
        report.protected !== true ||
        rules.length !== 1 ||
        unexpectedRule ||
        !hasFullControl) {
        throw new Error("CLAWLORE_WINDOWS_ACL_VERIFICATION_FAILED");
    }
}
export function enforcePrivatePath(path, options = {}) {
    if (!existsSync(path))
        return;
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
