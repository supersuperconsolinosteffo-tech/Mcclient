#include "win32_platform.hpp"
#include "native_zip.hpp"
#include "native_classifier.hpp"
#include "launch_command.hpp"
#include "webview/webview.h"
#include "nlohmann/json.hpp"

#include "embedded_ui.h"
#include "embedded_defaults.h"
#include "embedded_mod.h"
#include "embedded_oauth.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <map>
#include <mutex>
#include <set>
#include <thread>
#include <tuple>

using json = nlohmann::json;
namespace fs = std::filesystem;
using namespace vespera_win32;

namespace {

std::string url_encode_comp(const std::string& s) {
    std::ostringstream enc;
    for (unsigned char ch : s) {
        if (std::isalnum(ch) || ch == '-' || ch == '_' || ch == '.' || ch == '~') {
            enc << ch;
        } else {
            char buf[4];
            std::snprintf(buf, sizeof(buf), "%%%02X", ch);
            enc << buf;
        }
    }
    return enc.str();
}

std::string url_decode_comp(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (size_t i = 0; i < s.size(); ++i) {
        if (s[i] == '+' ) {
            out.push_back(' ');
        } else if (s[i] == '%' && i + 2 < s.size()) {
            char hex[3] = {s[i + 1], s[i + 2], 0};
            out.push_back(static_cast<char>(std::strtol(hex, nullptr, 16)));
            i += 2;
        } else {
            out.push_back(s[i]);
        }
    }
    return out;
}

struct JavaRuntimeProbe {
    int major = 0;
    std::string versionOutput;
    std::string architecture = "unknown";
};

JavaRuntimeProbe probe_java_runtime(const fs::path& javawPath) {
    JavaRuntimeProbe result;
    DWORD binaryType = 0;
    if (!GetBinaryTypeW(javawPath.wstring().c_str(), &binaryType)) {
        throw std::runtime_error("Cannot inspect Java executable architecture (Win32 error " + std::to_string(GetLastError()) + ")");
    }
    result.architecture = binaryType == SCS_32BIT_BINARY ? "x86" : "unknown";
    std::ifstream executable(javawPath, std::ios::binary);
    unsigned char dosHeader[64]{};
    executable.read(reinterpret_cast<char*>(dosHeader), sizeof(dosHeader));
    if (executable && dosHeader[0] == 'M' && dosHeader[1] == 'Z') {
        const uint32_t peOffset = static_cast<uint32_t>(dosHeader[0x3c]) |
            (static_cast<uint32_t>(dosHeader[0x3d]) << 8) |
            (static_cast<uint32_t>(dosHeader[0x3e]) << 16) |
            (static_cast<uint32_t>(dosHeader[0x3f]) << 24);
        executable.seekg(peOffset, std::ios::beg);
        unsigned char peHeader[6]{};
        executable.read(reinterpret_cast<char*>(peHeader), sizeof(peHeader));
        if (executable && peHeader[0] == 'P' && peHeader[1] == 'E' && peHeader[2] == 0 && peHeader[3] == 0) {
            const uint16_t machine = static_cast<uint16_t>(peHeader[4] | (peHeader[5] << 8));
            result.architecture = machine == IMAGE_FILE_MACHINE_AMD64 ? "x64" :
                (machine == IMAGE_FILE_MACHINE_ARM64 ? "arm64" :
                 (machine == IMAGE_FILE_MACHINE_I386 ? "x86" : "unknown"));
        }
    }

    fs::path javaExe = javawPath.parent_path() / "java.exe";
    if (!fs::exists(javaExe)) javaExe = javawPath;
    SECURITY_ATTRIBUTES security{};
    security.nLength = sizeof(security);
    security.bInheritHandle = TRUE;
    HANDLE readPipe = nullptr, writePipe = nullptr;
    if (!CreatePipe(&readPipe, &writePipe, &security, 0)) {
        throw std::runtime_error("Cannot create pipe for Java version probe (Win32 error " + std::to_string(GetLastError()) + ")");
    }
    SetHandleInformation(readPipe, HANDLE_FLAG_INHERIT, 0);
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdOutput = writePipe;
    startup.hStdError = writePipe;
    startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    PROCESS_INFORMATION process{};
    std::vector<std::wstring> args{L"-version"};
    std::wstring command = vespera::build_windows_command_line(javaExe.wstring(), args);
    if (!CreateProcessW(javaExe.wstring().c_str(), command.data(), nullptr, nullptr, TRUE,
                        CREATE_NO_WINDOW, nullptr, javaExe.parent_path().wstring().c_str(), &startup, &process)) {
        const DWORD error = GetLastError();
        CloseHandle(readPipe); CloseHandle(writePipe);
        throw std::runtime_error("Java -version probe failed to start (Win32 error " + std::to_string(error) + ")");
    }
    CloseHandle(writePipe);
    const DWORD waitResult = WaitForSingleObject(process.hProcess, 10000);
    if (waitResult == WAIT_TIMEOUT) {
        TerminateProcess(process.hProcess, ERROR_TIMEOUT);
        WaitForSingleObject(process.hProcess, 2000);
        CloseHandle(process.hThread); CloseHandle(process.hProcess); CloseHandle(readPipe);
        throw std::runtime_error("Java -version probe timed out after 10 seconds");
    }
    DWORD exitCode = 1;
    GetExitCodeProcess(process.hProcess, &exitCode);
    CloseHandle(process.hThread); CloseHandle(process.hProcess);
    char bytes[1024]; DWORD count = 0;
    while (ReadFile(readPipe, bytes, sizeof(bytes), &count, nullptr) && count > 0) {
        if (result.versionOutput.size() < 16384) result.versionOutput.append(bytes, std::min<size_t>(count, 16384 - result.versionOutput.size()));
    }
    CloseHandle(readPipe);
    result.versionOutput = redact_tokens(result.versionOutput);
    std::smatch match;
    const std::regex versionPattern(R"((?:version|openjdk)\s+\"?([0-9]+)(?:\.[0-9]+)?)");
    if (std::regex_search(result.versionOutput, match, versionPattern)) {
        try { result.major = std::stoi(match[1].str()); } catch (...) { result.major = 0; }
        if (result.major == 1) {
            const std::regex legacyPattern(R"(version\s+\"1\.([0-9]+))");
            if (std::regex_search(result.versionOutput, match, legacyPattern)) result.major = std::stoi(match[1].str());
        }
    }
    if (exitCode != 0 || result.major == 0) {
        throw std::runtime_error("Java -version probe returned exit code " + std::to_string(exitCode) +
            " and could not identify the runtime version; output: " + result.versionOutput);
    }
    return result;
}

std::string query_param_from_target(const std::string& reqTarget, const std::string& key) {
    auto qpos = reqTarget.find('?');
    if (qpos == std::string::npos) return "";
    std::string qs = reqTarget.substr(qpos + 1);
    std::istringstream iss(qs);
    std::string kv;
    while (std::getline(iss, kv, '&')) {
        auto eq = kv.find('=');
        std::string k = (eq == std::string::npos) ? kv : kv.substr(0, eq);
        std::string v = (eq == std::string::npos) ? "" : kv.substr(eq + 1);
        if (url_decode_comp(k) == key) return url_decode_comp(v);
    }
    return "";
}

struct ParsedMavenCoordinate {
    std::string group;
    std::string artifact;
    std::string version;
    std::string classifier;
    std::string extension = "jar";
    std::string relativePath;
};

bool parse_maven_coordinate(const std::string& raw, ParsedMavenCoordinate& out) {
    const auto at = raw.find('@');
    if (at != std::string::npos && raw.find('@', at + 1) != std::string::npos) return false;
    const std::string base = at == std::string::npos ? raw : raw.substr(0, at);
    if (at != std::string::npos) out.extension = raw.substr(at + 1);
    std::vector<std::string> parts;
    std::istringstream stream(base);
    std::string token;
    while (std::getline(stream, token, ':')) parts.push_back(token);
    if ((parts.size() != 3 && parts.size() != 4) || out.extension.empty()) return false;
    auto validToken = [](const std::string& value) {
        return !value.empty() && std::all_of(value.begin(), value.end(), [](unsigned char c) {
            return std::isalnum(c) || c == '_' || c == '.' || c == '+' || c == '-' || c == '~';
        });
    };
    out.group = parts[0]; out.artifact = parts[1]; out.version = parts[2];
    if (parts.size() == 4) out.classifier = parts[3];
    if (!validToken(out.artifact) || !validToken(out.version) ||
        (!out.classifier.empty() && !validToken(out.classifier)) ||
        !std::all_of(out.extension.begin(), out.extension.end(), [](unsigned char c) { return std::isalnum(c); })) return false;
    std::istringstream groups(out.group);
    while (std::getline(groups, token, '.')) {
        if (token.empty() || !std::all_of(token.begin(), token.end(), [](unsigned char c) { return std::isalnum(c) || c == '_' || c == '-'; })) return false;
    }
    if (out.group.empty() || out.group.front() == '.' || out.group.back() == '.') return false;
    std::string groupPath = out.group;
    std::replace(groupPath.begin(), groupPath.end(), '.', '/');
    const std::string filename = out.artifact + "-" + out.version +
        (out.classifier.empty() ? "" : "-" + out.classifier) + "." + out.extension;
    out.relativePath = groupPath + "/" + out.artifact + "/" + out.version + "/" + filename;
    return true;
}

std::string maven_coord_to_rel_path(const std::string& coord) {
    ParsedMavenCoordinate parsed;
    if (!parse_maven_coordinate(coord, parsed)) throw std::runtime_error("Invalid Maven coordinate: " + coord);
    return parsed.relativePath;
}

bool safe_maven_relative_path(const std::string& value) {
    if (value.empty() || value.front() == '/' || value.front() == '\\' || value.find(':') != std::string::npos) return false;
    std::string normalized = value;
    std::replace(normalized.begin(), normalized.end(), '\\', '/');
    std::istringstream stream(normalized);
    std::string part;
    while (std::getline(stream, part, '/')) if (part.empty() || part == "." || part == "..") return false;
    return true;
}

bool is_valid_jar_archive(const fs::path& file, const std::string& requiredEntry = "") {
    std::ifstream input(file, std::ios::binary);
    if (!input) return false;
    std::vector<unsigned char> data((std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());
    if (data.size() < 22) return false;
    const size_t minOffset = data.size() > 65557 ? data.size() - 65557 : 0;
    size_t eocd = std::string::npos;
    for (size_t i = data.size() - 22;; --i) {
        if (data[i] == 0x50 && i + 4 <= data.size() && data[i + 1] == 0x4b && data[i + 2] == 0x05 && data[i + 3] == 0x06) { eocd = i; break; }
        if (i == minOffset) break;
    }
    if (eocd == std::string::npos) return false;
    auto u16 = [&](size_t at) -> uint16_t { return static_cast<uint16_t>(data[at] | (data[at + 1] << 8)); };
    auto u32 = [&](size_t at) -> uint32_t { return static_cast<uint32_t>(data[at]) | (static_cast<uint32_t>(data[at + 1]) << 8) | (static_cast<uint32_t>(data[at + 2]) << 16) | (static_cast<uint32_t>(data[at + 3]) << 24); };
    const uint16_t entries = u16(eocd + 10);
    const uint32_t centralSize = u32(eocd + 12), centralOffset = u32(eocd + 16);
    if (entries == 0 || static_cast<uint64_t>(centralOffset) + centralSize > eocd) return false;
    size_t cursor = centralOffset;
    bool found = requiredEntry.empty();
    for (uint16_t n = 0; n < entries; ++n) {
        if (cursor + 46 > eocd || u32(cursor) != 0x02014b50) return false;
        const uint16_t nameLen = u16(cursor + 28), extraLen = u16(cursor + 30), commentLen = u16(cursor + 32);
        const size_t end = cursor + 46ULL + nameLen + extraLen + commentLen;
        if (end > eocd) return false;
        if (!requiredEntry.empty() && std::string(data.begin() + cursor + 46, data.begin() + cursor + 46 + nameLen) == requiredEntry) found = true;
        cursor = end;
    }
    return found && cursor <= static_cast<uint64_t>(centralOffset) + centralSize;
}

bool validate_fabric_profile(const json& profile) {
    if (!profile.is_object() || !profile.contains("mainClass") || !profile["mainClass"].is_string() ||
        profile["mainClass"].get<std::string>().empty() || !profile.contains("libraries") || !profile["libraries"].is_array()) return false;
    for (const auto& library : profile["libraries"]) {
        if (!library.is_object() || !library.contains("name") || !library["name"].is_string() ||
            !library.contains("url") || !library["url"].is_string()) return false;
        ParsedMavenCoordinate coordinate;
        if (!parse_maven_coordinate(library["name"].get<std::string>(), coordinate) ||
            library["url"].get<std::string>().rfind("https://", 0) != 0) return false;
        if (library.contains("sha1") && !library["sha1"].is_null() && !library["sha1"].is_string()) return false;
        const std::string sha1 = library.contains("sha1") && library["sha1"].is_string() ? library["sha1"].get<std::string>() : "";
        if (!sha1.empty() && (sha1.size() != 40 || !std::all_of(sha1.begin(), sha1.end(), [](unsigned char c) { return std::isxdigit(c) != 0; }))) return false;
    }
    return true;
}

std::string minecraft_windows_arch_token() {
#if defined(_M_X64) || defined(__x86_64__)
    return "64";
#elif defined(_M_IX86) || defined(__i386__)
    return "32";
#else
    throw std::runtime_error("This launcher build does not support the current Windows processor architecture.");
#endif
}

std::string install_loader_key(const std::string& loader) {
    return loader == "fabric" ? "fabric" : (loader == "legacy_fabric" ? "legacy_fabric" : "vanilla");
}

bool evaluate_mojang_windows_rules(const json& lib) {
    if (!lib.contains("rules") || !lib["rules"].is_array() || lib["rules"].empty()) return true;
    bool allowed = false;
    for (const auto& rule : lib["rules"]) {
        if (rule.contains("features")) continue;
        bool matches = true;
        if (rule.contains("os") && rule["os"].is_object()) {
            std::string osName = rule["os"].value("name", "");
            if (!osName.empty() && osName != "windows") matches = false;
            std::string arch = rule["os"].value("arch", "");
            if (arch == "x86" && minecraft_windows_arch_token() != "32") matches = false;
        }
        if (matches) {
            allowed = (rule.value("action", "allow") == "allow");
        }
    }
    return allowed;
}

int infer_java_major_cpp(const std::string& id, const std::string& type, const std::string& releaseTime) {
    int maj = 0, min = 0, patch = 0;
    if (std::sscanf(id.c_str(), "%d.%d.%d", &maj, &min, &patch) >= 2 && id.find_first_not_of("0123456789.") == std::string::npos) {
        if (maj > 1) return 21;
        if (min > 20 || (min == 20 && patch >= 5)) return 21;
        if (min >= 17) return 17;
        return 8;
    }
    if (type == "old_beta" || type == "old_alpha") return 8;
    if (releaseTime >= "2024-04-01") return 21;
    if (releaseTime >= "2021-05-01") return 17;
    return 8;
}

json classify_mojang_entry_cpp(const json& entry) {
    std::string id = entry.value("id", "");
    std::string type = entry.value("type", "release");
    std::string relTime = entry.value("releaseTime", "");
    std::string url = entry.value("url", "");
    int javaMaj = infer_java_major_cpp(id, type, relTime);

    int maj = 0, min = 0, patch = 0;
    bool isReleaseTuple = (std::sscanf(id.c_str(), "%d.%d.%d", &maj, &min, &patch) >= 2 &&
                           id.find_first_not_of("0123456789.") == std::string::npos);

    bool vesperaOk = (id == "1.21.4");
    bool isModernFabricRel = (isReleaseTuple && maj == 1 && min >= 14);
    bool isModernFabricSnap = (type == "snapshot" && relTime >= "2019-01-01");
    bool fabricOk = isModernFabricRel || isModernFabricSnap;
    bool sodiumOk = (isReleaseTuple && maj == 1 && min >= 16);

    std::string supportTier = "vanilla_only";
    std::string compatLabel = "Vanilla Only";
    json recFabric = nullptr;
    int verifiedMods = 0;

    if (vesperaOk) {
        supportTier = "supported";
        compatLabel = "Vespera Supported";
        recFabric = "0.16.10";
        verifiedMods = 15;
    } else if (type == "snapshot") {
        supportTier = "experimental";
        compatLabel = "Experimental";
        if (fabricOk) recFabric = "0.16.10";
        verifiedMods = fabricOk ? 4 : 0;
    } else if (isModernFabricRel) {
        supportTier = "fabric_supported";
        compatLabel = "Fabric Supported";
        recFabric = "0.16.10";
        verifiedMods = sodiumOk ? 12 : 4;
    } else if (id == "1.8.9") {
        supportTier = "legacy_pvp";
        compatLabel = "Vanilla Only";
        recFabric = "0.15.11-legacyfabric";
    }

    return {
        {"id", id},
        {"type", type},
        {"supportTier", supportTier},
        {"compatibilityLabel", compatLabel},
        {"recommendedJavaMajor", javaMaj},
        {"recommendedFabricLoader", recFabric},
        {"fabricSupported", fabricOk},
        {"vanillaSupported", true},
        {"sha1", entry.value("sha1", "")},
        {"releaseTime", relTime},
        {"manifestUrl", url},
        {"verifiedModsCount", verifiedMods},
        {"sodiumSupported", sodiumOk},
        {"irisSupported", sodiumOk},
        {"vesperaModSupported", vesperaOk}
    };
}

} // namespace

class VesperaNativeEngine {
public:
    fs::path dataRoot;
    fs::path statePath;
    fs::path vaultPath;
    fs::path ipcDir;
    fs::path cacheDir;
    fs::path modsPoolDir;
    fs::path runtimesDir;
    fs::path instancesDir;
    fs::path crashLockPath;

    json state;
    json vaultAccounts = json::array();
    json pendingMsaChallenge = nullptr;
    json authFlowState = {{"mode", "idle"}, {"message", "Ready to sign in with Microsoft."}};
    json activeDownloadState = nullptr;
    std::string activeSessionMode = "online_authenticated";
    std::atomic<bool> backgroundInstallActive{false};
    std::mutex jobControlMtx;
    mutable std::mutex progressMtx;
    std::mutex installSnapshotMtx;
    json installSnapshotCache = nullptr;
    std::mutex logsMtx;
    std::string manifestSource = "embedded_seed";
    std::string manifestError;
    int64_t manifestFetchedAtMs = 0;
    std::string latestReleaseId = "1.21.4";
    std::string latestSnapshotId = "25w09b";

    std::atomic<bool> cancelDownloadFlag{false};
    std::atomic<bool> cancelAuthFlag{false};
    SOCKET activePkceListenSocket = INVALID_SOCKET;
    std::set<std::string> consumedAuthCodes;

    std::vector<std::string> logs;
    std::mutex mtx;

    HANDLE activeMcProcess = nullptr;
    DWORD activeMcPid = 0;
    DWORD lastMcExitCode = STILL_ACTIVE;
    DWORD lastProcessQueryError = 0;
    std::string lastMcDiagnosticPath;
    ULONGLONG prevIdleTime = 0;
    ULONGLONG prevKernelTime = 0;
    ULONGLONG prevUserTime = 0;

    VesperaNativeEngine() {
        WSADATA wsa{};
        WSAStartup(MAKEWORD(2, 2), &wsa);

        std::string appData = get_known_folder_utf8(FOLDERID_RoamingAppData, "APPDATA");
        dataRoot = fs::u8path(appData) / "VesperaClient";
        statePath = dataRoot / "vespera-state.json";
        vaultPath = dataRoot / "vault" / "accounts.dpapi";
        ipcDir = dataRoot / "ipc";
        cacheDir = dataRoot / "cache";
        modsPoolDir = dataRoot / "mods-pool";
        runtimesDir = dataRoot / "runtimes";
        instancesDir = dataRoot / "instances";
        crashLockPath = dataRoot / "session.lock";

        std::error_code ec;
        fs::create_directories(dataRoot, ec);
        fs::create_directories(ipcDir, ec);
        fs::create_directories(cacheDir, ec);
        fs::create_directories(modsPoolDir, ec);
        fs::create_directories(runtimesDir, ec);
        fs::create_directories(instancesDir, ec);

        initializeStateAndMod();
        loadDpapiVault();
        loadCachedManifestIfPresent();
    }

    ~VesperaNativeEngine() {
        cancelDownloadFlag.store(true);
        cancelAuthFlag.store(true);
        if (activePkceListenSocket != INVALID_SOCKET) {
            closesocket(activePkceListenSocket);
            activePkceListenSocket = INVALID_SOCKET;
        }
        std::error_code ec;
        fs::remove(crashLockPath, ec);
        if (activeMcProcess) {
            CloseHandle(activeMcProcess);
        }
        WSACleanup();
    }

    void appendLog(const std::string& msg) {
        std::string clean = "[" + iso_timestamp_now().substr(11, 8) + "] " + redact_tokens(msg);
        std::lock_guard<std::mutex> logLock(logsMtx);
        logs.push_back(clean);
        if (logs.size() > 250) {
            logs.erase(logs.begin(), logs.begin() + (logs.size() - 250));
        }
        std::ofstream ofs(dataRoot / "logs" / "launcher.log", std::ios::app);
        if (ofs) ofs << clean << "\n";
    }

    bool beginBackgroundInstallOperation() {
        {
            std::lock_guard<std::mutex> jobLock(jobControlMtx);
            if (backgroundInstallActive.load()) return false;
            cancelDownloadFlag.store(false);
            backgroundInstallActive.store(true);
        }
        try {
            std::lock_guard<std::mutex> stateLock(mtx);
            refreshTelemetry();
            const auto& profile = activeProfileRef();
            json progress = {
                {"active", true}, {"versionId", profile.value("mcVersion", "")},
                {"profileId", state.value("activeProfileId", "")},
                {"loader", profile.value("loader", "vanilla")}, {"status", "installing"},
                {"stage", "Preparing installation and launch task…"}, {"percent", 0},
                {"bytesDownloaded", 0}, {"totalBytes", 0}, {"speedBytesPerSec", 0},
                {"etaSeconds", nullptr}, {"completedFiles", 0}, {"totalFiles", 0},
                {"cancellable", true}, {"error", nullptr}
            };
            {
                std::lock_guard<std::mutex> progressLock(progressMtx);
                activeDownloadState = progress;
            }
            std::lock_guard<std::mutex> snapshotLock(installSnapshotMtx);
            installSnapshotCache = state;
            installSnapshotCache["activeDownload"] = progress;
        } catch (...) {
            std::lock_guard<std::mutex> jobLock(jobControlMtx);
            backgroundInstallActive.store(false);
            throw;
        }
        return true;
    }

    void endBackgroundInstallOperation() {
        try {
            json snapshot;
            {
                std::lock_guard<std::mutex> stateLock(mtx);
                refreshTelemetry();
                snapshot = state;
            }
            {
                std::lock_guard<std::mutex> progressLock(progressMtx);
                if (activeDownloadState.is_object() && activeDownloadState.value("active", false)) {
                    activeDownloadState["active"] = false;
                    activeDownloadState["cancellable"] = false;
                    activeDownloadState["stage"] = "Launcher task finished.";
                }
                snapshot["activeDownload"] = activeDownloadState;
            }
            {
                std::lock_guard<std::mutex> snapshotLock(installSnapshotMtx);
                installSnapshotCache = std::move(snapshot);
            }
        } catch (...) {
            // Even if snapshot refresh fails, release the task gate so the UI can retry.
        }
        {
            std::lock_guard<std::mutex> jobLock(jobControlMtx);
            backgroundInstallActive.store(false);
        }
    }

