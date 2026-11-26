#ifndef VESPERA_WIN32_PLATFORM_HPP
#define VESPERA_WIN32_PLATFORM_HPP

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <shellapi.h>
#include <wincrypt.h>
#include <bcrypt.h>
#include <winhttp.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <psapi.h>

#include <atomic>
#include <cstdio>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <functional>
#include <regex>
#include <sstream>
#include <string>
#include <vector>

namespace vespera_win32 {

inline std::wstring utf8_to_wide(const std::string& str) {
    if (str.empty()) return L"";
    int needed = MultiByteToWideChar(CP_UTF8, 0, str.data(), static_cast<int>(str.size()), nullptr, 0);
    if (needed <= 0) return L"";
    std::wstring out(needed, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, str.data(), static_cast<int>(str.size()), out.data(), needed);
    return out;
}

inline std::string wide_to_utf8(const std::wstring& wstr) {
    if (wstr.empty()) return "";
    int needed = WideCharToMultiByte(CP_UTF8, 0, wstr.data(), static_cast<int>(wstr.size()), nullptr, 0, nullptr, nullptr);
    if (needed <= 0) return "";
    std::string out(needed, '\0');
    WideCharToMultiByte(CP_UTF8, 0, wstr.data(), static_cast<int>(wstr.size()), out.data(), needed, nullptr, nullptr);
    return out;
}

inline std::string get_known_folder_utf8(REFKNOWNFOLDERID rfid, const std::string& fallbackEnv) {
    PWSTR rawPath = nullptr;
    if (SUCCEEDED(SHGetKnownFolderPath(rfid, 0, nullptr, &rawPath)) && rawPath != nullptr) {
        std::wstring ws(rawPath);
        CoTaskMemFree(rawPath);
        return wide_to_utf8(ws);
    }
    if (!fallbackEnv.empty()) {
        const char* envVal = std::getenv(fallbackEnv.c_str());
        if (envVal) return std::string(envVal);
    }
    return "C:\\Users\\Public";
}

inline std::string iso_timestamp_now() {
    std::time_t t = std::time(nullptr);
    std::tm gmt{};
    gmtime_s(&gmt, &t);
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%02dZ",
                  gmt.tm_year + 1900, gmt.tm_mon + 1, gmt.tm_mday,
                  gmt.tm_hour, gmt.tm_min, gmt.tm_sec);
    return std::string(buf);
}

inline std::string redact_tokens(const std::string& input) {
    std::string out = input;
    out = std::regex_replace(out, std::regex("(--accessToken\\s+)([^\\s\"']+)"), "$1[REDACTED_MC_TOKEN]");
    out = std::regex_replace(out, std::regex("(Bearer\\s+)[A-Za-z0-9._~+/-]+=*"), "$1[REDACTED_BEARER]");
    out = std::regex_replace(out, std::regex("(\"access_token\"\\s*:\\s*\")[^\"]+(\")"), "$1[REDACTED]$2");
    out = std::regex_replace(out, std::regex("(\"refresh_token\"\\s*:\\s*\")[^\"]+(\")"), "$1[REDACTED]$2");
    return out;
}

