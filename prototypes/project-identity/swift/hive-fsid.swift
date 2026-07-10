// hive-fsid — the small amount of Foundation the identity resolver cannot get from Bun.
//
// Three subcommands, each printing one line of JSON to stdout:
//
//   bookmark-create <path>      -> {"bookmark":"<base64>"}
//   bookmark-resolve <base64>   -> {"path":"...","isStale":bool}
//   volinfo <path>              -> {"caseSensitive":bool,"casePreserving":bool,"isLocal":bool}
//
// Bookmarks are *plain* bookmarks, not security-scoped: the blueprint records that
// security-scoped bookmarks lost to plain bookmarks in a nonsandboxed Supervisor.
//
// Errors print {"error":"..."} and exit 1, so the caller never has to parse stderr.

import Foundation

func emit(_ object: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: object)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func fail(_ message: String) -> Never {
    emit(["error": message])
    exit(1)
}

let args = CommandLine.arguments
guard args.count >= 3 else {
    fail("usage: hive-fsid <bookmark-create|bookmark-resolve|volinfo> <arg>")
}

let command = args[1]
let argument = args[2]

switch command {
case "bookmark-create":
    let url = URL(fileURLWithPath: argument)
    do {
        // No .withSecurityScope: a nonsandboxed Supervisor stores plain bookmarks.
        let data = try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
        emit(["bookmark": data.base64EncodedString()])
    } catch {
        fail("bookmarkData failed: \(error.localizedDescription)")
    }

case "bookmark-resolve":
    guard let data = Data(base64Encoded: argument) else { fail("bookmark is not valid base64") }
    var isStale = false
    do {
        let url = try URL(
            resolvingBookmarkData: data,
            options: [],
            relativeTo: nil,
            bookmarkDataIsStale: &isStale
        )
        // .path is the bookmark's own answer; we deliberately do NOT realpath it here.
        // The resolver compares this raw answer against its confirmed canonical path,
        // because silent move-following is precisely what we are trying to detect.
        emit(["path": url.path, "isStale": isStale])
    } catch {
        fail("resolve failed: \(error.localizedDescription)")
    }

case "volinfo":
    let url = URL(fileURLWithPath: argument)
    do {
        let values = try url.resourceValues(forKeys: [
            .volumeSupportsCaseSensitiveNamesKey,
            .volumeSupportsCasePreservedNamesKey,
            .volumeIsLocalKey,
        ])
        emit([
            "caseSensitive": values.volumeSupportsCaseSensitiveNames ?? false,
            "casePreserving": values.volumeSupportsCasePreservedNames ?? false,
            "isLocal": values.volumeIsLocal ?? false,
        ])
    } catch {
        fail("resourceValues failed: \(error.localizedDescription)")
    }

default:
    fail("unknown command: \(command)")
}