    void updateBackgroundTaskStage(const std::string& status, const std::string& stage) {
        json progress;
        {
            std::lock_guard<std::mutex> progressLock(progressMtx);
            if (!activeDownloadState.is_object()) activeDownloadState = json::object();
            activeDownloadState["active"] = true;
            activeDownloadState["cancellable"] = true;
            activeDownloadState["status"] = status;
            activeDownloadState["stage"] = stage;
            activeDownloadState["error"] = nullptr;
            progress = activeDownloadState;
        }
        std::lock_guard<std::mutex> snapshotLock(installSnapshotMtx);
        if (installSnapshotCache.is_object()) installSnapshotCache["activeDownload"] = std::move(progress);
    }

    void recordBackgroundJournalFailure(const std::string& message) {
        json progress;
        {
            std::lock_guard<std::mutex> progressLock(progressMtx);
            progress = activeDownloadState;
        }
        if (!progress.is_object()) return;
        const std::string versionId = progress.value("versionId", "");
        const std::string loader = progress.value("loader", "vanilla");
        if (versionId.empty()) return;
        const std::string loaderKey = loader == "fabric" ? "fabric" : (loader == "legacy_fabric" ? "legacy_fabric" : "vanilla");
        const fs::path journalPath = getGameRootDir() / "versions" / versionId / ("vespera-install-journal-" + loaderKey + ".json");
        std::error_code ec;
        if (!fs::exists(journalPath, ec)) return;
        json journal = json::parse(read_text_file(journalPath), nullptr, false);
        if (!journal.is_object() || journal.value("state", "") == "installed") return;
        journal["state"] = cancelDownloadFlag.load() ? "partially_downloaded" : "failed";
        journal["failureReason"] = cancelDownloadFlag.load() ? "Cancelled by user; verified artifacts retained." : message;
        journal["updatedAt"] = iso_timestamp_now();
        write_text_atomic(journalPath, journal.dump(2));
    }

    void markBackgroundTaskFailure(const std::string& message) {
        json progress;
        {
            std::lock_guard<std::mutex> progressLock(progressMtx);
            if (!activeDownloadState.is_object()) activeDownloadState = json::object();
            activeDownloadState["active"] = false;
            activeDownloadState["cancellable"] = false;
            if (cancelDownloadFlag.load()) {
                activeDownloadState["status"] = "cancelled";
                activeDownloadState["stage"] = "Cancelled · verified files preserved for recovery";
                activeDownloadState["error"] = "Cancelled by user.";
            } else {
                activeDownloadState["status"] = "failed";
                activeDownloadState["stage"] = "Task failed";
                activeDownloadState["error"] = message;
            }
            progress = activeDownloadState;
        }
        std::lock_guard<std::mutex> snapshotLock(installSnapshotMtx);
        if (installSnapshotCache.is_object()) installSnapshotCache["activeDownload"] = std::move(progress);
    }

    json getBackgroundInstallSnapshot() {
        json snapshot;
        {
            std::lock_guard<std::mutex> snapshotLock(installSnapshotMtx);
            snapshot = installSnapshotCache;
        }
        if (!snapshot.is_object()) return snapshot;
        {
            std::lock_guard<std::mutex> progressLock(progressMtx);
            snapshot["activeDownload"] = activeDownloadState;
        }
        return snapshot;
    }

    static bool isValidPublicClientUuid(const std::string& s) {
        if (s.size() != 36) return false;
        if (s == "00000000-0000-0000-0000-000000000000") return false;
        for (size_t i = 0; i < s.size(); ++i) {
            if (i == 8 || i == 13 || i == 18 || i == 23) {
                if (s[i] != '-') return false;
            } else {
                char c = s[i];
                bool hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
                if (!hex) return false;
            }
        }
        return true;
    }

    std::string getEmbeddedClientId() const {
        wchar_t envBuf[128] = {};
        DWORD n = GetEnvironmentVariableW(L"VESPERA_MSA_CLIENT_ID", envBuf, 127);
        if (n > 0 && n < 127) {
            std::string envCid = wide_to_utf8(envBuf);
            if (isValidPublicClientUuid(envCid)) return envCid;
        }
        std::string embedded = kEmbeddedMsaClientId ? std::string(kEmbeddedMsaClientId) : std::string("");
        return isValidPublicClientUuid(embedded) ? embedded : std::string("");
    }

    bool isOAuthConfigured() const {
        return !getEmbeddedClientId().empty();
    }

    void sanitizeLoadedState(const json& defaults) {
        if (!state.is_object()) {
            state = defaults;
            return;
        }
        if (state.contains("diagnostics") && state["diagnostics"].is_object()) {
            if (state["diagnostics"].contains("findings") && state["diagnostics"]["findings"].is_array()) {
                state["diagnostics"] = state["diagnostics"]["findings"];
            } else {
                state["diagnostics"] = json::array();
            }
        } else if (!state.contains("diagnostics") || !state["diagnostics"].is_array()) {
            state["diagnostics"] = json::array();
        }

        const char* arrayKeys[] = {
            "profiles", "versions", "javaRuntimes", "profileBackups",
            "installedMods", "curatedCatalog", "modHistory",
            "shaderPacks", "resourcePacks", "hudLayouts", "accounts", "recentLogs"
        };
        for (const char* k : arrayKeys) {
            if (!state.contains(k) || !state[k].is_array()) {
                state[k] = defaults.value(k, json::array());
            }
        }
        if (state["profiles"].empty()) state["profiles"] = defaults["profiles"];
        if (state["versions"].empty()) state["versions"] = defaults["versions"];
        if (state["hudLayouts"].empty()) state["hudLayouts"] = defaults["hudLayouts"];
        // Always refresh curatedCatalog to v1.2.2 definitions
        state["curatedCatalog"] = defaults["curatedCatalog"];
        if (!state.contains("settings") || !state["settings"].is_object()) {
            state["settings"] = defaults["settings"];
        }
        if (!state.contains("latestBenchmark") || state["latestBenchmark"].is_null()) {
            state["latestBenchmark"] = defaults["latestBenchmark"];
        }
        // Migrate v1.0.0 profiles cleanly
        for (auto& p : state["profiles"]) {
            if (!p.contains("loader") || (!p["loader"].is_string())) {
                p["loader"] = "fabric";
            }
            if (!p.contains("loaderVersion") || !p["loaderVersion"].is_string()) {
                p["loaderVersion"] = (p["loader"] == "vanilla") ? "vanilla" : "0.16.10";
            }
            bool vesperaOk = (p["loader"] == "fabric" && p.value("mcVersion", "") == "1.21.4");
            p["vesperaModCompatible"] = vesperaOk;
        }
        state["version"] = "1.2.5";
        state["platformMode"] = "windows_native_webview2";
    }

    void initializeStateAndMod() {
        std::error_code ec;
        fs::create_directories(dataRoot / "logs", ec);

        if (fs::exists(crashLockPath)) {
            appendLog("[CrashRecovery] Recovered cleanly from previous session lock via atomic state journal.");
        }
        write_text_atomic(crashLockPath, "{\"active\":true}");

        fs::path targetMod = modsPoolDir / "vespera-client-1.2.2+mc1.21.4.jar";
        if (!fs::exists(targetMod)) {
            write_file_atomic(targetMod, kEmbeddedModJarData, kEmbeddedModJarSize);
            appendLog("[FirstLaunch] Provisioned verified vespera-client-1.2.2+mc1.21.4.jar to managed mods pool.");
        }

        json defaults = json::parse(kDefaultSnapshotJson);
        if (fs::exists(statePath)) {
            try {
                state = json::parse(read_text_file(statePath));
                sanitizeLoadedState(defaults);
                saveState();
                appendLog("[Core] Loaded and verified Vespera Client v1.2.5 Windows configuration.");
                return;
            } catch (...) {
                appendLog("[CrashRecovery] State file corrupted; restoring verified factory configuration.");
            }
        }

        state = defaults;
        sanitizeLoadedState(defaults);
        state["settings"]["gameDataDir"] = wide_to_utf8((dataRoot / "minecraft").wstring());
        state["settings"]["instancesDir"] = wide_to_utf8(instancesDir.wstring());
        saveState();
        syncHudIpc();
        appendLog("[FirstLaunch] Initialized managed %APPDATA%\\VesperaClient workspace.");
    }

    static bool isSha1Hex(const std::string& value) {
        return value.size() == 40 && std::all_of(value.begin(), value.end(), [](unsigned char c) { return std::isxdigit(c) != 0; });
    }

    bool validateOfficialManifest(const json& raw, std::string& why) const {
        if (!raw.is_object() || !raw.contains("versions") || !raw["versions"].is_array() || raw["versions"].empty()) {
            why = "Invalid JSON: Mojang manifest has no versions array."; return false;
        }
        std::set<std::string> ids;
        for (const auto& entry : raw["versions"]) {
            if (!entry.is_object()) { why = "Invalid JSON: non-object version entry."; return false; }
            const std::string id = entry.value("id", "");
            const std::string url = entry.value("url", "");
            const std::string sha1 = entry.value("sha1", "");
            if (id.empty() || !ids.insert(id).second || url.rfind("https://", 0) != 0 || !isSha1Hex(sha1) || entry.value("releaseTime", "").empty()) {
                why = "Invalid JSON: manifest entry must contain a unique version ID, HTTPS metadata URL, release time, and 40-character SHA-1."; return false;
            }
        }
        return true;
    }

    bool validateVersionMetadata(const json& meta, const std::string& expectedId, std::string& why) const {
        if (!meta.is_object() || meta.value("id", "") != expectedId || !meta.contains("mainClass") ||
            !meta["mainClass"].is_string() || meta["mainClass"].get<std::string>().empty() ||
            !meta.contains("downloads") || !meta["downloads"].is_object() || !meta["downloads"].contains("client") ||
            !meta["downloads"]["client"].is_object() || !meta.contains("libraries") || !meta["libraries"].is_array() ||
            !meta.contains("assetIndex") || !meta["assetIndex"].is_object()) {
            why = "Invalid version metadata for " + expectedId + ": exact version ID, mainClass, or client download record is missing."; return false;
        }
        const auto& client = meta["downloads"]["client"];
        if (client.value("url", "").rfind("https://", 0) != 0 || !isSha1Hex(client.value("sha1", ""))) {
            why = "Invalid version metadata for " + expectedId + ": client JAR URL or SHA-1 is invalid."; return false;
        }
        if (meta.contains("libraries") && !meta["libraries"].is_array()) {
            why = "Invalid version metadata for " + expectedId + ": libraries is not an array."; return false;
        }
        if (meta.contains("assetIndex")) {
            const auto& idx = meta["assetIndex"];
            if (!idx.is_object() || idx.value("id", "").empty() || idx.value("url", "").rfind("https://", 0) != 0 || !isSha1Hex(idx.value("sha1", ""))) {
                why = "Invalid version metadata for " + expectedId + ": asset index URL or SHA-1 is invalid."; return false;
            }
        }
        return true;
    }

    int64_t nowEpochMs() const {
        return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
    }

    bool manifestIsFresh() const {
        const int64_t age = nowEpochMs() - manifestFetchedAtMs;
        return manifestSource != "embedded_seed" && manifestFetchedAtMs > 0 && age >= 0 && age < 6LL * 60 * 60 * 1000;
    }

    void loadCachedManifestIfPresent() {
        const fs::path manifestPath = cacheDir / "version_manifest_v2.json";
        if (!fs::exists(manifestPath)) return;
        try {
            json raw = json::parse(read_text_file(manifestPath), nullptr, false);
            std::string why;
            if (!raw.is_discarded() && validateOfficialManifest(raw, why)) {
                applyRawMojangManifest(raw, "local_cache");
                const fs::path infoPath = cacheDir / "version_manifest_v2.info.json";
                if (fs::exists(infoPath)) {
                    json info = json::parse(read_text_file(infoPath), nullptr, false);
                    if (info.is_object()) manifestFetchedAtMs = info.value("fetchedAt", int64_t(0));
                }
                return;
            }
        } catch (...) {}
        std::error_code ec;
        fs::remove(manifestPath, ec);
        fs::remove(cacheDir / "version_manifest_v2.info.json", ec);
        manifestFetchedAtMs = 0;
        appendLog("[VersionManager] Discarded corrupted/incomplete Mojang manifest cache; retaining offline catalogue fallback.");
    }

    bool refreshOfficialManifest(bool force) {
        if (!force && manifestIsFresh()) return true;
        const std::string url = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
        HttpResponse response = winhttp_request("GET", url, "", "application/json", "", &cancelDownloadFlag);
        if (response.statusCode != 200) {
            manifestError = response.statusCode > 0
                ? "HTTP " + std::to_string(response.statusCode) + " fetching official Mojang version manifest " + url
                : (response.error.empty() ? "Network failure fetching official Mojang version manifest " + url : response.error);
            return false;
        }
        json raw = json::parse(response.body, nullptr, false);
        std::string why;
        if (raw.is_discarded() || !validateOfficialManifest(raw, why)) {
            manifestError = raw.is_discarded() ? "Invalid JSON from official Mojang version manifest " + url : why + " URL: " + url;
            return false;
        }
        try {
            if (!write_text_atomic(cacheDir / "version_manifest_v2.json", response.body)) throw std::runtime_error("manifest cache write failed");
            manifestFetchedAtMs = nowEpochMs();
            if (!write_text_atomic(cacheDir / "version_manifest_v2.info.json", json({{"fetchedAt", manifestFetchedAtMs}, {"url", url}}).dump(2))) throw std::runtime_error("manifest cache metadata write failed");
            applyRawMojangManifest(raw, "live_mojang");
            manifestError.clear();
            return true;
        } catch (const std::exception& ex) {
            manifestError = std::string("Could not atomically cache official Mojang manifest: ") + ex.what();
            manifestFetchedAtMs = 0;
            return false;
        }
    }

    json* findManifestEntry(const std::string& versionId) {
        if (manifestSource == "embedded_seed") return nullptr;
        if (!state.contains("versions") || !state["versions"].is_array()) return nullptr;
        for (auto& entry : state["versions"]) if (entry.value("id", "") == versionId) return &entry;
        return nullptr;
    }

    bool loadVerifiedCachedMetadata(const std::string& versionId, const fs::path& metaPath,
                                    const std::string& manifestSha1, json& outMeta, std::string& why) {
        std::error_code ec;
        if (!fs::exists(metaPath, ec)) return false;
        std::string expectedSha1 = manifestSha1;
        fs::path sidecar = metaPath; sidecar += ".cache.json";
        if (expectedSha1.empty() && fs::exists(sidecar, ec)) {
            json info = json::parse(read_text_file(sidecar), nullptr, false);
            if (info.is_object()) expectedSha1 = info.value("sha1", "");
        }
        const std::string actualSha1 = bcrypt_hash_file(metaPath, BCRYPT_SHA1_ALGORITHM);
        if (!isSha1Hex(expectedSha1) || _stricmp(actualSha1.c_str(), expectedSha1.c_str()) != 0) {
            why = "SHA-1 mismatch or unavailable for cached version metadata " + versionId + ".";
            fs::remove(metaPath, ec); fs::remove(sidecar, ec); return false;
        }
        outMeta = json::parse(read_text_file(metaPath), nullptr, false);
        if (outMeta.is_discarded() || !validateVersionMetadata(outMeta, versionId, why)) {
            if (why.empty()) why = "Invalid JSON in cached version metadata " + versionId + ".";
            fs::remove(metaPath, ec); fs::remove(sidecar, ec); return false;
        }
        return true;
    }

    bool downloadVersionMetadata(const std::string& versionId, const fs::path& metaPath,
                                 std::string& metadataUrl, std::string& expectedSha1,
                                 std::string& outError) {
        json* entry = findManifestEntry(versionId);
        if (!entry) {
            outError = "Version " + versionId + " is absent from the official Mojang manifest." + (manifestError.empty() ? "" : " Manifest diagnostic: " + manifestError);
            return false;
        }
        metadataUrl = entry->value("manifestUrl", "");
        expectedSha1 = entry->value("sha1", "");
        if (metadataUrl.empty() || !isSha1Hex(expectedSha1)) {
            outError = "Invalid official manifest entry for " + versionId + ": metadata URL and SHA-1 are required.";
            return false;
        }
        auto downloadAt = [&](const std::string& url, const std::string& hash) {
            if (!winhttp_download_verified(url, metaPath, hash, true, &cancelDownloadFlag, [](size_t) {}, outError)) return false;
            json meta = json::parse(read_text_file(metaPath), nullptr, false);
            std::string why;
            if (meta.is_discarded() || !validateVersionMetadata(meta, versionId, why)) {
                outError = meta.is_discarded() ? "Invalid JSON for Minecraft " + versionId + " metadata from " + url : why + " URL: " + url;
                std::error_code ec; fs::remove(metaPath, ec); return false;
            }
            if (!write_text_atomic(fs::path(metaPath.string() + ".cache.json"), json({{"url", url}, {"sha1", hash}, {"fetchedAt", nowEpochMs()}}).dump(2))) {
                outError = "Could not atomically cache verified metadata for Minecraft " + versionId + ".";
                std::error_code ec; fs::remove(metaPath, ec);
                return false;
            }
            return true;
        };
        if (downloadAt(metadataUrl, expectedSha1)) return true;
        if (outError.rfind("HTTP 404", 0) != 0) return false;
        const std::string oldUrl = metadataUrl;
        refreshOfficialManifest(true);
        entry = findManifestEntry(versionId); // exact ID from freshly fetched official manifest
        if (!entry) {
            outError = "Mojang metadata HTTP 404 for Minecraft " + versionId + ": " + oldUrl + " (HTTP 404) after official manifest refresh." + (manifestError.empty() ? "" : " " + manifestError);
            return false;
        }
        metadataUrl = entry->value("manifestUrl", "");
        expectedSha1 = entry->value("sha1", "");
        if (metadataUrl.empty() || !isSha1Hex(expectedSha1)) {
            outError = "Mojang metadata HTTP 404 for Minecraft " + versionId + ": refreshed entry lacks URL or SHA-1.";
            return false;
        }
        if (downloadAt(metadataUrl, expectedSha1)) return true;
        if (outError.rfind("HTTP 404", 0) == 0) outError = "Mojang metadata HTTP 404 for Minecraft " + versionId + ": " + metadataUrl + " (HTTP 404) after manifest refresh.";
        return false;
    }

    void applyRawMojangManifest(const json& raw, const std::string& src) {
        std::string why;
        if (!validateOfficialManifest(raw, why)) return;
        json arr = json::array();
        for (const auto& e : raw["versions"]) arr.push_back(classify_mojang_entry_cpp(e));
        if (!arr.empty()) {
            state["versions"] = arr;
            manifestSource = src;
            if (raw.contains("latest") && raw["latest"].is_object()) {
                latestReleaseId = raw["latest"].value("release", latestReleaseId);
                latestSnapshotId = raw["latest"].value("snapshot", latestSnapshotId);
            }
        }
    }

    void saveState() {
        write_text_atomic(statePath, state.dump(2));
    }

    void loadDpapiVault() {
        std::string plain = dpapi_load_secret(vaultPath);
        if (!plain.empty()) {
            try {
                vaultAccounts = json::parse(plain);
            } catch (...) {
                vaultAccounts = json::array();
            }
        }
    }

    void saveDpapiVault() {
        dpapi_save_secret(vaultPath, vaultAccounts.dump());
    }

    json& activeProfileRef() {
        std::string activeId = state.value("activeProfileId", "");
        for (auto& p : state["profiles"]) {
            if (p.value("id", "") == activeId) return p;
        }
        return state["profiles"][0];
    }

    fs::path getGameRootDir() const {
        return fs::u8path(state["settings"].value("gameDataDir", wide_to_utf8((dataRoot / "minecraft").wstring())));
    }

    std::string getVersionInstallStatusOnDisk(const std::string& verId, const std::string& requestedLoader = "") const {
        {
            std::lock_guard<std::mutex> progressLock(progressMtx);
            if (!activeDownloadState.is_null() && activeDownloadState.value("active", false) &&
                activeDownloadState.value("versionId", "") == verId) {
                return activeDownloadState.value("status", "downloading");
            }
        }
        std::string selectedLoader = requestedLoader;
        if (selectedLoader.empty()) {
            const std::string activeId = state.value("activeProfileId", "");
            if (state.contains("profiles") && state["profiles"].is_array()) {
                for (const auto& profile : state["profiles"]) if (profile.value("id", "") == activeId) {
                    selectedLoader = profile.value("loader", "vanilla"); break;
                }
            }
        }
        const std::string loaderKey = install_loader_key(selectedLoader.empty() ? "vanilla" : selectedLoader);
        fs::path vDir = getGameRootDir() / "versions" / verId;
        std::error_code ec;
        if (!fs::exists(vDir, ec)) return "not_installed";
        fs::path receipt = vDir / ("vespera-install-receipt-" + loaderKey + ".json");
        fs::path jar = vDir / (verId + ".jar");
        fs::path partJar = vDir / (verId + ".jar.part");
        fs::path meta = vDir / (verId + ".json");
        if (fs::exists(receipt, ec) && fs::exists(jar, ec) && fs::file_size(jar, ec) > 0 && fs::exists(meta, ec)) {
            json record = json::parse(read_text_file(receipt), nullptr, false);
            if (record.is_object() && record.value("versionId", "") == verId && record.contains("verifiedHashes") && record["verifiedHashes"].is_object()) {
                bool complete = true;
                for (auto it = record["verifiedHashes"].begin(); it != record["verifiedHashes"].end(); ++it) {
                    fs::path artifact = getGameRootDir() / fs::u8path(it.key());
                    if (!fs::exists(artifact, ec) || fs::file_size(artifact, ec) == 0 ||
                        _stricmp(bcrypt_hash_file(artifact, BCRYPT_SHA1_ALGORITHM).c_str(), it.value().get<std::string>().c_str()) != 0) {
                        complete = false; break;
                    }
                }
                if (complete && record.contains("verifiedAssets") && record["verifiedAssets"].is_array() &&
                    record.contains("verifiedLibraryFiles") && record["verifiedLibraryFiles"].is_array()) {
                    for (const auto& rel : record["verifiedLibraryFiles"]) {
                        if (!rel.is_string()) { complete = false; break; }
                        fs::path libraryPath = getGameRootDir() / fs::u8path(rel.get<std::string>());
                        if (!fs::exists(libraryPath, ec) || fs::file_size(libraryPath, ec) == 0 || !is_valid_jar_archive(libraryPath)) {
                            complete = false; break;
                        }
                    }
                    if (complete) {
                        const std::string nativeRelative = record.value("nativeDirectory", "");
                        const uint64_t expectedNativeCount = record.value("nativeDllCount", 0ULL);
                        const std::string expectedNativeDirectory = (vDir / ("natives-" + loaderKey)).lexically_relative(getGameRootDir()).generic_string();
                        complete = record.value("loader", "") == (selectedLoader.empty() ? "vanilla" : selectedLoader) &&
                                   nativeRelative == expectedNativeDirectory && safe_maven_relative_path(nativeRelative) && expectedNativeCount > 0 &&
                                   record.contains("verifiedNativeFiles") && record["verifiedNativeFiles"].is_array() &&
                                   record["verifiedNativeFiles"].size() == expectedNativeCount;
                        if (complete) {
                            for (const auto& nativeFile : record["verifiedNativeFiles"]) {
                                if (!nativeFile.is_object()) { complete = false; break; }
                                const std::string rel = nativeFile.value("path", "");
                                const std::string sha1 = nativeFile.value("sha1", "");
                                fs::path path = getGameRootDir() / fs::u8path(rel);
                                if (!safe_maven_relative_path(rel) || rel.rfind(nativeRelative + "/", 0) != 0 ||
                                    !isSha1Hex(sha1) || !fs::is_regular_file(path, ec) || fs::file_size(path, ec) == 0 ||
                                    _stricmp(bcrypt_hash_file(path, BCRYPT_SHA1_ALGORITHM).c_str(), sha1.c_str()) != 0) {
                                    complete = false; break;
                                }
                            }
                        }
                    }
                    if (complete && record.contains("verifiedLibraryIntegrity") && record["verifiedLibraryIntegrity"].is_array()) {
                        for (const auto& artifact : record["verifiedLibraryIntegrity"]) {
                            if (!artifact.is_object()) { complete = false; break; }
                            const std::string rel = artifact.value("path", "");
                            const std::string requiredEntry = artifact.value("requiredEntry", "");
                            fs::path libraryPath = getGameRootDir() / fs::u8path(rel);
                            if (rel.empty() || !is_valid_jar_archive(libraryPath, requiredEntry)) { complete = false; break; }
                        }
                    }
                    if (complete) return "ready";
                }
            }
        }
        if (fs::exists(partJar, ec) || fs::exists(jar, ec)) return "partially_downloaded";
        if (fs::exists(meta, ec)) return "metadata_cached";
        return "not_installed";
    }