inline bool write_file_atomic(const std::filesystem::path& target, const void* data, size_t len) {
    std::error_code ec;
    std::filesystem::create_directories(target.parent_path(), ec);
    std::filesystem::path tmp = target;
    tmp += L".tmp";

    HANDLE hFile = CreateFileW(tmp.wstring().c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (hFile == INVALID_HANDLE_VALUE) return false;

    const uint8_t* ptr = static_cast<const uint8_t*>(data);
    size_t remaining = len;
    while (remaining > 0) {
        DWORD chunk = static_cast<DWORD>(remaining > (1 << 20) ? (1 << 20) : remaining);
        DWORD written = 0;
        if (!WriteFile(hFile, ptr, chunk, &written, nullptr) || written == 0) {
            CloseHandle(hFile);
            DeleteFileW(tmp.wstring().c_str());
            return false;
        }
        ptr += written;
        remaining -= written;
    }
    FlushFileBuffers(hFile);
    CloseHandle(hFile);

    if (!MoveFileExW(tmp.wstring().c_str(), target.wstring().c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        DeleteFileW(tmp.wstring().c_str());
        return false;
    }
    return true;
}

inline bool write_text_atomic(const std::filesystem::path& target, const std::string& content) {
    return write_file_atomic(target, content.data(), content.size());
}

inline std::string read_text_file(const std::filesystem::path& p) {
    std::ifstream ifs(p, std::ios::binary);
    if (!ifs) return "";
    std::ostringstream ss;
    ss << ifs.rdbuf();
    return ss.str();
}

/**
 * Computes SHA-1 or SHA-256 hex digest using Windows Cryptography Next Generation (CNG / bcrypt.lib).
 */
inline std::string bcrypt_hash_bytes(const void* data, size_t size, LPCWSTR algId = BCRYPT_SHA256_ALGORITHM) {
    BCRYPT_ALG_HANDLE hAlg = nullptr;
    BCRYPT_HASH_HANDLE hHash = nullptr;
    std::string hexResult;

    if (BCryptOpenAlgorithmProvider(&hAlg, algId, nullptr, 0) != 0) return "";
    DWORD objLen = 0, cbData = 0, hashLen = 0;
    BCryptGetProperty(hAlg, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&objLen), sizeof(DWORD), &cbData, 0);
    BCryptGetProperty(hAlg, BCRYPT_HASH_LENGTH, reinterpret_cast<PUCHAR>(&hashLen), sizeof(DWORD), &cbData, 0);

    std::vector<UCHAR> hashObj(objLen);
    std::vector<UCHAR> digest(hashLen);

    if (BCryptCreateHash(hAlg, &hHash, hashObj.data(), objLen, nullptr, 0, 0) == 0) {
        if (BCryptHashData(hHash, reinterpret_cast<PUCHAR>(const_cast<void*>(data)), static_cast<ULONG>(size), 0) == 0 &&
            BCryptFinishHash(hHash, digest.data(), hashLen, 0) == 0) {
            static const char kHex[] = "0123456789abcdef";
            hexResult.reserve(hashLen * 2);
            for (DWORD i = 0; i < hashLen; ++i) {
                hexResult.push_back(kHex[(digest[i] >> 4) & 0xF]);
                hexResult.push_back(kHex[digest[i] & 0xF]);
            }
        }
        BCryptDestroyHash(hHash);
    }
    BCryptCloseAlgorithmProvider(hAlg, 0);
    return hexResult;
}

inline std::string bcrypt_hash_file(const std::filesystem::path& filePath, LPCWSTR algId = BCRYPT_SHA256_ALGORITHM) {
    std::ifstream ifs(filePath, std::ios::binary);
    if (!ifs) return "";
    std::vector<char> buf((std::istreambuf_iterator<char>(ifs)), std::istreambuf_iterator<char>());
    return bcrypt_hash_bytes(buf.data(), buf.size(), algId);
}

/**
 * Validates official Minecraft: Java Edition username format (3–16 chars: A-Z, a-z, 0-9, _).
 */
inline bool is_valid_minecraft_username(const std::string& username) {
    if (username.size() < 3 || username.size() > 16) return false;
    for (unsigned char c : username) {
        bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_';
        if (!ok) return false;
    }
    return true;
}

/**
 * Generates Mojang's deterministic offline UUID (`UUID.nameUUIDFromBytes("OfflinePlayer:" + username)`)
 * using Windows CNG `BCRYPT_MD5_ALGORITHM` + RFC 4122 Version 3 bit masking.
 */
inline std::string generate_offline_minecraft_uuid(const std::string& username) {
    std::string input = "OfflinePlayer:" + username;
    BCRYPT_ALG_HANDLE hAlg = nullptr;
    BCRYPT_HASH_HANDLE hHash = nullptr;
    unsigned char digest[16] = {};

    if (BCryptOpenAlgorithmProvider(&hAlg, BCRYPT_MD5_ALGORITHM, nullptr, 0) == 0) {
        DWORD objLen = 0, cbData = 0;
        BCryptGetProperty(hAlg, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&objLen), sizeof(DWORD), &cbData, 0);
        std::vector<UCHAR> hashObj(objLen);
        if (BCryptCreateHash(hAlg, &hHash, hashObj.data(), objLen, nullptr, 0, 0) == 0) {
            BCryptHashData(hHash, reinterpret_cast<PUCHAR>(input.data()), static_cast<ULONG>(input.size()), 0);
            BCryptFinishHash(hHash, digest, 16, 0);
            BCryptDestroyHash(hHash);
        }
        BCryptCloseAlgorithmProvider(hAlg, 0);
    }

    // RFC 4122 Version 3 (MD5 name-based) + IETF variant
    digest[6] = static_cast<unsigned char>((digest[6] & 0x0fU) | 0x30U);
    digest[8] = static_cast<unsigned char>((digest[8] & 0x3fU) | 0x80U);

    static const char kHex[] = "0123456789abcdef";
    std::string out;
    out.reserve(36);
    for (int i = 0; i < 16; ++i) {
        if (i == 4 || i == 6 || i == 8 || i == 10) out.push_back('-');
        out.push_back(kHex[(digest[i] >> 4) & 0xF]);
        out.push_back(kHex[digest[i] & 0xF]);
    }
    return out;
}

