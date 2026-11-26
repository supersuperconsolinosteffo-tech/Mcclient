#pragma once

#include <algorithm>
#include <cctype>
#include <string>

namespace vespera {

inline std::string first_meaningful_exception(const std::string& text) {
    const std::string needles[] = {
        "exception", "caused by:", "error", "failed", "fatal", "crash", "cannot",
        "noclassdeffounderror", "classnotfoundexception", "unsatisfiedlinkerror",
        "nosuchmethoderror", "unsupportedclassversionerror", "accessviolation",
        "could not find or load main class"
    };
    size_t begin = 0;
    while (begin < text.size()) {
        size_t end = text.find_first_of("\r\n", begin);
        if (end == std::string::npos) end = text.size();
        std::string line = text.substr(begin, end - begin);
        std::string lower = line;
        std::transform(lower.begin(), lower.end(), lower.begin(), [](unsigned char ch) {
            return static_cast<char>(std::tolower(ch));
        });
        for (const auto& needle : needles) {
            if (lower.find(needle) != std::string::npos) return line;
        }
        if (end == text.size()) break;
        begin = end + 1;
    }
    return {};
}

} // namespace vespera