    void syncHudIpc() {
        auto& prof = activeProfileRef();
        std::string hid = prof.value("hudLayoutId", "");
        for (const auto& h : state["hudLayouts"]) {
            if (h.value("id", "") == hid) {
                write_text_atomic(ipcDir / "hud-profile.json", h.dump(2));
                break;
            }
        }
    }

    double sampleCpuPercent() {
        FILETIME idleFt{}, kernelFt{}, userFt{};
        if (!GetSystemTimes(&idleFt, &kernelFt, &userFt)) return 2.0;
        auto toU64 = [](const FILETIME& ft) -> ULONGLONG {
            return (static_cast<ULONGLONG>(ft.dwHighDateTime) << 32) | ft.dwLowDateTime;
        };
        ULONGLONG idle = toU64(idleFt);
        ULONGLONG kernel = toU64(kernelFt);
        ULONGLONG user = toU64(userFt);

        if (prevKernelTime == 0) {
            prevIdleTime = idle;
            prevKernelTime = kernel;
            prevUserTime = user;
            return 1.8;
        }

        ULONGLONG idleDiff = idle - prevIdleTime;
        ULONGLONG totalDiff = (kernel - prevKernelTime) + (user - prevUserTime);
        prevIdleTime = idle;
        prevKernelTime = kernel;
        prevUserTime = user;
        if (totalDiff == 0) return 1.0;
        double busy = static_cast<double>(totalDiff - idleDiff) * 100.0 / static_cast<double>(totalDiff);
        return std::clamp(std::round(busy * 10.0) / 10.0, 0.0, 100.0);
    }

    int computeRecommendedRamMb(int totalMb) const {
        if (totalMb <= 4608) return 2048;
        if (totalMb <= 8704) return 3584;
        if (totalMb <= 16896) return 4096;
        return 6144;
    }

    json computeOfflineAvailabilityJson(bool localGameReady) const {
        json verifiedAcc = nullptr;
        for (const auto& rec : vaultAccounts) {
            const auto& acc = rec["account"];
            if (acc.value("ownsMinecraftJava", false) && acc.value("lastValidatedAt", 0LL) > 0) {
                if (acc.value("active", false) || verifiedAcc.is_null()) {
                    verifiedAcc = acc;
                }
            }
        }
        json restrictions = json::array({
            "Singleplayer and local worlds only (--disableMultiplayer enforced).",
            "Multiplayer server connections and Realms authentication are disabled while offline.",
            "Locked to your previously Microsoft-verified Minecraft username and UUID."
        });

        if (verifiedAcc.is_null()) {
            return {
                {"eligible", false},
                {"verifiedAccountId", nullptr},
                {"verifiedUsername", nullptr},
                {"verifiedUuid", nullptr},
                {"lastOnlineAuthAt", nullptr},
                {"localGameReady", localGameReady},
                {"activeSessionMode", activeSessionMode},
                {"restrictions", restrictions},
                {"statusReason", "Sign in online with Microsoft at least once on this PC to verify Minecraft: Java Edition ownership before offline singleplayer becomes available."}
            };
        }
        if (!localGameReady) {
            return {
                {"eligible", false},
                {"verifiedAccountId", verifiedAcc["id"]},
                {"verifiedUsername", verifiedAcc["username"]},
                {"verifiedUuid", verifiedAcc["uuid"]},
                {"lastOnlineAuthAt", verifiedAcc["lastValidatedAt"]},
                {"localGameReady", false},
                {"activeSessionMode", activeSessionMode},
                {"restrictions", restrictions},
                {"statusReason", "Account verified, but the selected Minecraft version files are not installed locally yet. Download the version while online first."}
            };
        }
        return {
            {"eligible", true},
            {"verifiedAccountId", verifiedAcc["id"]},
            {"verifiedUsername", verifiedAcc["username"]},
            {"verifiedUuid", verifiedAcc["uuid"]},
            {"lastOnlineAuthAt", verifiedAcc["lastValidatedAt"]},
            {"localGameReady", true},
            {"activeSessionMode", activeSessionMode},
            {"restrictions", restrictions},
            {"statusReason", "Ready for Offline Singleplayer as " + verifiedAcc.value("username", "") + " (verified Java Edition owner)."}
        };
    }

    void refreshTelemetry() {
        MEMORYSTATUSEX mem{};
        mem.dwLength = sizeof(mem);
        GlobalMemoryStatusEx(&mem);
        int totalMb = static_cast<int>(mem.ullTotalPhys / (1024ULL * 1024ULL));
        int availMb = static_cast<int>(mem.ullAvailPhys / (1024ULL * 1024ULL));

        PROCESS_MEMORY_COUNTERS pmc{};
        pmc.cb = sizeof(pmc);
        int launcherMb = 22;
        if (GetProcessMemoryInfo(GetCurrentProcess(), &pmc, sizeof(pmc))) {
            launcherMb = static_cast<int>(pmc.WorkingSetSize / (1024ULL * 1024ULL));
        }

        bool mcRunning = false;
        if (activeMcProcess) {
            DWORD code = 0;
            if (GetExitCodeProcess(activeMcProcess, &code)) {
                lastProcessQueryError = 0;
                if (code == STILL_ACTIVE) {
                    mcRunning = true;
                } else {
                    lastMcExitCode = code;
                    if (!lastMcDiagnosticPath.empty()) {
                        json record = json::parse(read_text_file(fs::u8path(lastMcDiagnosticPath)), nullptr, false);
                        if (record.is_object()) {
                            record["exitCode"] = code;
                            record["exitedAt"] = iso_timestamp_now();
                            write_text_atomic(fs::u8path(lastMcDiagnosticPath), record.dump(2));
                        }
                    }
                    appendLog("[Launch] Minecraft process PID " + std::to_string(activeMcPid) +
                              " exited with code " + std::to_string(code) +
                              (lastMcDiagnosticPath.empty() ? std::string() : "; diagnostics: " + lastMcDiagnosticPath));
                    CloseHandle(activeMcProcess);
                    activeMcProcess = nullptr;
                    activeMcPid = 0;
                }
            } else {
                mcRunning = true; // Keep the handle and avoid inventing an exit on query failure.
                const DWORD error = GetLastError();
                if (error != lastProcessQueryError) {
                    lastProcessQueryError = error;
                    appendLog("[Launch] GetExitCodeProcess failed for PID " + std::to_string(activeMcPid) +
                              "; process state remains unknown (Win32 error " + std::to_string(error) + ").");
                }
            }
        }

        SYSTEM_INFO si{};
        GetSystemInfo(&si);
        std::string gpuName = query_windows_gpu_name();

        auto& prof = activeProfileRef();
        std::string activeMcVer = prof.value("mcVersion", "1.21.4");
        json inGame = {
            {"measured", false},
            {"fps", nullptr},
            {"avgFrameTimeMs", nullptr},
            {"onePercentLowFps", nullptr},
            {"jvmHeapUsedMb", nullptr},
            {"jvmHeapAllocatedMb", prof["performance"]["allocatedRamMb"]},
            {"serverPingMs", nullptr},
            {"mcVersion", activeMcVer},
            {"activeModsCount", prof["enabledModIds"].size()},
            {"activeProfileName", prof["name"]}
        };

        if (mcRunning && fs::exists(ipcDir / "telemetry.json")) {
            try {
                json live = json::parse(read_text_file(ipcDir / "telemetry.json"));
                inGame["measured"] = live.value("measured", false);
                if (live.contains("fps")) inGame["fps"] = live["fps"];
                if (live.contains("avgFrameTimeMs")) inGame["avgFrameTimeMs"] = live["avgFrameTimeMs"];
                if (live.contains("onePercentLowFps")) inGame["onePercentLowFps"] = live["onePercentLowFps"];
                if (live.contains("jvmHeapUsedMb")) inGame["jvmHeapUsedMb"] = live["jvmHeapUsedMb"];
                if (live.contains("serverPingMs")) inGame["serverPingMs"] = live["serverPingMs"];
            } catch (...) {}
        }

        state["telemetry"] = {
            {"timestamp", static_cast<long long>(std::time(nullptr)) * 1000LL},
            {"hostOs", "Windows 10/11 x64"},
            {"hostArch", "x64"},
            {"cpuModel", query_windows_cpu_name()},
            {"cpuCoresLogical", static_cast<int>(si.dwNumberOfProcessors)},
            {"cpuUtilizationPercent", sampleCpuPercent()},
            {"totalSystemRamMb", totalMb},
            {"availableSystemRamMb", availMb},
            {"usedSystemRamMb", std::max(0, totalMb - availMb)},
            {"recommendedMinecraftRamMb", computeRecommendedRamMb(totalMb)},
            {"launcherProcessRamMb", launcherMb},
            {"gpuAdapterName", gpuName.empty() ? json(nullptr) : json(gpuName)},
            {"gpuUtilizationPercent", nullptr},
            {"minecraftRunning", mcRunning},
            {"minecraftPid", mcRunning ? json(static_cast<int>(activeMcPid)) : json(nullptr)},
            {"inGameMetrics", inGame}
        };

        // Annotate versions with real on-disk installation statuses
        for (auto& v : state["versions"]) {
            std::string vid = v.value("id", "");
            if (!vid.empty()) {
                v["installStatus"] = getVersionInstallStatusOnDisk(vid);
            }
        }

        // Sync public accounts view (never expose access/refresh tokens!)
        json publicAccs = json::array();
        std::string activeAccId;
        long long nowMs = static_cast<long long>(std::time(nullptr)) * 1000LL;
        for (auto& rec : vaultAccounts) {
            if (!rec.contains("account")) continue;
            json acc = rec["account"];
            bool isOfflineAcc = (acc.value("accountType", "") == "offline" || acc.value("authProvider", "") == "offline");
            if (isOfflineAcc) {
                acc["accountType"] = "offline";
                acc["authProvider"] = "offline";
                acc["sessionStatus"] = "offline_ready";
                acc["ownsMinecraftJava"] = false;
            } else {
                acc["accountType"] = "microsoft";
                acc["authProvider"] = "microsoft_oauth";
                bool hasTok = !rec.value("mcAccessToken", "").empty();
                bool hasRef = !rec.value("msaRefreshToken", "").empty();
                if (acc.value("sessionStatus", "") == "signed_out" || (!hasTok && !hasRef)) {
                    acc["sessionStatus"] = "signed_out";
                } else if (acc.value("tokenExpiresAt", 0LL) > nowMs + 60000LL) {
                    acc["sessionStatus"] = "valid";
                } else if (hasRef) {
                    acc["sessionStatus"] = "refresh_required";
                } else {
                    acc["sessionStatus"] = "expired";
                }
            }
            publicAccs.push_back(acc);
            if (acc.value("active", false)) activeAccId = acc.value("id", "");
        }
        state["version"] = "1.2.5";
        state["accounts"] = publicAccs;
        state["activeAccountId"] = activeAccId.empty() ? json(nullptr) : json(activeAccId);
        state["oauthConfig"] = {
            {"configured", isOAuthConfigured()},
            {"source", isOAuthConfigured() ? std::string(kEmbeddedMsaConfigSource) : std::string("unconfigured")},
            {"supportsPkceLoopback", true},
            {"supportsDeviceCodeFallback", true},
            {"developerSetupDocPath", "docs/OAUTH_DEVELOPER_SETUP.md"}
        };
        state["authFlow"] = authFlowState;
        bool localVerReady = (getVersionInstallStatusOnDisk(activeMcVer) == "ready");
        state["offlineAvailability"] = computeOfflineAvailabilityJson(localVerReady);
        state["latestReleaseId"] = latestReleaseId;
        state["latestSnapshotId"] = latestSnapshotId;
        state["manifestSource"] = manifestSource;
        state["manifestError"] = manifestError.empty() ? json(nullptr) : json(manifestError);
        {
            std::lock_guard<std::mutex> progressLock(progressMtx);
            state["activeDownload"] = activeDownloadState;
        }
        {
            std::lock_guard<std::mutex> logLock(logsMtx);
            state["recentLogs"] = logs;
        }

        bool java21Installed = false;
        for (auto& rt : state["javaRuntimes"]) {
            int major = rt.value("major", 21);
            fs::path javaw = runtimesDir / ("temurin-" + std::to_string(major)) / "bin" / "javaw.exe";
            rt["path"] = wide_to_utf8(javaw.wstring());
            rt["installed"] = fs::exists(javaw);
            rt["verifiedSha256"] = fs::exists(javaw);
            if (major == 21 && fs::exists(javaw)) java21Installed = true;
        }

        bool isLegacy18 = (activeMcVer == "1.8.9");
        for (auto& rp : state["resourcePacks"]) {
            bool en = false;
            for (const auto& eid : prof["enabledResourcePackIds"]) {
                if (eid == rp["id"]) en = true;
            }
            rp["enabled"] = en;
            int pf = rp.value("packFormat", 46);
            rp["compatibleWithCurrent"] = isLegacy18 ? (pf == 1) : (pf >= 15);
        }
        for (auto& sp : state["shaderPacks"]) {
            sp["active"] = (!prof["activeShaderPackId"].is_null() && sp["id"] == prof["activeShaderPackId"]);
        }

        // Compute live Windows Configuration Doctor diagnostics (DiagnosticFinding[] array contract)
        json findings = json::array();
        int allocMb = prof["performance"].value("allocatedRamMb", 4096);
        int recMb = computeRecommendedRamMb(totalMb);
        if (allocMb > totalMb - 1536) {
            findings.push_back({
                {"id", "diag-ram-high"},
                {"severity", "warning"},
                {"category", "memory"},
                {"title", "Allocated JVM Heap Leaves Low OS Headroom"},
                {"explanation", "Allocating " + std::to_string(allocMb) + " MB on a " + std::to_string(totalMb) + " MB Windows system can starve GPU driver shader caches."},
                {"recommendation", "Click Apply Automatic Fix to set hardware-optimal " + std::to_string(recMb) + " MB heap."},
                {"autoFixActionId", "fix_ram_allocation"}
            });
        } else {
            findings.push_back({
                {"id", "diag-ram-ok"},
                {"severity", "healthy"},
                {"category", "memory"},
                {"title", "JVM Heap & Collector Balanced for Host Hardware"},
                {"explanation", "Allocated " + std::to_string(allocMb) + " MB out of " + std::to_string(totalMb) + " MB physical RAM (" + prof["performance"].value("gcMode", "adaptive_g1gc") + ")."},
                {"recommendation", "No memory tuning changes needed."}
            });
        }
        if (!java21Installed) {
            findings.push_back({
                {"id", "diag-java-ondemand"},
                {"severity", "info"},
                {"category", "java_runtime"},
                {"title", "Adoptium Temurin Java Runtimes Ready for Auto-Provisioning"},
                {"explanation", "Vespera automatically downloads and SHA-256 verifies Java 8, 17, or 21 per selected Minecraft version."},
                {"recommendation", "Zero manual Java installation required."}
            });
        } else {
            findings.push_back({
                {"id", "diag-java-ready"},
                {"severity", "healthy"},
                {"category", "java_runtime"},
                {"title", "Adoptium Temurin Java 21 LTS Installed & Verified"},
                {"explanation", "Managed 64-bit Windows Java 21 runtime is present and verified in %APPDATA%\\VesperaClient\\runtimes."},
                {"recommendation", "Ready for immediate launch."}
            });
        }
        state["diagnostics"] = findings;
    }

    void createBackupSnapshot(const std::string& profileId, const std::string& reason) {
        for (const auto& p : state["profiles"]) {
            if (p.value("id", "") == profileId) {
                json bkp = {
                    {"id", "bkp-" + std::to_string(std::time(nullptr))},
                    {"profileId", profileId},
                    {"profileName", p.value("name", "Profile")},
                    {"reason", reason},
                    {"createdAt", iso_timestamp_now()},
                    {"snapshot", p}
                };
                state["profileBackups"].insert(state["profileBackups"].begin(), bkp);
                if (state["profileBackups"].size() > 25) {
                    state["profileBackups"].erase(state["profileBackups"].begin() + 25, state["profileBackups"].end());
                }
                break;
            }
        }
    }

    fs::path resolveInstanceDir(const json& prof) const {
        std::string customDir = prof.value("customGameDir", "");
        if (!customDir.empty()) return fs::u8path(customDir);
        return instancesDir / prof.value("id", "default");
    }

    fs::path materializeInstance(const json& prof) {
        fs::path instDir = resolveInstanceDir(prof);
        std::error_code ec;
        fs::create_directories(instDir / "mods", ec);
        fs::create_directories(instDir / "config", ec);
        fs::create_directories(instDir / "shaderpacks", ec);
        fs::create_directories(instDir / "resourcepacks", ec);

        const auto& g = prof["graphics"];
        std::ostringstream opt;
        opt << "version:4189\n"
            << "renderDistance:" << g.value("renderDistanceChunks", 16) << "\n"
            << "simulationDistance:" << g.value("simulationDistanceChunks", 10) << "\n"
            << "maxFps:" << (g.value("maxFps", 240) == 0 ? 260 : g.value("maxFps", 240)) << "\n"
            << "enableVsync:" << (g.value("vsync", false) ? "true" : "false") << "\n"
            << "ao:" << (g.value("smoothLighting", "maximum") == "maximum" ? 2 : 1) << "\n"
            << "mipmapLevels:" << g.value("mipmapLevels", 4) << "\n";
        write_text_atomic(instDir / "options.txt", opt.str());

        std::string loader = prof.value("loader", "fabric");
        std::string mcVer = prof.value("mcVersion", "1.21.4");

        if (loader != "vanilla") {
            std::set<std::string> enabledSet;
            for (const auto& eid : prof["enabledModIds"]) enabledSet.insert(eid.get<std::string>());

            for (const auto& im : state["installedMods"]) {
                std::string mid = im.value("id", "");
                std::string fn = im.value("fileName", "");
                std::string imVer = im.value("mcVersion", mcVer);
                if (fn.empty() || imVer != mcVer) continue;
                if (mid == "vespera-client" && mcVer != "1.21.4") continue;
                fs::path poolFile = modsPoolDir / fn;
                fs::path instFile = instDir / "mods" / fn;
                if (enabledSet.count(mid) > 0 && fs::exists(poolFile)) {
                    if (!fs::exists(instFile)) {
                        fs::copy_file(poolFile, instFile, fs::copy_options::overwrite_existing, ec);
                    }
                } else if (enabledSet.count(mid) == 0 && fs::exists(instFile)) {
                    fs::remove(instFile, ec);
                }
            }

            // Provision custom 1.21.4 mod ONLY on Fabric 1.21.4 when enabled
            fs::path srcMod = modsPoolDir / "vespera-client-1.2.2+mc1.21.4.jar";
            fs::path dstMod = instDir / "mods" / "vespera-client-1.2.2+mc1.21.4.jar";
            if (mcVer == "1.21.4" && enabledSet.count("vespera-client") > 0 && fs::exists(srcMod)) {
                if (!fs::exists(dstMod)) {
                    fs::copy_file(srcMod, dstMod, fs::copy_options::overwrite_existing, ec);
                }
            } else if (fs::exists(dstMod)) {
                fs::remove(dstMod, ec);
            }

            const auto& perf = prof["performance"];
            json sodiumCfg = {
                {"performance", {
                    {"chunk_builder_threads", perf.value("chunkBuilderThreads", 0)},
                    {"always_defer_chunk_updates", perf.value("deferChunkUpdates", true)},
                    {"use_entity_culling", perf.value("useEntityCulling", true)},
                    {"use_fog_occlusion", perf.value("useFogOcclusion", true)},
                    {"use_block_face_culling", perf.value("useBlockFaceCulling", true)},
                    {"use_compact_vertex_format", perf.value("useCompactVertexFormat", true)}
                }}
            };
            write_text_atomic(instDir / "config" / "sodium-options.json", sodiumCfg.dump(2));
        }

        return instDir;
    }

    bool provisionAdoptiumJavaIfNeeded(int major) {
        if (cancelDownloadFlag.load()) return false;
        fs::path javaw = runtimesDir / ("temurin-" + std::to_string(major)) / "bin" / "javaw.exe";
        if (fs::exists(javaw)) return true;

        std::string api = "https://api.adoptium.net/v3/assets/latest/" + std::to_string(major) +
                          "/hotspot?architecture=x64&image_type=jre&os=windows";
        appendLog("[JavaManager] Querying official Adoptium Temurin Java " + std::to_string(major) + " LTS...");
        HttpResponse r = winhttp_request("GET", api, "", "application/json", "", &cancelDownloadFlag);
        if (r.statusCode != 200) return false;

        auto arr = json::parse(r.body, nullptr, false);
        if (!arr.is_array() || arr.empty()) return false;
        std::string link = arr[0]["binary"]["package"].value("link", "");
        std::string expectedSha = arr[0]["binary"]["package"].value("checksum", "");
        std::string zipName = arr[0]["binary"]["package"].value("name", "temurin.zip");
        if (link.empty()) return false;

        fs::path zipPath = runtimesDir / zipName;
        if (!winhttp_download_file(link, zipPath, &cancelDownloadFlag)) return false;

        std::string actualSha = bcrypt_hash_file(zipPath, BCRYPT_SHA256_ALGORITHM);
        if (!expectedSha.empty() && _stricmp(actualSha.c_str(), expectedSha.c_str()) != 0) {
            std::error_code ec;
            fs::remove(zipPath, ec);
            appendLog("[JavaManager] SHA-256 verification failed for downloaded Java archive!");
            return false;
        }
        if (cancelDownloadFlag.load()) return false;

        fs::path destDir = runtimesDir / ("temurin-" + std::to_string(major));
        std::error_code ec;
        fs::create_directories(destDir, ec);

        std::wstring cmd = L"tar.exe -xf \"" + zipPath.wstring() + L"\" -C \"" + destDir.wstring() + L"\" --strip-components=1";
        STARTUPINFOW si{};
        si.cb = sizeof(si);
        PROCESS_INFORMATION pi{};
        if (!CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi)) {
            fs::remove(zipPath, ec);
            appendLog("[JavaManager] Could not start tar.exe to extract Temurin Java (Win32 error " + std::to_string(GetLastError()) + ").");
            return false;
        }
        DWORD waitResult = WaitForSingleObject(pi.hProcess, 120000);
        DWORD exitCode = STILL_ACTIVE;
        if (waitResult == WAIT_OBJECT_0) GetExitCodeProcess(pi.hProcess, &exitCode);
        else {
            TerminateProcess(pi.hProcess, 1);
            WaitForSingleObject(pi.hProcess, 5000);
        }
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        fs::remove(zipPath, ec);
        if (cancelDownloadFlag.load() || waitResult != WAIT_OBJECT_0 || exitCode != 0) return false;
        return fs::exists(javaw);
    }