/**
 * Windows DPAPI per-user token vault protection (CryptProtectData / CryptUnprotectData).
 */
inline bool dpapi_save_secret(const std::filesystem::path& path, const std::string& plaintextJson) {
    DATA_BLOB inBlob{};
    inBlob.pbData = reinterpret_cast<BYTE*>(const_cast<char*>(plaintextJson.data()));
    inBlob.cbData = static_cast<DWORD>(plaintextJson.size());
    DATA_BLOB outBlob{};
    if (!CryptProtectData(&inBlob, L"VesperaClientVault", nullptr, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &outBlob)) {
        return false;
    }
    bool ok = write_file_atomic(path, outBlob.pbData, outBlob.cbData);
    LocalFree(outBlob.pbData);
    return ok;
}

inline std::string dpapi_load_secret(const std::filesystem::path& path) {
    std::ifstream ifs(path, std::ios::binary);
    if (!ifs) return "";
    std::vector<BYTE> enc((std::istreambuf_iterator<char>(ifs)), std::istreambuf_iterator<char>());
    if (enc.empty()) return "";
    DATA_BLOB inBlob{ static_cast<DWORD>(enc.size()), enc.data() };
    DATA_BLOB outBlob{};
    if (!CryptUnprotectData(&inBlob, nullptr, nullptr, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &outBlob)) {
        return "";
    }
    std::string out(reinterpret_cast<char*>(outBlob.pbData), outBlob.cbData);
    SecureZeroMemory(outBlob.pbData, outBlob.cbData);
    LocalFree(outBlob.pbData);
    return out;
}

inline std::string winhttp_error_category(DWORD code) {
    if (code == ERROR_WINHTTP_TIMEOUT) return "Network timeout";
    if (code == ERROR_WINHTTP_NAME_NOT_RESOLVED) return "DNS failure";
    if (code == ERROR_WINHTTP_CANNOT_CONNECT || code == ERROR_WINHTTP_CONNECTION_ERROR) return "Network connection failure";
    return "Network failure";
}

struct HttpResponse {
    int statusCode = 0;
    std::string body;
    std::string error;
};

/**
 * Native TLS 1.2/1.3 HTTPS request over WinHTTP.
 */
