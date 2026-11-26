#pragma once

#include <algorithm>
#include <cctype>
#include <string>

namespace vespera {

// Match explicit Windows-native classifier suffixes to the launcher binary's
// target architecture. Mojang metadata sometimes applies only an OS rule to
// each classifier, so relying on rules alone can select x86/ARM DLLs on x64.
inline bool windows_classifier_matches_target(const std::string& classifier, const std::string& archToken) {
    std::string value = classifier;
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    const std::string prefix = "natives-windows";
    if (value.compare(0, prefix.size(), prefix) != 0) return true;
    std::string suffix = value.substr(prefix.size());
    if (suffix.empty()) return archToken == "64"; // unqualified Windows natives are the conventional x64 artifact
    if (suffix.front() != '-' && suffix.front() != '_') return true;
    while (!suffix.empty() && (suffix.front() == '-' || suffix.front() == '_')) suffix.erase(suffix.begin());

    if (archToken == "64") {
        if (suffix == "x86_64" || suffix == "amd64" || suffix == "x64" || suffix == "64") return true;
        if (suffix == "x86" || suffix == "32" || suffix == "arm64" || suffix == "aarch64" || suffix == "arm" || suffix == "arm32") return false;
        return true; // keep unknown historical classifier schemes rather than guessing
    }
    if (archToken == "32") {
        if (suffix == "x86" || suffix == "32") return true;
        if (suffix.empty() || suffix == "x86_64" || suffix == "amd64" || suffix == "x64" || suffix == "64" ||
            suffix == "arm64" || suffix == "aarch64" || suffix == "arm" || suffix == "arm32") return false;
        return true;
    }
    return false;
}

} // namespace vespera