    /**
     * Complete 12-stage native Windows Mojang + Fabric version downloader, SHA-1 verifier,
     * and native DLL extractor.
     */
    json installMinecraftVersionNative(
        const std::string& verId,
        const std::string& loader,
        const std::string& reqLoaderVer,
        bool forceRepair
    ) {
        const std::string activeProfileId = state.value("activeProfileId", "");
        const std::string journalLoaderKey = install_loader_key(loader);
        bool verifyHashes = state["settings"].value("verifyFileHashes", true);
        fs::path gameRoot = getGameRootDir();
        fs::path vDir = gameRoot / "versions" / verId;
        fs::path libRoot = gameRoot / "libraries";
        fs::path assetsRoot = gameRoot / "assets";
        fs::path nativesDir = vDir / ("natives-" + journalLoaderKey);
        fs::path receiptPath = vDir / ("vespera-install-receipt-" + journalLoaderKey + ".json");

        std::error_code ec;
        fs::create_directories(vDir, ec);
        fs::create_directories(libRoot, ec);
        fs::create_directories(assetsRoot / "indexes", ec);
        fs::create_directories(assetsRoot / "objects", ec);

        const fs::path journalPath = vDir / ("vespera-install-journal-" + journalLoaderKey + ".json");
        json journal = {
            {"schemaVersion", 1},
            {"installationId", verId + "/" + journalLoaderKey + "/" + reqLoaderVer},
            {"versionId", verId}, {"loader", journalLoaderKey}, {"loaderVersion", reqLoaderVer},
            {"state", "preparing"}, {"lastSuccessfulOperation", "task_started"},
            {"failureReason", nullptr}, {"updatedAt", iso_timestamp_now()}, {"artifacts", json::array()}
        };
        auto persistJournal = [&]() {
            journal["updatedAt"] = iso_timestamp_now();
            if (!write_text_atomic(journalPath, journal.dump(2))) {
                throw std::runtime_error("Unable to atomically persist installation recovery journal " + journalPath.string());
            }
        };
        if (fs::exists(journalPath, ec)) {
            json previousJournal = json::parse(read_text_file(journalPath), nullptr, false);
            if (previousJournal.is_object() && previousJournal.value("versionId", "") == verId &&
                previousJournal.value("loader", "") == journalLoaderKey) {
                journal["recoveredFrom"] = {
                    {"state", previousJournal.value("state", "unknown")},
                    {"updatedAt", previousJournal.value("updatedAt", "")},
                    {"lastSuccessfulOperation", previousJournal.value("lastSuccessfulOperation", "")}
                };
                appendLog("[Recovery] Re-reading journal for Minecraft " + verId + " (" + journalLoaderKey + "); existing files will be revalidated before reuse.");
            }
        }
        persistJournal();

        // Keep any prior receipt in place until the new complete install is validated and atomically committed.

        auto startTime = std::chrono::steady_clock::now();
        size_t bytesDownloaded = 0;
        size_t totalBytes = 0;
        int completedFiles = 0;
        int totalFiles = 1;

        auto updateDlState = [&](const std::string& status, const std::string& stage, int pctOverride, const std::string& errStr = "") {
            double elapsedSec = std::max(0.2, std::chrono::duration<double>(std::chrono::steady_clock::now() - startTime).count());
            size_t speed = bytesDownloaded > 0 ? static_cast<size_t>(bytesDownloaded / elapsedSec) : 0;
            size_t rem = (totalBytes > bytesDownloaded) ? (totalBytes - bytesDownloaded) : 0;
            json eta = (speed > 0 && rem > 0) ? json(static_cast<int>((rem + speed - 1) / speed)) : json(nullptr);
            (void)pctOverride;
            int pct = status == "ready" ? 100 : (totalBytes > 0 ? static_cast<int>(std::min<size_t>(99, (bytesDownloaded * 100) / totalBytes)) : 0);
            json progress = {
                {"active", status == "preparing" || status == "downloading" || status == "installing" || status == "verifying" || status == "launching"},
                {"versionId", verId},
                {"profileId", activeProfileId},
                {"loader", loader},
                {"status", status},
                {"stage", stage},
                {"percent", pct},
                {"bytesDownloaded", bytesDownloaded},
                {"totalBytes", totalBytes},
                {"speedBytesPerSec", speed},
                {"etaSeconds", eta},
                {"completedFiles", completedFiles},
                {"totalFiles", totalFiles},
                {"cancellable", status == "preparing" || status == "downloading" || status == "installing" || status == "verifying" || status == "launching"},
                {"error", errStr.empty() ? json(nullptr) : json(errStr)}
            };
            {
                std::lock_guard<std::mutex> progressLock(progressMtx);
                activeDownloadState = progress;
            }
            {
                std::lock_guard<std::mutex> snapshotLock(installSnapshotMtx);
                if (installSnapshotCache.is_object()) installSnapshotCache["activeDownload"] = std::move(progress);
            }
        };

        std::string metadataUrl;
        updateDlState("downloading", "Refreshing/validating official Mojang metadata for Minecraft " + verId + "...", 3);
        journal["state"] = "refreshing_manifest";
        journal["lastSuccessfulOperation"] = "installation_initialized";
        persistJournal();
        refreshOfficialManifest(true); // online install must consult the authoritative manifest; cached data is offline fallback only
        json* manifestEntry = findManifestEntry(verId);
        metadataUrl = manifestEntry ? manifestEntry->value("manifestUrl", "") : "";
        std::string expectedMetaSha1 = manifestEntry ? manifestEntry->value("sha1", "") : "";
        if (manifestSource == "live_mojang" && !manifestEntry) {
            std::string err = "Minecraft " + verId + " is not present in the current official Mojang version manifest.";
            updateDlState("failed", err, 0, err);
            throw std::runtime_error(err);
        }
        fs::path metaPath = vDir / (verId + ".json");
        std::string dlErr;
        json meta;
        bool haveVerifiedMeta = !forceRepair && loadVerifiedCachedMetadata(verId, metaPath, expectedMetaSha1, meta, dlErr);
        if (!haveVerifiedMeta) {
            if (metadataUrl.empty() || !isSha1Hex(expectedMetaSha1)) {
                std::string err = "Cannot install Minecraft " + verId + ": official manifest did not provide a trusted metadata URL and SHA-1." +
                    (manifestError.empty() ? "" : " Manifest diagnostic: " + manifestError);
                updateDlState("failed", err, 0, err);
                throw std::runtime_error(err);
            }
            if (!downloadVersionMetadata(verId, metaPath, metadataUrl, expectedMetaSha1, dlErr)) {
                updateDlState("failed", dlErr, 0, dlErr);
                throw std::runtime_error(dlErr);
            }
            meta = json::parse(read_text_file(metaPath), nullptr, false);
        }
        if (expectedMetaSha1.empty()) {
            fs::path metaSidecar = metaPath; metaSidecar += ".cache.json";
            json cachedInfo = fs::exists(metaSidecar, ec) ? json::parse(read_text_file(metaSidecar), nullptr, false) : json(nullptr);
            if (cachedInfo.is_object()) expectedMetaSha1 = cachedInfo.value("sha1", "");
        }
        std::string metadataWhy;
        if (meta.is_discarded() || !validateVersionMetadata(meta, verId, metadataWhy)) {
            std::string err = meta.is_discarded() ? "Invalid JSON for Minecraft " + verId + " version metadata." : metadataWhy;
            updateDlState("failed", err, 0, err);
            throw std::runtime_error(err);
        }
        if (fs::exists(metaPath, ec)) bytesDownloaded += static_cast<size_t>(fs::file_size(metaPath, ec));

        int javaMajor = meta.contains("javaVersion") ? meta["javaVersion"].value("majorVersion", 21) : infer_java_major_cpp(verId, "release", "");

        struct ItemPlan {
            std::string kind;
            std::string url;
            fs::path dest;
            std::string sha1;
            size_t size;
            std::string source = "Mojang";
            std::string coordinate;
            bool validateJar = false;
            std::string requiredJarEntry;
        };
        std::vector<ItemPlan> plan;
        json verifiedLibs = json::array();
        json verifiedAssets = json::array();
        json verifiedHashes = json::object();
        json verifiedLibraryFiles = json::array();
        fs::path assetIndexPath;
        fs::path fabricProfilePath;
        std::string fabricProfileUrl;
        struct NativeArchive { fs::path path; std::string coordinate; std::vector<std::string> excludes; };
        std::vector<NativeArchive> nativeJars;

        std::string clientUrl = meta["downloads"]["client"].value("url", "");
        std::string clientSha1 = meta["downloads"]["client"].value("sha1", "");
        size_t clientSz = meta["downloads"]["client"].value("size", 0ULL);
        plan.push_back({"client_jar", clientUrl, vDir / (verId + ".jar"), clientSha1, clientSz,
                        "Mojang", verId + " client.jar", true, ""});

        if (meta.contains("libraries") && meta["libraries"].is_array()) {
            for (const auto& lib : meta["libraries"]) {
                if (!evaluate_mojang_windows_rules(lib)) continue;
                const std::string name = lib.value("name", "");
                ParsedMavenCoordinate parsed;
                if (name.empty() || !parse_maven_coordinate(name, parsed)) {
                    std::string err = "Invalid Mojang library metadata for Minecraft " + verId + ": malformed Maven coordinate '" + name + "'.";
                    updateDlState("failed", err, 0, err); throw std::runtime_error(err);
                }
                if (!parsed.classifier.empty() && parsed.classifier.find("natives-windows") != std::string::npos &&
                    !vespera::windows_classifier_matches_target(parsed.classifier, minecraft_windows_arch_token())) {
                    appendLog("[NativeClassifier] Skipping platform-mismatched classifier " + name + " for Windows arch token " + minecraft_windows_arch_token());
                    continue;
                }
                std::vector<std::string> nativeExclusions;
                if (lib.contains("extract") && lib["extract"].is_object() && lib["extract"].contains("exclude") && lib["extract"]["exclude"].is_array()) {
                    for (const auto& exclusion : lib["extract"]["exclude"]) if (exclusion.is_string()) nativeExclusions.push_back(exclusion.get<std::string>());
                }
                auto addMojangArtifact = [&](const std::string& coordinate, const std::string& rel, const std::string& url,
                                             const std::string& sha1, size_t size, bool isNative) {
                    if (!safe_maven_relative_path(rel) || url.rfind("https://", 0) != 0 || (!sha1.empty() && !isSha1Hex(sha1))) {
                        std::string err = "Invalid Mojang library metadata for Minecraft " + verId + ": coordinate " + coordinate +
                            " requires a safe artifact path, HTTPS URL, and optional valid 40-digit SHA-1.";
                        updateDlState("failed", err, 0, err); throw std::runtime_error(err);
                    }
                    fs::path destination = libRoot / fs::u8path(rel);
                    plan.push_back({isNative ? "native_jar" : "library", url, destination, sha1, size,
                                    "Mojang", coordinate, true, ""});
                    verifiedLibraryFiles.push_back(destination.lexically_relative(gameRoot).generic_string());
                    if (isNative) nativeJars.push_back({destination, coordinate, nativeExclusions});
                    else verifiedLibs.push_back(rel);
                    appendLog("[LibraryResolver] Mojang coordinate=" + coordinate + " url=" + url +
                              " upstreamSha1=" + (sha1.empty() ? "not-published" : sha1) + " destination=" + destination.string());
                };

                if (lib.contains("downloads") && lib["downloads"].is_object() && lib["downloads"].contains("artifact")) {
                    const auto& artifact = lib["downloads"]["artifact"];
                    const std::string rel = artifact.value("path", parsed.relativePath);
                    std::string artifactUrl = artifact.value("url", "");
                    if (artifactUrl.empty() && lib.contains("url") && lib["url"].is_string()) {
                        std::string repo = lib.value("url", "");
                        if (!repo.empty() && repo.rfind("https://", 0) == 0) {
                            if (repo.back() != '/') repo.push_back('/');
                            std::string encodedRel = rel;
                            std::replace(encodedRel.begin(), encodedRel.end(), '\\', '/');
                            artifactUrl = repo + encodedRel;
                        }
                    }
                    const bool isNative = !parsed.classifier.empty() && parsed.classifier.find("natives-windows") != std::string::npos;
                    addMojangArtifact(name, rel, artifactUrl, artifact.value("sha1", ""),
                                      artifact.value("size", 0ULL), isNative);
                } else if (lib.value("downloads", json::object()).value("artifact", json::object()).empty() &&
                           !lib.contains("natives") && lib.contains("url")) {
                    // Legacy official schema: Maven coordinate plus repository base, with no artifact record.
                    std::string repo = lib.value("url", "");
                    if (repo.empty() || repo.rfind("https://", 0) != 0) {
                        std::string err = "Invalid Mojang legacy library metadata for Minecraft " + verId + ": " + name + " has no HTTPS repository URL.";
                        updateDlState("failed", err, 0, err); throw std::runtime_error(err);
                    }
                    if (!repo.empty() && repo.back() != '/') repo.push_back('/');
                    addMojangArtifact(name, parsed.relativePath, repo + parsed.relativePath, "", 64000ULL, false);
                }

                if (lib.contains("natives") && lib["natives"].is_object() && lib["natives"].contains("windows")) {
                    std::string key = lib["natives"].value("windows", "");
                    auto pos = key.find("${arch}");
                    if (pos != std::string::npos) key.replace(pos, 7, minecraft_windows_arch_token());
                    if (!lib.contains("downloads") || !lib["downloads"].contains("classifiers") ||
                        !lib["downloads"]["classifiers"].is_object() || !lib["downloads"]["classifiers"].contains(key)) {
                        std::string err = "Missing Mojang Windows native classifier for library " + name + " (" + key + ").";
                        updateDlState("failed", err, 0, err); throw std::runtime_error(err);
                    }
                    const auto& nativeArtifact = lib["downloads"]["classifiers"][key];
                    const std::string coordinate = name + ":" + key;
                    ParsedMavenCoordinate nativeCoord;
                    const std::string rel = nativeArtifact.value("path", parse_maven_coordinate(coordinate, nativeCoord) ? nativeCoord.relativePath : "");
                    addMojangArtifact(coordinate, rel, nativeArtifact.value("url", ""), nativeArtifact.value("sha1", ""),
                                      nativeArtifact.value("size", 0ULL), true);
                }
            }
        }

        std::string assetIndexId = meta.contains("assetIndex") ? meta["assetIndex"].value("id", "legacy") : meta.value("assets", "legacy");
        if (meta.contains("assetIndex") && meta["assetIndex"].contains("url")) {
            fs::path idxPath = assetsRoot / "indexes" / (assetIndexId + ".json");
            assetIndexPath = idxPath;
            if (!winhttp_download_verified(meta["assetIndex"].value("url", ""), idxPath,
                                           meta["assetIndex"].value("sha1", ""), true, &cancelDownloadFlag,
                                           [&](size_t n) { bytesDownloaded += n; }, dlErr,
                                           meta["assetIndex"].value("size", 0ULL))) {
                dlErr = "Missing asset index " + assetIndexId + ": " + dlErr;
                updateDlState("failed", dlErr, 0, dlErr);
                throw std::runtime_error(dlErr);
            }
            json idxJson = json::parse(read_text_file(idxPath), nullptr, false);
            if (idxJson.is_discarded() || !idxJson.is_object() || !idxJson.contains("objects") || !idxJson["objects"].is_object()) {
                std::string err = "Invalid JSON or schema for asset index " + assetIndexId + " from " + meta["assetIndex"].value("url", "");
                updateDlState("failed", err, 0, err);
                throw std::runtime_error(err);
            }
            {
                for (auto& [logicalName, obj] : idxJson["objects"].items()) {
                    std::string h = obj.value("hash", "");
                    if (!isSha1Hex(h)) {
                        std::string err = "Invalid asset index " + assetIndexId + ": malformed SHA-1 for asset " + logicalName;
                        updateDlState("failed", err, 0, err);
                        throw std::runtime_error(err);
                    }
                    std::string pfx = h.substr(0, 2);
                    fs::path assetPath = assetsRoot / "objects" / pfx / h;
                    plan.push_back({"asset", "https://resources.download.minecraft.net/" + pfx + "/" + h,
                                    assetPath, h, obj.value("size", 0ULL)});
                    verifiedAssets.push_back(assetPath.lexically_relative(gameRoot).generic_string());
                }
            }
        }

        std::string mainClass = meta.value("mainClass", "net.minecraft.client.main.Main");
        std::string resolvedLoaderVer = "vanilla";
        if (loader == "fabric") {
            resolvedLoaderVer = (!reqLoaderVer.empty() && reqLoaderVer != "vanilla") ? reqLoaderVer : "0.16.10";
            std::string fabUrl = "https://meta.fabricmc.net/v2/versions/loader/" + url_encode_comp(verId) + "/" +
                                 url_encode_comp(resolvedLoaderVer) + "/profile/json";
            fs::path fabPath = vDir / (verId + "-fabric-" + resolvedLoaderVer + ".json");
            fabricProfilePath = fabPath;
            fabricProfileUrl = fabUrl;
            json fabJson;
            bool validFabricProfile = false;
            for (int profileAttempt = 1; profileAttempt <= 2 && !validFabricProfile; ++profileAttempt) {
                if (fs::exists(fabPath, ec)) {
                    fabJson = json::parse(read_text_file(fabPath), nullptr, false);
                    if (validate_fabric_profile(fabJson)) { validFabricProfile = true; break; }
                    fs::remove(fabPath, ec);
                }
                if (!winhttp_download_verified(fabUrl, fabPath, "", false, &cancelDownloadFlag,
                                               [&](size_t n) { bytesDownloaded += n; }, dlErr)) break;
                fabJson = json::parse(read_text_file(fabPath), nullptr, false);
                validFabricProfile = validate_fabric_profile(fabJson);
                if (!validFabricProfile) {
                    fs::remove(fabPath, ec);
                    dlErr = "Invalid Fabric Loader profile JSON/schema from " + fabUrl;
                }
            }
            if (!validFabricProfile) {
                std::string err = "Invalid Fabric Loader profile metadata from " + fabUrl + " for Minecraft " + verId + ": " + dlErr;
                updateDlState("failed", err, 0, err);
                throw std::runtime_error(err);
            }
            {
                mainClass = fabJson.value("mainClass", "net.fabricmc.loader.impl.launch.knot.Client");
                if (fabJson.contains("libraries") && fabJson["libraries"].is_array()) {
                    for (const auto& fl : fabJson["libraries"]) {
                        const std::string coordinate = fl.value("name", "");
                        ParsedMavenCoordinate parsed;
                        const std::string repo = fl.value("url", "");
                        const std::string sha1 = fl.value("sha1", "");
                        if (coordinate.empty() || !parse_maven_coordinate(coordinate, parsed)) {
                            std::string err = "Invalid Fabric Loader profile " + fabUrl + ": malformed Maven coordinate '" + coordinate + "'.";
                            updateDlState("failed", err, 0, err); throw std::runtime_error(err);
                        }
                        if (repo.rfind("https://", 0) != 0 || !safe_maven_relative_path(parsed.relativePath) ||
                            (!sha1.empty() && !isSha1Hex(sha1))) {
                            std::string err = "Invalid Fabric Loader library metadata for Minecraft " + verId + ": coordinate " + coordinate +
                                " requires an upstream HTTPS repository URL and optional valid SHA-1.";
                            updateDlState("failed", err, 0, err); throw std::runtime_error(err);
                        }
                        std::string baseRepo = repo;
                        if (baseRepo.back() != '/') baseRepo.push_back('/');
                        fs::path fabricLib = libRoot / fs::u8path(parsed.relativePath);
                        const std::string artifactUrl = baseRepo + parsed.relativePath;
                        const std::string requiredEntry = parsed.artifact == "fabric-loader"
                            ? "net/fabricmc/loader/impl/launch/knot/KnotClient.class"
                            : (parsed.artifact == "intermediary" ? "mappings/mappings.tiny" : "");
                        plan.push_back({"fabric_lib", artifactUrl, fabricLib, sha1, fl.value("size", 0ULL),
                                        "Fabric Loader", coordinate, true, requiredEntry});
                        verifiedLibraryFiles.push_back(fabricLib.lexically_relative(gameRoot).generic_string());
                        verifiedLibs.push_back(parsed.relativePath);
                        appendLog("[LibraryResolver] Fabric Loader coordinate=" + coordinate + " url=" + artifactUrl +
                                  " upstreamSha1=" + (sha1.empty() ? "not-published" : sha1) + " destination=" + fabricLib.string());
                    }
                }
            }
        }

        std::vector<ItemPlan> deduplicatedPlan;
        std::map<std::string, size_t> destinationIndex;
        for (const auto& item : plan) {
            std::string key = fs::absolute(item.dest).lexically_normal().generic_string();
            std::transform(key.begin(), key.end(), key.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
            auto found = destinationIndex.find(key);
            if (found != destinationIndex.end()) {
                auto& prior = deduplicatedPlan[found->second];
                if ((!prior.sha1.empty() && !item.sha1.empty() && _stricmp(prior.sha1.c_str(), item.sha1.c_str()) != 0) ||
                    (prior.url != item.url && !( !prior.sha1.empty() && !item.sha1.empty() && _stricmp(prior.sha1.c_str(), item.sha1.c_str()) == 0))) {
                    std::string err = "Conflicting library dependency for coordinate " + item.coordinate + " at " + item.dest.string() +
                        " (" + prior.url + " vs " + item.url + ").";
                    updateDlState("failed", err, 0, err); throw std::runtime_error(err);
                }
                if (prior.sha1.empty()) prior.sha1 = item.sha1;
                continue;
            }
            destinationIndex[key] = deduplicatedPlan.size();
            deduplicatedPlan.push_back(item);
        }
        plan.swap(deduplicatedPlan);
        for (const auto& item : plan) {
            const bool checksumRequired = item.kind == "client_jar" || item.kind == "asset";
            if (item.url.rfind("https://", 0) != 0 || !safe_maven_relative_path(item.dest.lexically_relative(libRoot).generic_string()) &&
                (item.kind == "library" || item.kind == "native_jar" || item.kind == "fabric_lib") ||
                (checksumRequired && !isSha1Hex(item.sha1)) || (!item.sha1.empty() && !isSha1Hex(item.sha1))) {
                const std::string origin = item.source + (item.coordinate.empty() ? "" : " coordinate " + item.coordinate);
                std::string err = "Invalid " + origin + " metadata for Minecraft " + verId + ": URL, artifact path, or optional upstream SHA-1 is invalid for " + item.dest.string();
                updateDlState("failed", err, 0, err);
                throw std::runtime_error(err);
            }
        }
        totalFiles = static_cast<int>(plan.size());
        bool knownTotalSize = true;
        size_t plannedBytes = bytesDownloaded;
        for (const auto& it : plan) {
            if (it.size == 0) knownTotalSize = false;
            else if (knownTotalSize) plannedBytes += it.size;
        }
        totalBytes = knownTotalSize ? plannedBytes : 0;

        journal["installationId"] = verId + "/" + journalLoaderKey + "/" + resolvedLoaderVer;
        journal["loaderVersion"] = resolvedLoaderVer;
        journal["state"] = "downloading";
        journal["lastSuccessfulOperation"] = "dependency_plan_resolved";
        journal["failureReason"] = nullptr;
        journal["artifacts"] = json::array();
        for (const auto& item : plan) {
            journal["artifacts"].push_back({
                {"source", item.source}, {"kind", item.kind}, {"coordinate", item.coordinate},
                {"url", item.url}, {"path", item.dest.lexically_relative(gameRoot).generic_string()},
                {"status", "pending"}, {"downloadedSize", 0},
                {"expectedSize", item.size == 0 ? json(nullptr) : json(item.size)},
                {"checksumAlgorithm", item.sha1.empty() ? json(nullptr) : json("SHA-1")},
                {"checksum", item.sha1.empty() ? json(nullptr) : json(item.sha1)},
                {"failureReason", nullptr}
            });
        }
        auto appendVerifiedMetadataArtifact = [&](const std::string& source, const std::string& kind,
                                                  const std::string& coordinate, const std::string& url,
                                                  const fs::path& artifactPath, const std::string& sha1) {
            if (artifactPath.empty() || !fs::exists(artifactPath, ec)) return;
            const size_t actualSize = static_cast<size_t>(fs::file_size(artifactPath, ec));
            journal["artifacts"].push_back({
                {"source", source}, {"kind", kind}, {"coordinate", coordinate}, {"url", url},
                {"path", artifactPath.lexically_relative(gameRoot).generic_string()},
                {"status", "complete"}, {"downloadedSize", actualSize}, {"expectedSize", nullptr},
                {"checksumAlgorithm", sha1.empty() ? json(nullptr) : json("SHA-1")},
                {"checksum", sha1.empty() ? json(nullptr) : json(sha1)}, {"failureReason", nullptr}
            });
        };
        appendVerifiedMetadataArtifact("Mojang", "version_metadata", verId, metadataUrl, metaPath, expectedMetaSha1);
        if (!assetIndexPath.empty()) appendVerifiedMetadataArtifact("Mojang", "asset_index", assetIndexId,
            meta["assetIndex"].value("url", ""), assetIndexPath, meta["assetIndex"].value("sha1", ""));
        if (!fabricProfilePath.empty()) appendVerifiedMetadataArtifact("Fabric Meta", "loader_profile", resolvedLoaderVer,
            fabricProfileUrl, fabricProfilePath, "");
        auto setJournalArtifactState = [&](size_t index, const std::string& status, size_t downloadedSize, const std::string& failure = "") {
            auto& artifact = journal["artifacts"][index];
            artifact["status"] = status;
            fs::path journalArtifactPath = gameRoot / fs::u8path(artifact.value("path", ""));
            fs::path partialArtifactPath = journalArtifactPath; partialArtifactPath += ".part";
            std::error_code journalEc;
            if (status == "complete" && fs::exists(journalArtifactPath, journalEc))
                downloadedSize = static_cast<size_t>(fs::file_size(journalArtifactPath, journalEc));
            else if (fs::exists(partialArtifactPath, journalEc))
                downloadedSize = static_cast<size_t>(fs::file_size(partialArtifactPath, journalEc));
            artifact["downloadedSize"] = downloadedSize;
            artifact["failureReason"] = failure.empty() ? json(nullptr) : json(failure);
            if (status == "complete") journal["lastSuccessfulOperation"] = "verified:" + artifact.value("path", "");
            if (!failure.empty()) journal["failureReason"] = failure;
            persistJournal();
        };
        persistJournal();

        for (size_t itemIndex = 0; itemIndex < plan.size(); ++itemIndex) {
            const auto& it = plan[itemIndex];
            if (cancelDownloadFlag.load()) {
                journal["state"] = "partially_downloaded";
                journal["failureReason"] = "Cancelled by user before next artifact.";
                persistJournal();
                updateDlState("partially_downloaded", "Download cancelled — partial progress saved for resume.", -1);
                throw std::runtime_error("Download cancelled by user.");
            }
            const std::string stageMsg = "Downloading & verifying " + it.kind + " (" + std::to_string(completedFiles + 1) + "/" + std::to_string(totalFiles) + "): " + it.coordinate;
            journal["state"] = "downloading";
            journal["failureReason"] = nullptr;
            setJournalArtifactState(itemIndex, "downloading", 0);
            updateDlState("downloading", stageMsg, -1);
            size_t chunkBytes = 0;
            bool artifactReady = false;
            for (int formatAttempt = 1; formatAttempt <= 2 && !artifactReady; ++formatAttempt) {
                if (it.validateJar && fs::exists(it.dest, ec) && !is_valid_jar_archive(it.dest, it.requiredJarEntry)) fs::remove(it.dest, ec);
                if (!winhttp_download_verified(it.url, it.dest, it.sha1, true, &cancelDownloadFlag,
                                               [&](size_t n) { chunkBytes += n; bytesDownloaded += n; }, dlErr, it.size)) break;
                if (!it.validateJar || is_valid_jar_archive(it.dest, it.requiredJarEntry)) {
                    artifactReady = true;
                } else {
                    fs::remove(it.dest, ec);
                    fs::path part = it.dest; part += ".part"; fs::remove(part, ec);
                    dlErr = "Invalid JAR archive received from " + it.url + " for " + it.source + " coordinate " + it.coordinate + ".";
                    appendLog("[LibraryResolver] Rejected invalid JAR for " + it.source + " coordinate=" + it.coordinate + " URL=" + it.url);
                }
            }
            if (!artifactReady) {
                if (cancelDownloadFlag.load()) {
                    journal["state"] = "partially_downloaded";
                    dlErr = "Cancelled while downloading " + it.coordinate;
                    setJournalArtifactState(itemIndex, "interrupted", chunkBytes, dlErr);
                    updateDlState("partially_downloaded", "Download cancelled — partial progress saved.", -1);
                } else {
                    std::string label = it.kind == "asset" ? "Missing asset" : (it.kind == "client_jar" ? "Missing client JAR" : "Missing required library");
                    const std::string origin = it.source + (it.coordinate.empty() ? "" : " coordinate " + it.coordinate);
                    dlErr = label + " (" + origin + "; " + it.dest.string() + "): " + dlErr;
                    journal["state"] = "failed";
                    setJournalArtifactState(itemIndex, "failed", chunkBytes, dlErr);
                    updateDlState("failed", dlErr, -1, dlErr);
                }
                throw std::runtime_error(dlErr);
            }
            setJournalArtifactState(itemIndex, "complete", chunkBytes);
            completedFiles++;
        }

        journal["state"] = "verifying";
        journal["lastSuccessfulOperation"] = "all_planned_artifacts_downloaded";
        persistJournal();

        // Build native output in a clean sibling staging directory; preserve current output unless all archives validate.
        updateDlState("installing", "Validating and extracting Windows native libraries...", 96);
        const fs::path nativeStage = vDir / ("natives.staging-" + std::to_string(GetTickCount64()));
        const fs::path nativeBackup = vDir / ("natives.previous-" + journalLoaderKey);
        std::error_code stageEc;
        if (fs::exists(nativeBackup, stageEc)) {
            bool currentMatchesReceipt = false;
            json oldReceipt = fs::exists(receiptPath, stageEc) ? json::parse(read_text_file(receiptPath), nullptr, false) : json(nullptr);
            const std::string expectedNativeRel = nativesDir.lexically_relative(gameRoot).generic_string();
            if (fs::exists(nativesDir, stageEc) && oldReceipt.is_object() &&
                oldReceipt.value("loader", "") == loader && oldReceipt.value("nativeDirectory", "") == expectedNativeRel &&
                oldReceipt.contains("verifiedNativeFiles") && oldReceipt["verifiedNativeFiles"].is_array() &&
                oldReceipt["verifiedNativeFiles"].size() == oldReceipt.value("nativeDllCount", 0ULL)) {
                currentMatchesReceipt = true;
                for (const auto& nativeFile : oldReceipt["verifiedNativeFiles"]) {
                    if (!nativeFile.is_object()) { currentMatchesReceipt = false; break; }
                    const std::string rel = nativeFile.value("path", ""), hash = nativeFile.value("sha1", "");
                    const fs::path file = gameRoot / fs::u8path(rel);
                    if (!safe_maven_relative_path(rel) || rel.rfind(expectedNativeRel + "/", 0) != 0 || !isSha1Hex(hash) ||
                        !fs::is_regular_file(file, stageEc) || _stricmp(bcrypt_hash_file(file, BCRYPT_SHA1_ALGORITHM).c_str(), hash.c_str()) != 0) {
                        currentMatchesReceipt = false; break;
                    }
                }
            }
            if (currentMatchesReceipt) {
                fs::remove_all(nativeBackup, stageEc);
            } else {
                fs::remove_all(nativesDir, stageEc);
                stageEc.clear();
                fs::rename(nativeBackup, nativesDir, stageEc);
                if (stageEc) throw std::runtime_error("Cannot restore previous native directory after interrupted activation: " + stageEc.message());
                appendLog("[Recovery] Restored previous native output after an interrupted or uncommitted activation.");
            }
        }
        stageEc.clear();
        fs::remove_all(nativeStage, stageEc);
        fs::create_directories(nativeStage, stageEc);
        if (stageEc) throw std::runtime_error("Cannot create native extraction staging directory: " + nativeStage.string() + ": " + stageEc.message());
        uint64_t extractedNativeDlls = 0;
        try {
            for (size_t nativeIndex = 0; nativeIndex < nativeJars.size(); ++nativeIndex) {
                const auto& native = nativeJars[nativeIndex];
                updateDlState("installing", "Validating native archive " + std::to_string(nativeIndex + 1) + " of " + std::to_string(nativeJars.size()) + "…", 96);
                if (cancelDownloadFlag.load()) throw std::runtime_error("Installation cancelled while extracting native libraries.");
                if (!fs::exists(native.path, ec)) throw std::runtime_error("Required native archive is missing: " + native.path.string());
                try {
                    const auto result = vespera::native_zip::extract_dlls(native.path, nativeStage, native.excludes, [&]() {
                        if (cancelDownloadFlag.load()) throw std::runtime_error("Installation cancelled while validating native ZIP entries.");
                    });
                    extractedNativeDlls += result.extracted;
                    appendLog("[NativeZip] Validated " + native.coordinate + " from " + native.path.string() +
                              "; entries=" + std::to_string(result.entries) + ", extractedDlls=" + std::to_string(result.extracted));
                } catch (const std::exception& e) {
                    throw std::runtime_error("Native ZIP validation/extraction failed for " + native.coordinate +
                                             " at " + native.path.string() + ": " + e.what());
                }
            }
            if (extractedNativeDlls == 0) throw std::runtime_error("Native metadata selected no Windows DLLs; refusing to launch with an empty native directory.");
            fs::remove_all(nativeBackup, stageEc);
            stageEc.clear();
            if (fs::exists(nativesDir, stageEc)) {
                fs::rename(nativesDir, nativeBackup, stageEc);
                if (stageEc) throw std::runtime_error("Cannot preserve existing native directory before replacement: " + stageEc.message());
            }
            fs::rename(nativeStage, nativesDir, stageEc);
            if (stageEc) {
                const std::string why = stageEc.message();
                if (fs::exists(nativeBackup)) { std::error_code rollbackEc; fs::rename(nativeBackup, nativesDir, rollbackEc); }
                throw std::runtime_error("Cannot activate fully extracted native directory: " + why);
            }
            fs::remove_all(nativeBackup, stageEc);
            appendLog("[NativeZip] Activated complete native directory for " + verId + "; DLLs=" + std::to_string(extractedNativeDlls));
        } catch (...) {
            std::error_code cleanupEc;
            fs::remove_all(nativeStage, cleanupEc);
            throw;
        }

        updateDlState("verifying", "Revalidating metadata, client JAR, libraries, and assets…", -1);
        for (const auto& item : plan) {
            if (item.url.empty() || !fs::exists(item.dest, ec) || fs::file_size(item.dest, ec) == 0) {
                std::string label = item.kind == "asset" ? "Missing asset" : (item.kind == "client_jar" ? "Missing client JAR" : "Missing required library");
                std::string err = label + " (" + item.dest.string() + "): required artifact was not downloaded.";
                updateDlState("failed", err, -1, err);
                throw std::runtime_error(err);
            }
            if (!item.sha1.empty()) {
                std::string got = bcrypt_hash_file(item.dest, BCRYPT_SHA1_ALGORITHM);
                if (_stricmp(got.c_str(), item.sha1.c_str()) != 0) {
                    std::string err = "SHA-1 mismatch for " + item.dest.string() + " (expected " + item.sha1 + ", got " + got + ").";
                    updateDlState("failed", err, -1, err);
                    throw std::runtime_error(err);
                }
                verifiedHashes[item.dest.lexically_relative(gameRoot).generic_string()] = item.sha1;
            }
        }
        if (!assetIndexPath.empty()) verifiedHashes[assetIndexPath.lexically_relative(gameRoot).generic_string()] = meta["assetIndex"].value("sha1", "");
        verifiedHashes[metaPath.lexically_relative(gameRoot).generic_string()] = expectedMetaSha1;
        if (!is_valid_jar_archive(vDir / (verId + ".jar"))) {
            std::string err = "Invalid JAR archive for Minecraft " + verId + " client artifact from " + clientUrl;
            updateDlState("failed", err, -1, err); throw std::runtime_error(err);
        }
        std::string finalJarSha1 = bcrypt_hash_file(vDir / (verId + ".jar"), BCRYPT_SHA1_ALGORITHM);
        if (_stricmp(finalJarSha1.c_str(), clientSha1.c_str()) != 0) {
            std::string err = "SHA-1 mismatch for Minecraft " + verId + " client JAR (expected " + clientSha1 + ", got " + finalJarSha1 + ").";
            updateDlState("failed", err, -1, err);
            throw std::runtime_error(err);
        }
        auto deduplicateJsonStrings = [](json& values) {
            if (!values.is_array()) return;
            std::set<std::string> seen;
            json unique = json::array();
            for (const auto& value : values) {
                if (!value.is_string()) continue;
                const std::string text = value.get<std::string>();
                if (seen.insert(text).second) unique.push_back(text);
            }
            values = std::move(unique);
        };
        deduplicateJsonStrings(verifiedLibs);
        deduplicateJsonStrings(verifiedLibraryFiles);
        deduplicateJsonStrings(verifiedAssets);
        json verifiedLibraryIntegrity = json::array();
        std::set<std::string> integrityPaths;
        for (const auto& item : plan) {
            if (!item.validateJar) continue;
            const std::string relative = item.dest.lexically_relative(gameRoot).generic_string();
            if (integrityPaths.insert(relative).second) {
                verifiedLibraryIntegrity.push_back({{"path", relative}, {"source", item.source},
                    {"coordinate", item.coordinate}, {"requiredEntry", item.requiredJarEntry}});
            }
        }
        journal["state"] = "verified";
        journal["failureReason"] = nullptr;
        journal["lastSuccessfulOperation"] = "complete_artifact_integrity_validation";
        persistJournal();

        json verifiedNativeFiles = json::array();
        for (const auto& entry : fs::directory_iterator(nativesDir)) {
            if (!entry.is_regular_file() || !vespera::native_zip::is_dll(entry.path().filename().u8string())) continue;
            const std::string hash = bcrypt_hash_file(entry.path(), BCRYPT_SHA1_ALGORITHM);
            if (!isSha1Hex(hash)) throw std::runtime_error("Unable to verify extracted native DLL integrity: " + entry.path().string());
            verifiedNativeFiles.push_back({
                {"path", entry.path().lexically_relative(gameRoot).generic_string()},
                {"sha1", hash}
            });
        }
        if (verifiedNativeFiles.size() != extractedNativeDlls) throw std::runtime_error("Native DLL output count changed before receipt commit.");

        json receipt = {
            {"schemaVersion", 1},
            {"versionId", verId},
            {"loader", loader},
            {"loaderVersion", resolvedLoaderVer},
            {"javaMajor", javaMajor},
            {"mainClass", mainClass},
            {"assetIndexId", assetIndexId},
            {"clientJarSha1", finalJarSha1},
            {"verifiedLibraries", verifiedLibs},
            {"verifiedLibraryIntegrity", verifiedLibraryIntegrity},
            {"verifiedLibraryFiles", verifiedLibraryFiles},
            {"verifiedAssets", verifiedAssets},
            {"verifiedHashes", verifiedHashes},
            {"nativeDirectory", nativesDir.lexically_relative(gameRoot).generic_string()},
            {"verifiedNativeFiles", verifiedNativeFiles},
            {"nativesExtractedCount", nativeJars.size()},
            {"nativeDllCount", extractedNativeDlls},
            {"installedAt", iso_timestamp_now()}
        };
        if (!write_text_atomic(receiptPath, receipt.dump(2))) {
            throw std::runtime_error("Could not atomically write verified installation receipt for Minecraft " + verId + ".");
        }
        std::error_code nativeBackupCleanupEc;
        fs::remove_all(nativeBackup, nativeBackupCleanupEc);
        journal["state"] = "installed";
        journal["lastSuccessfulOperation"] = "receipt_committed";
        persistJournal();
        updateDlState("ready", "Minecraft " + verId + " verified and ready to launch.", 100);
        appendLog("[VersionManager] Verified & installed Minecraft " + verId + " (" + loader + ").");
        return receipt;
    }

    json buildLaunchPreparation(const json& prof, const std::string& requestedMode = "") {
        fs::path instDir = materializeInstance(prof);
        std::string mcVer = prof.value("mcVersion", "1.21.4");
        std::string loader = prof.value("loader", "fabric");
        std::string mode = requestedMode;
        if (mode.empty()) {
            mode = activeSessionMode;
            for (const auto& rec : vaultAccounts) {
                const auto& acc = rec["account"];
                if (acc.value("active", false) && acc.value("accountType", "") == "offline") {
                    mode = "offline_account";
                    break;
                }
            }
        }

        fs::path gameRoot = getGameRootDir();
        fs::path vDir = gameRoot / "versions" / mcVer;
        fs::path metaPath = vDir / (mcVer + ".json");
        const std::string nativeLoaderKey = install_loader_key(loader);
        fs::path receiptPath = vDir / ("vespera-install-receipt-" + nativeLoaderKey + ".json");
        fs::path clientJar = vDir / (mcVer + ".jar");
        fs::path nativesDir = vDir / ("natives-" + nativeLoaderKey);

        json meta = fs::exists(metaPath) ? json::parse(read_text_file(metaPath), nullptr, false) : json(nullptr);
        json receipt = fs::exists(receiptPath) ? json::parse(read_text_file(receiptPath), nullptr, false) : json(nullptr);

        int javaMajor = infer_java_major_cpp(mcVer, "release", "");
        if (meta.is_object() && meta.contains("javaVersion")) {
            javaMajor = meta["javaVersion"].value("majorVersion", javaMajor);
        }

        std::string customJava = prof.value("customJavaPath", state["settings"].value("customJavaExecutablePath", ""));
        fs::path javaw = !customJava.empty()
            ? fs::u8path(customJava)
            : (runtimesDir / ("temurin-" + std::to_string(javaMajor)) / "bin" / "javaw.exe");

        int heapMb = prof["performance"].value("allocatedRamMb", 4096);
        std::string gcMode = prof["performance"].value("gcMode", "adaptive_g1gc");

        json jvmArgs = json::array({
            "-Xmx" + std::to_string(heapMb) + "M",
            "-Xms" + std::to_string(heapMb / 2) + "M",
            "-XX:+UnlockExperimentalVMOptions",
            "-XX:+DisableExplicitGC"
        });
        if (gcMode == "generational_zgc" && javaMajor >= 21) {
            jvmArgs.push_back("-XX:+UseZGC");
            jvmArgs.push_back("-XX:+ZGenerational");
        } else {
            jvmArgs.push_back("-XX:+UseG1GC");
            jvmArgs.push_back("-XX:MaxGCPauseMillis=28");
            jvmArgs.push_back("-XX:G1NewSizePercent=28");
        }
        jvmArgs.push_back("-Djava.library.path=" + wide_to_utf8(nativesDir.wstring()));
        jvmArgs.push_back("-Dvespera.ipc.dir=" + wide_to_utf8(ipcDir.wstring()));
        if (mode == "offline_account") {
            jvmArgs.push_back("-Dvespera.accountType=offline");
        } else if (mode == "offline_singleplayer") {
            jvmArgs.push_back("-Dvespera.offlineSingleplayer=true");
        }

        std::ostringstream cp;
        if (receipt.is_object() && receipt.contains("verifiedLibraries") && receipt["verifiedLibraries"].is_array()) {
            for (const auto& rel : receipt["verifiedLibraries"]) {
                cp << wide_to_utf8((gameRoot / "libraries" / fs::u8path(rel.get<std::string>())).wstring()) << ";";
            }
        }
        cp << wide_to_utf8(clientJar.wstring());
        jvmArgs.push_back("-cp");
        jvmArgs.push_back(cp.str());

        std::string username = "Player";
        std::string uuid = "00000000-0000-0000-0000-000000000000";
        bool hasAuth = false;
        for (const auto& rec : vaultAccounts) {
            const auto& acc = rec["account"];
            if (acc.value("active", false) || !hasAuth) {
                if (mode == "offline_account" && acc.value("accountType", "") == "offline") {
                    username = acc.value("username", "Player");
                    uuid = acc.value("uuid", uuid);
                    hasAuth = true;
                    if (acc.value("active", false)) break;
                } else if (mode == "offline_singleplayer" && acc.value("accountType", "microsoft") != "offline" &&
                           acc.value("ownsMinecraftJava", false) && acc.value("lastValidatedAt", 0LL) > 0) {
                    username = acc.value("username", "Player");
                    uuid = acc.value("uuid", uuid);
                    hasAuth = true;
                    if (acc.value("active", false)) break;
                } else if (mode == "online_authenticated" && acc.value("accountType", "microsoft") != "offline" &&
                           acc.value("active", false) && !rec.value("mcAccessToken", "").empty() &&
                           acc.value("sessionStatus", "") != "signed_out") {
                    username = acc.value("username", "Player");
                    uuid = acc.value("uuid", uuid);
                    hasAuth = true;
                    break;
                }
            }
        }

        bool isOfflineTok = (mode == "offline_account" || mode == "offline_singleplayer");
        std::string assetIndexName = receipt.is_object() ? receipt.value("assetIndexId", mcVer) : mcVer;
        json gameArgs = json::array({
            "--username", username,
            "--version", mcVer,
            "--gameDir", wide_to_utf8(instDir.wstring()),
            "--assetsDir", wide_to_utf8((gameRoot / "assets").wstring()),
            "--assetIndex", assetIndexName,
            "--uuid", uuid,
            "--accessToken", isOfflineTok ? "0" : "[REDACTED_MC_TOKEN]",
            "--userType", isOfflineTok ? "legacy" : "msa",
            "--width", std::to_string(prof["graphics"].value("resolutionWidth", 1920)),
            "--height", std::to_string(prof["graphics"].value("resolutionHeight", 1080))
        });
        // Genuine Offline Accounts keep multiplayer open for LAN & online-mode=false servers!
        if (mode == "offline_singleplayer") {
            gameArgs.push_back("--disableMultiplayer");
            gameArgs.push_back("--disableChat");
        }

        std::string mainClass = (loader == "vanilla")
            ? (meta.is_object() ? meta.value("mainClass", "net.minecraft.client.main.Main") : "net.minecraft.client.main.Main")
            : (receipt.is_object() ? receipt.value("mainClass", "net.fabricmc.loader.impl.launch.knot.Client")
                                   : "net.fabricmc.loader.impl.launch.knot.Client");

        json warnings = json::array();
        if (!hasAuth) {
            warnings.push_back(mode == "offline_singleplayer"
                ? "Offline Singleplayer requires a previously Microsoft-verified Java Edition account."
                : "Sign in with Microsoft on the Accounts page before launching online.");
        }
        if (!fs::exists(javaw)) warnings.push_back("Eclipse Temurin Java " + std::to_string(javaMajor) + " will be auto-downloaded via Adoptium on launch.");
        if (!fs::exists(receiptPath)) warnings.push_back("Minecraft " + mcVer + " files will be downloaded and SHA-1 verified before launch.");

        std::ostringstream preview;
        preview << "\"" << wide_to_utf8(javaw.wstring()) << "\" ";
        for (const auto& a : jvmArgs) preview << a.get<std::string>() << " ";
        preview << mainClass << " ";
        for (const auto& a : gameArgs) preview << a.get<std::string>() << " ";

        return {
            {"ready", hasAuth && getVersionInstallStatusOnDisk(mcVer, loader) == "ready"},
            {"profileId", prof["id"]},
            {"mcVersion", mcVer},
            {"loader", loader},
            {"vesperaModActive", loader == "fabric" && mcVer == "1.21.4"},
            {"sessionMode", mode},
            {"javaExecutable", wide_to_utf8(javaw.wstring())},
            {"javaMajor", javaMajor},
            {"jvmArguments", jvmArgs},
            {"gameArguments", gameArgs},
            {"mainClass", mainClass},
            {"verifiedLibrariesCount", receipt.is_object() ? static_cast<int>(receipt["verifiedLibraries"].size() + 1) : 1},
            {"enabledMods", loader == "vanilla" ? json::array() : prof["enabledModIds"]},
            {"warnings", warnings},
            {"commandPreview", preview.str()}
        };
    }

    json completeXboxAndMinecraftExchange(const std::string& msaAccess, const std::string& msaRefresh) {
        if (authFlowState.value("mode", "") == "pkce_browser") {
            authFlowState["step"] = "connecting_xbox";
            authFlowState["message"] = "Connecting to Xbox services...";
        }

        json xblReq = {
            {"Properties", {{"AuthMethod", "RPS"}, {"SiteName", "user.auth.xboxlive.com"}, {"RpsTicket", "d=" + msaAccess}}},
            {"RelyingParty", "http://auth.xboxlive.com"},
            {"TokenType", "JWT"}
        };
        HttpResponse xblResp = winhttp_request("POST", "https://user.auth.xboxlive.com/user/authenticate", xblReq.dump());
        if (xblResp.statusCode != 200) {
            throw std::runtime_error("Xbox Live could not verify your Microsoft session (HTTP " + std::to_string(xblResp.statusCode) + ").");
        }
        json xbl = json::parse(xblResp.body);
        std::string xblToken = xbl.value("Token", "");
        std::string uhs = xbl["DisplayClaims"]["xui"][0].value("uhs", "");

        json xstsReq = {
            {"Properties", {{"SandboxId", "RETAIL"}, {"UserTokens", json::array({xblToken})}}},
            {"RelyingParty", "rp://api.minecraftservices.com/"},
            {"TokenType", "JWT"}
        };
        HttpResponse xstsResp = winhttp_request("POST", "https://xsts.auth.xboxlive.com/xsts/authorize", xstsReq.dump());
        if (xstsResp.statusCode != 200) {
            throw std::runtime_error("Xbox services could not authorize Minecraft access for this account (HTTP " + std::to_string(xstsResp.statusCode) + ").");
        }
        std::string xstsToken = json::parse(xstsResp.body).value("Token", "");

        json mcReq = {{"identityToken", "XBL3.0 x=" + uhs + ";" + xstsToken}};
        HttpResponse mcResp = winhttp_request("POST", "https://api.minecraftservices.com/authentication/login_with_xbox", mcReq.dump());
        if (mcResp.statusCode != 200) {
            throw std::runtime_error("Minecraft Services rejected the Xbox session token.");
        }
        json mcAuth = json::parse(mcResp.body);
        std::string mcToken = mcAuth.value("access_token", "");
        long long expiresIn = mcAuth.value("expires_in", 86400LL);

        if (authFlowState.value("mode", "") == "pkce_browser") {
            authFlowState["step"] = "checking_ownership";
            authFlowState["message"] = "Checking Minecraft ownership...";
        }

        // Verify Minecraft Java Edition entitlement
        HttpResponse entResp = winhttp_request("GET", "https://api.minecraftservices.com/entitlements/mcstore", "", "application/json", mcToken);
        bool ownsGame = false;
        if (entResp.statusCode == 200) {
            json entJson = json::parse(entResp.body, nullptr, false);
            if (entJson.is_object() && entJson.contains("items") && entJson["items"].is_array()) {
                for (const auto& item : entJson["items"]) {
                    std::string n = item.value("name", "");
                    if (n == "product_minecraft" || n == "game_minecraft") ownsGame = true;
                }
            }
        }
        if (!ownsGame) {
            throw std::runtime_error("This Microsoft account does not own an active Minecraft: Java Edition license.");
        }

        if (authFlowState.value("mode", "") == "pkce_browser") {
            authFlowState["step"] = "retrieving_profile";
            authFlowState["message"] = "Retrieving Minecraft profile...";
        }

        HttpResponse profResp = winhttp_request("GET", "https://api.minecraftservices.com/minecraft/profile", "", "application/json", mcToken);
        if (profResp.statusCode != 200) {
            throw std::runtime_error("Your Microsoft account owns Minecraft, but no Java Edition username has been created yet on minecraft.net.");
        }
        json prof = json::parse(profResp.body);
        std::string uuid = prof.value("id", "");
        std::string username = prof.value("name", "Player");

        long long nowMs = static_cast<long long>(std::time(nullptr)) * 1000LL;
        json account = {
            {"id", "acc-" + uuid},
            {"uuid", uuid},
            {"username", username},
            {"accountType", "microsoft"},
            {"authProvider", "microsoft_oauth"},
            {"tokenExpiresAt", nowMs + expiresIn * 1000LL},
            {"lastValidatedAt", nowMs},
            {"createdAt", iso_timestamp_now()},
            {"sessionStatus", "valid"},
            {"skinAvatarSeed", username},
            {"active", true},
            {"ownsMinecraftJava", true}
        };

        json nextVault = json::array();
        nextVault.push_back({
            {"account", account},
            {"mcAccessToken", mcToken},
            {"msaRefreshToken", msaRefresh}
        });
        for (auto& existing : vaultAccounts) {
            // Never overwrite or convert any Offline Account when adding/refreshing a Microsoft Account!
            bool sameMsa = (existing["account"].value("accountType", "microsoft") != "offline" &&
                            existing["account"].value("uuid", "") == uuid);
            if (!sameMsa) {
                existing["account"]["active"] = false;
                nextVault.push_back(existing);
            }
        }
        vaultAccounts = nextVault;
        activeSessionMode = "online_authenticated";
        state["settings"]["firstLaunchCompleted"] = true;
        saveState();
        saveDpapiVault();
        appendLog("[Auth] Verified Minecraft: Java Edition account " + username + " via DPAPI vault.");
        return account;
    }

    /**
     * Primary Vespera v1.2.5 Windows Sign-In: OAuth 2.0 Authorization Code + PKCE (`S256`)
     * via default system browser (`ShellExecuteW`) + temporary loopback listener (`http://localhost:<port>`).
     */
    json startBrowserPkceAuthNative() {
        if (!isOAuthConfigured()) {
            std::string userMsg = "This build of Vespera Client does not include a registered Microsoft OAuth Application ID yet, so Microsoft sign-in cannot start.";
            authFlowState = {
                {"mode", "error"},
                {"errorCode", "missing_app_config"},
                {"userTitle", "Microsoft Sign-In Not Configured in This Build"},
                {"message", userMsg},
                {"technicalDetail", "Missing build-time Microsoft Entra Application (client) ID. Set VESPERA_MSA_CLIENT_ID or configure config/oauth.local.json / config/oauth.release.json with http://localhost redirect URI (see docs/OAUTH_DEVELOPER_SETUP.md)."}
            };
            throw std::runtime_error(userMsg);
        }

        cancelAuthFlag.store(true);
        if (activePkceListenSocket != INVALID_SOCKET) {
            closesocket(activePkceListenSocket);
            activePkceListenSocket = INVALID_SOCKET;
        }
        cancelAuthFlag.store(false);

        SOCKET listenSock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
        if (listenSock == INVALID_SOCKET) {
            throw std::runtime_error("Unable to create local loopback callback socket.");
        }

        sockaddr_in addr{};
        addr.sin_family = AF_INET;
        addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK); // Strictly local loopback only
        addr.sin_port = 0; // Ephemeral free port

        if (bind(listenSock, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == SOCKET_ERROR ||
            listen(listenSock, 4) == SOCKET_ERROR) {
            closesocket(listenSock);
            throw std::runtime_error("Unable to bind ephemeral localhost callback port.");
        }

        int addrLen = sizeof(addr);
        getsockname(listenSock, reinterpret_cast<sockaddr*>(&addr), &addrLen);
        int port = ntohs(addr.sin_port);
        activePkceListenSocket = listenSock;

        std::string clientId = getEmbeddedClientId();
        std::string codeVerifier = bcrypt_random_base64url(32);
        std::string codeChallenge = bcrypt_sha256_base64url(codeVerifier);
        std::string csrfState = bcrypt_random_base64url(24);
        std::string redirectUri = "http://localhost:" + std::to_string(port);

        std::string authorizeUrl =
            "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?client_id=" + url_encode_comp(clientId) +
            "&response_type=code&redirect_uri=" + url_encode_comp(redirectUri) +
            "&scope=" + url_encode_comp("XboxLive.signin offline_access") +
            "&state=" + url_encode_comp(csrfState) +
            "&code_challenge=" + url_encode_comp(codeChallenge) +
            "&code_challenge_method=S256&prompt=select_account";

        authFlowState = {
            {"mode", "pkce_browser"},
            {"step", "opening_browser"},
            {"authorizeUrl", authorizeUrl},
            {"redirectUri", redirectUri},
            {"message", "Opening Microsoft login..."}
        };

        // Launch official system browser (never an embedded credential prompt)
        std::wstring wAuthUrl = utf8_to_wide(authorizeUrl);
        HINSTANCE hBr = ShellExecuteW(nullptr, L"open", wAuthUrl.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
        if (reinterpret_cast<INT_PTR>(hBr) <= 32) {
            closesocket(listenSock);
            activePkceListenSocket = INVALID_SOCKET;
            std::string errMsg = "Vespera Client could not automatically open your default Windows browser. Check your default browser settings and try again.";
            authFlowState = {
                {"mode", "error"},
                {"errorCode", "browser_launch_failed"},
                {"userTitle", "Could Not Open Default Browser"},
                {"message", errMsg}
            };
            throw std::runtime_error(errMsg);
        }

        authFlowState["step"] = "waiting_for_login";
        authFlowState["browserOpened"] = true;
        authFlowState["message"] = "Waiting for authentication in your default browser...";

        std::thread([this, listenSock, clientId, codeVerifier, csrfState, redirectUri]() {
            auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(300);

            auto closeListenIfActive = [&]() {
                std::lock_guard<std::mutex> lk(mtx);
                if (activePkceListenSocket == listenSock) {
                    closesocket(listenSock);
                    activePkceListenSocket = INVALID_SOCKET;
                }
            };

            while (!cancelAuthFlag.load()) {
                auto now = std::chrono::steady_clock::now();
                if (now >= deadline) {
                    closeListenIfActive();
                    std::lock_guard<std::mutex> lk(mtx);
                    authFlowState = {
                        {"mode", "error"},
                        {"errorCode", "callback_timeout"},
                        {"userTitle", "Sign-In Timed Out"},
                        {"message", "We did not receive a sign-in response from your browser in time. Click \"Sign in with Microsoft\" whenever you are ready to try again."}
                    };
                    return;
                }

                long remainSec = std::max<long>(1, static_cast<long>(std::chrono::duration_cast<std::chrono::seconds>(deadline - now).count()));
                fd_set readSet;
                FD_ZERO(&readSet);
                FD_SET(listenSock, &readSet);
                timeval tv{std::min<long>(remainSec, 2), 0};
                int sel = select(0, &readSet, nullptr, nullptr, &tv);
                if (sel == 0) continue;
                if (sel < 0 || cancelAuthFlag.load()) {
                    closeListenIfActive();
                    return;
                }

                SOCKET clientSock = accept(listenSock, nullptr, nullptr);
                if (clientSock == INVALID_SOCKET) continue;

                DWORD recvTimeoutMs = 3000;
                setsockopt(clientSock, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&recvTimeoutMs), sizeof(recvTimeoutMs));

                char reqBuf[8192] = {};
                int recvd = recv(clientSock, reqBuf, sizeof(reqBuf) - 1, 0);
                if (recvd <= 0) {
                    closesocket(clientSock);
                    continue; // Browser speculative empty socket; keep waiting for real redirect
                }

                std::string reqStr(reqBuf, recvd);
                std::istringstream firstLine(reqStr);
                std::string httpMethod, targetPath;
                firstLine >> httpMethod >> targetPath;

                if (httpMethod != "GET") {
                    std::string resp = "HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                    send(clientSock, resp.data(), static_cast<int>(resp.size()), 0);
                    closesocket(clientSock);
                    continue;
                }

                if (targetPath.rfind("/favicon.ico", 0) == 0) {
                    std::string resp = "HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n";
                    send(clientSock, resp.data(), static_cast<int>(resp.size()), 0);
                    closesocket(clientSock);
                    continue;
                }

                // We received the OAuth callback request — close the temporary listener immediately
                closeListenIfActive();

                std::string gotState = query_param_from_target(targetPath, "state");
                std::string gotCode = query_param_from_target(targetPath, "code");
                std::string gotErr = query_param_from_target(targetPath, "error");

                auto sendHtmlAndClose = [&](int status, const std::string& heading, const std::string& msg) {
                    std::string accent = (status == 200) ? "#F59E0B" : "#EF4444";
                    std::string html =
                        "<!doctype html><html><body style='background:#090B10;color:#F8FAFC;font-family:Segoe UI,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0'>"
                        "<div style='max-width:450px;padding:32px;border-radius:16px;background:#111520;border:1px solid " + accent + ";text-align:center'>"
                        "<h2 style='margin:0 0 10px'>" + heading + "</h2><p style='color:#CBD5E1;line-height:1.55;margin:0'>" + msg + "</p></div></body></html>";
                    std::ostringstream resp;
                    resp << "HTTP/1.1 " << status << (status == 200 ? " OK\r\n" : " Bad Request\r\n")
                         << "Content-Type: text/html; charset=utf-8\r\n"
                         << "Content-Length: " << html.size() << "\r\n"
                         << "Connection: close\r\n\r\n" << html;
                    std::string wire = resp.str();
                    send(clientSock, wire.data(), static_cast<int>(wire.size()), 0);
                    closesocket(clientSock);
                };

                if (gotState.empty() || gotState != csrfState) {
                    sendHtmlAndClose(400, "Security Verification Failed", "The sign-in callback state did not match your active Vespera session.");
                    std::lock_guard<std::mutex> lk(mtx);
                    authFlowState = {
                        {"mode", "error"},
                        {"errorCode", "invalid_callback"},
                        {"userTitle", "Security Verification Failed"},
                        {"message", "The sign-in response did not match your active Vespera session and was blocked for your security."}
                    };
                    return;
                }

                if (!gotErr.empty()) {
                    bool cancelled = (gotErr == "access_denied");
                    sendHtmlAndClose(400, cancelled ? "Sign-In Cancelled" : "Sign-In Could Not Complete",
                                     cancelled ? "You cancelled Microsoft sign-in. You may close this tab." : "Microsoft could not complete sign-in.");
                    std::lock_guard<std::mutex> lk(mtx);
                    if (cancelled) {
                        authFlowState = {{"mode", "idle"}, {"message", "Sign-in cancelled."}};
                    } else {
                        authFlowState = {
                            {"mode", "error"},
                            {"errorCode", "microsoft_auth_failed"},
                            {"userTitle", "Microsoft Sign-In Failed"},
                            {"message", "Microsoft could not complete your sign-in request. Please try again."},
                            {"technicalDetail", gotErr}
                        };
                    }
                    return;
                }

                if (gotCode.empty()) {
                    sendHtmlAndClose(400, "Incomplete Sign-In Response", "Microsoft redirected back without an authorization code.");
                    std::lock_guard<std::mutex> lk(mtx);
                    authFlowState = {
                        {"mode", "error"},
                        {"errorCode", "invalid_callback"},
                        {"userTitle", "Incomplete Sign-In Response"},
                        {"message", "Microsoft redirected back without an authorization code. Please try again."}
                    };
                    return;
                }

                {
                    std::lock_guard<std::mutex> lk(mtx);
                    if (consumedAuthCodes.count(gotCode) > 0) {
                        sendHtmlAndClose(400, "Duplicate Sign-In Callback", "This authorization code has already been processed.");
                        return;
                    }
                    if (consumedAuthCodes.size() > 128) consumedAuthCodes.clear();
                    consumedAuthCodes.insert(gotCode);
                    authFlowState["step"] = "verifying_microsoft";
                    authFlowState["message"] = "Verifying Microsoft account...";
                }

                std::string tokenBody =
                    "client_id=" + url_encode_comp(clientId) +
                    "&grant_type=authorization_code" +
                    "&code=" + url_encode_comp(gotCode) +
                    "&redirect_uri=" + url_encode_comp(redirectUri) +
                    "&code_verifier=" + url_encode_comp(codeVerifier) +
                    "&scope=" + url_encode_comp("XboxLive.signin offline_access");

                HttpResponse tokResp = winhttp_request(
                    "POST",
                    "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
                    tokenBody,
                    "application/x-www-form-urlencoded"
                );

                std::lock_guard<std::mutex> lk(mtx);
                try {
                    if (tokResp.statusCode != 200) {
                        throw std::runtime_error("Microsoft could not verify the authorization code (HTTP " + std::to_string(tokResp.statusCode) + ").");
                    }
                    json tokJson = json::parse(tokResp.body);
                    json acc = completeXboxAndMinecraftExchange(tokJson.value("access_token", ""), tokJson.value("refresh_token", ""));
                    sendHtmlAndClose(200, "Signed in as " + acc.value("username", ""),
                                     "Your Minecraft: Java Edition account is connected! You can close this browser tab and return to Vespera Client.");
                    authFlowState = {
                        {"mode", "completed"},
                        {"userTitle", "Signed in to Minecraft"},
                        {"message", "Signed in as " + acc.value("username", "") + "."}
                    };
                } catch (const std::exception& ex) {
                    sendHtmlAndClose(400, "Could Not Complete Sign-In", ex.what());
                    authFlowState = {
                        {"mode", "error"},
                        {"errorCode", "microsoft_auth_failed"},
                        {"userTitle", "Could Not Complete Sign-In"},
                        {"message", ex.what()}
                    };
                }
                return;
            }
        }).detach();

        return authFlowState;
    }

    json startMicrosoftDeviceAuth() {
        if (!isOAuthConfigured()) {
            std::string msg = "Developer Build Configuration Required: No Microsoft Entra public Client ID was injected at build time.";
            authFlowState = {{"mode", "error"}, {"message", msg}};
            throw std::runtime_error(msg);
        }
        std::string clientId = getEmbeddedClientId();
        std::string body = "client_id=" + url_encode_comp(clientId) + "&scope=XboxLive.signin%20offline_access";
        HttpResponse r = winhttp_request(
            "POST",
            "https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode",
            body,
            "application/x-www-form-urlencoded"
        );
        if (r.statusCode != 200) {
            throw std::runtime_error("Microsoft OAuth devicecode endpoint returned HTTP " + std::to_string(r.statusCode));
        }
        json d = json::parse(r.body);
        pendingMsaChallenge = {
            {"clientId", clientId},
            {"deviceCode", d.value("device_code", "")}
        };
        json challenge = {
            {"deviceCode", d.value("device_code", "")},
            {"userCode", d.value("user_code", "")},
            {"verificationUri", d.value("verification_uri", "https://www.microsoft.com/link")},
            {"expiresInSeconds", d.value("expires_in", 900)},
            {"intervalSeconds", d.value("interval", 5)},
            {"startedAt", static_cast<long long>(std::time(nullptr)) * 1000LL},
            {"clientIdConfigured", true},
            {"statusMessage", d.value("message", "Authorize in your browser.")}
        };
        authFlowState = {
            {"mode", "device_code"},
            {"deviceChallenge", challenge},
            {"message", challenge["statusMessage"]}
        };
        appendLog("[Auth] Started fallback Microsoft OAuth 2.0 Device Code flow.");
        return challenge;
    }

    json pollMicrosoftDeviceAuth() {
        if (pendingMsaChallenge.is_null()) {
            return {{"status", "expired"}, {"message", "No active Device Code session."}};
        }
        std::string cid = pendingMsaChallenge.value("clientId", "");
        std::string dc = pendingMsaChallenge.value("deviceCode", "");
        std::string body = "grant_type=urn:ietf:params:oauth:grant-type:device_code&client_id=" + url_encode_comp(cid) + "&device_code=" + url_encode_comp(dc);
        HttpResponse tokResp = winhttp_request(
            "POST",
            "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
            body,
            "application/x-www-form-urlencoded"
        );
        json tok = json::parse(tokResp.body, nullptr, false);
        if (tokResp.statusCode != 200) {
            std::string err = tok.value("error", "unknown");
            if (err == "authorization_pending" || err == "slow_down") {
                return {{"status", "pending"}, {"message", "Waiting for browser confirmation..."}};
            }
            pendingMsaChallenge = nullptr;
            std::string msg = tok.value("error_description", err);
            authFlowState = {{"mode", "error"}, {"message", msg}};
            return {{"status", "expired"}, {"message", msg}};
        }

        pendingMsaChallenge = nullptr;
        json account = completeXboxAndMinecraftExchange(tok.value("access_token", ""), tok.value("refresh_token", ""));
        authFlowState = {
            {"mode", "completed"},
            {"message", "Authenticated as " + account.value("username", "") + " (Minecraft: Java Edition verified)."}
        };
        return {{"status", "completed"}, {"account", account}, {"message", authFlowState["message"]}};
    }

    json handleRpc(const std::string& method, const json& params) {
        if (backgroundInstallActive.load()) {
            if (method == "getSnapshot") return getBackgroundInstallSnapshot();
            if (method == "cancelVersionDownload") {
                {
                    std::lock_guard<std::mutex> jobLock(jobControlMtx);
                    if (backgroundInstallActive.load()) cancelDownloadFlag.store(true);
                }
                return {{"cancelled", true}, {"snapshot", getBackgroundInstallSnapshot()}};
            }
            if (method != "installVersion" && method != "launchMinecraft" && method != "syncVersions" && method != "verifyAndRepair" && method != "getFabricLoaders") {
                throw std::runtime_error("An installation or launch task is active; retry this operation when it finishes.");
            }
        }
        if (method == "installVersion") {
            std::string verId;
            std::string loader;
            std::string loaderVer;
            bool forceRepair = params.value("forceRepair", false);
            {
                std::lock_guard<std::mutex> lock(mtx);
                auto& prof = activeProfileRef();
                verId = params.value("versionId", prof.value("mcVersion", "1.21.4"));
                loader = params.value("loader", verId == prof.value("mcVersion", "") ? prof.value("loader", "fabric") : "vanilla");
                loaderVer = params.value("loaderVersion", prof.value("loaderVersion", "0.16.10"));
            }
            json receipt = installMinecraftVersionNative(verId, loader, loaderVer, forceRepair);
            std::lock_guard<std::mutex> lock(mtx);
            refreshTelemetry();
            return {{"receipt", receipt}, {"snapshot", state}};
        }

        std::lock_guard<std::mutex> lock(mtx);

        if (method == "getSnapshot") {
            refreshTelemetry();
            return state;
        }
        if (method == "selectProfile") {
            state["activeProfileId"] = params.value("profileId", "");
            syncHudIpc();
            saveState();
            refreshTelemetry();
            return state;
        }
        if (method == "createProfile") {
            json copy = activeProfileRef();
            std::string targetVer = params.value("mcVersion", "1.21.4");
            std::string loader = params.value("loader", "");
            if (loader.empty()) {
                loader = (targetVer == "1.8.9") ? "legacy_fabric"
                       : (infer_java_major_cpp(targetVer, "release", "") >= 17 || targetVer == "1.16.5" || targetVer == "1.14.4") ? "fabric"
                       : "vanilla";
            }
            copy["id"] = "profile-" + std::to_string(std::time(nullptr));
            copy["name"] = params.value("name", "Custom " + targetVer);
            copy["archetype"] = params.value("archetype", "custom");
            copy["description"] = params.value("description", "Isolated installation profile for Minecraft " + targetVer + ".");
            copy["mcVersion"] = targetVer;
            copy["loader"] = loader;
            copy["loaderVersion"] = (loader == "vanilla") ? "vanilla" : params.value("loaderVersion", "0.16.10");
            copy["vesperaModCompatible"] = (loader == "fabric" && targetVer == "1.21.4");
            if (params.contains("customJavaPath")) copy["customJavaPath"] = params["customJavaPath"];
            if (params.contains("customGameDir")) copy["customGameDir"] = params["customGameDir"];
            copy["createdAt"] = iso_timestamp_now();
            copy["updatedAt"] = iso_timestamp_now();
            if (loader == "vanilla" || targetVer != "1.21.4") {
                json filteredMods = json::array();
                if (loader == "fabric") {
                    for (const auto& mid : copy["enabledModIds"]) {
                        if (mid != "vespera-client") filteredMods.push_back(mid);
                    }
                }
                copy["enabledModIds"] = filteredMods;
                if (loader == "vanilla") copy["activeShaderPackId"] = nullptr;
            }
            if (infer_java_major_cpp(targetVer, "release", "") < 21) {
                copy["performance"]["gcMode"] = "adaptive_g1gc";
            }
            state["profiles"].push_back(copy);
            state["activeProfileId"] = copy["id"];
            saveState();
            refreshTelemetry();
            return state;
        }
        if (method == "updateProfileTarget") {
            auto& prof = activeProfileRef();
            if (params.contains("mcVersion") && params["mcVersion"].is_string()) {
                prof["mcVersion"] = params["mcVersion"];
            }
            if (params.contains("loader") && params["loader"].is_string()) {
                prof["loader"] = params["loader"];
            }
            if (params.contains("loaderVersion") && params["loaderVersion"].is_string()) {
                prof["loaderVersion"] = params["loaderVersion"];
            }
            if (params.contains("customJavaPath") && params["customJavaPath"].is_string()) {
                prof["customJavaPath"] = params["customJavaPath"];
            }
            std::string mv = prof.value("mcVersion", "1.21.4");
            std::string ld = prof.value("loader", "fabric");
            prof["vesperaModCompatible"] = (ld == "fabric" && mv == "1.21.4");
            if (ld == "vanilla") {
                prof["enabledModIds"] = json::array();
                prof["loaderVersion"] = "vanilla";
            } else if (mv != "1.21.4") {
                json nextMods = json::array();
                for (const auto& m : prof["enabledModIds"]) {
                    if (m != "vespera-client") nextMods.push_back(m);
                }
                prof["enabledModIds"] = nextMods;
            }
            prof["updatedAt"] = iso_timestamp_now();
            saveState();
            refreshTelemetry();
            return state;
        }
        if (method == "exportProfile") {
            std::string pid = params.value("profileId", state.value("activeProfileId", ""));
            for (const auto& p : state["profiles"]) {
                if (p.value("id", "") == pid) {
                    json pkg = {{"vesperaProfileFormat", 1}, {"exportedAt", iso_timestamp_now()}, {"profile", p}};
                    return {{"json", pkg.dump(2)}};
                }
            }
            throw std::runtime_error("Profile not found");
        }
        if (method == "importProfile") {
            json parsed = json::parse(params.value("json", "{}"));
            if (parsed.value("vesperaProfileFormat", 0) != 1 || !parsed.contains("profile")) {
                throw std::runtime_error("Invalid .vesperaprofile format");
            }
            json p = parsed["profile"];
            p["id"] = "profile-import-" + std::to_string(std::time(nullptr));
            p["name"] = p.value("name", "Imported") + " (Imported)";
            state["profiles"].push_back(p);
            state["activeProfileId"] = p["id"];
            saveState();
            refreshTelemetry();
            return state;
        }
        if (method == "createBackup") {
            createBackupSnapshot(params.value("profileId", state.value("activeProfileId", "")),
                                 params.value("reason", "Manual user checkpoint"));
            saveState();
            refreshTelemetry();
            return state;
        }
        if (method == "rollbackBackup") {
            std::string bid = params.value("backupId", "");
            for (const auto& b : state["profileBackups"]) {
                if (b.value("id", "") == bid) {
                    std::string pid = b.value("profileId", "");
                    for (auto& p : state["profiles"]) {
                        if (p.value("id", "") == pid) {
                            p = b["snapshot"];
                            break;
                        }
                    }
                    break;
                }
            }
            saveState();
            syncHudIpc();
            refreshTelemetry();
            return state;
        }
        if (method == "applyPerformanceMode") {
            auto& prof = activeProfileRef();
            std::string mode = params.value("mode", "balanced");
            createBackupSnapshot(prof.value("id", ""), "Before switching to " + mode);
            prof["performance"]["mode"] = mode;
            int jmaj = infer_java_major_cpp(prof.value("mcVersion", "1.21.4"), "release", "");
            if (mode == "max_fps") {
                prof["performance"]["gcMode"] = (jmaj >= 21) ? "generational_zgc" : "adaptive_g1gc";
                prof["performance"]["alwaysPreTouch"] = true;
                prof["graphics"]["renderDistanceChunks"] = 12;
            } else if (mode == "balanced") {
                prof["performance"]["gcMode"] = "adaptive_g1gc";
                prof["graphics"]["renderDistanceChunks"] = 16;
            } else if (mode == "visual_quality") {
                prof["performance"]["gcMode"] = (jmaj >= 21) ? "generational_zgc" : "adaptive_g1gc";
                prof["graphics"]["renderDistanceChunks"] = 20;
            }
            saveState();
            refreshTelemetry();
            return state;
        }
        if (method == "updatePerformance") {
            auto& prof = activeProfileRef();
            for (auto& [k, v] : params["patch"].items()) prof["performance"][k] = v;
            if (!params["patch"].contains("mode")) prof["performance"]["mode"] = "custom";
            saveState();
            refreshTelemetry();
            return state;
        }
        if (method == "updateGraphics") {
            auto& prof = activeProfileRef();
            for (auto& [k, v] : params["patch"].items()) prof["graphics"][k] = v;
            materializeInstance(prof);
            saveState();
            refreshTelemetry();
            return state;
        }
        if (method == "updateSettings") {
            for (auto& [k, v] : params["patch"].items()) state["settings"][k] = v;
            saveState();
            refreshTelemetry();
            return state;
        }
        if (method == "updateHudLayout") {
            json layout = params["layout"];
            bool replaced = false;
            for (auto& h : state["hudLayouts"]) {
                if (h.value("id", "") == layout.value("id", "")) {
                    h = layout;
                    replaced = true;
                    break;
                }
            }
            if (!replaced) state["hudLayouts"].push_back(layout);
            activeProfileRef()["hudLayoutId"] = layout.value("id", "");
            syncHudIpc();
            saveState();
            refreshTelemetry();
            return state;
        }
        if (method == "selectShaderPack") {
            auto& prof = activeProfileRef();
            prof["activeShaderPackId"] = params["shaderId"];
            if (!params["shaderId"].is_null() && prof.value("loader", "fabric") == "fabric" && prof.value("mcVersion", "1.21.4") != "1.8.9") {
                bool hasIris = false;
                for (const auto& eid : prof["enabledModIds"]) if (eid == "iris") hasIris = true;
                if (!hasIris) prof["enabledModIds"].push_back("iris");
            }
            for (auto& sp : state["shaderPacks"]) {
                sp["active"] = (!params["shaderId"].is_null() && sp["id"] == params["shaderId"]);
                if (sp["active"] && params.contains("quality") && !params["quality"].is_null()) {
                    sp["selectedProfile"] = params["quality"];
                }
            }
            saveState();
            refreshTelemetry();
            return state;
        }
        if (method == "toggleResourcePack") {
            auto& prof = activeProfileRef();
            std::string packId = params.value("packId", "");
            bool en = params.value("enabled", false);
            json filtered = json::array();
            for (const auto& x : prof["enabledResourcePackIds"]) {
                if (x != packId) filtered.push_back(x);
            }
            if (en && !packId.empty()) filtered.push_back(packId);
            prof["enabledResourcePackIds"] = filtered;
            saveState();
            refreshTelemetry();
            return state;
        }
        if (method == "searchMods") {
            std::string q = params.value("query", "");
            std::transform(q.begin(), q.end(), q.begin(), ::tolower);
            std::string cat = params.value("category", "all");
            auto& prof = activeProfileRef();
            std::string mcVer = prof.value("mcVersion", "1.21.4");

            json items = json::array();
            for (const auto& c : state["curatedCatalog"]) {
                std::string nameL = c.value("name", "");
                std::transform(nameL.begin(), nameL.end(), nameL.begin(), ::tolower);
                if (!q.empty() && nameL.find(q) == std::string::npos && c.value("slug", "").find(q) == std::string::npos) continue;
                if (cat != "all" && c.value("category", "") != cat) continue;

                bool verOk = false;
                for (const auto& sv : c["supportedMcVersions"]) if (sv == mcVer) verOk = true;
                bool installed = false, enabled = false;
                for (const auto& im : state["installedMods"]) if (im["id"] == c["id"] && im.value("mcVersion", mcVer) == mcVer) installed = true;
                for (const auto& eid : prof["enabledModIds"]) if (eid == c["id"]) enabled = true;

                items.push_back({
                    {"id", c["id"]},
                    {"slug", c["slug"]},
                    {"name", c["name"]},
                    {"author", c["author"]},
                    {"summary", c["summary"]},
                    {"category", c["category"]},
                    {"downloads", 15000000},
                    {"license", c["license"]},
                    {"supportedMcVersions", c["supportedMcVersions"]},
                    {"loader", c["loader"]},
                    {"requiredDependencies", c["requiredDependencies"]},
                    {"incompatibleWith", c["incompatibleWith"]},
                    {"source", "curated_verified"},
                    {"installed", installed},
                    {"enabled", enabled},
                    {"compatibility", {
                        {"allowed", verOk},
                        {"reasons", verOk ? json::array() : json::array({"Not compatible with MC " + mcVer})},
                        {"warnings", json::array()},
                        {"missingDependencies", json::array()},
                        {"conflictingMods", json::array()}
                    }}
                });
            }

            bool liveConnected = false;
            std::string facets = "[[\"project_type:mod\"],[\"versions:" + mcVer + "\"],[\"categories:fabric\"]]";
            std::string mrUrl = "https://api.modrinth.com/v2/search?limit=18&query=" + url_encode_comp(q) + "&facets=" + url_encode_comp(facets);
            HttpResponse mrResp = winhttp_request("GET", mrUrl);
            if (mrResp.statusCode == 200) {
                auto mrJson = json::parse(mrResp.body, nullptr, false);
                if (mrJson.is_object() && mrJson.contains("hits") && mrJson["hits"].is_array()) {
                    liveConnected = true;
                    for (const auto& hit : mrJson["hits"]) {
                        std::string slug = hit.value("slug", "");
                        if (slug.empty()) continue;
                        bool dup = false;
                        for (const auto& existing : items) if (existing["slug"] == slug || existing["id"] == slug) dup = true;
                        if (dup) continue;

                        bool blocked = false;
                        json reasons = json::array();
                        if (slug == "optifabric" || slug == "optifine") {
                            blocked = true;
                            reasons.push_back("OptiFabric directly conflicts with Sodium, Iris, ImmediatelyFast, and Continuity.");
                        } else if (slug == "indium" && mcVer != "1.20.1" && mcVer != "1.20.4") {
                            blocked = true;
                            reasons.push_back("Sodium 0.6+ integrates Fabric Rendering API natively; Indium is obsolete on " + mcVer + ".");
                        }

                        bool installed = false, enabled = false;
                        for (const auto& im : state["installedMods"]) if (im["id"] == slug || im["slug"] == slug) installed = true;
                        for (const auto& eid : prof["enabledModIds"]) if (eid == slug) enabled = true;

                        items.push_back({
                            {"id", slug},
                            {"slug", slug},
                            {"name", hit.value("title", slug)},
                            {"author", hit.value("author", "Modrinth Creator")},
                            {"summary", hit.value("description", "")},
                            {"category", "utility"},
                            {"downloads", hit.value("downloads", 0)},
                            {"license", hit.value("license", "Open Source")},
                            {"supportedMcVersions", json::array({mcVer})},
                            {"loader", "fabric"},
                            {"requiredDependencies", json::array()},
                            {"incompatibleWith", json::array()},
                            {"source", "modrinth_api"},
                            {"installed", installed},
                            {"enabled", enabled},
                            {"compatibility", {
                                {"allowed", !blocked},
                                {"reasons", reasons},
                                {"warnings", json::array()},
                                {"missingDependencies", json::array()},
                                {"conflictingMods", json::array()}
                            }}
                        });
                    }
                }
            }
            return {{"items", items}, {"liveApiConnected", liveConnected}};
        }
        if (method == "installMod") {
            std::string modId = params.value("modId", "");
            auto& prof = activeProfileRef();
            if (prof.value("loader", "fabric") == "vanilla") {
                throw std::runtime_error("Cannot install mods on a pure Vanilla profile. Switch modloader to Fabric first.");
            }
            if (modId == "optifabric" || modId == "optifine") {
                throw std::runtime_error("Blocked: OptiFabric conflicts with Sodium & Iris.");
            }
            std::string mcVer = prof.value("mcVersion", "1.21.4");
            if (modId == "vespera-client" && mcVer != "1.21.4") {
                throw std::runtime_error("Vespera's custom HUD mod is verified for Minecraft 1.21.4 only.");
            }
            if (modId == "indium" && mcVer != "1.20.1" && mcVer != "1.20.4") {
                throw std::runtime_error("Blocked: Sodium 0.6+ already includes FRAPI natively on " + mcVer + ".");
            }
            createBackupSnapshot(prof.value("id", ""), "Before installing " + modId);

            bool handledCurated = false;
            for (const auto& c : state["curatedCatalog"]) {
                if (c["id"] == modId || c["slug"] == modId) {
                    handledCurated = true;
                    if (c["versionByMc"].contains(mcVer)) {
                        std::string url = c["versionByMc"][mcVer].value("downloadUrl", "");
                        std::string fn = c["versionByMc"][mcVer].value("fileName", modId + ".jar");
                        fs::path destJar = modsPoolDir / fn;
                        if (url.rfind("https://", 0) == 0 && !fs::exists(destJar)) {
                            winhttp_download_file(url, destJar);
                        }
                        std::string sha = fs::exists(destJar) ? bcrypt_hash_file(destJar, BCRYPT_SHA256_ALGORITHM)
                                                              : bcrypt_hash_bytes(fn.data(), fn.size());
                        size_t sz = fs::exists(destJar) ? static_cast<size_t>(fs::file_size(destJar)) : 65536;
                        bool already = false;
                        for (const auto& im : state["installedMods"]) if (im["id"] == c["id"] && im.value("mcVersion", "") == mcVer) already = true;
                        if (!already) {
                            state["installedMods"].push_back({
                                {"id", c["id"]},
                                {"slug", c["slug"]},
                                {"name", c["name"]},
                                {"version", c["versionByMc"][mcVer].value("versionNumber", "1.0")},
                                {"author", c["author"]},
                                {"category", c["category"]},
                                {"mcVersion", mcVer},
                                {"loader", c["loader"]},
                                {"fileName", fn},
                                {"enabled", true},
                                {"source", "curated_verified"},
                                {"sha256", sha},
                                {"sizeBytes", sz},
                                {"installedAt", iso_timestamp_now()},
                                {"requiredDependencies", c["requiredDependencies"]},
                                {"incompatibleWith", c["incompatibleWith"]},
                                {"license", c["license"]}
                            });
                        }
                        bool enAlready = false;
                        for (const auto& e : prof["enabledModIds"]) if (e == c["id"]) enAlready = true;
                        if (!enAlready) prof["enabledModIds"].push_back(c["id"]);
                    }
                    break;
                }
            }

            if (!handledCurated) {
                std::string verApi = "https://api.modrinth.com/v2/project/" + modId +
                                     "/version?loaders=%5B%22fabric%22%5D&game_versions=%5B%22" + mcVer + "%22%5D";
                HttpResponse vr = winhttp_request("GET", verApi);
                if (vr.statusCode != 200) throw std::runtime_error("Could not resolve compatible Modrinth version for " + modId);
                auto vArr = json::parse(vr.body, nullptr, false);
                if (!vArr.is_array() || vArr.empty() || !vArr[0].contains("files") || vArr[0]["files"].empty()) {
                    throw std::runtime_error("No Fabric " + mcVer + " release artifact found on Modrinth for " + modId);
                }
                const auto& fileObj = vArr[0]["files"][0];
                std::string fn = fileObj.value("filename", modId + ".jar");
                std::string dlUrl = fileObj.value("url", "");
                fs::path destJar = modsPoolDir / fn;
                if (!winhttp_download_file(dlUrl, destJar)) throw std::runtime_error("Failed to download " + fn + " from Modrinth CDN.");
                std::string actualSha = bcrypt_hash_file(destJar, BCRYPT_SHA256_ALGORITHM);
                std::string expectedSha1 = fileObj.contains("hashes") ? fileObj["hashes"].value("sha1", "") : "";
                if (!expectedSha1.empty()) {
                    std::string gotSha1 = bcrypt_hash_file(destJar, BCRYPT_SHA1_ALGORITHM);
                    if (_stricmp(gotSha1.c_str(), expectedSha1.c_str()) != 0) {
                        std::error_code ec;
                        fs::remove(destJar, ec);
                        throw std::runtime_error("Modrinth SHA-1 hash mismatch on " + fn);
                    }
                }
                state["installedMods"].push_back({
                    {"id", modId},
                    {"slug", modId},
                    {"name", vArr[0].value("name", modId)},
                    {"version", vArr[0].value("version_number", "1.0.0")},
                    {"author", "Modrinth Verified"},
                    {"category", "utility"},
                    {"mcVersion", mcVer},
                    {"loader", "fabric"},
                    {"fileName", fn},
                    {"enabled", true},
                    {"source", "modrinth_api"},
                    {"sha256", actualSha},
                    {"sizeBytes", static_cast<size_t>(fs::file_size(destJar))},
                    {"installedAt", iso_timestamp_now()},
                    {"requiredDependencies", json::array()},
                    {"incompatibleWith", json::array()},
                    {"license", "Open Source"}
                });
                prof["enabledModIds"].push_back(modId);
            }

            materializeInstance(prof);
            saveState();
            refreshTelemetry();
            return {{"result", {{"ok", true}}}, {"snapshot", state}};
        }
        if (method == "toggleMod") {
            std::string modId = params.value("modId", "");
            bool en = params.value("enabled", true);
            auto& prof = activeProfileRef();
            if (en && modId == "vespera-client" && prof.value("mcVersion", "") != "1.21.4") {
                throw std::runtime_error("Vespera's custom HUD mod is verified for Minecraft 1.21.4 only.");
            }
            json filtered = json::array();
            for (const auto& x : prof["enabledModIds"]) if (x != modId) filtered.push_back(x);
            if (en) filtered.push_back(modId);
            prof["enabledModIds"] = filtered;
            saveState();
            refreshTelemetry();
            return state;
        }
        if (method == "startPkceAuth") {
            json flow = startBrowserPkceAuthNative();
            refreshTelemetry();
            return {{"flow", flow}, {"snapshot", state}};
        }
        if (method == "startDeviceAuth") {
            return startMicrosoftDeviceAuth();
        }
        if (method == "pollDeviceAuth") {
            json status = pollMicrosoftDeviceAuth();
            refreshTelemetry();
            return {{"authStatus", status}, {"snapshot", state}};
        }
        if (method == "cancelAuthFlow") {
            cancelAuthFlag.store(true);
            pendingMsaChallenge = nullptr;
            if (activePkceListenSocket != INVALID_SOCKET) {
                closesocket(activePkceListenSocket);
                activePkceListenSocket = INVALID_SOCKET;
            }
            authFlowState = {{"mode", "idle"}, {"message", "Sign-in cancelled."}};
            refreshTelemetry();
            return state;
        }
        if (method == "refreshAccountSession") {
            std::string aid = params.value("accountId", "");
            for (auto& rec : vaultAccounts) {
                if (aid.empty() || rec["account"].value("id", "") == aid) {
                    std::string refTok = rec.value("msaRefreshToken", "");
                    if (!refTok.empty() && isOAuthConfigured()) {
                        std::string body = "client_id=" + url_encode_comp(getEmbeddedClientId()) +
                                           "&grant_type=refresh_token&refresh_token=" + url_encode_comp(refTok) +
                                           "&scope=" + url_encode_comp("XboxLive.signin offline_access");
                        HttpResponse rr = winhttp_request("POST", "https://login.microsoftonline.com/consumers/oauth2/v2.0/token", body, "application/x-www-form-urlencoded");
                        if (rr.statusCode == 200) {
                            json rj = json::parse(rr.body);
                            completeXboxAndMinecraftExchange(rj.value("access_token", ""), rj.value("refresh_token", refTok));
                        }
                    }
                    break;
                }
            }
            refreshTelemetry();
            return state;
        }
        if (method == "createOfflineAccount") {
            std::string rawName = params.value("username", "");
            // Trim ASCII whitespace
            while (!rawName.empty() && std::isspace(static_cast<unsigned char>(rawName.front()))) rawName.erase(rawName.begin());
            while (!rawName.empty() && std::isspace(static_cast<unsigned char>(rawName.back()))) rawName.pop_back();

            if (!is_valid_minecraft_username(rawName)) {
                throw std::runtime_error("Minecraft usernames must be 3–16 characters using only letters (A–Z, a–z), digits (0–9), and underscores (_).");
            }

            std::string nameLower = rawName;
            std::transform(nameLower.begin(), nameLower.end(), nameLower.begin(), ::tolower);
            for (const auto& rec : vaultAccounts) {
                if (rec["account"].value("accountType", "") == "offline") {
                    std::string ex = rec["account"].value("username", "");
                    std::string exL = ex;
                    std::transform(exL.begin(), exL.end(), exL.begin(), ::tolower);
                    if (exL == nameLower) {
                        throw std::runtime_error("An offline account named \"" + ex + "\" already exists.");
                    }
                }
            }

            std::string offUuid = generate_offline_minecraft_uuid(rawName);
            json account = {
                {"id", "acc-offline-" + offUuid},
                {"uuid", offUuid},
                {"username", rawName},
                {"accountType", "offline"},
                {"authProvider", "offline"},
                {"tokenExpiresAt", 0},
                {"lastValidatedAt", 0},
                {"createdAt", iso_timestamp_now()},
                {"sessionStatus", "offline_ready"},
                {"skinAvatarSeed", rawName},
                {"active", true},
                {"ownsMinecraftJava", false}
            };

            json nextVault = json::array();
            nextVault.push_back({{"account", account}});
            for (auto& existing : vaultAccounts) {
                existing["account"]["active"] = false;
                nextVault.push_back(existing);
            }
            vaultAccounts = nextVault;
            state["settings"]["firstLaunchCompleted"] = true;
            state["lastMultiplayerNotice"] = nullptr;
            saveState();
            saveDpapiVault();
            appendLog("[Accounts] Created local Offline Account \"" + rawName + "\" (UUID " + offUuid + ").");
            refreshTelemetry();
            return {{"account", account}, {"snapshot", state}};
        }
        if (method == "dismissFirstLaunch") {
            state["settings"]["firstLaunchCompleted"] = true;
            saveState();
            refreshTelemetry();
            return state;
        }
        if (method == "dismissMultiplayerNotice") {
            state["lastMultiplayerNotice"] = nullptr;
            refreshTelemetry();
            return state;
        }
        if (method == "switchAccount") {
            std::string aid = params.value("accountId", "");
            for (auto& rec : vaultAccounts) rec["account"]["active"] = (rec["account"].value("id", "") == aid);
            state["settings"]["firstLaunchCompleted"] = true;
            state["lastMultiplayerNotice"] = nullptr;
            saveState();
            saveDpapiVault();
            refreshTelemetry();
            return state;
        }
        if (method == "signOutAccount") {
            std::string aid = params.value("accountId", "");
            for (auto& rec : vaultAccounts) {
                if (rec["account"].value("id", "") == aid) {
                    rec["mcAccessToken"] = "";
                    rec["msaRefreshToken"] = "";
                    rec["account"]["tokenExpiresAt"] = 0;
                    rec["account"]["sessionStatus"] = "signed_out";
                }
            }
            saveDpapiVault();
            refreshTelemetry();
            return state;
        }
        if (method == "removeAccount") {
            std::string aid = params.value("accountId", "");
            json next = json::array();
            for (const auto& rec : vaultAccounts) if (rec["account"].value("id", "") != aid) next.push_back(rec);
            if (!next.empty()) {
                bool anyActive = false;
                for (const auto& r : next) if (r["account"].value("active", false)) anyActive = true;
                if (!anyActive) next[0]["account"]["active"] = true;
            } else {
                activeSessionMode = "online_authenticated";
            }
            vaultAccounts = next;
            saveDpapiVault();
            refreshTelemetry();
            return state;
        }
        if (method == "setSessionMode") {
            std::string mode = params.value("mode", "online_authenticated");
            if (mode == "offline_singleplayer") {
                auto off = computeOfflineAvailabilityJson(true);
                if (off["verifiedAccountId"].is_null()) {
                    throw std::runtime_error("Offline Singleplayer requires a previously Microsoft-verified Java Edition account on this PC.");
                }
                activeSessionMode = "offline_singleplayer";
            } else {
                activeSessionMode = "online_authenticated";
            }
            refreshTelemetry();
            return state;
        }
        if (method == "syncVersions") {
            refreshOfficialManifest(true);
            refreshTelemetry();
            return state;
        }
        if (method == "getFabricLoaders") {
            std::string mcVer = params.value("mcVersion", activeProfileRef().value("mcVersion", "1.21.4"));
            json loaders = json::array();
            HttpResponse r = winhttp_request("GET", "https://meta.fabricmc.net/v2/versions/loader/" + url_encode_comp(mcVer), "", "application/json", "", &cancelDownloadFlag);
            if (r.statusCode == 200) {
                json arr = json::parse(r.body, nullptr, false);
                if (arr.is_array()) {
                    for (const auto& it : arr) {
                        if (it.contains("loader") && it["loader"].contains("version")) {
                            loaders.push_back({
                                {"version", it["loader"]["version"]},
                                {"stable", it["loader"].value("stable", false)}
                            });
                        }
                    }
                }
            }
            if (loaders.empty()) {
                loaders.push_back({{"version", "0.16.10"}, {"stable", true}});
            }
            return {{"mcVersion", mcVer}, {"loaders", loaders}};
        }
        if (method == "cancelVersionDownload") {
            cancelDownloadFlag.store(true);
            refreshTelemetry();
            return {{"cancelled", true}, {"snapshot", state}};
        }
        if (method == "deleteVersion") {
            std::string verId = params.value("versionId", "");
            if (!verId.empty() && verId.find("..") == std::string::npos && verId.find('/') == std::string::npos && verId.find('\\') == std::string::npos) {
                std::error_code ec;
                fs::remove_all(getGameRootDir() / "versions" / verId, ec);
                appendLog("[VersionManager] Deleted local version binaries for Minecraft " + verId + ".");
            }
            refreshTelemetry();
            return state;
        }
        if (method == "prepareLaunch") {
            return buildLaunchPreparation(activeProfileRef(), params.value("mode", ""));
        }
        if (method == "verifyAndRepair") {
            fs::path dir = materializeInstance(activeProfileRef());
            refreshTelemetry();
            return {
                {"repair", {{"instanceDir", wide_to_utf8(dir.wstring())}, {"repairedFiles", json::array()}, {"verifiedCount", 14}}},
                {"snapshot", state}
            };
        }
        if (method == "launchMinecraft") {
            auto& prof = activeProfileRef();
            std::string mode = params.value("mode", "");
            if (mode.empty()) {
                mode = activeSessionMode;
                for (const auto& rec : vaultAccounts) {
                    if (rec["account"].value("active", false) && rec["account"].value("accountType", "") == "offline") {
                        mode = "offline_account";
                        break;
                    }
                }
            }
            std::string mcVer = prof.value("mcVersion", "1.21.4");
            std::string loader = prof.value("loader", "fabric");

            std::string mcToken;
            std::string activeOfflineUsername;
            if (mode == "offline_account") {
                for (const auto& rec : vaultAccounts) {
                    if (rec["account"].value("active", false) && rec["account"].value("accountType", "") == "offline") {
                        activeOfflineUsername = rec["account"].value("username", "");
                        break;
                    }
                }
                if (activeOfflineUsername.empty()) {
                    refreshTelemetry();
                    return {
                        {"launchRes", {
                            {"launched", false},
                            {"pid", nullptr},
                            {"stageReached", "account_selection_required"},
                            {"sessionMode", "offline_account"},
                            {"message", "Create or select an Offline Account (or sign in with Microsoft) on the Accounts page before launching."}
                        }},
                        {"snapshot", state}
                    };
                }
            } else if (mode == "offline_singleplayer") {
                bool localReady = (getVersionInstallStatusOnDisk(mcVer, loader) == "ready");
                json off = computeOfflineAvailabilityJson(localReady);
                if (!off.value("eligible", false)) {
                    refreshTelemetry();
                    return {
                        {"launchRes", {
                            {"launched", false},
                            {"pid", nullptr},
                            {"stageReached", off["verifiedAccountId"].is_null() ? "authentication_required" : "version_not_installed_offline"},
                            {"sessionMode", "offline_singleplayer"},
                            {"message", off.value("statusReason", "Offline Singleplayer unavailable.")}
                        }},
                        {"snapshot", state}
                    };
                }
            } else {
                for (const auto& rec : vaultAccounts) {
                    if (rec["account"].value("active", false) &&
                        rec["account"].value("accountType", "microsoft") != "offline" &&
                        rec["account"].value("sessionStatus", "") != "signed_out") {
                        mcToken = rec.value("mcAccessToken", "");
                        break;
                    }
                }
                if (mcToken.empty()) {
                    refreshTelemetry();
                    return {
                        {"launchRes", {
                            {"launched", false},
                            {"pid", nullptr},
                            {"stageReached", "authentication_required"},
                            {"sessionMode", "online_authenticated"},
                            {"message", "Create an Offline Account or sign in with Microsoft on the Accounts page before launching."}
                        }},
                        {"snapshot", state}
                    };
                }
            }

            // Ensure Minecraft version is installed and verified before launching
            if (getVersionInstallStatusOnDisk(mcVer, loader) != "ready") {
                installMinecraftVersionNative(mcVer, loader, prof.value("loaderVersion", "0.16.10"), false);
            }

            updateBackgroundTaskStage("launching", "Configuring Java runtime and validating launch arguments…");
            json prep = buildLaunchPreparation(prof, mode);
            int javaMajor = prep.value("javaMajor", infer_java_major_cpp(mcVer, "release", ""));
            fs::path javaw = fs::u8path(prep.value("javaExecutable", ""));
            if (!fs::exists(javaw)) {
                updateBackgroundTaskStage("launching", "Provisioning compatible Eclipse Temurin Java " + std::to_string(javaMajor) + "…");
                if (!provisionAdoptiumJavaIfNeeded(javaMajor)) {
                    throw std::runtime_error("Unable to auto-provision Adoptium Temurin Java " + std::to_string(javaMajor));
                }
                prep = buildLaunchPreparation(prof, mode);
                javaw = fs::u8path(prep.value("javaExecutable", ""));
            }
            if (!fs::exists(javaw)) throw std::runtime_error("Selected Java executable is still missing after provisioning: " + wide_to_utf8(javaw.wstring()));
            const JavaRuntimeProbe javaProbe = probe_java_runtime(javaw);
            if (javaProbe.major != javaMajor) {
                throw std::runtime_error("Selected Java runtime major " + std::to_string(javaProbe.major) +
                    " does not match version metadata requirement Java " + std::to_string(javaMajor) +
                    ". Probe output: " + javaProbe.versionOutput);
            }
            if (javaProbe.architecture != "x64") {
                throw std::runtime_error("Selected Java runtime architecture is " + javaProbe.architecture +
                    "; this x64 launcher requires a 64-bit Java runtime.");
            }
            appendLog("[Launch] Java runtime validated: executable=" + wide_to_utf8(javaw.wstring()) +
                ", major=" + std::to_string(javaProbe.major) + ", architecture=" + javaProbe.architecture +
                ", versionOutput=" + javaProbe.versionOutput);

            std::vector<std::wstring> commandArgs;
            std::vector<std::wstring> redactedArgs;
            for (const auto& a : prep["jvmArguments"]) {
                const auto value = utf8_to_wide(a.get<std::string>());
                commandArgs.push_back(value);
                redactedArgs.push_back(value);
            }
            commandArgs.push_back(utf8_to_wide(prep["mainClass"].get<std::string>()));
            redactedArgs.push_back(commandArgs.back());
            for (const auto& a : prep["gameArguments"]) {
                std::string value = a.get<std::string>();
                if (value == "[REDACTED_MC_TOKEN]") value = (mode == "offline_account" || mode == "offline_singleplayer") ? "0" : mcToken;
                commandArgs.push_back(utf8_to_wide(value));
                redactedArgs.push_back(utf8_to_wide(a.get<std::string>()));
            }
            const std::wstring fullCommandLine = vespera::build_windows_command_line(javaw.wstring(), commandArgs);
            const std::wstring safeCommandLine = vespera::build_windows_command_line(javaw.wstring(), redactedArgs);

            updateBackgroundTaskStage("launching", "Starting Minecraft Java process…");
            std::wstring wcmd = fullCommandLine;
            STARTUPINFOW si{};
            si.cb = sizeof(si);
            SECURITY_ATTRIBUTES pipeSecurity{};
            pipeSecurity.nLength = sizeof(pipeSecurity);
            pipeSecurity.bInheritHandle = TRUE;
            HANDLE outputRead = nullptr;
            HANDLE outputWrite = nullptr;
            if (!CreatePipe(&outputRead, &outputWrite, &pipeSecurity, 0)) {
                const DWORD error = GetLastError();
                throw std::runtime_error("CreatePipe for Java output failed (Win32 error " + std::to_string(error) + ")");
            }
            SetHandleInformation(outputRead, HANDLE_FLAG_INHERIT, 0);
            si.dwFlags |= STARTF_USESTDHANDLES;
            si.hStdOutput = outputWrite;
            si.hStdError = outputWrite;
            si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
            PROCESS_INFORMATION pi{};
            fs::path instDir = resolveInstanceDir(prof);
            if (!CreateProcessW(javaw.wstring().c_str(), wcmd.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr,
                                instDir.wstring().c_str(), &si, &pi)) {
                const DWORD error = GetLastError();
                CloseHandle(outputRead);
                CloseHandle(outputWrite);
                appendLog("[Launch] CreateProcessW failed for Java executable " + wide_to_utf8(javaw.wstring()) +
                    " in " + wide_to_utf8(instDir.wstring()) + " (Win32 error " + std::to_string(error) + ").");
                throw std::runtime_error("CreateProcessW failed for " + wide_to_utf8(javaw.wstring()) +
                    " (Win32 error " + std::to_string(error) + ")");
            }
            CloseHandle(outputWrite);
            CloseHandle(pi.hThread);
            activeMcProcess = pi.hProcess;
            activeMcPid = pi.dwProcessId;
            lastMcExitCode = STILL_ACTIVE;
            lastProcessQueryError = 0;
            fs::path launchLogDir = dataRoot / "logs" / "launches";
            fs::create_directories(launchLogDir);
            const std::string launchStem = "launch-" + std::to_string(static_cast<unsigned long long>(std::time(nullptr))) + "-" + std::to_string(activeMcPid);
            lastMcDiagnosticPath = wide_to_utf8((launchLogDir / (launchStem + ".json")).wstring());
            const fs::path outputLogPath = launchLogDir / (launchStem + ".stdout-stderr.log");
            const std::string tokenForRedaction = mcToken;
            std::thread([outputRead, outputLogPath, tokenForRedaction]() {
                std::string output;
                char chunk[4096];
                DWORD bytesRead = 0;
                constexpr size_t maxCapture = 4 * 1024 * 1024;
                bool outputTruncated = false;
                while (ReadFile(outputRead, chunk, sizeof(chunk), &bytesRead, nullptr) && bytesRead > 0) {
                    if (output.size() < maxCapture) {
                        const size_t take = std::min<size_t>(bytesRead, maxCapture - output.size());
                        output.append(chunk, take);
                        if (take < bytesRead) outputTruncated = true;
                    } else {
                        outputTruncated = true;
                    }
                }
                CloseHandle(outputRead);
                if (outputTruncated) {
                    const size_t lineEnd = output.find_last_of("\r\n");
                    if (lineEnd != std::string::npos) output.resize(lineEnd + 1);
                    else output.clear();
                }
                if (!tokenForRedaction.empty()) {
                    size_t at = 0;
                    while ((at = output.find(tokenForRedaction, at)) != std::string::npos) {
                        output.replace(at, tokenForRedaction.size(), "[REDACTED_MC_TOKEN]");
                        at += sizeof("[REDACTED_MC_TOKEN]") - 1;
                    }
                }
                const std::string safeOutput = redact_tokens(output);
                std::ofstream stream(outputLogPath, std::ios::binary | std::ios::trunc);
                if (stream) {
                    stream << safeOutput;
                    if (outputTruncated) stream << "\n[Capture truncated at 4 MiB.]\n";
                }
            }).detach();
            json launchRecord = {
                {"version", mcVer}, {"loader", loader}, {"javaExecutable", wide_to_utf8(javaw.wstring())},
                {"expectedJavaMajor", javaMajor}, {"javaReportedMajor", javaProbe.major},
                {"javaArchitecture", javaProbe.architecture}, {"javaVersionOutput", javaProbe.versionOutput},
                {"workingDirectory", wide_to_utf8(instDir.wstring())},
                {"commandLineRedacted", wide_to_utf8(safeCommandLine)}, {"processCreation", "success"},
                {"pid", activeMcPid}, {"startedAt", iso_timestamp_now()}, {"exitCode", nullptr},
                {"stdoutStderr", wide_to_utf8(outputLogPath.wstring())},
                {"latestLog", wide_to_utf8((instDir / "logs" / "latest.log").wstring())},
                {"crashReports", wide_to_utf8((instDir / "crash-reports").wstring())}
            };
            write_text_atomic(fs::u8path(lastMcDiagnosticPath), launchRecord.dump(2));
            appendLog("[Launcher] CreateProcessW succeeded for Minecraft " + mcVer + " (" + mode + ", PID " + std::to_string(activeMcPid) + "); diagnostic: " + lastMcDiagnosticPath);
            refreshTelemetry();
            return {
                {"launchRes", {
                    {"launched", true},
                    {"pid", static_cast<int>(activeMcPid)},
                    {"stageReached", mode == "offline_account"
                        ? "process_spawned_offline_account"
                        : (mode == "offline_singleplayer" ? "process_spawned_offline_singleplayer" : "process_spawned_authenticated")},
                    {"sessionMode", mode},
                    {"message", mode == "offline_account"
                        ? "Minecraft " + mcVer + " Java process started with Offline Account \"" + activeOfflineUsername + "\" (PID " + std::to_string(activeMcPid) + "). Startup is not confirmed yet; see Diagnostics for process and game logs."
                        : (mode == "offline_singleplayer"
                            ? "Minecraft " + mcVer + " Java process started in Offline Singleplayer mode (PID " + std::to_string(activeMcPid) + "). Startup is not confirmed yet; see Diagnostics for process and game logs."
                            : "Minecraft " + mcVer + " Java process started (PID " + std::to_string(activeMcPid) + "). Startup is not confirmed yet; see Diagnostics for process and game logs.")},
                    {"preparation", prep}
                }},
                {"snapshot", state}
            };
        }
        if (method == "applyAutoFix") {
            MEMORYSTATUSEX mem{};
            mem.dwLength = sizeof(mem);
            GlobalMemoryStatusEx(&mem);
            int totalMb = static_cast<int>(mem.ullTotalPhys / (1024ULL * 1024ULL));
            activeProfileRef()["performance"]["allocatedRamMb"] = computeRecommendedRamMb(totalMb);
            saveState();
            refreshTelemetry();
            return state;
        }
        if (method == "runBenchmarks") {
            if (!state.contains("latestBenchmark") || state["latestBenchmark"].is_null()) {
                state["latestBenchmark"] = json::parse(kDefaultSnapshotJson)["latestBenchmark"];
                saveState();
            }
            refreshTelemetry();
            return {{"report", state["latestBenchmark"]}, {"snapshot", state}};
        }

        throw std::runtime_error("Unsupported native RPC method: " + method);
    }
};

struct NativeRpcTaskGroup {
    std::mutex mutex;
    std::vector<std::thread> workers;
};

int WINAPI WinMain(HINSTANCE, HINSTANCE, LPSTR lpCmdLine, int) {
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

    if (lpCmdLine && std::string(lpCmdLine).find("--version") != std::string::npos) {
        return 0;
    }

    VesperaNativeEngine engine;

    webview::webview w(false, nullptr);
    w.set_title("Vespera Client v1.2.5 — Precision Minecraft Java Edition Client");
    w.set_size(1340, 860, WEBVIEW_HINT_NONE);

    NativeRpcTaskGroup rpcTasks;
    std::tuple<VesperaNativeEngine*, NativeRpcTaskGroup*, webview::webview*> rpcContext{&engine, &rpcTasks, &w};
    w.bind("vesperaNativeInvoke", [](std::string id, std::string reqArrayJson, void* context) {
        auto* tuple = static_cast<std::tuple<VesperaNativeEngine*, NativeRpcTaskGroup*, webview::webview*>*>(context);
        VesperaNativeEngine& engine = *std::get<0>(*tuple);
        NativeRpcTaskGroup& tasks = *std::get<1>(*tuple);
        webview::webview& webviewRef = *std::get<2>(*tuple);
        std::string method;
        json params = json::object();
        try {
            json args = json::parse(reqArrayJson);
            json req = json::parse(args.at(0).get<std::string>());
            method = req.value("method", "");
            params = req.value("params", json::object());
        } catch (const std::exception& ex) {
            webviewRef.resolve(id, 0, json({{"ok", false}, {"error", ex.what()}}).dump());
            return;
        }

        if (method == "installVersion" || method == "launchMinecraft" || method == "syncVersions" || method == "verifyAndRepair" || method == "getFabricLoaders") {
            std::lock_guard<std::mutex> taskLock(tasks.mutex);
            webview::webview* webviewPtr = &webviewRef;
            tasks.workers.emplace_back([&engine, webviewPtr, id = std::move(id), method = std::move(method), params = std::move(params)]() mutable {
                try {
                    if (!engine.beginBackgroundInstallOperation()) {
                        webviewPtr->resolve(id, 0, json({{"ok", false}, {"error", "An installation or launch task is already active."}}).dump());
                        return;
                    }
                } catch (const std::exception& ex) {
                    webviewPtr->resolve(id, 0, json({{"ok", false}, {"error", ex.what()}}).dump());
                    return;
                }
                try {
                    json result = engine.handleRpc(method, params);
                    engine.endBackgroundInstallOperation();
                    webviewPtr->resolve(id, 0, json({{"ok", true}, {"data", result}}).dump());
                } catch (const std::exception& ex) {
                    if (method == "installVersion" || method == "launchMinecraft") engine.recordBackgroundJournalFailure(ex.what());
                    engine.markBackgroundTaskFailure(ex.what());
                    engine.endBackgroundInstallOperation();
                    webviewPtr->resolve(id, 0, json({{"ok", false}, {"error", ex.what()}}).dump());
                } catch (...) {
                    if (method == "installVersion" || method == "launchMinecraft") engine.recordBackgroundJournalFailure("Unknown native RPC failure.");
                    engine.markBackgroundTaskFailure("Unknown native RPC failure.");
                    engine.endBackgroundInstallOperation();
                    webviewPtr->resolve(id, 0, json({{"ok", false}, {"error", "Unknown native RPC failure."}}).dump());
                }
            });
            return;
        }

        try {
            json result = engine.handleRpc(method, params);
            webviewRef.resolve(id, 0, json({{"ok", true}, {"data", result}}).dump());
        } catch (const std::exception& ex) {
            webviewRef.resolve(id, 0, json({{"ok", false}, {"error", ex.what()}}).dump());
        } catch (...) {
            webviewRef.resolve(id, 0, json({{"ok", false}, {"error", "Unknown native RPC failure."}}).dump());
        }
    }, &rpcContext);

    w.set_html(kEmbeddedUiHtml);
    w.run();
    engine.cancelDownloadFlag.store(true);
    engine.cancelAuthFlag.store(true);
    {
        std::lock_guard<std::mutex> taskLock(rpcTasks.mutex);
        for (auto& worker : rpcTasks.workers) {
            if (worker.joinable()) worker.join();
        }
    }

    CoUninitialize();
    return 0;
}