inline HttpResponse winhttp_request(
    const std::string& method,
    const std::string& urlUtf8,
    const std::string& requestBody = "",
    const std::string& contentType = "application/json",
    const std::string& bearerToken = "",
    std::atomic<bool>* cancelFlag = nullptr
) {
    HttpResponse res;
    std::wstring wurl = utf8_to_wide(urlUtf8);

    URL_COMPONENTS uc{};
    uc.dwStructSize = sizeof(uc);
    wchar_t hostBuf[256] = {};
    wchar_t pathBuf[2048] = {};
    uc.lpszHostName = hostBuf;
    uc.dwHostNameLength = 255;
    uc.lpszUrlPath = pathBuf;
    uc.dwUrlPathLength = 2047;

    if (!WinHttpCrackUrl(wurl.c_str(), static_cast<DWORD>(wurl.size()), 0, &uc)) {
        res.error = "Invalid URL";
        return res;
    }

    HINTERNET hSession = WinHttpOpen(L"VesperaClient/1.2.4 (Windows NT 10.0; Win64; x64)",
                                     WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
                                     WINHTTP_NO_PROXY_NAME,
                                     WINHTTP_NO_PROXY_BYPASS, 0);
    if (!hSession) {
        DWORD code = GetLastError();
        res.error = winhttp_error_category(code) + " (WinHTTP error " + std::to_string(code) + ") fetching " + urlUtf8;
        return res;
    }
    WinHttpSetTimeouts(hSession, 6000, 6000, 15000, 30000);

    HINTERNET hConnect = WinHttpConnect(hSession, hostBuf, uc.nPort, 0);
    if (!hConnect) {
        DWORD code = GetLastError();
        WinHttpCloseHandle(hSession);
        res.error = winhttp_error_category(code) + " (WinHTTP error " + std::to_string(code) + ") fetching " + urlUtf8;
        return res;
    }

    DWORD flags = (uc.nScheme == INTERNET_SCHEME_HTTPS) ? WINHTTP_FLAG_SECURE : 0;
    std::wstring wmethod = utf8_to_wide(method);
    HINTERNET hRequest = WinHttpOpenRequest(hConnect, wmethod.c_str(), pathBuf, nullptr,
                                            WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, flags);
    if (!hRequest) {
        WinHttpCloseHandle(hConnect);
        WinHttpCloseHandle(hSession);
        DWORD code = GetLastError();
        res.error = winhttp_error_category(code) + " (WinHTTP error " + std::to_string(code) + ") fetching " + urlUtf8;
        return res;
    }

    std::wstring headers = L"Accept: application/json\r\n";
    if (!contentType.empty() && !requestBody.empty()) {
        headers += L"Content-Type: " + utf8_to_wide(contentType) + L"\r\n";
    }
    if (!bearerToken.empty()) {
        headers += L"Authorization: Bearer " + utf8_to_wide(bearerToken) + L"\r\n";
    }

    if (cancelFlag && cancelFlag->load()) {
        WinHttpCloseHandle(hRequest);
        WinHttpCloseHandle(hConnect);
        WinHttpCloseHandle(hSession);
        res.error = "Request cancelled by user: " + urlUtf8;
        return res;
    }

    BOOL sent = WinHttpSendRequest(
        hRequest,
        headers.c_str(),
        static_cast<DWORD>(headers.size()),
        requestBody.empty() ? WINHTTP_NO_REQUEST_DATA : const_cast<char*>(requestBody.data()),
        static_cast<DWORD>(requestBody.size()),
        static_cast<DWORD>(requestBody.size()),
        0
    );

    if (sent && WinHttpReceiveResponse(hRequest, nullptr)) {
        DWORD status = 0;
        DWORD statusSize = sizeof(status);
        WinHttpQueryHeaders(hRequest, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                            WINHTTP_HEADER_NAME_BY_INDEX, &status, &statusSize, WINHTTP_NO_HEADER_INDEX);
        res.statusCode = static_cast<int>(status);

        DWORD avail = 0;
        do {
            if (cancelFlag && cancelFlag->load()) {
                res.error = "Request cancelled by user: " + urlUtf8;
                break;
            }
            avail = 0;
            if (!WinHttpQueryDataAvailable(hRequest, &avail) || avail == 0) break;
            std::vector<char> chunk(avail);
            DWORD readBytes = 0;
            if (WinHttpReadData(hRequest, chunk.data(), avail, &readBytes) && readBytes > 0) {
                res.body.append(chunk.data(), readBytes);
            }
        } while (avail > 0);
    } else {
        DWORD code = GetLastError();
        res.error = winhttp_error_category(code) + " (WinHTTP error " + std::to_string(code) + ") fetching " + urlUtf8;
    }

    WinHttpCloseHandle(hRequest);
    WinHttpCloseHandle(hConnect);
    WinHttpCloseHandle(hSession);
    return res;
}

