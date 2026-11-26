#pragma once

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <functional>
#include <map>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

#include "miniz.h"
#include "miniz_tinfl.h"

namespace vespera::native_zip {
namespace fs = std::filesystem;

struct ArchiveInfo {
    uint64_t entries = 0;
    uint64_t extracted = 0;
};

inline uint16_t u16(const std::vector<uint8_t>& b, size_t p) {
    return static_cast<uint16_t>(b[p] | (static_cast<uint16_t>(b[p + 1]) << 8));
}
inline uint32_t u32(const std::vector<uint8_t>& b, size_t p) {
    return static_cast<uint32_t>(b[p]) | (static_cast<uint32_t>(b[p + 1]) << 8) |
        (static_cast<uint32_t>(b[p + 2]) << 16) | (static_cast<uint32_t>(b[p + 3]) << 24);
}

inline bool valid_utf8(const std::string& s) {
    size_t i = 0;
    while (i < s.size()) {
        const uint8_t c = static_cast<uint8_t>(s[i++]);
        if (c < 0x80) continue;
        uint32_t code = 0; size_t extra = 0;
        if ((c & 0xe0) == 0xc0) { code = c & 0x1f; extra = 1; if (code < 2) return false; }
        else if ((c & 0xf0) == 0xe0) { code = c & 0x0f; extra = 2; }
        else if ((c & 0xf8) == 0xf0) { code = c & 0x07; extra = 3; }
        else return false;
        if (i + extra > s.size()) return false;
        for (size_t n = 0; n < extra; ++n) {
            const uint8_t next = static_cast<uint8_t>(s[i++]);
            if ((next & 0xc0) != 0x80) return false;
            code = (code << 6) | (next & 0x3f);
        }
        if ((extra == 2 && code < 0x800) || (extra == 3 && code < 0x10000) ||
            code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return false;
    }
    return true;
}

inline bool is_dll(const std::string& name) {
    auto dot = name.find_last_of('.');
    if (dot == std::string::npos) return false;
    std::string ext = name.substr(dot);
    std::transform(ext.begin(), ext.end(), ext.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return ext == ".dll";
}

inline bool excluded(const std::string& name, const std::vector<std::string>& prefixes) {
    for (auto prefix : prefixes) {
        std::replace(prefix.begin(), prefix.end(), '\\', '/');
        while (!prefix.empty() && prefix.front() == '/') prefix.erase(prefix.begin());
        if (name.compare(0, prefix.size(), prefix) == 0) return true;
    }
    return false;
}

inline fs::path safe_relative_path(const std::string& name) {
    if (name.empty() || name.front() == '/' || name.front() == '\\' || name.find(':') != std::string::npos ||
        name.find('\0') != std::string::npos || name.find('\\') != std::string::npos)
        throw std::runtime_error("unsafe ZIP entry path");
    fs::path rel;
    size_t start = 0;
    while (start <= name.size()) {
        const size_t end = name.find('/', start);
        const std::string part = name.substr(start, end == std::string::npos ? std::string::npos : end - start);
        if (part.empty() || part == "." || part == "..") throw std::runtime_error("unsafe ZIP entry path component");
        if (part.back() == '.' || part.back() == ' ' || part.find_first_of("<>\"|?*") != std::string::npos)
            throw std::runtime_error("ZIP entry is not a valid Windows path");
        const auto dot = part.find('.');
        std::string device = part.substr(0, dot);
        std::transform(device.begin(), device.end(), device.begin(), [](unsigned char c) { return static_cast<char>(std::toupper(c)); });
        static const std::set<std::string> reserved = {"CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"};
        if (reserved.count(device)) throw std::runtime_error("reserved Windows device name in ZIP entry");
        rel /= fs::u8path(part);
        if (end == std::string::npos) break;
        start = end + 1;
    }
    return rel;
}

// Extract native Windows DLLs from a ZIP/JAR. It validates every selected entry's
// local header, compressed stream, declared length and CRC before writing it.
// Output is only modified after each entry has fully validated; caller supplies a fresh staging dir.
inline ArchiveInfo extract_dlls(const fs::path& archive, const fs::path& destination,
                                const std::vector<std::string>& excludedPrefixes = {},
                                const std::function<void()>& checkpoint = {}) {
    std::ifstream in(archive, std::ios::binary);
    if (!in) throw std::runtime_error("cannot open archive");
    std::vector<uint8_t> b((std::istreambuf_iterator<char>(in)), {});
    if (in.bad() || b.size() < 22) throw std::runtime_error("truncated ZIP archive");
    if (b.size() > 1024ULL * 1024 * 1024) throw std::runtime_error("ZIP archive exceeds 1 GiB safety limit");
    const size_t minEocd = b.size() > 65557 ? b.size() - 65557 : 0;
    size_t eocd = std::string::npos;
    for (size_t p = b.size() - 22;; --p) {
        if (u32(b, p) == 0x06054b50 && p + 22ULL + u16(b, p + 20) == b.size()) { eocd = p; break; }
        if (p == minEocd) break;
    }
    if (eocd == std::string::npos) throw std::runtime_error("ZIP end-of-central-directory record missing or truncated");
    const uint16_t disk = u16(b, eocd + 4), centralDisk = u16(b, eocd + 6);
    const uint16_t diskEntries = u16(b, eocd + 8), totalEntries = u16(b, eocd + 10);
    const uint32_t centralSize = u32(b, eocd + 12), centralOffset = u32(b, eocd + 16);
    if (disk || centralDisk || diskEntries != totalEntries || totalEntries == 0xffff || centralOffset == 0xffffffff || centralSize == 0xffffffff)
        throw std::runtime_error("multi-disk or ZIP64 archives are unsupported");
    if (static_cast<uint64_t>(centralOffset) + centralSize > eocd) throw std::runtime_error("ZIP central directory is out of bounds");

    ArchiveInfo info{totalEntries, 0};
    size_t cursor = centralOffset;
    std::map<std::string, std::vector<uint8_t>> outputs;
    std::map<std::string, std::string> owners;
    std::map<std::string, std::string> outputNames;
    uint64_t totalNativeBytes = 0;
    for (uint16_t i = 0; i < totalEntries; ++i) {
        if (checkpoint) checkpoint();
        if (cursor + 46 > eocd || u32(b, cursor) != 0x02014b50) throw std::runtime_error("invalid ZIP central directory entry");
        const uint16_t flags = u16(b, cursor + 8), method = u16(b, cursor + 10);
        const uint32_t crc = u32(b, cursor + 16), compressed = u32(b, cursor + 20), uncompressed = u32(b, cursor + 24);
        const uint16_t nameLen = u16(b, cursor + 28), extraLen = u16(b, cursor + 30), commentLen = u16(b, cursor + 32);
        const uint32_t localOffset = u32(b, cursor + 42);
        const uint64_t entryEnd = static_cast<uint64_t>(cursor) + 46 + nameLen + extraLen + commentLen;
        if (entryEnd > static_cast<uint64_t>(centralOffset) + centralSize) throw std::runtime_error("truncated ZIP central entry");
        std::string name(reinterpret_cast<const char*>(b.data() + cursor + 46), nameLen);
        cursor = static_cast<size_t>(entryEnd);
        if (name.empty() || name.back() == '/' || excluded(name, excludedPrefixes) || !is_dll(name)) continue;
        if (!valid_utf8(name)) throw std::runtime_error("native ZIP entry name is not valid UTF-8");
        fs::path rel;
        try { rel = safe_relative_path(name); }
        catch (const std::exception& e) { throw std::runtime_error("unsafe native entry '" + name + "': " + e.what()); }
        if ((flags & 1) || (flags & 0x40)) throw std::runtime_error("encrypted native ZIP entry is unsupported: " + name);
        if (method != 0 && method != 8) throw std::runtime_error("unsupported compression method " + std::to_string(method) + " for " + name);
        if (compressed == 0xffffffff || uncompressed == 0xffffffff || localOffset == 0xffffffff)
            throw std::runtime_error("ZIP64 native entry is unsupported: " + name);
        if (uncompressed == 0) throw std::runtime_error("empty native DLL entry is invalid: " + name);
        if (uncompressed > 256ULL * 1024 * 1024 || compressed > b.size()) throw std::runtime_error("native entry size exceeds safe limits: " + name);
        if (static_cast<uint64_t>(localOffset) + 30 > centralOffset || u32(b, localOffset) != 0x04034b50)
            throw std::runtime_error("invalid local header for native entry: " + name);
        const uint16_t localFlags = u16(b, localOffset + 6), localMethod = u16(b, localOffset + 8);
        const uint16_t localNameLen = u16(b, localOffset + 26), localExtraLen = u16(b, localOffset + 28);
        const uint64_t dataOffset = static_cast<uint64_t>(localOffset) + 30 + localNameLen + localExtraLen;
        if (localFlags != flags || localMethod != method || dataOffset + compressed > centralOffset || localNameLen != nameLen ||
            std::string(reinterpret_cast<const char*>(b.data() + localOffset + 30), localNameLen) != name)
            throw std::runtime_error("local/central header mismatch or truncated data for native entry: " + name);
        if (!(flags & 8) && (u32(b, localOffset + 14) != crc || u32(b, localOffset + 18) != compressed || u32(b, localOffset + 22) != uncompressed))
            throw std::runtime_error("local/central size or CRC mismatch for native entry: " + name);
        std::vector<uint8_t> content(uncompressed);
        if (method == 0) {
            if (compressed != uncompressed) throw std::runtime_error("stored ZIP entry size mismatch: " + name);
            std::copy_n(b.data() + dataOffset, compressed, content.data());
        } else {
            const size_t result = tinfl_decompress_mem_to_mem(content.data(), content.size(), b.data() + dataOffset,
                                                               compressed, TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF);
            if (result != uncompressed) throw std::runtime_error("deflate stream invalid or truncated for native entry: " + name);
        }
        if (mz_crc32(MZ_CRC32_INIT, content.data(), content.size()) != crc) throw std::runtime_error("CRC-32 mismatch for native entry: " + name);
        // Windows' native loader searches java.library.path entries non-recursively;
        // place binary basenames at the library-path root and reject collisions.
        const std::string outputName = rel.filename().generic_u8string();
        std::string outputKey = outputName;
        std::transform(outputKey.begin(), outputKey.end(), outputKey.begin(), [](unsigned char c) {
            return static_cast<char>(c < 0x80 ? std::tolower(c) : c);
        });
        auto previous = outputs.find(outputKey);
        if (previous != outputs.end() && previous->second != content)
            throw std::runtime_error("conflicting duplicate native output '" + outputKey + "' from " + owners[outputKey] + " and " + name);
        if (previous == outputs.end()) {
            totalNativeBytes += content.size();
            if (totalNativeBytes > 512ULL * 1024 * 1024) throw std::runtime_error("total native DLL output exceeds 512 MiB safety limit");
            outputs.emplace(outputKey, std::move(content)); owners[outputKey] = name; outputNames[outputKey] = outputName;
        }
    }
    if (cursor != static_cast<uint64_t>(centralOffset) + centralSize) throw std::runtime_error("ZIP central directory size/count mismatch");
    if (outputs.empty()) throw std::runtime_error("archive contains no non-excluded Windows DLL entries");

    fs::create_directories(destination);
    for (const auto& [relative, content] : outputs) {
        const fs::path out = destination / fs::u8path(outputNames.at(relative));
        fs::create_directories(out.parent_path());
        if (fs::exists(out)) {
            std::ifstream existing(out, std::ios::binary);
            std::vector<uint8_t> old((std::istreambuf_iterator<char>(existing)), {});
            if (!existing.eof() && existing.bad()) throw std::runtime_error("cannot inspect duplicate native DLL: " + out.u8string());
            if (old != content) throw std::runtime_error("conflicting native DLL from multiple archives: " + out.u8string());
            continue;
        }
        std::ofstream file(out, std::ios::binary | std::ios::trunc);
        if (!file || (!content.empty() && !file.write(reinterpret_cast<const char*>(content.data()), static_cast<std::streamsize>(content.size()))))
            throw std::runtime_error("cannot write extracted native DLL: " + out.u8string());
        ++info.extracted;
    }
    return info;
}
} // namespace vespera::native_zip
