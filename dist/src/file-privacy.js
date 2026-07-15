import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, statSync } from "node:fs";
const WINDOWS_BROAD_PRINCIPALS = ["*S-1-1-0", "*S-1-5-11", "*S-1-5-32-545"];
const WINDOWS_BROAD_ALLOW_ACE = /\(A;[^)]*;;;(?:WD|AU|BU|S-1-1-0|S-1-5-11|S-1-5-32-545)\)/i;
function windowsCurrentUserSid(run) {
    const output = String(run("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
        encoding: "utf8",
        windowsHide: true,
    }));
    const sid = output.match(/S-\d-(?:\d+-)+\d+/)?.[0];
    if (!sid)
        throw new Error("CLAWLORE_WINDOWS_ACL_OWNER_UNRESOLVED");
    return sid;
}
export function enforceWindowsPrivateAcl(path, run = execFileSync) {
    const sid = windowsCurrentUserSid(run);
    run("icacls.exe", [
        path,
        "/inheritance:r",
        "/grant:r",
        `*${sid}:(F)`,
        "/remove:g",
        ...WINDOWS_BROAD_PRINCIPALS,
        "/C",
        "/Q",
    ], { encoding: "utf8", windowsHide: true });
    const sddl = String(run("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$acl=Get-Acl -LiteralPath $args[0]; $acl.Sddl",
        path,
    ], { encoding: "utf8", windowsHide: true })).trim();
    if (!sddl || !/D:P/i.test(sddl) || WINDOWS_BROAD_ALLOW_ACE.test(sddl)) {
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
        enforceWindowsPrivateAcl(path, options.execFile ?? execFileSync);
        return;
    }
    const expectedMode = options.kind === "directory" ? 0o700 : 0o600;
    chmodSync(path, expectedMode);
    const mode = statSync(path).mode & 0o777;
    if (mode !== expectedMode) {
        throw new Error(`CLAWLORE_PRIVATE_PATH_MODE_INVALID:${mode.toString(8)}`);
    }
}