inline bool winhttp_download_file(const std::string& urlUtf8, const std::filesystem::path& destFile,
                                  std::atomic<bool>* cancelFlag = nullptr) {
    HttpResponse r = winhttp_request("GET", urlUtf8, "", "application/json", "", cancelFlag);
    if ((cancelFlag && cancelFlag->load()) || r.statusCode < 200 || r.statusCode >= 300 || r.body.empty()) return false;
    return write_file_atomic(destFile, r.body.data(), r.body.size());
}

inline std::string base64url_encode(const unsigned char* data, size_t len) {
    static const char kTable[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    std::string out;
    out.reserve(((len + 2) / 3) * 4);
    for (size_t i = 0; i < len; i += 3) {
        uint32_t v = static_cast<uint32_t>(data[i]) << 16;
        if (i + 1 < len) v |= static_cast<uint32_t>(data[i + 1]) << 8;
        if (i + 2 < len) v |= static_cast<uint32_t>(data[i + 2]);
        out.push_back(kTable[(v >> 18) & 0x3F]);
        out.push_back(kTable[(v >> 12) & 0x3F]);
        if (i + 1 < len) out.push_back(kTable[(v >> 6) & 0x3F]);
        if (i + 2 < len) out.push_back(kTable[v & 0x3F]);
    }
    return out;
}

inline std::string bcrypt_random_base64url(size_t numBytes) {
    std::vector<unsigned char> buf(numBytes, 0);
    BCryptGenRandom(nullptr, buf.data(), static_cast<ULONG>(buf.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG);
    return base64url_encode(buf.data(), buf.size());
}

inline std::string bcrypt_sha256_base64url(const std::string& asciiInput) {
    BCRYPT_ALG_HANDLE hAlg = nullptr;
    BCRYPT_HASH_HANDLE hHash = nullptr;
    if (BCryptOpenAlgorithmProvider(&hAlg, BCRYPT_SHA256_ALGORITHM, nullptr, 0) != 0) return "";
    DWORD objLen = 0, cbData = 0;
    BCryptGetProperty(hAlg, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&objLen), sizeof(DWORD), &cbData, 0);
    std::vector<UCHAR> hashObj(objLen);
    unsigned char digest[32] = {};
    if (BCryptCreateHash(hAlg, &hHash, hashObj.data(), objLen, nullptr, 0, 0) == 0) {
        BCryptHashData(hHash, reinterpret_cast<PUCHAR>(const_cast<char*>(asciiInput.data())),
                       static_cast<ULONG>(asciiInput.size()), 0);
        BCryptFinishHash(hHash, digest, 32, 0);
        BCryptDestroyHash(hHash);
    }
    BCryptCloseAlgorithmProvider(hAlg, 0);
    return base64url_encode(digest, 32);
}

/**
 * Streaming WinHTTP downloader supporting HTTP Range resume on `.part` files,
 * SHA-1 verification, cancellation, and live byte progress callbacks.
 */
inline bool winhttp_download_verified(
    const std::string& urlUtf8,
    const std::filesystem::path& destFile,
    const std::string& expectedSha1,
    bool verifyHashes,
    std::atomic<bool>* cancelFlag,
    const std::function<void(size_t)>& onChunkBytes,
    std::string& outError,
    uint64_t expectedSize = 0
) {
    std::error_code ec;
    std::filesystem::create_directories(destFile.parent_path(), ec);

    if (std::filesystem::exists(destFile, ec) && std::filesystem::file_size(destFile, ec) > 0) {
        const uintmax_t currentSize = std::filesystem::file_size(destFile, ec);
        const bool sizeMatches = expectedSize == 0 || currentSize == expectedSize;
        const bool hashMatches = !verifyHashes || expectedSha1.empty() ||
            _stricmp(bcrypt_hash_file(destFile, BCRYPT_SHA1_ALGORITHM).c_str(), expectedSha1.c_str()) == 0;
        if (sizeMatches && hashMatches) return true;
        std::filesystem::remove(destFile, ec);
    }

    std::filesystem::path partFile = destFile;
    partFile += ".part";
    if (expectedSize > 0 && std::filesystem::exists(partFile, ec) &&
        std::filesystem::file_size(partFile, ec) > expectedSize) {
        std::filesystem::remove(partFile, ec);
    }

    for (int attempt = 1; attempt <= 3; ++attempt) {
        if (cancelFlag && cancelFlag->load()) {
            outError = "Download cancelled by user.";
            return false;
        }

        uintmax_t existingBytes = 0;
        if (std::filesystem::exists(partFile, ec)) {
            existingBytes = std::filesystem::file_size(partFile, ec);
        }

        std::wstring wurl = utf8_to_wide(urlUtf8);
        URL_COMPONENTS uc{};
        uc.dwStructSize = sizeof(uc);
        wchar_t hostBuf[256] = {};
        wchar_t pathBuf[2048] = {};
        uc.lpszHostName = hostBuf;
        uc.dwHostNameLength = 255;
        uc.lpszUrlPath = pathBuf;
        uc.dwUrlPathLength = 2047;
        if (!WinHttpCrackUrl(wurl.c_str(), static_cast<DWORD>(wurl.size()), 0, &uc)) {
            outError = "Invalid download URL: " + urlUtf8;
            return false;
        }

        HINTERNET hSession = WinHttpOpen(L"VesperaClient/1.2.4 (Windows NT 10.0; Win64; x64)",
                                         WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
                                         WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
        if (!hSession) {
            DWORD code = GetLastError();
            outError = winhttp_error_category(code) + " (WinHTTP error " + std::to_string(code) + ") fetching " + urlUtf8;
            continue;
        }
        WinHttpSetTimeouts(hSession, 6000, 6000, 15000, 30000);
        HINTERNET hConnect = WinHttpConnect(hSession, hostBuf, uc.nPort, 0);
        DWORD flags = (uc.nScheme == INTERNET_SCHEME_HTTPS) ? WINHTTP_FLAG_SECURE : 0;
        HINTERNET hRequest = hConnect
            ? WinHttpOpenRequest(hConnect, L"GET", pathBuf, nullptr, WINHTTP_NO_REFERER,
                                 WINHTTP_DEFAULT_ACCEPT_TYPES, flags)
            : nullptr;

        if (!hRequest) {
            if (hConnect) WinHttpCloseHandle(hConnect);
            WinHttpCloseHandle(hSession);
            outError = "WinHttpOpenRequest failed.";
            continue;
        }

        std::wstring hdrs;
        if (existingBytes > 0) {
            hdrs = L"Range: bytes=" + std::to_wstring(existingBytes) + L"-\r\n";
        }

        BOOL sent = WinHttpSendRequest(
            hRequest,
            hdrs.empty() ? WINHTTP_NO_ADDITIONAL_HEADERS : hdrs.c_str(),
            hdrs.empty() ? 0 : static_cast<DWORD>(hdrs.size()),
            WINHTTP_NO_REQUEST_DATA, 0, 0, 0
        );

        bool okAttempt = false;
        if (sent && WinHttpReceiveResponse(hRequest, nullptr)) {
            DWORD status = 0, sz = sizeof(status);
            WinHttpQueryHeaders(hRequest, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                                WINHTTP_HEADER_NAME_BY_INDEX, &status, &sz, WINHTTP_NO_HEADER_INDEX);
            if (status == 200 || status == 206) {
                DWORD contentLength = 0;
                DWORD contentLengthSize = sizeof(contentLength);
                const bool contentLengthKnown = WinHttpQueryHeaders(hRequest,
                    WINHTTP_QUERY_CONTENT_LENGTH | WINHTTP_QUERY_FLAG_NUMBER,
                    WINHTTP_HEADER_NAME_BY_INDEX, &contentLength, &contentLengthSize, WINHTTP_NO_HEADER_INDEX) != FALSE;
                const std::ios_base::openmode mode = std::ios::binary | ((status == 206 && existingBytes > 0) ? std::ios::app : std::ios::trunc);
                std::ofstream ofs(partFile, mode);
                if (ofs) {
                    okAttempt = true;
                    uint64_t responseBytes = 0;
                    bool readFailed = false;
                    DWORD avail = 0;
                    do {
                        if (cancelFlag && cancelFlag->load()) {
                            okAttempt = false;
                            outError = "Download cancelled by user.";
                            break;
                        }
                        avail = 0;
                        if (!WinHttpQueryDataAvailable(hRequest, &avail)) {
                            readFailed = true;
                            break;
                        }
                        if (avail == 0) break;
                        std::vector<char> chunk(avail);
                        DWORD readBytes = 0;
                        if (!WinHttpReadData(hRequest, chunk.data(), avail, &readBytes)) {
                            readFailed = true;
                            break;
                        }
                        if (readBytes == 0) break;
                        ofs.write(chunk.data(), readBytes);
                        if (!ofs) {
                            readFailed = true;
                            break;
                        }
                        responseBytes += readBytes;
                        if (onChunkBytes) onChunkBytes(readBytes);
                    } while (avail > 0);
                    ofs.close();
                    if (readFailed) {
                        okAttempt = false;
                        outError = "Incomplete or failed HTTP response body from " + urlUtf8;
                    } else if (contentLengthKnown && responseBytes != contentLength) {
                        okAttempt = false;
                        outError = "Incomplete HTTP response from " + urlUtf8 + ": received " + std::to_string(responseBytes) +
                            " of " + std::to_string(contentLength) + " response bytes.";
                    } else if (expectedSize > 0 && std::filesystem::file_size(partFile, ec) != expectedSize) {
                        okAttempt = false;
                        const uintmax_t partialSize = std::filesystem::file_size(partFile, ec);
                        if (partialSize > expectedSize) std::filesystem::remove(partFile, ec);
                        outError = "Downloaded artifact size mismatch for " + urlUtf8 + ": expected " +
                            std::to_string(expectedSize) + " bytes.";
                    }
                } else {
                    outError = "Could not open temporary download file " + partFile.string();
                }
            } else {
                outError = "HTTP " + std::to_string(status) + " fetching " + urlUtf8;
                if (status == 403 || status == 404) {
                    WinHttpCloseHandle(hRequest);
                    WinHttpCloseHandle(hConnect);
                    WinHttpCloseHandle(hSession);
                    std::filesystem::remove(partFile, ec);
                    return false;
                }
            }
        } else {
            DWORD code = GetLastError();
            outError = winhttp_error_category(code) + " (WinHTTP error " + std::to_string(code) + ") fetching " + urlUtf8;
        }

        WinHttpCloseHandle(hRequest);
        WinHttpCloseHandle(hConnect);
        WinHttpCloseHandle(hSession);

        if (cancelFlag && cancelFlag->load()) {
            return false;
        }

        if (okAttempt) {
            if (verifyHashes && !expectedSha1.empty()) {
                std::string gotSha = bcrypt_hash_file(partFile, BCRYPT_SHA1_ALGORITHM);
                if (_stricmp(gotSha.c_str(), expectedSha1.c_str()) != 0) {
                    std::filesystem::remove(partFile, ec);
                    outError = "SHA-1 integrity mismatch on " + wide_to_utf8(destFile.filename().wstring());
                    continue;
                }
            }
            std::filesystem::rename(partFile, destFile, ec);
            if (ec) {
                std::filesystem::copy_file(partFile, destFile, std::filesystem::copy_options::overwrite_existing, ec);
                std::filesystem::remove(partFile, ec);
            }
            return std::filesystem::exists(destFile, ec);
        }
        Sleep(static_cast<DWORD>(200 * attempt));
    }
    return false;
}

/**
 * Creates a standard Windows Shell Shortcut (.lnk) via COM IShellLinkW + IPersistFile.
 */
inline bool create_windows_shortcut(
    const std::filesystem::path& lnkPath,
    const std::filesystem::path& targetExe,
    const std::filesystem::path& workingDir,
    const std::filesystem::path& iconPath,
    const std::wstring& description
) {
    std::error_code ec;
    std::filesystem::create_directories(lnkPath.parent_path(), ec);

    IShellLinkW* psl = nullptr;
    HRESULT hr = CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER, IID_IShellLinkW, reinterpret_cast<void**>(&psl));
    if (FAILED(hr) || !psl) return false;

    psl->SetPath(targetExe.wstring().c_str());
    psl->SetWorkingDirectory(workingDir.wstring().c_str());
    psl->SetIconLocation(iconPath.wstring().c_str(), 0);
    psl->SetDescription(description.c_str());

    IPersistFile* ppf = nullptr;
    bool saved = false;
    if (SUCCEEDED(psl->QueryInterface(IID_IPersistFile, reinterpret_cast<void**>(&ppf))) && ppf) {
        saved = SUCCEEDED(ppf->Save(lnkPath.wstring().c_str(), TRUE));
        ppf->Release();
    }
    psl->Release();
    return saved;
}

inline std::string query_windows_gpu_name() {
    HKEY hKey = nullptr;
    if (RegOpenKeyExW(HKEY_LOCAL_MACHINE,
                      L"SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0000",
                      0, KEY_READ, &hKey) == ERROR_SUCCESS) {
        wchar_t buf[256] = {};
        DWORD sz = sizeof(buf);
        DWORD type = 0;
        if (RegQueryValueExW(hKey, L"DriverDesc", nullptr, &type, reinterpret_cast<LPBYTE>(buf), &sz) == ERROR_SUCCESS && type == REG_SZ) {
            RegCloseKey(hKey);
            return wide_to_utf8(buf);
        }
        RegCloseKey(hKey);
    }
    return "";
}

inline std::string query_windows_cpu_name() {
    HKEY hKey = nullptr;
    if (RegOpenKeyExW(HKEY_LOCAL_MACHINE,
                      L"HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0",
                      0, KEY_READ, &hKey) == ERROR_SUCCESS) {
        wchar_t buf[256] = {};
        DWORD sz = sizeof(buf);
        DWORD type = 0;
        if (RegQueryValueExW(hKey, L"ProcessorNameString", nullptr, &type, reinterpret_cast<LPBYTE>(buf), &sz) == ERROR_SUCCESS && type == REG_SZ) {
            RegCloseKey(hKey);
            return wide_to_utf8(buf);
        }
        RegCloseKey(hKey);
    }
    return "x86_64 Processor";
}

} // namespace vespera_win32

#endif
