#pragma once

#include <string>
#include <vector>

namespace vespera {

// Quote one argument using the Windows CRT command-line parsing rules used by
// Java's main() argument decoder. Always quote to keep path/space handling uniform.
inline std::wstring quote_windows_argument(const std::wstring& argument) {
    std::wstring out;
    out.push_back(L'"');
    size_t slashes = 0;
    for (wchar_t ch : argument) {
        if (ch == L'\\') { ++slashes; continue; }
        if (ch == L'"') {
            out.append(slashes * 2 + 1, L'\\');
            out.push_back(L'"');
            slashes = 0;
            continue;
        }
        out.append(slashes, L'\\');
        slashes = 0;
        out.push_back(ch);
    }
    // Backslashes immediately preceding the closing quote must be doubled.
    out.append(slashes * 2, L'\\');
    out.push_back(L'"');
    return out;
}

inline std::wstring build_windows_command_line(const std::wstring& executable,
                                                const std::vector<std::wstring>& arguments) {
    std::wstring out = quote_windows_argument(executable);
    for (const auto& argument : arguments) {
        out.push_back(L' ');
        out += quote_windows_argument(argument);
    }
    return out;
}

} // namespace vespera
